/**
 * Tests for Sandbox Mode — Try-Before-Buy.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { SandboxManager } from '../src/sandbox';

describe('SandboxManager', () => {
  let mgr: SandboxManager;

  beforeEach(() => {
    mgr = new SandboxManager({ enabled: true });
  });

  // ─── Policy Management ────────────────────────────────────────────────

  describe('policy management', () => {
    it('creates a policy', () => {
      const ok = mgr.upsertPolicy({
        id: 'trial',
        name: 'Free Trial',
        maxCalls: 10,
        windowSeconds: 3600,
        allowedTools: [],
        deniedTools: [],
        realResponses: true,
        active: true,
      });
      expect(ok).toBe(true);
      expect(mgr.getPolicy('trial')).not.toBeNull();
    });

    it('removes a policy', () => {
      mgr.upsertPolicy({ id: 'trial', name: 'Trial', maxCalls: 10, windowSeconds: 0, allowedTools: [], deniedTools: [], realResponses: true, active: true });
      expect(mgr.removePolicy('trial')).toBe(true);
      expect(mgr.getPolicy('trial')).toBeNull();
    });

    it('lists all policies', () => {
      mgr.upsertPolicy({ id: 'p1', name: 'P1', maxCalls: 5, windowSeconds: 0, allowedTools: [], deniedTools: [], realResponses: true, active: true });
      mgr.upsertPolicy({ id: 'p2', name: 'P2', maxCalls: 10, windowSeconds: 0, allowedTools: [], deniedTools: [], realResponses: true, active: true });
      expect(mgr.getPolicies()).toHaveLength(2);
    });
  });

  // ─── Key Assignment ───────────────────────────────────────────────────

  describe('key assignment', () => {
    beforeEach(() => {
      mgr.upsertPolicy({ id: 'trial', name: 'Trial', maxCalls: 5, windowSeconds: 0, allowedTools: [], deniedTools: [], realResponses: true, active: true });
    });

    it('assigns policy to key', () => {
      expect(mgr.assignPolicy('key-1', 'trial')).toBe(true);
      expect(mgr.getKeyPolicy('key-1')?.id).toBe('trial');
    });

    it('rejects assignment to nonexistent policy', () => {
      expect(mgr.assignPolicy('key-1', 'nonexistent')).toBe(false);
    });

    it('unassigns policy from key', () => {
      mgr.assignPolicy('key-1', 'trial');
      mgr.unassignPolicy('key-1');
      expect(mgr.getKeyPolicy('key-1')).toBeNull();
    });
  });

  // ─── Sandbox Checks ──────────────────────────────────────────────────

  describe('check', () => {
    beforeEach(() => {
      mgr.upsertPolicy({ id: 'trial', name: 'Trial', maxCalls: 3, windowSeconds: 0, allowedTools: [], deniedTools: ['dangerous'], realResponses: true, active: true });
      mgr.assignPolicy('key-1', 'trial');
    });

    it('allows sandbox call', () => {
      const result = mgr.check('key-1', 'readFile');
      expect(result.allowed).toBe(true);
      expect(result.isSandbox).toBe(true);
      expect(result.remaining).toBe(2);
    });

    it('denies denied tools', () => {
      const result = mgr.check('key-1', 'dangerous');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('tool_denied_in_sandbox');
    });

    it('enforces call limit', () => {
      mgr.check('key-1', 'tool1'); mgr.record('key-1', 'tool1');
      mgr.check('key-1', 'tool1'); mgr.record('key-1', 'tool1');
      mgr.check('key-1', 'tool1'); mgr.record('key-1', 'tool1');
      const result = mgr.check('key-1', 'tool1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('sandbox_limit_exceeded');
    });

    it('returns non-sandbox for keys without policy', () => {
      const result = mgr.check('key-no-policy', 'tool1');
      expect(result.isSandbox).toBe(false);
      expect(result.allowed).toBe(false);
    });

    it('returns non-sandbox when disabled', () => {
      mgr.setEnabled(false);
      const result = mgr.check('key-1', 'tool1');
      expect(result.isSandbox).toBe(false);
    });
  });

  // ─── Tool Filtering ──────────────────────────────────────────────────

  describe('tool filtering', () => {
    it('restricts to allowed tools', () => {
      mgr.upsertPolicy({ id: 'restricted', name: 'R', maxCalls: 10, windowSeconds: 0, allowedTools: ['readFile', 'listFiles'], deniedTools: [], realResponses: true, active: true });
      mgr.assignPolicy('key-1', 'restricted');

      expect(mgr.check('key-1', 'readFile').allowed).toBe(true);
      expect(mgr.check('key-1', 'deleteFile').allowed).toBe(false);
      expect(mgr.check('key-1', 'deleteFile').reason).toBe('tool_not_in_sandbox');
    });
  });

  // ─── Window Reset ─────────────────────────────────────────────────────

  describe('window reset', () => {
    it('resets call count after window expires', async () => {
      mgr.upsertPolicy({ id: 'windowed', name: 'W', maxCalls: 2, windowSeconds: 1, allowedTools: [], deniedTools: [], realResponses: true, active: true });
      mgr.assignPolicy('key-1', 'windowed');

      // Use up calls
      mgr.check('key-1', 'tool'); mgr.record('key-1', 'tool');
      mgr.check('key-1', 'tool'); mgr.record('key-1', 'tool');
      expect(mgr.check('key-1', 'tool').allowed).toBe(false);

      // Wait for window to expire
      await new Promise(r => setTimeout(r, 1100));

      // Should be allowed again
      expect(mgr.check('key-1', 'tool').allowed).toBe(true);
    });
  });

  // ─── Mock Responses ───────────────────────────────────────────────────

  describe('mock responses', () => {
    it('returns mock response for non-real policy', () => {
      mgr.upsertPolicy({
        id: 'mock', name: 'Mock', maxCalls: 10, windowSeconds: 0,
        allowedTools: [], deniedTools: [], realResponses: false,
        mockResponse: { result: 'preview' }, active: true,
      });
      const mock = mgr.getMockResponse('mock');
      expect(mock).toEqual({ result: 'preview' });
    });

    it('returns null for real-response policy', () => {
      mgr.upsertPolicy({ id: 'real', name: 'R', maxCalls: 10, windowSeconds: 0, allowedTools: [], deniedTools: [], realResponses: true, active: true });
      expect(mgr.getMockResponse('real')).toBeNull();
    });
  });

  // ─── Usage Tracking ───────────────────────────────────────────────────

  describe('usage tracking', () => {
    it('tracks per-tool usage', () => {
      mgr.upsertPolicy({ id: 'trial', name: 'T', maxCalls: 100, windowSeconds: 0, allowedTools: [], deniedTools: [], realResponses: true, active: true });
      mgr.assignPolicy('key-1', 'trial');

      mgr.check('key-1', 'readFile'); mgr.record('key-1', 'readFile');
      mgr.check('key-1', 'readFile'); mgr.record('key-1', 'readFile');
      mgr.check('key-1', 'writeFile'); mgr.record('key-1', 'writeFile');

      const usage = mgr.getUsage('key-1');
      expect(usage).not.toBeNull();
      expect(usage!.totalCalls).toBe(3);
      expect(usage!.toolCalls['readFile']).toBe(2);
      expect(usage!.toolCalls['writeFile']).toBe(1);
    });

    it('resets usage', () => {
      mgr.upsertPolicy({ id: 'trial', name: 'T', maxCalls: 100, windowSeconds: 0, allowedTools: [], deniedTools: [], realResponses: true, active: true });
      mgr.assignPolicy('key-1', 'trial');
      mgr.check('key-1', 'tool'); mgr.record('key-1', 'tool');
      mgr.resetUsage('key-1');
      expect(mgr.getUsage('key-1')).toBeNull();
    });
  });

  // ─── Export/Import ────────────────────────────────────────────────────

  describe('export/import', () => {
    it('round-trips state', () => {
      mgr.upsertPolicy({ id: 'trial', name: 'T', maxCalls: 10, windowSeconds: 0, allowedTools: [], deniedTools: [], realResponses: true, active: true });
      mgr.assignPolicy('key-1', 'trial');
      mgr.check('key-1', 'tool'); mgr.record('key-1', 'tool');

      const state = mgr.exportState();
      const mgr2 = new SandboxManager();
      mgr2.importState(state);

      expect(mgr2.getPolicy('trial')).not.toBeNull();
      expect(mgr2.getKeyPolicy('key-1')?.id).toBe('trial');
      expect(mgr2.getUsage('key-1')?.totalCalls).toBe(1);
    });
  });

  // ─── Default Policy ───────────────────────────────────────────────────

  describe('default policy', () => {
    it('applies default policy to unassigned keys', () => {
      mgr.upsertPolicy({ id: 'default-trial', name: 'Default', maxCalls: 5, windowSeconds: 0, allowedTools: [], deniedTools: [], realResponses: true, active: true });
      const mgr2 = new SandboxManager({ enabled: true, defaultPolicyId: 'default-trial' });
      mgr2.upsertPolicy({ id: 'default-trial', name: 'Default', maxCalls: 5, windowSeconds: 0, allowedTools: [], deniedTools: [], realResponses: true, active: true });

      const result = mgr2.check('any-key', 'tool');
      expect(result.isSandbox).toBe(true);
      expect(result.allowed).toBe(true);
    });
  });

  // ─── Stats ────────────────────────────────────────────────────────────

  describe('stats', () => {
    it('tracks sandbox stats', () => {
      mgr.upsertPolicy({ id: 'trial', name: 'T', maxCalls: 10, windowSeconds: 0, allowedTools: [], deniedTools: [], realResponses: true, active: true });
      mgr.assignPolicy('key-1', 'trial');
      mgr.check('key-1', 'tool'); mgr.record('key-1', 'tool');

      const stats = mgr.getStats();
      expect(stats.totalPolicies).toBe(1);
      expect(stats.activePolicies).toBe(1);
      expect(stats.totalSandboxCalls).toBe(1);
    });
  });

  // ─── Destroy ──────────────────────────────────────────────────────────

  describe('destroy', () => {
    it('releases all resources', () => {
      mgr.upsertPolicy({ id: 'trial', name: 'T', maxCalls: 10, windowSeconds: 0, allowedTools: [], deniedTools: [], realResponses: true, active: true });
      mgr.destroy();
      expect(mgr.getStats().totalPolicies).toBe(0);
    });
  });
});
