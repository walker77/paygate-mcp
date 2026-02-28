import { KeyLifecycleManager } from '../src/key-lifecycle';

describe('KeyLifecycleManager', () => {
  let mgr: KeyLifecycleManager;

  beforeEach(() => {
    mgr = new KeyLifecycleManager();
  });

  afterEach(() => {
    mgr.destroy();
  });

  // ─── Key Creation ─────────────────────────────────────────────────

  test('create a key', () => {
    expect(mgr.createKey({ id: 'k1', name: 'Key 1' })).toBe(true);
    const key = mgr.getKey('k1');
    expect(key).toBeTruthy();
    expect(key!.state).toBe('created');
    expect(key!.name).toBe('Key 1');
  });

  test('reject duplicate key', () => {
    mgr.createKey({ id: 'k1', name: 'Key 1' });
    expect(mgr.createKey({ id: 'k1', name: 'Key 1 again' })).toBe(false);
  });

  test('enforce max keys', () => {
    const m = new KeyLifecycleManager({ maxKeys: 2 });
    m.createKey({ id: 'a', name: 'A' });
    m.createKey({ id: 'b', name: 'B' });
    expect(m.createKey({ id: 'c', name: 'C' })).toBe(false);
    m.destroy();
  });

  test('auto-activate on create', () => {
    mgr.createKey({ id: 'k1', name: 'Key 1', autoActivate: true });
    expect(mgr.getKey('k1')!.state).toBe('active');
  });

  test('create with tags and metadata', () => {
    mgr.createKey({ id: 'k1', name: 'Key 1', tags: ['prod', 'team-a'], metadata: { owner: 'alice' } });
    const key = mgr.getKey('k1');
    expect(key!.tags).toEqual(['prod', 'team-a']);
    expect(key!.metadata).toEqual({ owner: 'alice' });
  });

  // ─── State Transitions ────────────────────────────────────────────

  test('activate a created key', () => {
    mgr.createKey({ id: 'k1', name: 'Key 1' });
    expect(mgr.activate('k1')).toBe(true);
    expect(mgr.getKey('k1')!.state).toBe('active');
  });

  test('suspend an active key', () => {
    mgr.createKey({ id: 'k1', name: 'Key 1', autoActivate: true });
    expect(mgr.suspend('k1', 'Suspicious activity')).toBe(true);
    const key = mgr.getKey('k1');
    expect(key!.state).toBe('suspended');
    expect(key!.suspendReason).toBe('Suspicious activity');
  });

  test('reactivate a suspended key', () => {
    mgr.createKey({ id: 'k1', name: 'Key 1', autoActivate: true });
    mgr.suspend('k1');
    expect(mgr.reactivate('k1')).toBe(true);
    expect(mgr.getKey('k1')!.state).toBe('active');
  });

  test('reactivate fails for non-suspended keys', () => {
    mgr.createKey({ id: 'k1', name: 'Key 1', autoActivate: true });
    expect(mgr.reactivate('k1')).toBe(false);
  });

  test('revoke a key', () => {
    mgr.createKey({ id: 'k1', name: 'Key 1', autoActivate: true });
    expect(mgr.revoke('k1', 'No longer needed')).toBe(true);
    const key = mgr.getKey('k1');
    expect(key!.state).toBe('revoked');
    expect(key!.revokeReason).toBe('No longer needed');
  });

  test('revoked key is terminal', () => {
    mgr.createKey({ id: 'k1', name: 'Key 1', autoActivate: true });
    mgr.revoke('k1');
    expect(mgr.activate('k1')).toBe(false);
    expect(mgr.suspend('k1')).toBe(false);
  });

  test('invalid transitions rejected', () => {
    mgr.createKey({ id: 'k1', name: 'Key 1' });
    expect(mgr.suspend('k1')).toBe(false);
  });

  // ─── Deletion ─────────────────────────────────────────────────────

  test('delete revoked key', () => {
    mgr.createKey({ id: 'k1', name: 'Key 1', autoActivate: true });
    mgr.revoke('k1');
    expect(mgr.deleteKey('k1')).toBe(true);
    expect(mgr.getKey('k1')).toBeNull();
  });

  test('delete created key', () => {
    mgr.createKey({ id: 'k1', name: 'Key 1' });
    expect(mgr.deleteKey('k1')).toBe(true);
  });

  test('cannot delete active key', () => {
    mgr.createKey({ id: 'k1', name: 'Key 1', autoActivate: true });
    expect(mgr.deleteKey('k1')).toBe(false);
  });

  // ─── Validity Check ───────────────────────────────────────────────

  test('isValid returns true for active keys', () => {
    mgr.createKey({ id: 'k1', name: 'Key 1', autoActivate: true });
    expect(mgr.isValid('k1')).toBe(true);
  });

  test('isValid returns false for non-active keys', () => {
    mgr.createKey({ id: 'k1', name: 'Key 1' });
    expect(mgr.isValid('k1')).toBe(false);
    mgr.activate('k1');
    mgr.suspend('k1');
    expect(mgr.isValid('k1')).toBe(false);
  });

  test('isValid returns false for unknown keys', () => {
    expect(mgr.isValid('unknown')).toBe(false);
  });

  // ─── Expiration ───────────────────────────────────────────────────

  test('expired key transitions to expired state', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    mgr.createKey({ id: 'k1', name: 'Key 1', expiresAt: past, autoActivate: true });
    expect(mgr.isValid('k1')).toBe(false);
    expect(mgr.getKey('k1')!.state).toBe('expired');
  });

  test('expireKeys batch expires past-due keys', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    mgr.createKey({ id: 'k1', name: 'Key 1', expiresAt: past, autoActivate: true });
    mgr.createKey({ id: 'k2', name: 'Key 2', autoActivate: true });
    const count = mgr.expireKeys();
    expect(count).toBe(1);
  });

  test('getExpiringKeys returns keys near expiration', () => {
    const soon = new Date(Date.now() + 30_000).toISOString();
    const far = new Date(Date.now() + 3600_000).toISOString();
    mgr.createKey({ id: 'soon', name: 'Soon', expiresAt: soon, autoActivate: true });
    mgr.createKey({ id: 'far', name: 'Far', expiresAt: far, autoActivate: true });

    const expiring = mgr.getExpiringKeys(60);
    expect(expiring.length).toBe(1);
    expect(expiring[0].id).toBe('soon');
  });

  // ─── Listing & Filtering ──────────────────────────────────────────

  test('listKeys returns all keys', () => {
    mgr.createKey({ id: 'a', name: 'A', autoActivate: true });
    mgr.createKey({ id: 'b', name: 'B' });
    expect(mgr.listKeys().length).toBe(2);
  });

  test('listKeys filters by state', () => {
    mgr.createKey({ id: 'a', name: 'A', autoActivate: true });
    mgr.createKey({ id: 'b', name: 'B' });
    expect(mgr.listKeys({ state: 'active' }).length).toBe(1);
    expect(mgr.listKeys({ state: 'created' }).length).toBe(1);
  });

  test('listKeys filters by tag', () => {
    mgr.createKey({ id: 'a', name: 'A', tags: ['prod'] });
    mgr.createKey({ id: 'b', name: 'B', tags: ['staging'] });
    expect(mgr.getKeysByTag('prod').length).toBe(1);
  });

  // ─── Events ───────────────────────────────────────────────────────

  test('events track state transitions', () => {
    mgr.createKey({ id: 'k1', name: 'Key 1' });
    mgr.activate('k1');
    mgr.suspend('k1', 'test');
    mgr.reactivate('k1');

    const events = mgr.getEvents('k1');
    expect(events.length).toBe(3);
    expect(events[0].event).toBe('reactivate');
    expect(events[1].event).toBe('suspend');
    expect(events[2].event).toBe('activate');
  });

  test('getAllEvents returns all key events', () => {
    mgr.createKey({ id: 'a', name: 'A' });
    mgr.createKey({ id: 'b', name: 'B' });
    mgr.activate('a');
    mgr.activate('b');
    expect(mgr.getAllEvents().length).toBe(2);
  });

  test('getEvents with limit', () => {
    mgr.createKey({ id: 'k', name: 'K' });
    mgr.activate('k');
    mgr.suspend('k');
    mgr.reactivate('k');
    expect(mgr.getEvents('k', 2).length).toBe(2);
  });

  // ─── Stats ────────────────────────────────────────────────────────

  test('stats track key counts by state', () => {
    mgr.createKey({ id: 'a', name: 'A', autoActivate: true });
    mgr.createKey({ id: 'b', name: 'B' });
    mgr.createKey({ id: 'c', name: 'C', autoActivate: true });
    mgr.revoke('c');

    const stats = mgr.getStats();
    expect(stats.totalKeys).toBe(3);
    expect(stats.byState.active).toBe(1);
    expect(stats.byState.created).toBe(1);
    expect(stats.byState.revoked).toBe(1);
    expect(stats.totalRevoked).toBe(1);
  });

  test('destroy clears everything', () => {
    mgr.createKey({ id: 'k', name: 'K', autoActivate: true });
    mgr.destroy();
    expect(mgr.getKey('k')).toBeNull();
    expect(mgr.getStats().totalKeys).toBe(0);
  });
});
