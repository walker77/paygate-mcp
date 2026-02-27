/**
 * Tests for v8.35.0 — Consumer Segmentation
 *
 * GET /admin/consumer-segmentation — Classifies API key consumers into
 * segments (power, regular, casual, dormant) based on usage patterns,
 * with per-segment aggregate metrics for targeted engagement.
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

describe('Consumer Segmentation', () => {
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

    const r = await httpGet(port, '/admin/consumer-segmentation', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.segments)).toBe(true);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalConsumers).toBe('number');
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/consumer-segmentation', { 'X-Admin-Key': adminKey });

    expect(r.body.segments.length).toBe(0);
    expect(r.body.summary.totalConsumers).toBe(0);
  });

  test('classifies dormant consumers (zero calls)', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'idle' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/consumer-segmentation', { 'X-Admin-Key': adminKey });

    const dormant = r.body.segments.find((s: any) => s.segment === 'dormant');
    expect(dormant).toBeDefined();
    expect(dormant.count).toBe(1);
  });

  test('classifies casual consumers (1-4 calls)', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'casual' }, { 'X-Admin-Key': adminKey })).body.key;

    // Make 2 calls → casual
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/consumer-segmentation', { 'X-Admin-Key': adminKey });

    const casual = r.body.segments.find((s: any) => s.segment === 'casual');
    expect(casual).toBeDefined();
    expect(casual.count).toBe(1);
  });

  test('classifies regular consumers (5-19 calls)', async () => {
    server = makeServer({ defaultCreditsPerCall: 1 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'regular' }, { 'X-Admin-Key': adminKey })).body.key;

    // Make 7 calls → regular
    for (let i = 0; i < 7; i++) {
      await httpPost(port, '/mcp', { jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    }

    const r = await httpGet(port, '/admin/consumer-segmentation', { 'X-Admin-Key': adminKey });

    const regular = r.body.segments.find((s: any) => s.segment === 'regular');
    expect(regular).toBeDefined();
    expect(regular.count).toBe(1);
  });

  test('classifies power consumers (20+ calls)', async () => {
    server = makeServer({ defaultCreditsPerCall: 1 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'poweruser' }, { 'X-Admin-Key': adminKey })).body.key;

    // Make 20 calls → power
    for (let i = 0; i < 20; i++) {
      await httpPost(port, '/mcp', { jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    }

    const r = await httpGet(port, '/admin/consumer-segmentation', { 'X-Admin-Key': adminKey });

    const power = r.body.segments.find((s: any) => s.segment === 'power');
    expect(power).toBeDefined();
    expect(power.count).toBe(1);
  });

  test('includes per-segment metrics', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/consumer-segmentation', { 'X-Admin-Key': adminKey });

    const seg = r.body.segments[0];
    expect(typeof seg.segment).toBe('string');
    expect(typeof seg.count).toBe('number');
    expect(typeof seg.totalCredits).toBe('number');
    expect(typeof seg.totalSpent).toBe('number');
    expect(typeof seg.avgCallsPerKey).toBe('number');
  });

  test('multiple segments coexist', async () => {
    server = makeServer({ defaultCreditsPerCall: 1 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Dormant: 0 calls
    await httpPost(port, '/keys', { credits: 100, name: 'idle' }, { 'X-Admin-Key': adminKey });

    // Casual: 2 calls
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'casual' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k2 });

    // Regular: 6 calls
    const k3 = (await httpPost(port, '/keys', { credits: 100, name: 'regular' }, { 'X-Admin-Key': adminKey })).body.key;
    for (let i = 0; i < 6; i++) {
      await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k3 });
    }

    const r = await httpGet(port, '/admin/consumer-segmentation', { 'X-Admin-Key': adminKey });

    expect(r.body.segments.length).toBeGreaterThanOrEqual(2);
    expect(r.body.summary.totalConsumers).toBe(3);

    const names = r.body.segments.map((s: any) => s.segment);
    expect(names).toContain('dormant');
    expect(names).toContain('casual');
    expect(names).toContain('regular');
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

    const r = await httpGet(port, '/admin/consumer-segmentation', { 'X-Admin-Key': adminKey });

    // Only the active key should be counted
    expect(r.body.summary.totalConsumers).toBe(1);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/consumer-segmentation');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/consumer-segmentation', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.consumerSegmentation).toBeDefined();
    expect(r.body.endpoints.consumerSegmentation).toContain('/admin/consumer-segmentation');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/consumer-segmentation', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/consumer-segmentation', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
