/**
 * Tests for Prepaid Credit Grants.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { CreditGrantManager, CreditGrant } from '../src/credit-grants';

describe('CreditGrantManager', () => {
  let manager: CreditGrantManager;

  beforeEach(() => {
    manager = new CreditGrantManager();
  });

  // ─── Grant Creation ─────────────────────────────────────────────────
  describe('createGrant', () => {
    it('creates a grant with defaults', () => {
      const grant = manager.createGrant('key-1', {
        name: 'Welcome Credits',
        amount: 100,
      });
      expect(grant.name).toBe('Welcome Credits');
      expect(grant.amount).toBe(100);
      expect(grant.balance).toBe(100);
      expect(grant.used).toBe(0);
      expect(grant.priority).toBe(10);
      expect(grant.expiresAt).toBeNull();
      expect(grant.active).toBe(true);
    });

    it('creates a grant with custom params', () => {
      const grant = manager.createGrant('key-1', {
        id: 'promo-50',
        name: 'Promo',
        amount: 50,
        priority: 1,
        expiresAt: '2030-01-01T00:00:00Z',
        metadata: { campaign: 'launch' },
      });
      expect(grant.id).toBe('promo-50');
      expect(grant.priority).toBe(1);
      expect(grant.expiresAt).toBe('2030-01-01T00:00:00Z');
      expect(grant.metadata?.campaign).toBe('launch');
    });

    it('tracks stats on creation', () => {
      manager.createGrant('key-1', { name: 'A', amount: 100 });
      manager.createGrant('key-2', { name: 'B', amount: 200 });
      const stats = manager.getStats();
      expect(stats.totalKeys).toBe(2);
      expect(stats.totalGrants).toBe(2);
      expect(stats.activeGrants).toBe(2);
      expect(stats.totalAllocated).toBe(300);
    });
  });

  // ─── Deduction ──────────────────────────────────────────────────────
  describe('deduct', () => {
    it('deducts from a single grant', () => {
      manager.createGrant('key-1', { name: 'Credits', amount: 100 });
      const result = manager.deduct('key-1', 30);
      expect(result.success).toBe(true);
      expect(result.totalDeducted).toBe(30);
      expect(result.remainingBalance).toBe(70);
      expect(result.breakdown).toHaveLength(1);
      expect(result.breakdown[0].amount).toBe(30);
    });

    it('deducts from highest-priority grant first', () => {
      manager.createGrant('key-1', { id: 'low', name: 'Low Priority', amount: 100, priority: 10 });
      manager.createGrant('key-1', { id: 'high', name: 'High Priority', amount: 50, priority: 1 });

      const result = manager.deduct('key-1', 30);
      expect(result.success).toBe(true);
      expect(result.breakdown[0].grantId).toBe('high');
      expect(result.breakdown[0].amount).toBe(30);
    });

    it('spills over to next grant when first is insufficient', () => {
      manager.createGrant('key-1', { id: 'a', name: 'Small', amount: 20, priority: 1 });
      manager.createGrant('key-1', { id: 'b', name: 'Large', amount: 100, priority: 2 });

      const result = manager.deduct('key-1', 50);
      expect(result.success).toBe(true);
      expect(result.totalDeducted).toBe(50);
      expect(result.breakdown).toHaveLength(2);
      expect(result.breakdown[0].grantId).toBe('a');
      expect(result.breakdown[0].amount).toBe(20);
      expect(result.breakdown[1].grantId).toBe('b');
      expect(result.breakdown[1].amount).toBe(30);
    });

    it('fails when insufficient total balance', () => {
      manager.createGrant('key-1', { name: 'Credits', amount: 10 });
      const result = manager.deduct('key-1', 50);
      expect(result.success).toBe(false);
      expect(result.totalDeducted).toBe(0);
      expect(result.shortfall).toBe(40);
    });

    it('returns shortfall for unknown key', () => {
      const result = manager.deduct('unknown', 10);
      expect(result.success).toBe(false);
      expect(result.shortfall).toBe(10);
    });

    it('prefers soonest-expiring at same priority', () => {
      manager.createGrant('key-1', { id: 'later', name: 'Later', amount: 50, priority: 1, expiresAt: '2030-12-01T00:00:00Z' });
      manager.createGrant('key-1', { id: 'sooner', name: 'Sooner', amount: 50, priority: 1, expiresAt: '2030-06-01T00:00:00Z' });

      const result = manager.deduct('key-1', 20);
      expect(result.breakdown[0].grantId).toBe('sooner');
    });

    it('skips expired grants', () => {
      manager.createGrant('key-1', { id: 'expired', name: 'Old', amount: 100, priority: 1, expiresAt: '2020-01-01T00:00:00Z' });
      manager.createGrant('key-1', { id: 'active', name: 'New', amount: 50, priority: 2 });

      const result = manager.deduct('key-1', 30);
      expect(result.success).toBe(true);
      expect(result.breakdown[0].grantId).toBe('active');
    });

    it('tracks stats on deduction', () => {
      manager.createGrant('key-1', { name: 'Credits', amount: 100 });
      manager.deduct('key-1', 30);
      manager.deduct('key-1', 20);
      const stats = manager.getStats();
      expect(stats.totalConsumed).toBe(50);
      expect(stats.totalDeductions).toBe(2);
    });
  });

  // ─── Refund ─────────────────────────────────────────────────────────
  describe('refund', () => {
    it('refunds credits back to a grant', () => {
      const grant = manager.createGrant('key-1', { id: 'g1', name: 'Credits', amount: 100 });
      manager.deduct('key-1', 30);
      const ok = manager.refund('key-1', 'g1', 10);
      expect(ok).toBe(true);
      const updated = manager.getGrant('key-1', 'g1');
      expect(updated?.balance).toBe(80);
      expect(updated?.used).toBe(20);
    });

    it('limits refund to amount used', () => {
      manager.createGrant('key-1', { id: 'g1', name: 'Credits', amount: 100 });
      manager.deduct('key-1', 10);
      manager.refund('key-1', 'g1', 999);
      const updated = manager.getGrant('key-1', 'g1');
      expect(updated?.balance).toBe(100);
      expect(updated?.used).toBe(0);
    });

    it('returns false for unknown key/grant', () => {
      expect(manager.refund('unknown', 'g1', 10)).toBe(false);
    });
  });

  // ─── Rollover ───────────────────────────────────────────────────────
  describe('rollover', () => {
    it('rolls over remaining balance to a new grant', () => {
      manager.createGrant('key-1', { id: 'old', name: 'January', amount: 100 });
      manager.deduct('key-1', 40);

      const result = manager.rollover('key-1', 'old', {
        name: 'February (Rollover)',
        amount: 0, // Will be overridden
        expiresAt: '2030-03-01T00:00:00Z',
      });

      expect(result).not.toBeNull();
      expect(result!.creditsRolled).toBe(60);
      expect(result!.creditsLost).toBe(0);
      expect(result!.newGrant.balance).toBe(60);
      expect(result!.newGrant.rolledOverFrom).toBe('old');
      expect(result!.sourceGrant.active).toBe(false);
    });

    it('supports partial rollover', () => {
      manager.createGrant('key-1', { id: 'old', name: 'Credits', amount: 100 });

      const result = manager.rollover('key-1', 'old', {
        name: 'Partial Rollover',
        amount: 0,
      }, 50);

      expect(result).not.toBeNull();
      expect(result!.creditsRolled).toBe(50);
      expect(result!.creditsLost).toBe(50);
    });

    it('returns null for unknown grant', () => {
      expect(manager.rollover('key-1', 'nonexistent', { name: 'x', amount: 0 })).toBeNull();
    });

    it('returns null for empty balance', () => {
      manager.createGrant('key-1', { id: 'empty', name: 'Empty', amount: 10 });
      manager.deduct('key-1', 10);
      expect(manager.rollover('key-1', 'empty', { name: 'x', amount: 0 })).toBeNull();
    });

    it('tracks rollover stats', () => {
      manager.createGrant('key-1', { id: 'old', name: 'Old', amount: 100 });
      manager.rollover('key-1', 'old', { name: 'New', amount: 0 });
      expect(manager.getStats().totalRollovers).toBe(1);
    });
  });

  // ─── Expiration ─────────────────────────────────────────────────────
  describe('expiration', () => {
    it('expires grants past expiration date', () => {
      manager.createGrant('key-1', { id: 'expired', name: 'Old', amount: 50, expiresAt: '2020-01-01T00:00:00Z' });
      const count = manager.expireGrants('key-1');
      expect(count).toBe(1);
      expect(manager.getGrant('key-1', 'expired')?.active).toBe(false);
    });

    it('does not expire non-expiring grants', () => {
      manager.createGrant('key-1', { name: 'Forever', amount: 50 });
      const count = manager.expireGrants('key-1');
      expect(count).toBe(0);
    });

    it('marks expired credits as lost in stats', () => {
      manager.createGrant('key-1', { name: 'Old', amount: 75, expiresAt: '2020-01-01T00:00:00Z' });
      manager.expireGrants('key-1');
      expect(manager.getStats().totalExpired).toBe(75);
    });

    it('expireAll works across all keys', () => {
      manager.createGrant('key-1', { name: 'A', amount: 50, expiresAt: '2020-01-01T00:00:00Z' });
      manager.createGrant('key-2', { name: 'B', amount: 50, expiresAt: '2020-01-01T00:00:00Z' });
      const count = manager.expireAll();
      expect(count).toBe(2);
    });
  });

  // ─── Balance & Summary ──────────────────────────────────────────────
  describe('balance and summary', () => {
    it('getBalance returns total active balance', () => {
      manager.createGrant('key-1', { name: 'A', amount: 100 });
      manager.createGrant('key-1', { name: 'B', amount: 50 });
      expect(manager.getBalance('key-1')).toBe(150);
    });

    it('getBalance returns 0 for unknown key', () => {
      expect(manager.getBalance('unknown')).toBe(0);
    });

    it('getSummary returns comprehensive info', () => {
      manager.createGrant('key-1', { name: 'Active', amount: 100, expiresAt: '2030-06-01T00:00:00Z' });
      manager.createGrant('key-1', { name: 'Expired', amount: 50, expiresAt: '2020-01-01T00:00:00Z' });
      manager.deduct('key-1', 20);

      const summary = manager.getSummary('key-1');
      expect(summary.totalGrants).toBe(2);
      expect(summary.activeGrants).toBe(1);
      expect(summary.expiredGrants).toBe(1);
      expect(summary.totalBalance).toBe(80);
      expect(summary.totalUsed).toBe(20);
      expect(summary.nearestExpiry).toBe('2030-06-01T00:00:00Z');
      expect(summary.grantsByPriority).toHaveLength(1);
    });
  });

  // ─── Void ───────────────────────────────────────────────────────────
  describe('voidGrant', () => {
    it('voids an active grant', () => {
      manager.createGrant('key-1', { id: 'g1', name: 'Credits', amount: 100 });
      expect(manager.voidGrant('key-1', 'g1')).toBe(true);
      expect(manager.getGrant('key-1', 'g1')?.active).toBe(false);
      expect(manager.getBalance('key-1')).toBe(0);
    });

    it('returns false for already-voided grant', () => {
      manager.createGrant('key-1', { id: 'g1', name: 'Credits', amount: 100 });
      manager.voidGrant('key-1', 'g1');
      expect(manager.voidGrant('key-1', 'g1')).toBe(false);
    });
  });

  // ─── Grant Retrieval ────────────────────────────────────────────────
  describe('getGrants', () => {
    it('returns all grants for a key', () => {
      manager.createGrant('key-1', { name: 'A', amount: 100 });
      manager.createGrant('key-1', { name: 'B', amount: 50 });
      expect(manager.getGrants('key-1')).toHaveLength(2);
    });

    it('filters by active status', () => {
      manager.createGrant('key-1', { id: 'a', name: 'Active', amount: 100 });
      manager.createGrant('key-1', { id: 'v', name: 'Voided', amount: 50 });
      manager.voidGrant('key-1', 'v');

      expect(manager.getGrants('key-1', { active: true })).toHaveLength(1);
      expect(manager.getGrants('key-1', { active: false })).toHaveLength(1);
    });

    it('returns empty for unknown key', () => {
      expect(manager.getGrants('unknown')).toHaveLength(0);
    });
  });

  // ─── Export/Import ──────────────────────────────────────────────────
  describe('export/import', () => {
    it('round-trips data', () => {
      manager.createGrant('key-1', { id: 'g1', name: 'Credits', amount: 100 });
      manager.deduct('key-1', 30);

      const exported = manager.exportAll();
      const manager2 = new CreditGrantManager();
      manager2.importAll(exported);

      expect(manager2.getBalance('key-1')).toBe(70);
      expect(manager2.getGrants('key-1')).toHaveLength(1);
    });
  });

  // ─── Cleanup ────────────────────────────────────────────────────────
  describe('clearGrants', () => {
    it('removes all grants for a key', () => {
      manager.createGrant('key-1', { name: 'A', amount: 100 });
      manager.createGrant('key-1', { name: 'B', amount: 50 });
      manager.clearGrants('key-1');
      expect(manager.getGrants('key-1')).toHaveLength(0);
      expect(manager.getStats().totalKeys).toBe(0);
    });
  });

  // ─── Destroy ────────────────────────────────────────────────────────
  describe('destroy', () => {
    it('releases all resources', () => {
      manager.createGrant('key-1', { name: 'Credits', amount: 100 });
      manager.destroy();
      expect(manager.getBalance('key-1')).toBe(0);
      expect(manager.getStats().totalGrants).toBe(0);
    });
  });
});
