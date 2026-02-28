/**
 * PriorityQueue — Request prioritization with weighted fair scheduling.
 *
 * When the system is under contention, higher-priority requests are
 * processed ahead of lower-priority ones. Each API key can be assigned
 * a priority tier (critical, high, normal, low, background).
 *
 * Features:
 *   - Five priority tiers with configurable max wait times
 *   - Per-key priority assignment
 *   - Max queue depth with per-tier limits
 *   - Starvation prevention via automatic promotion
 *   - Stats: queue depth per tier, average wait time, timeouts
 *
 * Zero external dependencies.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type PriorityTier = 'critical' | 'high' | 'normal' | 'low' | 'background';

export const PRIORITY_ORDER: PriorityTier[] = ['critical', 'high', 'normal', 'low', 'background'];
export const TIER_VALUES: Record<PriorityTier, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
  background: 4,
};

export interface PriorityQueueConfig {
  /** Enable priority queuing. Default false (disabled until explicitly enabled). */
  enabled: boolean;
  /** Max total queue depth. Default 1000. */
  maxQueueDepth: number;
  /** Max wait time per tier in ms. */
  maxWaitMs: Record<PriorityTier, number>;
  /** Starvation promotion interval in ms. Default 10_000 (10s). */
  promotionIntervalMs: number;
}

export interface QueuedRequest {
  id: string;
  apiKey: string;
  toolName: string;
  tier: PriorityTier;
  enqueuedAt: number;
  originalTier: PriorityTier;
  resolve: () => void;
  reject: (err: Error) => void;
}

export interface PriorityQueueStats {
  enabled: boolean;
  config: PriorityQueueConfig;
  currentDepth: number;
  depthPerTier: Record<PriorityTier, number>;
  totalEnqueued: number;
  totalProcessed: number;
  totalTimedOut: number;
  totalPromoted: number;
  avgWaitMs: number;
  keyPriorities: number;
}

// ─── Default config ─────────────────────────────────────────────────────────

const DEFAULT_PQ_CONFIG: PriorityQueueConfig = {
  enabled: false,
  maxQueueDepth: 1000,
  maxWaitMs: {
    critical: 1_000,
    high: 5_000,
    normal: 15_000,
    low: 30_000,
    background: 60_000,
  },
  promotionIntervalMs: 10_000,
};

// ─── PriorityQueue Class ────────────────────────────────────────────────────

export class PriorityQueue {
  private config: PriorityQueueConfig;
  private queue: QueuedRequest[] = [];
  private keyPriorities = new Map<string, PriorityTier>();

  // Stats
  private totalEnqueued = 0;
  private totalProcessed = 0;
  private totalTimedOut = 0;
  private totalPromoted = 0;
  private totalWaitMs = 0;
  private idCounter = 0;

  // Promotion timer
  private promotionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<PriorityQueueConfig>) {
    this.config = {
      ...DEFAULT_PQ_CONFIG,
      maxWaitMs: { ...DEFAULT_PQ_CONFIG.maxWaitMs, ...config?.maxWaitMs },
      ...config,
    };
    if (config?.maxWaitMs) {
      this.config.maxWaitMs = { ...DEFAULT_PQ_CONFIG.maxWaitMs, ...config.maxWaitMs };
    }

    if (this.config.enabled) {
      this.startPromotionTimer();
    }
  }

  /**
   * Set priority tier for an API key.
   */
  setKeyPriority(apiKey: string, tier: PriorityTier): void {
    if (!PRIORITY_ORDER.includes(tier)) {
      throw new Error(`Invalid priority tier: "${tier}". Must be one of: ${PRIORITY_ORDER.join(', ')}`);
    }
    this.keyPriorities.set(apiKey, tier);
  }

  /**
   * Get priority tier for an API key (default: 'normal').
   */
  getKeyPriority(apiKey: string): PriorityTier {
    return this.keyPriorities.get(apiKey) || 'normal';
  }

  /**
   * Remove priority assignment for an API key.
   */
  removeKeyPriority(apiKey: string): boolean {
    return this.keyPriorities.delete(apiKey);
  }

  /**
   * Enqueue a request. Resolves when the request should proceed.
   * Rejects if queue is full or wait time exceeds tier max.
   */
  async enqueue(apiKey: string, toolName: string): Promise<void> {
    if (!this.config.enabled) return;

    const tier = this.getKeyPriority(apiKey);

    // Critical requests bypass the queue
    if (tier === 'critical') return;

    if (this.queue.length >= this.config.maxQueueDepth) {
      throw new Error('Queue is full');
    }

    this.totalEnqueued++;
    const id = String(++this.idCounter);

    return new Promise<void>((resolve, reject) => {
      const entry: QueuedRequest = {
        id,
        apiKey,
        toolName,
        tier,
        enqueuedAt: Date.now(),
        originalTier: tier,
        resolve: () => {
          const waitMs = Date.now() - entry.enqueuedAt;
          this.totalWaitMs += waitMs;
          this.totalProcessed++;
          resolve();
        },
        reject,
      };

      // Insert in priority order
      const insertIdx = this.findInsertIndex(tier);
      this.queue.splice(insertIdx, 0, entry);

      // Set timeout for max wait
      const maxWait = this.config.maxWaitMs[tier];
      setTimeout(() => {
        const idx = this.queue.findIndex(q => q.id === id);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          this.totalTimedOut++;
          reject(new Error(`Request timed out in queue after ${maxWait}ms (tier: ${tier})`));
        }
      }, maxWait);
    });
  }

  /**
   * Dequeue the next highest-priority request.
   * Call this when capacity becomes available.
   */
  dequeue(): QueuedRequest | null {
    if (this.queue.length === 0) return null;
    const entry = this.queue.shift()!;
    entry.resolve();
    return entry;
  }

  /**
   * Dequeue up to N requests.
   */
  dequeueN(n: number): QueuedRequest[] {
    const result: QueuedRequest[] = [];
    for (let i = 0; i < n && this.queue.length > 0; i++) {
      const entry = this.queue.shift()!;
      entry.resolve();
      result.push(entry);
    }
    return result;
  }

  /**
   * Update configuration at runtime.
   */
  configure(updates: Partial<PriorityQueueConfig>): PriorityQueueConfig {
    if (updates.enabled !== undefined) {
      this.config.enabled = updates.enabled;
      if (updates.enabled && !this.promotionTimer) {
        this.startPromotionTimer();
      } else if (!updates.enabled && this.promotionTimer) {
        this.stopPromotionTimer();
      }
    }
    if (updates.maxQueueDepth !== undefined) {
      this.config.maxQueueDepth = Math.max(10, Math.min(10_000, updates.maxQueueDepth));
    }
    if (updates.maxWaitMs) {
      Object.assign(this.config.maxWaitMs, updates.maxWaitMs);
    }
    if (updates.promotionIntervalMs !== undefined) {
      this.config.promotionIntervalMs = Math.max(1_000, updates.promotionIntervalMs);
      // Restart timer with new interval
      if (this.promotionTimer) {
        this.stopPromotionTimer();
        this.startPromotionTimer();
      }
    }
    return this.currentConfig;
  }

  /**
   * Get queue statistics.
   */
  stats(): PriorityQueueStats {
    const depthPerTier: Record<PriorityTier, number> = {
      critical: 0, high: 0, normal: 0, low: 0, background: 0,
    };
    for (const entry of this.queue) {
      depthPerTier[entry.tier]++;
    }

    return {
      enabled: this.config.enabled,
      config: { ...this.config, maxWaitMs: { ...this.config.maxWaitMs } },
      currentDepth: this.queue.length,
      depthPerTier,
      totalEnqueued: this.totalEnqueued,
      totalProcessed: this.totalProcessed,
      totalTimedOut: this.totalTimedOut,
      totalPromoted: this.totalPromoted,
      avgWaitMs: this.totalProcessed > 0 ? Math.round(this.totalWaitMs / this.totalProcessed) : 0,
      keyPriorities: this.keyPriorities.size,
    };
  }

  /** Current queue depth. */
  get depth(): number {
    return this.queue.length;
  }

  /** Is queue enabled? */
  get isEnabled(): boolean {
    return this.config.enabled;
  }

  /** Current config (copy). */
  get currentConfig(): PriorityQueueConfig {
    return {
      ...this.config,
      maxWaitMs: { ...this.config.maxWaitMs },
    };
  }

  /**
   * Destroy the queue — stop timers and reject all pending.
   */
  destroy(): void {
    this.stopPromotionTimer();
    for (const entry of this.queue) {
      entry.reject(new Error('Queue destroyed'));
    }
    this.queue = [];
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private findInsertIndex(tier: PriorityTier): number {
    const tierValue = TIER_VALUES[tier];
    // Find the first entry with a lower priority (higher tier value)
    for (let i = 0; i < this.queue.length; i++) {
      if (TIER_VALUES[this.queue[i].tier] > tierValue) {
        return i;
      }
    }
    return this.queue.length;
  }

  private promoteStarvedRequests(): void {
    const now = Date.now();
    for (const entry of this.queue) {
      const waitMs = now - entry.enqueuedAt;
      if (waitMs > this.config.promotionIntervalMs && entry.tier !== 'high') {
        const currentIdx = PRIORITY_ORDER.indexOf(entry.tier);
        if (currentIdx > 1) { // Don't promote beyond 'high'
          entry.tier = PRIORITY_ORDER[currentIdx - 1];
          this.totalPromoted++;
        }
      }
    }
    // Re-sort after promotions
    this.queue.sort((a, b) => TIER_VALUES[a.tier] - TIER_VALUES[b.tier]);
  }

  private startPromotionTimer(): void {
    this.promotionTimer = setInterval(() => {
      this.promoteStarvedRequests();
    }, this.config.promotionIntervalMs);
    this.promotionTimer.unref();
  }

  private stopPromotionTimer(): void {
    if (this.promotionTimer) {
      clearInterval(this.promotionTimer);
      this.promotionTimer = null;
    }
  }
}
