/**
 * Tests for Connection-Time Billing.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ConnectionBillingManager } from '../src/connection-billing';

describe('ConnectionBillingManager', () => {
  let mgr: ConnectionBillingManager;

  beforeEach(() => {
    mgr = new ConnectionBillingManager({
      enabled: true,
      creditsPerInterval: 2,
      intervalSeconds: 1, // 1 second intervals for testing
      gracePeriodSeconds: 0,
      billedTransports: ['sse', 'stdio'],
    });
  });

  // ─── Session Lifecycle ────────────────────────────────────────────────

  describe('session lifecycle', () => {
    it('starts a session', () => {
      const id = mgr.startSession('key-1', 'sse');
      expect(id).toMatch(/^conn_/);
      const session = mgr.getSession(id);
      expect(session).not.toBeNull();
      expect(session!.apiKey).toBe('key-1');
      expect(session!.transport).toBe('sse');
      expect(session!.endedAt).toBeNull();
    });

    it('ends a session', () => {
      const id = mgr.startSession('key-1', 'sse');
      const ended = mgr.endSession(id);
      expect(ended).not.toBeNull();
      expect(ended!.endedAt).not.toBeNull();
      expect(mgr.getSession(id)).toBeNull(); // Removed from active
    });

    it('returns null when ending nonexistent session', () => {
      expect(mgr.endSession('nonexistent')).toBeNull();
    });
  });

  // ─── Session Queries ──────────────────────────────────────────────────

  describe('session queries', () => {
    it('lists active sessions', () => {
      mgr.startSession('key-1', 'sse');
      mgr.startSession('key-2', 'stdio');
      expect(mgr.getActiveSessions()).toHaveLength(2);
    });

    it('filters by API key', () => {
      mgr.startSession('key-1', 'sse');
      mgr.startSession('key-1', 'sse');
      mgr.startSession('key-2', 'stdio');
      expect(mgr.getSessionsByKey('key-1')).toHaveLength(2);
    });
  });

  // ─── Billing ──────────────────────────────────────────────────────────

  describe('billing', () => {
    it('bills after interval', async () => {
      const id = mgr.startSession('key-1', 'sse');

      // Wait 1.1 seconds (1 interval)
      await new Promise(r => setTimeout(r, 1100));

      const result = mgr.bill(id);
      expect(result.creditsCharged).toBe(2); // creditsPerInterval = 2
      expect(result.shouldTerminate).toBe(false);
      expect(result.durationSeconds).toBeGreaterThanOrEqual(1);
    });

    it('does not double-bill same interval', async () => {
      const id = mgr.startSession('key-1', 'sse');
      await new Promise(r => setTimeout(r, 1100));

      const r1 = mgr.bill(id);
      expect(r1.creditsCharged).toBe(2);

      // Billing again immediately should charge 0
      const r2 = mgr.bill(id);
      expect(r2.creditsCharged).toBe(0);
    });

    it('bills multiple intervals', async () => {
      const id = mgr.startSession('key-1', 'sse');
      await new Promise(r => setTimeout(r, 2100));

      const result = mgr.bill(id);
      expect(result.creditsCharged).toBe(4); // 2 intervals × 2 credits
    });

    it('skips non-billed transports', () => {
      const id = mgr.startSession('key-1', 'http');
      const result = mgr.bill(id);
      expect(result.creditsCharged).toBe(0);
    });

    it('skips paused sessions', async () => {
      const id = mgr.startSession('key-1', 'sse');
      mgr.pauseSession(id);
      await new Promise(r => setTimeout(r, 1100));

      const result = mgr.bill(id);
      expect(result.creditsCharged).toBe(0);
    });

    it('resumes billing after unpause', async () => {
      const id = mgr.startSession('key-1', 'sse');
      mgr.pauseSession(id);
      await new Promise(r => setTimeout(r, 1100));
      mgr.resumeSession(id);

      const result = mgr.bill(id);
      // Should bill for elapsed intervals even though it was paused
      expect(result.creditsCharged).toBeGreaterThanOrEqual(2);
    });

    it('skips when disabled', async () => {
      mgr.setEnabled(false);
      const id = mgr.startSession('key-1', 'sse');
      await new Promise(r => setTimeout(r, 1100));

      const result = mgr.bill(id);
      expect(result.creditsCharged).toBe(0);
    });
  });

  // ─── Idle Timeout ─────────────────────────────────────────────────────

  describe('idle timeout', () => {
    it('terminates idle sessions', async () => {
      const mgr2 = new ConnectionBillingManager({
        enabled: true,
        creditsPerInterval: 1,
        intervalSeconds: 60,
        idleTimeoutSeconds: 1,
        billedTransports: ['sse'],
      });

      const id = mgr2.startSession('key-1', 'sse');
      await new Promise(r => setTimeout(r, 1100));

      const result = mgr2.bill(id);
      expect(result.shouldTerminate).toBe(true);
      expect(result.terminateReason).toBe('idle_timeout');
    });

    it('resets idle timer on activity', async () => {
      const mgr2 = new ConnectionBillingManager({
        enabled: true,
        creditsPerInterval: 1,
        intervalSeconds: 60,
        idleTimeoutSeconds: 2,
        billedTransports: ['sse'],
      });

      const id = mgr2.startSession('key-1', 'sse');
      await new Promise(r => setTimeout(r, 1000));
      mgr2.recordActivity(id);
      await new Promise(r => setTimeout(r, 1000));

      const result = mgr2.bill(id);
      expect(result.shouldTerminate).toBe(false);
    });
  });

  // ─── Max Duration ─────────────────────────────────────────────────────

  describe('max duration', () => {
    it('terminates sessions at max duration', async () => {
      const mgr2 = new ConnectionBillingManager({
        enabled: true,
        creditsPerInterval: 1,
        intervalSeconds: 60,
        maxDurationSeconds: 1,
        billedTransports: ['sse'],
      });

      const id = mgr2.startSession('key-1', 'sse');
      await new Promise(r => setTimeout(r, 1100));

      const result = mgr2.bill(id);
      expect(result.shouldTerminate).toBe(true);
      expect(result.terminateReason).toBe('max_duration');
    });
  });

  // ─── Credit Check ─────────────────────────────────────────────────────

  describe('credit check callback', () => {
    it('terminates when insufficient credits', async () => {
      const id = mgr.startSession('key-1', 'sse');
      await new Promise(r => setTimeout(r, 1100));

      const result = mgr.bill(id, () => 0); // No credits
      expect(result.shouldTerminate).toBe(true);
      expect(result.terminateReason).toBe('insufficient_credits');
    });

    it('bills when sufficient credits', async () => {
      const id = mgr.startSession('key-1', 'sse');
      await new Promise(r => setTimeout(r, 1100));

      const result = mgr.bill(id, () => 100); // Plenty of credits
      expect(result.creditsCharged).toBe(2);
      expect(result.shouldTerminate).toBe(false);
    });
  });

  // ─── Grace Period ─────────────────────────────────────────────────────

  describe('grace period', () => {
    it('does not bill during grace period', async () => {
      const mgr2 = new ConnectionBillingManager({
        enabled: true,
        creditsPerInterval: 1,
        intervalSeconds: 1,
        gracePeriodSeconds: 2,
        billedTransports: ['sse'],
      });

      const id = mgr2.startSession('key-1', 'sse');
      await new Promise(r => setTimeout(r, 1100));

      const result = mgr2.bill(id);
      expect(result.creditsCharged).toBe(0); // Still in grace period
    });
  });

  // ─── Bill All ─────────────────────────────────────────────────────────

  describe('billAll', () => {
    it('bills all active sessions', async () => {
      mgr.startSession('key-1', 'sse');
      mgr.startSession('key-2', 'sse');
      await new Promise(r => setTimeout(r, 1100));

      const results = mgr.billAll();
      expect(results).toHaveLength(2);
      expect(results[0].result.creditsCharged).toBe(2);
      expect(results[1].result.creditsCharged).toBe(2);
    });
  });

  // ─── Cost Estimation ──────────────────────────────────────────────────

  describe('estimateCost', () => {
    it('estimates connection cost', () => {
      const cost = mgr.estimateCost('key-1', 5); // 5 minutes
      // 5 minutes = 300 seconds / 1 second interval = 300 intervals × 2 credits
      expect(cost).toBe(600);
    });
  });

  // ─── Stats ────────────────────────────────────────────────────────────

  describe('stats', () => {
    it('tracks billing stats', async () => {
      const id = mgr.startSession('key-1', 'sse');
      await new Promise(r => setTimeout(r, 1100));
      mgr.bill(id);

      const stats = mgr.getStats();
      expect(stats.activeSessions).toBe(1);
      expect(stats.totalSessions).toBe(1);
      expect(stats.totalCreditsBilled).toBe(2);
    });
  });

  // ─── Destroy ──────────────────────────────────────────────────────────

  describe('destroy', () => {
    it('releases all resources', () => {
      mgr.startSession('key-1', 'sse');
      mgr.destroy();
      expect(mgr.getActiveSessions()).toHaveLength(0);
      expect(mgr.getStats().totalSessions).toBe(0);
    });
  });
});
