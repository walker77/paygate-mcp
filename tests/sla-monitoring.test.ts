/**
 * Tests for v8.15.0 — SLA Monitoring
 *
 * GET /admin/sla — Service level metrics: uptime percentage, error rates,
 * per-tool availability, denied vs allowed ratios, and overall SLA health.
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

describe('SLA Monitoring', () => {
  jest.setTimeout(15000);

  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    await server.stop();
  });

  test('returns complete SLA structure', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/sla', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalCalls).toBe('number');
    expect(typeof r.body.summary.allowedCalls).toBe('number');
    expect(typeof r.body.summary.deniedCalls).toBe('number');
    expect(typeof r.body.summary.successRate).toBe('number');
    expect(typeof r.body.uptime).toBe('object');
    expect(Array.isArray(r.body.byTool)).toBe(true);
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('no activity returns baseline metrics', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/sla', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalCalls).toBe(0);
    expect(r.body.summary.successRate).toBe(100);
    expect(r.body.byTool).toHaveLength(0);
  });

  test('tracks success rate across calls', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 1000, name: 'sla-test' }, { 'X-Admin-Key': adminKey })).body.key;

    // 4 successful calls
    for (let i = 1; i <= 4; i++) {
      await httpPost(port, '/mcp', { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    }

    const r = await httpGet(port, '/admin/sla', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalCalls).toBe(4);
    expect(r.body.summary.allowedCalls).toBe(4);
    expect(r.body.summary.deniedCalls).toBe(0);
    expect(r.body.summary.successRate).toBe(100);
  });

  test('calculates denial rate from insufficient credits', async () => {
    server = makeServer({ defaultCreditsPerCall: 100 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'denial-test' }, { 'X-Admin-Key': adminKey })).body.key;

    // 1 success, then denied
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/sla', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalCalls).toBe(3);
    expect(r.body.summary.allowedCalls).toBe(1);
    expect(r.body.summary.deniedCalls).toBe(2);
    // 1/3 = 33.33%
    expect(r.body.summary.successRate).toBeLessThan(50);
  });

  test('per-tool breakdown with availability', async () => {
    server = makeServer({ toolPricing: { tool_a: { creditsPerCall: 5 }, tool_b: { creditsPerCall: 10 } } });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 1000, name: 'multi' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/sla', { 'X-Admin-Key': adminKey });

    expect(r.body.byTool.length).toBeGreaterThanOrEqual(2);
    const toolA = r.body.byTool.find((t: any) => t.tool === 'tool_a');
    const toolB = r.body.byTool.find((t: any) => t.tool === 'tool_b');
    expect(toolA.totalCalls).toBe(2);
    expect(toolA.successRate).toBe(100);
    expect(toolB.totalCalls).toBe(1);
    expect(toolB.successRate).toBe(100);
  });

  test('uptime includes server start time', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/sla', { 'X-Admin-Key': adminKey });

    expect(typeof r.body.uptime.startedAt).toBe('string');
    expect(typeof r.body.uptime.uptimeSeconds).toBe('number');
    expect(r.body.uptime.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  test('per-tool sorted by total calls descending', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 1000, name: 'sorted' }, { 'X-Admin-Key': adminKey })).body.key;

    // 3 calls to tool_a, 1 to tool_b
    for (let i = 1; i <= 3; i++) {
      await httpPost(port, '/mcp', { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    }
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/sla', { 'X-Admin-Key': adminKey });

    expect(r.body.byTool[0].tool).toBe('tool_a');
    expect(r.body.byTool[0].totalCalls).toBe(3);
  });

  test('denial reasons breakdown', async () => {
    server = makeServer({ defaultCreditsPerCall: 100 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'reasons' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/sla', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.denialReasons).toBeDefined();
    expect(typeof r.body.summary.denialReasons).toBe('object');
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/sla');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/sla', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.slaMonitoring).toBeDefined();
    expect(r.body.endpoints.slaMonitoring).toContain('/admin/sla');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/sla', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/sla', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
