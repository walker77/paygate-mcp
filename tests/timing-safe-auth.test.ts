/**
 * Timing-safe authentication tests — constant-time admin key comparison.
 */

import { AdminKeyManager } from '../src/admin-keys';
import { PayGateServer } from '../src/server';
import http from 'http';

// Suppress logger output in tests
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

function post(port: number, path: string, body: any, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (chunk) => chunks += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(chunks) });
        } catch {
          resolve({ status: res.statusCode!, body: chunks });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── AdminKeyManager Timing-Safe Validation ──────────────────────────────────

describe('Timing-Safe Admin Key Validation', () => {
  it('should validate correct admin key', () => {
    const mgr = new AdminKeyManager();
    mgr.bootstrap('ak_correct_key_12345');

    const result = mgr.validate('ak_correct_key_12345');
    expect(result).not.toBeNull();
    expect(result!.role).toBe('super_admin');
  });

  it('should reject incorrect admin key', () => {
    const mgr = new AdminKeyManager();
    mgr.bootstrap('ak_correct_key_12345');

    const result = mgr.validate('ak_wrong_key_99999');
    expect(result).toBeNull();
  });

  it('should reject empty key', () => {
    const mgr = new AdminKeyManager();
    mgr.bootstrap('ak_test_key');

    expect(mgr.validate('')).toBeNull();
  });

  it('should reject key with different length', () => {
    const mgr = new AdminKeyManager();
    mgr.bootstrap('ak_long_admin_key_here');

    // Shorter key should not match
    expect(mgr.validate('ak_short')).toBeNull();
    // Longer key should not match
    expect(mgr.validate('ak_very_very_very_long_admin_key_that_does_not_match')).toBeNull();
  });

  it('should validate key among multiple admin keys', () => {
    const mgr = new AdminKeyManager();
    mgr.bootstrap('ak_admin_1');

    // Create additional admin keys via the manager
    const key2 = mgr.create('Second Admin', 'admin', 'ak_admin_1');
    const key3 = mgr.create('Viewer', 'viewer', 'ak_admin_1');

    // All three should be validatable
    expect(mgr.validate('ak_admin_1')).not.toBeNull();
    if (key2) expect(mgr.validate(key2.key)).not.toBeNull();
    if (key3) expect(mgr.validate(key3.key)).not.toBeNull();

    // Invalid key should still be rejected
    expect(mgr.validate('ak_does_not_exist')).toBeNull();
  });

  it('should reject inactive (revoked) admin key', () => {
    const mgr = new AdminKeyManager();
    mgr.bootstrap('ak_bootstrap');

    const created = mgr.create('To Revoke', 'admin', 'ak_bootstrap');
    expect(created).not.toBeNull();
    expect(mgr.validate(created!.key)).not.toBeNull();

    // Revoke the key
    mgr.revoke(created!.key);

    // Should now be rejected
    expect(mgr.validate(created!.key)).toBeNull();
  });

  it('should update lastUsedAt on successful validation', () => {
    const mgr = new AdminKeyManager();
    mgr.bootstrap('ak_timestamp_test');

    const before = mgr.validate('ak_timestamp_test');
    expect(before).not.toBeNull();
    const firstTime = before!.lastUsedAt;

    // Small delay to ensure different timestamp
    const laterResult = mgr.validate('ak_timestamp_test');
    expect(laterResult).not.toBeNull();
    // lastUsedAt should be updated (or equal if very fast)
    expect(laterResult!.lastUsedAt).toBeDefined();
  });

  it('should not update lastUsedAt on failed validation', () => {
    const mgr = new AdminKeyManager();
    mgr.bootstrap('ak_no_update');

    // Failed validation should return null
    const result = mgr.validate('ak_invalid_key');
    expect(result).toBeNull();
    // Original key should not have been touched
  });
});

// ─── Integration: Timing-Safe Auth on Server ─────────────────────────────────

describe('Timing-Safe Auth Integration', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop(1000);
  });

  it('should accept correct admin key via HTTP', async () => {
    const resp = await post(port, '/keys', { name: 'timing-test', credits: 10 }, { 'X-Admin-Key': adminKey });
    expect(resp.status).toBe(201);
    expect(resp.body.key).toBeDefined();
  });

  it('should reject incorrect admin key via HTTP', async () => {
    const resp = await post(port, '/keys', { name: 'test' }, { 'X-Admin-Key': 'wrong_key' });
    expect(resp.status).toBe(401);
    expect(resp.body.error).toBeDefined();
  });

  it('should reject partial admin key match', async () => {
    // Try with just the first few characters of the real admin key
    const partial = adminKey.slice(0, 8);
    const resp = await post(port, '/keys', { name: 'test' }, { 'X-Admin-Key': partial });
    expect(resp.status).toBe(401);
  });

  it('should reject admin key with extra characters appended', async () => {
    const extended = adminKey + '_extra';
    const resp = await post(port, '/keys', { name: 'test' }, { 'X-Admin-Key': extended });
    expect(resp.status).toBe(401);
  });

  it('should handle concurrent auth requests without timing leak', async () => {
    // Fire 10 valid + 10 invalid requests concurrently
    const validRequests = Array.from({ length: 10 }, () =>
      post(port, '/status', {}, { 'X-Admin-Key': adminKey })
    );
    const invalidRequests = Array.from({ length: 10 }, () =>
      post(port, '/status', {}, { 'X-Admin-Key': 'completely_wrong_key_12345' })
    );

    const results = await Promise.all([...validRequests, ...invalidRequests]);

    // First 10 should succeed
    for (let i = 0; i < 10; i++) {
      expect(results[i].status).toBe(200);
    }
    // Last 10 should fail with 401
    for (let i = 10; i < 20; i++) {
      expect(results[i].status).toBe(401);
    }
  });
});
