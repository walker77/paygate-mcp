/**
 * Tests for v8.22.0 — Namespace Usage Summary
 *
 * GET /admin/namespace-usage — Per-namespace aggregated metrics:
 * credit allocation, spending, call counts, active keys, and
 * cross-namespace comparison.
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

describe('Namespace Usage Summary', () => {
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

    const r = await httpGet(port, '/admin/namespace-usage', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalNamespaces).toBe('number');
    expect(Array.isArray(r.body.namespaces)).toBe(true);
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/namespace-usage', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalNamespaces).toBe(0);
    expect(r.body.namespaces.length).toBe(0);
  });

  test('groups keys by namespace', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'prod-1', namespace: 'prod' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 200, name: 'prod-2', namespace: 'prod' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 50, name: 'dev-1', namespace: 'dev' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/namespace-usage', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalNamespaces).toBe(2);
    const prod = r.body.namespaces.find((n: any) => n.namespace === 'prod');
    expect(prod).toBeDefined();
    expect(prod.keyCount).toBe(2);
    expect(prod.totalAllocated).toBe(300);

    const dev = r.body.namespaces.find((n: any) => n.namespace === 'dev');
    expect(dev).toBeDefined();
    expect(dev.keyCount).toBe(1);
    expect(dev.totalAllocated).toBe(50);
  });

  test('tracks spending per namespace', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'spender', namespace: 'prod' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/namespace-usage', { 'X-Admin-Key': adminKey });

    const prod = r.body.namespaces.find((n: any) => n.namespace === 'prod');
    expect(prod.totalSpent).toBe(10);
    expect(prod.totalCalls).toBe(2);
  });

  test('default namespace for keys without namespace', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'no-ns' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/namespace-usage', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalNamespaces).toBe(1);
    expect(r.body.namespaces[0].namespace).toBe('default');
  });

  test('sorted by total spending descending', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 1000, name: 'big', namespace: 'big-ns' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 1000, name: 'small', namespace: 'small-ns' }, { 'X-Admin-Key': adminKey })).body.key;

    // big-ns: 3 calls = 15 credits
    for (let i = 1; i <= 3; i++) {
      await httpPost(port, '/mcp', { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });
    }
    // small-ns: 1 call = 5 credits
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/namespace-usage', { 'X-Admin-Key': adminKey });

    expect(r.body.namespaces[0].namespace).toBe('big-ns');
    expect(r.body.namespaces[0].totalSpent).toBe(15);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/namespace-usage');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/namespace-usage', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.namespaceUsage).toBeDefined();
    expect(r.body.endpoints.namespaceUsage).toContain('/admin/namespace-usage');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/namespace-usage', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/namespace-usage', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
