/**
 * RateLimiter — Sliding window rate limiter per API key.
 *
 * Uses a simple sliding window counter (calls in last N seconds).
 * Fail-closed: if rate limit exceeded, DENY.
 */

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  remaining: number;
  resetInMs: number;
}

interface WindowEntry {
  timestamps: number[];
}

export class RateLimiter {
  private readonly windowMs: number;
  private readonly maxCalls: number;
  private windows = new Map<string, WindowEntry>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * @param maxCallsPerMin Maximum calls per window per key. 0 = unlimited.
   */
  constructor(maxCallsPerMin: number) {
    this.maxCalls = maxCallsPerMin;
    this.windowMs = 60_000; // 1 minute window

    if (maxCallsPerMin > 0) {
      this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    }
  }

  check(key: string): RateLimitResult {
    if (this.maxCalls <= 0) {
      return { allowed: true, remaining: Infinity, resetInMs: 0 };
    }

    const now = Date.now();
    const cutoff = now - this.windowMs;
    const entry = this.getOrCreate(key);

    // Remove expired timestamps
    entry.timestamps = entry.timestamps.filter(t => t > cutoff);

    if (entry.timestamps.length >= this.maxCalls) {
      const oldestInWindow = entry.timestamps[0];
      const resetInMs = oldestInWindow + this.windowMs - now;
      return {
        allowed: false,
        reason: `rate_limited: ${this.maxCalls} calls/min exceeded`,
        remaining: 0,
        resetInMs: Math.max(0, resetInMs),
      };
    }

    return {
      allowed: true,
      remaining: this.maxCalls - entry.timestamps.length - 1, // after this call
      resetInMs: entry.timestamps.length > 0 ? entry.timestamps[0] + this.windowMs - now : this.windowMs,
    };
  }

  /**
   * Record a call. Call AFTER gate allows.
   */
  record(key: string): void {
    if (this.maxCalls <= 0) return;
    const entry = this.getOrCreate(key);
    entry.timestamps.push(Date.now());
  }

  /**
   * Check a key against a custom limit. Used for per-tool rate limiting.
   * Uses composite keys like "pg_abc:tool:search" to track per-tool usage.
   */
  checkCustom(key: string, maxCalls: number): RateLimitResult {
    if (maxCalls <= 0) {
      return { allowed: true, remaining: Infinity, resetInMs: 0 };
    }

    const now = Date.now();
    const cutoff = now - this.windowMs;
    const entry = this.getOrCreate(key);

    // Remove expired timestamps
    entry.timestamps = entry.timestamps.filter(t => t > cutoff);

    if (entry.timestamps.length >= maxCalls) {
      const oldestInWindow = entry.timestamps[0];
      const resetInMs = oldestInWindow + this.windowMs - now;
      return {
        allowed: false,
        reason: `rate_limited: ${maxCalls} calls/min exceeded for tool`,
        remaining: 0,
        resetInMs: Math.max(0, resetInMs),
      };
    }

    return {
      allowed: true,
      remaining: maxCalls - entry.timestamps.length - 1,
      resetInMs: entry.timestamps.length > 0 ? entry.timestamps[0] + this.windowMs - now : this.windowMs,
    };
  }

  /**
   * Record a call for any key (including composite per-tool keys).
   */
  recordCustom(key: string): void {
    const entry = this.getOrCreate(key);
    entry.timestamps.push(Date.now());
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  private getOrCreate(key: string): WindowEntry {
    let entry = this.windows.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.windows.set(key, entry);
    }
    return entry;
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, entry] of this.windows) {
      entry.timestamps = entry.timestamps.filter(t => t > cutoff);
      if (entry.timestamps.length === 0) {
        this.windows.delete(key);
      }
    }
  }
}
