/**
 * Tests for v8.58.0 — Group Activity
 *
 * GET /admin/group-activity — Per-group activity metrics with key
 * counts, total spend, total calls, credits remaining, and top group
 * identification for policy-template-based analytics.
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

describe('Group Activity', () => {
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

    const r = await httpGet(port, '/admin/group-activity', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.groups)).toBe(true);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalGroups).toBe('number');
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/group-activity', { 'X-Admin-Key': adminKey });

    expect(r.body.groups.length).toBe(0);
    expect(r.body.summary.totalGroups).toBe(0);
  });

  test('groups keys by group field', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const alpha = (await httpPost(port, '/groups', { name: 'team-alpha' }, { 'X-Admin-Key': adminKey })).body;
    const beta = (await httpPost(port, '/groups', { name: 'team-beta' }, { 'X-Admin-Key': adminKey })).body;

    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'a' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'b' }, { 'X-Admin-Key': adminKey })).body.key;
    const k3 = (await httpPost(port, '/keys', { credits: 100, name: 'c' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/groups/assign', { groupId: alpha.id, key: k1 }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/groups/assign', { groupId: alpha.id, key: k2 }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/groups/assign', { groupId: beta.id, key: k3 }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/group-activity', { 'X-Admin-Key': adminKey });

    const alphaGroup = r.body.groups.find((g: any) => g.group === 'team-alpha');
    const betaGroup = r.body.groups.find((g: any) => g.group === 'team-beta');
    expect(alphaGroup.keyCount).toBe(2);
    expect(betaGroup.keyCount).toBe(1);
  });

  test('tracks spend and calls per group', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const eng = (await httpPost(port, '/groups', { name: 'eng' }, { 'X-Admin-Key': adminKey })).body;
    const sales = (await httpPost(port, '/groups', { name: 'sales' }, { 'X-Admin-Key': adminKey })).body;

    const k1 = (await httpPost(port, '/keys', { credits: 200, name: 'a' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 200, name: 'b' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/groups/assign', { groupId: eng.id, key: k1 }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/groups/assign', { groupId: sales.id, key: k2 }, { 'X-Admin-Key': adminKey });

    // eng: 2 calls = 20
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });

    // sales: 1 call = 10
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/group-activity', { 'X-Admin-Key': adminKey });

    const engGroup = r.body.groups.find((g: any) => g.group === 'eng');
    const salesGroup = r.body.groups.find((g: any) => g.group === 'sales');

    expect(engGroup.totalSpent).toBe(20);
    expect(engGroup.totalCalls).toBe(2);
    expect(salesGroup.totalSpent).toBe(10);
    expect(salesGroup.totalCalls).toBe(1);
  });

  test('sorted by totalSpent descending', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const low = (await httpPost(port, '/groups', { name: 'low' }, { 'X-Admin-Key': adminKey })).body;
    const high = (await httpPost(port, '/groups', { name: 'high' }, { 'X-Admin-Key': adminKey })).body;

    const k1 = (await httpPost(port, '/keys', { credits: 200, name: 'a' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 200, name: 'b' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/groups/assign', { groupId: low.id, key: k1 }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/groups/assign', { groupId: high.id, key: k2 }, { 'X-Admin-Key': adminKey });

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/group-activity', { 'X-Admin-Key': adminKey });

    expect(r.body.groups[0].group).toBe('high');
  });

  test('ungrouped keys shown as "ungrouped"', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const grp = (await httpPost(port, '/groups', { name: 'custom' }, { 'X-Admin-Key': adminKey })).body;

    await httpPost(port, '/keys', { credits: 100, name: 'no-group' }, { 'X-Admin-Key': adminKey });
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'with-group' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/groups/assign', { groupId: grp.id, key: k2 }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/group-activity', { 'X-Admin-Key': adminKey });

    expect(r.body.groups.length).toBe(2);
    const ungrouped = r.body.groups.find((g: any) => g.group === 'ungrouped');
    expect(ungrouped).toBeDefined();
    expect(ungrouped.keyCount).toBe(1);
  });

  test('includes credits remaining per group', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const grp = (await httpPost(port, '/groups', { name: 'g1' }, { 'X-Admin-Key': adminKey })).body;

    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'a' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 200, name: 'b' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/groups/assign', { groupId: grp.id, key: k1 }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/groups/assign', { groupId: grp.id, key: k2 }, { 'X-Admin-Key': adminKey });

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });

    const r = await httpGet(port, '/admin/group-activity', { 'X-Admin-Key': adminKey });

    const g1 = r.body.groups.find((g: any) => g.group === 'g1');
    expect(g1.creditsRemaining).toBe(290); // 90 + 200
  });

  test('summary includes topGroup', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const big = (await httpPost(port, '/groups', { name: 'big' }, { 'X-Admin-Key': adminKey })).body;
    const small = (await httpPost(port, '/groups', { name: 'small' }, { 'X-Admin-Key': adminKey })).body;

    const k1 = (await httpPost(port, '/keys', { credits: 200, name: 'a' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'b' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/groups/assign', { groupId: big.id, key: k1 }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/groups/assign', { groupId: small.id, key: k2 }, { 'X-Admin-Key': adminKey });

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });

    const r = await httpGet(port, '/admin/group-activity', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.topGroup).toBe('big');
    expect(r.body.summary.totalGroups).toBeGreaterThanOrEqual(2);
  });

  test('excludes revoked and suspended keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const grp = (await httpPost(port, '/groups', { name: 'g1' }, { 'X-Admin-Key': adminKey })).body;

    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'revoked' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'suspended' }, { 'X-Admin-Key': adminKey })).body.key;
    const k3 = (await httpPost(port, '/keys', { credits: 100, name: 'active' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/groups/assign', { groupId: grp.id, key: k1 }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/groups/assign', { groupId: grp.id, key: k2 }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/groups/assign', { groupId: grp.id, key: k3 }, { 'X-Admin-Key': adminKey });

    await httpPost(port, '/keys/revoke', { key: k1 }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys/suspend', { key: k2 }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/group-activity', { 'X-Admin-Key': adminKey });

    const g1 = r.body.groups.find((g: any) => g.group === 'g1');
    expect(g1.keyCount).toBe(1);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/group-activity');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/group-activity', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.groupActivity).toBeDefined();
    expect(r.body.endpoints.groupActivity).toContain('/admin/group-activity');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const grp = (await httpPost(port, '/groups', { name: 'g1' }, { 'X-Admin-Key': adminKey })).body;
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/groups/assign', { groupId: grp.id, key: k }, { 'X-Admin-Key': adminKey });

    await httpGet(port, '/admin/group-activity', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/group-activity', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
