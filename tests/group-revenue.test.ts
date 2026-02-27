/**
 * Tests for v8.44.0 — Group Revenue
 *
 * GET /admin/group-revenue — Revenue breakdown by key group showing
 * which groups generate the most credit consumption.
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

describe('Group Revenue', () => {
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

    const r = await httpGet(port, '/admin/group-revenue', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.groups)).toBe(true);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalGroups).toBe('number');
    expect(typeof r.body.summary.totalRevenue).toBe('number');
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/group-revenue', { 'X-Admin-Key': adminKey });

    expect(r.body.groups.length).toBe(0);
    expect(r.body.summary.totalGroups).toBe(0);
    expect(r.body.summary.totalRevenue).toBe(0);
  });

  test('groups revenue by key group', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create group and keys
    const grp = (await httpPost(port, '/groups', { name: 'premium' }, { 'X-Admin-Key': adminKey })).body;
    const k1 = (await httpPost(port, '/keys', { credits: 200, name: 'u1' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/groups/assign', { groupId: grp.id, key: k1 }, { 'X-Admin-Key': adminKey });

    const k2 = (await httpPost(port, '/keys', { credits: 200, name: 'u2' }, { 'X-Admin-Key': adminKey })).body.key;

    // premium: 2 calls = 20 credits
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });

    // ungrouped: 1 call = 10 credits
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/group-revenue', { 'X-Admin-Key': adminKey });

    expect(r.body.groups.length).toBe(2);
    const premium = r.body.groups.find((g: any) => g.group === 'premium');
    expect(premium.totalSpent).toBe(20);
    expect(premium.keyCount).toBe(1);
  });

  test('keys without group shown as "ungrouped"', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'nogroup' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/group-revenue', { 'X-Admin-Key': adminKey });

    const ungrouped = r.body.groups.find((g: any) => g.group === 'ungrouped');
    expect(ungrouped).toBeDefined();
    expect(ungrouped.totalSpent).toBe(5);
  });

  test('sorted by total spent descending', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const smallGrp = (await httpPost(port, '/groups', { name: 'small-group' }, { 'X-Admin-Key': adminKey })).body;
    const bigGrp = (await httpPost(port, '/groups', { name: 'big-group' }, { 'X-Admin-Key': adminKey })).body;

    const k1 = (await httpPost(port, '/keys', { credits: 200, name: 'u1' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/groups/assign', { groupId: smallGrp.id, key: k1 }, { 'X-Admin-Key': adminKey });

    const k2 = (await httpPost(port, '/keys', { credits: 200, name: 'u2' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/groups/assign', { groupId: bigGrp.id, key: k2 }, { 'X-Admin-Key': adminKey });

    // small-group: 1 call
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });

    // big-group: 3 calls
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/group-revenue', { 'X-Admin-Key': adminKey });

    expect(r.body.groups[0].group).toBe('big-group');
  });

  test('includes percentage and totalCalls', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const grp1 = (await httpPost(port, '/groups', { name: 'grp1' }, { 'X-Admin-Key': adminKey })).body;
    const k = (await httpPost(port, '/keys', { credits: 200, name: 'u1' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/groups/assign', { groupId: grp1.id, key: k }, { 'X-Admin-Key': adminKey });

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/group-revenue', { 'X-Admin-Key': adminKey });

    const grp = r.body.groups.find((g: any) => g.group === 'grp1');
    expect(typeof grp.percentage).toBe('number');
    expect(grp.totalCalls).toBe(1);
  });

  test('excludes revoked and suspended keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'revoked' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys', { credits: 100, name: 'active' }, { 'X-Admin-Key': adminKey });

    await httpPost(port, '/keys/revoke', { key: k1 }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/group-revenue', { 'X-Admin-Key': adminKey });

    const total = r.body.groups.reduce((s: number, g: any) => s + g.keyCount, 0);
    expect(total).toBe(1);
  });

  test('summary includes topGroup', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const topGrp = (await httpPost(port, '/groups', { name: 'top-earner' }, { 'X-Admin-Key': adminKey })).body;
    const k = (await httpPost(port, '/keys', { credits: 200, name: 'u1' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/groups/assign', { groupId: topGrp.id, key: k }, { 'X-Admin-Key': adminKey });

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/group-revenue', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.topGroup).toBe('top-earner');
    expect(r.body.summary.totalRevenue).toBe(10);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/group-revenue');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/group-revenue', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.groupRevenue).toBeDefined();
    expect(r.body.endpoints.groupRevenue).toContain('/admin/group-revenue');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/group-revenue', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/group-revenue', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
