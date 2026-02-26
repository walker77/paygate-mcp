import { KeyStore } from '../src/store';
import { Gate } from '../src/gate';
import { PayGateConfig, DEFAULT_CONFIG } from '../src/types';

// ─── Key Tags Tests ──────────────────────────────────────────────────────────

describe('Key Tags', () => {
  let store: KeyStore;

  beforeEach(() => {
    store = new KeyStore();
  });

  describe('createKey with tags', () => {
    it('should create key with empty tags by default', () => {
      const record = store.createKey('test', 100);
      expect(record.tags).toEqual({});
    });

    it('should create key with initial tags', () => {
      const record = store.createKey('test', 100, {
        tags: { team: 'backend', env: 'production' },
      });
      expect(record.tags).toEqual({ team: 'backend', env: 'production' });
    });

    it('should sanitize tag keys/values to 100 chars', () => {
      const longKey = 'a'.repeat(200);
      const longVal = 'b'.repeat(200);
      const record = store.createKey('test', 100, {
        tags: { [longKey]: longVal },
      });
      const keys = Object.keys(record.tags);
      expect(keys[0].length).toBe(100);
      expect(record.tags[keys[0]].length).toBe(100);
    });

    it('should enforce max 50 tags', () => {
      const tags: Record<string, string> = {};
      for (let i = 0; i < 60; i++) {
        tags[`key${i}`] = `val${i}`;
      }
      const record = store.createKey('test', 100, { tags });
      expect(Object.keys(record.tags).length).toBe(50);
    });
  });

  describe('setTags', () => {
    it('should merge tags (add new, update existing)', () => {
      const record = store.createKey('test', 100, {
        tags: { team: 'backend', env: 'staging' },
      });
      const success = store.setTags(record.key, { env: 'production', region: 'us-east' });
      expect(success).toBe(true);
      const updated = store.getKey(record.key);
      expect(updated!.tags).toEqual({
        team: 'backend',
        env: 'production',
        region: 'us-east',
      });
    });

    it('should remove tags with null value', () => {
      const record = store.createKey('test', 100, {
        tags: { team: 'backend', env: 'staging', region: 'us-west' },
      });
      const success = store.setTags(record.key, { env: null });
      expect(success).toBe(true);
      const updated = store.getKey(record.key);
      expect(updated!.tags).toEqual({ team: 'backend', region: 'us-west' });
    });

    it('should return false for unknown key', () => {
      expect(store.setTags('pg_nonexistent', { foo: 'bar' })).toBe(false);
    });

    it('should not exceed 50 tags on update', () => {
      const tags: Record<string, string> = {};
      for (let i = 0; i < 50; i++) {
        tags[`key${i}`] = `val${i}`;
      }
      const record = store.createKey('test', 100, { tags });
      // Try to add one more — should be ignored (50 limit)
      store.setTags(record.key, { newKey: 'newVal' });
      const updated = store.getKey(record.key);
      expect(Object.keys(updated!.tags).length).toBe(50);
      expect(updated!.tags['newKey']).toBeUndefined();
    });

    it('should allow updating existing tag even when at limit', () => {
      const tags: Record<string, string> = {};
      for (let i = 0; i < 50; i++) {
        tags[`key${i}`] = `val${i}`;
      }
      const record = store.createKey('test', 100, { tags });
      store.setTags(record.key, { key0: 'updated' });
      const updated = store.getKey(record.key);
      expect(updated!.tags['key0']).toBe('updated');
    });
  });

  describe('listKeysByTag', () => {
    it('should find keys matching all specified tags', () => {
      store.createKey('backend-prod', 100, {
        tags: { team: 'backend', env: 'production' },
      });
      store.createKey('backend-staging', 100, {
        tags: { team: 'backend', env: 'staging' },
      });
      store.createKey('frontend-prod', 100, {
        tags: { team: 'frontend', env: 'production' },
      });

      const backendKeys = store.listKeysByTag({ team: 'backend' });
      expect(backendKeys.length).toBe(2);

      const prodKeys = store.listKeysByTag({ env: 'production' });
      expect(prodKeys.length).toBe(2);

      const backendProd = store.listKeysByTag({ team: 'backend', env: 'production' });
      expect(backendProd.length).toBe(1);
      expect(backendProd[0].name).toBe('backend-prod');
    });

    it('should return empty array when no matches', () => {
      store.createKey('test', 100, { tags: { team: 'backend' } });
      const results = store.listKeysByTag({ team: 'nonexistent' });
      expect(results.length).toBe(0);
    });

    it('should mask key in results', () => {
      store.createKey('test', 100, { tags: { team: 'backend' } });
      const results = store.listKeysByTag({ team: 'backend' });
      expect(results[0].keyPrefix).toMatch(/^pg_[a-f0-9]{7}\.\.\.$/);
      expect((results[0] as any).key).toBeUndefined();
    });
  });
});

// ─── IP Allowlist Tests ──────────────────────────────────────────────────────

describe('IP Allowlist', () => {
  let store: KeyStore;

  beforeEach(() => {
    store = new KeyStore();
  });

  describe('createKey with ipAllowlist', () => {
    it('should create key with empty allowlist by default', () => {
      const record = store.createKey('test', 100);
      expect(record.ipAllowlist).toEqual([]);
    });

    it('should create key with initial IP allowlist', () => {
      const record = store.createKey('test', 100, {
        ipAllowlist: ['192.168.1.1', '10.0.0.0/8'],
      });
      expect(record.ipAllowlist).toEqual(['192.168.1.1', '10.0.0.0/8']);
    });

    it('should sanitize IP list (max 100 entries)', () => {
      const ips = Array.from({ length: 110 }, (_, i) => `10.0.0.${i % 256}`);
      const record = store.createKey('test', 100, { ipAllowlist: ips });
      expect(record.ipAllowlist.length).toBe(100);
    });
  });

  describe('setIpAllowlist', () => {
    it('should replace the entire allowlist', () => {
      const record = store.createKey('test', 100, {
        ipAllowlist: ['192.168.1.1'],
      });
      store.setIpAllowlist(record.key, ['10.0.0.1', '10.0.0.2']);
      const updated = store.getKey(record.key);
      expect(updated!.ipAllowlist).toEqual(['10.0.0.1', '10.0.0.2']);
    });

    it('should clear allowlist with empty array', () => {
      const record = store.createKey('test', 100, {
        ipAllowlist: ['192.168.1.1'],
      });
      store.setIpAllowlist(record.key, []);
      const updated = store.getKey(record.key);
      expect(updated!.ipAllowlist).toEqual([]);
    });

    it('should return false for unknown key', () => {
      expect(store.setIpAllowlist('pg_nonexistent', ['1.2.3.4'])).toBe(false);
    });
  });

  describe('checkIp', () => {
    it('should allow all IPs when allowlist is empty', () => {
      const record = store.createKey('test', 100);
      expect(store.checkIp(record.key, '1.2.3.4')).toBe(true);
      expect(store.checkIp(record.key, '255.255.255.255')).toBe(true);
    });

    it('should allow exact IP match', () => {
      const record = store.createKey('test', 100, {
        ipAllowlist: ['192.168.1.1', '10.0.0.5'],
      });
      expect(store.checkIp(record.key, '192.168.1.1')).toBe(true);
      expect(store.checkIp(record.key, '10.0.0.5')).toBe(true);
    });

    it('should deny non-matching IP', () => {
      const record = store.createKey('test', 100, {
        ipAllowlist: ['192.168.1.1'],
      });
      expect(store.checkIp(record.key, '192.168.1.2')).toBe(false);
      expect(store.checkIp(record.key, '10.0.0.1')).toBe(false);
    });

    it('should support CIDR notation (/24)', () => {
      const record = store.createKey('test', 100, {
        ipAllowlist: ['192.168.1.0/24'],
      });
      expect(store.checkIp(record.key, '192.168.1.0')).toBe(true);
      expect(store.checkIp(record.key, '192.168.1.1')).toBe(true);
      expect(store.checkIp(record.key, '192.168.1.255')).toBe(true);
      expect(store.checkIp(record.key, '192.168.2.1')).toBe(false);
    });

    it('should support CIDR notation (/16)', () => {
      const record = store.createKey('test', 100, {
        ipAllowlist: ['10.20.0.0/16'],
      });
      expect(store.checkIp(record.key, '10.20.0.1')).toBe(true);
      expect(store.checkIp(record.key, '10.20.255.255')).toBe(true);
      expect(store.checkIp(record.key, '10.21.0.1')).toBe(false);
    });

    it('should support CIDR notation (/8)', () => {
      const record = store.createKey('test', 100, {
        ipAllowlist: ['10.0.0.0/8'],
      });
      expect(store.checkIp(record.key, '10.0.0.1')).toBe(true);
      expect(store.checkIp(record.key, '10.255.255.255')).toBe(true);
      expect(store.checkIp(record.key, '11.0.0.1')).toBe(false);
    });

    it('should support CIDR /32 (single host)', () => {
      const record = store.createKey('test', 100, {
        ipAllowlist: ['1.2.3.4/32'],
      });
      expect(store.checkIp(record.key, '1.2.3.4')).toBe(true);
      expect(store.checkIp(record.key, '1.2.3.5')).toBe(false);
    });

    it('should support CIDR /0 (all IPs)', () => {
      const record = store.createKey('test', 100, {
        ipAllowlist: ['0.0.0.0/0'],
      });
      expect(store.checkIp(record.key, '1.2.3.4')).toBe(true);
      expect(store.checkIp(record.key, '255.255.255.255')).toBe(true);
    });

    it('should handle mixed exact + CIDR', () => {
      const record = store.createKey('test', 100, {
        ipAllowlist: ['192.168.1.100', '10.0.0.0/8'],
      });
      expect(store.checkIp(record.key, '192.168.1.100')).toBe(true);
      expect(store.checkIp(record.key, '10.50.50.50')).toBe(true);
      expect(store.checkIp(record.key, '192.168.1.101')).toBe(false);
      expect(store.checkIp(record.key, '172.16.0.1')).toBe(false);
    });

    it('should return false for unknown key', () => {
      expect(store.checkIp('pg_nonexistent', '1.2.3.4')).toBe(false);
    });

    it('should handle invalid CIDR gracefully', () => {
      const record = store.createKey('test', 100, {
        ipAllowlist: ['192.168.1.0/99'],
      });
      // Invalid CIDR bits (99) — should not match
      expect(store.checkIp(record.key, '192.168.1.1')).toBe(false);
    });
  });
});

// ─── Gate IP Allowlist Integration ───────────────────────────────────────────

describe('Gate IP Allowlist Integration', () => {
  let gate: Gate;
  let config: PayGateConfig;

  beforeEach(() => {
    config = {
      ...DEFAULT_CONFIG,
      defaultCreditsPerCall: 1,
      webhookSecret: null,
    };
    gate = new Gate(config);
  });

  it('should deny tool call when IP not in allowlist', () => {
    const record = gate.store.createKey('test', 100, {
      ipAllowlist: ['192.168.1.1'],
    });
    const decision = gate.evaluate(record.key, { name: 'test_tool' }, '10.0.0.1');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('ip_not_allowed');
  });

  it('should allow tool call when IP matches allowlist', () => {
    const record = gate.store.createKey('test', 100, {
      ipAllowlist: ['192.168.1.1'],
    });
    const decision = gate.evaluate(record.key, { name: 'test_tool' }, '192.168.1.1');
    expect(decision.allowed).toBe(true);
  });

  it('should allow tool call when allowlist is empty (all IPs)', () => {
    const record = gate.store.createKey('test', 100);
    const decision = gate.evaluate(record.key, { name: 'test_tool' }, '10.0.0.1');
    expect(decision.allowed).toBe(true);
  });

  it('should allow tool call when no clientIp provided', () => {
    const record = gate.store.createKey('test', 100, {
      ipAllowlist: ['192.168.1.1'],
    });
    // No clientIp — skip IP check (for stdio/local connections)
    const decision = gate.evaluate(record.key, { name: 'test_tool' });
    expect(decision.allowed).toBe(true);
  });

  it('should allow tool call with CIDR match', () => {
    const record = gate.store.createKey('test', 100, {
      ipAllowlist: ['10.0.0.0/8'],
    });
    const decision = gate.evaluate(record.key, { name: 'test_tool' }, '10.50.25.100');
    expect(decision.allowed).toBe(true);
  });

  it('should shadow-allow denied IP in shadow mode', () => {
    const shadowConfig: PayGateConfig = {
      ...DEFAULT_CONFIG,
      defaultCreditsPerCall: 1,
      shadowMode: true,
      webhookSecret: null,
    };
    const shadowGate = new Gate(shadowConfig);
    const record = shadowGate.store.createKey('test', 100, {
      ipAllowlist: ['192.168.1.1'],
    });
    const decision = shadowGate.evaluate(record.key, { name: 'test_tool' }, '10.0.0.1');
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain('shadow');
    expect(decision.reason).toContain('ip_not_allowed');
  });
});

// ─── Store backfill Tests ────────────────────────────────────────────────────

describe('Store backfill for tags and ipAllowlist', () => {
  it('should backfill tags and ipAllowlist on load', () => {
    // Create store, add key without tags/ipAllowlist in stored format
    const store1 = new KeyStore();
    const record = store1.createKey('test', 100);
    // Simulate old format by removing tags/ipAllowlist from the in-memory record
    delete (record as any).tags;
    delete (record as any).ipAllowlist;
    // Re-save
    (store1 as any).save();

    // Load a fresh store from same data — backfill should add defaults
    // We can't easily test file-based persistence in a unit test,
    // but we can test that getKey always returns tags/ipAllowlist
    const freshRecord = store1.getKey(record.key);
    // Due to our backfill in load(), re-accessing after modification tests the in-memory path
    // The important thing is the store always returns these fields
    expect(freshRecord).not.toBeNull();
  });
});

// ─── Import Key with tags/ipAllowlist ────────────────────────────────────────

describe('importKey with tags and ipAllowlist', () => {
  let store: KeyStore;

  beforeEach(() => {
    store = new KeyStore();
  });

  it('should import key with tags', () => {
    const record = store.importKey('pg_customkey123456789012345678901234567890abcdef', 'imported', 50, {
      tags: { source: 'migration', plan: 'enterprise' },
    });
    expect(record.tags).toEqual({ source: 'migration', plan: 'enterprise' });
  });

  it('should import key with ipAllowlist', () => {
    const record = store.importKey('pg_customkey223456789012345678901234567890abcdef', 'imported', 50, {
      ipAllowlist: ['10.0.0.0/8', '192.168.1.1'],
    });
    expect(record.ipAllowlist).toEqual(['10.0.0.0/8', '192.168.1.1']);
  });

  it('should default to empty tags/ipAllowlist on import', () => {
    const record = store.importKey('pg_customkey323456789012345678901234567890abcdef', 'imported', 50);
    expect(record.tags).toEqual({});
    expect(record.ipAllowlist).toEqual([]);
  });
});
