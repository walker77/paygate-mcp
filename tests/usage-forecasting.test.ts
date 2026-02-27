/**
 * Tests for v8.13.0 — Usage Forecasting
 *
 * GET /admin/forecast — Predicts future credit consumption and key exhaustion
 * based on historical usage patterns: per-key depletion forecasts, system-wide
 * consumption trends, and hourly usage projections.
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

describe('Usage Forecasting', () => {
  jest.setTimeout(15000);

  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('returns complete forecast structure', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/forecast', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalActiveKeys).toBe('number');
    expect(typeof r.body.summary.keysAtRisk).toBe('number');
    expect(Array.isArray(r.body.keyForecasts)).toBe(true);
    expect(typeof r.body.systemForecast).toBe('object');
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('no activity produces empty forecasts', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/forecast', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalActiveKeys).toBe(0);
    expect(r.body.summary.keysAtRisk).toBe(0);
    expect(r.body.keyForecasts).toHaveLength(0);
    expect(r.body.systemForecast.totalCreditsRemaining).toBe(0);
  });

  test('forecasts depletion for active keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'spender' }, { 'X-Admin-Key': adminKey })).body.key;

    // Make some calls to establish usage pattern
    for (let i = 1; i <= 5; i++) {
      await httpPost(port, '/mcp', { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    }

    const r = await httpGet(port, '/admin/forecast', { 'X-Admin-Key': adminKey });

    const forecast = r.body.keyForecasts.find((f: any) => f.keyName === 'spender');
    expect(forecast).toBeDefined();
    expect(typeof forecast.creditsRemaining).toBe('number');
    expect(typeof forecast.totalSpent).toBe('number');
    expect(typeof forecast.callCount).toBe('number');
    expect(typeof forecast.avgCreditsPerCall).toBe('number');
    expect(forecast.creditsRemaining).toBe(50);
    expect(forecast.totalSpent).toBe(50);
    expect(forecast.callCount).toBe(5);
    expect(forecast.avgCreditsPerCall).toBe(10);
  });

  test('estimates calls remaining', async () => {
    server = makeServer({ defaultCreditsPerCall: 20 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 200, name: 'estimator' }, { 'X-Admin-Key': adminKey })).body.key;

    // Spend 60 credits (3 calls × 20)
    for (let i = 1; i <= 3; i++) {
      await httpPost(port, '/mcp', { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    }

    const r = await httpGet(port, '/admin/forecast', { 'X-Admin-Key': adminKey });

    const forecast = r.body.keyForecasts.find((f: any) => f.keyName === 'estimator');
    expect(forecast).toBeDefined();
    expect(forecast.creditsRemaining).toBe(140);
    // 140 remaining / 20 avg per call = 7 calls remaining
    expect(forecast.estimatedCallsRemaining).toBe(7);
  });

  test('marks keys at risk with low remaining calls', async () => {
    server = makeServer({ defaultCreditsPerCall: 40 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'at-risk' }, { 'X-Admin-Key': adminKey })).body.key;

    // Spend 80 credits (2 calls × 40) — only 20 remaining = 0 full calls
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/forecast', { 'X-Admin-Key': adminKey });

    const forecast = r.body.keyForecasts.find((f: any) => f.keyName === 'at-risk');
    expect(forecast).toBeDefined();
    expect(forecast.atRisk).toBe(true);
    expect(r.body.summary.keysAtRisk).toBeGreaterThanOrEqual(1);
  });

  test('keys with plenty of credits are not at risk', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 10000, name: 'wealthy' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/forecast', { 'X-Admin-Key': adminKey });

    const forecast = r.body.keyForecasts.find((f: any) => f.keyName === 'wealthy');
    expect(forecast).toBeDefined();
    expect(forecast.atRisk).toBe(false);
  });

  test('system forecast aggregates all keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 500, name: 'key1' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 300, name: 'key2' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/forecast', { 'X-Admin-Key': adminKey });

    expect(r.body.systemForecast.totalCreditsRemaining).toBe(780);
    expect(r.body.systemForecast.totalCreditsSpent).toBe(20);
    expect(r.body.systemForecast.totalCalls).toBe(2);
  });

  test('unused keys show no forecast data', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 1000, name: 'unused' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/forecast', { 'X-Admin-Key': adminKey });

    const forecast = r.body.keyForecasts.find((f: any) => f.keyName === 'unused');
    expect(forecast).toBeDefined();
    expect(forecast.callCount).toBe(0);
    expect(forecast.estimatedCallsRemaining).toBeNull();
    expect(forecast.atRisk).toBe(false);
  });

  test('per-tool breakdown in forecasts', async () => {
    server = makeServer({ toolPricing: { tool_a: { creditsPerCall: 10 }, tool_b: { creditsPerCall: 25 } } });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 500, name: 'multi-tool' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/forecast', { 'X-Admin-Key': adminKey });

    expect(r.body.systemForecast.byTool).toBeDefined();
    const toolA = r.body.systemForecast.byTool.find((t: any) => t.tool === 'tool_a');
    const toolB = r.body.systemForecast.byTool.find((t: any) => t.tool === 'tool_b');
    expect(toolA).toBeDefined();
    expect(toolB).toBeDefined();
    expect(toolA.totalCredits).toBe(10);
    expect(toolB.totalCredits).toBe(25);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/forecast');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/forecast', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.usageForecasting).toBeDefined();
    expect(r.body.endpoints.usageForecasting).toContain('/admin/forecast');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/forecast', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/forecast', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
