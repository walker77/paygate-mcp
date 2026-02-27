/**
 * Tests for v8.52.0 — Tool Error Rate
 *
 * GET /admin/tool-error-rate — Per-tool error rates showing denied vs
 * allowed requests, denial reasons, and overall reliability metrics.
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

describe('Tool Error Rate', () => {
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

    const r = await httpGet(port, '/admin/tool-error-rate', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.tools)).toBe(true);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalTools).toBe('number');
    expect(typeof r.body.summary.overallErrorRate).toBe('number');
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no activity', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/tool-error-rate', { 'X-Admin-Key': adminKey });

    expect(r.body.tools.length).toBe(0);
    expect(r.body.summary.totalTools).toBe(0);
    expect(r.body.summary.overallErrorRate).toBe(0);
  });

  test('shows per-tool error rate', async () => {
    server = makeServer({ defaultCreditsPerCall: 100 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 150, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;

    // tool_a: 1 allowed (100 credits used, 50 left)
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    // tool_a: 1 denied (50 < 100 needed)
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/tool-error-rate', { 'X-Admin-Key': adminKey });

    const toolA = r.body.tools.find((t: any) => t.tool === 'tool_a');
    expect(toolA).toBeDefined();
    expect(toolA.totalRequests).toBe(2);
    expect(toolA.allowed).toBe(1);
    expect(toolA.denied).toBe(1);
    expect(toolA.errorRate).toBe(50);
  });

  test('tools with zero errors have 0% rate', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 200, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/tool-error-rate', { 'X-Admin-Key': adminKey });

    const toolA = r.body.tools.find((t: any) => t.tool === 'tool_a');
    expect(toolA.errorRate).toBe(0);
    expect(toolA.allowed).toBe(2);
    expect(toolA.denied).toBe(0);
  });

  test('sorted by error rate descending', async () => {
    server = makeServer({ defaultCreditsPerCall: 50 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 200, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 75, name: 'user2' }, { 'X-Admin-Key': adminKey })).body.key;

    // tool_a: 2 allowed via k1 (0% error)
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });

    // tool_b: 1 allowed + 1 denied via k2 (50% error)
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k2 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/tool-error-rate', { 'X-Admin-Key': adminKey });

    expect(r.body.tools[0].tool).toBe('tool_b');
    expect(r.body.tools[0].errorRate).toBeGreaterThan(0);
    expect(r.body.tools[1].tool).toBe('tool_a');
    expect(r.body.tools[1].errorRate).toBe(0);
  });

  test('overall error rate in summary', async () => {
    server = makeServer({ defaultCreditsPerCall: 100 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 250, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;

    // 2 allowed, 1 denied = 33.33% overall error rate
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_c', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/tool-error-rate', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.overallErrorRate).toBeGreaterThan(0);
    expect(typeof r.body.summary.overallErrorRate).toBe('number');
  });

  test('includes highestErrorTool in summary', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 200, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/tool-error-rate', { 'X-Admin-Key': adminKey });

    // With all successful, the highest error tool is the one with 0% — or null if all are 0
    expect(r.body.summary.highestErrorTool === null || typeof r.body.summary.highestErrorTool === 'string').toBe(true);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/tool-error-rate');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/tool-error-rate', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.toolErrorRate).toBeDefined();
    expect(r.body.endpoints.toolErrorRate).toContain('/admin/tool-error-rate');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/tool-error-rate', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/tool-error-rate', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
