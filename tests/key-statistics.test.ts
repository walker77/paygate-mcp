/**
 * Tests for v6.1.0 — Key Statistics Endpoint.
 *
 * Tests GET /keys/stats returning aggregate statistics across all keys:
 * total, active, suspended, expired, revoked counts, credit aggregates,
 * namespace/group breakdowns, and optional namespace filtering.
 */

import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';
import http from 'http';

const ECHO_CMD = process.execPath;
const ECHO_ARGS = ['-e', `process.stdin.resume(); process.stdin.on('data', d => { const r = JSON.parse(d.toString().trim()); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: {} }) + '\\n'); });`];

function makeServer(): PayGateServer {
  return new PayGateServer({
    ...DEFAULT_CONFIG,
    serverCommand: ECHO_CMD,
    serverArgs: ECHO_ARGS,
    port: 0,
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

describe('Key Statistics Endpoint', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  const keys: string[] = [];

  beforeAll(async () => {
    server = makeServer();
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    // Create 8 keys with varying properties
    // Keys 0-3: namespace 'prod', credits 100-400
    for (let i = 0; i < 4; i++) {
      const res = await httpPost(port, '/keys', {
        name: `prod-key-${i}`,
        credits: (i + 1) * 100,
        namespace: 'prod',
      }, { 'x-admin-key': adminKey });
      keys.push(res.body.key);
    }

    // Keys 4-6: namespace 'staging', credits 500-700
    for (let i = 0; i < 3; i++) {
      const res = await httpPost(port, '/keys', {
        name: `staging-key-${i}`,
        credits: (i + 5) * 100,
        namespace: 'staging',
      }, { 'x-admin-key': adminKey });
      keys.push(res.body.key);
    }

    // Key 7: no namespace, credits 800
    const res7 = await httpPost(port, '/keys', {
      name: 'default-key',
      credits: 800,
    }, { 'x-admin-key': adminKey });
    keys.push(res7.body.key);

    // Suspend key 1
    await httpPost(port, '/keys/suspend', { key: keys[1] }, { 'x-admin-key': adminKey });

    // Revoke key 2
    await httpPost(port, '/keys/revoke', { key: keys[2] }, { 'x-admin-key': adminKey });

    // Set group on key 3 and key 4
    const key3Record = server.gate.store.getKey(keys[3]);
    if (key3Record) key3Record.group = 'enterprise';
    const key4Record = server.gate.store.getKey(keys[4]);
    if (key4Record) key4Record.group = 'enterprise';

    // Set group on key 5
    const key5Record = server.gate.store.getKey(keys[5]);
    if (key5Record) key5Record.group = 'starter';
  });

  afterAll(async () => {
    if (server) await server.gracefulStop(5_000);
  }, 30_000);

  // ─── Basic stats ───
  test('returns aggregate statistics', async () => {
    const res = await httpGet(port, '/keys/stats', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(8);
    expect(res.body.active).toBe(6); // 8 - 1 suspended - 1 revoked
    expect(res.body.suspended).toBe(1);
    expect(res.body.revoked).toBe(1);
    expect(res.body.expired).toBe(0);
  });

  test('returns credit aggregates', async () => {
    const res = await httpGet(port, '/keys/stats', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    // Total allocated: 100+200+300+400+500+600+700+800 = 3600
    expect(res.body.totalCreditsAllocated).toBe(3600);
    expect(res.body.totalCreditsSpent).toBe(0); // no usage yet
    expect(res.body.totalCreditsRemaining).toBe(3600);
    expect(res.body.totalCalls).toBe(0);
  });

  test('returns namespace breakdown', async () => {
    const res = await httpGet(port, '/keys/stats', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.byNamespace).toBeDefined();
    expect(res.body.byNamespace.prod).toBe(4);
    expect(res.body.byNamespace.staging).toBe(3);
    expect(res.body.byNamespace.default).toBe(1);
  });

  test('returns group breakdown', async () => {
    const res = await httpGet(port, '/keys/stats', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.byGroup).toBeDefined();
    expect(res.body.byGroup.enterprise).toBe(2);
    expect(res.body.byGroup.starter).toBe(1);
  });

  // ─── Namespace filtering ───
  test('filters by namespace', async () => {
    const res = await httpGet(port, '/keys/stats?namespace=prod', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.filteredByNamespace).toBe('prod');
    // Credits for prod: 100+200+300+400 = 1000
    expect(res.body.totalCreditsAllocated).toBe(1000);
    expect(res.body.byNamespace.prod).toBe(4);
    expect(res.body.byNamespace.staging).toBeUndefined();
  });

  test('filters by staging namespace', async () => {
    const res = await httpGet(port, '/keys/stats?namespace=staging', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.filteredByNamespace).toBe('staging');
    // Credits for staging: 500+600+700 = 1800
    expect(res.body.totalCreditsAllocated).toBe(1800);
  });

  test('non-existent namespace returns zeros', async () => {
    const res = await httpGet(port, '/keys/stats?namespace=nonexistent', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.active).toBe(0);
    expect(res.body.totalCreditsAllocated).toBe(0);
    expect(res.body.totalCalls).toBe(0);
  });

  test('no filteredByNamespace when no filter', async () => {
    const res = await httpGet(port, '/keys/stats', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.filteredByNamespace).toBeUndefined();
  });

  // ─── Suspended/revoked in namespace filter ───
  test('namespace filter counts suspended and revoked correctly', async () => {
    const res = await httpGet(port, '/keys/stats?namespace=prod', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.suspended).toBe(1); // key 1 in prod
    expect(res.body.revoked).toBe(1);   // key 2 in prod
    expect(res.body.active).toBe(2);    // key 0 and key 3
  });

  // ─── Auth ───
  test('requires admin auth', async () => {
    const res = await httpGet(port, '/keys/stats');
    expect(res.status).toBe(401);
  });

  test('wrong admin key returns 401', async () => {
    const res = await httpGet(port, '/keys/stats', { 'x-admin-key': 'wrong-key' });
    expect(res.status).toBe(401);
  });

  // ─── Method ───
  test('POST returns 405', async () => {
    const res = await httpPost(port, '/keys/stats', {}, { 'x-admin-key': adminKey });
    expect(res.status).toBe(405);
  });

  // ─── With expired key ───
  test('counts expired keys correctly', async () => {
    // Create a key with an expiry in the past
    const createRes = await httpPost(port, '/keys', {
      name: 'expired-key',
      credits: 50,
      namespace: 'prod',
    }, { 'x-admin-key': adminKey });
    expect(createRes.status).toBe(201);

    const expiredKey = createRes.body.key;
    // Manually set expiresAt in the past
    const record = server.gate.store.getKey(expiredKey);
    if (record) {
      record.expiresAt = new Date(Date.now() - 60000).toISOString();
    }

    const res = await httpGet(port, '/keys/stats', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(9); // 8 + 1 expired
    expect(res.body.expired).toBe(1);

    // Check prod-filtered stats include the expired key
    const prodRes = await httpGet(port, '/keys/stats?namespace=prod', { 'x-admin-key': adminKey });
    expect(prodRes.body.expired).toBe(1);
  });

  // ─── Root listing includes /keys/stats ───
  test('root listing includes /keys/stats endpoint', async () => {
    const res = await httpGet(port, '/', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    const body = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
    const endpointStr = JSON.stringify(body);
    expect(endpointStr).toContain('/keys/stats');
  });

  // ─── Credit tracking after usage ───
  test('tracks credits spent after topup and usage simulation', async () => {
    // Simulate spending by directly modifying a record
    const record = server.gate.store.getKey(keys[0]);
    if (record) {
      record.totalSpent = 25;
      record.totalCalls = 5;
    }

    const res = await httpGet(port, '/keys/stats', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.totalCreditsSpent).toBe(25);
    expect(res.body.totalCalls).toBe(5);
    expect(res.body.totalCreditsRemaining).toBe(res.body.totalCreditsAllocated - 25);

    // Reset for other tests
    if (record) {
      record.totalSpent = 0;
      record.totalCalls = 0;
    }
  });

  // ─── Empty server ───
  test('returns zeros on fresh server', async () => {
    const freshServer = makeServer();
    const freshInfo = await freshServer.start();
    try {
      const res = await httpGet(freshInfo.port, '/keys/stats', { 'x-admin-key': freshInfo.adminKey });
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
      expect(res.body.active).toBe(0);
      expect(res.body.suspended).toBe(0);
      expect(res.body.expired).toBe(0);
      expect(res.body.revoked).toBe(0);
      expect(res.body.totalCreditsAllocated).toBe(0);
      expect(res.body.totalCreditsSpent).toBe(0);
      expect(res.body.totalCreditsRemaining).toBe(0);
      expect(res.body.totalCalls).toBe(0);
      expect(res.body.byNamespace).toEqual({});
      expect(res.body.byGroup).toEqual({});
    } finally {
      await freshServer.stop();
    }
  });

  // ─── Response shape ───
  test('response has all expected fields', async () => {
    const res = await httpGet(port, '/keys/stats', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(typeof res.body.total).toBe('number');
    expect(typeof res.body.active).toBe('number');
    expect(typeof res.body.suspended).toBe('number');
    expect(typeof res.body.expired).toBe('number');
    expect(typeof res.body.revoked).toBe('number');
    expect(typeof res.body.totalCreditsAllocated).toBe('number');
    expect(typeof res.body.totalCreditsSpent).toBe('number');
    expect(typeof res.body.totalCreditsRemaining).toBe('number');
    expect(typeof res.body.totalCalls).toBe('number');
    expect(typeof res.body.byNamespace).toBe('object');
    expect(typeof res.body.byGroup).toBe('object');
  });

  // ─── Group breakdown with namespace filter ───
  test('group breakdown respects namespace filter', async () => {
    const res = await httpGet(port, '/keys/stats?namespace=staging', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    // key4 (staging, enterprise) and key5 (staging, starter)
    expect(res.body.byGroup.enterprise).toBe(1);
    expect(res.body.byGroup.starter).toBe(1);
  });

  // ─── No group keys ───
  test('byGroup excludes keys without groups', async () => {
    const res = await httpGet(port, '/keys/stats', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    // Total grouped: enterprise=2, starter=1 → 3 keys in groups
    const groupedCount = Object.values(res.body.byGroup).reduce((a: number, b: any) => a + b, 0);
    expect(groupedCount).toBeLessThan(res.body.total);
  });
});
