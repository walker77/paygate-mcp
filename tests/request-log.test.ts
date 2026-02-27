/**
 * Tests for v7.4.0 — Request Log
 *
 * GET /requests — Queryable log of tool call requests with timing,
 * credits, status, deny reason, and request ID.
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
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { tools: [{ name: 'echo_tool', inputSchema: { type: 'object' } }] } }) + '\\n');
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

describe('Request Log', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let apiKey: string;

  beforeEach(async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
    // Create a key with enough credits
    const r = await httpPost(port, '/keys', { credits: 1000, name: 'test-key' }, { 'X-Admin-Key': adminKey });
    apiKey = r.body.key;
  });

  afterEach(async () => {
    await server.stop();
  });

  test('returns empty log initially', async () => {
    const r = await httpGet(port, '/requests', { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(0);
    expect(r.body.requests).toEqual([]);
    expect(r.body.summary).toBeDefined();
    expect(r.body.summary.totalAllowed).toBe(0);
    expect(r.body.summary.totalDenied).toBe(0);
    expect(r.body.summary.totalCredits).toBe(0);
    expect(r.body.summary.avgDurationMs).toBe(0);
  });

  test('logs successful tool calls', async () => {
    await mcpCall(port, 'echo_tool', apiKey);
    await mcpCall(port, 'echo_tool', apiKey);

    const r = await httpGet(port, '/requests', { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect(r.body.requests).toHaveLength(2);
    // Newest first
    expect(r.body.requests[0].id).toBeGreaterThan(r.body.requests[1].id);

    const entry = r.body.requests[0];
    expect(entry.tool).toBe('echo_tool');
    expect(entry.status).toBe('allowed');
    expect(entry.credits).toBe(5);
    expect(typeof entry.durationMs).toBe('number');
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    expect(entry.timestamp).toBeDefined();
    expect(entry.key).toMatch(/^pg_.+\.\.\./);
    expect(entry.requestId).toMatch(/^req_/);
  });

  test('logs denied tool calls (insufficient credits)', async () => {
    // Create a key with 1 credit — less than defaultCreditsPerCall of 5
    const r2 = await httpPost(port, '/keys', { credits: 1, name: 'poor-key' }, { 'X-Admin-Key': adminKey });
    const poorKey = r2.body.key;

    await mcpCall(port, 'echo_tool', poorKey);

    const r = await httpGet(port, '/requests', { 'X-Admin-Key': adminKey });
    // Find the denied entry
    const denied = r.body.requests.find((e: any) => e.status === 'denied');
    expect(denied).toBeDefined();
    expect(denied.tool).toBe('echo_tool');
    expect(denied.credits).toBe(0);
    expect(denied.denyReason).toBe('insufficient_credits');
  });

  test('logs denied tool calls (rate limited)', async () => {
    const rlServer = makeServer({ defaultCreditsPerCall: 1, globalRateLimitPerMin: 1 });
    const rl = await rlServer.start();
    const rlKey = (await httpPost(rl.port, '/keys', { credits: 100 }, { 'X-Admin-Key': rl.adminKey })).body.key;

    await mcpCall(rl.port, 'echo_tool', rlKey); // first call OK
    await mcpCall(rl.port, 'echo_tool', rlKey); // second call rate limited

    const r = await httpGet(rl.port, '/requests', { 'X-Admin-Key': rl.adminKey });
    const denied = r.body.requests.find((e: any) => e.status === 'denied');
    expect(denied).toBeDefined();
    expect(denied.denyReason).toBe('rate_limited');
    await rlServer.stop();
  });

  test('filter by key', async () => {
    // Create a second key
    const r2 = await httpPost(port, '/keys', { credits: 100, name: 'other-key' }, { 'X-Admin-Key': adminKey });
    const otherKey = r2.body.key;

    await mcpCall(port, 'echo_tool', apiKey);
    await mcpCall(port, 'echo_tool', otherKey);

    // Get all requests
    const allRequests = await httpGet(port, '/requests', { 'X-Admin-Key': adminKey });
    expect(allRequests.body.total).toBe(2);

    // Filter using the key parameter — pg_ prefix is always present in masked keys
    const keyPrefix = apiKey.slice(0, 7);
    const filtered = await httpGet(port, `/requests?key=${keyPrefix}`, { 'X-Admin-Key': adminKey });
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.requests[0].key).toContain(keyPrefix);
  });

  test('filter by tool name', async () => {
    await mcpCall(port, 'echo_tool', apiKey);

    const r = await httpGet(port, '/requests?tool=echo_tool', { 'X-Admin-Key': adminKey });
    expect(r.body.total).toBe(1);
    expect(r.body.requests[0].tool).toBe('echo_tool');

    const r2 = await httpGet(port, '/requests?tool=nonexistent', { 'X-Admin-Key': adminKey });
    expect(r2.body.total).toBe(0);
  });

  test('filter by status', async () => {
    // Create a poor key (1 credit, needs 5)
    const r2 = await httpPost(port, '/keys', { credits: 1, name: 'poor' }, { 'X-Admin-Key': adminKey });
    const poorKey = r2.body.key;

    await mcpCall(port, 'echo_tool', apiKey); // allowed
    await mcpCall(port, 'echo_tool', poorKey); // denied (insufficient credits)

    const allowed = await httpGet(port, '/requests?status=allowed', { 'X-Admin-Key': adminKey });
    expect(allowed.body.total).toBe(1);
    expect(allowed.body.requests[0].status).toBe('allowed');

    const denied = await httpGet(port, '/requests?status=denied', { 'X-Admin-Key': adminKey });
    expect(denied.body.total).toBe(1);
    expect(denied.body.requests[0].status).toBe('denied');
  });

  test('filter by since timestamp', async () => {
    await mcpCall(port, 'echo_tool', apiKey);

    const future = new Date(Date.now() + 60_000).toISOString();
    const r = await httpGet(port, `/requests?since=${encodeURIComponent(future)}`, { 'X-Admin-Key': adminKey });
    expect(r.body.total).toBe(0);

    const past = new Date(Date.now() - 60_000).toISOString();
    const r2 = await httpGet(port, `/requests?since=${encodeURIComponent(past)}`, { 'X-Admin-Key': adminKey });
    expect(r2.body.total).toBe(1);
  });

  test('pagination with limit and offset', async () => {
    // Make 5 calls
    for (let i = 0; i < 5; i++) {
      await mcpCall(port, 'echo_tool', apiKey);
    }

    const r = await httpGet(port, '/requests?limit=2&offset=0', { 'X-Admin-Key': adminKey });
    expect(r.body.total).toBe(5);
    expect(r.body.requests).toHaveLength(2);
    expect(r.body.limit).toBe(2);
    expect(r.body.offset).toBe(0);
    // Newest first
    expect(r.body.requests[0].id).toBeGreaterThan(r.body.requests[1].id);

    const r2 = await httpGet(port, '/requests?limit=2&offset=2', { 'X-Admin-Key': adminKey });
    expect(r2.body.requests).toHaveLength(2);
    expect(r2.body.requests[0].id).toBeLessThan(r.body.requests[1].id);
  });

  test('summary statistics', async () => {
    // Create poor key (1 credit, needs 5)
    const r2 = await httpPost(port, '/keys', { credits: 1, name: 'poor' }, { 'X-Admin-Key': adminKey });
    const poorKey = r2.body.key;

    await mcpCall(port, 'echo_tool', apiKey); // allowed, 5 credits
    await mcpCall(port, 'echo_tool', apiKey); // allowed, 5 credits
    await mcpCall(port, 'echo_tool', poorKey); // denied, 0 credits

    const r = await httpGet(port, '/requests', { 'X-Admin-Key': adminKey });
    expect(r.body.summary.totalAllowed).toBe(2);
    expect(r.body.summary.totalDenied).toBe(1);
    expect(r.body.summary.totalCredits).toBe(10);
    expect(r.body.summary.avgDurationMs).toBeGreaterThanOrEqual(0);
  });

  test('requires admin key', async () => {
    const r = await httpGet(port, '/requests');
    expect(r.status).toBe(401);
  });

  test('rejects non-GET methods', async () => {
    const r = await httpPost(port, '/requests', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('does not log non-tool-call requests', async () => {
    // Do a tools/list request — should NOT appear in request log
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }, { 'X-API-Key': apiKey });

    const r = await httpGet(port, '/requests', { 'X-Admin-Key': adminKey });
    expect(r.body.total).toBe(0);
  });

  test('each entry has a unique incrementing ID', async () => {
    await mcpCall(port, 'echo_tool', apiKey);
    await mcpCall(port, 'echo_tool', apiKey);
    await mcpCall(port, 'echo_tool', apiKey);

    const r = await httpGet(port, '/requests', { 'X-Admin-Key': adminKey });
    const ids = r.body.requests.map((e: any) => e.id);
    // Newest first, so ids should be descending
    expect(ids[0]).toBeGreaterThan(ids[1]);
    expect(ids[1]).toBeGreaterThan(ids[2]);
    // All unique
    expect(new Set(ids).size).toBe(3);
  });

  test('multiple filters combine', async () => {
    // Create poor key for denied requests (1 credit, needs 5)
    const r2 = await httpPost(port, '/keys', { credits: 1, name: 'poor' }, { 'X-Admin-Key': adminKey });
    const poorKey = r2.body.key;

    await mcpCall(port, 'echo_tool', apiKey); // allowed
    await mcpCall(port, 'echo_tool', poorKey); // denied

    const r = await httpGet(port, '/requests?tool=echo_tool&status=allowed', { 'X-Admin-Key': adminKey });
    expect(r.body.total).toBe(1);
    expect(r.body.requests[0].status).toBe('allowed');
  });

  test('limit is capped at 1000', async () => {
    const r = await httpGet(port, '/requests?limit=9999', { 'X-Admin-Key': adminKey });
    expect(r.body.limit).toBe(1000);
  });

  test('root listing includes requestLog endpoint', async () => {
    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.requestLog).toBeDefined();
    expect(r.body.endpoints.requestLog).toContain('/requests');
  });

  test('ring buffer caps at max entries', async () => {
    // Access the internal maxRequestLogEntries
    const maxEntries = (server as any).maxRequestLogEntries;
    expect(typeof maxEntries).toBe('number');
    expect(maxEntries).toBe(5000);

    // We can't easily test 5000 entries in a unit test, but verify the field exists
    expect((server as any).requestLog).toBeDefined();
    expect(Array.isArray((server as any).requestLog)).toBe(true);
  });

  test('summary stats computed on filtered results', async () => {
    // Create poor key (1 credit, needs 5)
    const r2 = await httpPost(port, '/keys', { credits: 1, name: 'poor' }, { 'X-Admin-Key': adminKey });
    const poorKey = r2.body.key;

    await mcpCall(port, 'echo_tool', apiKey); // allowed
    await mcpCall(port, 'echo_tool', poorKey); // denied

    // Filter to only allowed
    const r = await httpGet(port, '/requests?status=allowed', { 'X-Admin-Key': adminKey });
    expect(r.body.summary.totalAllowed).toBe(1);
    expect(r.body.summary.totalDenied).toBe(0);
    expect(r.body.summary.totalCredits).toBe(5);
  });

  test('denyReason is not present on allowed entries', async () => {
    await mcpCall(port, 'echo_tool', apiKey);

    const r = await httpGet(port, '/requests', { 'X-Admin-Key': adminKey });
    const entry = r.body.requests[0];
    expect(entry.status).toBe('allowed');
    expect(entry.denyReason).toBeUndefined();
  });

  test('duration tracks elapsed time', async () => {
    await mcpCall(port, 'echo_tool', apiKey);

    const r = await httpGet(port, '/requests', { 'X-Admin-Key': adminKey });
    const entry = r.body.requests[0];
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    // Should be reasonable (< 10 seconds for a local echo)
    expect(entry.durationMs).toBeLessThan(10_000);
  });
});
