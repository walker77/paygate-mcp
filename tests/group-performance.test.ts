/**
 * Tests for v8.24.0 — Group Performance
 *
 * GET /admin/group-performance — Per-group analytics: key counts,
 * credit allocation/spending, call volume, utilization, and
 * group policy summary.
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

describe('Group Performance', () => {
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

    const r = await httpGet(port, '/admin/group-performance', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalGroups).toBe('number');
    expect(Array.isArray(r.body.groups)).toBe(true);
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no groups', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/group-performance', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalGroups).toBe(0);
    expect(r.body.groups.length).toBe(0);
  });

  test('tracks group with keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create a group
    const grp = await httpPost(port, '/groups', { name: 'prod-team', description: 'Production' }, { 'X-Admin-Key': adminKey });
    const groupId = grp.body.id;

    // Create keys and assign to group
    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'key-a' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 200, name: 'key-b' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/groups/assign', { key: k1, groupId }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/groups/assign', { key: k2, groupId }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/group-performance', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalGroups).toBe(1);
    expect(r.body.groups.length).toBe(1);
    expect(r.body.groups[0].groupName).toBe('prod-team');
    expect(r.body.groups[0].keyCount).toBe(2);
    expect(r.body.groups[0].totalAllocated).toBe(300);
  });

  test('shows credit utilization', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create group + key
    const grp = await httpPost(port, '/groups', { name: 'test-group' }, { 'X-Admin-Key': adminKey });
    const groupId = grp.body.id;
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'spender' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/groups/assign', { key: k, groupId }, { 'X-Admin-Key': adminKey });

    // Make tool calls to spend credits
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} }
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/group-performance', { 'X-Admin-Key': adminKey });

    expect(r.body.groups[0].totalSpent).toBeGreaterThan(0);
    expect(r.body.groups[0].totalCalls).toBeGreaterThan(0);
    expect(typeof r.body.groups[0].utilizationPct).toBe('number');
  });

  test('multiple groups sorted by spending', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create two groups
    const grp1 = await httpPost(port, '/groups', { name: 'low-spend' }, { 'X-Admin-Key': adminKey });
    const grp2 = await httpPost(port, '/groups', { name: 'high-spend' }, { 'X-Admin-Key': adminKey });

    // Create keys
    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'k1' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'k2' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/groups/assign', { key: k1, groupId: grp1.body.id }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/groups/assign', { key: k2, groupId: grp2.body.id }, { 'X-Admin-Key': adminKey });

    // Spend more on k2 (high-spend group)
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/group-performance', { 'X-Admin-Key': adminKey });

    expect(r.body.groups.length).toBe(2);
    // Sorted by totalSpent descending
    expect(r.body.groups[0].totalSpent).toBeGreaterThanOrEqual(r.body.groups[1].totalSpent);
    expect(r.body.groups[0].groupName).toBe('high-spend');
  });

  test('includes group policy summary', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/groups', {
      name: 'restricted',
      allowedTools: ['tool_a'],
      rateLimitPerMin: 30,
    }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/group-performance', { 'X-Admin-Key': adminKey });

    expect(r.body.groups[0].policy).toBeDefined();
    expect(r.body.groups[0].policy.allowedTools).toEqual(['tool_a']);
    expect(r.body.groups[0].policy.rateLimitPerMin).toBe(30);
  });

  test('ungrouped keys summary', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create a key without a group
    await httpPost(port, '/keys', { credits: 100, name: 'solo-key' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/group-performance', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.ungroupedKeys).toBeDefined();
    expect(r.body.summary.ungroupedKeys).toBeGreaterThanOrEqual(1);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/group-performance');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/group-performance', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.groupPerformance).toBeDefined();
    expect(r.body.endpoints.groupPerformance).toContain('/admin/group-performance');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/group-performance', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/group-performance', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
