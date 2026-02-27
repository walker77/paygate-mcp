/**
 * Tests for v8.11.0 — Key Lifecycle Analysis
 *
 * GET /admin/key-portfolio — Key lifecycle metrics: creation patterns, active/inactive
 * ratios, key age distribution, stale keys, expiring-soon keys, and turnover.
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

function httpDelete(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'DELETE', headers },
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

/* ── tests ───────────────────────────────────────────────── */

describe('Key Lifecycle Analysis', () => {
  jest.setTimeout(15000);

  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    await server.stop();
  });

  test('returns complete lifecycle structure', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/key-portfolio', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalKeys).toBe('number');
    expect(typeof r.body.summary.activeKeys).toBe('number');
    expect(typeof r.body.summary.inactiveKeys).toBe('number');
    expect(Array.isArray(r.body.staleKeys)).toBe(true);
    expect(Array.isArray(r.body.expiringSoon)).toBe(true);
  });

  test('empty system returns zeroed metrics', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/key-portfolio', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalKeys).toBe(0);
    expect(r.body.summary.activeKeys).toBe(0);
    expect(r.body.summary.inactiveKeys).toBe(0);
    expect(r.body.staleKeys).toHaveLength(0);
    expect(r.body.expiringSoon).toHaveLength(0);
  });

  test('counts active and inactive keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'active-key' }, { 'X-Admin-Key': adminKey });
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'will-revoke' }, { 'X-Admin-Key': adminKey })).body.key;

    // Revoke the second key
    await httpPost(port, '/keys/revoke', { key: k2 }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/key-portfolio', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalKeys).toBe(2);
    expect(r.body.summary.activeKeys).toBe(1);
    expect(r.body.summary.inactiveKeys).toBe(1);
  });

  test('identifies expiring-soon keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Key expiring in 12 hours (should be flagged as expiring soon)
    await httpPost(port, '/keys', {
      credits: 100,
      name: 'soon-expire',
      expiresAt: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
    }, { 'X-Admin-Key': adminKey });

    // Key expiring in 30 days (should NOT be flagged)
    await httpPost(port, '/keys', {
      credits: 100,
      name: 'far-expire',
      expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
    }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/key-portfolio', { 'X-Admin-Key': adminKey });

    const soonNames = r.body.expiringSoon.map((k: any) => k.name);
    expect(soonNames).toContain('soon-expire');
    expect(soonNames).not.toContain('far-expire');
  });

  test('identifies stale keys (never used)', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'never-used' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/key-portfolio', { 'X-Admin-Key': adminKey });

    const staleNames = r.body.staleKeys.map((k: any) => k.name);
    expect(staleNames).toContain('never-used');
  });

  test('used keys not flagged as stale', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'recently-used' }, { 'X-Admin-Key': adminKey })).body.key;

    // Use the key
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/key-portfolio', { 'X-Admin-Key': adminKey });

    const staleNames = r.body.staleKeys.map((k: any) => k.name);
    expect(staleNames).not.toContain('recently-used');
  });

  test('key age distribution', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'new-key' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/key-portfolio', { 'X-Admin-Key': adminKey });

    expect(r.body.ageDistribution).toBeDefined();
    expect(typeof r.body.ageDistribution.averageAgeDays).toBe('number');
    expect(r.body.ageDistribution.averageAgeDays).toBeGreaterThanOrEqual(0);
  });

  test('suspended keys counted separately', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const created = await httpPost(port, '/keys', { credits: 100, name: 'will-suspend' }, { 'X-Admin-Key': adminKey });

    // Suspend the key
    await httpPost(port, '/keys/suspend', { key: created.body.key }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/key-portfolio', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.suspendedKeys).toBeGreaterThanOrEqual(1);
  });

  test('credit utilization per key', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'utilizer' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/key-portfolio', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.averageCreditUtilization).toBeDefined();
    expect(typeof r.body.summary.averageCreditUtilization).toBe('number');
  });

  test('namespace breakdown', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'ns-a', namespace: 'prod' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 100, name: 'ns-b', namespace: 'staging' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/key-portfolio', { 'X-Admin-Key': adminKey });

    expect(r.body.byNamespace).toBeDefined();
    expect(r.body.byNamespace.length).toBeGreaterThanOrEqual(2);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/key-portfolio');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/key-portfolio', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.keyPortfolio).toBeDefined();
    expect(r.body.endpoints.keyPortfolio).toContain('/admin/key-portfolio');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/key-portfolio', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/key-portfolio', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
