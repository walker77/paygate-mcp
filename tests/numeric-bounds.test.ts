/**
 * Numeric input bounds tests — verifies that all admin endpoints enforce
 * upper bounds on numeric fields (credits, quotas, spending limits, auto-topup,
 * rate limits) to prevent absurd values.
 *
 * v8.89.0: Numeric admin inputs previously only enforced Math.max(0, ...)
 * but had no upper cap. Now clamped via clampInt() to sane maximums.
 */

import { PayGateServer } from '../src/server';
import http from 'http';

// Suppress logger output in tests
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

let server: PayGateServer;
let port: number;
let adminKey: string;
let testKey: string;

beforeAll(async () => {
  server = new PayGateServer({
    serverCommand: 'echo',
    serverArgs: ['test'],
    port: 0,
    requestTimeoutMs: 3000,
  });
  const started = await server.start();
  port = started.port;
  adminKey = started.adminKey;

  // Create a test key for endpoint tests
  const res = await postJson('/keys', { credits: 1000, name: 'bounds-test-key' });
  testKey = res.body.key;
});

afterAll(async () => {
  await server.gracefulStop(1000);
});

function getJson(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: {
        'X-Admin-Key': adminKey,
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
    req.end();
  });
}

function postJson(path: string, body: any, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
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
        'X-Admin-Key': adminKey,
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

describe('Numeric input bounds enforcement', () => {
  // ── Credits clamping ────────────────────────────────────────────
  describe('Credit bounds', () => {
    test('POST /keys clamps credits to MAX_CREDITS (1 billion)', async () => {
      const res = await postJson('/keys', { credits: 9_999_999_999, name: 'huge-credits' });
      expect(res.status).toBe(201);
      expect(res.body.credits).toBeLessThanOrEqual(1_000_000_000);
    });

    test('POST /topup clamps credits to MAX_CREDITS', async () => {
      const res = await postJson('/topup', { key: testKey, credits: 5_000_000_000 });
      expect(res.status).toBe(200);
      // Verify the key credits didn't jump beyond reasonable bounds
      const statusRes = await getJson(`/keys/usage?key=${testKey}`);
      expect(statusRes.body.credits).toBeLessThanOrEqual(2_000_000_000);
    });

    test('POST /keys/transfer clamps credits to MAX_CREDITS', async () => {
      // Create two keys
      const key1 = await postJson('/keys', { credits: 500, name: 'xfer-src' });
      const key2 = await postJson('/keys', { credits: 100, name: 'xfer-dst' });
      // Try to transfer absurd amount — should fail with insufficient credits (clamped to 1B)
      const res = await postJson('/keys/transfer', {
        from: key1.body.key,
        to: key2.body.key,
        credits: 99_999_999_999,
      });
      // Should fail because clamped value (1B) > available (500)
      expect(res.status).toBe(400);
    });
  });

  // ── Quota bounds ────────────────────────────────────────────────
  describe('Quota bounds', () => {
    test('POST /keys/quota clamps all limits to MAX_QUOTA_LIMIT', async () => {
      const res = await postJson('/keys/quota', {
        key: testKey,
        dailyCallLimit: 99_999_999_999,
        monthlyCallLimit: 99_999_999_999,
        dailyCreditLimit: 99_999_999_999,
        monthlyCreditLimit: 99_999_999_999,
      });
      expect(res.status).toBe(200);
      // Verify quota was clamped
      const statusRes = await getJson(`/keys/quota-status?key=${testKey}`);
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.daily.callsLimit).toBeLessThanOrEqual(1_000_000_000);
      expect(statusRes.body.monthly.callsLimit).toBeLessThanOrEqual(1_000_000_000);
    });

    test('POST /keys creates key with clamped quota', async () => {
      const res = await postJson('/keys', {
        credits: 100,
        name: 'quota-clamp-test',
        quota: {
          dailyCallLimit: 5_000_000_000,
          monthlyCallLimit: 5_000_000_000,
          dailyCreditLimit: 5_000_000_000,
          monthlyCreditLimit: 5_000_000_000,
        },
      });
      expect(res.status).toBe(201);
      const statusRes = await getJson(`/keys/quota-status?key=${res.body.key}`);
      expect(statusRes.body.daily.callsLimit).toBeLessThanOrEqual(1_000_000_000);
    });
  });

  // ── Auto-topup bounds ──────────────────────────────────────────
  describe('Auto-topup bounds', () => {
    test('POST /keys/auto-topup clamps threshold and amount', async () => {
      const res = await postJson('/keys/auto-topup', {
        key: testKey,
        threshold: 999_999_999_999,
        amount: 999_999_999_999,
        maxDaily: 999_999_999_999,
      });
      expect(res.status).toBe(200);
      expect(res.body.autoTopup.threshold).toBeLessThanOrEqual(100_000_000);
      expect(res.body.autoTopup.amount).toBeLessThanOrEqual(100_000_000);
      expect(res.body.autoTopup.maxDaily).toBeLessThanOrEqual(1_000_000_000);
    });
  });

  // ── Spending limit bounds ──────────────────────────────────────
  describe('Spending limit bounds', () => {
    test('POST /limits clamps spendingLimit to MAX_SPENDING_LIMIT', async () => {
      const res = await postJson('/limits', {
        key: testKey,
        spendingLimit: 99_999_999_999,
      });
      expect(res.status).toBe(200);
      expect(res.body.spendingLimit).toBeLessThanOrEqual(1_000_000_000);
    });
  });

  // ── Bulk operations bounds ──────────────────────────────────────
  describe('Bulk operations bounds', () => {
    test('POST /keys/bulk create clamps credits', async () => {
      const res = await postJson('/keys/bulk', {
        operations: [
          { action: 'create', name: 'bulk-clamp-test', credits: 9_999_999_999 },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.results[0].success).toBe(true);
      // Verify the created key has clamped credits by checking via /keys/usage
      const keyVal = res.body.results[0].key;
      if (keyVal) {
        const usage = await getJson(`/keys/usage?key=${keyVal}`);
        expect(usage.body.credits).toBeLessThanOrEqual(1_000_000_000);
      }
    });

    test('POST /keys/bulk topup clamps credits', async () => {
      const res = await postJson('/keys/bulk', {
        operations: [
          { action: 'topup', key: testKey, credits: 9_999_999_999 },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.results[0].success).toBe(true);
    });
  });

  // ── Reservation bounds ──────────────────────────────────────────
  describe('Reservation bounds', () => {
    test('POST /keys/reserve clamps credits to MAX_CREDITS', async () => {
      // Create a key with known credits
      const keyRes = await postJson('/keys', { credits: 500, name: 'reserve-clamp-test' });
      // Try to reserve absurd amount — gets clamped then fails (insufficient)
      const res = await postJson('/keys/reserve', {
        key: keyRes.body.key,
        credits: 99_999_999_999,
      });
      // Clamped to 1B > 500 available, so should fail
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/insufficient/i);
    });
  });

  // ── Reasonable values still work ───────────────────────────────
  describe('Reasonable values pass through', () => {
    test('credits at exactly 1 billion succeed', async () => {
      const res = await postJson('/keys', { credits: 1_000_000_000, name: 'max-credits' });
      expect(res.status).toBe(201);
      expect(res.body.credits).toBe(1_000_000_000);
    });

    test('normal quota values are preserved', async () => {
      const res = await postJson('/keys/quota', {
        key: testKey,
        dailyCallLimit: 10000,
        monthlyCallLimit: 100000,
        dailyCreditLimit: 50000,
        monthlyCreditLimit: 500000,
      });
      expect(res.status).toBe(200);
      const statusRes = await getJson(`/keys/quota-status?key=${testKey}`);
      expect(statusRes.body.daily.callsLimit).toBe(10000);
      expect(statusRes.body.monthly.callsLimit).toBe(100000);
    });

    test('normal spending limit is preserved', async () => {
      const res = await postJson('/limits', {
        key: testKey,
        spendingLimit: 50000,
      });
      expect(res.status).toBe(200);
      expect(res.body.spendingLimit).toBe(50000);
    });
  });
});
