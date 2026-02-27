/**
 * Tests for v7.5.0 — Tool Stats
 *
 * GET /tools/stats — Per-tool analytics: call counts, success rates,
 * latency, credits, top consumers, deny reason breakdown.
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
        { name: 'tool_b', inputSchema: { type: 'object' } }
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

function mcpCall(port: number, toolName: string, apiKey: string): Promise<{ status: number; body: any }> {
  return httpPost(port, '/mcp', {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name: toolName, arguments: {} },
  }, { 'X-API-Key': apiKey });
}

/* ── tests ───────────────────────────────────────────────── */

describe('Tool Stats', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let apiKey: string;

  beforeEach(async () => {
    server = makeServer({ defaultCreditsPerCall: 3 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
    const r = await httpPost(port, '/keys', { credits: 1000, name: 'test-key' }, { 'X-Admin-Key': adminKey });
    apiKey = r.body.key;
  }, 30_000);

  afterEach(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('returns empty stats initially', async () => {
    const r = await httpGet(port, '/tools/stats', { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.totalTools).toBe(0);
    expect(r.body.totalCalls).toBe(0);
    expect(r.body.tools).toEqual([]);
  });

  test('aggregates stats per tool', async () => {
    await mcpCall(port, 'tool_a', apiKey);
    await mcpCall(port, 'tool_a', apiKey);
    await mcpCall(port, 'tool_b', apiKey);

    const r = await httpGet(port, '/tools/stats', { 'X-Admin-Key': adminKey });
    expect(r.body.totalTools).toBe(2);
    expect(r.body.totalCalls).toBe(3);

    const toolA = r.body.tools.find((t: any) => t.tool === 'tool_a');
    expect(toolA).toBeDefined();
    expect(toolA.totalCalls).toBe(2);
    expect(toolA.allowed).toBe(2);
    expect(toolA.denied).toBe(0);
    expect(toolA.successRate).toBe(100);
    expect(toolA.totalCredits).toBe(6); // 2 calls * 3 credits

    const toolB = r.body.tools.find((t: any) => t.tool === 'tool_b');
    expect(toolB).toBeDefined();
    expect(toolB.totalCalls).toBe(1);
  });

  test('tools sorted by call count descending', async () => {
    await mcpCall(port, 'tool_b', apiKey);
    await mcpCall(port, 'tool_a', apiKey);
    await mcpCall(port, 'tool_a', apiKey);
    await mcpCall(port, 'tool_a', apiKey);

    const r = await httpGet(port, '/tools/stats', { 'X-Admin-Key': adminKey });
    expect(r.body.tools[0].tool).toBe('tool_a');
    expect(r.body.tools[1].tool).toBe('tool_b');
  });

  test('tracks success rate with denied calls', async () => {
    // Create poor key (1 credit, needs 3)
    const r2 = await httpPost(port, '/keys', { credits: 1, name: 'poor' }, { 'X-Admin-Key': adminKey });
    const poorKey = r2.body.key;

    await mcpCall(port, 'tool_a', apiKey); // allowed
    await mcpCall(port, 'tool_a', poorKey); // denied

    const r = await httpGet(port, '/tools/stats', { 'X-Admin-Key': adminKey });
    const toolA = r.body.tools.find((t: any) => t.tool === 'tool_a');
    expect(toolA.totalCalls).toBe(2);
    expect(toolA.allowed).toBe(1);
    expect(toolA.denied).toBe(1);
    expect(toolA.successRate).toBe(50);
  });

  test('average duration is reasonable', async () => {
    await mcpCall(port, 'tool_a', apiKey);

    const r = await httpGet(port, '/tools/stats', { 'X-Admin-Key': adminKey });
    const toolA = r.body.tools.find((t: any) => t.tool === 'tool_a');
    expect(toolA.avgDurationMs).toBeGreaterThanOrEqual(0);
    expect(toolA.avgDurationMs).toBeLessThan(10_000);
  });

  test('detailed stats for specific tool', async () => {
    await mcpCall(port, 'tool_a', apiKey);
    await mcpCall(port, 'tool_a', apiKey);

    const r = await httpGet(port, '/tools/stats?tool=tool_a', { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.tool).toBe('tool_a');
    expect(r.body.totalCalls).toBe(2);
    expect(r.body.allowed).toBe(2);
    expect(r.body.denied).toBe(0);
    expect(r.body.successRate).toBe(100);
    expect(r.body.totalCredits).toBe(6);
    expect(r.body.avgDurationMs).toBeGreaterThanOrEqual(0);
    expect(r.body.p95DurationMs).toBeGreaterThanOrEqual(0);
    expect(r.body.denyReasons).toEqual({});
    expect(r.body.topConsumers).toBeDefined();
    expect(r.body.topConsumers.length).toBeGreaterThanOrEqual(1);
  });

  test('detailed stats with deny reason breakdown', async () => {
    const r2 = await httpPost(port, '/keys', { credits: 1, name: 'poor' }, { 'X-Admin-Key': adminKey });
    const poorKey = r2.body.key;

    await mcpCall(port, 'tool_a', apiKey); // allowed
    await mcpCall(port, 'tool_a', poorKey); // denied

    const r = await httpGet(port, '/tools/stats?tool=tool_a', { 'X-Admin-Key': adminKey });
    expect(r.body.denyReasons).toBeDefined();
    expect(r.body.denyReasons['insufficient_credits']).toBe(1);
  });

  test('detailed stats with top consumers', async () => {
    // Create second key
    const r2 = await httpPost(port, '/keys', { credits: 100, name: 'key-2' }, { 'X-Admin-Key': adminKey });
    const key2 = r2.body.key;

    await mcpCall(port, 'tool_a', apiKey);
    await mcpCall(port, 'tool_a', apiKey);
    await mcpCall(port, 'tool_a', key2);

    const r = await httpGet(port, '/tools/stats?tool=tool_a', { 'X-Admin-Key': adminKey });
    expect(r.body.topConsumers).toHaveLength(2);
    // Top consumer should be apiKey (2 calls)
    expect(r.body.topConsumers[0].calls).toBe(2);
    expect(r.body.topConsumers[0].credits).toBe(6);
    expect(r.body.topConsumers[1].calls).toBe(1);
  });

  test('filter by since timestamp', async () => {
    await mcpCall(port, 'tool_a', apiKey);

    const future = new Date(Date.now() + 60_000).toISOString();
    const r = await httpGet(port, `/tools/stats?since=${encodeURIComponent(future)}`, { 'X-Admin-Key': adminKey });
    expect(r.body.totalCalls).toBe(0);
    expect(r.body.tools).toEqual([]);

    const past = new Date(Date.now() - 60_000).toISOString();
    const r2 = await httpGet(port, `/tools/stats?since=${encodeURIComponent(past)}`, { 'X-Admin-Key': adminKey });
    expect(r2.body.totalCalls).toBe(1);
  });

  test('empty result for nonexistent tool', async () => {
    const r = await httpGet(port, '/tools/stats?tool=nonexistent', { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.tool).toBe('nonexistent');
    expect(r.body.totalCalls).toBe(0);
    expect(r.body.successRate).toBe(0);
  });

  test('requires admin key', async () => {
    const r = await httpGet(port, '/tools/stats');
    expect(r.status).toBe(401);
  });

  test('rejects non-GET methods', async () => {
    const r = await httpPost(port, '/tools/stats', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes toolStats endpoint', async () => {
    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.toolStats).toBeDefined();
    expect(r.body.endpoints.toolStats).toContain('/tools/stats');
  });

  test('p95 duration calculated correctly', async () => {
    // Make several calls to get meaningful p95
    for (let i = 0; i < 10; i++) {
      await mcpCall(port, 'tool_a', apiKey);
    }

    const r = await httpGet(port, '/tools/stats?tool=tool_a', { 'X-Admin-Key': adminKey });
    expect(r.body.p95DurationMs).toBeGreaterThanOrEqual(0);
    expect(typeof r.body.p95DurationMs).toBe('number');
  });

  test('since filter applies to detailed tool view', async () => {
    await mcpCall(port, 'tool_a', apiKey);

    const future = new Date(Date.now() + 60_000).toISOString();
    const r = await httpGet(port, `/tools/stats?tool=tool_a&since=${encodeURIComponent(future)}`, { 'X-Admin-Key': adminKey });
    expect(r.body.totalCalls).toBe(0);
  });
});
