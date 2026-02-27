/**
 * Tests for v8.21.0 — Key Age Analysis
 *
 * GET /admin/key-age — Key age distribution: oldest/newest keys,
 * average lifespan, age buckets (24h/7d/30d/older), and recently
 * created keys list.
 */

import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';
import http from 'http';

/* ── helpers ─────────────────────────────────────────────── */

const ECHO_CMD = process.execPath;
const ECHO_ARGS = ['-e', `
  process.stdin.resume();
  process.stdin.on('data', d => {
    const r = JSON.parse(d.toString().trim());
    if (r.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { tools: [
        { name: 'tool_a', inputSchema: { type: 'object' } },
        { name: 'tool_b', inputSchema: { type: 'object' } },
        { name: 'tool_c', inputSchema: { type: 'object' } },
      ] } }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { content: [{ type: 'text', text: 'ok' }] } }) + '\\n');
    }
  });
`];

function makeServer(overrides: Record<string, any> = {}): PayGateServer {
  return new PayGateServer({
    ...DEFAULT_CONFIG,
    serverCommand: ECHO_CMD,
    serverArgs: ECHO_ARGS,
    port: 0,
    ...overrides,
  });
}

function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        let buf = '';
        res.on('data', (c: Buffer) => (buf += c));
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

function httpPost(port: number, path: string, body: any, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let buf = '';
        res.on('data', (c: Buffer) => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode!, body: buf }); }
        });
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

/* ── tests ───────────────────────────────────────────────── */

describe('Key Age Analysis', () => {
  jest.setTimeout(15000);

  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('returns complete structure', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/key-age', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalKeys).toBe('number');
    expect(typeof r.body.summary.avgAgeHours).toBe('number');
    expect(r.body.distribution).toBeDefined();
    expect(Array.isArray(r.body.recentlyCreated)).toBe(true);
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/key-age', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalKeys).toBe(0);
    expect(r.body.summary.avgAgeHours).toBe(0);
    expect(r.body.recentlyCreated.length).toBe(0);
  });

  test('tracks newly created keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'fresh-key' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/key-age', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalKeys).toBe(1);
    expect(r.body.recentlyCreated.length).toBe(1);
    expect(r.body.recentlyCreated[0].keyName).toBe('fresh-key');
    expect(typeof r.body.recentlyCreated[0].ageHours).toBe('number');
    expect(r.body.recentlyCreated[0].ageHours).toBeLessThan(1); // Just created
  });

  test('distribution buckets', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'key1' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 100, name: 'key2' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/key-age', { 'X-Admin-Key': adminKey });

    expect(typeof r.body.distribution.last24h).toBe('number');
    expect(typeof r.body.distribution.last7d).toBe('number');
    expect(typeof r.body.distribution.last30d).toBe('number');
    expect(typeof r.body.distribution.older).toBe('number');
    // All newly created keys should be in last24h
    expect(r.body.distribution.last24h).toBe(2);
  });

  test('oldest and newest keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'first' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 100, name: 'second' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/key-age', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.oldestKey).toBeDefined();
    expect(r.body.summary.newestKey).toBeDefined();
    // newest should be 'second' (created after 'first')
    expect(r.body.summary.newestKey.keyName).toBe('second');
  });

  test('recently created returns all keys sorted by age', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'a' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 100, name: 'b' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 100, name: 'c' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/key-age', { 'X-Admin-Key': adminKey });

    expect(r.body.recentlyCreated.length).toBe(3);
    // All should have low age (just created)
    for (const k of r.body.recentlyCreated) {
      expect(k.ageHours).toBeLessThan(1);
      expect(k).toHaveProperty('keyName');
      expect(k).toHaveProperty('createdAt');
    }
    // Sorted by age ascending (newest first)
    for (let i = 1; i < r.body.recentlyCreated.length; i++) {
      expect(r.body.recentlyCreated[i - 1].ageHours).toBeLessThanOrEqual(r.body.recentlyCreated[i].ageHours);
    }
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/key-age');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/key-age', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.keyAge).toBeDefined();
    expect(r.body.endpoints.keyAge).toContain('/admin/key-age');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/key-age', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/key-age', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
