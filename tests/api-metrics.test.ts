import { APIMetricsAggregator } from '../src/api-metrics';

describe('APIMetricsAggregator', () => {
  let agg: APIMetricsAggregator;

  beforeEach(() => {
    agg = new APIMetricsAggregator();
  });

  // ── Recording ────────────────────────────────────────────────────────

  it('records a metric', () => {
    agg.record({ latencyMs: 50, statusCode: 200 });
    expect(agg.getStats().totalRecords).toBe(1);
  });

  it('records multiple metrics', () => {
    agg.record({ latencyMs: 50, statusCode: 200 });
    agg.record({ latencyMs: 100, statusCode: 200 });
    agg.record({ latencyMs: 200, statusCode: 500 });
    expect(agg.getStats().totalRecords).toBe(3);
    expect(agg.getStats().totalErrors).toBe(1);
  });

  it('evicts oldest when over limit', () => {
    const small = new APIMetricsAggregator({ maxRecords: 3 });
    for (let i = 0; i < 5; i++) {
      small.record({ latencyMs: i * 10, statusCode: 200 });
    }
    expect(small.getStats().totalRecords).toBe(3);
  });

  // ── Summary ──────────────────────────────────────────────────────────

  it('returns empty summary when no records', () => {
    const summary = agg.getSummary('1m');
    expect(summary.totalRequests).toBe(0);
    expect(summary.avgLatencyMs).toBe(0);
  });

  it('computes summary with percentiles', () => {
    const now = Date.now();
    for (let i = 1; i <= 100; i++) {
      agg.record({ latencyMs: i, statusCode: i > 95 ? 500 : 200, timestamp: now + i });
    }
    const summary = agg.getSummary('1m');
    expect(summary.totalRequests).toBe(100);
    expect(summary.totalErrors).toBe(5);
    expect(summary.errorRate).toBe(5);
    expect(summary.p50LatencyMs).toBe(50);
    expect(summary.p95LatencyMs).toBe(95);
    expect(summary.p99LatencyMs).toBe(99);
    expect(summary.minLatencyMs).toBe(1);
    expect(summary.maxLatencyMs).toBe(100);
  });

  it('filters summary by tool', () => {
    const now = Date.now();
    agg.record({ tool: 'search', latencyMs: 50, statusCode: 200, timestamp: now });
    agg.record({ tool: 'search', latencyMs: 100, statusCode: 200, timestamp: now + 1 });
    agg.record({ tool: 'list', latencyMs: 200, statusCode: 200, timestamp: now + 2 });
    const summary = agg.getSummary('1m', { tool: 'search' });
    expect(summary.totalRequests).toBe(2);
  });

  it('filters summary by key', () => {
    const now = Date.now();
    agg.record({ key: 'k1', latencyMs: 50, statusCode: 200, timestamp: now });
    agg.record({ key: 'k2', latencyMs: 100, statusCode: 200, timestamp: now + 1 });
    const summary = agg.getSummary('1m', { key: 'k1' });
    expect(summary.totalRequests).toBe(1);
  });

  // ── Tool Breakdown ───────────────────────────────────────────────────

  it('computes per-tool breakdown', () => {
    const now = Date.now();
    agg.record({ tool: 'search', latencyMs: 50, statusCode: 200, timestamp: now });
    agg.record({ tool: 'search', latencyMs: 100, statusCode: 200, timestamp: now + 1 });
    agg.record({ tool: 'list', latencyMs: 200, statusCode: 500, timestamp: now + 2 });
    const breakdown = agg.getToolBreakdown();
    expect(breakdown).toHaveLength(2);
    expect(breakdown[0].tool).toBe('search');
    expect(breakdown[0].count).toBe(2);
    expect(breakdown[1].tool).toBe('list');
    expect(breakdown[1].errors).toBe(1);
  });

  // ── Buckets ──────────────────────────────────────────────────────────

  it('generates time-series buckets', () => {
    const now = Date.now();
    agg.record({ latencyMs: 50, statusCode: 200, timestamp: now });
    agg.record({ latencyMs: 100, statusCode: 200, timestamp: now + 1000 });
    const buckets = agg.getBuckets('1m');
    expect(buckets.length).toBeGreaterThanOrEqual(1);
    const total = buckets.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(2);
  });

  it('returns empty buckets when no records', () => {
    expect(agg.getBuckets('1h')).toHaveLength(0);
  });

  // ── Cleanup ──────────────────────────────────────────────────────────

  it('cleans up old records', () => {
    const old = Date.now() - 200_000_000; // well past 24h
    agg.record({ latencyMs: 50, statusCode: 200, timestamp: old });
    agg.record({ latencyMs: 100, statusCode: 200, timestamp: Date.now() });
    const removed = agg.cleanup();
    expect(removed).toBe(1);
    expect(agg.getStats().totalRecords).toBe(1);
  });

  // ── Stats ────────────────────────────────────────────────────────────

  it('tracks stats', () => {
    agg.record({ latencyMs: 50, statusCode: 200 });
    agg.record({ latencyMs: 100, statusCode: 500 });
    const stats = agg.getStats();
    expect(stats.totalRecords).toBe(2);
    expect(stats.totalRequests).toBe(2);
    expect(stats.totalErrors).toBe(1);
    expect(stats.oldestRecord).not.toBeNull();
    expect(stats.newestRecord).not.toBeNull();
  });

  // ── Destroy ──────────────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    agg.record({ latencyMs: 50, statusCode: 200 });
    agg.destroy();
    expect(agg.getStats().totalRecords).toBe(0);
  });
});
