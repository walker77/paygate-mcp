/**
 * Tests for v8.53.0 — Consumer Spend Velocity
 *
 * GET /admin/consumer-spend-velocity — Per-consumer spend rate analysis
 * with credits per hour, depletion forecast, and velocity ranking.
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

describe('Consumer Spend Velocity', () => {
  jest.setTimeout(15000);

  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('returns complete structure', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/consumer-spend-velocity', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.consumers)).toBe(true);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalConsumers).toBe('number');
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/consumer-spend-velocity', { 'X-Admin-Key': adminKey });

    expect(r.body.consumers.length).toBe(0);
    expect(r.body.summary.totalConsumers).toBe(0);
  });

  test('shows per-consumer velocity', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 200, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/consumer-spend-velocity', { 'X-Admin-Key': adminKey });

    expect(r.body.consumers.length).toBe(1);
    const c = r.body.consumers[0];
    expect(c.name).toBe('user1');
    expect(c.totalSpent).toBe(20);
    expect(c.creditsRemaining).toBe(180);
    expect(typeof c.creditsPerHour).toBe('number');
  });

  test('includes depletion forecast', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/consumer-spend-velocity', { 'X-Admin-Key': adminKey });

    const c = r.body.consumers[0];
    // hoursUntilDepleted should be a number or null
    expect(c.hoursUntilDepleted === null || typeof c.hoursUntilDepleted === 'number').toBe(true);
  });

  test('zero-spend consumers have null velocity', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'idle-user' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/consumer-spend-velocity', { 'X-Admin-Key': adminKey });

    const c = r.body.consumers[0];
    expect(c.creditsPerHour).toBe(0);
    expect(c.hoursUntilDepleted).toBeNull();
    expect(c.totalSpent).toBe(0);
  });

  test('sorted by creditsPerHour descending', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 200, name: 'slow' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 200, name: 'fast' }, { 'X-Admin-Key': adminKey })).body.key;

    // slow: 1 call = 5
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });

    // fast: 3 calls = 15
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/consumer-spend-velocity', { 'X-Admin-Key': adminKey });

    expect(r.body.consumers[0].name).toBe('fast');
    expect(r.body.consumers[1].name).toBe('slow');
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

    const r = await httpGet(port, '/admin/consumer-spend-velocity', { 'X-Admin-Key': adminKey });

    expect(r.body.consumers.length).toBe(1);
    expect(r.body.consumers[0].name).toBe('active');
  });

  test('summary includes fastest spender', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 200, name: 'spender' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/consumer-spend-velocity', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.fastestSpender === null || typeof r.body.summary.fastestSpender === 'string').toBe(true);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/consumer-spend-velocity');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/consumer-spend-velocity', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.consumerSpendVelocity).toBeDefined();
    expect(r.body.endpoints.consumerSpendVelocity).toContain('/admin/consumer-spend-velocity');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/consumer-spend-velocity', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/consumer-spend-velocity', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
