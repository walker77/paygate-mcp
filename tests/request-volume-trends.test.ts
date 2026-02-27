/**
 * Tests for v8.25.0 — Request Volume Trends
 *
 * GET /admin/request-trends — Hourly time-series of request volume,
 * success/failure counts, credit spend, and average duration for
 * the recent window. Built on requestLog data.
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

describe('Request Volume Trends', () => {
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

    const r = await httpGet(port, '/admin/request-trends', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalRequests).toBe('number');
    expect(typeof r.body.summary.totalAllowed).toBe('number');
    expect(typeof r.body.summary.totalDenied).toBe('number');
    expect(typeof r.body.summary.totalCredits).toBe('number');
    expect(Array.isArray(r.body.hourly)).toBe(true);
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no requests', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/request-trends', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalRequests).toBe(0);
    expect(r.body.summary.totalAllowed).toBe(0);
    expect(r.body.summary.totalDenied).toBe(0);
    expect(r.body.summary.totalCredits).toBe(0);
  });

  test('tracks successful requests', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'caller' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} }
    }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_b', arguments: {} }
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/request-trends', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalRequests).toBe(2);
    expect(r.body.summary.totalAllowed).toBe(2);
    expect(r.body.summary.totalCredits).toBe(10);
  });

  test('tracks denied requests', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 3, name: 'low-credits' }, { 'X-Admin-Key': adminKey })).body.key;

    // This should be denied (3 credits < 5 per call)
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} }
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/request-trends', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalDenied).toBeGreaterThanOrEqual(1);
  });

  test('hourly buckets have expected fields', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'k1' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} }
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/request-trends', { 'X-Admin-Key': adminKey });

    expect(r.body.hourly.length).toBeGreaterThanOrEqual(1);
    const bucket = r.body.hourly[0];
    expect(typeof bucket.hour).toBe('string');
    expect(typeof bucket.total).toBe('number');
    expect(typeof bucket.allowed).toBe('number');
    expect(typeof bucket.denied).toBe('number');
    expect(typeof bucket.credits).toBe('number');
    expect(typeof bucket.avgDurationMs).toBe('number');
  });

  test('hourly buckets sorted chronologically', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'k1' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} }
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/request-trends', { 'X-Admin-Key': adminKey });

    // Verify chronological order
    for (let i = 1; i < r.body.hourly.length; i++) {
      expect(r.body.hourly[i - 1].hour <= r.body.hourly[i].hour).toBe(true);
    }
  });

  test('summary includes avg duration', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'k1' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} }
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/request-trends', { 'X-Admin-Key': adminKey });

    expect(typeof r.body.summary.avgDurationMs).toBe('number');
    expect(r.body.summary.avgDurationMs).toBeGreaterThanOrEqual(0);
  });

  test('peak hour identification', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'k1' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} }
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/request-trends', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.peakHour).toBeDefined();
    expect(typeof r.body.summary.peakHour.hour).toBe('string');
    expect(typeof r.body.summary.peakHour.total).toBe('number');
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/request-trends');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/request-trends', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.requestTrends).toBeDefined();
    expect(r.body.endpoints.requestTrends).toContain('/admin/request-trends');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/request-trends', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/request-trends', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
