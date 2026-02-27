/**
 * Tests for v8.38.0 — Consumer Lifetime Value
 *
 * GET /admin/consumer-lifetime-value — Per-consumer value metrics showing
 * total spend, average spend per call, tool diversity, and value tier
 * classification for revenue optimization and engagement targeting.
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

describe('Consumer Lifetime Value', () => {
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

    const r = await httpGet(port, '/admin/consumer-lifetime-value', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.consumers)).toBe(true);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalConsumers).toBe('number');
    expect(typeof r.body.summary.totalLifetimeValue).toBe('number');
    expect(typeof r.body.summary.avgLifetimeValue).toBe('number');
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/consumer-lifetime-value', { 'X-Admin-Key': adminKey });

    expect(r.body.consumers.length).toBe(0);
    expect(r.body.summary.totalConsumers).toBe(0);
    expect(r.body.summary.totalLifetimeValue).toBe(0);
    expect(r.body.summary.avgLifetimeValue).toBe(0);
  });

  test('calculates per-consumer value from totalSpent', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'spender' }, { 'X-Admin-Key': adminKey })).body.key;

    // 3 calls at 10 credits each = 30 spent
    for (let i = 0; i < 3; i++) {
      await httpPost(port, '/mcp', { jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    }

    const r = await httpGet(port, '/admin/consumer-lifetime-value', { 'X-Admin-Key': adminKey });

    expect(r.body.consumers.length).toBe(1);
    expect(r.body.consumers[0].name).toBe('spender');
    expect(r.body.consumers[0].lifetimeValue).toBe(30);
    expect(r.body.consumers[0].totalCalls).toBe(3);
    expect(r.body.consumers[0].avgSpendPerCall).toBe(10);
  });

  test('classifies value tiers', async () => {
    server = makeServer({ defaultCreditsPerCall: 50 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // High value: 150 spent (3 calls * 50 credits = 150 >= 100 → high)
    const k1 = (await httpPost(port, '/keys', { credits: 500, name: 'whale' }, { 'X-Admin-Key': adminKey })).body.key;
    for (let i = 0; i < 3; i++) {
      await httpPost(port, '/mcp', { jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });
    }

    // Low value: 1 spent (1 call * 1 credit < 10 → low)
    const k2 = (await httpPost(port, '/keys', { credits: 50, name: 'lite' }, { 'X-Admin-Key': adminKey })).body.key;

    const r2 = await httpGet(port, '/admin/consumer-lifetime-value', { 'X-Admin-Key': adminKey });

    const whale = r2.body.consumers.find((c: any) => c.name === 'whale');
    expect(whale).toBeDefined();
    expect(whale.tier).toBe('high');
  });

  test('sorted by lifetime value descending', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'small' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'big' }, { 'X-Admin-Key': adminKey })).body.key;

    // k1: 1 call = 5 spent
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });
    // k2: 3 calls = 15 spent
    for (let i = 0; i < 3; i++) {
      await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });
    }

    const r = await httpGet(port, '/admin/consumer-lifetime-value', { 'X-Admin-Key': adminKey });

    expect(r.body.consumers[0].name).toBe('big');
    expect(r.body.consumers[1].name).toBe('small');
  });

  test('includes tool diversity count', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'diverse' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_c', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/consumer-lifetime-value', { 'X-Admin-Key': adminKey });

    expect(r.body.consumers[0].toolsUsed).toBe(3);
  });

  test('limits to top 20 consumers', async () => {
    server = makeServer({ defaultCreditsPerCall: 1 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create 25 keys with usage
    for (let i = 0; i < 25; i++) {
      const k = (await httpPost(port, '/keys', { credits: 100, name: `user${i}` }, { 'X-Admin-Key': adminKey })).body.key;
      await httpPost(port, '/mcp', { jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    }

    const r = await httpGet(port, '/admin/consumer-lifetime-value', { 'X-Admin-Key': adminKey });

    expect(r.body.consumers.length).toBeLessThanOrEqual(20);
    expect(r.body.summary.totalConsumers).toBe(25);
  });

  test('excludes zero-spend consumers from list', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'idle' }, { 'X-Admin-Key': adminKey });
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'active' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/consumer-lifetime-value', { 'X-Admin-Key': adminKey });

    // Only the active spender appears in consumers list
    expect(r.body.consumers.length).toBe(1);
    expect(r.body.consumers[0].name).toBe('active');
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/consumer-lifetime-value');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/consumer-lifetime-value', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.consumerLifetimeValue).toBeDefined();
    expect(r.body.endpoints.consumerLifetimeValue).toContain('/admin/consumer-lifetime-value');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/consumer-lifetime-value', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/consumer-lifetime-value', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
