import { AccessLogEngine } from '../src/access-log';

describe('AccessLogEngine', () => {
  let log: AccessLogEngine;

  beforeEach(() => {
    log = new AccessLogEngine();
  });

  afterEach(() => {
    log.destroy();
  });

  // ─── Recording ────────────────────────────────────────────────────

  test('record an access entry', () => {
    const id = log.record({ key: 'k1', tool: 'search', status: 'allowed', responseTimeMs: 45 });
    expect(id).toMatch(/^log_/);
    expect(log.getStats().totalEntries).toBe(1);
  });

  test('record with all fields', () => {
    log.record({
      key: 'k1',
      tool: 'generate',
      method: 'tools/call',
      status: 'allowed',
      responseTimeMs: 100,
      ip: '10.0.0.1',
      userAgent: 'TestAgent/1.0',
      credits: 5,
      requestId: 'req_123',
      metadata: { region: 'us-east' },
    });
    const entry = log.search().entries[0];
    expect(entry.ip).toBe('10.0.0.1');
    expect(entry.credits).toBe(5);
    expect(entry.requestId).toBe('req_123');
  });

  test('bulk import entries', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      key: 'k1',
      tool: 'tool',
      status: 'allowed' as const,
      responseTimeMs: 50 + i,
    }));
    const count = log.importEntries(entries);
    expect(count).toBe(10);
    expect(log.getStats().totalEntries).toBe(10);
  });

  test('enforce max entries', () => {
    const small = new AccessLogEngine({ maxEntries: 5 });
    for (let i = 0; i < 10; i++) {
      small.record({ key: 'k', tool: 't', status: 'allowed', responseTimeMs: 50 });
    }
    expect(small.getStats().totalEntries).toBeLessThanOrEqual(5);
    expect(small.getStats().totalEvicted).toBeGreaterThan(0);
    small.destroy();
  });

  // ─── Search ───────────────────────────────────────────────────────

  test('search by key', () => {
    log.record({ key: 'k1', tool: 'search', status: 'allowed', responseTimeMs: 50 });
    log.record({ key: 'k2', tool: 'search', status: 'allowed', responseTimeMs: 50 });
    const result = log.search({ key: 'k1' });
    expect(result.total).toBe(1);
    expect(result.entries[0].key).toBe('k1');
  });

  test('search by multiple keys', () => {
    log.record({ key: 'k1', tool: 't', status: 'allowed', responseTimeMs: 50 });
    log.record({ key: 'k2', tool: 't', status: 'allowed', responseTimeMs: 50 });
    log.record({ key: 'k3', tool: 't', status: 'allowed', responseTimeMs: 50 });
    const result = log.search({ keys: ['k1', 'k2'] });
    expect(result.total).toBe(2);
  });

  test('search by tool', () => {
    log.record({ key: 'k1', tool: 'search', status: 'allowed', responseTimeMs: 50 });
    log.record({ key: 'k1', tool: 'generate', status: 'allowed', responseTimeMs: 50 });
    const result = log.search({ tool: 'search' });
    expect(result.total).toBe(1);
  });

  test('search by status', () => {
    log.record({ key: 'k1', tool: 't', status: 'allowed', responseTimeMs: 50 });
    log.record({ key: 'k1', tool: 't', status: 'denied', responseTimeMs: 0 });
    log.record({ key: 'k1', tool: 't', status: 'rate_limited', responseTimeMs: 0 });
    expect(log.search({ status: 'denied' }).total).toBe(1);
    expect(log.search({ status: 'rate_limited' }).total).toBe(1);
  });

  test('search by IP', () => {
    log.record({ key: 'k1', tool: 't', status: 'allowed', responseTimeMs: 50, ip: '10.0.0.1' });
    log.record({ key: 'k1', tool: 't', status: 'allowed', responseTimeMs: 50, ip: '192.168.1.1' });
    expect(log.search({ ip: '10.0.0.1' }).total).toBe(1);
  });

  test('search by response time range', () => {
    log.record({ key: 'k1', tool: 't', status: 'allowed', responseTimeMs: 50 });
    log.record({ key: 'k1', tool: 't', status: 'allowed', responseTimeMs: 500 });
    log.record({ key: 'k1', tool: 't', status: 'allowed', responseTimeMs: 5000 });
    expect(log.search({ minResponseTimeMs: 100 }).total).toBe(2);
    expect(log.search({ maxResponseTimeMs: 100 }).total).toBe(1);
  });

  test('free text search', () => {
    log.record({ key: 'k1', tool: 'search_users', status: 'allowed', responseTimeMs: 50 });
    log.record({ key: 'k1', tool: 'delete_files', status: 'denied', responseTimeMs: 0, error: 'forbidden' });
    expect(log.search({ search: 'users' }).total).toBe(1);
    expect(log.search({ search: 'forbidden' }).total).toBe(1);
  });

  // ─── Pagination ───────────────────────────────────────────────────

  test('search with limit and offset', () => {
    for (let i = 0; i < 20; i++) {
      log.record({ key: 'k1', tool: 't', status: 'allowed', responseTimeMs: 50 });
    }
    const page1 = log.search({ limit: 5, offset: 0 });
    expect(page1.entries.length).toBe(5);
    expect(page1.hasMore).toBe(true);

    const page2 = log.search({ limit: 5, offset: 15 });
    expect(page2.entries.length).toBe(5);
    expect(page2.hasMore).toBe(false);
  });

  // ─── Count ────────────────────────────────────────────────────────

  test('count with filter', () => {
    log.record({ key: 'k1', tool: 't', status: 'allowed', responseTimeMs: 50 });
    log.record({ key: 'k1', tool: 't', status: 'denied', responseTimeMs: 0 });
    log.record({ key: 'k2', tool: 't', status: 'allowed', responseTimeMs: 50 });
    expect(log.count()).toBe(3);
    expect(log.count({ key: 'k1' })).toBe(2);
    expect(log.count({ status: 'denied' })).toBe(1);
  });

  // ─── Get Entry ────────────────────────────────────────────────────

  test('getEntry by ID', () => {
    const id = log.record({ key: 'k1', tool: 't', status: 'allowed', responseTimeMs: 50 });
    expect(log.getEntry(id)).toBeTruthy();
    expect(log.getEntry('nonexistent')).toBeNull();
  });

  // ─── Summary ──────────────────────────────────────────────────────

  test('summarize access logs', () => {
    for (let i = 0; i < 10; i++) {
      log.record({ key: i % 2 === 0 ? 'k1' : 'k2', tool: i % 3 === 0 ? 'search' : 'generate', status: 'allowed', responseTimeMs: 50 + i * 10, ip: `10.0.0.${i}` });
    }
    log.record({ key: 'k1', tool: 'admin', status: 'denied', responseTimeMs: 0 });
    log.record({ key: 'k1', tool: 'admin', status: 'rate_limited', responseTimeMs: 0 });

    const summary = log.summarize();
    expect(summary.totalRequests).toBe(12);
    expect(summary.totalAllowed).toBe(10);
    expect(summary.totalDenied).toBe(1);
    expect(summary.totalRateLimited).toBe(1);
    expect(summary.uniqueKeys).toBe(2);
    expect(summary.uniqueTools).toBeGreaterThan(0);
    expect(summary.uniqueIps).toBe(10);
    expect(summary.avgResponseTimeMs).toBeGreaterThan(0);
    expect(summary.topKeys.length).toBeGreaterThan(0);
    expect(summary.topTools.length).toBeGreaterThan(0);
  });

  test('summarize empty logs', () => {
    const summary = log.summarize();
    expect(summary.totalRequests).toBe(0);
    expect(summary.avgResponseTimeMs).toBe(0);
  });

  test('summarize with time range', () => {
    const now = Date.now();
    log.record({ key: 'k1', tool: 't', status: 'allowed', responseTimeMs: 50 });
    const summary = log.summarize(now - 1000, now + 1000);
    expect(summary.totalRequests).toBe(1);
  });

  // ─── Purge ────────────────────────────────────────────────────────

  test('purge removes old entries', () => {
    const short = new AccessLogEngine({ retentionMs: 1 }); // 1ms retention
    short.record({ key: 'k', tool: 't', status: 'allowed', responseTimeMs: 50 });
    // The entry is technically at "now" so might not be purged immediately
    // Force by manipulating the entry timestamp
    const entries = (short as any).entries;
    entries[0].timestamp = Date.now() - 100;
    const purged = short.purge();
    expect(purged).toBe(1);
    expect(short.getStats().totalEntries).toBe(0);
    short.destroy();
  });

  test('clear removes all entries', () => {
    for (let i = 0; i < 5; i++) {
      log.record({ key: 'k', tool: 't', status: 'allowed', responseTimeMs: 50 });
    }
    log.clear();
    expect(log.getStats().totalEntries).toBe(0);
  });

  // ─── Stats ────────────────────────────────────────────────────────

  test('stats track entries and evictions', () => {
    for (let i = 0; i < 5; i++) {
      log.record({ key: 'k', tool: 't', status: 'allowed', responseTimeMs: 50 });
    }
    const stats = log.getStats();
    expect(stats.totalEntries).toBe(5);
    expect(stats.totalRecorded).toBe(5);
    expect(stats.oldestEntry).toBeTruthy();
    expect(stats.newestEntry).toBeTruthy();
  });

  test('stats null for empty log', () => {
    const stats = log.getStats();
    expect(stats.oldestEntry).toBeNull();
    expect(stats.newestEntry).toBeNull();
  });

  test('destroy clears everything', () => {
    log.record({ key: 'k', tool: 't', status: 'allowed', responseTimeMs: 50 });
    log.destroy();
    expect(log.getStats().totalEntries).toBe(0);
    expect(log.getStats().totalRecorded).toBe(0);
  });
});
