/**
 * Tests for v8.4.0 — Cost Analysis
 *
 * GET /admin/costs — Cost analysis with per-tool, per-namespace breakdown,
 * hourly trends, and top spenders.
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

async function discoverTools(port: number, apiKey: string): Promise<void> {
  await httpPost(port, '/mcp', {
    jsonrpc: '2.0', id: 999, method: 'tools/list', params: {},
  }, { 'X-API-Key': apiKey });
}

/* ── tests ───────────────────────────────────────────────── */

describe('Cost Analysis', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeEach(async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
  });

  afterEach(async () => {
    await server.stop();
  });

  test('returns complete cost analysis structure', async () => {
    const r = await httpGet(port, '/admin/costs', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    // Summary
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalCredits).toBe('number');
    expect(typeof r.body.summary.totalCalls).toBe('number');
    expect(typeof r.body.summary.totalAllowed).toBe('number');
    expect(typeof r.body.summary.totalDenied).toBe('number');
    expect(typeof r.body.summary.avgCostPerCall).toBe('number');
    // Arrays
    expect(Array.isArray(r.body.perTool)).toBe(true);
    expect(Array.isArray(r.body.perNamespace)).toBe(true);
    expect(Array.isArray(r.body.hourlyTrends)).toBe(true);
    expect(Array.isArray(r.body.topSpenders)).toBe(true);
  });

  test('empty system has zero costs', async () => {
    const r = await httpGet(port, '/admin/costs', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalCredits).toBe(0);
    expect(r.body.summary.totalCalls).toBe(0);
    expect(r.body.summary.avgCostPerCall).toBe(0);
    expect(r.body.perTool).toHaveLength(0);
    expect(r.body.topSpenders).toHaveLength(0);
  });

  test('tracks per-tool costs', async () => {
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'tool-test' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    // tool_a: 2 calls (10 credits)
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });
    // tool_b: 1 call (5 credits)
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'tool_b', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/costs', { 'X-Admin-Key': adminKey });

    expect(r.body.perTool.length).toBe(2);
    // tool_a should be first (more credits)
    const toolA = r.body.perTool.find((t: any) => t.tool === 'tool_a');
    expect(toolA.calls).toBe(2);
    expect(toolA.credits).toBe(10);
    expect(toolA.avgCost).toBe(5);
    const toolB = r.body.perTool.find((t: any) => t.tool === 'tool_b');
    expect(toolB.calls).toBe(1);
    expect(toolB.credits).toBe(5);
  });

  test('tracks per-namespace costs', async () => {
    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'ns1-key', namespace: 'prod' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'ns2-key', namespace: 'staging' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k1);
    // prod: 2 calls
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k1 });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k1 });
    // staging: 1 call
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/costs', { 'X-Admin-Key': adminKey });

    expect(r.body.perNamespace.length).toBe(2);
    const prod = r.body.perNamespace.find((n: any) => n.namespace === 'prod');
    expect(prod.credits).toBe(10);
    expect(prod.calls).toBe(2);
    const staging = r.body.perNamespace.find((n: any) => n.namespace === 'staging');
    expect(staging.credits).toBe(5);
  });

  test('summary includes avg cost per call', async () => {
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'avg-test' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_b', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/costs', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalCredits).toBe(10);
    expect(r.body.summary.totalCalls).toBe(2);
    expect(r.body.summary.avgCostPerCall).toBe(5);
  });

  test('hourly trends have correct structure', async () => {
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'trend-test' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/costs', { 'X-Admin-Key': adminKey });

    expect(r.body.hourlyTrends.length).toBeGreaterThanOrEqual(1);
    const bucket = r.body.hourlyTrends[0];
    expect(bucket.hour).toBeTruthy();
    expect(typeof bucket.calls).toBe('number');
    expect(typeof bucket.credits).toBe('number');
    expect(typeof bucket.denied).toBe('number');
  });

  test('top spenders ranked by credits', async () => {
    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'light' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'heavy' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k1);
    // light: 1 call
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k1 });
    // heavy: 3 calls
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k2 });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'tool_b', arguments: {} },
    }, { 'X-API-Key': k2 });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/costs', { 'X-Admin-Key': adminKey });

    expect(r.body.topSpenders.length).toBe(2);
    expect(r.body.topSpenders[0].credits).toBeGreaterThanOrEqual(r.body.topSpenders[1].credits);
  });

  test('tracks denied calls', async () => {
    const k = (await httpPost(port, '/keys', { credits: 5, name: 'limited' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    // First call succeeds
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });
    // Second call denied (no credits)
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/costs', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalCalls).toBe(2);
    expect(r.body.summary.totalAllowed).toBe(1);
    expect(r.body.summary.totalDenied).toBe(1);
    expect(r.body.summary.totalCredits).toBe(5);
  });

  test('filters by namespace', async () => {
    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'p1', namespace: 'prod' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 's1', namespace: 'staging' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k1);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k1 });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/costs?namespace=prod', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalCalls).toBe(1);
    expect(r.body.summary.totalCredits).toBe(5);
  });

  test('default namespace used for keys without namespace', async () => {
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'noNs' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/costs', { 'X-Admin-Key': adminKey });

    const defNs = r.body.perNamespace.find((n: any) => n.namespace === 'default');
    expect(defNs).toBeDefined();
    expect(defNs.credits).toBe(5);
  });

  test('requires admin key', async () => {
    const r = await httpGet(port, '/admin/costs');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    const r = await httpPost(port, '/admin/costs', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.costAnalysis).toBeDefined();
    expect(r.body.endpoints.costAnalysis).toContain('/admin/costs');
  });

  test('does not modify system state', async () => {
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    // Call cost analysis multiple times
    await httpGet(port, '/admin/costs', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/costs', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(95);
  });
});
