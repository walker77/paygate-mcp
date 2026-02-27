/**
 * Tests for v8.10.0 — Revenue Analysis
 *
 * GET /admin/revenue — Revenue metrics with per-tool revenue, per-key spending,
 * daily/hourly revenue trends, top earners, and credit flow summary.
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

describe('Revenue Analysis', () => {
  jest.setTimeout(15000);

  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    await server.stop();
  });

  test('returns complete revenue analysis structure', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/revenue', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalRevenue).toBe('number');
    expect(typeof r.body.summary.totalCalls).toBe('number');
    expect(typeof r.body.summary.averageRevenuePerCall).toBe('number');
    expect(Array.isArray(r.body.byTool)).toBe(true);
    expect(Array.isArray(r.body.byKey)).toBe(true);
    expect(Array.isArray(r.body.hourlyRevenue)).toBe(true);
  });

  test('zero activity returns zeroed metrics', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/revenue', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalRevenue).toBe(0);
    expect(r.body.summary.totalCalls).toBe(0);
    expect(r.body.summary.averageRevenuePerCall).toBe(0);
    expect(r.body.byTool).toHaveLength(0);
    expect(r.body.byKey).toHaveLength(0);
  });

  test('tracks revenue from successful calls', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 1000, name: 'spender' }, { 'X-Admin-Key': adminKey })).body.key;

    // Make tool calls
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/revenue', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalRevenue).toBe(20);
    expect(r.body.summary.totalCalls).toBe(2);
    expect(r.body.summary.averageRevenuePerCall).toBe(10);
  });

  test('per-tool revenue breakdown', async () => {
    server = makeServer({ defaultCreditsPerCall: 5, toolPricing: { tool_a: { creditsPerCall: 10 }, tool_b: { creditsPerCall: 20 } } });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 1000, name: 'multi' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/revenue', { 'X-Admin-Key': adminKey });

    const toolA = r.body.byTool.find((t: any) => t.tool === 'tool_a');
    const toolB = r.body.byTool.find((t: any) => t.tool === 'tool_b');

    expect(toolA).toBeDefined();
    expect(toolA.revenue).toBe(20);
    expect(toolA.calls).toBe(2);

    expect(toolB).toBeDefined();
    expect(toolB.revenue).toBe(20);
    expect(toolB.calls).toBe(1);
  });

  test('per-key spending breakdown', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 1000, name: 'alice' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 1000, name: 'bob' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/revenue', { 'X-Admin-Key': adminKey });

    const alice = r.body.byKey.find((k: any) => k.name === 'alice');
    const bob = r.body.byKey.find((k: any) => k.name === 'bob');

    expect(alice).toBeDefined();
    expect(alice.revenue).toBe(20);
    expect(alice.calls).toBe(2);

    expect(bob).toBeDefined();
    expect(bob.revenue).toBe(10);
    expect(bob.calls).toBe(1);
  });

  test('byTool is sorted by revenue descending', async () => {
    server = makeServer({ defaultCreditsPerCall: 5, toolPricing: { tool_a: { creditsPerCall: 10 }, tool_b: { creditsPerCall: 50 } } });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 5000, name: 'sorter' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/revenue', { 'X-Admin-Key': adminKey });

    expect(r.body.byTool[0].tool).toBe('tool_b');
    expect(r.body.byTool[0].revenue).toBe(50);
  });

  test('byKey is sorted by revenue descending', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 1000, name: 'light' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 1000, name: 'heavy' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/revenue', { 'X-Admin-Key': adminKey });

    expect(r.body.byKey[0].name).toBe('heavy');
    expect(r.body.byKey[0].revenue).toBe(30);
  });

  test('hourly revenue structure', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 1000, name: 'hourly' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/revenue', { 'X-Admin-Key': adminKey });

    expect(r.body.hourlyRevenue.length).toBeGreaterThan(0);
    const entry = r.body.hourlyRevenue[0];
    expect(typeof entry.hour).toBe('string');
    expect(typeof entry.revenue).toBe('number');
    expect(typeof entry.calls).toBe('number');
  });

  test('denied calls do not count as revenue', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 5, name: 'poor' }, { 'X-Admin-Key': adminKey })).body.key;

    // This call should be denied (5 credits but needs 10)
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/revenue', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalRevenue).toBe(0);
  });

  test('credit flow shows allocated vs spent', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 1000, name: 'flow' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/revenue', { 'X-Admin-Key': adminKey });

    expect(r.body.creditFlow).toBeDefined();
    expect(r.body.creditFlow.totalAllocated).toBeGreaterThanOrEqual(1000);
    expect(r.body.creditFlow.totalSpent).toBe(10);
    expect(r.body.creditFlow.totalRemaining).toBeGreaterThanOrEqual(990);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/revenue');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/revenue', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.revenueAnalysis).toBeDefined();
    expect(r.body.endpoints.revenueAnalysis).toContain('/admin/revenue');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/revenue', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/revenue', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
