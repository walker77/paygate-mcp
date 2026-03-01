import { CreditPoolManager } from '../src/credit-pool';

describe('CreditPoolManager', () => {
  let pools: CreditPoolManager;

  beforeEach(() => {
    pools = new CreditPoolManager();
  });

  afterEach(() => {
    pools.destroy();
  });

  // ── Pool Management ────────────────────────────────────────────────

  describe('pool management', () => {
    it('creates a pool', () => {
      const pool = pools.createPool({ name: 'team-budget', credits: 10000 });
      expect(pool.id).toMatch(/^pool_/);
      expect(pool.name).toBe('team-budget');
      expect(pool.totalCredits).toBe(10000);
      expect(pool.usedCredits).toBe(0);
    });

    it('rejects empty name', () => {
      expect(() => pools.createPool({ name: '', credits: 100 })).toThrow();
    });

    it('rejects non-positive credits', () => {
      expect(() => pools.createPool({ name: 'bad', credits: 0 })).toThrow();
    });

    it('rejects duplicate names', () => {
      pools.createPool({ name: 'team', credits: 100 });
      expect(() => pools.createPool({ name: 'team', credits: 200 })).toThrow(/already exists/);
    });

    it('gets pool by ID', () => {
      const pool = pools.createPool({ name: 'test', credits: 100 });
      expect(pools.getPool(pool.id)).not.toBeNull();
      expect(pools.getPool('pool_999')).toBeNull();
    });

    it('deletes a pool', () => {
      const pool = pools.createPool({ name: 'test', credits: 100 });
      expect(pools.deletePool(pool.id)).toBe(true);
      expect(pools.getPool(pool.id)).toBeNull();
      expect(pools.deletePool(pool.id)).toBe(false);
    });

    it('adds credits to pool', () => {
      const pool = pools.createPool({ name: 'grow', credits: 100 });
      const updated = pools.addCredits(pool.id, 50);
      expect(updated!.totalCredits).toBe(150);
    });

    it('rejects non-positive addCredits', () => {
      const pool = pools.createPool({ name: 'test', credits: 100 });
      expect(() => pools.addCredits(pool.id, 0)).toThrow();
    });

    it('returns null for unknown pool addCredits', () => {
      expect(pools.addCredits('pool_999', 50)).toBeNull();
    });
  });

  // ── Membership ─────────────────────────────────────────────────────

  describe('membership', () => {
    let poolId: string;

    beforeEach(() => {
      const pool = pools.createPool({ name: 'shared', credits: 5000 });
      poolId = pool.id;
    });

    it('adds a member', () => {
      expect(pools.addMember(poolId, 'key_a')).toBe(true);
      expect(pools.getPool(poolId)!.members).toContain('key_a');
    });

    it('rejects duplicate member', () => {
      pools.addMember(poolId, 'key_a');
      expect(pools.addMember(poolId, 'key_a')).toBe(false);
    });

    it('throws for unknown pool', () => {
      expect(() => pools.addMember('pool_999', 'key_a')).toThrow(/not found/);
    });

    it('removes a member', () => {
      pools.addMember(poolId, 'key_a');
      expect(pools.removeMember(poolId, 'key_a')).toBe(true);
      expect(pools.getPool(poolId)!.members).not.toContain('key_a');
    });

    it('returns false for unknown member removal', () => {
      expect(pools.removeMember(poolId, 'key_999')).toBe(false);
    });

    it('returns false for unknown pool removal', () => {
      expect(pools.removeMember('pool_999', 'key_a')).toBe(false);
    });

    it('gets pools for a key', () => {
      const p2 = pools.createPool({ name: 'other', credits: 1000 });
      pools.addMember(poolId, 'key_a');
      pools.addMember(p2.id, 'key_a');
      expect(pools.getKeyPools('key_a')).toHaveLength(2);
      expect(pools.getKeyPools('key_999')).toEqual([]);
    });

    it('cleans up key-to-pool mapping on delete', () => {
      pools.addMember(poolId, 'key_a');
      pools.deletePool(poolId);
      expect(pools.getKeyPools('key_a')).toEqual([]);
    });
  });

  // ── Credit Operations ──────────────────────────────────────────────

  describe('credit operations', () => {
    let poolId: string;

    beforeEach(() => {
      const pool = pools.createPool({ name: 'ops', credits: 1000 });
      poolId = pool.id;
      pools.addMember(poolId, 'key_a');
      pools.addMember(poolId, 'key_b');
    });

    it('consumes credits', () => {
      const result = pools.consume(poolId, 'key_a', 200);
      expect(result).not.toBeNull();
      expect(result!.balanceBefore).toBe(1000);
      expect(result!.balanceAfter).toBe(800);
      expect(result!.amount).toBe(200);
    });

    it('rejects non-positive amount', () => {
      expect(() => pools.consume(poolId, 'key_a', 0)).toThrow();
    });

    it('returns null for insufficient credits', () => {
      expect(pools.consume(poolId, 'key_a', 1001)).toBeNull();
    });

    it('returns null for non-member', () => {
      expect(pools.consume(poolId, 'key_999', 100)).toBeNull();
    });

    it('returns null for unknown pool', () => {
      expect(pools.consume('pool_999', 'key_a', 100)).toBeNull();
    });

    it('shares credits between members', () => {
      pools.consume(poolId, 'key_a', 600);
      pools.consume(poolId, 'key_b', 300);
      expect(pools.getRemaining(poolId)).toBe(100);
    });

    it('gets remaining credits', () => {
      pools.consume(poolId, 'key_a', 400);
      expect(pools.getRemaining(poolId)).toBe(600);
      expect(pools.getRemaining('pool_999')).toBe(0);
    });
  });

  // ── Query ──────────────────────────────────────────────────────────

  describe('query', () => {
    it('gets pool status', () => {
      const pool = pools.createPool({ name: 'test', credits: 1000 });
      pools.addMember(pool.id, 'k1');
      pools.consume(pool.id, 'k1', 250);

      const status = pools.getPoolStatus(pool.id);
      expect(status).not.toBeNull();
      expect(status!.remainingCredits).toBe(750);
      expect(status!.percentUsed).toBe(25);
      expect(status!.memberCount).toBe(1);
    });

    it('returns null for unknown pool status', () => {
      expect(pools.getPoolStatus('pool_999')).toBeNull();
    });

    it('gets consumption history', () => {
      const pool = pools.createPool({ name: 'hist', credits: 1000 });
      pools.addMember(pool.id, 'k1');
      pools.consume(pool.id, 'k1', 100);
      pools.consume(pool.id, 'k1', 200);
      expect(pools.getHistory(pool.id)).toHaveLength(2);
    });

    it('lists all pools', () => {
      pools.createPool({ name: 'a', credits: 100 });
      pools.createPool({ name: 'b', credits: 200 });
      expect(pools.listPools()).toHaveLength(2);
    });
  });

  // ── Stats & Destroy ────────────────────────────────────────────────

  describe('stats and destroy', () => {
    it('tracks comprehensive stats', () => {
      const p1 = pools.createPool({ name: 'a', credits: 1000 });
      const p2 = pools.createPool({ name: 'b', credits: 2000 });
      pools.addMember(p1.id, 'k1');
      pools.addMember(p2.id, 'k2');
      pools.addMember(p2.id, 'k3');
      pools.consume(p1.id, 'k1', 500);

      const stats = pools.getStats();
      expect(stats.totalPools).toBe(2);
      expect(stats.totalMembers).toBe(3);
      expect(stats.totalCreditsAllocated).toBe(3000);
      expect(stats.totalCreditsUsed).toBe(500);
    });

    it('destroy resets everything', () => {
      pools.createPool({ name: 'x', credits: 100 });
      pools.destroy();
      expect(pools.getStats().totalPools).toBe(0);
    });
  });
});
