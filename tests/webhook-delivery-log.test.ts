import { WebhookDeliveryLog } from '../src/webhook-delivery-log';

describe('WebhookDeliveryLog', () => {
  let log: WebhookDeliveryLog;

  beforeEach(() => {
    log = new WebhookDeliveryLog();
  });

  afterEach(() => {
    log.destroy();
  });

  // ── Recording ───────────────────────────────────────────────────

  describe('recording', () => {
    it('records a successful delivery', () => {
      const entry = log.record({
        url: 'https://example.com/hook',
        event: 'key.created',
        payload: { key: 'k1' },
        statusCode: 200,
        durationMs: 150,
      });

      expect(entry.id).toMatch(/^dlv_/);
      expect(entry.status).toBe('success');
      expect(entry.statusCode).toBe(200);
      expect(entry.attempts).toBe(1);
    });

    it('records a failed delivery', () => {
      const entry = log.record({
        url: 'https://example.com/hook',
        event: 'key.deleted',
        payload: {},
        statusCode: 500,
        durationMs: 3000,
      });

      expect(entry.status).toBe('failed');
    });

    it('records delivery with error string', () => {
      const entry = log.record({
        url: 'https://example.com/hook',
        event: 'key.created',
        payload: {},
        error: 'Connection refused',
      });

      expect(entry.status).toBe('failed');
      expect(entry.error).toBe('Connection refused');
    });

    it('records pending delivery (no status code)', () => {
      const entry = log.record({
        url: 'https://example.com/hook',
        event: 'key.usage',
        payload: {},
      });

      expect(entry.status).toBe('pending');
      expect(entry.statusCode).toBeNull();
    });
  });

  // ── Retry Recording ─────────────────────────────────────────────

  describe('retry recording', () => {
    it('records a retry attempt', () => {
      const entry = log.record({
        url: 'https://example.com/hook',
        event: 'key.created',
        payload: {},
        statusCode: 500,
      });

      const retried = log.recordRetry(entry.id, { statusCode: 200, durationMs: 100 });
      expect(retried).not.toBeNull();
      expect(retried!.status).toBe('success');
      expect(retried!.attempts).toBe(2);
    });

    it('marks retrying status', () => {
      const entry = log.record({
        url: 'https://example.com/hook',
        event: 'key.created',
        payload: {},
        statusCode: 500,
      });

      log.markRetrying(entry.id);
      const updated = log.getEntry(entry.id);
      expect(updated!.status).toBe('retrying');
    });

    it('returns null for unknown entry retry', () => {
      expect(log.recordRetry('dlv_999', { statusCode: 200 })).toBeNull();
    });

    it('returns false for unknown entry markRetrying', () => {
      expect(log.markRetrying('dlv_999')).toBe(false);
    });
  });

  // ── Query ───────────────────────────────────────────────────────

  describe('query', () => {
    beforeEach(() => {
      log.record({ url: 'https://a.com/hook', event: 'key.created', payload: {}, statusCode: 200 });
      log.record({ url: 'https://b.com/hook', event: 'key.deleted', payload: {}, statusCode: 500 });
      log.record({ url: 'https://a.com/hook', event: 'key.usage', payload: {}, statusCode: 200 });
    });

    it('queries all entries', () => {
      expect(log.query()).toHaveLength(3);
    });

    it('filters by URL', () => {
      expect(log.query({ url: 'https://a.com/hook' })).toHaveLength(2);
    });

    it('filters by event', () => {
      expect(log.query({ event: 'key.deleted' })).toHaveLength(1);
    });

    it('filters by status', () => {
      expect(log.query({ status: 'success' })).toHaveLength(2);
      expect(log.query({ status: 'failed' })).toHaveLength(1);
    });

    it('gets entry by ID', () => {
      const entry = log.record({ url: 'http://x', event: 'test', payload: {} });
      expect(log.getEntry(entry.id)).not.toBeNull();
      expect(log.getEntry('dlv_999')).toBeNull();
    });

    it('gets failed entries', () => {
      const failed = log.getFailedEntries();
      expect(failed).toHaveLength(1);
      expect(failed[0].statusCode).toBe(500);
    });

    it('calculates success rate', () => {
      expect(log.getSuccessRate('https://a.com/hook')).toBe(100);
      expect(log.getSuccessRate('https://b.com/hook')).toBe(0);
      expect(log.getSuccessRate('https://unknown.com')).toBe(0);
    });
  });

  // ── Max Entries ─────────────────────────────────────────────────

  describe('max entries', () => {
    it('evicts old entries at capacity', () => {
      const small = new WebhookDeliveryLog({ maxEntries: 3 });
      small.record({ url: 'http://x', event: 'e1', payload: {} });
      small.record({ url: 'http://x', event: 'e2', payload: {} });
      small.record({ url: 'http://x', event: 'e3', payload: {} });
      small.record({ url: 'http://x', event: 'e4', payload: {} });

      expect(small.query()).toHaveLength(3);
      small.destroy();
    });
  });

  // ── Stats & Destroy ─────────────────────────────────────────────

  describe('stats and destroy', () => {
    it('tracks comprehensive stats', () => {
      log.record({ url: 'http://a', event: 'e1', payload: {}, statusCode: 200, durationMs: 100 });
      log.record({ url: 'http://a', event: 'e2', payload: {}, statusCode: 200, durationMs: 200 });
      log.record({ url: 'http://b', event: 'e3', payload: {}, statusCode: 500, durationMs: 300 });

      const stats = log.getStats();
      expect(stats.totalEntries).toBe(3);
      expect(stats.totalSuccess).toBe(2);
      expect(stats.totalFailed).toBe(1);
      expect(stats.avgDurationMs).toBe(200);
      expect(stats.urlBreakdown).toHaveLength(2);
    });

    it('destroy resets everything', () => {
      log.record({ url: 'http://x', event: 'e', payload: {} });
      log.destroy();

      expect(log.getStats().totalEntries).toBe(0);
    });
  });
});
