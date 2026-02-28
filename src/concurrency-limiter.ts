/**
 * ConcurrencyLimiter — Caps simultaneous in-flight requests per key/tool.
 *
 * Unlike rate limiting (calls per time window), this limits active concurrent
 * requests. Protects backend MCP servers from burst parallelism, especially
 * from autonomous agents firing many parallel tool calls.
 *
 * Zero external dependencies. Purely synchronous increment/decrement tracking.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ConcurrencyLimiterConfig {
  /** Max concurrent in-flight requests per API key. 0 = unlimited. Default: 0. */
  maxConcurrentPerKey: number;
  /** Max concurrent in-flight requests per tool. 0 = unlimited. Default: 0. */
  maxConcurrentPerTool: number;
}

export interface ConcurrencySnapshot {
  /** Per-key inflight counts. */
  byKey: Record<string, number>;
  /** Per-tool inflight counts. */
  byTool: Record<string, number>;
  /** Per key:tool composite inflight counts. */
  byKeyTool: Record<string, number>;
  /** Total inflight across all keys. */
  totalInflight: number;
}

export interface ConcurrencyAcquireResult {
  acquired: boolean;
  reason?: string;
  currentInflight?: number;
  limit?: number;
}

// ─── Default Config ─────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ConcurrencyLimiterConfig = {
  maxConcurrentPerKey: 0,
  maxConcurrentPerTool: 0,
};

// ─── ConcurrencyLimiter Class ───────────────────────────────────────────────

export class ConcurrencyLimiter {
  private readonly config: ConcurrencyLimiterConfig;
  private readonly byKey = new Map<string, number>();
  private readonly byTool = new Map<string, number>();
  private readonly byKeyTool = new Map<string, number>();

  constructor(config?: Partial<ConcurrencyLimiterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Attempt to acquire a concurrency slot.
   * Returns { acquired: true } if the request can proceed.
   * Returns { acquired: false, reason, currentInflight, limit } if at capacity.
   *
   * Caller MUST call release() when the request completes (success or failure).
   */
  acquire(apiKey: string, toolName: string): ConcurrencyAcquireResult {
    // Check per-key limit
    if (this.config.maxConcurrentPerKey > 0) {
      const current = this.byKey.get(apiKey) || 0;
      if (current >= this.config.maxConcurrentPerKey) {
        return {
          acquired: false,
          reason: `Key concurrency limit exceeded (${current}/${this.config.maxConcurrentPerKey})`,
          currentInflight: current,
          limit: this.config.maxConcurrentPerKey,
        };
      }
    }

    // Check per-tool limit
    if (this.config.maxConcurrentPerTool > 0) {
      const current = this.byTool.get(toolName) || 0;
      if (current >= this.config.maxConcurrentPerTool) {
        return {
          acquired: false,
          reason: `Tool concurrency limit exceeded for "${toolName}" (${current}/${this.config.maxConcurrentPerTool})`,
          currentInflight: current,
          limit: this.config.maxConcurrentPerTool,
        };
      }
    }

    // Acquire — increment all counters
    this.byKey.set(apiKey, (this.byKey.get(apiKey) || 0) + 1);
    this.byTool.set(toolName, (this.byTool.get(toolName) || 0) + 1);
    const composite = `${apiKey}:${toolName}`;
    this.byKeyTool.set(composite, (this.byKeyTool.get(composite) || 0) + 1);

    return { acquired: true };
  }

  /**
   * Release a concurrency slot. Must be called after acquire() succeeds.
   */
  release(apiKey: string, toolName: string): void {
    const keyCount = this.byKey.get(apiKey) || 0;
    if (keyCount <= 1) {
      this.byKey.delete(apiKey);
    } else {
      this.byKey.set(apiKey, keyCount - 1);
    }

    const toolCount = this.byTool.get(toolName) || 0;
    if (toolCount <= 1) {
      this.byTool.delete(toolName);
    } else {
      this.byTool.set(toolName, toolCount - 1);
    }

    const composite = `${apiKey}:${toolName}`;
    const compositeCount = this.byKeyTool.get(composite) || 0;
    if (compositeCount <= 1) {
      this.byKeyTool.delete(composite);
    } else {
      this.byKeyTool.set(composite, compositeCount - 1);
    }
  }

  /**
   * Get current inflight count for a key.
   */
  getKeyInflight(apiKey: string): number {
    return this.byKey.get(apiKey) || 0;
  }

  /**
   * Get current inflight count for a tool.
   */
  getToolInflight(toolName: string): number {
    return this.byTool.get(toolName) || 0;
  }

  /**
   * Get full concurrency snapshot for admin endpoint.
   */
  snapshot(): ConcurrencySnapshot {
    const byKey: Record<string, number> = {};
    for (const [k, v] of this.byKey) byKey[k] = v;

    const byTool: Record<string, number> = {};
    for (const [k, v] of this.byTool) byTool[k] = v;

    const byKeyTool: Record<string, number> = {};
    for (const [k, v] of this.byKeyTool) byKeyTool[k] = v;

    let totalInflight = 0;
    for (const v of this.byKey.values()) totalInflight += v;

    return { byKey, byTool, byKeyTool, totalInflight };
  }

  /**
   * Check if limiting is enabled.
   */
  get enabled(): boolean {
    return this.config.maxConcurrentPerKey > 0 || this.config.maxConcurrentPerTool > 0;
  }

  /**
   * Get current config.
   */
  get limits(): ConcurrencyLimiterConfig {
    return { ...this.config };
  }
}
