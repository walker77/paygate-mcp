/**
 * Tests for v8.57.0 — Revenue Forecast
 *
 * GET /admin/revenue-forecast — Projected revenue based on current
 * spend trends with hourly/daily/weekly/monthly projections and
 * confidence indicators.
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

describe('Revenue Forecast', () => {
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

    const r = await httpGet(port, '/admin/revenue-forecast', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.forecast).toBeDefined();
    expect(r.body.current).toBeDefined();
    expect(typeof r.body.current.totalSpent).toBe('number');
    expect(typeof r.body.current.creditsPerHour).toBe('number');
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('zero forecast when no keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/revenue-forecast', { 'X-Admin-Key': adminKey });

    expect(r.body.current.totalSpent).toBe(0);
    expect(r.body.current.creditsPerHour).toBe(0);
    expect(r.body.forecast.nextHour).toBe(0);
    expect(r.body.forecast.nextDay).toBe(0);
    expect(r.body.forecast.nextWeek).toBe(0);
    expect(r.body.forecast.nextMonth).toBe(0);
  });

  test('projects revenue from spend rate', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 10000, name: 'spender' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/revenue-forecast', { 'X-Admin-Key': adminKey });

    expect(r.body.current.totalSpent).toBe(20);
    expect(r.body.current.creditsPerHour).toBeGreaterThan(0);
    expect(r.body.forecast.nextHour).toBeGreaterThan(0);
    // All forecasts are capped by remaining credits, so higher windows may equal lower ones
    expect(r.body.forecast.nextDay).toBeGreaterThanOrEqual(r.body.forecast.nextHour);
    expect(r.body.forecast.nextWeek).toBeGreaterThanOrEqual(r.body.forecast.nextDay);
    expect(r.body.forecast.nextMonth).toBeGreaterThanOrEqual(r.body.forecast.nextWeek);
  });

  test('zero spend yields zero forecast', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'idle' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/revenue-forecast', { 'X-Admin-Key': adminKey });

    expect(r.body.current.totalSpent).toBe(0);
    expect(r.body.forecast.nextHour).toBe(0);
    expect(r.body.forecast.nextDay).toBe(0);
  });

  test('forecast capped by remaining credits', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 50, name: 'limited' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/revenue-forecast', { 'X-Admin-Key': adminKey });

    // Can't spend more than remaining credits (40)
    expect(r.body.forecast.nextMonth).toBeLessThanOrEqual(r.body.current.totalSpent + r.body.current.totalRemaining);
  });

  test('includes active key count in current', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'a' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 100, name: 'b' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/revenue-forecast', { 'X-Admin-Key': adminKey });

    expect(r.body.current.activeKeys).toBe(2);
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

    const r = await httpGet(port, '/admin/revenue-forecast', { 'X-Admin-Key': adminKey });

    expect(r.body.current.activeKeys).toBe(1);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/revenue-forecast');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/revenue-forecast', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.revenueForecast).toBeDefined();
    expect(r.body.endpoints.revenueForecast).toContain('/admin/revenue-forecast');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/revenue-forecast', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/revenue-forecast', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
