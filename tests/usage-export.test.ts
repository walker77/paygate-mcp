import { UsageExportEngine } from '../src/usage-export';

describe('UsageExportEngine', () => {
  let engine: UsageExportEngine;
  const now = Date.now();

  beforeEach(() => {
    engine = new UsageExportEngine();
  });

  afterEach(() => {
    engine.destroy();
  });

  function seedData() {
    const base = new Date('2026-02-15T00:00:00Z').getTime();
    for (let i = 0; i < 48; i++) {
      engine.record({
        timestamp: base + i * 3600_000,
        key: i % 2 === 0 ? 'key_a' : 'key_b',
        tool: i % 3 === 0 ? 'generate' : 'search',
        credits: 10 + (i % 5),
        allowed: i % 7 !== 0,
        responseTimeMs: 50 + i * 2,
      });
    }
  }

  // ─── Recording ──────────────────────────────────────────────────

  test('record usage events', () => {
    engine.record({ timestamp: now, key: 'k1', tool: 'search', credits: 5, allowed: true });
    expect(engine.getStats().totalRecords).toBe(1);
  });

  test('bulk import records', () => {
    const records = Array.from({ length: 10 }, (_, i) => ({
      timestamp: now + i * 1000,
      key: 'k1',
      tool: 'tool',
      credits: 5,
      allowed: true,
    }));
    const count = engine.importRecords(records);
    expect(count).toBe(10);
    expect(engine.getStats().totalRecords).toBe(10);
  });

  test('enforce max records', () => {
    const small = new UsageExportEngine({ maxRecords: 20 });
    for (let i = 0; i < 30; i++) {
      small.record({ timestamp: now + i, key: 'k', tool: 't', credits: 1, allowed: true });
    }
    expect(small.getStats().totalRecords).toBeLessThanOrEqual(20);
    small.destroy();
  });

  // ─── JSON Export ────────────────────────────────────────────────

  test('export as JSON', () => {
    seedData();
    const result = engine.export({}, 'json');
    expect(result.format).toBe('json');
    expect(result.totalRecords).toBe(48);
    expect(result.includedRecords).toBe(48);
    const parsed = JSON.parse(result.data);
    expect(parsed.length).toBe(48);
  });

  test('export with limit', () => {
    seedData();
    const result = engine.export({ limit: 5 }, 'json');
    expect(result.includedRecords).toBe(5);
    expect(result.totalRecords).toBe(48);
  });

  test('export with key filter', () => {
    seedData();
    const result = engine.export({ keys: ['key_a'] }, 'json');
    expect(result.totalRecords).toBe(24);
    expect(JSON.parse(result.data).every((r: any) => r.key === 'key_a')).toBe(true);
  });

  test('export with tool filter', () => {
    seedData();
    const result = engine.export({ tools: ['generate'] }, 'json');
    expect(result.totalRecords).toBeGreaterThan(0);
    expect(JSON.parse(result.data).every((r: any) => r.tool === 'generate')).toBe(true);
  });

  test('export with date range', () => {
    seedData();
    const base = new Date('2026-02-15T00:00:00Z').getTime();
    const result = engine.export({
      startTime: base,
      endTime: base + 12 * 3600_000,
    }, 'json');
    expect(result.totalRecords).toBe(12);
  });

  test('export with allowed filter', () => {
    seedData();
    const result = engine.export({ allowed: false }, 'json');
    expect(result.totalRecords).toBeGreaterThan(0);
    expect(JSON.parse(result.data).every((r: any) => r.allowed === false)).toBe(true);
  });

  // ─── CSV Export ─────────────────────────────────────────────────

  test('export as CSV', () => {
    seedData();
    const result = engine.export({}, 'csv');
    expect(result.format).toBe('csv');
    const lines = result.data.trim().split('\n');
    expect(lines[0]).toBe('timestamp,key,tool,credits,allowed,responseTimeMs');
    expect(lines.length).toBe(49); // header + 48 records
  });

  test('empty CSV has header only', () => {
    const result = engine.export({}, 'csv');
    expect(result.data).toContain('timestamp,key,tool,credits,allowed,responseTimeMs');
    expect(result.totalRecords).toBe(0);
  });

  test('CSV handles special characters', () => {
    engine.record({ timestamp: now, key: 'key,with,commas', tool: 'tool"with"quotes', credits: 5, allowed: true });
    const result = engine.export({}, 'csv');
    expect(result.data).toContain('"key,with,commas"');
    expect(result.data).toContain('"tool""with""quotes"');
  });

  // ─── Aggregated Export ──────────────────────────────────────────

  test('aggregate by daily', () => {
    seedData();
    const result = engine.exportAggregated({}, 'daily');
    expect(result.granularity).toBe('daily');
    expect(result.buckets.length).toBeGreaterThan(0);
    expect(result.totalRecords).toBe(48);

    for (const bucket of result.buckets) {
      expect(bucket.totalCalls).toBeGreaterThan(0);
      expect(bucket.periodStart).toBeTruthy();
      expect(bucket.periodEnd).toBeTruthy();
    }
  });

  test('aggregate by hourly', () => {
    seedData();
    const result = engine.exportAggregated({}, 'hourly');
    expect(result.granularity).toBe('hourly');
    expect(result.buckets.length).toBe(48); // 1 per hour
  });

  test('aggregate by monthly', () => {
    seedData();
    const result = engine.exportAggregated({}, 'monthly');
    expect(result.granularity).toBe('monthly');
    expect(result.buckets.length).toBeGreaterThan(0);
  });

  test('aggregate with filter', () => {
    seedData();
    const result = engine.exportAggregated({ keys: ['key_a'] }, 'daily');
    const totalCalls = result.buckets.reduce((sum, b) => sum + b.totalCalls, 0);
    expect(totalCalls).toBe(24);
  });

  test('aggregate empty data', () => {
    const result = engine.exportAggregated({}, 'daily');
    expect(result.buckets.length).toBe(0);
    expect(result.totalRecords).toBe(0);
  });

  test('aggregate includes denied calls count', () => {
    seedData();
    const result = engine.exportAggregated({}, 'daily');
    const totalDenied = result.buckets.reduce((sum, b) => sum + b.deniedCalls, 0);
    expect(totalDenied).toBeGreaterThan(0);
  });

  test('aggregate includes average response time', () => {
    seedData();
    const result = engine.exportAggregated({}, 'daily');
    for (const bucket of result.buckets) {
      expect(bucket.avgResponseTimeMs).not.toBeNull();
      expect(bucket.avgResponseTimeMs!).toBeGreaterThan(0);
    }
  });

  // ─── Count ──────────────────────────────────────────────────────

  test('count with filter', () => {
    seedData();
    expect(engine.count()).toBe(48);
    expect(engine.count({ keys: ['key_a'] })).toBe(24);
  });

  // ─── Date Range ─────────────────────────────────────────────────

  test('export includes date range', () => {
    seedData();
    const result = engine.export({}, 'json');
    expect(result.dateRange).toBeTruthy();
    expect(result.dateRange!.start).toBeTruthy();
    expect(result.dateRange!.end).toBeTruthy();
  });

  test('export of empty data has null date range', () => {
    const result = engine.export({}, 'json');
    expect(result.dateRange).toBeNull();
  });

  // ─── Stats ──────────────────────────────────────────────────────

  test('stats track exports', () => {
    seedData();
    engine.export();
    engine.exportAggregated();

    const stats = engine.getStats();
    expect(stats.totalRecords).toBe(48);
    expect(stats.totalExports).toBe(2);
    expect(stats.uniqueKeys).toBe(2);
    expect(stats.uniqueTools).toBe(2);
  });

  test('clear removes all records', () => {
    seedData();
    engine.clear();
    expect(engine.getStats().totalRecords).toBe(0);
  });

  test('destroy clears everything', () => {
    seedData();
    engine.export();
    engine.destroy();
    expect(engine.getStats().totalRecords).toBe(0);
    expect(engine.getStats().totalExports).toBe(0);
  });
});
