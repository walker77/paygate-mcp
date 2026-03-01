import { RequestBufferQueue } from '../src/request-buffer';

describe('RequestBufferQueue', () => {
  let buffer: RequestBufferQueue;

  beforeEach(() => {
    buffer = new RequestBufferQueue();
  });

  afterEach(() => {
    buffer.destroy();
  });

  // ── Buffer Control ──────────────────────────────────────────────

  describe('buffer control', () => {
    it('starts in idle state', () => {
      expect(buffer.isBuffering()).toBe(false);
      expect(buffer.getStats().status).toBe('idle');
    });

    it('enters buffering state', () => {
      buffer.startBuffering('maintenance');
      expect(buffer.isBuffering()).toBe(true);
      expect(buffer.getStats().bufferingReason).toBe('maintenance');
      expect(buffer.getStats().bufferingSince).toBeTruthy();
    });

    it('stops buffering', () => {
      buffer.startBuffering('maintenance');
      buffer.stopBuffering();
      expect(buffer.isBuffering()).toBe(false);
      expect(buffer.getStats().bufferingReason).toBeNull();
    });

    it('ignores duplicate startBuffering calls', () => {
      buffer.startBuffering('reason1');
      const since = buffer.getStats().bufferingSince;
      buffer.startBuffering('reason2');
      expect(buffer.getStats().bufferingReason).toBe('reason1');
      expect(buffer.getStats().bufferingSince).toBe(since);
    });
  });

  // ── Enqueue ─────────────────────────────────────────────────────

  describe('enqueue', () => {
    it('rejects enqueue when not buffering', () => {
      const result = buffer.enqueue({ payload: { test: true } });
      expect(result).toBeNull();
    });

    it('enqueues requests when buffering', () => {
      buffer.startBuffering();
      const req = buffer.enqueue({ payload: { method: 'tools/call' } });
      expect(req).not.toBeNull();
      expect(req!.id).toMatch(/^br_/);
      expect(req!.payload).toEqual({ method: 'tools/call' });
      expect(buffer.size()).toBe(1);
    });

    it('assigns priority and key', () => {
      buffer.startBuffering();
      const req = buffer.enqueue({ payload: 'test', key: 'k1', priority: 5 });
      expect(req!.priority).toBe(5);
      expect(req!.key).toBe('k1');
    });

    it('sets TTL-based expiry', () => {
      buffer.startBuffering();
      const req = buffer.enqueue({ payload: 'test', ttlMs: 60000 });
      expect(req!.expiresAt).toBeGreaterThan(Date.now());
    });

    it('drops requests when buffer is full', () => {
      const small = new RequestBufferQueue({ maxSize: 2 });
      small.startBuffering();
      small.enqueue({ payload: 'a' });
      small.enqueue({ payload: 'b' });
      const dropped = small.enqueue({ payload: 'c' });
      expect(dropped).toBeNull();
      expect(small.getStats().totalDropped).toBe(1);
      small.destroy();
    });
  });

  // ── Drain ───────────────────────────────────────────────────────

  describe('drain', () => {
    it('drains all requests in priority order', () => {
      buffer.startBuffering();
      buffer.enqueue({ payload: 'low', priority: 1 });
      buffer.enqueue({ payload: 'high', priority: 10 });
      buffer.enqueue({ payload: 'mid', priority: 5 });

      const drained = buffer.drain();
      expect(drained).toHaveLength(3);
      expect(drained[0].payload).toBe('high');
      expect(drained[1].payload).toBe('mid');
      expect(drained[2].payload).toBe('low');
      expect(buffer.size()).toBe(0);
    });

    it('uses FIFO within same priority', () => {
      buffer.startBuffering();
      buffer.enqueue({ payload: 'first', priority: 1 });
      buffer.enqueue({ payload: 'second', priority: 1 });

      const drained = buffer.drain();
      expect(drained[0].payload).toBe('first');
      expect(drained[1].payload).toBe('second');
    });

    it('drainBatch returns partial set', () => {
      buffer.startBuffering();
      buffer.enqueue({ payload: 'a' });
      buffer.enqueue({ payload: 'b' });
      buffer.enqueue({ payload: 'c' });

      const batch = buffer.drainBatch(2);
      expect(batch).toHaveLength(2);
      expect(buffer.size()).toBe(1);
    });

    it('tracks drained count in stats', () => {
      buffer.startBuffering();
      buffer.enqueue({ payload: 'a' });
      buffer.enqueue({ payload: 'b' });
      buffer.drain();
      expect(buffer.getStats().totalDrained).toBe(2);
    });
  });

  // ── TTL Expiry ──────────────────────────────────────────────────

  describe('TTL expiry', () => {
    it('prunes expired requests on drain', async () => {
      const fast = new RequestBufferQueue({ defaultTtlMs: 50 });
      fast.startBuffering();
      fast.enqueue({ payload: 'expiring' });

      await new Promise(r => setTimeout(r, 80));

      const drained = fast.drain();
      expect(drained).toHaveLength(0);
      expect(fast.getStats().totalExpired).toBe(1);
      fast.destroy();
    });
  });

  // ── Peek & Remove ──────────────────────────────────────────────

  describe('peek and remove', () => {
    it('peeks without draining', () => {
      buffer.startBuffering();
      buffer.enqueue({ payload: 'a' });
      buffer.enqueue({ payload: 'b' });

      const peeked = buffer.peek(1);
      expect(peeked).toHaveLength(1);
      expect(buffer.size()).toBe(2);
    });

    it('removes specific request', () => {
      buffer.startBuffering();
      const req = buffer.enqueue({ payload: 'test' })!;
      expect(buffer.remove(req.id)).toBe(true);
      expect(buffer.size()).toBe(0);
    });

    it('returns false for unknown remove', () => {
      expect(buffer.remove('br_999')).toBe(false);
    });

    it('discards all requests', () => {
      buffer.startBuffering();
      buffer.enqueue({ payload: 'a' });
      buffer.enqueue({ payload: 'b' });

      const count = buffer.discardAll();
      expect(count).toBe(2);
      expect(buffer.size()).toBe(0);
      expect(buffer.getStats().totalDropped).toBe(2);
    });
  });

  // ── Stats & Destroy ─────────────────────────────────────────────

  describe('stats and destroy', () => {
    it('tracks comprehensive stats', () => {
      buffer.startBuffering('test');
      buffer.enqueue({ payload: 'a' });
      buffer.enqueue({ payload: 'b' });

      const stats = buffer.getStats();
      expect(stats.status).toBe('buffering');
      expect(stats.bufferedCount).toBe(2);
      expect(stats.totalEnqueued).toBe(2);
      expect(stats.bufferingReason).toBe('test');
    });

    it('destroy resets everything', () => {
      buffer.startBuffering();
      buffer.enqueue({ payload: 'test' });
      buffer.destroy();

      const stats = buffer.getStats();
      expect(stats.status).toBe('idle');
      expect(stats.bufferedCount).toBe(0);
      expect(stats.totalEnqueued).toBe(0);
    });
  });
});
