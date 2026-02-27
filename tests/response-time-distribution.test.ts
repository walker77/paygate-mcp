/**
 * Tests for v8.37.0 — Response Time Distribution
 *
 * GET /admin/response-time-distribution — Histogram of response times
 * across tool calls, with configurable buckets showing latency distribution
 * for performance monitoring and SLA compliance.
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

describe('Response Time Distribution', () => {
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

    const r = await httpGet(port, '/admin/response-time-distribution', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.buckets)).toBe(true);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalRequests).toBe('number');
    expect(typeof r.body.summary.avgResponseTime).toBe('number');
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no requests', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/response-time-distribution', { 'X-Admin-Key': adminKey });

    expect(r.body.buckets.length).toBe(0);
    expect(r.body.summary.totalRequests).toBe(0);
    expect(r.body.summary.avgResponseTime).toBe(0);
  });

  test('tracks requests in latency buckets', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/response-time-distribution', { 'X-Admin-Key': adminKey });

    expect(r.body.buckets.length).toBeGreaterThanOrEqual(1);
    expect(r.body.summary.totalRequests).toBe(2);
  });

  test('bucket structure has range, count, and percentage', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/response-time-distribution', { 'X-Admin-Key': adminKey });

    const bucket = r.body.buckets[0];
    expect(typeof bucket.range).toBe('string');
    expect(typeof bucket.count).toBe('number');
    expect(typeof bucket.percentage).toBe('number');
    expect(bucket.percentage).toBeGreaterThan(0);
    expect(bucket.percentage).toBeLessThanOrEqual(100);
  });

  test('percentages sum to approximately 100', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;

    for (let i = 0; i < 5; i++) {
      await httpPost(port, '/mcp', { jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    }

    const r = await httpGet(port, '/admin/response-time-distribution', { 'X-Admin-Key': adminKey });

    const totalPct = r.body.buckets.reduce((sum: number, b: any) => sum + b.percentage, 0);
    expect(totalPct).toBeGreaterThanOrEqual(99);
    expect(totalPct).toBeLessThanOrEqual(101);
  });

  test('includes p50, p95, p99 in summary', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;

    for (let i = 0; i < 5; i++) {
      await httpPost(port, '/mcp', { jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    }

    const r = await httpGet(port, '/admin/response-time-distribution', { 'X-Admin-Key': adminKey });

    expect(typeof r.body.summary.p50).toBe('number');
    expect(typeof r.body.summary.p95).toBe('number');
    expect(typeof r.body.summary.p99).toBe('number');
    expect(r.body.summary.p50).toBeLessThanOrEqual(r.body.summary.p95);
    expect(r.body.summary.p95).toBeLessThanOrEqual(r.body.summary.p99);
  });

  test('only counts allowed requests', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 10, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;

    // 2 allowed calls (10 credits, 5 per call = 2 calls max)
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    // This should be denied (out of credits)
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/response-time-distribution', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalRequests).toBe(2);
  });

  test('buckets sorted by range ascending', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/response-time-distribution', { 'X-Admin-Key': adminKey });

    const order = ['0-50ms', '51-100ms', '101-250ms', '251-500ms', '501-1000ms', '1001ms+'];
    const ranges = r.body.buckets.map((b: any) => b.range);
    const filtered = order.filter(o => ranges.includes(o));
    expect(ranges).toEqual(filtered);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/response-time-distribution');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/response-time-distribution', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.responseTimeDistribution).toBeDefined();
    expect(r.body.endpoints.responseTimeDistribution).toContain('/admin/response-time-distribution');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/response-time-distribution', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/response-time-distribution', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
