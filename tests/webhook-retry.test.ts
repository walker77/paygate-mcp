import { WebhookRetryManager } from '../src/webhook-retry';

describe('WebhookRetryManager', () => {
  let mgr: WebhookRetryManager;

  beforeEach(() => {
    mgr = new WebhookRetryManager();
  });

  // ── Enqueue ──────────────────────────────────────────────────────────

  it('enqueues an entry', () => {
    const e = mgr.enqueue({ url: 'https://example.com/hook', payload: { event: 'test' } });
    expect(e.url).toBe('https://example.com/hook');
    expect(e.status).toBe('pending');
    expect(e.attempts).toBe(0);
    expect(e.maxAttempts).toBe(5);
  });

  it('rejects empty URL', () => {
    expect(() => mgr.enqueue({ url: '', payload: {} })).toThrow('required');
  });

  it('enforces max queue size', () => {
    const small = new WebhookRetryManager({ maxQueueSize: 2 });
    small.enqueue({ url: 'https://a.com', payload: {} });
    small.enqueue({ url: 'https://b.com', payload: {} });
    expect(() => small.enqueue({ url: 'https://c.com', payload: {} })).toThrow('Maximum');
  });

  it('uses custom maxAttempts', () => {
    const e = mgr.enqueue({ url: 'https://a.com', payload: {}, maxAttempts: 3 });
    expect(e.maxAttempts).toBe(3);
  });

  // ── Dequeue ──────────────────────────────────────────────────────────

  it('dequeues the oldest ready entry', () => {
    mgr.enqueue({ url: 'https://a.com', payload: { n: 1 } });
    mgr.enqueue({ url: 'https://b.com', payload: { n: 2 } });
    const next = mgr.dequeue();
    expect(next).not.toBeNull();
    expect(next!.url).toBe('https://a.com');
  });

  it('returns null when no entries are ready', () => {
    expect(mgr.dequeue()).toBeNull();
  });

  it('dequeues all ready entries', () => {
    mgr.enqueue({ url: 'https://a.com', payload: {} });
    mgr.enqueue({ url: 'https://b.com', payload: {} });
    const all = mgr.dequeueAll();
    expect(all).toHaveLength(2);
  });

  // ── Delivery Tracking ───────────────────────────────────────────────

  it('marks entry as delivered', () => {
    const e = mgr.enqueue({ url: 'https://a.com', payload: {} });
    mgr.markDelivered(e.id);
    const updated = mgr.getEntry(e.id)!;
    expect(updated.status).toBe('delivered');
    expect(updated.attempts).toBe(1);
    expect(updated.deliveredAt).not.toBeNull();
  });

  it('marks entry as failed and schedules retry', () => {
    const e = mgr.enqueue({ url: 'https://a.com', payload: {} });
    mgr.markFailed(e.id, 'Timeout');
    const updated = mgr.getEntry(e.id)!;
    expect(updated.status).toBe('pending');
    expect(updated.attempts).toBe(1);
    expect(updated.lastError).toBe('Timeout');
    expect(updated.nextAttemptAt).toBeGreaterThan(Date.now() - 100);
  });

  it('moves to dead letter after max attempts', () => {
    const e = mgr.enqueue({ url: 'https://a.com', payload: {}, maxAttempts: 2 });
    mgr.markFailed(e.id, 'err1');
    mgr.markFailed(e.id, 'err2');
    const updated = mgr.getEntry(e.id)!;
    expect(updated.status).toBe('dead');
    expect(updated.attempts).toBe(2);
  });

  it('rejects markDelivered for unknown entry', () => {
    expect(() => mgr.markDelivered('nope')).toThrow('not found');
  });

  // ── Entry Management ────────────────────────────────────────────────

  it('lists entries by status', () => {
    const e1 = mgr.enqueue({ url: 'https://a.com', payload: {} });
    mgr.enqueue({ url: 'https://b.com', payload: {} });
    mgr.markDelivered(e1.id);
    expect(mgr.listEntries('delivered')).toHaveLength(1);
    expect(mgr.listEntries('pending')).toHaveLength(1);
  });

  it('removes an entry', () => {
    const e = mgr.enqueue({ url: 'https://a.com', payload: {} });
    expect(mgr.removeEntry(e.id)).toBe(true);
    expect(mgr.getEntry(e.id)).toBeNull();
  });

  it('purges dead entries', () => {
    const e = mgr.enqueue({ url: 'https://a.com', payload: {}, maxAttempts: 1 });
    mgr.markFailed(e.id, 'err');
    expect(mgr.purgeDead()).toBe(1);
    expect(mgr.listEntries('dead')).toHaveLength(0);
  });

  it('retries a dead entry', () => {
    const e = mgr.enqueue({ url: 'https://a.com', payload: {}, maxAttempts: 1 });
    mgr.markFailed(e.id, 'err');
    expect(mgr.getEntry(e.id)!.status).toBe('dead');
    mgr.retryDead(e.id);
    expect(mgr.getEntry(e.id)!.status).toBe('pending');
  });

  it('rejects retry of non-dead entry', () => {
    const e = mgr.enqueue({ url: 'https://a.com', payload: {} });
    expect(() => mgr.retryDead(e.id)).toThrow('not dead');
  });

  // ── Stats ────────────────────────────────────────────────────────────

  it('tracks stats', () => {
    const e1 = mgr.enqueue({ url: 'https://a.com', payload: {} });
    mgr.enqueue({ url: 'https://b.com', payload: {}, maxAttempts: 1 });
    mgr.markDelivered(e1.id);
    const stats = mgr.getStats();
    expect(stats.totalEnqueued).toBe(2);
    expect(stats.totalDelivered).toBe(1);
    expect(stats.pending).toBe(1);
    expect(stats.delivered).toBe(1);
  });

  // ── Destroy ──────────────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    mgr.enqueue({ url: 'https://a.com', payload: {} });
    mgr.destroy();
    expect(mgr.getStats().totalEnqueued).toBe(0);
    expect(mgr.listEntries()).toHaveLength(0);
  });
});
