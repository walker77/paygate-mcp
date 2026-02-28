import { AuditTrailManager } from '../src/audit-trail';

describe('AuditTrailManager', () => {
  let audit: AuditTrailManager;

  beforeEach(() => {
    audit = new AuditTrailManager();
  });

  // ── Recording ─────────────────────────────────────────────────

  it('records an audit entry', () => {
    const id = audit.record({
      action: 'key.created',
      actor: 'admin_1',
      target: 'key_abc',
      details: { credits: 1000 },
    });
    expect(id).toMatch(/^audit_/);
  });

  it('requires action, actor, and target', () => {
    expect(() => audit.record({ action: '', actor: 'a', target: 't' })).toThrow('Action');
    expect(() => audit.record({ action: 'a', actor: '', target: 't' })).toThrow('Actor');
    expect(() => audit.record({ action: 'a', actor: 'a', target: '' })).toThrow('Target');
  });

  it('records batch entries', () => {
    const ids = audit.recordBatch([
      { action: 'a', actor: 'x', target: 't1' },
      { action: 'b', actor: 'x', target: 't2' },
    ]);
    expect(ids).toHaveLength(2);
  });

  it('assigns sequential IDs', () => {
    const id1 = audit.record({ action: 'a', actor: 'x', target: 't' });
    const id2 = audit.record({ action: 'b', actor: 'x', target: 't' });
    expect(id1).toBe('audit_1');
    expect(id2).toBe('audit_2');
  });

  // ── Hash Chain ────────────────────────────────────────────────

  it('creates hash chain linking entries', () => {
    audit.record({ action: 'a', actor: 'x', target: 't' });
    audit.record({ action: 'b', actor: 'x', target: 't' });
    const entry1 = audit.getEntry('audit_1')!;
    const entry2 = audit.getEntry('audit_2')!;
    expect(entry1.previousHash).toBe('0'); // Genesis
    expect(entry2.previousHash).toBe(entry1.hash);
  });

  it('verifies intact chain', () => {
    audit.record({ action: 'a', actor: 'x', target: 't' });
    audit.record({ action: 'b', actor: 'x', target: 't' });
    audit.record({ action: 'c', actor: 'x', target: 't' });
    const result = audit.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.totalEntries).toBe(3);
  });

  it('verifies empty chain as valid', () => {
    expect(audit.verifyChain().valid).toBe(true);
  });

  // ── Query ─────────────────────────────────────────────────────

  it('queries by action', () => {
    audit.record({ action: 'key.created', actor: 'x', target: 't1' });
    audit.record({ action: 'key.deleted', actor: 'x', target: 't2' });
    const result = audit.query({ action: 'key.created' });
    expect(result.entries).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('queries by multiple actions', () => {
    audit.record({ action: 'a', actor: 'x', target: 't' });
    audit.record({ action: 'b', actor: 'x', target: 't' });
    audit.record({ action: 'c', actor: 'x', target: 't' });
    const result = audit.query({ actions: ['a', 'c'] });
    expect(result.entries).toHaveLength(2);
  });

  it('queries by actor', () => {
    audit.record({ action: 'a', actor: 'admin_1', target: 't' });
    audit.record({ action: 'a', actor: 'admin_2', target: 't' });
    const result = audit.query({ actor: 'admin_1' });
    expect(result.entries).toHaveLength(1);
  });

  it('queries by target', () => {
    audit.record({ action: 'a', actor: 'x', target: 'key_abc' });
    audit.record({ action: 'a', actor: 'x', target: 'key_def' });
    const result = audit.query({ target: 'key_abc' });
    expect(result.entries).toHaveLength(1);
  });

  it('queries with pagination', () => {
    for (let i = 0; i < 10; i++) {
      audit.record({ action: 'a', actor: 'x', target: 't' });
    }
    const page1 = audit.query({ limit: 3, offset: 0 });
    expect(page1.entries).toHaveLength(3);
    expect(page1.hasMore).toBe(true);
    expect(page1.total).toBe(10);
  });

  // ── History ───────────────────────────────────────────────────

  it('gets target history', () => {
    audit.record({ action: 'created', actor: 'x', target: 'key_abc' });
    audit.record({ action: 'updated', actor: 'y', target: 'key_abc' });
    audit.record({ action: 'created', actor: 'x', target: 'key_def' });
    const history = audit.getTargetHistory('key_abc');
    expect(history).toHaveLength(2);
  });

  it('gets actor history', () => {
    audit.record({ action: 'a', actor: 'admin_1', target: 't1' });
    audit.record({ action: 'b', actor: 'admin_1', target: 't2' });
    audit.record({ action: 'c', actor: 'admin_2', target: 't1' });
    const history = audit.getActorHistory('admin_1');
    expect(history).toHaveLength(2);
  });

  // ── Analytics ─────────────────────────────────────────────────

  it('counts actions', () => {
    audit.record({ action: 'key.created', actor: 'x', target: 't' });
    audit.record({ action: 'key.created', actor: 'x', target: 't2' });
    audit.record({ action: 'key.deleted', actor: 'x', target: 't' });
    const counts = audit.getActionCounts();
    expect(counts.get('key.created')).toBe(2);
    expect(counts.get('key.deleted')).toBe(1);
  });

  it('lists unique actors', () => {
    audit.record({ action: 'a', actor: 'admin_1', target: 't' });
    audit.record({ action: 'a', actor: 'admin_2', target: 't' });
    expect(audit.getActors()).toEqual(expect.arrayContaining(['admin_1', 'admin_2']));
  });

  it('lists unique targets', () => {
    audit.record({ action: 'a', actor: 'x', target: 'key_a' });
    audit.record({ action: 'a', actor: 'x', target: 'key_b' });
    expect(audit.getTargets()).toEqual(expect.arrayContaining(['key_a', 'key_b']));
  });

  // ── Max Entries Eviction ──────────────────────────────────────

  it('evicts oldest entries when over limit', () => {
    const a = new AuditTrailManager({ maxEntries: 5 });
    for (let i = 0; i < 8; i++) {
      a.record({ action: `action_${i}`, actor: 'x', target: 't' });
    }
    expect(a.getStats().totalEntries).toBe(5);
    a.destroy();
  });

  // ── Metadata ──────────────────────────────────────────────────

  it('records actorType, targetType, and source', () => {
    const id = audit.record({
      action: 'key.created',
      actor: 'admin_1',
      actorType: 'admin',
      target: 'key_abc',
      targetType: 'api_key',
      source: '192.168.1.1',
    });
    const entry = audit.getEntry(id)!;
    expect(entry.actorType).toBe('admin');
    expect(entry.targetType).toBe('api_key');
    expect(entry.source).toBe('192.168.1.1');
  });

  it('queries by actorType and targetType', () => {
    audit.record({ action: 'a', actor: 'x', actorType: 'admin', target: 't', targetType: 'key' });
    audit.record({ action: 'a', actor: 'y', actorType: 'user', target: 't', targetType: 'key' });
    expect(audit.query({ actorType: 'admin' }).entries).toHaveLength(1);
    expect(audit.query({ targetType: 'key' }).entries).toHaveLength(2);
  });

  // ── Stats ─────────────────────────────────────────────────────

  it('tracks stats', () => {
    audit.record({ action: 'a', actor: 'x', target: 't' });
    audit.record({ action: 'b', actor: 'y', target: 't' });
    const stats = audit.getStats();
    expect(stats.totalEntries).toBe(2);
    expect(stats.totalActors).toBe(2);
    expect(stats.totalActions).toBe(2);
    expect(stats.chainValid).toBe(true);
    expect(stats.oldestEntry).toEqual(expect.any(Number));
    expect(stats.newestEntry).toEqual(expect.any(Number));
  });

  // ── Destroy ───────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    audit.record({ action: 'a', actor: 'x', target: 't' });
    audit.destroy();
    expect(audit.getStats().totalEntries).toBe(0);
  });
});
