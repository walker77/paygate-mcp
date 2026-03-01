import { WebhookBatchProcessor } from '../src/webhook-batch';

describe('WebhookBatchProcessor', () => {
  let batch: WebhookBatchProcessor;

  beforeEach(() => {
    batch = new WebhookBatchProcessor({ maxBatchSize: 3 });
  });

  afterEach(() => {
    batch.destroy();
  });

  // ── Add ──────────────────────────────────────────────────────────────

  it('adds events to queue', () => {
    const e = batch.add('https://a.com', { event: 'test' });
    expect(e.url).toBe('https://a.com');
    expect(e.id).toMatch(/^be_/);
    expect(batch.getQueueSize('https://a.com')).toBe(1);
  });

  it('rejects empty URL', () => {
    expect(() => batch.add('', {})).toThrow('required');
  });

  it('enforces max queue size', () => {
    const small = new WebhookBatchProcessor({ maxQueueSize: 2, maxBatchSize: 100 });
    small.add('https://a.com', {});
    small.add('https://a.com', {});
    expect(() => small.add('https://a.com', {})).toThrow('Maximum');
    small.destroy();
  });

  it('auto-flushes when batch size reached', () => {
    const flushed: unknown[][] = [];
    batch.setFlushHandler((url, events) => {
      flushed.push(events);
    });
    batch.add('https://a.com', { n: 1 });
    batch.add('https://a.com', { n: 2 });
    batch.add('https://a.com', { n: 3 }); // triggers auto-flush at maxBatchSize=3
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(3);
    expect(batch.getQueueSize('https://a.com')).toBe(0);
  });

  // ── Flush ────────────────────────────────────────────────────────────

  it('flushes events for a URL', () => {
    batch.add('https://a.com', { n: 1 });
    batch.add('https://a.com', { n: 2 });
    const result = batch.flush('https://a.com');
    expect(result).not.toBeNull();
    expect(result!.events).toHaveLength(2);
    expect(result!.success).toBe(true);
    expect(batch.getQueueSize('https://a.com')).toBe(0);
  });

  it('returns null for empty queue', () => {
    expect(batch.flush('https://a.com')).toBeNull();
  });

  it('tracks flush errors', () => {
    batch.setFlushHandler(() => { throw new Error('delivery failed'); });
    batch.add('https://a.com', {});
    const result = batch.flush('https://a.com');
    expect(result!.success).toBe(false);
    expect(result!.error).toContain('delivery failed');
    expect(batch.getStats().totalErrors).toBe(1);
  });

  // ── Flush All ────────────────────────────────────────────────────────

  it('flushes all queued URLs', () => {
    batch.add('https://a.com', {});
    batch.add('https://b.com', {});
    batch.add('https://b.com', {});
    const results = batch.flushAll();
    expect(results).toHaveLength(2);
    expect(batch.getQueueSize('https://a.com')).toBe(0);
    expect(batch.getQueueSize('https://b.com')).toBe(0);
  });

  // ── Query ────────────────────────────────────────────────────────────

  it('lists queued URLs', () => {
    batch.add('https://a.com', {});
    batch.add('https://b.com', {});
    expect(batch.getQueuedUrls()).toEqual(expect.arrayContaining(['https://a.com', 'https://b.com']));
  });

  it('gets flush history', () => {
    batch.add('https://a.com', {});
    batch.flush('https://a.com');
    const history = batch.getFlushHistory();
    expect(history).toHaveLength(1);
    expect(history[0].url).toBe('https://a.com');
  });

  it('discards queue for a URL', () => {
    batch.add('https://a.com', {});
    batch.add('https://a.com', {});
    const discarded = batch.discardQueue('https://a.com');
    expect(discarded).toBe(2);
    expect(batch.getQueueSize('https://a.com')).toBe(0);
  });

  // ── Auto Flush ───────────────────────────────────────────────────────

  it('auto-flushes on interval', async () => {
    const flushed: unknown[][] = [];
    const fast = new WebhookBatchProcessor({
      maxBatchSize: 100,
      flushIntervalMs: 50,
      onFlush: (url, events) => { flushed.push(events); },
    });
    fast.add('https://a.com', {});
    fast.startAutoFlush();
    await new Promise(r => setTimeout(r, 80));
    fast.destroy();
    expect(flushed.length).toBeGreaterThanOrEqual(1);
  });

  // ── Stats ────────────────────────────────────────────────────────────

  it('tracks stats', () => {
    batch.add('https://a.com', {});
    batch.add('https://b.com', {});
    batch.flush('https://a.com');
    const stats = batch.getStats();
    expect(stats.totalAdded).toBe(2);
    expect(stats.totalFlushed).toBe(1);
    expect(stats.totalFlushes).toBe(1);
    expect(stats.queuedEvents).toBe(1);
    expect(stats.activeUrls).toBe(1);
  });

  // ── Destroy ──────────────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    batch.add('https://a.com', {});
    batch.startAutoFlush();
    batch.destroy();
    expect(batch.getStats().totalAdded).toBe(0);
    expect(batch.getStats().queuedEvents).toBe(0);
  });
});
