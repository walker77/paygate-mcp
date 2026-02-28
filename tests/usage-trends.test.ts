import { UsageTrendAnalyzer } from '../src/usage-trends';

describe('UsageTrendAnalyzer', () => {
  let analyzer: UsageTrendAnalyzer;

  beforeEach(() => {
    analyzer = new UsageTrendAnalyzer();
  });

  // ── Recording ─────────────────────────────────────────────────

  it('records a data point', () => {
    const point = analyzer.record('key_a', 'search', 50);
    expect(point.value).toBe(50);
    expect(point.key).toBe('key_a');
    expect(point.tool).toBe('search');
  });

  it('records batch data points', () => {
    const points = analyzer.recordBatch([
      { key: 'key_a', tool: 'search', value: 10 },
      { key: 'key_a', tool: 'search', value: 20 },
    ]);
    expect(points).toHaveLength(2);
  });

  it('retrieves data points', () => {
    analyzer.record('key_a', 'search', 10);
    analyzer.record('key_a', 'search', 20);
    const points = analyzer.getDataPoints('key_a', 'search');
    expect(points).toHaveLength(2);
  });

  // ── Trend Analysis ────────────────────────────────────────────

  it('analyzes stable trend', () => {
    for (let i = 0; i < 20; i++) {
      analyzer.record('key_a', 'search', 50 + (Math.random() * 2 - 1)); // ~50 ± 1
    }
    const trend = analyzer.getTrend('key_a', 'search');
    expect(trend).not.toBeNull();
    expect(trend!.trend).toBe('stable');
    expect(trend!.dataPoints).toBe(20);
  });

  it('analyzes growing trend', () => {
    for (let i = 0; i < 20; i++) {
      analyzer.record('key_a', 'search', 10 + i * 5); // 10, 15, 20, ... 105
    }
    const trend = analyzer.getTrend('key_a', 'search');
    expect(trend).not.toBeNull();
    expect(trend!.trend).toBe('growing');
    expect(trend!.changePercent).toBeGreaterThan(0);
  });

  it('analyzes declining trend', () => {
    for (let i = 0; i < 20; i++) {
      analyzer.record('key_a', 'search', 100 - i * 5); // 100, 95, 90, ... 5
    }
    const trend = analyzer.getTrend('key_a', 'search');
    expect(trend).not.toBeNull();
    expect(trend!.trend).toBe('declining');
    expect(trend!.changePercent).toBeLessThan(0);
  });

  it('returns null trend for unknown key+tool', () => {
    expect(analyzer.getTrend('unknown', 'unknown')).toBeNull();
  });

  it('computes statistics correctly', () => {
    analyzer.record('key_a', 'search', 10);
    analyzer.record('key_a', 'search', 20);
    analyzer.record('key_a', 'search', 30);
    const trend = analyzer.getTrend('key_a', 'search');
    expect(trend!.min).toBe(10);
    expect(trend!.max).toBe(30);
    expect(trend!.average).toBe(20);
    expect(trend!.currentValue).toBe(30);
  });

  // ── Anomaly Detection ─────────────────────────────────────────

  it('detects spike anomaly', () => {
    // Record 15 normal values to build baseline
    for (let i = 0; i < 15; i++) {
      analyzer.record('key_a', 'search', 50);
    }
    // Record a spike
    analyzer.record('key_a', 'search', 500);

    const anomalies = analyzer.getAnomalies('key_a', 'search');
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    expect(anomalies[0].type).toBe('spike');
    expect(anomalies[0].value).toBe(500);
  });

  it('detects drop anomaly', () => {
    for (let i = 0; i < 15; i++) {
      analyzer.record('key_a', 'search', 100);
    }
    analyzer.record('key_a', 'search', 0);

    const anomalies = analyzer.getAnomalies('key_a', 'search');
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    expect(anomalies[0].type).toBe('drop');
  });

  it('does not flag normal values as anomalies', () => {
    for (let i = 0; i < 20; i++) {
      analyzer.record('key_a', 'search', 50);
    }
    const anomalies = analyzer.getAnomalies('key_a', 'search');
    expect(anomalies).toHaveLength(0);
  });

  it('gets all anomalies across keys', () => {
    for (let i = 0; i < 15; i++) {
      analyzer.record('key_a', 'search', 50);
      analyzer.record('key_b', 'other', 100);
    }
    analyzer.record('key_a', 'search', 500);
    analyzer.record('key_b', 'other', 1000);

    const all = analyzer.getAllAnomalies();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  // ── Summary ───────────────────────────────────────────────────

  it('generates key summary', () => {
    for (let i = 0; i < 5; i++) {
      analyzer.record('key_a', 'search', 10);
      analyzer.record('key_a', 'translate', 20);
    }

    const summary = analyzer.getKeySummary('key_a');
    expect(summary).not.toBeNull();
    expect(summary!.totalCalls).toBe(10);
    expect(summary!.totalCredits).toBe(150); // 5*10 + 5*20
    expect(summary!.uniqueTools).toBe(2);
    expect(summary!.topTools).toHaveLength(2);
    expect(summary!.topTools[0].tool).toBe('translate'); // Higher credits
  });

  it('returns null summary for unknown key', () => {
    expect(analyzer.getKeySummary('unknown')).toBeNull();
  });

  // ── Listing ───────────────────────────────────────────────────

  it('lists tracked keys', () => {
    analyzer.record('key_a', 'search', 10);
    analyzer.record('key_b', 'search', 10);
    expect(analyzer.listKeys()).toEqual(expect.arrayContaining(['key_a', 'key_b']));
  });

  it('lists tracked tools', () => {
    analyzer.record('key_a', 'search', 10);
    analyzer.record('key_a', 'translate', 10);
    expect(analyzer.listTools()).toEqual(expect.arrayContaining(['search', 'translate']));
  });

  // ── Max Data Points ───────────────────────────────────────────

  it('evicts oldest data points when over limit', () => {
    const a = new UsageTrendAnalyzer({ maxDataPoints: 5 });
    for (let i = 0; i < 8; i++) {
      a.record('key_a', 'search', i);
    }
    const points = a.getDataPoints('key_a', 'search');
    expect(points).toHaveLength(5);
    expect(points[0].value).toBe(3);
    a.destroy();
  });

  // ── Stats ─────────────────────────────────────────────────────

  it('tracks stats', () => {
    analyzer.record('key_a', 'search', 10);
    analyzer.record('key_b', 'translate', 20);
    const stats = analyzer.getStats();
    expect(stats.totalDataPoints).toBe(2);
    expect(stats.totalKeys).toBe(2);
    expect(stats.totalTools).toBe(2);
  });

  // ── Destroy ───────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    analyzer.record('key_a', 'search', 10);
    analyzer.destroy();
    expect(analyzer.getStats().totalDataPoints).toBe(0);
  });
});
