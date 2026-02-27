/**
 * Tests for v8.55.0 — Credit Burn Rate
 *
 * GET /admin/credit-burn-rate — System-wide credit burn rate analysis
 * with total credits allocated, total spent, burn rate per hour,
 * estimated system-wide depletion, and per-hour spend trend.
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
    if (r.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { protocolVersion: '2025-01-01', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0' } } }) + '\\n');
    } else if (r.method === 'tools/list') {
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

describe('Credit Burn Rate', () => {
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

    const r = await httpGet(port, '/admin/credit-burn-rate', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.burnRate).toBeDefined();
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalAllocated).toBe('number');
    expect(typeof r.body.summary.totalSpent).toBe('number');
    expect(typeof r.body.summary.totalRemaining).toBe('number');
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/credit-burn-rate', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalAllocated).toBe(0);
    expect(r.body.summary.totalSpent).toBe(0);
    expect(r.body.summary.totalRemaining).toBe(0);
    expect(r.body.burnRate.creditsPerHour).toBe(0);
    expect(r.body.burnRate.hoursUntilDepleted).toBeNull();
  });

  test('calculates burn rate from active keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 200, name: 'a' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 300, name: 'b' }, { 'X-Admin-Key': adminKey })).body.key;

    // k1: 2 calls = 20 spent
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });

    // k2: 1 call = 10 spent
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/credit-burn-rate', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalAllocated).toBe(500); // 200 + 300
    expect(r.body.summary.totalSpent).toBe(30); // 20 + 10
    expect(r.body.summary.totalRemaining).toBe(470); // 500 - 30
    expect(r.body.burnRate.creditsPerHour).toBeGreaterThan(0);
    expect(r.body.burnRate.hoursUntilDepleted).toBeGreaterThan(0);
  });

  test('zero spend yields null depletion', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'idle' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/credit-burn-rate', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalAllocated).toBe(100);
    expect(r.body.summary.totalSpent).toBe(0);
    expect(r.body.burnRate.creditsPerHour).toBe(0);
    expect(r.body.burnRate.hoursUntilDepleted).toBeNull();
  });

  test('includes utilization percentage', async () => {
    server = makeServer({ defaultCreditsPerCall: 50 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 200, name: 'a' }, { 'X-Admin-Key': adminKey })).body.key;

    // 1 call = 50 spent, 200 allocated → 25% utilized
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/credit-burn-rate', { 'X-Admin-Key': adminKey });

    expect(r.body.burnRate.utilizationPercent).toBe(25);
  });

  test('excludes revoked and suspended keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'revoked' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'suspended' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys', { credits: 50, name: 'active' }, { 'X-Admin-Key': adminKey });

    await httpPost(port, '/keys/revoke', { key: k1 }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys/suspend', { key: k2 }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/credit-burn-rate', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalAllocated).toBe(50);
    expect(r.body.summary.activeKeys).toBe(1);
  });

  test('summary includes activeKeys count', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'a' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 100, name: 'b' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 100, name: 'c' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/credit-burn-rate', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.activeKeys).toBe(3);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/credit-burn-rate');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/credit-burn-rate', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.creditBurnRate).toBeDefined();
    expect(r.body.endpoints.creditBurnRate).toContain('/admin/credit-burn-rate');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/credit-burn-rate', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/credit-burn-rate', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
