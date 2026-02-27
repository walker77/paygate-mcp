/**
 * Tests for v8.31.0 — Credit Efficiency
 *
 * GET /admin/credit-efficiency — Credit allocation efficiency analysis
 * with waste ratio, burn efficiency, over/under-provisioned key detection,
 * and allocation recommendations.
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

describe('Credit Efficiency', () => {
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

    const r = await httpGet(port, '/admin/credit-efficiency', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalAllocated).toBe('number');
    expect(typeof r.body.summary.totalSpent).toBe('number');
    expect(typeof r.body.summary.totalRemaining).toBe('number');
    expect(typeof r.body.summary.burnEfficiency).toBe('number');
    expect(typeof r.body.summary.wasteRatio).toBe('number');
    expect(Array.isArray(r.body.overProvisioned)).toBe(true);
    expect(Array.isArray(r.body.underProvisioned)).toBe(true);
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/credit-efficiency', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalAllocated).toBe(0);
    expect(r.body.summary.burnEfficiency).toBe(0);
    expect(r.body.summary.wasteRatio).toBe(0);
    expect(r.body.overProvisioned.length).toBe(0);
    expect(r.body.underProvisioned.length).toBe(0);
  });

  test('calculates burn efficiency correctly', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'spender' }, { 'X-Admin-Key': adminKey })).body.key;

    // Spend 50 of 100 credits (5 calls at 10 each)
    for (let i = 0; i < 5; i++) {
      await httpPost(port, '/mcp', {
        jsonrpc: '2.0', id: i + 1, method: 'tools/call',
        params: { name: 'tool_a', arguments: {} }
      }, { 'X-API-Key': k });
    }

    const r = await httpGet(port, '/admin/credit-efficiency', { 'X-Admin-Key': adminKey });

    // burnEfficiency = totalSpent / totalAllocated * 100 = 50/100 * 100 = 50%
    expect(r.body.summary.burnEfficiency).toBe(50);
    expect(r.body.summary.totalSpent).toBe(50);
    expect(r.body.summary.totalRemaining).toBe(50);
  });

  test('detects over-provisioned keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create a key with 1000 credits but only spend 5 (over-provisioned: >90% remaining)
    const k = (await httpPost(port, '/keys', { credits: 1000, name: 'idle-whale' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} }
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/credit-efficiency', { 'X-Admin-Key': adminKey });

    expect(r.body.overProvisioned.length).toBeGreaterThanOrEqual(1);
    const over = r.body.overProvisioned.find((k: any) => k.name === 'idle-whale');
    expect(over).toBeDefined();
    expect(over.remainingPercent).toBeGreaterThan(90);
  });

  test('detects under-provisioned keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create a key with just enough credits for 2 calls (10 credits, 5 per call)
    const k = (await httpPost(port, '/keys', { credits: 10, name: 'low-budget' }, { 'X-Admin-Key': adminKey })).body.key;

    // Use most credits (spend 5 of 10 → 50% remaining, but low absolute remaining)
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} }
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/credit-efficiency', { 'X-Admin-Key': adminKey });

    // Under-provisioned: <=10 credits remaining or <=10% remaining
    expect(r.body.underProvisioned.length).toBeGreaterThanOrEqual(1);
    const under = r.body.underProvisioned.find((k: any) => k.name === 'low-budget');
    expect(under).toBeDefined();
  });

  test('waste ratio reflects unused credits', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create key with 100 credits but don't use any
    await httpPost(port, '/keys', { credits: 100, name: 'idle' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/credit-efficiency', { 'X-Admin-Key': adminKey });

    // wasteRatio = totalRemaining / totalAllocated * 100 = 100/100 * 100 = 100%
    expect(r.body.summary.wasteRatio).toBe(100);
    expect(r.body.summary.burnEfficiency).toBe(0);
  });

  test('over-provisioned sorted by remaining credits descending', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create two over-provisioned keys
    const k1 = (await httpPost(port, '/keys', { credits: 500, name: 'whale-small' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 1000, name: 'whale-big' }, { 'X-Admin-Key': adminKey })).body.key;

    // Spend just 5 on each (both >90% remaining)
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/credit-efficiency', { 'X-Admin-Key': adminKey });

    if (r.body.overProvisioned.length >= 2) {
      expect(r.body.overProvisioned[0].credits).toBeGreaterThanOrEqual(r.body.overProvisioned[1].credits);
    }
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/credit-efficiency');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/credit-efficiency', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.creditEfficiency).toBeDefined();
    expect(r.body.endpoints.creditEfficiency).toContain('/admin/credit-efficiency');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/credit-efficiency', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/credit-efficiency', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
