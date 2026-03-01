/**
 * WebhookRateLimiter — Per-URL rate limiting for webhook delivery.
 *
 * Control delivery rate to each webhook endpoint to prevent
 * overwhelming receivers.
 *
 * @example
 * ```ts
 * const limiter = new WebhookRateLimiter({ maxPerMinute: 60 });
 *
 * if (limiter.canDeliver('https://example.com/hook')) {
 *   await deliver(payload);
 *   limiter.recordDelivery('https://example.com/hook');
 * } else {
 *   const wait = limiter.getRetryAfter('https://example.com/hook');
 * }
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface WebhookRateLimit {
  url: string;
  maxPerMinute: number;
  currentCount: number;
  windowStart: number;
  blocked: boolean;
  retryAfterMs: number;
}

export interface WebhookRateLimitOverride {
  url: string;
  maxPerMinute: number;
}

export interface WebhookRateLimiterConfig {
  /** Default max deliveries per minute per URL. Default 60. */
  maxPerMinute?: number;
  /** Max tracked URLs. Default 5000. */
  maxUrls?: number;
}

export interface WebhookRateLimiterStats {
  trackedUrls: number;
  totalDeliveries: number;
  totalBlocked: number;
  overrideCount: number;
}

// ── Implementation ───────────────────────────────────────────────────

interface URLWindow {
  count: number;
  windowStart: number;
}

export class WebhookRateLimiter {
  private windows = new Map<string, URLWindow>();
  private overrides = new Map<string, number>(); // url -> maxPerMinute
  private defaultMax: number;
  private maxUrls: number;

  // Stats
  private totalDeliveries = 0;
  private totalBlocked = 0;

  constructor(config: WebhookRateLimiterConfig = {}) {
    this.defaultMax = config.maxPerMinute ?? 60;
    this.maxUrls = config.maxUrls ?? 5000;
  }

  // ── Core Operations ────────────────────────────────────────────

  /** Check if delivery is allowed for a URL. */
  canDeliver(url: string): boolean {
    const w = this.getWindow(url);
    const max = this.getMaxForUrl(url);
    this.maybeResetWindow(w);
    return w.count < max;
  }

  /** Record a delivery for a URL. */
  recordDelivery(url: string): boolean {
    const w = this.getOrCreateWindow(url);
    this.maybeResetWindow(w);
    const max = this.getMaxForUrl(url);

    if (w.count >= max) {
      this.totalBlocked++;
      return false;
    }

    w.count++;
    this.totalDeliveries++;
    return true;
  }

  /** Get retry-after in ms for a blocked URL. */
  getRetryAfter(url: string): number {
    const w = this.windows.get(url);
    if (!w) return 0;
    this.maybeResetWindow(w);
    const max = this.getMaxForUrl(url);
    if (w.count < max) return 0;

    const elapsed = Date.now() - w.windowStart;
    return Math.max(0, 60_000 - elapsed);
  }

  // ── Rate Limit Overrides ───────────────────────────────────────

  /** Set a per-URL rate limit override. */
  setOverride(url: string, maxPerMinute: number): void {
    if (maxPerMinute <= 0) throw new Error('maxPerMinute must be positive');
    this.overrides.set(url, maxPerMinute);
  }

  /** Remove a per-URL override. */
  removeOverride(url: string): boolean {
    return this.overrides.delete(url);
  }

  /** Get all overrides. */
  getOverrides(): WebhookRateLimitOverride[] {
    return [...this.overrides.entries()].map(([url, maxPerMinute]) => ({ url, maxPerMinute }));
  }

  // ── Query ──────────────────────────────────────────────────────

  /** Get rate limit status for a URL. */
  getStatus(url: string): WebhookRateLimit {
    const w = this.windows.get(url);
    const max = this.getMaxForUrl(url);

    if (!w) {
      return {
        url, maxPerMinute: max, currentCount: 0,
        windowStart: Date.now(), blocked: false, retryAfterMs: 0,
      };
    }

    this.maybeResetWindow(w);
    const blocked = w.count >= max;
    const elapsed = Date.now() - w.windowStart;
    const retryAfterMs = blocked ? Math.max(0, 60_000 - elapsed) : 0;

    return { url, maxPerMinute: max, currentCount: w.count, windowStart: w.windowStart, blocked, retryAfterMs };
  }

  /** Reset rate limit window for a URL. */
  resetUrl(url: string): boolean {
    const w = this.windows.get(url);
    if (!w) return false;
    w.count = 0;
    w.windowStart = Date.now();
    return true;
  }

  /** Remove a URL entirely. */
  removeUrl(url: string): boolean {
    return this.windows.delete(url);
  }

  /** Get all URLs currently at or above their limit. */
  getBlockedUrls(): WebhookRateLimit[] {
    const results: WebhookRateLimit[] = [];
    for (const url of this.windows.keys()) {
      const status = this.getStatus(url);
      if (status.blocked) results.push(status);
    }
    return results;
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): WebhookRateLimiterStats {
    return {
      trackedUrls: this.windows.size,
      totalDeliveries: this.totalDeliveries,
      totalBlocked: this.totalBlocked,
      overrideCount: this.overrides.size,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.windows.clear();
    this.overrides.clear();
    this.totalDeliveries = 0;
    this.totalBlocked = 0;
  }

  // ── Private ────────────────────────────────────────────────────

  private getMaxForUrl(url: string): number {
    return this.overrides.get(url) ?? this.defaultMax;
  }

  private getWindow(url: string): URLWindow {
    return this.windows.get(url) ?? { count: 0, windowStart: Date.now() };
  }

  private getOrCreateWindow(url: string): URLWindow {
    let w = this.windows.get(url);
    if (!w) {
      if (this.windows.size >= this.maxUrls) {
        // Evict oldest window
        let oldestUrl: string | null = null;
        let oldestTime = Infinity;
        for (const [u, win] of this.windows) {
          if (win.windowStart < oldestTime) { oldestTime = win.windowStart; oldestUrl = u; }
        }
        if (oldestUrl) this.windows.delete(oldestUrl);
      }
      w = { count: 0, windowStart: Date.now() };
      this.windows.set(url, w);
    }
    return w;
  }

  private maybeResetWindow(w: URLWindow): void {
    if (Date.now() - w.windowStart >= 60_000) {
      w.count = 0;
      w.windowStart = Date.now();
    }
  }
}
