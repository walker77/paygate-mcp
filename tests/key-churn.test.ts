/**
 * Tests for v8.33.0 — Key Churn Analysis
 *
 * GET /admin/key-churn — Key churn metrics with creation vs revocation
 * rates, net growth, churn rate percentage, and retention analysis.
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

describe('Key Churn Analysis', () => {
  jest.setTimeout(15000);

  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    await server.stop();
  });

  test('returns complete structure', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/key-churn', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalKeys).toBe('number');
    expect(typeof r.body.summary.activeKeys).toBe('number');
    expect(typeof r.body.summary.revokedKeys).toBe('number');
    expect(typeof r.body.summary.suspendedKeys).toBe('number');
    expect(typeof r.body.summary.churnRate).toBe('number');
    expect(typeof r.body.summary.retentionRate).toBe('number');
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/key-churn', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalKeys).toBe(0);
    expect(r.body.summary.churnRate).toBe(0);
    expect(r.body.summary.retentionRate).toBe(100);
  });

  test('tracks active and revoked keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'stays' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'goes' }, { 'X-Admin-Key': adminKey })).body.key;

    // Revoke k2
    await httpPost(port, '/keys/revoke', { key: k2 }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/key-churn', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalKeys).toBe(2);
    expect(r.body.summary.activeKeys).toBe(1);
    expect(r.body.summary.revokedKeys).toBe(1);
  });

  test('calculates churn rate correctly', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create 4 keys, revoke 1 → churn rate = 1/4 = 25%
    const keys = [];
    for (let i = 0; i < 4; i++) {
      const k = (await httpPost(port, '/keys', { credits: 100, name: `key${i}` }, { 'X-Admin-Key': adminKey })).body.key;
      keys.push(k);
    }
    await httpPost(port, '/keys/revoke', { key: keys[0] }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/key-churn', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.churnRate).toBe(25);
    expect(r.body.summary.retentionRate).toBe(75);
  });

  test('tracks suspended keys separately', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'suspended' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys/suspend', { key: k }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/key-churn', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.suspendedKeys).toBe(1);
  });

  test('includes never-used keys count', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create 2 keys, use only one
    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'active-user' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys', { credits: 100, name: 'idle' }, { 'X-Admin-Key': adminKey });

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });

    const r = await httpGet(port, '/admin/key-churn', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.neverUsedKeys).toBeDefined();
    expect(r.body.summary.neverUsedKeys).toBeGreaterThanOrEqual(1);
  });

  test('includes average credits per key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'k1' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 200, name: 'k2' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/key-churn', { 'X-Admin-Key': adminKey });

    expect(typeof r.body.summary.avgCreditsPerKey).toBe('number');
    expect(r.body.summary.avgCreditsPerKey).toBe(150);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/key-churn');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/key-churn', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.keyChurn).toBeDefined();
    expect(r.body.endpoints.keyChurn).toContain('/admin/key-churn');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/key-churn', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/key-churn', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
