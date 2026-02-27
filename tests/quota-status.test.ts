/**
 * Tests for v6.3.0 — Quota Status Endpoint.
 *
 * Tests GET /keys/quota-status?key=... returning current daily/monthly quota
 * usage: calls/credits used vs limits, remaining, reset day/month,
 * quota source (per-key vs global vs none).
 */

import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';
import http from 'http';

const ECHO_CMD = process.execPath;
const ECHO_ARGS = ['-e', `process.stdin.resume(); process.stdin.on('data', d => { const r = JSON.parse(d.toString().trim()); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: {} }) + '\\n'); });`];

function makeServer(overrides: Record<string, any> = {}): PayGateServer {
  return new PayGateServer({
    ...DEFAULT_CONFIG,
    serverCommand: ECHO_CMD,
    serverArgs: ECHO_ARGS,
    port: 0,
    ...overrides,
  });
}

async function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode!, body: buf }); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function httpPost(port: number, path: string, body: object, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode!, body: buf }); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── With global quota ───
describe('GET /keys/quota-status with global quota', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let testKey: string;

  beforeAll(async () => {
    server = makeServer({
      globalQuota: {
        dailyCallLimit: 100,
        monthlyCallLimit: 2000,
        dailyCreditLimit: 500,
        monthlyCreditLimit: 10000,
      },
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    const res = await httpPost(port, '/keys', { name: 'quota-key', credits: 5000 }, { 'x-admin-key': adminKey });
    testKey = res.body.key;
  });

  afterAll(async () => {
    if (server) await server.gracefulStop(5_000);
  }, 30_000);

  test('returns quota status with global quota source', async () => {
    const res = await httpGet(port, `/keys/quota-status?key=${testKey}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.quotaSource).toBe('global');
    expect(res.body.name).toBe('quota-key');
    expect(res.body.key).toContain('...');
  });

  test('returns daily quota info', async () => {
    const res = await httpGet(port, `/keys/quota-status?key=${testKey}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.daily.callsUsed).toBe(0);
    expect(res.body.daily.callsLimit).toBe(100);
    expect(res.body.daily.callsRemaining).toBe(100);
    expect(res.body.daily.creditsUsed).toBe(0);
    expect(res.body.daily.creditsLimit).toBe(500);
    expect(res.body.daily.creditsRemaining).toBe(500);
    expect(typeof res.body.daily.resetDay).toBe('string');
  });

  test('returns monthly quota info', async () => {
    const res = await httpGet(port, `/keys/quota-status?key=${testKey}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.monthly.callsUsed).toBe(0);
    expect(res.body.monthly.callsLimit).toBe(2000);
    expect(res.body.monthly.callsRemaining).toBe(2000);
    expect(res.body.monthly.creditsUsed).toBe(0);
    expect(res.body.monthly.creditsLimit).toBe(10000);
    expect(res.body.monthly.creditsRemaining).toBe(10000);
    expect(typeof res.body.monthly.resetMonth).toBe('string');
  });

  test('reflects usage after recording calls', async () => {
    const record = server.gate.store.getKey(testKey);
    if (record) {
      server.gate.quotaTracker.record(record, 10);
      server.gate.quotaTracker.record(record, 15);
      server.gate.quotaTracker.record(record, 5);
    }

    const res = await httpGet(port, `/keys/quota-status?key=${testKey}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.daily.callsUsed).toBe(3);
    expect(res.body.daily.callsRemaining).toBe(97);
    expect(res.body.daily.creditsUsed).toBe(30);
    expect(res.body.daily.creditsRemaining).toBe(470);
    expect(res.body.monthly.callsUsed).toBe(3);
    expect(res.body.monthly.callsRemaining).toBe(1997);
    expect(res.body.monthly.creditsUsed).toBe(30);
    expect(res.body.monthly.creditsRemaining).toBe(9970);
  });

  test('requires admin auth', async () => {
    const res = await httpGet(port, `/keys/quota-status?key=${testKey}`);
    expect(res.status).toBe(401);
  });

  test('requires key parameter', async () => {
    const res = await httpGet(port, '/keys/quota-status', { 'x-admin-key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('key');
  });

  test('returns 404 for nonexistent key', async () => {
    const res = await httpGet(port, '/keys/quota-status?key=pg_nonexistent', { 'x-admin-key': adminKey });
    expect(res.status).toBe(404);
  });

  test('POST returns 405', async () => {
    const res = await httpPost(port, `/keys/quota-status?key=${testKey}`, {}, { 'x-admin-key': adminKey });
    expect(res.status).toBe(405);
  });

  test('root listing includes quota-status', async () => {
    const res = await httpGet(port, '/', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    const str = JSON.stringify(res.body);
    expect(str).toContain('/keys/quota-status');
  });
});

// ─── Per-key quota override ───
describe('GET /keys/quota-status with per-key quota', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let testKey: string;

  beforeAll(async () => {
    server = makeServer({
      globalQuota: {
        dailyCallLimit: 100,
        monthlyCallLimit: 2000,
        dailyCreditLimit: 500,
        monthlyCreditLimit: 10000,
      },
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    const res = await httpPost(port, '/keys', { name: 'per-key-quota', credits: 5000 }, { 'x-admin-key': adminKey });
    testKey = res.body.key;

    // Set per-key quota override
    const record = server.gate.store.getKey(testKey);
    if (record) {
      record.quota = {
        dailyCallLimit: 50,
        monthlyCallLimit: 500,
        dailyCreditLimit: 200,
        monthlyCreditLimit: 5000,
      };
    }
  });

  afterAll(async () => {
    if (server) await server.gracefulStop(5_000);
  }, 30_000);

  test('uses per-key quota and reports source', async () => {
    const res = await httpGet(port, `/keys/quota-status?key=${testKey}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.quotaSource).toBe('per-key');
    expect(res.body.daily.callsLimit).toBe(50);
    expect(res.body.monthly.callsLimit).toBe(500);
    expect(res.body.daily.creditsLimit).toBe(200);
    expect(res.body.monthly.creditsLimit).toBe(5000);
  });
});

// ─── No quota configured ───
describe('GET /keys/quota-status with no quota', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let testKey: string;

  beforeAll(async () => {
    server = makeServer(); // no globalQuota
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    const res = await httpPost(port, '/keys', { name: 'no-quota-key', credits: 5000 }, { 'x-admin-key': adminKey });
    testKey = res.body.key;
  });

  afterAll(async () => {
    if (server) await server.gracefulStop(5_000);
  }, 30_000);

  test('reports no quota source', async () => {
    const res = await httpGet(port, `/keys/quota-status?key=${testKey}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.quotaSource).toBe('none');
  });

  test('limits are all zero and remaining is null', async () => {
    const res = await httpGet(port, `/keys/quota-status?key=${testKey}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.daily.callsLimit).toBe(0);
    expect(res.body.daily.callsRemaining).toBeNull();
    expect(res.body.daily.creditsLimit).toBe(0);
    expect(res.body.daily.creditsRemaining).toBeNull();
    expect(res.body.monthly.callsLimit).toBe(0);
    expect(res.body.monthly.callsRemaining).toBeNull();
    expect(res.body.monthly.creditsLimit).toBe(0);
    expect(res.body.monthly.creditsRemaining).toBeNull();
  });

  test('still reports usage counters', async () => {
    const record = server.gate.store.getKey(testKey);
    if (record) {
      server.gate.quotaTracker.record(record, 7);
    }

    const res = await httpGet(port, `/keys/quota-status?key=${testKey}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.daily.callsUsed).toBe(1);
    expect(res.body.daily.creditsUsed).toBe(7);
  });
});

// ─── Reset day/month format ───
describe('Quota status reset periods', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let testKey: string;

  beforeAll(async () => {
    server = makeServer({
      globalQuota: {
        dailyCallLimit: 10,
        monthlyCallLimit: 100,
        dailyCreditLimit: 0,
        monthlyCreditLimit: 0,
      },
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    const res = await httpPost(port, '/keys', { name: 'period-key', credits: 1000 }, { 'x-admin-key': adminKey });
    testKey = res.body.key;
  });

  afterAll(async () => {
    if (server) await server.gracefulStop(5_000);
  }, 30_000);

  test('resetDay is today in YYYY-MM-DD format', async () => {
    const res = await httpGet(port, `/keys/quota-status?key=${testKey}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    const today = new Date().toISOString().slice(0, 10);
    expect(res.body.daily.resetDay).toBe(today);
  });

  test('resetMonth is current month in YYYY-MM format', async () => {
    const res = await httpGet(port, `/keys/quota-status?key=${testKey}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    const month = new Date().toISOString().slice(0, 7);
    expect(res.body.monthly.resetMonth).toBe(month);
  });

  test('zero limits show remaining as null (unlimited)', async () => {
    const res = await httpGet(port, `/keys/quota-status?key=${testKey}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    // dailyCreditLimit = 0 (unlimited)
    expect(res.body.daily.creditsLimit).toBe(0);
    expect(res.body.daily.creditsRemaining).toBeNull();
    // daily calls have a limit
    expect(res.body.daily.callsLimit).toBe(10);
    expect(res.body.daily.callsRemaining).toBe(10);
  });
});
