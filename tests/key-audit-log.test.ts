import { APIKeyAuditLog } from '../src/key-audit-log';

describe('APIKeyAuditLog', () => {
  let audit: APIKeyAuditLog;

  beforeEach(() => {
    audit = new APIKeyAuditLog();
  });

  afterEach(() => {
    audit.destroy();
  });

  // ── Recording ──────────────────────────────────────────────────────

  describe('recording', () => {
    it('records an audit event', () => {
      const entry = audit.record({ key: 'k1', action: 'created', actor: 'admin@co.com' });
      expect(entry.id).toMatch(/^aud_/);
      expect(entry.key).toBe('k1');
      expect(entry.action).toBe('created');
      expect(entry.actor).toBe('admin@co.com');
    });

    it('records with details and IP', () => {
      const entry = audit.record({
        key: 'k1', action: 'rotated', actor: 'admin',
        details: { reason: 'scheduled' }, ip: '10.0.0.1',
      });
      expect(entry.details.reason).toBe('scheduled');
      expect(entry.ip).toBe('10.0.0.1');
    });

    it('rejects missing key', () => {
      expect(() => audit.record({ key: '', action: 'created', actor: 'admin' })).toThrow();
    });

    it('rejects missing action', () => {
      expect(() => audit.record({ key: 'k1', action: '' as any, actor: 'admin' })).toThrow();
    });

    it('rejects missing actor', () => {
      expect(() => audit.record({ key: 'k1', action: 'created', actor: '' })).toThrow();
    });

    it('records multiple actions for same key', () => {
      audit.record({ key: 'k1', action: 'created', actor: 'admin' });
      audit.record({ key: 'k1', action: 'rotated', actor: 'admin' });
      audit.record({ key: 'k1', action: 'revoked', actor: 'security' });
      expect(audit.getKeyHistory('k1')).toHaveLength(3);
    });
  });

  // ── Query ──────────────────────────────────────────────────────────

  describe('query', () => {
    beforeEach(() => {
      audit.record({ key: 'k1', action: 'created', actor: 'admin' });
      audit.record({ key: 'k1', action: 'rotated', actor: 'admin' });
      audit.record({ key: 'k2', action: 'created', actor: 'ops' });
      audit.record({ key: 'k2', action: 'suspended', actor: 'security' });
    });

    it('queries all entries', () => {
      expect(audit.query()).toHaveLength(4);
    });

    it('filters by key', () => {
      expect(audit.query({ key: 'k1' })).toHaveLength(2);
    });

    it('filters by action', () => {
      expect(audit.query({ action: 'created' })).toHaveLength(2);
    });

    it('filters by actor', () => {
      expect(audit.query({ actor: 'security' })).toHaveLength(1);
    });

    it('gets key history', () => {
      const history = audit.getKeyHistory('k1');
      expect(history).toHaveLength(2);
      expect(history[0].action).toBe('created');
      expect(history[1].action).toBe('rotated');
    });

    it('returns empty for unknown key', () => {
      expect(audit.getKeyHistory('unknown')).toEqual([]);
    });

    it('gets entry by ID', () => {
      const entry = audit.record({ key: 'k3', action: 'accessed', actor: 'user' });
      expect(audit.getEntry(entry.id)).not.toBeNull();
      expect(audit.getEntry('aud_999')).toBeNull();
    });

    it('gets latest for key', () => {
      const latest = audit.getLatestForKey('k1');
      expect(latest).not.toBeNull();
      expect(latest!.action).toBe('rotated');
    });

    it('returns null for unknown key latest', () => {
      expect(audit.getLatestForKey('unknown')).toBeNull();
    });

    it('gets unique actors', () => {
      const actors = audit.getActors();
      expect(actors).toContain('admin');
      expect(actors).toContain('ops');
      expect(actors).toContain('security');
    });
  });

  // ── Max Entries ────────────────────────────────────────────────────

  describe('max entries', () => {
    it('trims entries at capacity', () => {
      const small = new APIKeyAuditLog({ maxEntries: 3 });
      small.record({ key: 'k1', action: 'created', actor: 'a' });
      small.record({ key: 'k2', action: 'created', actor: 'a' });
      small.record({ key: 'k3', action: 'created', actor: 'a' });
      small.record({ key: 'k4', action: 'created', actor: 'a' });
      expect(small.getStats().totalEntries).toBe(3);
      small.destroy();
    });
  });

  // ── Stats & Destroy ────────────────────────────────────────────────

  describe('stats and destroy', () => {
    it('tracks comprehensive stats', () => {
      audit.record({ key: 'k1', action: 'created', actor: 'admin' });
      audit.record({ key: 'k1', action: 'rotated', actor: 'admin' });
      audit.record({ key: 'k2', action: 'created', actor: 'ops' });

      const stats = audit.getStats();
      expect(stats.totalEntries).toBe(3);
      expect(stats.uniqueKeys).toBe(2);
      expect(stats.uniqueActors).toBe(2);
      expect(stats.actionBreakdown).toHaveLength(2);
    });

    it('destroy resets everything', () => {
      audit.record({ key: 'k1', action: 'created', actor: 'a' });
      audit.destroy();
      expect(audit.getStats().totalEntries).toBe(0);
    });
  });
});
