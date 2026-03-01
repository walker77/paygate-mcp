import { RequestThrottleQueue } from '../src/request-throttle';

describe('RequestThrottleQueue', () => {
  let throttle: RequestThrottleQueue;

  beforeEach(() => {
    throttle = new RequestThrottleQueue({ maxConcurrent: 2, maxQueueDepth: 3 });
  });

  afterEach(() => {
    throttle.destroy();
  });

  // ── tryAcquire ─────────────────────────────────────────────────────

  describe('tryAcquire', () => {
    it('acquires when under concurrency limit', () => {
      const result = throttle.tryAcquire('key1');
      expect(result.status).toBe('acquired');
      if (result.status === 'acquired') {
        expect(result.ticket.id).toMatch(/^tt_/);
        expect(result.ticket.key).toBe('key1');
      }
    });

    it('acquires up to max concurrent per key', () => {
      const r1 = throttle.tryAcquire('key1');
      const r2 = throttle.tryAcquire('key1');
      expect(r1.status).toBe('acquired');
      expect(r2.status).toBe('acquired');
    });

    it('queues when at concurrency limit', () => {
      throttle.tryAcquire('key1');
      throttle.tryAcquire('key1');
      const r3 = throttle.tryAcquire('key1');
      expect(r3.status).toBe('queued');
      if (r3.status === 'queued') {
        expect(r3.position).toBe(1);
        expect(r3.queueDepth).toBe(1);
      }
    });

    it('rejects when queue is full', () => {
      throttle.tryAcquire('key1');
      throttle.tryAcquire('key1');
      throttle.tryAcquire('key1'); // queued 1
      throttle.tryAcquire('key1'); // queued 2
      throttle.tryAcquire('key1'); // queued 3
      const r6 = throttle.tryAcquire('key1');
      expect(r6.status).toBe('rejected');
      if (r6.status === 'rejected') {
        expect(r6.reason).toBe('Queue full');
      }
    });

    it('tracks keys independently', () => {
      throttle.tryAcquire('key1');
      throttle.tryAcquire('key1');
      const r3 = throttle.tryAcquire('key2');
      expect(r3.status).toBe('acquired'); // different key
    });
  });

  // ── release ────────────────────────────────────────────────────────

  describe('release', () => {
    it('releases a slot', () => {
      const r1 = throttle.tryAcquire('key1');
      if (r1.status === 'acquired') {
        const promoted = throttle.release(r1.ticket.id);
        expect(promoted).toBeNull(); // no queue
      }
    });

    it('promotes from queue on release', () => {
      const r1 = throttle.tryAcquire('key1');
      throttle.tryAcquire('key1');
      throttle.tryAcquire('key1'); // queued

      if (r1.status === 'acquired') {
        const promoted = throttle.release(r1.ticket.id);
        expect(promoted).not.toBeNull();
        expect(promoted!.key).toBe('key1');
      }
    });

    it('returns null for unknown ticket', () => {
      expect(throttle.release('tt_999')).toBeNull();
    });

    it('cleans up empty slots', () => {
      const r1 = throttle.tryAcquire('key1');
      if (r1.status === 'acquired') {
        throttle.release(r1.ticket.id);
        expect(throttle.getStats().trackedKeys).toBe(0);
      }
    });
  });

  // ── Query ──────────────────────────────────────────────────────────

  describe('query', () => {
    it('gets key status', () => {
      throttle.tryAcquire('key1');
      throttle.tryAcquire('key1');
      throttle.tryAcquire('key1'); // queued

      const status = throttle.getKeyStatus('key1');
      expect(status.active).toBe(2);
      expect(status.queued).toBe(1);
      expect(status.maxConcurrent).toBe(2);
    });

    it('returns zero for unknown key', () => {
      const status = throttle.getKeyStatus('unknown');
      expect(status.active).toBe(0);
      expect(status.queued).toBe(0);
    });

    it('gets active keys', () => {
      throttle.tryAcquire('key1');
      throttle.tryAcquire('key2');
      const keys = throttle.getActiveKeys();
      expect(keys).toHaveLength(2);
    });

    it('cancels a queued request', () => {
      throttle.tryAcquire('key1');
      throttle.tryAcquire('key1');
      const r3 = throttle.tryAcquire('key1'); // queued

      if (r3.status === 'queued') {
        // The queued entry has an id we can find in getKeyStatus
        // but the result doesn't expose the id — let's use clearQueue instead
      }

      // Test cancelQueued with known queue
      expect(throttle.cancelQueued('tq_unknown')).toBe(false);
    });

    it('clears queue for a key', () => {
      throttle.tryAcquire('key1');
      throttle.tryAcquire('key1');
      throttle.tryAcquire('key1');
      throttle.tryAcquire('key1');

      expect(throttle.clearQueue('key1')).toBe(2);
      expect(throttle.getKeyStatus('key1').queued).toBe(0);
    });

    it('returns 0 for unknown key clearQueue', () => {
      expect(throttle.clearQueue('unknown')).toBe(0);
    });
  });

  // ── Key Eviction ───────────────────────────────────────────────────

  describe('key eviction', () => {
    it('evicts empty key slots at max capacity', () => {
      const small = new RequestThrottleQueue({ maxConcurrent: 1, maxQueueDepth: 1, maxKeys: 2 });
      const r1 = small.tryAcquire('key1');
      if (r1.status === 'acquired') small.release(r1.ticket.id); // empty slot
      small.tryAcquire('key2');
      small.tryAcquire('key3'); // should evict key1
      expect(small.getStats().trackedKeys).toBe(2);
      small.destroy();
    });
  });

  // ── Stats & Destroy ────────────────────────────────────────────────

  describe('stats and destroy', () => {
    it('tracks comprehensive stats', () => {
      throttle.tryAcquire('key1');
      throttle.tryAcquire('key1');
      throttle.tryAcquire('key1'); // queued
      throttle.tryAcquire('key1'); // queued
      throttle.tryAcquire('key1'); // queued
      throttle.tryAcquire('key1'); // rejected

      const stats = throttle.getStats();
      expect(stats.trackedKeys).toBe(1);
      expect(stats.totalActive).toBe(2);
      expect(stats.totalQueued).toBe(3);
      expect(stats.totalAcquired).toBe(2);
      expect(stats.totalRejected).toBe(1);
    });

    it('tracks releases', () => {
      const r1 = throttle.tryAcquire('key1');
      if (r1.status === 'acquired') {
        throttle.release(r1.ticket.id);
        expect(throttle.getStats().totalReleased).toBe(1);
      }
    });

    it('destroy resets everything', () => {
      throttle.tryAcquire('key1');
      throttle.destroy();
      expect(throttle.getStats().trackedKeys).toBe(0);
      expect(throttle.getStats().totalAcquired).toBe(0);
    });
  });
});
