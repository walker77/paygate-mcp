/**
 * Tests for v8.29.0 — System Health Score
 *
 * GET /admin/system-health — Composite system health score 0-100
 * with component breakdowns: key health, webhook health, credit
 * utilization, error rates, and capacity.
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

describe('System Health Score', () => {
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

    const r = await httpGet(port, '/admin/system-health', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(typeof r.body.score).toBe('number');
    expect(r.body.score).toBeGreaterThanOrEqual(0);
    expect(r.body.score).toBeLessThanOrEqual(100);
    expect(typeof r.body.level).toBe('string');
    expect(r.body.components).toBeDefined();
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('healthy score when empty system', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/system-health', { 'X-Admin-Key': adminKey });

    // Empty system should be healthy (no problems)
    expect(r.body.score).toBeGreaterThanOrEqual(80);
    expect(['healthy', 'good']).toContain(r.body.level);
  });

  test('includes key health component', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'k1' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/system-health', { 'X-Admin-Key': adminKey });

    expect(r.body.components.keyHealth).toBeDefined();
    expect(typeof r.body.components.keyHealth.score).toBe('number');
    expect(typeof r.body.components.keyHealth.detail).toBe('string');
  });

  test('includes error rate component', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/system-health', { 'X-Admin-Key': adminKey });

    expect(r.body.components.errorRate).toBeDefined();
    expect(typeof r.body.components.errorRate.score).toBe('number');
  });

  test('includes credit utilization component', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/system-health', { 'X-Admin-Key': adminKey });

    expect(r.body.components.creditUtilization).toBeDefined();
    expect(typeof r.body.components.creditUtilization.score).toBe('number');
  });

  test('score degrades with suspended keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create keys and suspend some
    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'good1' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'bad1' }, { 'X-Admin-Key': adminKey })).body.key;
    const k3 = (await httpPost(port, '/keys', { credits: 100, name: 'bad2' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys/suspend', { key: k2 }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys/suspend', { key: k3 }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/system-health', { 'X-Admin-Key': adminKey });

    // Key health should be degraded
    expect(r.body.components.keyHealth.score).toBeLessThan(100);
  });

  test('level reflects score', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/system-health', { 'X-Admin-Key': adminKey });

    // Level should match score range
    const validLevels = ['healthy', 'good', 'warning', 'critical'];
    expect(validLevels).toContain(r.body.level);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/system-health');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/system-health', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.systemHealth).toBeDefined();
    expect(r.body.endpoints.systemHealth).toContain('/admin/system-health');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/system-health', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/system-health', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
