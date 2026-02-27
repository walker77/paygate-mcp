/**
 * Tests for v8.39.0 — Tool Revenue Ranking
 *
 * GET /admin/tool-revenue — Ranks tools by total credits consumed,
 * showing which tools drive the most revenue for pricing and
 * strategy analysis.
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

describe('Tool Revenue Ranking', () => {
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

    const r = await httpGet(port, '/admin/tool-revenue', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.tools)).toBe(true);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalTools).toBe('number');
    expect(typeof r.body.summary.totalRevenue).toBe('number');
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no calls made', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/tool-revenue', { 'X-Admin-Key': adminKey });

    expect(r.body.tools.length).toBe(0);
    expect(r.body.summary.totalTools).toBe(0);
    expect(r.body.summary.totalRevenue).toBe(0);
  });

  test('ranks tools by total credits consumed', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 500, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;

    // 3 calls to tool_a = 30 credits
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    // 1 call to tool_b = 10 credits
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/tool-revenue', { 'X-Admin-Key': adminKey });

    expect(r.body.tools.length).toBe(2);
    // tool_a should be first (most revenue)
    expect(r.body.tools[0].tool).toBe('tool_a');
    expect(r.body.tools[0].totalCredits).toBe(30);
    expect(r.body.tools[0].callCount).toBe(3);
    expect(r.body.tools[1].tool).toBe('tool_b');
    expect(r.body.tools[1].totalCredits).toBe(10);
    expect(r.body.tools[1].callCount).toBe(1);
  });

  test('calculates avg credits per call', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/tool-revenue', { 'X-Admin-Key': adminKey });

    expect(r.body.tools[0].avgCreditsPerCall).toBe(5);
  });

  test('calculates revenue percentage', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 500, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;

    // 3 calls to tool_a = 30 credits (75%)
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    // 1 call to tool_b = 10 credits (25%)
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/tool-revenue', { 'X-Admin-Key': adminKey });

    expect(r.body.tools[0].percentage).toBe(75);
    expect(r.body.tools[1].percentage).toBe(25);
  });

  test('aggregates across multiple consumers', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'u1' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'u2' }, { 'X-Admin-Key': adminKey })).body.key;

    // u1 calls tool_a
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });
    // u2 calls tool_a
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/tool-revenue', { 'X-Admin-Key': adminKey });

    const toolA = r.body.tools.find((t: any) => t.tool === 'tool_a');
    expect(toolA.callCount).toBe(2);
    expect(toolA.totalCredits).toBe(10);
    expect(toolA.uniqueConsumers).toBe(2);
  });

  test('counts unique consumers per tool', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'solo' }, { 'X-Admin-Key': adminKey })).body.key;

    // same consumer calls tool_a twice
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/tool-revenue', { 'X-Admin-Key': adminKey });

    const toolA = r.body.tools.find((t: any) => t.tool === 'tool_a');
    expect(toolA.uniqueConsumers).toBe(1);
  });

  test('summary includes topTool', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 200, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/tool-revenue', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.topTool).toBe('tool_b');
    expect(r.body.summary.totalRevenue).toBe(30);
    expect(r.body.summary.totalTools).toBe(2);
  });

  test('only counts allowed requests', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 5, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;

    // This call succeeds (5 credits)
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    // This call is denied (no credits left)
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/tool-revenue', { 'X-Admin-Key': adminKey });

    const toolA = r.body.tools.find((t: any) => t.tool === 'tool_a');
    expect(toolA.callCount).toBe(1);
    expect(toolA.totalCredits).toBe(5);
  });

  test('sorted by total credits descending', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 500, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;

    // 1 call to tool_c = 5
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_c', arguments: {} } }, { 'X-API-Key': k });
    // 3 calls to tool_b = 15
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });
    // 2 calls to tool_a = 10
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/tool-revenue', { 'X-Admin-Key': adminKey });

    expect(r.body.tools[0].tool).toBe('tool_b');
    expect(r.body.tools[1].tool).toBe('tool_a');
    expect(r.body.tools[2].tool).toBe('tool_c');
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/tool-revenue');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/tool-revenue', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.toolRevenue).toBeDefined();
    expect(r.body.endpoints.toolRevenue).toContain('/admin/tool-revenue');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    await httpGet(port, '/admin/tool-revenue', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/tool-revenue', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(95);
  });
});
