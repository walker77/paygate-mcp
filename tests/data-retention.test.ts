import { DataRetentionManager } from '../src/data-retention';

describe('DataRetentionManager', () => {
  let mgr: DataRetentionManager;

  beforeEach(() => {
    mgr = new DataRetentionManager();
  });

  // ── Policy Management ──────────────────────────────────────────

  it('adds a retention policy', () => {
    const policy = mgr.addPolicy({ name: 'logs', category: 'logging', retentionDays: 90 });
    expect(policy.name).toBe('logs');
    expect(policy.retentionDays).toBe(90);
    expect(policy.action).toBe('delete');
    expect(policy.enabled).toBe(true);
  });

  it('rejects duplicate policy names', () => {
    mgr.addPolicy({ name: 'logs', category: 'logging', retentionDays: 90 });
    expect(() => mgr.addPolicy({ name: 'logs', category: 'logging', retentionDays: 90 }))
      .toThrow('already exists');
  });

  it('requires positive retention days', () => {
    expect(() => mgr.addPolicy({ name: 'x', category: 'c', retentionDays: 0 }))
      .toThrow('positive');
  });

  it('lists policies sorted by priority', () => {
    mgr.addPolicy({ name: 'a', category: 'c', retentionDays: 30, priority: 1 });
    mgr.addPolicy({ name: 'b', category: 'c', retentionDays: 30, priority: 10 });
    const policies = mgr.listPolicies();
    expect(policies[0].name).toBe('b');
  });

  it('removes a policy', () => {
    mgr.addPolicy({ name: 'logs', category: 'c', retentionDays: 30 });
    expect(mgr.removePolicy('logs')).toBe(true);
    expect(mgr.getPolicyByName('logs')).toBeNull();
  });

  it('enables and disables policies', () => {
    mgr.addPolicy({ name: 'logs', category: 'c', retentionDays: 30 });
    mgr.setPolicyEnabled('logs', false);
    expect(mgr.getPolicyByName('logs')!.enabled).toBe(false);
  });

  it('updates retention days', () => {
    mgr.addPolicy({ name: 'logs', category: 'c', retentionDays: 30 });
    mgr.setRetentionDays('logs', 60);
    expect(mgr.getPolicyByName('logs')!.retentionDays).toBe(60);
  });

  // ── Store Registration ─────────────────────────────────────────

  it('registers and uses a data store', () => {
    mgr.addPolicy({ name: 'logs', category: 'c', retentionDays: 30 });

    let data = [
      { ts: Date.now() - 40 * 24 * 60 * 60 * 1000, val: 'old' },
      { ts: Date.now() - 10 * 24 * 60 * 60 * 1000, val: 'recent' },
    ];

    mgr.registerStore('logs', {
      count: () => data.length,
      purge: (before) => {
        const initial = data.length;
        data = data.filter(d => d.ts >= before);
        return initial - data.length;
      },
    });

    const result = mgr.enforce();
    expect(result.totalPurged).toBe(1);
    expect(data).toHaveLength(1);
    expect(data[0].val).toBe('recent');
  });

  it('requires policy to exist for store registration', () => {
    expect(() => mgr.registerStore('nonexistent', { count: () => 0, purge: () => 0 }))
      .toThrow('not found');
  });

  it('unregisters a store', () => {
    mgr.addPolicy({ name: 'logs', category: 'c', retentionDays: 30 });
    mgr.registerStore('logs', { count: () => 0, purge: () => 0 });
    expect(mgr.unregisterStore('logs')).toBe(true);
  });

  // ── Enforcement ────────────────────────────────────────────────

  it('skips disabled policies', () => {
    mgr.addPolicy({ name: 'logs', category: 'c', retentionDays: 30 });
    mgr.setPolicyEnabled('logs', false);
    mgr.registerStore('logs', { count: () => 10, purge: () => 10 });

    const result = mgr.enforce();
    expect(result.policiesEvaluated).toBe(0);
    expect(result.totalPurged).toBe(0);
  });

  it('skips policies without stores', () => {
    mgr.addPolicy({ name: 'logs', category: 'c', retentionDays: 30 });
    const result = mgr.enforce();
    expect(result.policiesEvaluated).toBe(1);
    expect(result.policiesTriggered).toBe(0);
  });

  it('handles store purge errors gracefully', () => {
    mgr.addPolicy({ name: 'logs', category: 'c', retentionDays: 30 });
    mgr.registerStore('logs', {
      count: () => 10,
      purge: () => { throw new Error('storage error'); },
    });

    const result = mgr.enforce();
    expect(result.policiesEvaluated).toBe(1);
    expect(result.totalPurged).toBe(0); // error was caught
  });

  it('records purge history', () => {
    mgr.addPolicy({ name: 'logs', category: 'c', retentionDays: 30 });
    mgr.registerStore('logs', { count: () => 10, purge: () => 5 });

    mgr.enforce();
    const history = mgr.getPurgeHistory();
    expect(history).toHaveLength(1);
    expect(history[0].purgedCount).toBe(5);
    expect(history[0].policyName).toBe('logs');
  });

  it('enforces multiple policies', () => {
    mgr.addPolicy({ name: 'logs', category: 'c', retentionDays: 30 });
    mgr.addPolicy({ name: 'metrics', category: 'c', retentionDays: 7 });

    mgr.registerStore('logs', { count: () => 100, purge: () => 20 });
    mgr.registerStore('metrics', { count: () => 50, purge: () => 30 });

    const result = mgr.enforce();
    expect(result.policiesTriggered).toBe(2);
    expect(result.totalPurged).toBe(50);
  });

  // ── Status ─────────────────────────────────────────────────────

  it('returns status for all policies', () => {
    mgr.addPolicy({ name: 'logs', category: 'c', retentionDays: 30 });
    mgr.registerStore('logs', { count: () => 42, purge: () => 0 });

    const statuses = mgr.getStatus();
    expect(statuses).toHaveLength(1);
    expect(statuses[0].policyName).toBe('logs');
    expect(statuses[0].currentCount).toBe(42);
    expect(statuses[0].cutoffDate).toBeDefined();
  });

  // ── Stats ───────────────────────────────────────────────────────

  it('tracks stats', () => {
    mgr.addPolicy({ name: 'logs', category: 'c', retentionDays: 30 });
    mgr.registerStore('logs', { count: () => 10, purge: () => 3 });
    mgr.enforce();

    const stats = mgr.getStats();
    expect(stats.totalPolicies).toBe(1);
    expect(stats.enabledPolicies).toBe(1);
    expect(stats.totalStores).toBe(1);
    expect(stats.totalPurged).toBe(3);
    expect(stats.lastEnforcement).toEqual(expect.any(Number));
  });

  // ── Destroy ─────────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    mgr.addPolicy({ name: 'logs', category: 'c', retentionDays: 30 });
    mgr.registerStore('logs', { count: () => 0, purge: () => 0 });
    mgr.destroy();
    expect(mgr.getStats().totalPolicies).toBe(0);
    expect(mgr.getStats().totalStores).toBe(0);
  });
});
