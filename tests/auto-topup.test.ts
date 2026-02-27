/**
 * Tests for v3.2.0 — Usage-Based Auto-Topup
 *
 * Covers:
 *   - Gate.checkAutoTopup() unit tests
 *   - Gate.evaluate() auto-topup integration
 *   - evaluateBatch() auto-topup integration
 *   - Daily limit enforcement + reset
 *   - POST /keys/auto-topup endpoint (configure + disable)
 *   - State file backfill
 *   - Redis serialization round-trip
 *   - Audit log + webhook events
 */

import { Gate } from '../src/gate';
import { KeyStore } from '../src/store';
import { PayGateConfig, DEFAULT_CONFIG, ApiKeyRecord } from '../src/types';
import { RedisSync, PubSubEvent } from '../src/redis-sync';
import { PayGateServer } from '../src/server';
import http from 'http';

// ─── Test Helpers ──────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<PayGateConfig> = {}): PayGateConfig {
  return { ...DEFAULT_CONFIG, serverCommand: 'echo', name: 'test', ...overrides };
}

function request(port: number, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode!, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── Gate.checkAutoTopup() — Unit Tests ──────────────────────────────────

describe('Gate.checkAutoTopup()', () => {
  let gate: Gate;
  let apiKey: string;

  beforeEach(() => {
    gate = new Gate(makeConfig());
    const record = gate.store.createKey('topup-test', 100);
    apiKey = record.key;
  });

  afterEach(() => gate.destroy());

  test('returns false when autoTopup is not configured', () => {
    expect(gate.checkAutoTopup(apiKey)).toBe(false);
  });

  test('returns false when credits are above threshold', () => {
    const record = gate.store.getKey(apiKey)!;
    record.autoTopup = { threshold: 10, amount: 50, maxDaily: 0 };
    // credits = 100, threshold = 10 → no topup needed
    expect(gate.checkAutoTopup(apiKey)).toBe(false);
    expect(record.credits).toBe(100);
  });

  test('triggers topup when credits drop below threshold', () => {
    const record = gate.store.getKey(apiKey)!;
    record.autoTopup = { threshold: 10, amount: 50, maxDaily: 0 };
    record.credits = 5; // below threshold
    expect(gate.checkAutoTopup(apiKey)).toBe(true);
    expect(record.credits).toBe(55); // 5 + 50
    expect(record.autoTopupTodayCount).toBe(1);
  });

  test('triggers topup when credits equal zero', () => {
    const record = gate.store.getKey(apiKey)!;
    record.autoTopup = { threshold: 20, amount: 100, maxDaily: 0 };
    record.credits = 0;
    expect(gate.checkAutoTopup(apiKey)).toBe(true);
    expect(record.credits).toBe(100);
  });

  test('triggers topup when credits exactly equal threshold', () => {
    const record = gate.store.getKey(apiKey)!;
    record.autoTopup = { threshold: 10, amount: 50, maxDaily: 0 };
    record.credits = 10; // at threshold, not below
    // credits >= threshold → no topup
    expect(gate.checkAutoTopup(apiKey)).toBe(false);
  });

  test('respects maxDaily limit', () => {
    const record = gate.store.getKey(apiKey)!;
    record.autoTopup = { threshold: 10, amount: 50, maxDaily: 2 };
    record.credits = 5;

    // First topup
    expect(gate.checkAutoTopup(apiKey)).toBe(true);
    expect(record.autoTopupTodayCount).toBe(1);
    record.credits = 5; // simulate spending again

    // Second topup
    expect(gate.checkAutoTopup(apiKey)).toBe(true);
    expect(record.autoTopupTodayCount).toBe(2);
    record.credits = 5; // simulate spending again

    // Third topup — should be blocked
    expect(gate.checkAutoTopup(apiKey)).toBe(false);
    expect(record.credits).toBe(5); // unchanged
    expect(record.autoTopupTodayCount).toBe(2);
  });

  test('unlimited daily when maxDaily is 0', () => {
    const record = gate.store.getKey(apiKey)!;
    record.autoTopup = { threshold: 10, amount: 50, maxDaily: 0 };

    for (let i = 0; i < 10; i++) {
      record.credits = 5;
      expect(gate.checkAutoTopup(apiKey)).toBe(true);
    }
    expect(record.autoTopupTodayCount).toBe(10);
  });

  test('resets daily counter on new day', () => {
    const record = gate.store.getKey(apiKey)!;
    record.autoTopup = { threshold: 10, amount: 50, maxDaily: 1 };
    record.credits = 5;

    // First topup today
    expect(gate.checkAutoTopup(apiKey)).toBe(true);
    expect(record.autoTopupTodayCount).toBe(1);
    record.credits = 5;

    // Should be blocked (maxDaily=1)
    expect(gate.checkAutoTopup(apiKey)).toBe(false);

    // Simulate day change
    record.autoTopupLastResetDay = '2020-01-01';
    record.credits = 5;

    // Should work again (new day)
    expect(gate.checkAutoTopup(apiKey)).toBe(true);
    expect(record.autoTopupTodayCount).toBe(1);
    // Check that the reset day was updated
    expect(record.autoTopupLastResetDay).toBe(new Date().toISOString().slice(0, 10));
  });

  test('returns false for invalid/revoked key', () => {
    gate.store.revokeKey(apiKey);
    expect(gate.checkAutoTopup(apiKey)).toBe(false);
  });

  test('calls onAutoTopup hook', () => {
    const record = gate.store.getKey(apiKey)!;
    record.autoTopup = { threshold: 10, amount: 50, maxDaily: 0 };
    record.credits = 5;

    let hookCalled = false;
    let hookArgs: any[] = [];
    gate.onAutoTopup = (key, amount, newBalance) => {
      hookCalled = true;
      hookArgs = [key, amount, newBalance];
    };

    gate.checkAutoTopup(apiKey);
    expect(hookCalled).toBe(true);
    expect(hookArgs[0]).toBe(apiKey);
    expect(hookArgs[1]).toBe(50);
    expect(hookArgs[2]).toBe(55);
  });

  test('does not call onAutoTopup hook when no topup occurs', () => {
    const record = gate.store.getKey(apiKey)!;
    record.autoTopup = { threshold: 10, amount: 50, maxDaily: 0 };
    record.credits = 100; // above threshold

    let hookCalled = false;
    gate.onAutoTopup = () => { hookCalled = true; };

    gate.checkAutoTopup(apiKey);
    expect(hookCalled).toBe(false);
  });
});

// ─── Gate.evaluate() — Auto-topup Integration ───────────────────────────

describe('Gate.evaluate() with auto-topup', () => {
  let gate: Gate;
  let apiKey: string;

  beforeEach(() => {
    gate = new Gate(makeConfig({ defaultCreditsPerCall: 5 }));
    const record = gate.store.createKey('eval-topup', 20);
    apiKey = record.key;
    record.autoTopup = { threshold: 10, amount: 50, maxDaily: 0 };
  });

  afterEach(() => gate.destroy());

  test('auto-tops up after credit deduction drops below threshold', () => {
    // credits=20, charge=5 → remaining=15 → above threshold (10) → no topup
    const result1 = gate.evaluate(apiKey, { name: 'tool1' });
    expect(result1.allowed).toBe(true);
    expect(result1.remainingCredits).toBe(15);

    // credits=15, charge=5 → remaining=10 → at threshold → no topup
    const result2 = gate.evaluate(apiKey, { name: 'tool1' });
    expect(result2.allowed).toBe(true);
    expect(result2.remainingCredits).toBe(10);

    // credits=10, charge=5 → remaining=5 → below threshold → auto-topup!
    const result3 = gate.evaluate(apiKey, { name: 'tool1' });
    expect(result3.allowed).toBe(true);
    // After deduction: 5 credits. Auto-topup adds 50 → 55
    expect(result3.remainingCredits).toBe(55);
  });

  test('auto-topup prevents insufficient_credits on next call', () => {
    const record = gate.store.getKey(apiKey)!;
    record.credits = 6; // Just enough for one call
    record.autoTopup = { threshold: 10, amount: 100, maxDaily: 0 };

    // credits=6, charge=5 → remaining=1 → below threshold → auto-topup → 101
    const result = gate.evaluate(apiKey, { name: 'tool1' });
    expect(result.allowed).toBe(true);
    expect(result.remainingCredits).toBe(101);

    // Next call should succeed easily
    const result2 = gate.evaluate(apiKey, { name: 'tool1' });
    expect(result2.allowed).toBe(true);
    expect(result2.remainingCredits).toBe(96);
  });

  test('auto-topup still denied when insufficient credits for the call itself', () => {
    const record = gate.store.getKey(apiKey)!;
    record.credits = 3; // Not enough for 5-credit call
    record.autoTopup = { threshold: 10, amount: 100, maxDaily: 0 };

    // Auto-topup happens AFTER deduction, not before. So this should be denied.
    const result = gate.evaluate(apiKey, { name: 'tool1' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('insufficient_credits');
  });
});

// ─── evaluateBatch() — Auto-topup Integration ────────────────────────────

describe('evaluateBatch() with auto-topup', () => {
  let gate: Gate;
  let apiKey: string;

  beforeEach(() => {
    gate = new Gate(makeConfig({ defaultCreditsPerCall: 5 }));
    const record = gate.store.createKey('batch-topup', 30);
    apiKey = record.key;
    record.autoTopup = { threshold: 10, amount: 100, maxDaily: 0 };
  });

  afterEach(() => gate.destroy());

  test('auto-tops up after batch deduction drops below threshold', () => {
    // 3 calls × 5 credits = 15 deducted. 30 - 15 = 15 → above threshold
    const result1 = gate.evaluateBatch(apiKey, [
      { name: 'tool1' }, { name: 'tool2' }, { name: 'tool3' },
    ]);
    expect(result1.allAllowed).toBe(true);
    expect(result1.remainingCredits).toBe(15);

    // 2 calls × 5 = 10 deducted. 15 - 10 = 5 → below threshold → auto-topup → 105
    const result2 = gate.evaluateBatch(apiKey, [
      { name: 'tool1' }, { name: 'tool2' },
    ]);
    expect(result2.allAllowed).toBe(true);
    expect(result2.remainingCredits).toBe(105);
  });
});

// ─── KeyStore backfill ────────────────────────────────────────────────────

describe('KeyStore auto-topup backfill', () => {
  test('new keys have autoTopup tracking fields', () => {
    const store = new KeyStore();
    const record = store.createKey('test', 100);
    expect(record.autoTopupTodayCount).toBe(0);
    expect(record.autoTopupLastResetDay).toBe(new Date().toISOString().slice(0, 10));
    expect(record.autoTopup).toBeUndefined();
  });

  test('imported keys have autoTopup tracking fields', () => {
    const store = new KeyStore();
    const record = store.importKey('pg_test123', 'imported', 100);
    expect(record.autoTopupTodayCount).toBe(0);
    expect(record.autoTopupLastResetDay).toBe(new Date().toISOString().slice(0, 10));
  });
});

// ─── Redis serialization round-trip ───────────────────────────────────────

describe('Redis serialization for auto-topup', () => {
  test('recordToHash and hashToRecord preserve autoTopup config', () => {
    // We test the serialization by accessing private methods via prototype
    const store = new KeyStore();
    const record = store.createKey('redis-test', 100);
    record.autoTopup = { threshold: 10, amount: 50, maxDaily: 5 };
    record.autoTopupTodayCount = 3;
    record.autoTopupLastResetDay = '2025-01-15';

    // Create a mock RedisSync to test serialization
    const mockRedis = {
      hset: jest.fn(),
      command: jest.fn(),
      evalLua: jest.fn(),
      hgetall: jest.fn(),
      disconnect: jest.fn(),
    };
    const sync = new RedisSync(mockRedis as any, store);

    // Access private methods via prototype
    const hash = (sync as any).recordToHash(record) as string[];
    expect(hash).toContain('autoTopup');
    const atIdx = hash.indexOf('autoTopup');
    expect(JSON.parse(hash[atIdx + 1])).toEqual({ threshold: 10, amount: 50, maxDaily: 5 });

    expect(hash).toContain('autoTopupTodayCount');
    const countIdx = hash.indexOf('autoTopupTodayCount');
    expect(hash[countIdx + 1]).toBe('3');

    expect(hash).toContain('autoTopupLastResetDay');
    const dayIdx = hash.indexOf('autoTopupLastResetDay');
    expect(hash[dayIdx + 1]).toBe('2025-01-15');

    // Convert hash array to object for hashToRecord
    const hashObj: Record<string, string> = {};
    for (let i = 0; i < hash.length; i += 2) {
      hashObj[hash[i]] = hash[i + 1];
    }

    const restored = (sync as any).hashToRecord(hashObj) as ApiKeyRecord;
    expect(restored.autoTopup).toEqual({ threshold: 10, amount: 50, maxDaily: 5 });
    expect(restored.autoTopupTodayCount).toBe(3);
    expect(restored.autoTopupLastResetDay).toBe('2025-01-15');
  });

  test('hashToRecord handles missing autoTopup fields (backfill)', () => {
    const store = new KeyStore();
    const mockRedis = {
      hset: jest.fn(), command: jest.fn(), evalLua: jest.fn(),
      hgetall: jest.fn(), disconnect: jest.fn(),
    };
    const sync = new RedisSync(mockRedis as any, store);

    // Simulate old Redis record without autoTopup fields
    const hash: Record<string, string> = {
      key: 'pg_test',
      name: 'test',
      credits: '100',
      totalSpent: '0',
      totalCalls: '0',
      createdAt: new Date().toISOString(),
      lastUsedAt: '',
      active: '1',
      spendingLimit: '0',
      allowedTools: '[]',
      deniedTools: '[]',
      expiresAt: '',
      quota: '',
      tags: '{}',
      ipAllowlist: '[]',
      quotaDailyCalls: '0',
      quotaMonthlyCalls: '0',
      quotaDailyCredits: '0',
      quotaMonthlyCredits: '0',
      quotaLastResetDay: '2025-01-15',
      quotaLastResetMonth: '2025-01',
      namespace: 'default',
      // No autoTopup fields
    };

    const restored = (sync as any).hashToRecord(hash) as ApiKeyRecord;
    expect(restored.autoTopup).toBeUndefined();
    expect(restored.autoTopupTodayCount).toBe(0);
    expect(restored.autoTopupLastResetDay).toBe(new Date().toISOString().slice(0, 10));
  });
});

// ─── HTTP Endpoint Tests ──────────────────────────────────────────────────

describe('POST /keys/auto-topup endpoint', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let apiKey: string;

  beforeAll(async () => {
    server = new PayGateServer(
      { serverCommand: 'echo', port: 0, name: 'auto-topup-test' },
      'test-admin-key',
    );
    const result = await server.start();
    port = result.port;
    adminKey = result.adminKey;

    // Create a test key
    const createRes = await request(port, 'POST', '/keys',
      { name: 'topup-key', credits: 100 },
      { 'X-Admin-Key': adminKey });
    apiKey = createRes.body.key;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('requires admin auth', async () => {
    const res = await request(port, 'POST', '/keys/auto-topup', { key: apiKey });
    expect(res.status).toBe(401);
  });

  test('rejects GET method', async () => {
    const res = await request(port, 'GET', '/keys/auto-topup', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(405);
  });

  test('rejects invalid JSON', async () => {
    const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, method: 'POST', path: '/keys/auto-topup',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      }, (r) => {
        let raw = '';
        r.on('data', (c: Buffer) => { raw += c.toString(); });
        r.on('end', () => resolve({ status: r.statusCode!, body: JSON.parse(raw) }));
      });
      req.on('error', reject);
      req.write('not json');
      req.end();
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid JSON');
  });

  test('rejects missing key', async () => {
    const res = await request(port, 'POST', '/keys/auto-topup',
      { threshold: 10, amount: 50 },
      { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing key');
  });

  test('rejects invalid key', async () => {
    const res = await request(port, 'POST', '/keys/auto-topup',
      { key: 'pg_doesnotexist', threshold: 10, amount: 50 },
      { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(404);
  });

  test('rejects missing threshold', async () => {
    const res = await request(port, 'POST', '/keys/auto-topup',
      { key: apiKey, amount: 50 },
      { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('threshold');
  });

  test('rejects missing amount', async () => {
    const res = await request(port, 'POST', '/keys/auto-topup',
      { key: apiKey, threshold: 10 },
      { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('amount');
  });

  test('configures auto-topup successfully', async () => {
    const res = await request(port, 'POST', '/keys/auto-topup',
      { key: apiKey, threshold: 10, amount: 50, maxDaily: 5 },
      { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.autoTopup).toEqual({ threshold: 10, amount: 50, maxDaily: 5 });
    expect(res.body.message).toContain('Auto-topup enabled');
    expect(res.body.message).toContain('max 5/day');

    // Verify on the record
    const record = server.gate.store.getKey(apiKey)!;
    expect(record.autoTopup).toEqual({ threshold: 10, amount: 50, maxDaily: 5 });
  });

  test('configures with maxDaily=0 (unlimited)', async () => {
    const res = await request(port, 'POST', '/keys/auto-topup',
      { key: apiKey, threshold: 20, amount: 100, maxDaily: 0 },
      { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.autoTopup).toEqual({ threshold: 20, amount: 100, maxDaily: 0 });
    expect(res.body.message).toContain('unlimited daily');
  });

  test('disables auto-topup', async () => {
    // First configure
    await request(port, 'POST', '/keys/auto-topup',
      { key: apiKey, threshold: 10, amount: 50 },
      { 'X-Admin-Key': adminKey });

    // Then disable
    const res = await request(port, 'POST', '/keys/auto-topup',
      { key: apiKey, disable: true },
      { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.autoTopup).toBeNull();
    expect(res.body.message).toBe('Auto-topup disabled');

    const record = server.gate.store.getKey(apiKey)!;
    expect(record.autoTopup).toBeUndefined();
  });

  test('auto-topup appears in root endpoint listing', async () => {
    const res = await request(port, 'GET', '/');
    expect(res.status).toBe(200);
    expect(res.body.endpoints.autoTopup).toContain('auto-topup');
  });

  test('audit log records auto-topup configuration', async () => {
    await request(port, 'POST', '/keys/auto-topup',
      { key: apiKey, threshold: 15, amount: 75, maxDaily: 3 },
      { 'X-Admin-Key': adminKey });

    const auditRes = await request(port, 'GET', '/audit?types=key.auto_topup_configured', undefined, { 'X-Admin-Key': adminKey });
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.events.length).toBeGreaterThan(0);
    const lastEvent = auditRes.body.events[0];
    expect(lastEvent.type).toBe('key.auto_topup_configured');
    expect(lastEvent.metadata.threshold).toBe(15);
    expect(lastEvent.metadata.amount).toBe(75);
  });

  test('auto-topup triggers audit event on actual topup', async () => {
    // Configure auto-topup
    await request(port, 'POST', '/keys/auto-topup',
      { key: apiKey, threshold: 200, amount: 500 },
      { 'X-Admin-Key': adminKey });

    // Set credits low enough that any call triggers topup
    const record = server.gate.store.getKey(apiKey)!;
    record.credits = 10;

    // Make a call that triggers auto-topup (credits 10 → 9 after 1-credit deduction → below 200 → topup)
    const result = server.gate.evaluate(apiKey, { name: 'test-tool' });
    expect(result.allowed).toBe(true);

    // Check audit log
    const auditRes = await request(port, 'GET', '/audit?types=key.auto_topped_up', undefined, { 'X-Admin-Key': adminKey });
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.events.length).toBeGreaterThan(0);
    const lastEvent = auditRes.body.events[0];
    expect(lastEvent.type).toBe('key.auto_topped_up');
    expect(lastEvent.metadata.creditsAdded).toBe(500);
  });
});

// ─── PubSubEvent type check ───────────────────────────────────────────────

describe('PubSubEvent type compatibility', () => {
  test('key_updated event type is valid', () => {
    const event: PubSubEvent = {
      type: 'key_updated',
      key: 'pg_test',
      instanceId: 'test',
    };
    expect(event.type).toBe('key_updated');
  });

  test('credits_changed with inline data is valid', () => {
    const event: PubSubEvent = {
      type: 'credits_changed',
      key: 'pg_test',
      instanceId: 'test',
      data: { credits: 100, totalSpent: 50, totalCalls: 10 },
    };
    expect(event.data?.credits).toBe(100);
  });
});
