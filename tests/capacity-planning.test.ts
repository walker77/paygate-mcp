/**
 * Tests for v8.16.0 — Capacity Planning
 *
 * GET /admin/capacity — System capacity analysis: credit burn rates,
 * estimated days until depletion, per-namespace capacity, top consumer
 * trends, and scaling recommendations.
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

describe('Capacity Planning', () => {
  jest.setTimeout(15000);

  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    await server.stop();
  });

  test('returns complete capacity structure', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/capacity', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalCreditsAllocated).toBe('number');
    expect(typeof r.body.summary.totalCreditsRemaining).toBe('number');
    expect(typeof r.body.summary.totalCreditsSpent).toBe('number');
    expect(typeof r.body.summary.utilizationPct).toBe('number');
    expect(Array.isArray(r.body.topConsumers)).toBe(true);
    expect(Array.isArray(r.body.recommendations)).toBe(true);
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty system shows zero capacity', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/capacity', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalCreditsAllocated).toBe(0);
    expect(r.body.summary.totalCreditsRemaining).toBe(0);
    expect(r.body.summary.totalCreditsSpent).toBe(0);
    expect(r.body.topConsumers).toHaveLength(0);
  });

  test('tracks total credits allocated and remaining', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 500, name: 'cap-test' }, { 'X-Admin-Key': adminKey })).body.key;

    // Spend some credits
    for (let i = 1; i <= 3; i++) {
      await httpPost(port, '/mcp', { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    }

    const r = await httpGet(port, '/admin/capacity', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalCreditsAllocated).toBe(500);
    expect(r.body.summary.totalCreditsSpent).toBe(30);
    expect(r.body.summary.totalCreditsRemaining).toBe(470);
  });

  test('calculates utilization percentage', async () => {
    server = makeServer({ defaultCreditsPerCall: 50 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 200, name: 'util-test' }, { 'X-Admin-Key': adminKey })).body.key;

    // Spend 150 / 200 = 75%
    for (let i = 1; i <= 3; i++) {
      await httpPost(port, '/mcp', { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    }

    const r = await httpGet(port, '/admin/capacity', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.utilizationPct).toBe(75);
  });

  test('top consumers ranked by credits spent', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 1000, name: 'heavy' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 1000, name: 'light' }, { 'X-Admin-Key': adminKey })).body.key;

    // Heavy: 5 calls = 50 credits
    for (let i = 1; i <= 5; i++) {
      await httpPost(port, '/mcp', { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });
    }
    // Light: 1 call = 10 credits
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/capacity', { 'X-Admin-Key': adminKey });

    expect(r.body.topConsumers.length).toBe(2);
    expect(r.body.topConsumers[0].keyName).toBe('heavy');
    expect(r.body.topConsumers[0].creditsSpent).toBe(50);
    expect(r.body.topConsumers[1].keyName).toBe('light');
  });

  test('burn rate calculated from events', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 1000, name: 'burn' }, { 'X-Admin-Key': adminKey })).body.key;

    for (let i = 1; i <= 4; i++) {
      await httpPost(port, '/mcp', { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    }

    const r = await httpGet(port, '/admin/capacity', { 'X-Admin-Key': adminKey });

    expect(typeof r.body.summary.burnRate).toBe('object');
    expect(typeof r.body.summary.burnRate.creditsPerCall).toBe('number');
    expect(r.body.summary.burnRate.creditsPerCall).toBe(10);
    expect(typeof r.body.summary.burnRate.totalCalls).toBe('number');
    expect(r.body.summary.burnRate.totalCalls).toBe(4);
  });

  test('recommendations for high utilization', async () => {
    server = makeServer({ defaultCreditsPerCall: 90 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'high-util' }, { 'X-Admin-Key': adminKey })).body.key;

    // Spend 90/100 = 90%
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/capacity', { 'X-Admin-Key': adminKey });

    expect(r.body.recommendations.length).toBeGreaterThan(0);
    expect(typeof r.body.recommendations[0]).toBe('string');
  });

  test('no recommendations for healthy system', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 10000, name: 'healthy' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/capacity', { 'X-Admin-Key': adminKey });

    // Low utilization = no urgent recommendations
    const urgentRecs = r.body.recommendations.filter((rec: string) => rec.includes('critical') || rec.includes('immediately'));
    expect(urgentRecs).toHaveLength(0);
  });

  test('per-namespace capacity breakdown', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 500, name: 'ns-a', namespace: 'prod' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 300, name: 'ns-b', namespace: 'staging' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });

    const r = await httpGet(port, '/admin/capacity', { 'X-Admin-Key': adminKey });

    expect(r.body.byNamespace).toBeDefined();
    expect(typeof r.body.byNamespace).toBe('object');
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/capacity');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/capacity', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.capacityPlanning).toBeDefined();
    expect(r.body.endpoints.capacityPlanning).toContain('/admin/capacity');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/capacity', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/capacity', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
