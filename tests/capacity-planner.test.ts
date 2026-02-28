import { CapacityPlanner } from '../src/capacity-planner';

describe('CapacityPlanner', () => {
  let planner: CapacityPlanner;

  beforeEach(() => {
    planner = new CapacityPlanner();
  });

  // ── Resource Management ────────────────────────────────────────

  it('adds a resource', () => {
    const r = planner.addResource({ name: 'api_calls', capacity: 10000, unit: 'calls/day' });
    expect(r.name).toBe('api_calls');
    expect(r.capacity).toBe(10000);
    expect(r.warningThreshold).toBe(0.8);
    expect(r.criticalThreshold).toBe(0.95);
  });

  it('rejects duplicate resource names', () => {
    planner.addResource({ name: 'cpu', capacity: 100 });
    expect(() => planner.addResource({ name: 'cpu', capacity: 100 })).toThrow('already exists');
  });

  it('requires positive capacity', () => {
    expect(() => planner.addResource({ name: 'x', capacity: 0 })).toThrow('positive');
  });

  it('lists resources', () => {
    planner.addResource({ name: 'a', capacity: 100 });
    planner.addResource({ name: 'b', capacity: 200 });
    expect(planner.listResources()).toHaveLength(2);
  });

  it('removes a resource', () => {
    planner.addResource({ name: 'a', capacity: 100 });
    expect(planner.removeResource('a')).toBe(true);
    expect(planner.getResourceByName('a')).toBeNull();
  });

  it('updates capacity', () => {
    planner.addResource({ name: 'a', capacity: 100 });
    planner.setCapacity('a', 200);
    expect(planner.getResourceByName('a')!.capacity).toBe(200);
  });

  // ── Sampling ───────────────────────────────────────────────────

  it('records samples', () => {
    planner.addResource({ name: 'api', capacity: 10000 });
    planner.recordSample('api', 5000);
    planner.recordSample('api', 6000);
    expect(planner.getSamples('api')).toHaveLength(2);
  });

  it('rejects samples for unknown resources', () => {
    expect(() => planner.recordSample('unknown', 100)).toThrow('not found');
  });

  // ── Forecasting ────────────────────────────────────────────────

  it('forecasts growing trend', () => {
    planner.addResource({ name: 'api', capacity: 10000 });

    // Record increasing usage
    for (let i = 0; i < 10; i++) {
      planner.recordSample('api', 1000 + i * 500);
    }

    const result = planner.forecast('api', 10);
    expect(result.trend).toBe('growing');
    expect(result.growthRate).toBeGreaterThan(0);
    expect(result.forecast).toHaveLength(10);
    // Forecast values should increase
    expect(result.forecast[9].predictedValue).toBeGreaterThan(result.forecast[0].predictedValue);
  });

  it('forecasts stable trend', () => {
    planner.addResource({ name: 'api', capacity: 10000 });

    // Record flat usage
    for (let i = 0; i < 10; i++) {
      planner.recordSample('api', 5000);
    }

    const result = planner.forecast('api', 10);
    expect(result.trend).toBe('stable');
  });

  it('forecasts declining trend', () => {
    planner.addResource({ name: 'api', capacity: 10000 });

    // Record decreasing usage
    for (let i = 0; i < 10; i++) {
      planner.recordSample('api', 9000 - i * 500);
    }

    const result = planner.forecast('api', 10);
    expect(result.trend).toBe('declining');
  });

  it('calculates periods until thresholds', () => {
    planner.addResource({ name: 'api', capacity: 10000 });

    // Linear growth from 1000
    for (let i = 0; i < 10; i++) {
      planner.recordSample('api', 1000 + i * 500);
    }

    const result = planner.forecast('api', 100);
    // Should eventually hit warning (8000) and critical (9500)
    if (result.growthRate > 0) {
      expect(result.periodsUntilWarning).toEqual(expect.any(Number));
      expect(result.periodsUntilCapacity).toEqual(expect.any(Number));
    }
  });

  it('returns null periods for non-growing resources', () => {
    planner.addResource({ name: 'api', capacity: 10000 });

    for (let i = 0; i < 10; i++) {
      planner.recordSample('api', 5000);
    }

    const result = planner.forecast('api', 10);
    expect(result.periodsUntilCapacity).toBeNull();
  });

  it('handles empty samples', () => {
    planner.addResource({ name: 'api', capacity: 10000 });
    const result = planner.forecast('api', 10);
    expect(result.currentValue).toBe(0);
    expect(result.trend).toBe('stable');
    expect(result.forecast).toHaveLength(0);
  });

  it('forecast confidence decreases with distance', () => {
    planner.addResource({ name: 'api', capacity: 10000 });
    for (let i = 0; i < 5; i++) planner.recordSample('api', 1000 + i * 100);

    const result = planner.forecast('api', 20);
    expect(result.forecast[0].confidence).toBeGreaterThan(result.forecast[19].confidence);
  });

  // ── Alerts ─────────────────────────────────────────────────────

  it('generates warning alert at threshold', () => {
    planner.addResource({ name: 'api', capacity: 100, warningThreshold: 0.8 });
    planner.recordSample('api', 85);

    const alerts = planner.getAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('warning');
  });

  it('generates critical alert', () => {
    planner.addResource({ name: 'api', capacity: 100, criticalThreshold: 0.95 });
    planner.recordSample('api', 96);

    const alerts = planner.getAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('critical');
  });

  it('generates capacity_reached alert', () => {
    planner.addResource({ name: 'api', capacity: 100 });
    planner.recordSample('api', 100);

    const alerts = planner.getAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('capacity_reached');
  });

  it('no alert below warning threshold', () => {
    planner.addResource({ name: 'api', capacity: 100 });
    planner.recordSample('api', 50);
    expect(planner.getAlerts()).toHaveLength(0);
  });

  it('gets alerts for specific resource', () => {
    planner.addResource({ name: 'a', capacity: 100 });
    planner.addResource({ name: 'b', capacity: 100 });
    planner.recordSample('a', 90);
    planner.recordSample('b', 50);

    expect(planner.getResourceAlerts('a')).toHaveLength(1);
    expect(planner.getResourceAlerts('b')).toHaveLength(0);
  });

  it('clears alerts', () => {
    planner.addResource({ name: 'api', capacity: 100 });
    planner.recordSample('api', 90);
    planner.clearAlerts();
    expect(planner.getAlerts()).toHaveLength(0);
  });

  // ── Stats ───────────────────────────────────────────────────────

  it('tracks stats', () => {
    planner.addResource({ name: 'api', capacity: 100 });
    planner.recordSample('api', 50);
    planner.recordSample('api', 85); // triggers warning

    const stats = planner.getStats();
    expect(stats.totalResources).toBe(1);
    expect(stats.totalSamples).toBe(2);
    expect(stats.totalAlerts).toBe(1);
    expect(stats.resourcesAtWarning).toBe(1);
  });

  // ── Destroy ─────────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    planner.addResource({ name: 'api', capacity: 100 });
    planner.recordSample('api', 90);
    planner.destroy();
    expect(planner.getStats().totalResources).toBe(0);
    expect(planner.getStats().totalSamples).toBe(0);
  });
});
