import { APIKeyDeprecation } from '../src/key-deprecation';

describe('APIKeyDeprecation', () => {
  let dep: APIKeyDeprecation;

  beforeEach(() => {
    dep = new APIKeyDeprecation();
  });

  afterEach(() => {
    dep.destroy();
  });

  // ── Deprecation Management ─────────────────────────────────────────

  describe('deprecation management', () => {
    it('deprecates a key', () => {
      const record = dep.deprecateKey({
        key: 'old_key',
        sunsetAt: Date.now() + 86400000,
        reason: 'Migrating to v2',
        replacement: 'new_key',
      });
      expect(record.id).toMatch(/^dep_/);
      expect(record.status).toBe('deprecated');
      expect(record.replacement).toBe('new_key');
    });

    it('rejects empty key', () => {
      expect(() => dep.deprecateKey({ key: '', sunsetAt: Date.now() + 86400000, reason: 'test' })).toThrow();
    });

    it('rejects empty reason', () => {
      expect(() => dep.deprecateKey({ key: 'k1', sunsetAt: Date.now() + 86400000, reason: '' })).toThrow();
    });

    it('rejects past sunset date', () => {
      expect(() => dep.deprecateKey({ key: 'k1', sunsetAt: Date.now() - 1000, reason: 'test' })).toThrow();
    });

    it('rejects duplicate key deprecation', () => {
      dep.deprecateKey({ key: 'k1', sunsetAt: Date.now() + 86400000, reason: 'test' });
      expect(() => dep.deprecateKey({ key: 'k1', sunsetAt: Date.now() + 86400000, reason: 'test2' })).toThrow(/already has/);
    });

    it('cancels a deprecation', () => {
      dep.deprecateKey({ key: 'k1', sunsetAt: Date.now() + 86400000, reason: 'test' });
      expect(dep.cancelDeprecation('k1')).toBe(true);
      expect(dep.getKeyStatus('k1')).toBeNull();
      expect(dep.cancelDeprecation('k1')).toBe(false);
    });

    it('expires a key', () => {
      dep.deprecateKey({ key: 'k1', sunsetAt: Date.now() + 86400000, reason: 'test' });
      expect(dep.expireKey('k1')).toBe(true);
      expect(dep.getKeyStatus('k1')!.status).toBe('expired');
    });

    it('returns false for unknown key expire', () => {
      expect(dep.expireKey('unknown')).toBe(false);
    });

    it('extends sunset date', () => {
      dep.deprecateKey({ key: 'k1', sunsetAt: Date.now() + 86400000, reason: 'test' });
      const newSunset = Date.now() + 172800000;
      const updated = dep.extendSunset('k1', newSunset);
      expect(updated).not.toBeNull();
      expect(updated!.sunsetAt).toBe(newSunset);
    });

    it('returns null for unknown key extend', () => {
      expect(dep.extendSunset('unknown', Date.now() + 86400000)).toBeNull();
    });

    it('rejects past date for extend', () => {
      dep.deprecateKey({ key: 'k1', sunsetAt: Date.now() + 86400000, reason: 'test' });
      expect(() => dep.extendSunset('k1', Date.now() - 1000)).toThrow();
    });
  });

  // ── Query ──────────────────────────────────────────────────────────

  describe('query', () => {
    beforeEach(() => {
      dep.deprecateKey({ key: 'k1', sunsetAt: Date.now() + 86400000, reason: 'v2 migration' });
      dep.deprecateKey({ key: 'k2', sunsetAt: Date.now() + 172800000, reason: 'v3 migration' });
    });

    it('gets key status', () => {
      const status = dep.getKeyStatus('k1');
      expect(status).not.toBeNull();
      expect(status!.status).toBe('deprecated');
      expect(status!.daysUntilSunset).toBeGreaterThanOrEqual(0);
    });

    it('returns null for unknown key', () => {
      expect(dep.getKeyStatus('unknown')).toBeNull();
    });

    it('queries all deprecated', () => {
      expect(dep.query()).toHaveLength(2);
    });

    it('queries by status', () => {
      expect(dep.query({ status: 'deprecated' })).toHaveLength(2);
      expect(dep.query({ status: 'expired' })).toHaveLength(0);
    });

    it('checks if key is deprecated', () => {
      expect(dep.isDeprecated('k1')).toBe(true);
      expect(dep.isDeprecated('unknown')).toBe(false);
    });

    it('gets raw record', () => {
      const record = dep.getRecord('k1');
      expect(record).not.toBeNull();
      expect(record!.reason).toBe('v2 migration');
    });
  });

  // ── Stats & Destroy ────────────────────────────────────────────────

  describe('stats and destroy', () => {
    it('tracks comprehensive stats', () => {
      dep.deprecateKey({ key: 'k1', sunsetAt: Date.now() + 86400000, reason: 'test' });
      dep.deprecateKey({ key: 'k2', sunsetAt: Date.now() + 172800000, reason: 'test' });
      dep.expireKey('k2');

      const stats = dep.getStats();
      expect(stats.totalTracked).toBe(2);
      expect(stats.deprecatedCount).toBe(1);
      expect(stats.expiredCount).toBe(1);
    });

    it('destroy resets everything', () => {
      dep.deprecateKey({ key: 'k1', sunsetAt: Date.now() + 86400000, reason: 'test' });
      dep.destroy();
      expect(dep.getStats().totalTracked).toBe(0);
    });
  });
});
