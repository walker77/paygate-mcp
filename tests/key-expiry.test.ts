/**
 * Tests for API Key Expiry (TTL).
 * v0.8.0 feature: keys can have an expiration date.
 */

import { Gate } from '../src/gate';
import { KeyStore } from '../src/store';
import { PayGateConfig, DEFAULT_CONFIG } from '../src/types';

describe('Key Expiry', () => {
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

  describe('store-level expiry', () => {
    it('should create key with expiresAt', () => {
      const future = new Date(Date.now() + 86400000).toISOString(); // +1 day
      const record = gate.store.createKey('test', 100, { expiresAt: future });
      expect(record.expiresAt).toBe(future);
    });

    it('should create key without expiry by default', () => {
      const record = gate.store.createKey('test', 100);
      expect(record.expiresAt).toBeNull();
    });

    it('should return key when not expired', () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      const record = gate.store.createKey('test', 100, { expiresAt: future });
      expect(gate.store.getKey(record.key)).not.toBeNull();
    });

    it('should return null for expired key', () => {
      const past = new Date(Date.now() - 1000).toISOString(); // 1 second ago
      const record = gate.store.createKey('test', 100, { expiresAt: past });
      expect(gate.store.getKey(record.key)).toBeNull();
    });

    it('should still allow getKeyRaw for expired key', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const record = gate.store.createKey('test', 100, { expiresAt: past });
      expect(gate.store.getKeyRaw(record.key)).not.toBeNull();
    });

    it('should correctly detect expired status', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const record = gate.store.createKey('test', 100, { expiresAt: past });
      expect(gate.store.isExpired(record.key)).toBe(true);
    });

    it('should correctly detect non-expired status', () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      const record = gate.store.createKey('test', 100, { expiresAt: future });
      expect(gate.store.isExpired(record.key)).toBe(false);
    });

    it('should report non-expired for keys without expiry', () => {
      const record = gate.store.createKey('test', 100);
      expect(gate.store.isExpired(record.key)).toBe(false);
    });

    it('should report non-expired for non-existent keys', () => {
      expect(gate.store.isExpired('nonexistent')).toBe(false);
    });
  });

  describe('setExpiry', () => {
    it('should set expiry on existing key', () => {
      const record = gate.store.createKey('test', 100);
      expect(record.expiresAt).toBeNull();

      const future = new Date(Date.now() + 86400000).toISOString();
      gate.store.setExpiry(record.key, future);

      const updated = gate.store.getKey(record.key);
      expect(updated!.expiresAt).toBe(future);
    });

    it('should remove expiry when set to null', () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      const record = gate.store.createKey('test', 100, { expiresAt: future });
      expect(record.expiresAt).toBe(future);

      gate.store.setExpiry(record.key, null);
      const updated = gate.store.getKey(record.key);
      expect(updated!.expiresAt).toBeNull();
    });

    it('should allow extending expiry on expired key', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const record = gate.store.createKey('test', 100, { expiresAt: past });

      // Key is expired
      expect(gate.store.getKey(record.key)).toBeNull();

      // Extend it
      const future = new Date(Date.now() + 86400000).toISOString();
      gate.store.setExpiry(record.key, future);

      // Now it should be valid again
      expect(gate.store.getKey(record.key)).not.toBeNull();
    });

    it('should return false for non-existent key', () => {
      expect(gate.store.setExpiry('nonexistent', null)).toBe(false);
    });
  });

  describe('gate-level expiry enforcement', () => {
    it('should deny calls with expired key', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const record = gate.store.createKey('test', 100, { expiresAt: past });
      const decision = gate.evaluate(record.key, { name: 'search' });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('api_key_expired');
    });

    it('should allow calls with non-expired key', () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      const record = gate.store.createKey('test', 100, { expiresAt: future });
      const decision = gate.evaluate(record.key, { name: 'search' });
      expect(decision.allowed).toBe(true);
    });

    it('should not charge credits for expired key', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const record = gate.store.createKey('test', 100, { expiresAt: past });
      gate.evaluate(record.key, { name: 'search' });

      // Check raw record — credits should be untouched
      const raw = gate.store.getKeyRaw(record.key);
      expect(raw!.credits).toBe(100);
    });

    it('should distinguish expired from invalid in deny reason', () => {
      // Expired key
      const past = new Date(Date.now() - 1000).toISOString();
      const record = gate.store.createKey('test', 100, { expiresAt: past });
      const expired = gate.evaluate(record.key, { name: 'search' });
      expect(expired.reason).toBe('api_key_expired');

      // Invalid key
      const invalid = gate.evaluate('pg_nonexistent', { name: 'search' });
      expect(invalid.reason).toBe('invalid_api_key');
    });
  });

  describe('shadow mode with expiry', () => {
    beforeEach(() => {
      config.shadowMode = true;
      gate.destroy();
      gate = new Gate(config);
    });

    it('should allow but log expired key in shadow mode', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const record = gate.store.createKey('test', 100, { expiresAt: past });
      const decision = gate.evaluate(record.key, { name: 'search' });
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('shadow:api_key_expired');
    });
  });

  describe('listKeys with expiry', () => {
    it('should include expired status in key list', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const future = new Date(Date.now() + 86400000).toISOString();

      gate.store.createKey('expired-key', 100, { expiresAt: past });
      gate.store.createKey('valid-key', 100, { expiresAt: future });
      gate.store.createKey('no-expiry', 100);

      const keys = gate.store.listKeys();
      const expiredKey = keys.find(k => k.name === 'expired-key');
      const validKey = keys.find(k => k.name === 'valid-key');
      const noExpiry = keys.find(k => k.name === 'no-expiry');

      expect(expiredKey!.expired).toBe(true);
      expect(validKey!.expired).toBe(false);
      expect(noExpiry!.expired).toBe(false);
    });
  });

  describe('persistence with expiry', () => {
    it('should persist and restore expiry fields', () => {
      const os = require('os');
      const path = require('path');
      const fs = require('fs');

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paygate-test-'));
      const statePath = path.join(tmpDir, 'state.json');

      // Create store with state and add key with expiry
      const store1 = new KeyStore(statePath);
      const future = new Date(Date.now() + 86400000).toISOString();
      const record = store1.createKey('test', 100, {
        allowedTools: ['search'],
        deniedTools: ['admin'],
        expiresAt: future,
      });

      // Create new store from same file
      const store2 = new KeyStore(statePath);
      const restored = store2.getKey(record.key);

      expect(restored).not.toBeNull();
      expect(restored!.allowedTools).toEqual(['search']);
      expect(restored!.deniedTools).toEqual(['admin']);
      expect(restored!.expiresAt).toBe(future);

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true });
    });
  });
});
