/**
 * Tests for Revenue Share Tracking.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { RevenueShareTracker } from '../src/revenue-share';

describe('RevenueShareTracker', () => {
  let tracker: RevenueShareTracker;

  beforeEach(() => {
    tracker = new RevenueShareTracker();
  });

  // ─── Rule Management ──────────────────────────────────────────────────

  describe('rule management', () => {
    it('creates a rule', () => {
      const ok = tracker.upsertRule({
        id: 'rule-1',
        developerId: 'dev-1',
        tools: ['readFile', 'writeFile'],
        sharePercent: 30,
        minCreditsPerCall: 0,
        active: true,
      });
      expect(ok).toBe(true);
      expect(tracker.getRule('rule-1')).not.toBeNull();
    });

    it('rejects invalid share percent', () => {
      expect(tracker.upsertRule({ id: 'r', developerId: 'd', tools: [], sharePercent: 101, minCreditsPerCall: 0, active: true })).toBe(false);
      expect(tracker.upsertRule({ id: 'r', developerId: 'd', tools: [], sharePercent: -1, minCreditsPerCall: 0, active: true })).toBe(false);
    });

    it('removes a rule', () => {
      tracker.upsertRule({ id: 'r1', developerId: 'd1', tools: [], sharePercent: 20, minCreditsPerCall: 0, active: true });
      expect(tracker.removeRule('r1')).toBe(true);
      expect(tracker.getRule('r1')).toBeNull();
    });

    it('lists rules', () => {
      tracker.upsertRule({ id: 'r1', developerId: 'd1', tools: [], sharePercent: 20, minCreditsPerCall: 0, active: true });
      tracker.upsertRule({ id: 'r2', developerId: 'd2', tools: [], sharePercent: 30, minCreditsPerCall: 0, active: true });
      expect(tracker.getRules()).toHaveLength(2);
    });
  });

  // ─── Rule Matching ────────────────────────────────────────────────────

  describe('findRule', () => {
    it('matches tool-specific rules', () => {
      tracker.upsertRule({ id: 'r1', developerId: 'd1', tools: ['readFile'], sharePercent: 30, minCreditsPerCall: 0, active: true });
      expect(tracker.findRule('readFile')?.id).toBe('r1');
      expect(tracker.findRule('writeFile')).toBeNull();
    });

    it('matches catch-all rules (empty tools)', () => {
      tracker.upsertRule({ id: 'r1', developerId: 'd1', tools: [], sharePercent: 20, minCreditsPerCall: 0, active: true });
      expect(tracker.findRule('anyTool')?.id).toBe('r1');
    });

    it('skips inactive rules', () => {
      tracker.upsertRule({ id: 'r1', developerId: 'd1', tools: [], sharePercent: 20, minCreditsPerCall: 0, active: false });
      expect(tracker.findRule('tool')).toBeNull();
    });
  });

  // ─── Revenue Recording ────────────────────────────────────────────────

  describe('record', () => {
    beforeEach(() => {
      tracker.upsertRule({ id: 'r1', developerId: 'dev-1', tools: ['premium_tool'], sharePercent: 30, minCreditsPerCall: 0, active: true });
    });

    it('splits revenue correctly', () => {
      const entry = tracker.record('premium_tool', 10, 'key-1');
      expect(entry).not.toBeNull();
      expect(entry!.developerShare).toBe(3); // 30% of 10
      expect(entry!.platformShare).toBe(7); // 70% of 10
    });

    it('returns null for non-matching tools', () => {
      const entry = tracker.record('other_tool', 10, 'key-1');
      expect(entry).toBeNull();
    });

    it('skips calls below minimum', () => {
      tracker.upsertRule({ id: 'r2', developerId: 'dev-2', tools: ['expensive'], sharePercent: 50, minCreditsPerCall: 5, active: true });
      expect(tracker.record('expensive', 3, 'key-1')).toBeNull();
      expect(tracker.record('expensive', 5, 'key-1')).not.toBeNull();
    });

    it('handles zero credits', () => {
      expect(tracker.record('premium_tool', 0, 'key-1')).toBeNull();
    });

    it('floors developer share', () => {
      // 30% of 7 = 2.1, should floor to 2
      const entry = tracker.record('premium_tool', 7, 'key-1');
      expect(entry!.developerShare).toBe(2);
      expect(entry!.platformShare).toBe(5);
    });
  });

  // ─── Developer Payouts ────────────────────────────────────────────────

  describe('developer payouts', () => {
    beforeEach(() => {
      tracker.upsertRule({ id: 'r1', developerId: 'dev-1', tools: ['tool1'], sharePercent: 50, minCreditsPerCall: 0, active: true });
    });

    it('tracks developer earnings', () => {
      tracker.record('tool1', 10, 'key-1');
      tracker.record('tool1', 20, 'key-1');

      const payout = tracker.getDeveloperPayout('dev-1');
      expect(payout).not.toBeNull();
      expect(payout!.totalEarned).toBe(15); // 50% of 30
      expect(payout!.balance).toBe(15);
      expect(payout!.callCount).toBe(2);
    });

    it('returns null for unknown developer', () => {
      expect(tracker.getDeveloperPayout('unknown')).toBeNull();
    });

    it('tracks per-tool breakdown', () => {
      tracker.upsertRule({ id: 'r2', developerId: 'dev-1', tools: ['tool2'], sharePercent: 50, minCreditsPerCall: 0, active: true });
      tracker.record('tool1', 10, 'key-1');
      tracker.record('tool2', 20, 'key-1');

      const payout = tracker.getDeveloperPayout('dev-1');
      expect(payout!.byTool['tool1'].credits).toBe(5);
      expect(payout!.byTool['tool2']).toBeDefined();
    });
  });

  // ─── Settlements ──────────────────────────────────────────────────────

  describe('settle', () => {
    beforeEach(() => {
      tracker.upsertRule({ id: 'r1', developerId: 'dev-1', tools: [], sharePercent: 40, minCreditsPerCall: 0, active: true });
      tracker.record('tool1', 100, 'key-1');
    });

    it('settles developer balance', () => {
      const settlement = tracker.settle('dev-1', 'stripe_transfer_123');
      expect(settlement).not.toBeNull();
      expect(settlement!.credits).toBe(40); // 40% of 100
      expect(settlement!.externalRef).toBe('stripe_transfer_123');
    });

    it('zeroes balance after settlement', () => {
      tracker.settle('dev-1');
      const payout = tracker.getDeveloperPayout('dev-1');
      expect(payout!.balance).toBe(0);
    });

    it('returns null for zero balance', () => {
      tracker.settle('dev-1');
      expect(tracker.settle('dev-1')).toBeNull();
    });

    it('tracks settlement history', () => {
      tracker.settle('dev-1');
      tracker.record('tool1', 50, 'key-2');
      tracker.settle('dev-1');

      const settlements = tracker.getSettlements('dev-1');
      expect(settlements).toHaveLength(2);
    });
  });

  // ─── Platform Summary ─────────────────────────────────────────────────

  describe('platform summary', () => {
    it('shows revenue split', () => {
      tracker.upsertRule({ id: 'r1', developerId: 'dev-1', tools: [], sharePercent: 30, minCreditsPerCall: 0, active: true });
      tracker.record('tool1', 100, 'key-1');

      const summary = tracker.getPlatformSummary();
      expect(summary.totalCredits).toBe(100);
      expect(summary.developerCredits).toBe(30);
      expect(summary.platformCredits).toBe(70);
      expect(summary.platformPercent).toBe(70);
    });
  });

  // ─── Entries ──────────────────────────────────────────────────────────

  describe('getEntries', () => {
    it('returns recent entries', () => {
      tracker.upsertRule({ id: 'r1', developerId: 'dev-1', tools: [], sharePercent: 50, minCreditsPerCall: 0, active: true });
      for (let i = 0; i < 5; i++) {
        tracker.record('tool', 10, 'key-1');
      }
      expect(tracker.getEntries(3)).toHaveLength(3);
    });

    it('filters by developer', () => {
      tracker.upsertRule({ id: 'r1', developerId: 'dev-1', tools: ['t1'], sharePercent: 50, minCreditsPerCall: 0, active: true });
      tracker.upsertRule({ id: 'r2', developerId: 'dev-2', tools: ['t2'], sharePercent: 50, minCreditsPerCall: 0, active: true });
      tracker.record('t1', 10, 'key-1');
      tracker.record('t2', 10, 'key-2');

      expect(tracker.getEntries(100, 'dev-1')).toHaveLength(1);
    });
  });

  // ─── Stats ────────────────────────────────────────────────────────────

  describe('stats', () => {
    it('tracks revenue stats', () => {
      tracker.upsertRule({ id: 'r1', developerId: 'dev-1', tools: [], sharePercent: 25, minCreditsPerCall: 0, active: true });
      tracker.record('tool', 100, 'key-1');

      const stats = tracker.getStats();
      expect(stats.totalRules).toBe(1);
      expect(stats.uniqueDevelopers).toBe(1);
      expect(stats.totalCredits).toBe(100);
      expect(stats.totalDeveloperCredits).toBe(25);
      expect(stats.totalPlatformCredits).toBe(75);
    });
  });

  // ─── Destroy ──────────────────────────────────────────────────────────

  describe('destroy', () => {
    it('releases all resources', () => {
      tracker.upsertRule({ id: 'r1', developerId: 'd1', tools: [], sharePercent: 20, minCreditsPerCall: 0, active: true });
      tracker.destroy();
      expect(tracker.getRules()).toHaveLength(0);
      expect(tracker.getEntries()).toHaveLength(0);
    });
  });
});
