import { SloMonitor } from '../src/slo-monitor';

describe('SloMonitor', () => {
  let slo: SloMonitor;

  beforeEach(() => {
    slo = new SloMonitor();
  });

  afterEach(() => {
    slo.destroy();
  });

  // ─── SLO Definition ──────────────────────────────────────────────

  test('define and list SLOs', () => {
    slo.defineSlo({ id: 'lat-1', name: 'Search Latency', type: 'latency', target: 0.99, thresholdMs: 500 });
    slo.defineSlo({ id: 'avail-1', name: 'Availability', type: 'availability', target: 0.999 });
    expect(slo.listSlos().length).toBe(2);
    expect(slo.getSlo('lat-1')?.name).toBe('Search Latency');
  });

  test('reject invalid target', () => {
    expect(() => slo.defineSlo({ id: 'bad', name: 'Bad', type: 'availability', target: 0 })).toThrow();
    expect(() => slo.defineSlo({ id: 'bad', name: 'Bad', type: 'availability', target: 1.5 })).toThrow();
  });

  test('latency SLO requires thresholdMs', () => {
    expect(() => slo.defineSlo({ id: 'lat', name: 'Lat', type: 'latency', target: 0.99 })).toThrow();
  });

  test('remove SLO', () => {
    slo.defineSlo({ id: 's1', name: 'S1', type: 'availability', target: 0.99 });
    expect(slo.removeSlo('s1')).toBe(true);
    expect(slo.getSlo('s1')).toBeNull();
    expect(slo.removeSlo('nonexistent')).toBe(false);
  });

  // ─── Latency SLO ─────────────────────────────────────────────────

  test('latency SLO tracks compliance', () => {
    slo.defineSlo({ id: 'lat', name: 'Latency', type: 'latency', target: 0.95, thresholdMs: 200 });

    // 19 good, 1 bad = 95%
    for (let i = 0; i < 19; i++) {
      slo.recordEvent({ tool: 'search', latencyMs: 100, success: true });
    }
    slo.recordEvent({ tool: 'search', latencyMs: 300, success: true }); // over threshold

    const status = slo.getStatus('lat')!;
    expect(status.compliant).toBe(true);
    expect(status.totalEvents).toBe(20);
    expect(status.goodEvents).toBe(19);
    expect(status.badEvents).toBe(1);
    expect(status.current).toBe(0.95);
  });

  test('latency SLO violation', () => {
    slo.defineSlo({ id: 'lat', name: 'Latency', type: 'latency', target: 0.99, thresholdMs: 200 });

    for (let i = 0; i < 5; i++) {
      slo.recordEvent({ tool: 'search', latencyMs: 100, success: true });
    }
    for (let i = 0; i < 5; i++) {
      slo.recordEvent({ tool: 'search', latencyMs: 500, success: true }); // over threshold
    }

    const status = slo.getStatus('lat')!;
    expect(status.compliant).toBe(false);
    expect(status.current).toBe(0.5);
  });

  // ─── Availability SLO ──────────────────────────────────────────────

  test('availability SLO tracks success rate', () => {
    slo.defineSlo({ id: 'avail', name: 'Availability', type: 'availability', target: 0.99 });

    for (let i = 0; i < 99; i++) {
      slo.recordEvent({ tool: 'search', latencyMs: 100, success: true });
    }
    slo.recordEvent({ tool: 'search', latencyMs: 100, success: false }); // 1 failure

    const status = slo.getStatus('avail')!;
    expect(status.compliant).toBe(true);
    expect(status.current).toBe(0.99);
    expect(status.goodEvents).toBe(99);
    expect(status.badEvents).toBe(1);
  });

  test('availability SLO violation', () => {
    slo.defineSlo({ id: 'avail', name: 'Availability', type: 'availability', target: 0.99 });

    for (let i = 0; i < 90; i++) {
      slo.recordEvent({ tool: 'search', latencyMs: 100, success: true });
    }
    for (let i = 0; i < 10; i++) {
      slo.recordEvent({ tool: 'search', latencyMs: 100, success: false });
    }

    const status = slo.getStatus('avail')!;
    expect(status.compliant).toBe(false);
    expect(status.current).toBe(0.9);
  });

  // ─── Error Budget ─────────────────────────────────────────────────

  test('error budget calculation', () => {
    slo.defineSlo({ id: 'avail', name: 'Avail', type: 'availability', target: 0.99 });

    // Budget = 1 - 0.99 = 0.01 (1% error budget)
    const status = slo.getStatus('avail')!;
    expect(status.budgetTotal).toBe(0.01);
    expect(status.budgetRemaining).toBe(0.01); // no events, full budget
  });

  test('error budget consumed by failures', () => {
    slo.defineSlo({ id: 'avail', name: 'Avail', type: 'availability', target: 0.9 });

    // 8 good, 2 bad = 80% → budget = 0.1, consumed = 0.2
    for (let i = 0; i < 8; i++) slo.recordEvent({ tool: 't', latencyMs: 10, success: true });
    for (let i = 0; i < 2; i++) slo.recordEvent({ tool: 't', latencyMs: 10, success: false });

    const status = slo.getStatus('avail')!;
    expect(status.budgetTotal).toBe(0.1);
    expect(status.budgetConsumed).toBe(0.2);
    expect(status.budgetRemaining).toBe(0); // fully consumed (capped at 0)
  });

  // ─── Tool/Key Filtering ────────────────────────────────────────────

  test('SLO filters by tools', () => {
    slo.defineSlo({ id: 's1', name: 'Search Avail', type: 'availability', target: 0.99, tools: ['search'] });

    slo.recordEvent({ tool: 'search', latencyMs: 100, success: true });
    slo.recordEvent({ tool: 'generate', latencyMs: 100, success: false }); // different tool, excluded

    const status = slo.getStatus('s1')!;
    expect(status.totalEvents).toBe(1);
    expect(status.goodEvents).toBe(1);
  });

  test('SLO filters by keys', () => {
    slo.defineSlo({ id: 's1', name: 'Key Avail', type: 'availability', target: 0.99, keys: ['k1'] });

    slo.recordEvent({ tool: 'search', key: 'k1', latencyMs: 100, success: true });
    slo.recordEvent({ tool: 'search', key: 'k2', latencyMs: 100, success: false }); // different key

    const status = slo.getStatus('s1')!;
    expect(status.totalEvents).toBe(1);
  });

  // ─── Violations ────────────────────────────────────────────────────

  test('getViolations returns only violated SLOs', () => {
    slo.defineSlo({ id: 'good', name: 'Good', type: 'availability', target: 0.5 });
    slo.defineSlo({ id: 'bad', name: 'Bad', type: 'availability', target: 0.99 });

    // All failures → good (target 50%) is met, bad (target 99%) is violated
    for (let i = 0; i < 5; i++) slo.recordEvent({ tool: 't', latencyMs: 10, success: true });
    for (let i = 0; i < 5; i++) slo.recordEvent({ tool: 't', latencyMs: 10, success: false });

    const violations = slo.getViolations();
    expect(violations.length).toBe(1);
    expect(violations[0].id).toBe('bad');
  });

  // ─── Alerts ────────────────────────────────────────────────────────

  test('alert on budget exhaustion', () => {
    slo.defineSlo({ id: 'avail', name: 'Avail', type: 'availability', target: 0.9 });

    // 5 good, 5 bad = 50% availability → budget exhausted
    for (let i = 0; i < 5; i++) slo.recordEvent({ tool: 't', latencyMs: 10, success: true });
    for (let i = 0; i < 5; i++) slo.recordEvent({ tool: 't', latencyMs: 10, success: false });

    const alerts = slo.getAlerts();
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.some(a => a.type === 'budget_exhausted')).toBe(true);
  });

  test('clear alerts', () => {
    slo.defineSlo({ id: 'avail', name: 'Avail', type: 'availability', target: 0.9 });
    for (let i = 0; i < 5; i++) slo.recordEvent({ tool: 't', latencyMs: 10, success: false });

    expect(slo.getAlerts().length).toBeGreaterThan(0);
    slo.clearAlerts();
    expect(slo.getAlerts().length).toBe(0);
  });

  // ─── Empty State ──────────────────────────────────────────────────

  test('status with no events is compliant', () => {
    slo.defineSlo({ id: 'avail', name: 'Avail', type: 'availability', target: 0.99 });
    const status = slo.getStatus('avail')!;
    expect(status.compliant).toBe(true);
    expect(status.current).toBe(1);
    expect(status.totalEvents).toBe(0);
  });

  test('getStatus returns null for unknown SLO', () => {
    expect(slo.getStatus('nonexistent')).toBeNull();
  });

  // ─── Stats ────────────────────────────────────────────────────────

  test('stats track SLOs and events', () => {
    slo.defineSlo({ id: 's1', name: 'S1', type: 'availability', target: 0.99 });
    slo.defineSlo({ id: 's2', name: 'S2', type: 'availability', target: 0.5 });

    for (let i = 0; i < 5; i++) slo.recordEvent({ tool: 't', latencyMs: 10, success: true });
    for (let i = 0; i < 5; i++) slo.recordEvent({ tool: 't', latencyMs: 10, success: false });

    const stats = slo.getStats();
    expect(stats.totalSlos).toBe(2);
    expect(stats.totalEvents).toBe(10);
    expect(stats.violatedSlos).toBe(1); // s1 violated (50% < 99%)
    expect(stats.compliantSlos).toBe(1); // s2 compliant (50% >= 50%)
  });

  test('destroy clears everything', () => {
    slo.defineSlo({ id: 's1', name: 'S1', type: 'availability', target: 0.99 });
    slo.recordEvent({ tool: 't', latencyMs: 10, success: true });
    slo.destroy();
    expect(slo.getStats().totalSlos).toBe(0);
    expect(slo.getStats().totalEvents).toBe(0);
  });
});
