/**
 * Tests for v8.8.0 — Traffic Analysis
 *
 * GET /admin/traffic — Request volume patterns, peak hours, tool popularity,
 * throughput metrics, and namespace distribution.
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

async function discoverTools(port: number, apiKey: string): Promise<void> {
  await httpPost(port, '/mcp', {
    jsonrpc: '2.0', id: 999, method: 'tools/list', params: {},
  }, { 'X-API-Key': apiKey });
}

/* ── tests ───────────────────────────────────────────────── */

describe('Traffic Analysis', () => {
  jest.setTimeout(15000);

  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('returns complete traffic analysis structure', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/traffic', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalCalls).toBe('number');
    expect(typeof r.body.summary.totalAllowed).toBe('number');
    expect(typeof r.body.summary.totalDenied).toBe('number');
    expect(typeof r.body.summary.successRate).toBe('number');
    expect(typeof r.body.summary.uniqueKeys).toBe('number');
    expect(typeof r.body.summary.uniqueTools).toBe('number');
    expect(Array.isArray(r.body.toolPopularity)).toBe(true);
    expect(Array.isArray(r.body.hourlyVolume)).toBe(true);
    expect(Array.isArray(r.body.topConsumers)).toBe(true);
    expect(Array.isArray(r.body.byNamespace)).toBe(true);
  });

  test('empty system has zero traffic', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/traffic', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalCalls).toBe(0);
    expect(r.body.summary.totalAllowed).toBe(0);
    expect(r.body.summary.totalDenied).toBe(0);
    expect(r.body.summary.successRate).toBe(0);
    expect(r.body.summary.uniqueKeys).toBe(0);
    expect(r.body.summary.uniqueTools).toBe(0);
    expect(r.body.toolPopularity).toHaveLength(0);
    expect(r.body.hourlyVolume).toHaveLength(0);
    expect(r.body.topConsumers).toHaveLength(0);
  });

  test('counts successful calls', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'caller' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_b', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/traffic', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalCalls).toBe(2);
    expect(r.body.summary.totalAllowed).toBe(2);
    expect(r.body.summary.totalDenied).toBe(0);
    expect(r.body.summary.successRate).toBe(1);
    expect(r.body.summary.uniqueKeys).toBe(1);
    expect(r.body.summary.uniqueTools).toBe(2);
  });

  test('tool popularity ranked by call count', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'popularity' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    // tool_a: 3 calls, tool_b: 1 call
    for (let i = 0; i < 3; i++) {
      await httpPost(port, '/mcp', {
        jsonrpc: '2.0', id: i + 1, method: 'tools/call',
        params: { name: 'tool_a', arguments: {} },
      }, { 'X-API-Key': k });
    }
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name: 'tool_b', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/traffic', { 'X-Admin-Key': adminKey });

    expect(r.body.toolPopularity.length).toBe(2);
    expect(r.body.toolPopularity[0].tool).toBe('tool_a');
    expect(r.body.toolPopularity[0].calls).toBe(3);
    expect(r.body.toolPopularity[1].tool).toBe('tool_b');
    expect(r.body.toolPopularity[1].calls).toBe(1);
  });

  test('hourly volume has correct structure', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'hourly' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/traffic', { 'X-Admin-Key': adminKey });

    expect(r.body.hourlyVolume.length).toBeGreaterThanOrEqual(1);
    const bucket = r.body.hourlyVolume[0];
    expect(bucket.hour).toBeTruthy();
    expect(typeof bucket.calls).toBe('number');
    expect(typeof bucket.allowed).toBe('number');
    expect(typeof bucket.denied).toBe('number');
    expect(typeof bucket.credits).toBe('number');
  });

  test('top consumers ranked by call count', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // light: 1 call
    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'light' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k1);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k1 });

    // heavy: 3 calls
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'heavy' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k2);
    for (let i = 0; i < 3; i++) {
      await httpPost(port, '/mcp', {
        jsonrpc: '2.0', id: i + 10, method: 'tools/call',
        params: { name: 'tool_a', arguments: {} },
      }, { 'X-API-Key': k2 });
    }

    const r = await httpGet(port, '/admin/traffic', { 'X-Admin-Key': adminKey });

    expect(r.body.topConsumers.length).toBe(2);
    expect(r.body.topConsumers[0].name).toBe('heavy');
    expect(r.body.topConsumers[0].calls).toBe(3);
  });

  test('namespace breakdown groups traffic', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'ns-prod', namespace: 'production' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'ns-dev', namespace: 'development' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k1);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k1 });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/traffic', { 'X-Admin-Key': adminKey });

    expect(r.body.byNamespace.length).toBeGreaterThanOrEqual(2);
    const prod = r.body.byNamespace.find((n: any) => n.namespace === 'production');
    const dev = r.body.byNamespace.find((n: any) => n.namespace === 'development');
    expect(prod).toBeDefined();
    expect(dev).toBeDefined();
    expect(prod.calls).toBe(1);
    expect(dev.calls).toBe(1);
  });

  test('tool popularity includes success rate', async () => {
    server = makeServer({ defaultCreditsPerCall: 5, globalRateLimitPerMin: 1 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'mixed' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/traffic', { 'X-Admin-Key': adminKey });

    const toolA = r.body.toolPopularity.find((t: any) => t.tool === 'tool_a');
    expect(toolA).toBeDefined();
    expect(typeof toolA.successRate).toBe('number');
    expect(typeof toolA.credits).toBe('number');
  });

  test('peak hour identified', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'peak' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/traffic', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.peakHour).toBeTruthy();
    expect(typeof r.body.summary.peakHourCalls).toBe('number');
    expect(r.body.summary.peakHourCalls).toBeGreaterThanOrEqual(1);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/traffic');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/traffic', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.trafficAnalysis).toBeDefined();
    expect(r.body.endpoints.trafficAnalysis).toContain('/admin/traffic');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    await httpGet(port, '/admin/traffic', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/traffic', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(95);
  });
});
