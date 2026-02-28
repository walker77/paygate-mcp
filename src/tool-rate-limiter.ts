/**
 * Per-Tool Rate Limiter — Tool-Specific Rate Limiting.
 *
 * Apply different rate limits to different tools. Expensive tools
 * can have stricter limits (10 calls/min) while cheap tools
 * can have generous limits (1000 calls/min).
 *
 * Uses sliding window algorithm per key+tool combination.
 *
 * Use cases:
 *   - Protect expensive AI inference tools with tight limits
 *   - Allow generous limits for cheap data retrieval tools
 *   - Different tiers get different per-tool allocations
 *
 * Zero external dependencies.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ToolRateRule {
  /** Tool name pattern (exact match or '*' for default). */
  tool: string;
  /** Maximum calls per window. */
  maxCalls: number;
  /** Window size in seconds. */
  windowSeconds: number;
  /** Whether this rule is active. */
  active: boolean;
  /** Optional description. */
  description?: string;
}

export interface ToolRateCheckResult {
  /** Whether the call is allowed. */
  allowed: boolean;
  /** The tool being checked. */
  tool: string;
  /** The key being checked. */
  key: string;
  /** Calls used in current window. */
  used: number;
  /** Maximum calls allowed. */
  limit: number;
  /** Seconds until the oldest call in window expires. */
  retryAfterSeconds: number;
  /** Which rule was applied. */
  ruleApplied: string;
}

export interface ToolRateLimiterConfig {
  /** Maximum rules. Default: 500. */
  maxRules?: number;
  /** Default window size in seconds if no rule matches. Default: 60. */
  defaultWindowSeconds?: number;
  /** Default max calls if no rule matches. Default: 60. */
  defaultMaxCalls?: number;
  /** Maximum tracked key+tool combos. Default: 100000. */
  maxTracked?: number;
}

export interface ToolRateLimiterStats {
  /** Total rules configured. */
  totalRules: number;
  /** Active rules. */
  activeRules: number;
  /** Total checks performed. */
  totalChecks: number;
  /** Total denials. */
  totalDenials: number;
  /** Denials by tool. */
  denialsByTool: Record<string, number>;
  /** Active key+tool combos being tracked. */
  activeTracking: number;
}

// ─── Sliding Window Entry ────────────────────────────────────────────────────

interface WindowEntry {
  timestamps: number[]; // Call timestamps in ms
}

// ─── Per-Tool Rate Limiter ───────────────────────────────────────────────────

export class ToolRateLimiter {
  private rules = new Map<string, ToolRateRule>(); // tool → rule
  private windows = new Map<string, WindowEntry>(); // "key:tool" → window
  private maxRules: number;
  private defaultWindowSeconds: number;
  private defaultMaxCalls: number;
  private maxTracked: number;

  // Stats
  private totalChecks = 0;
  private totalDenials = 0;
  private denialsByTool: Record<string, number> = {};

  constructor(config: ToolRateLimiterConfig = {}) {
    this.maxRules = config.maxRules ?? 500;
    this.defaultWindowSeconds = config.defaultWindowSeconds ?? 60;
    this.defaultMaxCalls = config.defaultMaxCalls ?? 60;
    this.maxTracked = config.maxTracked ?? 100_000;
  }

  /** Add or update a rate rule for a tool. */
  upsertRule(rule: ToolRateRule): boolean {
    if (this.rules.size >= this.maxRules && !this.rules.has(rule.tool)) {
      return false;
    }
    if (rule.maxCalls < 0 || rule.windowSeconds <= 0) return false;

    this.rules.set(rule.tool, { ...rule });
    return true;
  }

  /** Remove a rule. */
  removeRule(tool: string): boolean {
    return this.rules.delete(tool);
  }

  /** Get a rule. */
  getRule(tool: string): ToolRateRule | null {
    return this.rules.get(tool) ?? null;
  }

  /** Get all rules. */
  getRules(): ToolRateRule[] {
    return [...this.rules.values()];
  }

  /**
   * Check if a tool call is allowed for a given key.
   * If allowed, records the call in the sliding window.
   */
  check(key: string, tool: string): ToolRateCheckResult {
    this.totalChecks++;

    const rule = this.resolveRule(tool);
    const windowKey = `${key}:${tool}`;
    const now = Date.now();
    const windowMs = rule.windowSeconds * 1000;

    // Get or create window
    let entry = this.windows.get(windowKey);
    if (!entry) {
      if (this.windows.size >= this.maxTracked) {
        this.evictOldest();
      }
      entry = { timestamps: [] };
      this.windows.set(windowKey, entry);
    }

    // Remove expired timestamps
    const cutoff = now - windowMs;
    entry.timestamps = entry.timestamps.filter(ts => ts > cutoff);

    const used = entry.timestamps.length;

    if (used >= rule.maxCalls) {
      this.totalDenials++;
      this.denialsByTool[tool] = (this.denialsByTool[tool] ?? 0) + 1;

      // Calculate retry-after: time until oldest timestamp expires
      const oldestInWindow = entry.timestamps[0] ?? now;
      const retryAfterMs = (oldestInWindow + windowMs) - now;
      const retryAfterSeconds = Math.max(0, Math.ceil(retryAfterMs / 1000));

      return {
        allowed: false,
        tool,
        key,
        used,
        limit: rule.maxCalls,
        retryAfterSeconds,
        ruleApplied: rule.tool,
      };
    }

    // Record call
    entry.timestamps.push(now);

    return {
      allowed: true,
      tool,
      key,
      used: used + 1,
      limit: rule.maxCalls,
      retryAfterSeconds: 0,
      ruleApplied: rule.tool,
    };
  }

  /**
   * Check without recording (peek).
   */
  peek(key: string, tool: string): ToolRateCheckResult {
    const rule = this.resolveRule(tool);
    const windowKey = `${key}:${tool}`;
    const now = Date.now();
    const windowMs = rule.windowSeconds * 1000;

    const entry = this.windows.get(windowKey);
    if (!entry) {
      return { allowed: true, tool, key, used: 0, limit: rule.maxCalls, retryAfterSeconds: 0, ruleApplied: rule.tool };
    }

    const cutoff = now - windowMs;
    const active = entry.timestamps.filter(ts => ts > cutoff);
    const used = active.length;

    if (used >= rule.maxCalls) {
      const oldestInWindow = active[0] ?? now;
      const retryAfterMs = (oldestInWindow + windowMs) - now;
      return {
        allowed: false,
        tool,
        key,
        used,
        limit: rule.maxCalls,
        retryAfterSeconds: Math.max(0, Math.ceil(retryAfterMs / 1000)),
        ruleApplied: rule.tool,
      };
    }

    return { allowed: true, tool, key, used, limit: rule.maxCalls, retryAfterSeconds: 0, ruleApplied: rule.tool };
  }

  /** Reset the window for a specific key+tool. */
  resetWindow(key: string, tool: string): boolean {
    return this.windows.delete(`${key}:${tool}`);
  }

  /** Reset all windows for a key. */
  resetKey(key: string): number {
    let count = 0;
    for (const wKey of this.windows.keys()) {
      if (wKey.startsWith(`${key}:`)) {
        this.windows.delete(wKey);
        count++;
      }
    }
    return count;
  }

  /** Get stats. */
  getStats(): ToolRateLimiterStats {
    return {
      totalRules: this.rules.size,
      activeRules: [...this.rules.values()].filter(r => r.active).length,
      totalChecks: this.totalChecks,
      totalDenials: this.totalDenials,
      denialsByTool: { ...this.denialsByTool },
      activeTracking: this.windows.size,
    };
  }

  /** Reset stats. */
  resetStats(): void {
    this.totalChecks = 0;
    this.totalDenials = 0;
    this.denialsByTool = {};
  }

  /** Destroy and release resources. */
  destroy(): void {
    this.rules.clear();
    this.windows.clear();
    this.resetStats();
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private resolveRule(tool: string): ToolRateRule {
    // Exact match first
    const exact = this.rules.get(tool);
    if (exact && exact.active) return exact;

    // Wildcard default
    const wildcard = this.rules.get('*');
    if (wildcard && wildcard.active) return wildcard;

    // Built-in default
    return {
      tool: '*',
      maxCalls: this.defaultMaxCalls,
      windowSeconds: this.defaultWindowSeconds,
      active: true,
    };
  }

  private evictOldest(): void {
    // Remove 10% of oldest entries
    const now = Date.now();
    const entries = [...this.windows.entries()];
    entries.sort((a, b) => {
      const aLast = a[1].timestamps[a[1].timestamps.length - 1] ?? 0;
      const bLast = b[1].timestamps[b[1].timestamps.length - 1] ?? 0;
      return aLast - bLast;
    });
    const toRemove = Math.max(1, Math.floor(entries.length * 0.1));
    for (let i = 0; i < toRemove; i++) {
      this.windows.delete(entries[i][0]);
    }
  }
}
