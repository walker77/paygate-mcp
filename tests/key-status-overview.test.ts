/**
 * Tests for v8.26.0 — Key Status Overview
 *
 * GET /admin/key-status — Quick-glance key status dashboard:
 * active/suspended/revoked/expired counts, keys needing attention
 * (low credits, near expiry), and status distribution.
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

describe('Key Status Overview', () => {
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

    const r = await httpGet(port, '/admin/key-status', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.counts).toBeDefined();
    expect(typeof r.body.counts.total).toBe('number');
    expect(typeof r.body.counts.active).toBe('number');
    expect(typeof r.body.counts.suspended).toBe('number');
    expect(typeof r.body.counts.revoked).toBe('number');
    expect(typeof r.body.counts.expired).toBe('number');
    expect(Array.isArray(r.body.needsAttention)).toBe(true);
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/key-status', { 'X-Admin-Key': adminKey });

    expect(r.body.counts.total).toBe(0);
    expect(r.body.counts.active).toBe(0);
    expect(r.body.needsAttention.length).toBe(0);
  });

  test('counts active keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'k1' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 200, name: 'k2' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/key-status', { 'X-Admin-Key': adminKey });

    expect(r.body.counts.total).toBe(2);
    expect(r.body.counts.active).toBe(2);
  });

  test('counts suspended keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'to-suspend' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys/suspend', { key: k }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/key-status', { 'X-Admin-Key': adminKey });

    expect(r.body.counts.suspended).toBe(1);
  });

  test('counts revoked keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'to-revoke' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys/revoke', { key: k }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/key-status', { 'X-Admin-Key': adminKey });

    expect(r.body.counts.revoked).toBe(1);
  });

  test('flags low credit keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create key with very low credits
    await httpPost(port, '/keys', { credits: 2, name: 'low-credits' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/key-status', { 'X-Admin-Key': adminKey });

    const lowCredit = r.body.needsAttention.find((a: any) => a.issue === 'low_credits');
    expect(lowCredit).toBeDefined();
    expect(lowCredit.keyName).toBe('low-credits');
  });

  test('flags expiring keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create key that expires in 1 day
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'expiring-soon' }, { 'X-Admin-Key': adminKey })).body.key;
    const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 1 day from now
    await httpPost(port, '/keys/expiry', { key: k, expiresAt: expiry }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/key-status', { 'X-Admin-Key': adminKey });

    const expiring = r.body.needsAttention.find((a: any) => a.issue === 'expiring_soon');
    expect(expiring).toBeDefined();
    expect(expiring.keyName).toBe('expiring-soon');
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/key-status');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/key-status', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.keyStatus).toBeDefined();
    expect(r.body.endpoints.keyStatus).toContain('/admin/key-status');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/key-status', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/key-status', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
