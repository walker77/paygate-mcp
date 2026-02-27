/**
 * Tests for v8.54.0 — Namespace Activity
 *
 * GET /admin/namespace-activity — Per-namespace activity metrics with
 * key counts, total spend, total calls, credits remaining, and active
 * consumer counts for multi-tenant visibility.
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

describe('Namespace Activity', () => {
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

    const r = await httpGet(port, '/admin/namespace-activity', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.namespaces)).toBe(true);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalNamespaces).toBe('number');
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/namespace-activity', { 'X-Admin-Key': adminKey });

    expect(r.body.namespaces.length).toBe(0);
    expect(r.body.summary.totalNamespaces).toBe(0);
  });

  test('groups keys by namespace', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'a', namespace: 'ns-alpha' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 100, name: 'b', namespace: 'ns-alpha' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 100, name: 'c', namespace: 'ns-beta' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/namespace-activity', { 'X-Admin-Key': adminKey });

    expect(r.body.namespaces.length).toBe(2);
    const alpha = r.body.namespaces.find((n: any) => n.namespace === 'ns-alpha');
    const beta = r.body.namespaces.find((n: any) => n.namespace === 'ns-beta');
    expect(alpha.keyCount).toBe(2);
    expect(beta.keyCount).toBe(1);
  });

  test('tracks spend and calls per namespace', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 200, name: 'a', namespace: 'prod' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 200, name: 'b', namespace: 'staging' }, { 'X-Admin-Key': adminKey })).body.key;

    // prod: 2 calls = 20 credits
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });

    // staging: 1 call = 10 credits
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/namespace-activity', { 'X-Admin-Key': adminKey });

    const prod = r.body.namespaces.find((n: any) => n.namespace === 'prod');
    const staging = r.body.namespaces.find((n: any) => n.namespace === 'staging');

    expect(prod.totalSpent).toBe(20);
    expect(prod.totalCalls).toBe(2);
    expect(staging.totalSpent).toBe(10);
    expect(staging.totalCalls).toBe(1);
  });

  test('sorted by totalSpent descending', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 200, name: 'a', namespace: 'low' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 200, name: 'b', namespace: 'high' }, { 'X-Admin-Key': adminKey })).body.key;

    // low: 1 call = 5
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });

    // high: 3 calls = 15
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/namespace-activity', { 'X-Admin-Key': adminKey });

    expect(r.body.namespaces[0].namespace).toBe('high');
    expect(r.body.namespaces[1].namespace).toBe('low');
  });

  test('includes credits remaining per namespace', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'a', namespace: 'ns1' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys', { credits: 200, name: 'b', namespace: 'ns1' }, { 'X-Admin-Key': adminKey });

    // 1 call on k1 = 10 credits spent, k1 now has 90
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });

    const r = await httpGet(port, '/admin/namespace-activity', { 'X-Admin-Key': adminKey });

    const ns1 = r.body.namespaces.find((n: any) => n.namespace === 'ns1');
    expect(ns1.creditsRemaining).toBe(290); // 90 + 200
  });

  test('keys without namespace grouped as "default"', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'no-ns' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 100, name: 'with-ns', namespace: 'custom' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/namespace-activity', { 'X-Admin-Key': adminKey });

    expect(r.body.namespaces.length).toBe(2);
    const defaultNs = r.body.namespaces.find((n: any) => n.namespace === 'default');
    expect(defaultNs).toBeDefined();
    expect(defaultNs.keyCount).toBe(1);
  });

  test('excludes revoked and suspended keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'revoked', namespace: 'ns1' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'suspended', namespace: 'ns1' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys', { credits: 100, name: 'active', namespace: 'ns1' }, { 'X-Admin-Key': adminKey });

    await httpPost(port, '/keys/revoke', { key: k1 }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys/suspend', { key: k2 }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/namespace-activity', { 'X-Admin-Key': adminKey });

    const ns1 = r.body.namespaces.find((n: any) => n.namespace === 'ns1');
    expect(ns1.keyCount).toBe(1);
  });

  test('summary includes topNamespace', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 200, name: 'a', namespace: 'big' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys', { credits: 100, name: 'b', namespace: 'small' }, { 'X-Admin-Key': adminKey });

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });

    const r = await httpGet(port, '/admin/namespace-activity', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.topNamespace).toBe('big');
    expect(r.body.summary.totalNamespaces).toBe(2);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/namespace-activity');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/namespace-activity', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.namespaceActivity).toBeDefined();
    expect(r.body.endpoints.namespaceActivity).toContain('/admin/namespace-activity');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable', namespace: 'ns1' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/namespace-activity', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/namespace-activity', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
