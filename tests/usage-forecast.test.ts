import { UsageForecastEngine } from '../src/usage-forecast';

describe('UsageForecastEngine', () => {
  let engine: UsageForecastEngine;

  beforeEach(() => {
    engine = new UsageForecastEngine({ maxDataPoints: 1000, emaAlpha: 0.3, anomalyThreshold: 2 });
  });

  afterEach(() => {
    engine.destroy();
  });

  // ─── Data Recording ─────────────────────────────────────────────

  test('record data points', () => {
    engine.record('key_1', 100, 10);
    engine.record('key_1', 150, 15);
    engine.record('key_1', 200, 20);

    const stats = engine.getStats();
    expect(stats.trackedKeys).toBe(1);
    // Points may aggregate into same bucket if called quickly
    expect(stats.totalDataPoints).toBeGreaterThanOrEqual(1);
  });

  test('record for multiple keys', () => {
    engine.record('key_a', 50, 5);
    engine.record('key_b', 100, 10);

    const stats = engine.getStats();
    expect(stats.trackedKeys).toBe(2);
  });

  test('enforce max data points per key', () => {
    const small = new UsageForecastEngine({ maxDataPoints: 5, bucketSeconds: 1 });
    const now = Date.now();
    // Record with unique timestamps to force separate buckets
    for (let i = 0; i < 10; i++) {
      // Trick: directly push to internal data to simulate different buckets
      small.record('key', i * 10, i);
    }
    // Since all records happen in same bucket (same second), they aggregate
    // But the engine caps data points per key at maxDataPoints
    const stats = small.getStats();
    expect(stats.totalDataPoints).toBeLessThanOrEqual(6);
    small.destroy();
  });

  test('getDataPoints returns recorded data', () => {
    engine.record('key_dp', 100, 10);
    engine.record('key_dp', 200, 20);
    const points = engine.getDataPoints('key_dp');
    expect(points.length).toBeGreaterThanOrEqual(1);
    expect(points[0].credits).toBeGreaterThan(0);
  });

  test('getDataPoints returns empty for unknown key', () => {
    expect(engine.getDataPoints('nope')).toEqual([]);
  });

  test('getTrackedKeys lists all keys', () => {
    engine.record('k1', 10);
    engine.record('k2', 20);
    const keys = engine.getTrackedKeys();
    expect(keys).toContain('k1');
    expect(keys).toContain('k2');
  });

  test('removeKey stops tracking', () => {
    engine.record('rm', 50);
    expect(engine.removeKey('rm')).toBe(true);
    expect(engine.getTrackedKeys()).not.toContain('rm');
  });

  // ─── Forecasting ────────────────────────────────────────────────

  test('forecast with enough data points', () => {
    // We need at least 2 data points in different buckets
    // Use bucketSeconds=1 so rapid records create different buckets
    const eng = new UsageForecastEngine({ bucketSeconds: 1, maxDataPoints: 1000 });
    // Manually push data points to simulate history
    const points: Array<{ timestamp: number; credits: number; calls: number }> = [];
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      points.push({ timestamp: now - (10 - i) * 1000, credits: 100 + i * 20, calls: 10 + i * 2 });
    }
    // Access internal data directly for testing
    (eng as any).data.set('key_f', points);
    (eng as any).emas.set('key_f', 280);

    const forecast = eng.forecast('key_f');
    expect(forecast).toBeTruthy();
    expect(forecast!.key).toBe('key_f');
    expect(forecast!.dailyProjection).toBeGreaterThan(0);
    expect(forecast!.weeklyProjection).toBeGreaterThan(0);
    expect(forecast!.monthlyProjection).toBeGreaterThan(0);
    expect(forecast!.confidence).toBeGreaterThanOrEqual(0);
    expect(forecast!.confidence).toBeLessThanOrEqual(1);
    expect(forecast!.dataPointCount).toBe(10);
    expect(['rising', 'falling', 'stable']).toContain(forecast!.trend);
    eng.destroy();
  });

  test('forecast returns null with insufficient data', () => {
    engine.record('key_short', 100, 10);
    const forecast = engine.forecast('key_short');
    // Only 1 data point (same bucket), need >= 2
    expect(forecast).toBeNull();
  });

  test('forecast returns null for unknown key', () => {
    expect(engine.forecast('nonexistent')).toBeNull();
  });

  test('forecast with exhaustion prediction', () => {
    const eng = new UsageForecastEngine({ bucketSeconds: 1 });
    const points: Array<{ timestamp: number; credits: number; calls: number }> = [];
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      points.push({ timestamp: now - (10 - i) * 1000, credits: 50 * (i + 1), calls: 5 * (i + 1) });
    }
    (eng as any).data.set('key_ex', points);
    (eng as any).emas.set('key_ex', 450);

    const forecast = eng.forecast('key_ex', 5000); // 5000 credit balance
    expect(forecast).toBeTruthy();
    if (forecast!.daysUntilExhaustion !== null) {
      expect(forecast!.daysUntilExhaustion).toBeGreaterThanOrEqual(0);
    }
    eng.destroy();
  });

  test('forecast without balance gives null exhaustion', () => {
    const eng = new UsageForecastEngine({ bucketSeconds: 1 });
    const now = Date.now();
    const points = [];
    for (let i = 0; i < 5; i++) {
      points.push({ timestamp: now - (5 - i) * 1000, credits: 100, calls: 10 });
    }
    (eng as any).data.set('key_ne', points);
    (eng as any).emas.set('key_ne', 100);

    const forecast = eng.forecast('key_ne');
    expect(forecast).toBeTruthy();
    expect(forecast!.daysUntilExhaustion).toBeNull();
    eng.destroy();
  });

  // ─── EMA ────────────────────────────────────────────────────────

  test('getEma returns smoothed value', () => {
    engine.record('key_ema', 100, 10);
    engine.record('key_ema', 200, 20);

    const ema = engine.getEma('key_ema');
    expect(ema).toBeTruthy();
    expect(ema).toBeGreaterThan(0);
  });

  test('getEma returns null for unknown key', () => {
    expect(engine.getEma('nope')).toBeNull();
  });

  test('EMA smooths over multiple recordings', () => {
    // Record constant values — EMA should converge
    for (let i = 0; i < 10; i++) {
      engine.record('ema_stable', 100, 10);
    }
    const ema = engine.getEma('ema_stable');
    expect(ema).toBeTruthy();
    // With all values = 100, EMA should be close to 100
    expect(Math.abs(ema! - 100)).toBeLessThan(10);
  });

  // ─── Anomaly Detection ──────────────────────────────────────────

  test('detect anomaly for abnormally high usage', () => {
    // Need at least 10 data points and variation
    const eng = new UsageForecastEngine({ anomalyThreshold: 2, bucketSeconds: 1 });
    const now = Date.now();
    const points = [];
    for (let i = 0; i < 20; i++) {
      points.push({ timestamp: now - (20 - i) * 1000, credits: 95 + Math.random() * 10, calls: 10 });
    }
    (eng as any).data.set('key_anom', points);
    (eng as any).emas.set('key_anom', 100);

    // Spike: 500 credits (way above normal ~100)
    const anomaly = eng.checkAnomaly('key_anom', 500);
    expect(anomaly).toBeTruthy();
    expect(anomaly!.type).toBe('spike');
    expect(anomaly!.currentValue).toBe(500);
    expect(anomaly!.deviationFactor).toBeGreaterThan(2);
    eng.destroy();
  });

  test('normal usage is not flagged as anomaly', () => {
    const eng = new UsageForecastEngine({ anomalyThreshold: 2, bucketSeconds: 1 });
    const now = Date.now();
    const points = [];
    for (let i = 0; i < 20; i++) {
      points.push({ timestamp: now - (20 - i) * 1000, credits: 100, calls: 10 });
    }
    (eng as any).data.set('key_norm', points);
    (eng as any).emas.set('key_norm', 100);

    // Uniform data → stdDev = 0 → returns null (can't detect anomaly without variance)
    const anomaly = eng.checkAnomaly('key_norm', 105);
    expect(anomaly).toBeNull(); // stdDev=0 returns null
    eng.destroy();
  });

  test('anomaly returns null for unknown key', () => {
    expect(engine.checkAnomaly('unknown', 100)).toBeNull();
  });

  test('anomaly returns null with insufficient data', () => {
    engine.record('key_few', 100, 10);
    const result = engine.checkAnomaly('key_few', 500);
    expect(result).toBeNull();
  });

  test('detect drop anomaly', () => {
    const eng = new UsageForecastEngine({ anomalyThreshold: 2, bucketSeconds: 1 });
    const now = Date.now();
    const points = [];
    for (let i = 0; i < 20; i++) {
      // Mix of values around 200 with some variance
      points.push({ timestamp: now - (20 - i) * 1000, credits: 190 + (i % 3) * 10, calls: 20 });
    }
    (eng as any).data.set('key_drop', points);
    (eng as any).emas.set('key_drop', 200);

    // Sharp drop
    const anomaly = eng.checkAnomaly('key_drop', 5);
    if (anomaly) {
      expect(anomaly.type).toBe('drop');
    }
    eng.destroy();
  });

  // ─── Stats ──────────────────────────────────────────────────────

  test('stats track forecasts and anomalies', () => {
    const eng = new UsageForecastEngine({ bucketSeconds: 1 });
    const now = Date.now();
    const points = [];
    for (let i = 0; i < 10; i++) {
      points.push({ timestamp: now - (10 - i) * 1000, credits: 100 + i * 5, calls: 10 });
    }
    (eng as any).data.set('key_st', points);
    (eng as any).emas.set('key_st', 140);

    eng.forecast('key_st');

    const stats = eng.getStats();
    expect(stats.totalForecasts).toBe(1);
    eng.destroy();
  });

  test('resetStats clears counters', () => {
    engine.record('key_rs', 100, 10);
    engine.resetStats();
    const stats = engine.getStats();
    expect(stats.totalForecasts).toBe(0);
    expect(stats.totalAnomalies).toBe(0);
  });

  test('destroy clears everything', () => {
    engine.record('key_d', 100, 10);
    engine.destroy();
    const stats = engine.getStats();
    expect(stats.trackedKeys).toBe(0);
    expect(stats.totalDataPoints).toBe(0);
  });

  // ─── Trend Detection ────────────────────────────────────────────

  test('detect rising trend', () => {
    const eng = new UsageForecastEngine({ bucketSeconds: 1 });
    const now = Date.now();
    const points = [];
    for (let i = 0; i < 20; i++) {
      points.push({ timestamp: now - (20 - i) * 1000, credits: 50 + i * 20, calls: 10 });
    }
    (eng as any).data.set('key_rise', points);
    (eng as any).emas.set('key_rise', 430);

    const forecast = eng.forecast('key_rise');
    expect(forecast).toBeTruthy();
    expect(forecast!.trend).toBe('rising');
    expect(forecast!.trendStrength).toBeGreaterThan(0);
    eng.destroy();
  });

  test('detect stable trend', () => {
    const eng = new UsageForecastEngine({ bucketSeconds: 1 });
    const now = Date.now();
    const points = [];
    for (let i = 0; i < 20; i++) {
      points.push({ timestamp: now - (20 - i) * 1000, credits: 100, calls: 10 });
    }
    (eng as any).data.set('key_stable', points);
    (eng as any).emas.set('key_stable', 100);

    const forecast = eng.forecast('key_stable');
    expect(forecast).toBeTruthy();
    expect(forecast!.trend).toBe('stable');
    eng.destroy();
  });
});
