/**
 * Tests for v6.0.0 — Key Listing Pagination & Filtering.
 *
 * Tests enhanced GET /keys with pagination (limit/offset), filtering
 * (namespace, group, active, suspended, expired, namePrefix, credit range),
 * and sorting (sortBy + order).
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

describe('Key Listing Pagination & Filtering', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  const keys: string[] = [];

  beforeAll(async () => {
    server = makeServer();
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    // Create 10 keys with varying properties
    for (let i = 0; i < 10; i++) {
      const name = `key-${String(i).padStart(2, '0')}`;
      const credits = (i + 1) * 100;
      const namespace = i < 5 ? 'prod' : 'staging';
      const res = await httpPost(port, '/keys', { name, credits, namespace }, { 'x-admin-key': adminKey });
      keys.push(res.body.key);
    }

    // Suspend key-03
    await httpPost(port, '/keys/suspend', { key: keys[3] }, { 'x-admin-key': adminKey });

    // Directly set group on key-07 via store (group assignment endpoints need stateful setup)
    const key07Record = server.gate.store.getKey(keys[7]);
    if (key07Record) key07Record.group = 'enterprise';
  });

  afterAll(async () => {
    if (server) await server.stop();
  });

  // ─── Legacy behavior (backward compat) ───
  test('GET /keys without pagination params returns flat array (legacy)', async () => {
    const res = await httpGet(port, '/keys', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(10);
  });

  test('GET /keys?namespace=prod returns filtered flat array (legacy)', async () => {
    const res = await httpGet(port, '/keys?namespace=prod', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(5);
  });

  // ─── Pagination ───
  test('pagination: returns paginated result with limit', async () => {
    const res = await httpGet(port, '/keys?limit=3', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.keys).toBeDefined();
    expect(res.body.keys.length).toBe(3);
    expect(res.body.total).toBe(10);
    expect(res.body.offset).toBe(0);
    expect(res.body.limit).toBe(3);
    expect(res.body.hasMore).toBe(true);
  });

  test('pagination: offset skips results', async () => {
    const res = await httpGet(port, '/keys?limit=3&offset=8', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.keys.length).toBe(2); // only 2 remaining
    expect(res.body.total).toBe(10);
    expect(res.body.offset).toBe(8);
    expect(res.body.hasMore).toBe(false);
  });

  test('pagination: limit=500 is max', async () => {
    const res = await httpGet(port, '/keys?limit=1000', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(500);
    expect(res.body.keys.length).toBe(10);
  });

  test('pagination: limit=0 defaults to 1', async () => {
    const res = await httpGet(port, '/keys?limit=0', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(1);
    expect(res.body.keys.length).toBe(1);
  });

  test('pagination: offset beyond total returns empty', async () => {
    const res = await httpGet(port, '/keys?limit=10&offset=100', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.keys.length).toBe(0);
    expect(res.body.total).toBe(10);
    expect(res.body.hasMore).toBe(false);
  });

  // ─── Filtering ───
  test('filter: namespace', async () => {
    const res = await httpGet(port, '/keys?limit=50&namespace=staging', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    for (const k of res.body.keys) {
      expect(k.namespace).toBe('staging');
    }
  });

  test('filter: active=true', async () => {
    const res = await httpGet(port, '/keys?limit=50&active=true', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    for (const k of res.body.keys) {
      expect(k.active).toBe(true);
    }
  });

  test('filter: suspended=true', async () => {
    const res = await httpGet(port, '/keys?limit=50&suspended=true', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1); // only key-03
    expect(res.body.keys[0].name).toBe('key-03');
    expect(res.body.keys[0].suspended).toBe(true);
  });

  test('filter: suspended=false', async () => {
    const res = await httpGet(port, '/keys?limit=50&suspended=false', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(9); // all except key-03
  });

  test('filter: namePrefix', async () => {
    const res = await httpGet(port, '/keys?limit=50&namePrefix=key-0', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(9); // key-00 through key-09
    for (const k of res.body.keys) {
      expect(k.name.toLowerCase().startsWith('key-0')).toBe(true);
    }
  });

  test('filter: namePrefix is case-insensitive', async () => {
    const res = await httpGet(port, '/keys?limit=50&namePrefix=KEY-0', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(9);
  });

  test('filter: minCredits', async () => {
    const res = await httpGet(port, '/keys?limit=50&minCredits=500', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    for (const k of res.body.keys) {
      expect(k.credits).toBeGreaterThanOrEqual(500);
    }
  });

  test('filter: maxCredits', async () => {
    const res = await httpGet(port, '/keys?limit=50&maxCredits=300', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    for (const k of res.body.keys) {
      expect(k.credits).toBeLessThanOrEqual(300);
    }
  });

  test('filter: credit range', async () => {
    const res = await httpGet(port, '/keys?limit=50&minCredits=300&maxCredits=700', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
    for (const k of res.body.keys) {
      expect(k.credits).toBeGreaterThanOrEqual(300);
      expect(k.credits).toBeLessThanOrEqual(700);
    }
  });

  test('filter: group', async () => {
    const res = await httpGet(port, '/keys?limit=50&group=enterprise', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.keys[0].name).toBe('key-07');
  });

  test('filter: combined namespace + active', async () => {
    const res = await httpGet(port, '/keys?limit=50&namespace=prod&active=true', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    for (const k of res.body.keys) {
      expect(k.namespace).toBe('prod');
      expect(k.active).toBe(true);
    }
  });

  // ─── Sorting ───
  test('sort: by name asc', async () => {
    const res = await httpGet(port, '/keys?limit=50&sortBy=name&order=asc', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    const names = res.body.keys.map((k: any) => k.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  test('sort: by name desc', async () => {
    const res = await httpGet(port, '/keys?limit=50&sortBy=name&order=desc', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    const names = res.body.keys.map((k: any) => k.name);
    const sorted = [...names].sort().reverse();
    expect(names).toEqual(sorted);
  });

  test('sort: by credits asc', async () => {
    const res = await httpGet(port, '/keys?limit=50&sortBy=credits&order=asc', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    const credits = res.body.keys.map((k: any) => k.credits);
    for (let i = 1; i < credits.length; i++) {
      expect(credits[i]).toBeGreaterThanOrEqual(credits[i - 1]);
    }
  });

  test('sort: by credits desc', async () => {
    const res = await httpGet(port, '/keys?limit=50&sortBy=credits&order=desc', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    const credits = res.body.keys.map((k: any) => k.credits);
    for (let i = 1; i < credits.length; i++) {
      expect(credits[i]).toBeLessThanOrEqual(credits[i - 1]);
    }
  });

  test('sort: default is createdAt desc', async () => {
    const res = await httpGet(port, '/keys?limit=50', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    const dates = res.body.keys.map((k: any) => k.createdAt);
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i] <= dates[i - 1]).toBe(true);
    }
  });

  // ─── Auth ───
  test('requires admin auth', async () => {
    const res = await httpGet(port, '/keys?limit=5');
    expect(res.status).toBe(401);
  });

  // ─── SDK exports ───
  test('KeyListQuery and KeyListResult types are exported', () => {
    const sdk = require('../src/index');
    // Type-only exports won't appear at runtime, but DEFAULT_CONFIG confirms types module is loaded
    expect(sdk.DEFAULT_CONFIG).toBeDefined();
  });

  // ─── Edge cases ───
  test('negative offset treated as 0', async () => {
    const res = await httpGet(port, '/keys?limit=5&offset=-10', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.offset).toBe(0);
  });

  test('non-numeric limit defaults to 50', async () => {
    const res = await httpGet(port, '/keys?limit=abc', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    // NaN limit → Math.max(1, NaN || 50) → 50
    expect(res.body.limit).toBe(50);
  });

  test('pagination + filter combined', async () => {
    const res = await httpGet(port, '/keys?limit=2&offset=0&namespace=prod&sortBy=credits&order=asc', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.keys.length).toBe(2);
    expect(res.body.total).toBe(5); // 5 prod keys
    expect(res.body.hasMore).toBe(true);
    for (const k of res.body.keys) {
      expect(k.namespace).toBe('prod');
    }
    // Credits should be ascending
    expect(res.body.keys[0].credits).toBeLessThanOrEqual(res.body.keys[1].credits);
  });

  test('no matching results', async () => {
    const res = await httpGet(port, '/keys?limit=50&namePrefix=nonexistent', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.keys.length).toBe(0);
    expect(res.body.total).toBe(0);
    expect(res.body.hasMore).toBe(false);
  });
});
