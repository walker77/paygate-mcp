import { GracePeriodManager } from '../src/grace-period';

describe('GracePeriodManager', () => {
  let mgr: GracePeriodManager;

  beforeEach(() => {
    mgr = new GracePeriodManager();
  });

  // ── Policy Management ────────────────────────────────────────────────

  it('defines a policy', () => {
    const p = mgr.definePolicy({ name: 'payment_failure', durationMs: 7000 });
    expect(p.name).toBe('payment_failure');
    expect(p.durationMs).toBe(7000);
  });

  it('rejects empty name', () => {
    expect(() => mgr.definePolicy({ name: '', durationMs: 1000 })).toThrow('required');
  });

  it('rejects non-positive duration', () => {
    expect(() => mgr.definePolicy({ name: 'test', durationMs: 0 })).toThrow('positive');
  });

  it('rejects duplicate names', () => {
    mgr.definePolicy({ name: 'test', durationMs: 1000 });
    expect(() => mgr.definePolicy({ name: 'test', durationMs: 2000 })).toThrow('already exists');
  });

  it('gets policy by ID or name', () => {
    const p = mgr.definePolicy({ name: 'test', durationMs: 1000 });
    expect(mgr.getPolicy(p.id)).not.toBeNull();
    expect(mgr.getPolicy('test')).not.toBeNull();
    expect(mgr.getPolicy('nope')).toBeNull();
  });

  it('lists and removes policies', () => {
    const p = mgr.definePolicy({ name: 'test', durationMs: 1000 });
    expect(mgr.listPolicies()).toHaveLength(1);
    mgr.removePolicy(p.id);
    expect(mgr.listPolicies()).toHaveLength(0);
  });

  // ── Grace Period Lifecycle ───────────────────────────────────────────

  it('starts a grace period', () => {
    mgr.definePolicy({ name: 'test', durationMs: 5000 });
    const gp = mgr.startGracePeriod('key1', 'test');
    expect(gp.key).toBe('key1');
    expect(gp.policyName).toBe('test');
    expect(gp.active).toBe(true);
    expect(gp.expiresAt).toBeGreaterThan(Date.now());
  });

  it('rejects unknown policy', () => {
    expect(() => mgr.startGracePeriod('key1', 'nope')).toThrow('not found');
  });

  it('rejects duplicate active grace period for same key', () => {
    mgr.definePolicy({ name: 'test', durationMs: 5000 });
    mgr.startGracePeriod('key1', 'test');
    expect(() => mgr.startGracePeriod('key1', 'test')).toThrow('already has');
  });

  // ── Check ────────────────────────────────────────────────────────────

  it('checks active grace period', () => {
    mgr.definePolicy({ name: 'test', durationMs: 5000 });
    mgr.startGracePeriod('key1', 'test');
    const result = mgr.check('key1');
    expect(result.inGracePeriod).toBe(true);
    expect(result.remainingMs).toBeGreaterThan(0);
    expect(result.expired).toBe(false);
  });

  it('returns false for unknown key', () => {
    const result = mgr.check('unknown');
    expect(result.inGracePeriod).toBe(false);
    expect(result.gracePeriod).toBeNull();
  });

  it('detects expired grace period', async () => {
    mgr.definePolicy({ name: 'short', durationMs: 30 });
    mgr.startGracePeriod('key1', 'short');
    await new Promise(r => setTimeout(r, 50));
    const result = mgr.check('key1');
    expect(result.inGracePeriod).toBe(false);
    expect(result.expired).toBe(true);
  });

  // ── Extend ───────────────────────────────────────────────────────────

  it('extends a grace period', () => {
    mgr.definePolicy({ name: 'test', durationMs: 5000, maxExtensions: 2 });
    mgr.startGracePeriod('key1', 'test');
    const before = mgr.getByKey('key1')!.expiresAt;
    mgr.extend('key1', 3000);
    const after = mgr.getByKey('key1')!.expiresAt;
    expect(after).toBe(before + 3000);
    expect(mgr.getByKey('key1')!.extensions).toBe(1);
  });

  it('rejects extend beyond max extensions', () => {
    mgr.definePolicy({ name: 'test', durationMs: 5000, maxExtensions: 1 });
    mgr.startGracePeriod('key1', 'test');
    mgr.extend('key1');
    expect(() => mgr.extend('key1')).toThrow('Maximum extensions');
  });

  it('rejects extend for unknown key', () => {
    expect(() => mgr.extend('nope')).toThrow('No grace period');
  });

  // ── Cancel ───────────────────────────────────────────────────────────

  it('cancels a grace period', () => {
    mgr.definePolicy({ name: 'test', durationMs: 5000 });
    mgr.startGracePeriod('key1', 'test');
    const cancelled = mgr.cancel('key1');
    expect(cancelled.active).toBe(false);
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(mgr.check('key1').inGracePeriod).toBe(false);
  });

  it('rejects cancel for unknown key', () => {
    expect(() => mgr.cancel('nope')).toThrow('No grace period');
  });

  // ── Query ────────────────────────────────────────────────────────────

  it('gets by key', () => {
    mgr.definePolicy({ name: 'test', durationMs: 5000 });
    mgr.startGracePeriod('key1', 'test');
    expect(mgr.getByKey('key1')).not.toBeNull();
    expect(mgr.getByKey('nope')).toBeNull();
  });

  it('lists active periods', () => {
    mgr.definePolicy({ name: 'test', durationMs: 5000 });
    mgr.startGracePeriod('key1', 'test');
    mgr.startGracePeriod('key2', 'test');
    expect(mgr.listActive()).toHaveLength(2);
  });

  it('lists expiring periods', () => {
    mgr.definePolicy({ name: 'short', durationMs: 1000 });
    mgr.definePolicy({ name: 'long', durationMs: 100000 });
    mgr.startGracePeriod('key1', 'short');
    mgr.startGracePeriod('key2', 'long');
    const expiring = mgr.listExpiring(2000);
    expect(expiring).toHaveLength(1);
    expect(expiring[0].key).toBe('key1');
  });

  // ── Stats ────────────────────────────────────────────────────────────

  it('tracks stats', () => {
    mgr.definePolicy({ name: 'test', durationMs: 5000 });
    mgr.startGracePeriod('key1', 'test');
    mgr.startGracePeriod('key2', 'test');
    mgr.cancel('key2');
    const stats = mgr.getStats();
    expect(stats.totalPolicies).toBe(1);
    expect(stats.activePeriods).toBe(1);
    expect(stats.totalStarted).toBe(2);
    expect(stats.totalCancelled).toBe(1);
  });

  // ── Destroy ──────────────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    mgr.definePolicy({ name: 'test', durationMs: 5000 });
    mgr.startGracePeriod('key1', 'test');
    mgr.destroy();
    expect(mgr.getStats().totalPolicies).toBe(0);
    expect(mgr.getStats().activePeriods).toBe(0);
  });
});
