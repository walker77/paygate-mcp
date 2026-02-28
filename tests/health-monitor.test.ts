import { HealthMonitor } from '../src/health-monitor';

describe('HealthMonitor', () => {
  let monitor: HealthMonitor;

  beforeEach(() => {
    monitor = new HealthMonitor();
  });

  afterEach(() => {
    monitor.destroy();
  });

  // ─── Target Management ──────────────────────────────────────────

  test('upsert and retrieve a target', () => {
    const ok = monitor.upsertTarget({
      id: 'backend-1',
      name: 'Main Backend',
      intervalSeconds: 30,
      timeoutMs: 5000,
      unhealthyThreshold: 3,
      healthyThreshold: 2,
      active: true,
      checkType: 'ping',
    });
    expect(ok).toBe(true);
    const target = monitor.getTarget('backend-1');
    expect(target).toBeTruthy();
    expect(target!.name).toBe('Main Backend');
  });

  test('list all targets', () => {
    monitor.upsertTarget({ id: 'a', name: 'A', intervalSeconds: 30, timeoutMs: 5000, unhealthyThreshold: 3, healthyThreshold: 2, active: true, checkType: 'ping' });
    monitor.upsertTarget({ id: 'b', name: 'B', intervalSeconds: 60, timeoutMs: 10000, unhealthyThreshold: 5, healthyThreshold: 3, active: false, checkType: 'tcp' });
    expect(monitor.getTargets().length).toBe(2);
  });

  test('remove a target', () => {
    monitor.upsertTarget({ id: 'del', name: 'Del', intervalSeconds: 30, timeoutMs: 5000, unhealthyThreshold: 3, healthyThreshold: 2, active: true, checkType: 'ping' });
    expect(monitor.removeTarget('del')).toBe(true);
    expect(monitor.getTarget('del')).toBeNull();
  });

  test('enforce max targets', () => {
    const small = new HealthMonitor({ maxTargets: 2 });
    small.upsertTarget({ id: 'a', name: 'A', intervalSeconds: 30, timeoutMs: 5000, unhealthyThreshold: 3, healthyThreshold: 2, active: true, checkType: 'ping' });
    small.upsertTarget({ id: 'b', name: 'B', intervalSeconds: 30, timeoutMs: 5000, unhealthyThreshold: 3, healthyThreshold: 2, active: true, checkType: 'ping' });
    expect(small.upsertTarget({ id: 'c', name: 'C', intervalSeconds: 30, timeoutMs: 5000, unhealthyThreshold: 3, healthyThreshold: 2, active: true, checkType: 'ping' })).toBe(false);
    small.destroy();
  });

  // ─── Health Check Recording ─────────────────────────────────────

  test('record successful check transitions to healthy', () => {
    monitor.upsertTarget({ id: 't1', name: 'T1', intervalSeconds: 30, timeoutMs: 5000, unhealthyThreshold: 3, healthyThreshold: 2, active: true, checkType: 'ping' });

    monitor.recordCheck({ targetId: 't1', success: true, responseTimeMs: 50, checkedAt: new Date().toISOString() });
    monitor.recordCheck({ targetId: 't1', success: true, responseTimeMs: 45, checkedAt: new Date().toISOString() });

    const snap = monitor.getSnapshot('t1');
    expect(snap).toBeTruthy();
    expect(snap!.status).toBe('healthy');
    expect(snap!.consecutiveSuccesses).toBe(2);
  });

  test('record failure transitions through degraded to unhealthy', () => {
    monitor.upsertTarget({ id: 't2', name: 'T2', intervalSeconds: 30, timeoutMs: 5000, unhealthyThreshold: 3, healthyThreshold: 2, active: true, checkType: 'ping' });

    // First failure → degraded
    const status1 = monitor.recordCheck({ targetId: 't2', success: false, responseTimeMs: 0, error: 'timeout', checkedAt: new Date().toISOString() });
    expect(status1).toBe('degraded');

    // Second failure → still degraded
    const status2 = monitor.recordCheck({ targetId: 't2', success: false, responseTimeMs: 0, error: 'timeout', checkedAt: new Date().toISOString() });
    expect(status2).toBe('degraded');

    // Third failure → unhealthy
    const status3 = monitor.recordCheck({ targetId: 't2', success: false, responseTimeMs: 0, error: 'timeout', checkedAt: new Date().toISOString() });
    expect(status3).toBe('unhealthy');
  });

  test('recovery from unhealthy to healthy', () => {
    monitor.upsertTarget({ id: 't3', name: 'T3', intervalSeconds: 30, timeoutMs: 5000, unhealthyThreshold: 2, healthyThreshold: 2, active: true, checkType: 'ping' });

    // Become unhealthy
    monitor.recordCheck({ targetId: 't3', success: false, responseTimeMs: 0, checkedAt: new Date().toISOString() });
    monitor.recordCheck({ targetId: 't3', success: false, responseTimeMs: 0, checkedAt: new Date().toISOString() });

    // Recover
    monitor.recordCheck({ targetId: 't3', success: true, responseTimeMs: 50, checkedAt: new Date().toISOString() });
    monitor.recordCheck({ targetId: 't3', success: true, responseTimeMs: 45, checkedAt: new Date().toISOString() });

    const snap = monitor.getSnapshot('t3');
    expect(snap!.status).toBe('healthy');
  });

  test('record for unknown target returns unknown', () => {
    const status = monitor.recordCheck({ targetId: 'nope', success: true, responseTimeMs: 50, checkedAt: new Date().toISOString() });
    expect(status).toBe('unknown');
  });

  // ─── Snapshots ──────────────────────────────────────────────────

  test('snapshot includes uptime percentage', () => {
    monitor.upsertTarget({ id: 'up', name: 'Up', intervalSeconds: 30, timeoutMs: 5000, unhealthyThreshold: 3, healthyThreshold: 1, active: true, checkType: 'ping' });

    // 9 successes, 1 failure = 90% uptime
    for (let i = 0; i < 9; i++) {
      monitor.recordCheck({ targetId: 'up', success: true, responseTimeMs: 50, checkedAt: new Date().toISOString() });
    }
    monitor.recordCheck({ targetId: 'up', success: false, responseTimeMs: 0, checkedAt: new Date().toISOString() });

    const snap = monitor.getSnapshot('up');
    expect(snap!.uptimePercent).toBe(90);
  });

  test('snapshot includes average response time', () => {
    monitor.upsertTarget({ id: 'avg', name: 'Avg', intervalSeconds: 30, timeoutMs: 5000, unhealthyThreshold: 3, healthyThreshold: 1, active: true, checkType: 'ping' });

    monitor.recordCheck({ targetId: 'avg', success: true, responseTimeMs: 100, checkedAt: new Date().toISOString() });
    monitor.recordCheck({ targetId: 'avg', success: true, responseTimeMs: 200, checkedAt: new Date().toISOString() });

    const snap = monitor.getSnapshot('avg');
    expect(snap!.avgResponseTimeMs).toBe(150);
  });

  test('snapshot returns null for unknown target', () => {
    expect(monitor.getSnapshot('nope')).toBeNull();
  });

  test('getAllSnapshots returns all targets', () => {
    monitor.upsertTarget({ id: 'a', name: 'A', intervalSeconds: 30, timeoutMs: 5000, unhealthyThreshold: 3, healthyThreshold: 2, active: true, checkType: 'ping' });
    monitor.upsertTarget({ id: 'b', name: 'B', intervalSeconds: 30, timeoutMs: 5000, unhealthyThreshold: 3, healthyThreshold: 2, active: true, checkType: 'ping' });

    expect(monitor.getAllSnapshots().length).toBe(2);
  });

  // ─── Overall Health ─────────────────────────────────────────────

  test('overall health is healthy when all healthy', () => {
    monitor.upsertTarget({ id: 'h1', name: 'H1', intervalSeconds: 30, timeoutMs: 5000, unhealthyThreshold: 3, healthyThreshold: 1, active: true, checkType: 'ping' });
    monitor.upsertTarget({ id: 'h2', name: 'H2', intervalSeconds: 30, timeoutMs: 5000, unhealthyThreshold: 3, healthyThreshold: 1, active: true, checkType: 'ping' });

    monitor.recordCheck({ targetId: 'h1', success: true, responseTimeMs: 50, checkedAt: new Date().toISOString() });
    monitor.recordCheck({ targetId: 'h2', success: true, responseTimeMs: 50, checkedAt: new Date().toISOString() });

    expect(monitor.getOverallHealth()).toBe('healthy');
  });

  test('overall health is unhealthy when any unhealthy', () => {
    monitor.upsertTarget({ id: 'good', name: 'Good', intervalSeconds: 30, timeoutMs: 5000, unhealthyThreshold: 1, healthyThreshold: 1, active: true, checkType: 'ping' });
    monitor.upsertTarget({ id: 'bad', name: 'Bad', intervalSeconds: 30, timeoutMs: 5000, unhealthyThreshold: 1, healthyThreshold: 1, active: true, checkType: 'ping' });

    monitor.recordCheck({ targetId: 'good', success: true, responseTimeMs: 50, checkedAt: new Date().toISOString() });
    monitor.recordCheck({ targetId: 'bad', success: false, responseTimeMs: 0, checkedAt: new Date().toISOString() });

    expect(monitor.getOverallHealth()).toBe('unhealthy');
  });

  test('overall health is unknown when no targets', () => {
    expect(monitor.getOverallHealth()).toBe('unknown');
  });

  // ─── History ────────────────────────────────────────────────────

  test('getHistory returns check history', () => {
    monitor.upsertTarget({ id: 'hist', name: 'Hist', intervalSeconds: 30, timeoutMs: 5000, unhealthyThreshold: 3, healthyThreshold: 2, active: true, checkType: 'ping' });

    for (let i = 0; i < 5; i++) {
      monitor.recordCheck({ targetId: 'hist', success: true, responseTimeMs: 50 + i, checkedAt: new Date().toISOString() });
    }

    const history = monitor.getHistory('hist');
    expect(history.length).toBe(5);
  });

  test('getHistory respects limit', () => {
    monitor.upsertTarget({ id: 'lim', name: 'Lim', intervalSeconds: 30, timeoutMs: 5000, unhealthyThreshold: 3, healthyThreshold: 2, active: true, checkType: 'ping' });

    for (let i = 0; i < 10; i++) {
      monitor.recordCheck({ targetId: 'lim', success: true, responseTimeMs: 50, checkedAt: new Date().toISOString() });
    }

    expect(monitor.getHistory('lim', 3).length).toBe(3);
  });

  // ─── Due Targets ────────────────────────────────────────────────

  test('getDueTargets returns unchecked active targets', () => {
    monitor.upsertTarget({ id: 'due', name: 'Due', intervalSeconds: 30, timeoutMs: 5000, unhealthyThreshold: 3, healthyThreshold: 2, active: true, checkType: 'ping' });
    const due = monitor.getDueTargets();
    expect(due).toContain('due');
  });

  test('getDueTargets excludes recently checked', () => {
    monitor.upsertTarget({ id: 'recent', name: 'Recent', intervalSeconds: 3600, timeoutMs: 5000, unhealthyThreshold: 3, healthyThreshold: 2, active: true, checkType: 'ping' });
    monitor.recordCheck({ targetId: 'recent', success: true, responseTimeMs: 50, checkedAt: new Date().toISOString() });

    const due = monitor.getDueTargets();
    expect(due).not.toContain('recent');
  });

  test('getDueTargets excludes inactive targets', () => {
    monitor.upsertTarget({ id: 'inactive', name: 'Inactive', intervalSeconds: 30, timeoutMs: 5000, unhealthyThreshold: 3, healthyThreshold: 2, active: false, checkType: 'ping' });

    const due = monitor.getDueTargets();
    expect(due).not.toContain('inactive');
  });

  // ─── Stats ──────────────────────────────────────────────────────

  test('stats track checks and failures', () => {
    monitor.upsertTarget({ id: 's', name: 'S', intervalSeconds: 30, timeoutMs: 5000, unhealthyThreshold: 3, healthyThreshold: 2, active: true, checkType: 'ping' });
    monitor.recordCheck({ targetId: 's', success: true, responseTimeMs: 50, checkedAt: new Date().toISOString() });
    monitor.recordCheck({ targetId: 's', success: false, responseTimeMs: 0, checkedAt: new Date().toISOString() });

    const stats = monitor.getStats();
    expect(stats.totalChecks).toBe(2);
    expect(stats.totalFailures).toBe(1);
    expect(stats.totalTargets).toBe(1);
    expect(stats.activeTargets).toBe(1);
  });

  test('destroy clears everything', () => {
    monitor.upsertTarget({ id: 'd', name: 'D', intervalSeconds: 30, timeoutMs: 5000, unhealthyThreshold: 3, healthyThreshold: 2, active: true, checkType: 'ping' });
    monitor.recordCheck({ targetId: 'd', success: true, responseTimeMs: 50, checkedAt: new Date().toISOString() });
    monitor.destroy();

    expect(monitor.getTargets().length).toBe(0);
    expect(monitor.getStats().totalChecks).toBe(0);
  });
});
