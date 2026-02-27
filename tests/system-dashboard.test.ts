/**
 * Tests for v8.2.0 — System Dashboard
 *
 * GET /admin/dashboard — System-wide overview with key stats, credit summary,
 * usage breakdown, top consumers, top tools, notification counts, and uptime.
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

describe('System Dashboard', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeEach(async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
  }, 30_000);

  afterEach(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('returns complete dashboard structure', async () => {
    const r = await httpGet(port, '/admin/dashboard', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    // Keys section
    expect(r.body.keys).toBeDefined();
    expect(typeof r.body.keys.total).toBe('number');
    expect(typeof r.body.keys.active).toBe('number');
    expect(typeof r.body.keys.suspended).toBe('number');
    expect(typeof r.body.keys.revoked).toBe('number');
    expect(typeof r.body.keys.expired).toBe('number');
    // Credits section
    expect(r.body.credits).toBeDefined();
    expect(typeof r.body.credits.totalAllocated).toBe('number');
    expect(typeof r.body.credits.totalSpent).toBe('number');
    expect(typeof r.body.credits.totalRemaining).toBe('number');
    // Usage section
    expect(r.body.usage).toBeDefined();
    expect(typeof r.body.usage.totalCalls).toBe('number');
    expect(typeof r.body.usage.totalAllowed).toBe('number');
    expect(typeof r.body.usage.totalDenied).toBe('number');
    expect(typeof r.body.usage.totalCreditsSpent).toBe('number');
    expect(Array.isArray(r.body.usage.denyReasons)).toBe(true);
    // Top consumers and tools
    expect(Array.isArray(r.body.topConsumers)).toBe(true);
    expect(Array.isArray(r.body.topTools)).toBe(true);
    // Notifications
    expect(r.body.notifications).toBeDefined();
    expect(typeof r.body.notifications.critical).toBe('number');
    expect(typeof r.body.notifications.warning).toBe('number');
    expect(typeof r.body.notifications.info).toBe('number');
    // Uptime
    expect(r.body.uptime).toBeDefined();
    expect(typeof r.body.uptime.startedAt).toBe('string');
    expect(typeof r.body.uptime.uptimeSeconds).toBe('number');
    expect(typeof r.body.uptime.uptimeHours).toBe('number');
  });

  test('empty system has zero counts', async () => {
    const r = await httpGet(port, '/admin/dashboard', { 'X-Admin-Key': adminKey });

    expect(r.body.keys.total).toBe(0);
    expect(r.body.keys.active).toBe(0);
    expect(r.body.credits.totalAllocated).toBe(0);
    expect(r.body.credits.totalSpent).toBe(0);
    expect(r.body.credits.totalRemaining).toBe(0);
    expect(r.body.usage.totalCalls).toBe(0);
  });

  test('counts active keys', async () => {
    await httpPost(port, '/keys', { credits: 100, name: 'k1' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 200, name: 'k2' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/dashboard', { 'X-Admin-Key': adminKey });

    expect(r.body.keys.total).toBe(2);
    expect(r.body.keys.active).toBe(2);
  });

  test('counts suspended keys', async () => {
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'susp' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys/suspend', { key: k }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/dashboard', { 'X-Admin-Key': adminKey });

    expect(r.body.keys.suspended).toBe(1);
    expect(r.body.keys.active).toBe(0);
  });

  test('counts revoked keys', async () => {
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'rev' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys/revoke', { key: k }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/dashboard', { 'X-Admin-Key': adminKey });

    expect(r.body.keys.revoked).toBe(1);
  });

  test('counts expired keys', async () => {
    await httpPost(port, '/keys', {
      credits: 100, name: 'exp',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/dashboard', { 'X-Admin-Key': adminKey });

    expect(r.body.keys.expired).toBe(1);
    expect(r.body.keys.active).toBe(0);
  });

  test('credit summary reflects allocations', async () => {
    await httpPost(port, '/keys', { credits: 100, name: 'c1' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 200, name: 'c2' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/dashboard', { 'X-Admin-Key': adminKey });

    expect(r.body.credits.totalAllocated).toBe(300);
    expect(r.body.credits.totalRemaining).toBe(300);
    expect(r.body.credits.totalSpent).toBe(0);
  });

  test('credit summary reflects spending', async () => {
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'spender' }, { 'X-Admin-Key': adminKey })).body.key;
    // Discover tools and make a call
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 999, method: 'tools/list', params: {},
    }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/dashboard', { 'X-Admin-Key': adminKey });

    expect(r.body.credits.totalAllocated).toBe(100);
    expect(r.body.credits.totalSpent).toBe(5);
    expect(r.body.credits.totalRemaining).toBe(95);
  });

  test('usage counts track tool calls', async () => {
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'user' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 999, method: 'tools/list', params: {},
    }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_b', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/dashboard', { 'X-Admin-Key': adminKey });

    expect(r.body.usage.totalCalls).toBe(2);
    expect(r.body.usage.totalAllowed).toBe(2);
    expect(r.body.usage.totalDenied).toBe(0);
    expect(r.body.usage.totalCreditsSpent).toBe(10);
  });

  test('top consumers ranked by credits spent', async () => {
    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'light-user' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'heavy-user' }, { 'X-Admin-Key': adminKey })).body.key;
    // Discover tools
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 999, method: 'tools/list', params: {},
    }, { 'X-API-Key': k1 });
    // k1: 1 call (5 credits)
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k1 });
    // k2: 2 calls (10 credits)
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k2 });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'tool_b', arguments: {} },
    }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/dashboard', { 'X-Admin-Key': adminKey });

    expect(r.body.topConsumers.length).toBe(2);
    // heavy-user should be first (more credits spent)
    expect(r.body.topConsumers[0].credits).toBeGreaterThanOrEqual(r.body.topConsumers[1].credits);
  });

  test('top tools ranked by call count', async () => {
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'caller' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 999, method: 'tools/list', params: {},
    }, { 'X-API-Key': k });
    // Call tool_a twice, tool_b once
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'tool_b', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/dashboard', { 'X-Admin-Key': adminKey });

    expect(r.body.topTools.length).toBe(2);
    // tool_a should be first (more calls)
    expect(r.body.topTools[0].tool).toBe('tool_a');
    expect(r.body.topTools[0].calls).toBe(2);
    expect(r.body.topTools[1].tool).toBe('tool_b');
    expect(r.body.topTools[1].calls).toBe(1);
  });

  test('notification counts reflect key issues', async () => {
    // Create a suspended key (info notification)
    const sk = (await httpPost(port, '/keys', { credits: 100, name: 'susp' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys/suspend', { key: sk }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/dashboard', { 'X-Admin-Key': adminKey });

    expect(r.body.notifications.info).toBeGreaterThanOrEqual(1);
  });

  test('notification counts reflect expiring keys', async () => {
    await httpPost(port, '/keys', {
      credits: 100, name: 'expiring',
      expiresAt: new Date(Date.now() + 6 * 3_600_000).toISOString(), // 6 hours — critical
    }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/dashboard', { 'X-Admin-Key': adminKey });

    expect(r.body.notifications.critical).toBeGreaterThanOrEqual(1);
  });

  test('uptime increases over time', async () => {
    const r = await httpGet(port, '/admin/dashboard', { 'X-Admin-Key': adminKey });

    expect(r.body.uptime.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(r.body.uptime.startedAt).toBeTruthy();
    // startedAt should be a valid ISO date
    expect(new Date(r.body.uptime.startedAt).getTime()).toBeGreaterThan(0);
  });

  test('mixed key states counted correctly', async () => {
    // 2 active
    await httpPost(port, '/keys', { credits: 100, name: 'a1' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 100, name: 'a2' }, { 'X-Admin-Key': adminKey });
    // 1 suspended
    const sk = (await httpPost(port, '/keys', { credits: 100, name: 's1' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys/suspend', { key: sk }, { 'X-Admin-Key': adminKey });
    // 1 revoked
    const rk = (await httpPost(port, '/keys', { credits: 100, name: 'r1' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys/revoke', { key: rk }, { 'X-Admin-Key': adminKey });
    // 1 expired
    await httpPost(port, '/keys', {
      credits: 100, name: 'e1',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/dashboard', { 'X-Admin-Key': adminKey });

    expect(r.body.keys.total).toBe(5);
    expect(r.body.keys.active).toBe(2);
    expect(r.body.keys.suspended).toBe(1);
    expect(r.body.keys.revoked).toBe(1);
    expect(r.body.keys.expired).toBe(1);
    expect(r.body.credits.totalAllocated).toBe(500);
  });

  test('requires admin key', async () => {
    const r = await httpGet(port, '/admin/dashboard');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    const r = await httpPost(port, '/admin/dashboard', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.systemDashboard).toBeDefined();
    expect(r.body.endpoints.systemDashboard).toContain('/admin/dashboard');
  });

  test('does not modify system state', async () => {
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    // Call dashboard multiple times
    await httpGet(port, '/admin/dashboard', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/dashboard', { 'X-Admin-Key': adminKey });

    // Balance should be unchanged
    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });

  test('denied calls tracked in usage', async () => {
    // Create key with only 5 credits (one call's worth)
    const k = (await httpPost(port, '/keys', { credits: 5, name: 'limited' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 999, method: 'tools/list', params: {},
    }, { 'X-API-Key': k });
    // First call succeeds (5 credits)
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });
    // Second call should be denied (0 credits remaining)
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/dashboard', { 'X-Admin-Key': adminKey });

    expect(r.body.usage.totalCalls).toBe(2);
    expect(r.body.usage.totalAllowed).toBe(1);
    expect(r.body.usage.totalDenied).toBe(1);
    expect(r.body.usage.denyReasons.length).toBeGreaterThanOrEqual(1);
  });
});
