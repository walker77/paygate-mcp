import { KeyMigrationManager } from '../src/key-migration';

describe('KeyMigrationManager', () => {
  let mgr: KeyMigrationManager;

  beforeEach(() => {
    mgr = new KeyMigrationManager();
  });

  // ── Plan ─────────────────────────────────────────────────────────────

  it('plans a migration', () => {
    const m = mgr.planMigration({ keys: ['k1', 'k2'], fromTier: 'free', toTier: 'pro' });
    expect(m.status).toBe('planned');
    expect(m.keys).toEqual(['k1', 'k2']);
    expect(m.fromTier).toBe('free');
    expect(m.toTier).toBe('pro');
  });

  it('rejects empty keys', () => {
    expect(() => mgr.planMigration({ keys: [], fromTier: 'free', toTier: 'pro' })).toThrow('required');
  });

  it('rejects missing fromTier', () => {
    expect(() => mgr.planMigration({ keys: ['k1'], fromTier: '', toTier: 'pro' })).toThrow('required');
  });

  it('rejects same fromTier and toTier', () => {
    expect(() => mgr.planMigration({ keys: ['k1'], fromTier: 'free', toTier: 'free' })).toThrow('different');
  });

  it('enforces max migrations', () => {
    const small = new KeyMigrationManager({ maxMigrations: 2 });
    small.planMigration({ keys: ['k1'], fromTier: 'a', toTier: 'b' });
    small.planMigration({ keys: ['k2'], fromTier: 'a', toTier: 'b' });
    expect(() => small.planMigration({ keys: ['k3'], fromTier: 'a', toTier: 'b' })).toThrow('Maximum');
  });

  // ── Execute ──────────────────────────────────────────────────────────

  it('executes a planned migration (no handler = all succeed)', () => {
    const m = mgr.planMigration({ keys: ['k1', 'k2'], fromTier: 'free', toTier: 'pro' });
    const result = mgr.executeMigration(m.id);
    expect(result.status).toBe('completed');
    expect(result.migratedKeys).toEqual(['k1', 'k2']);
    expect(result.failedKeys).toHaveLength(0);
  });

  it('uses migration handler', () => {
    mgr.setHandler({
      migrate: (key) => key !== 'k2',
      rollback: () => true,
    });
    const m = mgr.planMigration({ keys: ['k1', 'k2'], fromTier: 'free', toTier: 'pro' });
    const result = mgr.executeMigration(m.id);
    expect(result.status).toBe('failed');
    expect(result.migratedKeys).toEqual(['k1']);
    expect(result.failedKeys).toHaveLength(1);
    expect(result.failedKeys[0].key).toBe('k2');
  });

  it('handles handler exceptions', () => {
    mgr.setHandler({
      migrate: () => { throw new Error('boom'); },
      rollback: () => true,
    });
    const m = mgr.planMigration({ keys: ['k1'], fromTier: 'free', toTier: 'pro' });
    const result = mgr.executeMigration(m.id);
    expect(result.status).toBe('failed');
    expect(result.failedKeys[0].error).toContain('boom');
  });

  it('rejects executing non-planned migration', () => {
    const m = mgr.planMigration({ keys: ['k1'], fromTier: 'a', toTier: 'b' });
    mgr.executeMigration(m.id);
    expect(() => mgr.executeMigration(m.id)).toThrow('not in planned state');
  });

  it('rejects executing unknown migration', () => {
    expect(() => mgr.executeMigration('nope')).toThrow('not found');
  });

  // ── Rollback ─────────────────────────────────────────────────────────

  it('rolls back a completed migration', () => {
    const rollbacks: string[] = [];
    mgr.setHandler({
      migrate: () => true,
      rollback: (key) => { rollbacks.push(key); return true; },
    });
    const m = mgr.planMigration({ keys: ['k1', 'k2'], fromTier: 'free', toTier: 'pro' });
    mgr.executeMigration(m.id);
    const result = mgr.rollbackMigration(m.id);
    expect(result.status).toBe('rolled_back');
    expect(rollbacks).toEqual(['k1', 'k2']);
  });

  it('rejects rollback of planned migration', () => {
    const m = mgr.planMigration({ keys: ['k1'], fromTier: 'a', toTier: 'b' });
    expect(() => mgr.rollbackMigration(m.id)).toThrow('cannot be rolled back');
  });

  // ── Query ────────────────────────────────────────────────────────────

  it('gets migration by ID', () => {
    const m = mgr.planMigration({ keys: ['k1'], fromTier: 'a', toTier: 'b' });
    expect(mgr.getMigration(m.id)).not.toBeNull();
    expect(mgr.getMigration('nope')).toBeNull();
  });

  it('lists migrations by status', () => {
    mgr.planMigration({ keys: ['k1'], fromTier: 'a', toTier: 'b' });
    const m2 = mgr.planMigration({ keys: ['k2'], fromTier: 'a', toTier: 'b' });
    mgr.executeMigration(m2.id);
    expect(mgr.listMigrations('planned')).toHaveLength(1);
    expect(mgr.listMigrations('completed')).toHaveLength(1);
    expect(mgr.listMigrations()).toHaveLength(2);
  });

  it('removes a migration', () => {
    const m = mgr.planMigration({ keys: ['k1'], fromTier: 'a', toTier: 'b' });
    expect(mgr.removeMigration(m.id)).toBe(true);
    expect(mgr.getMigration(m.id)).toBeNull();
  });

  // ── Stats ────────────────────────────────────────────────────────────

  it('tracks stats', () => {
    const m1 = mgr.planMigration({ keys: ['k1', 'k2'], fromTier: 'a', toTier: 'b' });
    mgr.executeMigration(m1.id);
    mgr.planMigration({ keys: ['k3'], fromTier: 'a', toTier: 'b' });
    const stats = mgr.getStats();
    expect(stats.totalMigrations).toBe(2);
    expect(stats.completed).toBe(1);
    expect(stats.planned).toBe(1);
    expect(stats.totalKeysMigrated).toBe(2);
  });

  // ── Destroy ──────────────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    mgr.planMigration({ keys: ['k1'], fromTier: 'a', toTier: 'b' });
    mgr.destroy();
    expect(mgr.getStats().totalMigrations).toBe(0);
  });
});
