import { KeyStore } from '../src/store';
import { existsSync, unlinkSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

/**
 * Persistence tests — verify KeyStore saves/loads state from disk.
 */

function tmpStatePath(): string {
  const dir = join(tmpdir(), 'paygate-test-' + randomBytes(8).toString('hex'));
  mkdirSync(dir, { recursive: true });
  return join(dir, 'state.json');
}

function cleanup(path: string): void {
  try { unlinkSync(path); } catch {}
  try { unlinkSync(path + '.tmp'); } catch {}
}

describe('KeyStore Persistence', () => {

  describe('save and load', () => {
    it('should persist keys to disk after createKey', () => {
      const path = tmpStatePath();
      try {
        const store = new KeyStore(path);
        store.createKey('alice', 100);

        expect(existsSync(path)).toBe(true);
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        expect(raw).toHaveLength(1);
        expect(raw[0][1].name).toBe('alice');
        expect(raw[0][1].credits).toBe(100);
      } finally {
        cleanup(path);
      }
    });

    it('should load keys from disk on construction', () => {
      const path = tmpStatePath();
      try {
        // Create store and add keys
        const store1 = new KeyStore(path);
        const key1 = store1.createKey('alice', 100);
        const key2 = store1.createKey('bob', 200);

        // Create a new store from same file
        const store2 = new KeyStore(path);
        expect(store2.getKey(key1.key)).not.toBeNull();
        expect(store2.getKey(key1.key)!.credits).toBe(100);
        expect(store2.getKey(key2.key)!.credits).toBe(200);
        expect(store2.activeKeyCount).toBe(2);
      } finally {
        cleanup(path);
      }
    });

    it('should persist credit deductions', () => {
      const path = tmpStatePath();
      try {
        const store1 = new KeyStore(path);
        const key = store1.createKey('alice', 100);
        store1.deductCredits(key.key, 30);

        const store2 = new KeyStore(path);
        expect(store2.getKey(key.key)!.credits).toBe(70);
        expect(store2.getKey(key.key)!.totalSpent).toBe(30);
        expect(store2.getKey(key.key)!.totalCalls).toBe(1);
      } finally {
        cleanup(path);
      }
    });

    it('should persist top-ups', () => {
      const path = tmpStatePath();
      try {
        const store1 = new KeyStore(path);
        const key = store1.createKey('alice', 100);
        store1.addCredits(key.key, 50);

        const store2 = new KeyStore(path);
        expect(store2.getKey(key.key)!.credits).toBe(150);
      } finally {
        cleanup(path);
      }
    });

    it('should persist key revocation', () => {
      const path = tmpStatePath();
      try {
        const store1 = new KeyStore(path);
        const key = store1.createKey('alice', 100);
        store1.revokeKey(key.key);

        const store2 = new KeyStore(path);
        expect(store2.getKey(key.key)).toBeNull(); // revoked = inactive
        expect(store2.activeKeyCount).toBe(0);
      } finally {
        cleanup(path);
      }
    });

    it('should persist imported keys', () => {
      const path = tmpStatePath();
      try {
        const store1 = new KeyStore(path);
        store1.importKey('pg_custom_123', 'imported', 999);

        const store2 = new KeyStore(path);
        expect(store2.getKey('pg_custom_123')!.credits).toBe(999);
      } finally {
        cleanup(path);
      }
    });
  });

  describe('no statePath (in-memory mode)', () => {
    it('should work normally without persistence', () => {
      const store = new KeyStore();
      const key = store.createKey('test', 100);
      expect(store.getKey(key.key)!.credits).toBe(100);
    });

    it('should not create any files', () => {
      const store = new KeyStore();
      store.createKey('test', 100);
      // No file created — no way to verify except no crash
    });
  });

  describe('edge cases', () => {
    it('should handle missing state file gracefully', () => {
      const path = join(tmpdir(), 'nonexistent-' + randomBytes(8).toString('hex'), 'state.json');
      const store = new KeyStore(path);
      expect(store.activeKeyCount).toBe(0);
    });

    it('should handle corrupt state file gracefully', () => {
      const path = tmpStatePath();
      try {
        // Write garbage
        const { writeFileSync } = require('fs');
        writeFileSync(path, 'not json!!!', 'utf-8');

        // Should not crash, just start empty
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
        const store = new KeyStore(path);
        expect(store.activeKeyCount).toBe(0);
        consoleSpy.mockRestore();
      } finally {
        cleanup(path);
      }
    });

    it('should handle empty array state file', () => {
      const path = tmpStatePath();
      try {
        const { writeFileSync } = require('fs');
        writeFileSync(path, '[]', 'utf-8');

        const store = new KeyStore(path);
        expect(store.activeKeyCount).toBe(0);
      } finally {
        cleanup(path);
      }
    });

    it('should create parent directories if needed', () => {
      const path = join(tmpdir(), 'paygate-nested-' + randomBytes(8).toString('hex'), 'deep', 'dir', 'state.json');
      try {
        const store = new KeyStore(path);
        store.createKey('test', 100);
        expect(existsSync(path)).toBe(true);
      } finally {
        cleanup(path);
      }
    });

    it('should survive rapid mutations', () => {
      const path = tmpStatePath();
      try {
        const store1 = new KeyStore(path);
        const key = store1.createKey('rapid', 1000);

        for (let i = 0; i < 100; i++) {
          store1.deductCredits(key.key, 1);
        }

        const store2 = new KeyStore(path);
        expect(store2.getKey(key.key)!.credits).toBe(900);
        expect(store2.getKey(key.key)!.totalCalls).toBe(100);
      } finally {
        cleanup(path);
      }
    });
  });
});
