/**
 * Tests for v8.18.0 — Tool Latency Analysis
 *
 * GET /admin/latency — Per-tool response time metrics: average, p95, min,
 * max durations, slowest tools ranking, latency distribution, and
 * per-key latency breakdown.
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

describe('Tool Latency Analysis', () => {
  jest.setTimeout(15000);

  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('returns complete latency structure', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/latency', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalCalls).toBe('number');
    expect(Array.isArray(r.body.byTool)).toBe(true);
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no calls made', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/latency', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalCalls).toBe(0);
    expect(r.body.summary.avgDurationMs).toBe(0);
    expect(r.body.byTool.length).toBe(0);
  });

  test('tracks per-tool latency metrics', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 1000, name: 'latency-user' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/latency', { 'X-Admin-Key': adminKey });

    const toolA = r.body.byTool.find((t: any) => t.tool === 'tool_a');
    expect(toolA).toBeDefined();
    expect(toolA.totalCalls).toBe(2);
    expect(typeof toolA.avgDurationMs).toBe('number');
    expect(typeof toolA.minDurationMs).toBe('number');
    expect(typeof toolA.maxDurationMs).toBe('number');
    expect(typeof toolA.p95DurationMs).toBe('number');
    expect(toolA.minDurationMs).toBeLessThanOrEqual(toolA.avgDurationMs);
    expect(toolA.maxDurationMs).toBeGreaterThanOrEqual(toolA.avgDurationMs);

    const toolB = r.body.byTool.find((t: any) => t.tool === 'tool_b');
    expect(toolB).toBeDefined();
    expect(toolB.totalCalls).toBe(1);
  });

  test('sorted by slowest average first', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 1000, name: 'sorter' }, { 'X-Admin-Key': adminKey })).body.key;

    // Make multiple calls — actual durations depend on execution time
    for (let i = 1; i <= 3; i++) {
      await httpPost(port, '/mcp', { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    }
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/latency', { 'X-Admin-Key': adminKey });

    // Just verify they are sorted by avgDurationMs descending
    for (let i = 1; i < r.body.byTool.length; i++) {
      expect(r.body.byTool[i - 1].avgDurationMs).toBeGreaterThanOrEqual(r.body.byTool[i].avgDurationMs);
    }
  });

  test('summary aggregates across all tools', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 1000, name: 'summary-user' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/latency', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalCalls).toBe(3);
    expect(typeof r.body.summary.avgDurationMs).toBe('number');
    expect(typeof r.body.summary.minDurationMs).toBe('number');
    expect(typeof r.body.summary.maxDurationMs).toBe('number');
    expect(typeof r.body.summary.p95DurationMs).toBe('number');
    expect(r.body.summary.avgDurationMs).toBeGreaterThanOrEqual(0);
  });

  test('slowest tools ranking', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 1000, name: 'ranking' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/latency', { 'X-Admin-Key': adminKey });

    expect(Array.isArray(r.body.slowestTools)).toBe(true);
    expect(r.body.slowestTools.length).toBeGreaterThanOrEqual(1);
    expect(r.body.slowestTools[0]).toHaveProperty('tool');
    expect(r.body.slowestTools[0]).toHaveProperty('avgDurationMs');
  });

  test('only counts allowed calls', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Key with very few credits — second call will be denied
    const k = (await httpPost(port, '/keys', { credits: 5, name: 'limited' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/latency', { 'X-Admin-Key': adminKey });

    // Only the allowed call should be counted
    expect(r.body.summary.totalCalls).toBe(1);
  });

  test('per-key latency breakdown', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 1000, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 1000, name: 'user2' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/latency', { 'X-Admin-Key': adminKey });

    expect(Array.isArray(r.body.byKey)).toBe(true);
    expect(r.body.byKey.length).toBe(2);

    const user1 = r.body.byKey.find((k: any) => k.keyName === 'user1');
    expect(user1).toBeDefined();
    expect(user1.totalCalls).toBe(1);
    expect(typeof user1.avgDurationMs).toBe('number');
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/latency');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/latency', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.latencyAnalysis).toBeDefined();
    expect(r.body.endpoints.latencyAnalysis).toContain('/admin/latency');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/latency', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/latency', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
