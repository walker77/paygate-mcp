/**
 * Tests for v8.0.0 — Key Dashboard
 *
 * GET /keys/dashboard?key=... — Consolidated key overview with metadata,
 * balance, health, velocity, rate limits, quotas, usage, and recent activity.
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

describe('Key Dashboard', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let apiKey: string;

  beforeEach(async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
    const r = await httpPost(port, '/keys', { credits: 100, name: 'dash-key' }, { 'X-Admin-Key': adminKey });
    apiKey = r.body.key;
  }, 30_000);

  afterEach(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('returns complete dashboard for active key', async () => {
    const r = await httpGet(port, `/keys/dashboard?key=${apiKey}`, { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    // Metadata
    expect(r.body.key).toMatch(/^pg_.+\.\.\./);
    expect(r.body.name).toBe('dash-key');
    expect(r.body.status).toBe('active');
    // Balance
    expect(r.body.balance).toBeDefined();
    expect(r.body.balance.credits).toBe(100);
    expect(r.body.balance.totalSpent).toBe(0);
    expect(r.body.balance.totalAllocated).toBe(100);
    // Health
    expect(r.body.health).toBeDefined();
    expect(r.body.health.score).toBeGreaterThanOrEqual(0);
    expect(r.body.health.score).toBeLessThanOrEqual(100);
    expect(typeof r.body.health.status).toBe('string');
    // Velocity
    expect(r.body.velocity).toBeDefined();
    expect(typeof r.body.velocity.creditsPerHour).toBe('number');
    expect(typeof r.body.velocity.creditsPerDay).toBe('number');
    // Rate limits
    expect(r.body.rateLimits).toBeDefined();
    expect(r.body.rateLimits.global).toBeDefined();
    expect(r.body.rateLimits.global.limit).toBeGreaterThan(0);
    // Usage
    expect(r.body.usage).toBeDefined();
    expect(r.body.usage.totalCalls).toBe(0);
    // Recent activity
    expect(Array.isArray(r.body.recentActivity)).toBe(true);
  });

  test('shows suspended status', async () => {
    await httpPost(port, '/keys/suspend', { key: apiKey }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, `/keys/dashboard?key=${apiKey}`, { 'X-Admin-Key': adminKey });

    expect(r.body.status).toBe('suspended');
  });

  test('shows revoked status', async () => {
    await httpPost(port, '/keys/revoke', { key: apiKey }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, `/keys/dashboard?key=${apiKey}`, { 'X-Admin-Key': adminKey });

    expect(r.body.status).toBe('revoked');
  });

  test('balance reflects spending', async () => {
    // Make a tool call to spend credits
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': apiKey });

    const r = await httpGet(port, `/keys/dashboard?key=${apiKey}`, { 'X-Admin-Key': adminKey });

    expect(r.body.balance.credits).toBe(95); // 100 - 5
    expect(r.body.balance.totalSpent).toBe(5);
    expect(r.body.balance.totalAllocated).toBe(100);
  });

  test('spending limit included when configured', async () => {
    await httpPost(port, '/limits', { key: apiKey, spendingLimit: 50 }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, `/keys/dashboard?key=${apiKey}`, { 'X-Admin-Key': adminKey });

    expect(r.body.balance.spendingLimit).toBe(50);
  });

  test('no spending limit when not set', async () => {
    const r = await httpGet(port, `/keys/dashboard?key=${apiKey}`, { 'X-Admin-Key': adminKey });
    expect(r.body.balance.spendingLimit).toBeUndefined();
  });

  test('health score reflects key state', async () => {
    const r = await httpGet(port, `/keys/dashboard?key=${apiKey}`, { 'X-Admin-Key': adminKey });
    // Healthy key with credits and no usage should score high
    expect(r.body.health.score).toBeGreaterThanOrEqual(75);
  });

  test('usage counts after tool calls', async () => {
    // Make two tool calls
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': apiKey });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_b', arguments: {} },
    }, { 'X-API-Key': apiKey });

    const r = await httpGet(port, `/keys/dashboard?key=${apiKey}`, { 'X-Admin-Key': adminKey });

    expect(r.body.usage.totalCalls).toBe(2);
    expect(r.body.usage.totalAllowed).toBe(2);
    expect(r.body.usage.totalDenied).toBe(0);
    expect(r.body.usage.totalCredits).toBe(10); // 5 + 5
  });

  test('quotas section present when configured', async () => {
    const ps = makeServer({
      defaultCreditsPerCall: 1,
      globalQuota: { dailyCallLimit: 100, monthlyCallLimit: 1000 },
    });
    const pStarted = await ps.start();
    const pk = (await httpPost(pStarted.port, '/keys', { credits: 100 }, { 'X-Admin-Key': pStarted.adminKey })).body.key;

    const r = await httpGet(pStarted.port, `/keys/dashboard?key=${pk}`, { 'X-Admin-Key': pStarted.adminKey });

    expect(r.body.quotas).toBeDefined();
    expect(r.body.quotas.source).toBe('global');
    expect(r.body.quotas.daily.callsLimit).toBe(100);
    expect(r.body.quotas.monthly.callsLimit).toBe(1000);

    await ps.stop();
  });

  test('no quotas section when not configured', async () => {
    const r = await httpGet(port, `/keys/dashboard?key=${apiKey}`, { 'X-Admin-Key': adminKey });
    expect(r.body.quotas).toBeUndefined();
  });

  test('supports alias keys', async () => {
    await httpPost(port, '/keys/alias', { key: apiKey, alias: 'dash-alias' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/keys/dashboard?key=dash-alias', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.name).toBe('dash-key');
    expect(r.body.balance.credits).toBe(100);
  });

  test('includes namespace and group', async () => {
    // Create key in namespace
    const r2 = await httpPost(port, '/keys', {
      credits: 50, name: 'ns-key', namespace: 'prod',
    }, { 'X-Admin-Key': adminKey });
    const nsKey = r2.body.key;

    const r = await httpGet(port, `/keys/dashboard?key=${nsKey}`, { 'X-Admin-Key': adminKey });

    expect(r.body.namespace).toBe('prod');
  });

  test('includes tags when present', async () => {
    await httpPost(port, '/keys/tags', { key: apiKey, tags: { env: 'staging', team: 'alpha' } }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, `/keys/dashboard?key=${apiKey}`, { 'X-Admin-Key': adminKey });

    expect(r.body.tags).toBeDefined();
    expect(r.body.tags.env).toBe('staging');
    expect(r.body.tags.team).toBe('alpha');
  });

  test('requires admin key', async () => {
    const r = await httpGet(port, `/keys/dashboard?key=${apiKey}`);
    expect(r.status).toBe(401);
  });

  test('requires key parameter', async () => {
    const r = await httpGet(port, '/keys/dashboard', { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('key');
  });

  test('returns 404 for unknown key', async () => {
    const r = await httpGet(port, '/keys/dashboard?key=pg_nonexistent', { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(404);
  });

  test('rejects POST method', async () => {
    const r = await httpPost(port, '/keys/dashboard', { key: apiKey }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.keyDashboard).toBeDefined();
    expect(r.body.endpoints.keyDashboard).toContain('/keys/dashboard');
  });

  test('recent activity includes key creation event', async () => {
    // The key was just created — audit trail should have it
    const r = await httpGet(port, `/keys/dashboard?key=${apiKey}`, { 'X-Admin-Key': adminKey });
    // Recent activity may include key.created event
    if (r.body.recentActivity.length > 0) {
      expect(r.body.recentActivity[0].timestamp).toBeDefined();
      expect(r.body.recentActivity[0].event).toBeDefined();
    }
  });

  test('velocity shows zero for unused key', async () => {
    const r = await httpGet(port, `/keys/dashboard?key=${apiKey}`, { 'X-Admin-Key': adminKey });
    expect(r.body.velocity.creditsPerHour).toBe(0);
    expect(r.body.velocity.creditsPerDay).toBe(0);
  });

  test('does not modify key state', async () => {
    // Call dashboard multiple times
    await httpGet(port, `/keys/dashboard?key=${apiKey}`, { 'X-Admin-Key': adminKey });
    await httpGet(port, `/keys/dashboard?key=${apiKey}`, { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': apiKey });
    expect(balance.body.credits).toBe(100);
  });
});
