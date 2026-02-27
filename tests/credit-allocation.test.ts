/**
 * Tests for v8.48.0 — Credit Allocation Summary
 *
 * GET /admin/credit-allocation — Shows how credits are distributed across
 * the system with tiers, totals, and allocation efficiency.
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

describe('Credit Allocation Summary', () => {
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

    const r = await httpGet(port, '/admin/credit-allocation', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.tiers)).toBe(true);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalKeys).toBe('number');
    expect(typeof r.body.summary.totalAllocated).toBe('number');
    expect(typeof r.body.summary.totalRemaining).toBe('number');
    expect(typeof r.body.summary.totalSpent).toBe('number');
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/credit-allocation', { 'X-Admin-Key': adminKey });

    expect(r.body.tiers.length).toBe(0);
    expect(r.body.summary.totalKeys).toBe(0);
    expect(r.body.summary.totalAllocated).toBe(0);
    expect(r.body.summary.totalRemaining).toBe(0);
    expect(r.body.summary.totalSpent).toBe(0);
  });

  test('calculates allocation tiers', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Small allocation (1-100)
    await httpPost(port, '/keys', { credits: 50, name: 'small1' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 80, name: 'small2' }, { 'X-Admin-Key': adminKey });

    // Medium allocation (101-500)
    await httpPost(port, '/keys', { credits: 200, name: 'medium' }, { 'X-Admin-Key': adminKey });

    // Large allocation (501+)
    await httpPost(port, '/keys', { credits: 1000, name: 'large' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/credit-allocation', { 'X-Admin-Key': adminKey });

    expect(r.body.tiers.length).toBeGreaterThanOrEqual(3);
    const small = r.body.tiers.find((t: any) => t.tier === '1-100');
    expect(small.count).toBe(2);
    const medium = r.body.tiers.find((t: any) => t.tier === '101-500');
    expect(medium.count).toBe(1);
    const large = r.body.tiers.find((t: any) => t.tier === '501+');
    expect(large.count).toBe(1);
  });

  test('summary totals are correct', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'u1' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys', { credits: 200, name: 'u2' }, { 'X-Admin-Key': adminKey });

    // Spend 30 from k
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/credit-allocation', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalKeys).toBe(2);
    expect(r.body.summary.totalAllocated).toBe(300); // 100 + 200
    expect(r.body.summary.totalSpent).toBe(30);
    expect(r.body.summary.totalRemaining).toBe(270); // 70 + 200
  });

  test('tier includes totalCredits', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 50, name: 'k1' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 80, name: 'k2' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/credit-allocation', { 'X-Admin-Key': adminKey });

    const small = r.body.tiers.find((t: any) => t.tier === '1-100');
    expect(small.totalCredits).toBe(130); // 50 + 80
  });

  test('tier includes percentage', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'k1' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 300, name: 'k2' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/credit-allocation', { 'X-Admin-Key': adminKey });

    // Percentages based on total allocated credits
    for (const tier of r.body.tiers) {
      expect(typeof tier.percentage).toBe('number');
    }
  });

  test('excludes revoked and suspended keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'revoked' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'suspended' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys', { credits: 100, name: 'active' }, { 'X-Admin-Key': adminKey });

    await httpPost(port, '/keys/revoke', { key: k1 }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys/suspend', { key: k2 }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/credit-allocation', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalKeys).toBe(1);
  });

  test('tiers sorted by range ascending', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 50, name: 'small' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 200, name: 'medium' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 1000, name: 'large' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/credit-allocation', { 'X-Admin-Key': adminKey });

    const order = ['1-100', '101-500', '501+'];
    const tiers = r.body.tiers.map((t: any) => t.tier);
    const filtered = order.filter(o => tiers.includes(o));
    expect(tiers).toEqual(filtered);
  });

  test('includes averageAllocation in summary', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'k1' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 200, name: 'k2' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/credit-allocation', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.averageAllocation).toBe(150);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/credit-allocation');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/credit-allocation', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.creditAllocation).toBeDefined();
    expect(r.body.endpoints.creditAllocation).toContain('/admin/credit-allocation');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/credit-allocation', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/credit-allocation', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
