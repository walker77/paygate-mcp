/**
 * Tests for v8.36.0 — Credit Distribution
 *
 * GET /admin/credit-distribution — Histogram of credit balances across
 * active keys, showing how credits are distributed in configurable
 * buckets for capacity and pricing analysis.
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

describe('Credit Distribution', () => {
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

    const r = await httpGet(port, '/admin/credit-distribution', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.buckets)).toBe(true);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalKeys).toBe('number');
    expect(typeof r.body.summary.medianCredits).toBe('number');
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/credit-distribution', { 'X-Admin-Key': adminKey });

    expect(r.body.buckets.length).toBe(0);
    expect(r.body.summary.totalKeys).toBe(0);
    expect(r.body.summary.medianCredits).toBe(0);
  });

  test('places keys in correct buckets', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // 5 credits → 0-10 bucket
    await httpPost(port, '/keys', { credits: 5, name: 'tiny' }, { 'X-Admin-Key': adminKey });
    // 50 credits → 11-50 bucket
    await httpPost(port, '/keys', { credits: 50, name: 'small' }, { 'X-Admin-Key': adminKey });
    // 100 credits → 51-100 bucket
    await httpPost(port, '/keys', { credits: 100, name: 'medium' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/credit-distribution', { 'X-Admin-Key': adminKey });

    const b0 = r.body.buckets.find((b: any) => b.range === '0-10');
    expect(b0).toBeDefined();
    expect(b0.count).toBe(1);

    const b1 = r.body.buckets.find((b: any) => b.range === '11-50');
    expect(b1).toBeDefined();
    expect(b1.count).toBe(1);

    const b2 = r.body.buckets.find((b: any) => b.range === '51-100');
    expect(b2).toBeDefined();
    expect(b2.count).toBe(1);
  });

  test('high credit keys go to 1001+ bucket', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 5000, name: 'whale' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/credit-distribution', { 'X-Admin-Key': adminKey });

    const big = r.body.buckets.find((b: any) => b.range === '1001+');
    expect(big).toBeDefined();
    expect(big.count).toBe(1);
    expect(big.totalCredits).toBe(5000);
  });

  test('calculates median credits correctly', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create keys with credits: 10, 50, 100 → median = 50
    await httpPost(port, '/keys', { credits: 10, name: 'k1' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 50, name: 'k2' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 100, name: 'k3' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/credit-distribution', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.medianCredits).toBe(50);
  });

  test('includes total credits per bucket', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 5, name: 'k1' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 8, name: 'k2' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/credit-distribution', { 'X-Admin-Key': adminKey });

    const b0 = r.body.buckets.find((b: any) => b.range === '0-10');
    expect(b0.totalCredits).toBe(13);
    expect(b0.count).toBe(2);
  });

  test('excludes revoked and suspended keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'revoked' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'suspended' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys', { credits: 50, name: 'active' }, { 'X-Admin-Key': adminKey });

    await httpPost(port, '/keys/revoke', { key: k1 }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys/suspend', { key: k2 }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/credit-distribution', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalKeys).toBe(1);
  });

  test('buckets sorted by range ascending', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 5, name: 'k1' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 500, name: 'k2' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 5000, name: 'k3' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/credit-distribution', { 'X-Admin-Key': adminKey });

    const ranges = r.body.buckets.map((b: any) => b.range);
    const order = ['0-10', '11-50', '51-100', '101-500', '501-1000', '1001+'];
    const filtered = order.filter(o => ranges.includes(o));
    expect(ranges).toEqual(filtered);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/credit-distribution');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/credit-distribution', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.creditDistribution).toBeDefined();
    expect(r.body.endpoints.creditDistribution).toContain('/admin/credit-distribution');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/credit-distribution', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/credit-distribution', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
