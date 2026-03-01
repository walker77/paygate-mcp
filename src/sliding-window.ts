/**
 * RateLimitSlidingWindow — Precise sliding window rate limiter.
 *
 * Uses sub-window granularity for more accurate rate limiting
 * than fixed-window approaches. Tracks per-key request counts
 * across configurable time windows.
 *
 * @example
 * ```ts
 * const limiter = new RateLimitSlidingWindow({
 *   windowMs: 60000,      // 1 minute window
 *   maxRequests: 100,      // 100 requests per window
 *   subWindows: 6,         // 6 sub-windows of 10s each
 * });
 *
 * const result = limiter.check('api_key_123');
 * if (!result.allowed) {
 *   console.log(`Rate limited. Retry after ${result.retryAfterMs}ms`);
 * }
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface SlidingWindowConfig {
  /** Window duration in ms. Default 60000 (1 min). */
  windowMs?: number;
  /** Max requests per window. Default 100. */
  maxRequests?: number;
  /** Number of sub-windows for granularity. Default 10. */
  subWindows?: number;
  /** Max tracked keys. Default 100000. */
  maxKeys?: number;
}

export interface SlidingWindowCheckResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAtMs: number;
  retryAfterMs: number;
  currentCount: number;
}

export interface SlidingWindowStats {
  trackedKeys: number;
  totalChecks: number;
  totalAllowed: number;
  totalDenied: number;
  hitRate: number;
}

// ── Implementation ───────────────────────────────────────────────────

interface SubWindow {
  count: number;
  start: number;
}

interface KeyState {
  subWindows: SubWindow[];
  lastAccess: number;
}

export class RateLimitSlidingWindow {
  private keys = new Map<string, KeyState>();
  private windowMs: number;
  private maxRequests: number;
  private subWindowCount: number;
  private subWindowMs: number;
  private maxKeys: number;

  // Stats
  private totalChecks = 0;
  private totalAllowed = 0;
  private totalDenied = 0;

  constructor(config: SlidingWindowConfig = {}) {
    this.windowMs = config.windowMs ?? 60_000;
    this.maxRequests = config.maxRequests ?? 100;
    this.subWindowCount = config.subWindows ?? 10;
    this.subWindowMs = this.windowMs / this.subWindowCount;
    this.maxKeys = config.maxKeys ?? 100_000;
  }

  /** Check if a request is allowed and consume a token. */
  check(key: string): SlidingWindowCheckResult {
    this.totalChecks++;
    const now = Date.now();
    const state = this.getOrCreateState(key, now);
    this.pruneSubWindows(state, now);

    const currentCount = this.countRequests(state, now);

    if (currentCount >= this.maxRequests) {
      this.totalDenied++;
      const oldestWindow = state.subWindows[0];
      const retryAfterMs = oldestWindow
        ? Math.max(0, oldestWindow.start + this.windowMs - now)
        : 0;

      return {
        allowed: false,
        remaining: 0,
        limit: this.maxRequests,
        resetAtMs: now + retryAfterMs,
        retryAfterMs,
        currentCount,
      };
    }

    // Add to current sub-window
    this.addRequest(state, now);
    this.totalAllowed++;
    state.lastAccess = now;

    const remaining = this.maxRequests - currentCount - 1;
    return {
      allowed: true,
      remaining: Math.max(0, remaining),
      limit: this.maxRequests,
      resetAtMs: now + this.windowMs,
      retryAfterMs: 0,
      currentCount: currentCount + 1,
    };
  }

  /** Peek at current usage without consuming a token. */
  peek(key: string): SlidingWindowCheckResult {
    const now = Date.now();
    const state = this.keys.get(key);

    if (!state) {
      return {
        allowed: true,
        remaining: this.maxRequests,
        limit: this.maxRequests,
        resetAtMs: now + this.windowMs,
        retryAfterMs: 0,
        currentCount: 0,
      };
    }

    this.pruneSubWindows(state, now);
    const currentCount = this.countRequests(state, now);
    const remaining = this.maxRequests - currentCount;

    return {
      allowed: remaining > 0,
      remaining: Math.max(0, remaining),
      limit: this.maxRequests,
      resetAtMs: now + this.windowMs,
      retryAfterMs: remaining <= 0
        ? Math.max(0, (state.subWindows[0]?.start ?? now) + this.windowMs - now)
        : 0,
      currentCount,
    };
  }

  /** Reset a key's rate limit state. */
  resetKey(key: string): boolean {
    return this.keys.delete(key);
  }

  /** Get current usage for a key. */
  getKeyUsage(key: string): { count: number; limit: number; remaining: number } | null {
    const state = this.keys.get(key);
    if (!state) return null;

    this.pruneSubWindows(state, Date.now());
    const count = this.countRequests(state, Date.now());
    return { count, limit: this.maxRequests, remaining: Math.max(0, this.maxRequests - count) };
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): SlidingWindowStats {
    return {
      trackedKeys: this.keys.size,
      totalChecks: this.totalChecks,
      totalAllowed: this.totalAllowed,
      totalDenied: this.totalDenied,
      hitRate: this.totalChecks > 0
        ? Math.round((this.totalDenied / this.totalChecks) * 10000) / 100
        : 0,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.keys.clear();
    this.totalChecks = 0;
    this.totalAllowed = 0;
    this.totalDenied = 0;
  }

  // ── Private ───────────────────────────────────────────────────

  private getOrCreateState(key: string, now: number): KeyState {
    let state = this.keys.get(key);
    if (!state) {
      if (this.keys.size >= this.maxKeys) {
        // Evict oldest accessed key
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        for (const [k, s] of this.keys) {
          if (s.lastAccess < oldestTime) {
            oldestTime = s.lastAccess;
            oldestKey = k;
          }
        }
        if (oldestKey) this.keys.delete(oldestKey);
      }
      state = { subWindows: [], lastAccess: now };
      this.keys.set(key, state);
    }
    return state;
  }

  private pruneSubWindows(state: KeyState, now: number): void {
    const cutoff = now - this.windowMs;
    state.subWindows = state.subWindows.filter(sw => sw.start + this.subWindowMs > cutoff);
  }

  private countRequests(state: KeyState, now: number): number {
    const cutoff = now - this.windowMs;
    let total = 0;

    for (const sw of state.subWindows) {
      if (sw.start + this.subWindowMs <= cutoff) continue;

      // For partially-expired sub-windows, weight by overlap
      if (sw.start < cutoff) {
        const overlap = (sw.start + this.subWindowMs - cutoff) / this.subWindowMs;
        total += Math.ceil(sw.count * overlap);
      } else {
        total += sw.count;
      }
    }

    return total;
  }

  private addRequest(state: KeyState, now: number): void {
    const subWindowStart = Math.floor(now / this.subWindowMs) * this.subWindowMs;
    const existing = state.subWindows.find(sw => sw.start === subWindowStart);

    if (existing) {
      existing.count++;
    } else {
      state.subWindows.push({ count: 1, start: subWindowStart });
    }
  }
}
