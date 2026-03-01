/**
 * RateLimitTokenBucket — Token bucket rate limiter.
 *
 * Classic token bucket algorithm with configurable refill rate,
 * burst capacity, and per-key tracking. Complements sliding window
 * for different rate limiting strategies.
 *
 * @example
 * ```ts
 * const bucket = new RateLimitTokenBucket({
 *   capacity: 100,
 *   refillRate: 10,     // tokens per second
 *   refillIntervalMs: 1000,
 * });
 *
 * const result = bucket.consume('key1', 5);
 * // { allowed: true, remaining: 95, retryAfterMs: 0 }
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface TokenBucketConfig {
  /** Max tokens per bucket. Default 100. */
  capacity?: number;
  /** Tokens added per interval. Default 10. */
  refillRate?: number;
  /** Refill interval in ms. Default 1000. */
  refillIntervalMs?: number;
  /** Max tracked keys. Default 10000. */
  maxKeys?: number;
}

export interface TokenConsumeResult {
  key: string;
  allowed: boolean;
  remaining: number;
  capacity: number;
  retryAfterMs: number;
  timestamp: number;
}

export interface TokenBucketState {
  key: string;
  tokens: number;
  capacity: number;
  lastRefill: number;
}

export interface TokenBucketStats {
  trackedKeys: number;
  totalRequests: number;
  totalAllowed: number;
  totalDenied: number;
  totalTokensConsumed: number;
}

// ── Implementation ───────────────────────────────────────────────────

interface BucketEntry {
  tokens: number;
  lastRefill: number;
  lastAccess: number;
}

export class RateLimitTokenBucket {
  private buckets = new Map<string, BucketEntry>();
  private capacity: number;
  private refillRate: number;
  private refillIntervalMs: number;
  private maxKeys: number;

  // Stats
  private totalRequests = 0;
  private totalAllowed = 0;
  private totalDenied = 0;
  private totalTokensConsumed = 0;

  constructor(config: TokenBucketConfig = {}) {
    this.capacity = config.capacity ?? 100;
    this.refillRate = config.refillRate ?? 10;
    this.refillIntervalMs = config.refillIntervalMs ?? 1000;
    this.maxKeys = config.maxKeys ?? 10_000;
  }

  // ── Core Operations ─────────────────────────────────────────────

  /** Consume tokens from a key's bucket. */
  consume(key: string, tokens = 1): TokenConsumeResult {
    const now = Date.now();
    this.totalRequests++;

    const entry = this.getOrCreateEntry(key, now);
    this.refillTokens(entry, now);

    if (entry.tokens >= tokens) {
      entry.tokens -= tokens;
      entry.lastAccess = now;
      this.totalAllowed++;
      this.totalTokensConsumed += tokens;

      return {
        key,
        allowed: true,
        remaining: Math.floor(entry.tokens),
        capacity: this.capacity,
        retryAfterMs: 0,
        timestamp: now,
      };
    }

    // Not enough tokens — calculate wait time
    const deficit = tokens - entry.tokens;
    const intervalsNeeded = Math.ceil(deficit / this.refillRate);
    const retryAfterMs = intervalsNeeded * this.refillIntervalMs;
    entry.lastAccess = now;
    this.totalDenied++;

    return {
      key,
      allowed: false,
      remaining: Math.floor(entry.tokens),
      capacity: this.capacity,
      retryAfterMs,
      timestamp: now,
    };
  }

  /** Peek at a key's bucket without consuming. */
  peek(key: string): TokenBucketState {
    const now = Date.now();
    const entry = this.buckets.get(key);

    if (!entry) {
      return { key, tokens: this.capacity, capacity: this.capacity, lastRefill: now };
    }

    // Calculate current tokens with refill
    const elapsed = now - entry.lastRefill;
    const intervals = Math.floor(elapsed / this.refillIntervalMs);
    const refilled = Math.min(entry.tokens + intervals * this.refillRate, this.capacity);

    return { key, tokens: Math.floor(refilled), capacity: this.capacity, lastRefill: entry.lastRefill };
  }

  /** Reset a key's bucket to full capacity. */
  reset(key: string): boolean {
    const entry = this.buckets.get(key);
    if (!entry) return false;
    entry.tokens = this.capacity;
    entry.lastRefill = Date.now();
    return true;
  }

  /** Remove a key's bucket. */
  remove(key: string): boolean {
    return this.buckets.delete(key);
  }

  /** Set custom capacity for a key. */
  setCapacity(key: string, capacity: number): void {
    const now = Date.now();
    const entry = this.getOrCreateEntry(key, now);
    this.refillTokens(entry, now);
    entry.tokens = Math.min(entry.tokens, capacity);
  }

  /** List all tracked keys with states. */
  listBuckets(limit = 50): TokenBucketState[] {
    const now = Date.now();
    const results: TokenBucketState[] = [];

    for (const [key, entry] of this.buckets) {
      if (results.length >= limit) break;
      const elapsed = now - entry.lastRefill;
      const intervals = Math.floor(elapsed / this.refillIntervalMs);
      const tokens = Math.min(entry.tokens + intervals * this.refillRate, this.capacity);
      results.push({ key, tokens: Math.floor(tokens), capacity: this.capacity, lastRefill: entry.lastRefill });
    }

    return results;
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): TokenBucketStats {
    return {
      trackedKeys: this.buckets.size,
      totalRequests: this.totalRequests,
      totalAllowed: this.totalAllowed,
      totalDenied: this.totalDenied,
      totalTokensConsumed: this.totalTokensConsumed,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.buckets.clear();
    this.totalRequests = 0;
    this.totalAllowed = 0;
    this.totalDenied = 0;
    this.totalTokensConsumed = 0;
  }

  // ── Private ───────────────────────────────────────────────────

  private getOrCreateEntry(key: string, now: number): BucketEntry {
    let entry = this.buckets.get(key);
    if (!entry) {
      if (this.buckets.size >= this.maxKeys) {
        // Evict least recently accessed
        let oldestKey: string | null = null;
        let oldestAccess = Infinity;
        for (const [k, e] of this.buckets) {
          if (e.lastAccess < oldestAccess) {
            oldestAccess = e.lastAccess;
            oldestKey = k;
          }
        }
        if (oldestKey) this.buckets.delete(oldestKey);
      }
      entry = { tokens: this.capacity, lastRefill: now, lastAccess: now };
      this.buckets.set(key, entry);
    }
    return entry;
  }

  private refillTokens(entry: BucketEntry, now: number): void {
    const elapsed = now - entry.lastRefill;
    const intervals = Math.floor(elapsed / this.refillIntervalMs);
    if (intervals > 0) {
      entry.tokens = Math.min(entry.tokens + intervals * this.refillRate, this.capacity);
      entry.lastRefill += intervals * this.refillIntervalMs;
    }
  }
}
