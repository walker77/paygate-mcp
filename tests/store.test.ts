import { KeyStore } from '../src/store';

describe('KeyStore', () => {
  let store: KeyStore;

  beforeEach(() => {
    store = new KeyStore();
  });

  describe('createKey', () => {
    it('should create a key with pg_ prefix', () => {
      const record = store.createKey('test', 100);
      expect(record.key).toMatch(/^pg_[a-f0-9]{48}$/);
    });

    it('should set initial credits', () => {
      const record = store.createKey('test', 500);
      expect(record.credits).toBe(500);
      expect(record.name).toBe('test');
      expect(record.active).toBe(true);
      expect(record.totalSpent).toBe(0);
      expect(record.totalCalls).toBe(0);
    });

    it('should create unique keys', () => {
      const k1 = store.createKey('a', 10);
      const k2 = store.createKey('b', 10);
      expect(k1.key).not.toBe(k2.key);
    });
  });

  describe('getKey', () => {
    it('should return key record for valid key', () => {
      const created = store.createKey('test', 100);
      const found = store.getKey(created.key);
      expect(found).not.toBeNull();
      expect(found!.name).toBe('test');
    });

    it('should return null for unknown key', () => {
      expect(store.getKey('pg_nonexistent')).toBeNull();
    });

    it('should return null for revoked key', () => {
      const record = store.createKey('test', 100);
      store.revokeKey(record.key);
      expect(store.getKey(record.key)).toBeNull();
    });
  });

  describe('hasCredits', () => {
    it('should return true when sufficient', () => {
      const record = store.createKey('test', 100);
      expect(store.hasCredits(record.key, 50)).toBe(true);
      expect(store.hasCredits(record.key, 100)).toBe(true);
    });

    it('should return false when insufficient', () => {
      const record = store.createKey('test', 10);
      expect(store.hasCredits(record.key, 11)).toBe(false);
    });

    it('should return false for unknown key', () => {
      expect(store.hasCredits('pg_fake', 1)).toBe(false);
    });
  });

  describe('deductCredits', () => {
    it('should deduct and track usage', () => {
      const record = store.createKey('test', 100);
      const result = store.deductCredits(record.key, 10);
      expect(result).toBe(true);

      const updated = store.getKey(record.key)!;
      expect(updated.credits).toBe(90);
      expect(updated.totalSpent).toBe(10);
      expect(updated.totalCalls).toBe(1);
      expect(updated.lastUsedAt).not.toBeNull();
    });

    it('should fail if insufficient credits', () => {
      const record = store.createKey('test', 5);
      expect(store.deductCredits(record.key, 10)).toBe(false);
      expect(store.getKey(record.key)!.credits).toBe(5);
    });
  });

  describe('addCredits', () => {
    it('should add credits (top-up)', () => {
      const record = store.createKey('test', 100);
      store.addCredits(record.key, 50);
      expect(store.getKey(record.key)!.credits).toBe(150);
    });

    it('should return false for unknown key', () => {
      expect(store.addCredits('pg_fake', 50)).toBe(false);
    });

    it('should reject negative credit amounts', () => {
      const record = store.createKey('test', 100);
      expect(store.addCredits(record.key, -50)).toBe(false);
      expect(store.getKey(record.key)!.credits).toBe(100); // unchanged
    });

    it('should reject zero credit amounts', () => {
      const record = store.createKey('test', 100);
      expect(store.addCredits(record.key, 0)).toBe(false);
      expect(store.getKey(record.key)!.credits).toBe(100);
    });
  });

  describe('input sanitization', () => {
    it('should floor float credits to integers', () => {
      const record = store.createKey('test', 10.7);
      expect(record.credits).toBe(10);
    });

    it('should clamp negative initial credits to 0', () => {
      const record = store.createKey('test', -50);
      expect(record.credits).toBe(0);
    });

    it('should truncate long names to 200 chars', () => {
      const record = store.createKey('A'.repeat(500), 10);
      expect(record.name.length).toBe(200);
    });
  });

  describe('listKeys', () => {
    it('should mask key values', () => {
      store.createKey('alpha', 100);
      store.createKey('beta', 200);

      const list = store.listKeys();
      expect(list).toHaveLength(2);
      expect(list[0].keyPrefix).toMatch(/^pg_[a-f0-9]{7}\.\.\.$/);
      expect((list[0] as any).key).toBeUndefined();
    });
  });

  describe('activeKeyCount', () => {
    it('should count only active keys', () => {
      const k1 = store.createKey('a', 10);
      store.createKey('b', 10);
      expect(store.activeKeyCount).toBe(2);

      store.revokeKey(k1.key);
      expect(store.activeKeyCount).toBe(1);
    });
  });

  describe('importKey', () => {
    it('should import a pre-existing key', () => {
      const record = store.importKey('pg_custom_key_123', 'imported', 999);
      expect(record.key).toBe('pg_custom_key_123');
      expect(store.getKey('pg_custom_key_123')!.credits).toBe(999);
    });
  });
});
