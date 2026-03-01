import { CreditExpirationManager } from '../src/credit-expiration';

describe('CreditExpirationManager', () => {
  let mgr: CreditExpirationManager;

  beforeEach(() => {
    mgr = new CreditExpirationManager();
  });

  afterEach(() => {
    mgr.destroy();
  });

  // ── Granting ────────────────────────────────────────────────────

  describe('granting', () => {
    it('grants credits with expiration', () => {
      const grant = mgr.grant({ key: 'k1', amount: 100, expiresInMs: 60000 });
      expect(grant.id).toMatch(/^cg_/);
      expect(grant.originalAmount).toBe(100);
      expect(grant.remainingAmount).toBe(100);
      expect(grant.expired).toBe(false);
    });

    it('rejects non-positive amount', () => {
      expect(() => mgr.grant({ key: 'k1', amount: 0, expiresInMs: 60000 })).toThrow('positive');
    });

    it('rejects non-positive expiration', () => {
      expect(() => mgr.grant({ key: 'k1', amount: 100, expiresInMs: 0 })).toThrow('positive');
    });

    it('tracks source', () => {
      const grant = mgr.grant({ key: 'k1', amount: 100, expiresInMs: 60000, source: 'promo' });
      expect(grant.source).toBe('promo');
    });
  });

  // ── Consumption ─────────────────────────────────────────────────

  describe('consumption', () => {
    it('consumes from oldest grant first (FIFO)', () => {
      mgr.grant({ key: 'k1', amount: 50, expiresInMs: 60000 });
      mgr.grant({ key: 'k1', amount: 100, expiresInMs: 120000 });

      const result = mgr.consume('k1', 70);
      expect(result.consumed).toBe(70);
      expect(result.remaining).toBe(80); // 0 from first + 80 from second
      expect(result.grantsUsed).toBe(2);
    });

    it('returns 0 consumed for unknown key', () => {
      const result = mgr.consume('unknown', 10);
      expect(result.consumed).toBe(0);
      expect(result.remaining).toBe(0);
    });

    it('partially consumes when insufficient balance', () => {
      mgr.grant({ key: 'k1', amount: 30, expiresInMs: 60000 });

      const result = mgr.consume('k1', 50);
      expect(result.consumed).toBe(30);
      expect(result.remaining).toBe(0);
    });

    it('consumes exact balance', () => {
      mgr.grant({ key: 'k1', amount: 100, expiresInMs: 60000 });

      const result = mgr.consume('k1', 100);
      expect(result.consumed).toBe(100);
      expect(result.remaining).toBe(0);
    });

    it('rejects non-positive consume amount', () => {
      expect(() => mgr.consume('k1', 0)).toThrow('positive');
    });
  });

  // ── Expiration ──────────────────────────────────────────────────

  describe('expiration', () => {
    it('expired grants are not consumable', async () => {
      mgr.grant({ key: 'k1', amount: 100, expiresInMs: 50 });

      await new Promise(r => setTimeout(r, 80));

      const result = mgr.consume('k1', 10);
      expect(result.consumed).toBe(0);
    });

    it('getBalance excludes expired grants', async () => {
      mgr.grant({ key: 'k1', amount: 100, expiresInMs: 50 });
      mgr.grant({ key: 'k1', amount: 200, expiresInMs: 60000 });

      await new Promise(r => setTimeout(r, 80));

      expect(mgr.getBalance('k1')).toBe(200);
    });

    it('force expires all grants for a key', () => {
      mgr.grant({ key: 'k1', amount: 100, expiresInMs: 60000 });
      mgr.grant({ key: 'k1', amount: 200, expiresInMs: 120000 });

      const count = mgr.expireAll('k1');
      expect(count).toBe(2);
      expect(mgr.getBalance('k1')).toBe(0);
    });
  });

  // ── Query ───────────────────────────────────────────────────────

  describe('query', () => {
    it('gets balance for a key', () => {
      mgr.grant({ key: 'k1', amount: 100, expiresInMs: 60000 });
      mgr.grant({ key: 'k1', amount: 50, expiresInMs: 60000 });
      expect(mgr.getBalance('k1')).toBe(150);
    });

    it('returns 0 for unknown key', () => {
      expect(mgr.getBalance('unknown')).toBe(0);
    });

    it('gets active grants for a key', () => {
      mgr.grant({ key: 'k1', amount: 100, expiresInMs: 60000 });
      mgr.grant({ key: 'k1', amount: 50, expiresInMs: 60000 });
      mgr.consume('k1', 100); // depletes first grant

      const grants = mgr.getGrants('k1');
      expect(grants).toHaveLength(1);
      expect(grants[0].remainingAmount).toBe(50);
    });

    it('gets expiring-soon grants', () => {
      mgr.grant({ key: 'k1', amount: 100, expiresInMs: 5000 }); // 5s
      mgr.grant({ key: 'k2', amount: 200, expiresInMs: 60000 }); // 60s

      const expiring = mgr.getExpiringSoon(10000); // within 10s
      expect(expiring).toHaveLength(1);
      expect(expiring[0].key).toBe('k1');
    });
  });

  // ── Stats & Destroy ─────────────────────────────────────────────

  describe('stats and destroy', () => {
    it('tracks comprehensive stats', () => {
      mgr.grant({ key: 'k1', amount: 100, expiresInMs: 60000 });
      mgr.grant({ key: 'k2', amount: 200, expiresInMs: 60000 });
      mgr.consume('k1', 30);

      const stats = mgr.getStats();
      expect(stats.trackedKeys).toBe(2);
      expect(stats.totalGrants).toBe(2);
      expect(stats.totalGranted).toBe(300);
      expect(stats.totalConsumed).toBe(30);
    });

    it('destroy resets everything', () => {
      mgr.grant({ key: 'k1', amount: 100, expiresInMs: 60000 });
      mgr.destroy();

      expect(mgr.getStats().trackedKeys).toBe(0);
      expect(mgr.getStats().totalGranted).toBe(0);
    });
  });
});
