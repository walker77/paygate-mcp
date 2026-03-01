import { RateLimitTokenBucket } from '../src/token-bucket';

describe('RateLimitTokenBucket', () => {
  let bucket: RateLimitTokenBucket;

  beforeEach(() => {
    bucket = new RateLimitTokenBucket({ capacity: 100, refillRate: 10, refillIntervalMs: 1000 });
  });

  afterEach(() => {
    bucket.destroy();
  });

  // ── Consume ─────────────────────────────────────────────────────

  describe('consume', () => {
    it('allows consumption within capacity', () => {
      const result = bucket.consume('k1', 5);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(95);
      expect(result.retryAfterMs).toBe(0);
    });

    it('denies when insufficient tokens', () => {
      bucket.consume('k1', 95);
      const result = bucket.consume('k1', 10);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(5);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it('defaults to consuming 1 token', () => {
      const result = bucket.consume('k1');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(99);
    });

    it('tracks per-key independently', () => {
      bucket.consume('k1', 50);
      bucket.consume('k2', 30);

      const r1 = bucket.consume('k1', 1);
      const r2 = bucket.consume('k2', 1);
      expect(r1.remaining).toBe(49);
      expect(r2.remaining).toBe(69);
    });

    it('denies exact capacity + 1', () => {
      bucket.consume('k1', 100);
      const result = bucket.consume('k1', 1);
      expect(result.allowed).toBe(false);
    });
  });

  // ── Refill ──────────────────────────────────────────────────────

  describe('refill', () => {
    it('refills tokens over time', async () => {
      bucket.consume('k1', 100); // drain all

      await new Promise(r => setTimeout(r, 1100)); // wait > 1 interval

      const result = bucket.consume('k1', 5);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThanOrEqual(5);
    });

    it('does not exceed capacity on refill', async () => {
      bucket.consume('k1', 5); // 95 remaining

      await new Promise(r => setTimeout(r, 1100));

      const state = bucket.peek('k1');
      expect(state.tokens).toBeLessThanOrEqual(100);
    });
  });

  // ── Peek ────────────────────────────────────────────────────────

  describe('peek', () => {
    it('returns full capacity for unknown key', () => {
      const state = bucket.peek('unknown');
      expect(state.tokens).toBe(100);
      expect(state.capacity).toBe(100);
    });

    it('returns current tokens without consuming', () => {
      bucket.consume('k1', 20);
      const state = bucket.peek('k1');
      expect(state.tokens).toBe(80);

      // Peek again — should be the same
      const state2 = bucket.peek('k1');
      expect(state2.tokens).toBe(80);
    });
  });

  // ── Reset & Remove ─────────────────────────────────────────────

  describe('reset and remove', () => {
    it('resets bucket to full capacity', () => {
      bucket.consume('k1', 80);
      expect(bucket.reset('k1')).toBe(true);
      const state = bucket.peek('k1');
      expect(state.tokens).toBe(100);
    });

    it('returns false for unknown reset', () => {
      expect(bucket.reset('unknown')).toBe(false);
    });

    it('removes a bucket', () => {
      bucket.consume('k1', 10);
      expect(bucket.remove('k1')).toBe(true);
      // After removal, peek returns full capacity (new bucket)
      const state = bucket.peek('k1');
      expect(state.tokens).toBe(100);
    });
  });

  // ── List Buckets ────────────────────────────────────────────────

  describe('listBuckets', () => {
    it('lists tracked buckets', () => {
      bucket.consume('k1', 10);
      bucket.consume('k2', 20);
      bucket.consume('k3', 30);

      const list = bucket.listBuckets();
      expect(list).toHaveLength(3);
    });

    it('respects limit', () => {
      bucket.consume('k1', 10);
      bucket.consume('k2', 20);
      bucket.consume('k3', 30);

      const list = bucket.listBuckets(2);
      expect(list).toHaveLength(2);
    });
  });

  // ── Eviction ────────────────────────────────────────────────────

  describe('eviction', () => {
    it('evicts LRU key at capacity', () => {
      const small = new RateLimitTokenBucket({ maxKeys: 3 });
      small.consume('k1', 1);
      small.consume('k2', 1);
      small.consume('k3', 1);
      small.consume('k4', 1); // k1 should be evicted

      expect(small.getStats().trackedKeys).toBe(3);
      small.destroy();
    });
  });

  // ── Stats & Destroy ─────────────────────────────────────────────

  describe('stats and destroy', () => {
    it('tracks comprehensive stats', () => {
      bucket.consume('k1', 10);
      bucket.consume('k1', 10);
      bucket.consume('k1', 90); // denied — only 80 left

      const stats = bucket.getStats();
      expect(stats.trackedKeys).toBe(1);
      expect(stats.totalRequests).toBe(3);
      expect(stats.totalAllowed).toBe(2);
      expect(stats.totalDenied).toBe(1);
      expect(stats.totalTokensConsumed).toBe(20);
    });

    it('destroy resets everything', () => {
      bucket.consume('k1', 10);
      bucket.destroy();

      const stats = bucket.getStats();
      expect(stats.trackedKeys).toBe(0);
      expect(stats.totalRequests).toBe(0);
    });
  });
});
