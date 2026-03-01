import { RequestPriorityRouter } from '../src/request-priority-router';

describe('RequestPriorityRouter', () => {
  let router: RequestPriorityRouter;

  beforeEach(() => {
    router = new RequestPriorityRouter({ maxQueueDepthPerTier: 5 });
  });

  afterEach(() => {
    router.destroy();
  });

  // ── Key Tier Management ────────────────────────────────────────────

  describe('key tier management', () => {
    it('sets and gets key tier', () => {
      router.setKeyTier('key_vip', 'critical');
      expect(router.getKeyTier('key_vip')).toBe('critical');
    });

    it('returns default tier for unknown key', () => {
      expect(router.getKeyTier('unknown')).toBe('normal');
    });

    it('removes key tier', () => {
      router.setKeyTier('key_a', 'high');
      expect(router.removeKeyTier('key_a')).toBe(true);
      expect(router.getKeyTier('key_a')).toBe('normal');
    });

    it('returns false for unknown key removal', () => {
      expect(router.removeKeyTier('unknown')).toBe(false);
    });

    it('sets tier max depth', () => {
      router.setTierMaxDepth('critical', 100);
      expect(router.getTierStatus('critical').maxQueueDepth).toBe(100);
    });

    it('rejects non-positive max depth', () => {
      expect(() => router.setTierMaxDepth('high', 0)).toThrow();
    });
  });

  // ── Enqueue / Dequeue ──────────────────────────────────────────────

  describe('enqueue and dequeue', () => {
    it('enqueues a request', () => {
      const req = router.enqueue({ key: 'k1', payload: { data: 1 } });
      expect(req).not.toBeNull();
      expect(req!.id).toMatch(/^pr_/);
      expect(req!.tier).toBe('normal');
    });

    it('uses key tier for enqueue', () => {
      router.setKeyTier('k1', 'critical');
      const req = router.enqueue({ key: 'k1', payload: {} });
      expect(req!.tier).toBe('critical');
    });

    it('allows tier override in enqueue', () => {
      router.setKeyTier('k1', 'low');
      const req = router.enqueue({ key: 'k1', payload: {}, tier: 'high' });
      expect(req!.tier).toBe('high');
    });

    it('rejects when tier queue is full', () => {
      for (let i = 0; i < 5; i++) router.enqueue({ key: 'k', payload: i });
      const result = router.enqueue({ key: 'k', payload: 'overflow' });
      expect(result).toBeNull();
    });

    it('dequeues in priority order', () => {
      router.enqueue({ key: 'free', payload: 'low', tier: 'low' });
      router.enqueue({ key: 'paid', payload: 'normal', tier: 'normal' });
      router.enqueue({ key: 'vip', payload: 'critical', tier: 'critical' });
      router.enqueue({ key: 'pro', payload: 'high', tier: 'high' });

      expect(router.dequeue()!.tier).toBe('critical');
      expect(router.dequeue()!.tier).toBe('high');
      expect(router.dequeue()!.tier).toBe('normal');
      expect(router.dequeue()!.tier).toBe('low');
    });

    it('returns null when all queues empty', () => {
      expect(router.dequeue()).toBeNull();
    });

    it('maintains FIFO within same tier', () => {
      router.enqueue({ key: 'a', payload: 'first', tier: 'normal' });
      router.enqueue({ key: 'b', payload: 'second', tier: 'normal' });
      expect(router.dequeue()!.payload).toBe('first');
      expect(router.dequeue()!.payload).toBe('second');
    });
  });

  // ── Peek and Batch ─────────────────────────────────────────────────

  describe('peek and batch', () => {
    it('peeks without removing', () => {
      router.enqueue({ key: 'k1', payload: 'test', tier: 'high' });
      const peeked = router.peek();
      expect(peeked).not.toBeNull();
      expect(peeked!.payload).toBe('test');
      expect(router.getTotalQueued()).toBe(1); // still in queue
    });

    it('returns null for empty peek', () => {
      expect(router.peek()).toBeNull();
    });

    it('dequeues batch in priority order', () => {
      router.enqueue({ key: 'a', payload: 1, tier: 'low' });
      router.enqueue({ key: 'b', payload: 2, tier: 'critical' });
      router.enqueue({ key: 'c', payload: 3, tier: 'normal' });

      const batch = router.dequeueBatch(2);
      expect(batch).toHaveLength(2);
      expect(batch[0].tier).toBe('critical');
      expect(batch[1].tier).toBe('normal');
    });

    it('batch returns fewer if queue depleted', () => {
      router.enqueue({ key: 'a', payload: 1 });
      const batch = router.dequeueBatch(5);
      expect(batch).toHaveLength(1);
    });
  });

  // ── Query ──────────────────────────────────────────────────────────

  describe('query', () => {
    it('gets total queued', () => {
      router.enqueue({ key: 'a', payload: 1, tier: 'high' });
      router.enqueue({ key: 'b', payload: 2, tier: 'low' });
      expect(router.getTotalQueued()).toBe(2);
    });

    it('gets tier status', () => {
      router.enqueue({ key: 'a', payload: 1, tier: 'critical' });
      router.enqueue({ key: 'b', payload: 2, tier: 'critical' });
      const status = router.getTierStatus('critical');
      expect(status.queued).toBe(2);
      expect(status.tier).toBe('critical');
    });

    it('clears a tier', () => {
      router.enqueue({ key: 'a', payload: 1, tier: 'low' });
      router.enqueue({ key: 'b', payload: 2, tier: 'low' });
      expect(router.clearTier('low')).toBe(2);
      expect(router.getTierStatus('low').queued).toBe(0);
    });

    it('cancels a request', () => {
      const req = router.enqueue({ key: 'a', payload: 1 });
      expect(router.cancel(req!.id)).toBe(true);
      expect(router.getTotalQueued()).toBe(0);
    });

    it('returns false for unknown cancel', () => {
      expect(router.cancel('pr_999')).toBe(false);
    });
  });

  // ── Stats & Destroy ────────────────────────────────────────────────

  describe('stats and destroy', () => {
    it('tracks comprehensive stats', () => {
      router.setKeyTier('vip', 'critical');
      router.enqueue({ key: 'vip', payload: 1 });
      router.enqueue({ key: 'free', payload: 2, tier: 'low' });
      router.dequeue(); // process critical

      const stats = router.getStats();
      expect(stats.totalQueued).toBe(1);
      expect(stats.totalProcessed).toBe(1);
      expect(stats.keyCount).toBe(1);
      expect(stats.tierBreakdown).toHaveLength(4);
    });

    it('tracks rejections', () => {
      for (let i = 0; i < 5; i++) router.enqueue({ key: 'k', payload: i });
      router.enqueue({ key: 'k', payload: 'overflow' });
      expect(router.getStats().totalRejected).toBe(1);
    });

    it('destroy resets everything', () => {
      router.enqueue({ key: 'k', payload: 1 });
      router.destroy();
      expect(router.getStats().totalQueued).toBe(0);
      expect(router.getStats().totalRejected).toBe(0);
    });
  });
});
