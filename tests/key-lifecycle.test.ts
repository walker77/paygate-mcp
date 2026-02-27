/**
 * Tests for v8.3.0 — Key Lifecycle Report
 *
 * GET /admin/lifecycle — Key lifecycle report with creation/revocation/expiry
 * trends, average lifetime, and at-risk keys.
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

describe('Key Lifecycle Report', () => {
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

  test('returns complete report structure', async () => {
    const r = await httpGet(port, '/admin/lifecycle', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    // Events section
    expect(r.body.events).toBeDefined();
    expect(typeof r.body.events.created).toBe('number');
    expect(typeof r.body.events.revoked).toBe('number');
    expect(typeof r.body.events.suspended).toBe('number');
    expect(typeof r.body.events.resumed).toBe('number');
    expect(typeof r.body.events.rotated).toBe('number');
    expect(typeof r.body.events.cloned).toBe('number');
    // Trends
    expect(Array.isArray(r.body.trends)).toBe(true);
    // At risk
    expect(Array.isArray(r.body.atRisk)).toBe(true);
  });

  test('empty system has zero event counts', async () => {
    const r = await httpGet(port, '/admin/lifecycle', { 'X-Admin-Key': adminKey });

    expect(r.body.events.created).toBe(0);
    expect(r.body.events.revoked).toBe(0);
    expect(r.body.events.suspended).toBe(0);
    expect(r.body.events.resumed).toBe(0);
    expect(r.body.atRisk).toHaveLength(0);
  });

  test('counts key creation events', async () => {
    await httpPost(port, '/keys', { credits: 100, name: 'k1' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 200, name: 'k2' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/lifecycle', { 'X-Admin-Key': adminKey });

    expect(r.body.events.created).toBe(2);
  });

  test('counts revocation events', async () => {
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'rev' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys/revoke', { key: k }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/lifecycle', { 'X-Admin-Key': adminKey });

    expect(r.body.events.created).toBe(1);
    expect(r.body.events.revoked).toBe(1);
  });

  test('counts suspension and resumption events', async () => {
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'toggle' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys/suspend', { key: k }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys/resume', { key: k }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/lifecycle', { 'X-Admin-Key': adminKey });

    expect(r.body.events.suspended).toBe(1);
    expect(r.body.events.resumed).toBe(1);
  });

  test('trends show daily buckets', async () => {
    await httpPost(port, '/keys', { credits: 100, name: 'trend-key' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/lifecycle', { 'X-Admin-Key': adminKey });

    expect(r.body.trends.length).toBeGreaterThanOrEqual(1);
    const today = new Date().toISOString().slice(0, 10);
    const todayBucket = r.body.trends.find((t: any) => t.date === today);
    expect(todayBucket).toBeDefined();
    expect(todayBucket.created).toBeGreaterThanOrEqual(1);
  });

  test('at-risk includes expiring keys', async () => {
    await httpPost(port, '/keys', {
      credits: 100, name: 'expiring-soon',
      expiresAt: new Date(Date.now() + 3 * 24 * 3_600_000).toISOString(), // 3 days
    }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/lifecycle', { 'X-Admin-Key': adminKey });

    const atRisk = r.body.atRisk.find((k: any) => k.name === 'expiring-soon');
    expect(atRisk).toBeDefined();
    expect(atRisk.risk).toBe('expiring_soon');
    expect(atRisk.details.daysRemaining).toBeLessThan(7);
  });

  test('at-risk includes expired keys', async () => {
    await httpPost(port, '/keys', {
      credits: 100, name: 'already-expired',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/lifecycle', { 'X-Admin-Key': adminKey });

    const atRisk = r.body.atRisk.find((k: any) => k.name === 'already-expired');
    expect(atRisk).toBeDefined();
    expect(atRisk.risk).toBe('expired');
  });

  test('at-risk includes zero-credit keys', async () => {
    // Create key with 5 credits, spend them all
    const k = (await httpPost(port, '/keys', { credits: 5, name: 'zero-cred' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 999, method: 'tools/list', params: {},
    }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/lifecycle', { 'X-Admin-Key': adminKey });

    const atRisk = r.body.atRisk.find((k: any) => k.name === 'zero-cred');
    expect(atRisk).toBeDefined();
    expect(atRisk.risk).toBe('zero_credits');
  });

  test('at-risk excludes suspended keys', async () => {
    const k = (await httpPost(port, '/keys', {
      credits: 100, name: 'susp-exp',
      expiresAt: new Date(Date.now() + 1 * 24 * 3_600_000).toISOString(),
    }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys/suspend', { key: k }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/lifecycle', { 'X-Admin-Key': adminKey });

    const atRisk = r.body.atRisk.find((k: any) => k.name === 'susp-exp');
    expect(atRisk).toBeUndefined();
  });

  test('at-risk excludes revoked keys', async () => {
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'rev-risk' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys/revoke', { key: k }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/lifecycle', { 'X-Admin-Key': adminKey });

    const atRisk = r.body.atRisk.find((k: any) => k.name === 'rev-risk');
    expect(atRisk).toBeUndefined();
  });

  test('healthy keys not in at-risk', async () => {
    await httpPost(port, '/keys', { credits: 1000, name: 'healthy' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/lifecycle', { 'X-Admin-Key': adminKey });

    expect(r.body.atRisk).toHaveLength(0);
  });

  test('multiple lifecycle events for same key', async () => {
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'multi' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys/suspend', { key: k }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys/resume', { key: k }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys/revoke', { key: k }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/lifecycle', { 'X-Admin-Key': adminKey });

    expect(r.body.events.created).toBe(1);
    expect(r.body.events.suspended).toBe(1);
    expect(r.body.events.resumed).toBe(1);
    expect(r.body.events.revoked).toBe(1);
  });

  test('average lifetime is null when no revoked keys', async () => {
    await httpPost(port, '/keys', { credits: 100, name: 'active' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/lifecycle', { 'X-Admin-Key': adminKey });

    expect(r.body.averageLifetimeHours).toBeNull();
  });

  test('requires admin key', async () => {
    const r = await httpGet(port, '/admin/lifecycle');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    const r = await httpPost(port, '/admin/lifecycle', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.keyLifecycle).toBeDefined();
    expect(r.body.endpoints.keyLifecycle).toContain('/admin/lifecycle');
  });

  test('at-risk key includes masked key', async () => {
    await httpPost(port, '/keys', {
      credits: 100, name: 'mask-check',
      expiresAt: new Date(Date.now() + 2 * 24 * 3_600_000).toISOString(),
    }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/lifecycle', { 'X-Admin-Key': adminKey });

    const atRisk = r.body.atRisk.find((k: any) => k.name === 'mask-check');
    expect(atRisk).toBeDefined();
    expect(atRisk.key).toMatch(/^pg_.+\.\.\./);
  });

  test('does not modify system state', async () => {
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    // Call lifecycle report multiple times
    await httpGet(port, '/admin/lifecycle', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/lifecycle', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
