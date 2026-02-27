/**
 * Tests for v8.32.0 — Access Heatmap
 *
 * GET /admin/access-heatmap — Hourly access patterns showing request
 * distribution by hour of day, tool breakdown per hour, and peak/quiet
 * window identification for capacity planning.
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

describe('Access Heatmap', () => {
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

    const r = await httpGet(port, '/admin/access-heatmap', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.hourly)).toBe(true);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalRequests).toBe('number');
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no requests', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/access-heatmap', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalRequests).toBe(0);
    expect(r.body.hourly.length).toBe(0);
  });

  test('tracks requests in current hour bucket', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'k1' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/access-heatmap', { 'X-Admin-Key': adminKey });

    expect(r.body.hourly.length).toBeGreaterThanOrEqual(1);
    expect(r.body.summary.totalRequests).toBe(2);
  });

  test('hourly buckets include tool breakdown', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'k1' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/access-heatmap', { 'X-Admin-Key': adminKey });

    const bucket = r.body.hourly[0];
    expect(typeof bucket.hour).toBe('string');
    expect(typeof bucket.total).toBe('number');
    expect(bucket.total).toBe(3);
    expect(typeof bucket.tools).toBe('object');
    expect(bucket.tools['tool_a']).toBe(2);
    expect(bucket.tools['tool_b']).toBe(1);
  });

  test('identifies peak hour', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'k1' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/access-heatmap', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.peakHour).toBeDefined();
    expect(typeof r.body.summary.peakHour.hour).toBe('string');
    expect(typeof r.body.summary.peakHour.total).toBe('number');
    expect(r.body.summary.peakHour.total).toBeGreaterThanOrEqual(1);
  });

  test('includes unique consumers per hour', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'u1' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'u2' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/access-heatmap', { 'X-Admin-Key': adminKey });

    const bucket = r.body.hourly[0];
    expect(bucket.uniqueConsumers).toBe(2);
  });

  test('hourly buckets sorted chronologically', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'k1' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/access-heatmap', { 'X-Admin-Key': adminKey });

    for (let i = 1; i < r.body.hourly.length; i++) {
      expect(r.body.hourly[i - 1].hour <= r.body.hourly[i].hour).toBe(true);
    }
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/access-heatmap');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/access-heatmap', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.accessHeatmap).toBeDefined();
    expect(r.body.endpoints.accessHeatmap).toContain('/admin/access-heatmap');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/access-heatmap', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/access-heatmap', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
