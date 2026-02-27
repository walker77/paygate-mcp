/**
 * Tests for v8.30.0 — Tool Adoption
 *
 * GET /admin/tool-adoption — Per-tool adoption metrics showing unique
 * consumers, adoption rate as % of active keys, first/last seen timestamps,
 * never-used tool identification, and ranking by adoption rate.
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

describe('Tool Adoption', () => {
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

    const r = await httpGet(port, '/admin/tool-adoption', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.tools)).toBe(true);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalTools).toBe('number');
    expect(typeof r.body.summary.usedTools).toBe('number');
    expect(typeof r.body.summary.unusedTools).toBe('number');
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no requests', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/tool-adoption', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.usedTools).toBe(0);
    expect(r.body.tools.length).toBe(0);
  });

  test('tracks unique consumers per tool', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'user2' }, { 'X-Admin-Key': adminKey })).body.key;

    // Both users call tool_a
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} }
    }, { 'X-API-Key': k1 });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} }
    }, { 'X-API-Key': k2 });

    // Only user1 calls tool_b
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'tool_b', arguments: {} }
    }, { 'X-API-Key': k1 });

    const r = await httpGet(port, '/admin/tool-adoption', { 'X-Admin-Key': adminKey });

    const toolA = r.body.tools.find((t: any) => t.tool === 'tool_a');
    const toolB = r.body.tools.find((t: any) => t.tool === 'tool_b');
    expect(toolA.uniqueConsumers).toBe(2);
    expect(toolB.uniqueConsumers).toBe(1);
  });

  test('calculates adoption rate as percent of active keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;
    // Create a second key that does not use any tools
    await httpPost(port, '/keys', { credits: 100, name: 'user2' }, { 'X-Admin-Key': adminKey });

    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} }
    }, { 'X-API-Key': k1 });

    const r = await httpGet(port, '/admin/tool-adoption', { 'X-Admin-Key': adminKey });

    const toolA = r.body.tools.find((t: any) => t.tool === 'tool_a');
    // 1 of 2 active keys used tool_a → 50%
    expect(toolA.adoptionRate).toBe(50);
  });

  test('includes first and last seen timestamps', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'k1' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} }
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/tool-adoption', { 'X-Admin-Key': adminKey });

    const toolA = r.body.tools.find((t: any) => t.tool === 'tool_a');
    expect(typeof toolA.firstSeen).toBe('string');
    expect(typeof toolA.lastSeen).toBe('string');
    expect(new Date(toolA.firstSeen).getTime()).toBeGreaterThan(0);
    expect(new Date(toolA.lastSeen).getTime()).toBeGreaterThanOrEqual(new Date(toolA.firstSeen).getTime());
  });

  test('tools sorted by adoption rate descending', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'user1' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'user2' }, { 'X-Admin-Key': adminKey })).body.key;

    // tool_a used by both keys, tool_b used by only k1
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k2 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k1 });

    const r = await httpGet(port, '/admin/tool-adoption', { 'X-Admin-Key': adminKey });

    expect(r.body.tools.length).toBeGreaterThanOrEqual(2);
    // tool_a (100%) should come before tool_b (50%)
    const aIdx = r.body.tools.findIndex((t: any) => t.tool === 'tool_a');
    const bIdx = r.body.tools.findIndex((t: any) => t.tool === 'tool_b');
    expect(aIdx).toBeLessThan(bIdx);
  });

  test('includes total calls per tool', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'k1' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/tool-adoption', { 'X-Admin-Key': adminKey });

    const toolA = r.body.tools.find((t: any) => t.tool === 'tool_a');
    expect(toolA.totalCalls).toBe(2);
  });

  test('summary counts used and unused tools', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'k1' }, { 'X-Admin-Key': adminKey })).body.key;

    // Only call tool_a — tool_b and tool_c remain unused
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/tool-adoption', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.usedTools).toBe(1);
    expect(r.body.summary.totalTools).toBeGreaterThanOrEqual(1);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/tool-adoption');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/tool-adoption', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.toolAdoption).toBeDefined();
    expect(r.body.endpoints.toolAdoption).toContain('/admin/tool-adoption');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/tool-adoption', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/tool-adoption', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
