/**
 * RequestPriorityRouter — Route requests based on priority tiers.
 *
 * Assign API keys to priority tiers (critical, high, normal, low)
 * and route requests with tier-aware ordering.
 *
 * @example
 * ```ts
 * const router = new RequestPriorityRouter();
 *
 * router.setKeyTier('key_vip', 'critical');
 * router.setKeyTier('key_free', 'low');
 *
 * router.enqueue({ key: 'key_vip', payload: data1 });
 * router.enqueue({ key: 'key_free', payload: data2 });
 *
 * const next = router.dequeue(); // returns key_vip request first
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type PriorityTier = 'critical' | 'high' | 'normal' | 'low';

const TIER_ORDER: Record<PriorityTier, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export interface PriorityRequest {
  id: string;
  key: string;
  tier: PriorityTier;
  payload: unknown;
  enqueuedAt: number;
}

export interface PriorityEnqueueParams {
  key: string;
  payload: unknown;
  tier?: PriorityTier; // override key's default tier
}

export interface TierConfig {
  tier: PriorityTier;
  maxQueueDepth: number;
}

export interface TierStatus {
  tier: PriorityTier;
  queued: number;
  maxQueueDepth: number;
  processed: number;
}

export interface RequestPriorityRouterConfig {
  /** Max queue depth per tier. Default 1000. */
  maxQueueDepthPerTier?: number;
  /** Default tier for unknown keys. Default 'normal'. */
  defaultTier?: PriorityTier;
}

export interface RequestPriorityRouterStats {
  totalQueued: number;
  totalProcessed: number;
  totalRejected: number;
  keyCount: number;
  tierBreakdown: TierStatus[];
}

// ── Implementation ───────────────────────────────────────────────────

export class RequestPriorityRouter {
  private queues = new Map<PriorityTier, PriorityRequest[]>();
  private keyTiers = new Map<string, PriorityTier>();
  private tierMaxDepth = new Map<PriorityTier, number>();
  private nextId = 1;
  private defaultTier: PriorityTier;
  private defaultMaxDepth: number;

  // Stats
  private processed = new Map<PriorityTier, number>();
  private totalRejected = 0;

  constructor(config: RequestPriorityRouterConfig = {}) {
    this.defaultMaxDepth = config.maxQueueDepthPerTier ?? 1000;
    this.defaultTier = config.defaultTier ?? 'normal';

    // Initialize queues for all tiers
    for (const tier of Object.keys(TIER_ORDER) as PriorityTier[]) {
      this.queues.set(tier, []);
      this.processed.set(tier, 0);
    }
  }

  // ── Key Tier Management ────────────────────────────────────────

  /** Set priority tier for a key. */
  setKeyTier(key: string, tier: PriorityTier): void {
    this.keyTiers.set(key, tier);
  }

  /** Get priority tier for a key. */
  getKeyTier(key: string): PriorityTier {
    return this.keyTiers.get(key) ?? this.defaultTier;
  }

  /** Remove key tier assignment. */
  removeKeyTier(key: string): boolean {
    return this.keyTiers.delete(key);
  }

  /** Set max queue depth for a tier. */
  setTierMaxDepth(tier: PriorityTier, maxDepth: number): void {
    if (maxDepth <= 0) throw new Error('maxDepth must be positive');
    this.tierMaxDepth.set(tier, maxDepth);
  }

  // ── Enqueue / Dequeue ──────────────────────────────────────────

  /** Enqueue a request. */
  enqueue(params: PriorityEnqueueParams): PriorityRequest | null {
    const tier = params.tier ?? this.getKeyTier(params.key);
    const queue = this.queues.get(tier)!;
    const max = this.tierMaxDepth.get(tier) ?? this.defaultMaxDepth;

    if (queue.length >= max) {
      this.totalRejected++;
      return null;
    }

    const request: PriorityRequest = {
      id: `pr_${this.nextId++}`,
      key: params.key,
      tier,
      payload: params.payload,
      enqueuedAt: Date.now(),
    };

    queue.push(request);
    return request;
  }

  /** Dequeue the highest-priority request. */
  dequeue(): PriorityRequest | null {
    for (const tier of Object.keys(TIER_ORDER) as PriorityTier[]) {
      const queue = this.queues.get(tier)!;
      if (queue.length > 0) {
        const request = queue.shift()!;
        this.processed.set(tier, (this.processed.get(tier) ?? 0) + 1);
        return request;
      }
    }
    return null;
  }

  /** Peek at the next request without removing. */
  peek(): PriorityRequest | null {
    for (const tier of Object.keys(TIER_ORDER) as PriorityTier[]) {
      const queue = this.queues.get(tier)!;
      if (queue.length > 0) return queue[0];
    }
    return null;
  }

  /** Dequeue up to N requests in priority order. */
  dequeueBatch(count: number): PriorityRequest[] {
    const results: PriorityRequest[] = [];
    for (let i = 0; i < count; i++) {
      const req = this.dequeue();
      if (!req) break;
      results.push(req);
    }
    return results;
  }

  // ── Query ──────────────────────────────────────────────────────

  /** Get total queued count. */
  getTotalQueued(): number {
    let total = 0;
    for (const queue of this.queues.values()) total += queue.length;
    return total;
  }

  /** Get status for a specific tier. */
  getTierStatus(tier: PriorityTier): TierStatus {
    const queue = this.queues.get(tier)!;
    return {
      tier,
      queued: queue.length,
      maxQueueDepth: this.tierMaxDepth.get(tier) ?? this.defaultMaxDepth,
      processed: this.processed.get(tier) ?? 0,
    };
  }

  /** Clear queue for a specific tier. */
  clearTier(tier: PriorityTier): number {
    const queue = this.queues.get(tier)!;
    const count = queue.length;
    queue.length = 0;
    return count;
  }

  /** Cancel a specific request by ID. */
  cancel(requestId: string): boolean {
    for (const queue of this.queues.values()) {
      const idx = queue.findIndex(r => r.id === requestId);
      if (idx !== -1) {
        queue.splice(idx, 1);
        return true;
      }
    }
    return false;
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): RequestPriorityRouterStats {
    let totalQueued = 0;
    let totalProcessed = 0;
    const tierBreakdown: TierStatus[] = [];

    for (const tier of Object.keys(TIER_ORDER) as PriorityTier[]) {
      const status = this.getTierStatus(tier);
      totalQueued += status.queued;
      totalProcessed += status.processed;
      tierBreakdown.push(status);
    }

    return {
      totalQueued,
      totalProcessed,
      totalRejected: this.totalRejected,
      keyCount: this.keyTiers.size,
      tierBreakdown,
    };
  }

  /** Clear all data. */
  destroy(): void {
    for (const queue of this.queues.values()) queue.length = 0;
    this.keyTiers.clear();
    this.tierMaxDepth.clear();
    for (const tier of Object.keys(TIER_ORDER) as PriorityTier[]) {
      this.processed.set(tier, 0);
    }
    this.totalRejected = 0;
  }
}
