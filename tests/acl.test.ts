/**
 * Tests for Per-Tool ACL (Access Control Lists).
 * v0.8.0 feature: allowedTools (whitelist) and deniedTools (blacklist) per API key.
 */

import { Gate } from '../src/gate';
import { PayGateConfig, DEFAULT_CONFIG } from '../src/types';

describe('Per-Tool ACL', () => {
  let gate: Gate;
  let config: PayGateConfig;

  beforeEach(() => {
    config = {
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100,
      defaultCreditsPerCall: 1,
    };
    gate = new Gate(config);
  });

  afterEach(() => {
    gate.destroy();
  });

  describe('allowedTools (whitelist)', () => {
    it('should allow calls to whitelisted tools', () => {
      const record = gate.store.createKey('test', 100, {
        allowedTools: ['search', 'generate'],
      });
      const decision = gate.evaluate(record.key, { name: 'search' });
      expect(decision.allowed).toBe(true);
    });

    it('should deny calls to non-whitelisted tools', () => {
      const record = gate.store.createKey('test', 100, {
        allowedTools: ['search', 'generate'],
      });
      const decision = gate.evaluate(record.key, { name: 'delete-all' });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('tool_not_allowed');
      expect(decision.reason).toContain('delete-all');
    });

    it('should allow all tools when allowedTools is empty', () => {
      const record = gate.store.createKey('test', 100, {
        allowedTools: [],
      });
      const d1 = gate.evaluate(record.key, { name: 'anything' });
      expect(d1.allowed).toBe(true);
      const d2 = gate.evaluate(record.key, { name: 'whatever' });
      expect(d2.allowed).toBe(true);
    });

    it('should not charge credits when tool is not allowed', () => {
      const record = gate.store.createKey('test', 100, {
        allowedTools: ['search'],
      });
      gate.evaluate(record.key, { name: 'forbidden-tool' });
      expect(gate.store.getKey(record.key)!.credits).toBe(100);
    });
  });

  describe('deniedTools (blacklist)', () => {
    it('should deny calls to blacklisted tools', () => {
      const record = gate.store.createKey('test', 100, {
        deniedTools: ['dangerous-tool'],
      });
      const decision = gate.evaluate(record.key, { name: 'dangerous-tool' });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('tool_denied');
    });

    it('should allow calls to non-blacklisted tools', () => {
      const record = gate.store.createKey('test', 100, {
        deniedTools: ['dangerous-tool'],
      });
      const decision = gate.evaluate(record.key, { name: 'safe-tool' });
      expect(decision.allowed).toBe(true);
    });

    it('should allow all tools when deniedTools is empty', () => {
      const record = gate.store.createKey('test', 100, {
        deniedTools: [],
      });
      const d1 = gate.evaluate(record.key, { name: 'any-tool' });
      expect(d1.allowed).toBe(true);
    });
  });

  describe('combined whitelist + blacklist', () => {
    it('should deny blacklisted tool even if whitelisted', () => {
      const record = gate.store.createKey('test', 100, {
        allowedTools: ['search', 'generate', 'admin-tool'],
        deniedTools: ['admin-tool'],
      });
      // search is in allowed and not in denied — allowed
      expect(gate.evaluate(record.key, { name: 'search' }).allowed).toBe(true);
      // admin-tool is in both — denied wins
      expect(gate.evaluate(record.key, { name: 'admin-tool' }).allowed).toBe(false);
    });

    it('should deny tool not in whitelist regardless of blacklist', () => {
      const record = gate.store.createKey('test', 100, {
        allowedTools: ['search'],
        deniedTools: ['other-tool'],
      });
      // not in allowed list — denied
      expect(gate.evaluate(record.key, { name: 'unknown' }).allowed).toBe(false);
    });
  });

  describe('setAcl', () => {
    it('should update ACL after key creation', () => {
      const record = gate.store.createKey('test', 100);
      // Initially no ACL — all tools allowed
      expect(gate.evaluate(record.key, { name: 'anything' }).allowed).toBe(true);

      // Set whitelist
      gate.store.setAcl(record.key, ['search']);
      expect(gate.evaluate(record.key, { name: 'search' }).allowed).toBe(true);
      expect(gate.evaluate(record.key, { name: 'other' }).allowed).toBe(false);

      // Clear whitelist
      gate.store.setAcl(record.key, []);
      expect(gate.evaluate(record.key, { name: 'other' }).allowed).toBe(true);
    });

    it('should return false for invalid key', () => {
      expect(gate.store.setAcl('invalid', ['search'])).toBe(false);
    });
  });

  describe('filterToolsForKey', () => {
    const tools = [
      { name: 'search', description: 'Search' },
      { name: 'generate', description: 'Generate' },
      { name: 'delete', description: 'Delete' },
      { name: 'admin', description: 'Admin' },
    ];

    it('should filter by whitelist', () => {
      const record = gate.store.createKey('test', 100, {
        allowedTools: ['search', 'generate'],
      });
      const filtered = gate.filterToolsForKey(record.key, tools);
      expect(filtered).not.toBeNull();
      expect(filtered!.map(t => t.name)).toEqual(['search', 'generate']);
    });

    it('should filter by blacklist', () => {
      const record = gate.store.createKey('test', 100, {
        deniedTools: ['delete', 'admin'],
      });
      const filtered = gate.filterToolsForKey(record.key, tools);
      expect(filtered).not.toBeNull();
      expect(filtered!.map(t => t.name)).toEqual(['search', 'generate']);
    });

    it('should return null when no ACL configured', () => {
      const record = gate.store.createKey('test', 100);
      const filtered = gate.filterToolsForKey(record.key, tools);
      expect(filtered).toBeNull();
    });

    it('should return null when no API key', () => {
      const filtered = gate.filterToolsForKey(null, tools);
      expect(filtered).toBeNull();
    });

    it('should return null for invalid API key', () => {
      const filtered = gate.filterToolsForKey('invalid', tools);
      expect(filtered).toBeNull();
    });
  });

  describe('shadow mode with ACL', () => {
    beforeEach(() => {
      config.shadowMode = true;
      gate.destroy();
      gate = new Gate(config);
    });

    it('should allow but log tool_not_allowed in shadow mode', () => {
      const record = gate.store.createKey('test', 100, {
        allowedTools: ['search'],
      });
      const decision = gate.evaluate(record.key, { name: 'other' });
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toContain('shadow:tool_not_allowed');
    });

    it('should allow but log tool_denied in shadow mode', () => {
      const record = gate.store.createKey('test', 100, {
        deniedTools: ['dangerous'],
      });
      const decision = gate.evaluate(record.key, { name: 'dangerous' });
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toContain('shadow:tool_denied');
    });
  });
});
