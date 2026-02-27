/**
 * Tests for v7.9.0 — Tool Availability
 *
 * GET /tools/available?key=... — Per-key tool availability with pricing,
 * affordability, rate limit status, and ACL enforcement.
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

/** Trigger tools/list through MCP to populate the registry */
async function discoverTools(port: number, apiKeyOrHeaders: string | Record<string, string>): Promise<void> {
  const headers = typeof apiKeyOrHeaders === 'string'
    ? { 'X-API-Key': apiKeyOrHeaders }
    : apiKeyOrHeaders;
  await httpPost(port, '/mcp', {
    jsonrpc: '2.0', id: 999, method: 'tools/list', params: {},
  }, headers);
}

/* ── tests ───────────────────────────────────────────────── */

describe('Tool Availability', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let apiKey: string;

  beforeEach(async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
    const r = await httpPost(port, '/keys', { credits: 100, name: 'test-key' }, { 'X-Admin-Key': adminKey });
    apiKey = r.body.key;
    // Trigger tools/list to populate the tool registry
    await discoverTools(port, apiKey);
  });

  afterEach(async () => {
    await server.stop();
  });

  test('returns all tools with availability info', async () => {
    const r = await httpGet(port, `/tools/available?key=${apiKey}`, { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.totalTools).toBe(3);
    expect(r.body.accessibleTools).toBe(3);
    expect(r.body.creditsAvailable).toBe(100);
    expect(r.body.tools).toHaveLength(3);
    expect(r.body.tools[0].tool).toBe('tool_a');
    expect(r.body.tools[0].accessible).toBe(true);
    expect(r.body.tools[0].creditsPerCall).toBe(10);
    expect(r.body.tools[0].canAfford).toBe(true);
  });

  test('shows masked key', async () => {
    const r = await httpGet(port, `/tools/available?key=${apiKey}`, { 'X-Admin-Key': adminKey });
    expect(r.body.key).toMatch(/^pg_.+\.\.\./);
  });

  test('deniedTools reflected in accessibility', async () => {
    await httpPost(port, '/keys/acl', { key: apiKey, deniedTools: ['tool_b'] }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, `/tools/available?key=${apiKey}`, { 'X-Admin-Key': adminKey });

    expect(r.body.accessibleTools).toBe(2);
    const toolB = r.body.tools.find((t: any) => t.tool === 'tool_b');
    expect(toolB.accessible).toBe(false);
    expect(toolB.denyReason).toBe('denied_by_acl');
  });

  test('allowedTools restriction', async () => {
    await httpPost(port, '/keys/acl', { key: apiKey, allowedTools: ['tool_a'] }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, `/tools/available?key=${apiKey}`, { 'X-Admin-Key': adminKey });

    expect(r.body.accessibleTools).toBe(1);
    const toolA = r.body.tools.find((t: any) => t.tool === 'tool_a');
    expect(toolA.accessible).toBe(true);
    const toolB = r.body.tools.find((t: any) => t.tool === 'tool_b');
    expect(toolB.accessible).toBe(false);
    expect(toolB.denyReason).toBe('not_in_allowed_list');
  });

  test('canAfford false when credits insufficient', async () => {
    // Create a key with only 5 credits (tool costs 10)
    const r2 = await httpPost(port, '/keys', { credits: 5, name: 'broke' }, { 'X-Admin-Key': adminKey });
    const brokeKey = r2.body.key;

    const r = await httpGet(port, `/tools/available?key=${brokeKey}`, { 'X-Admin-Key': adminKey });

    expect(r.body.creditsAvailable).toBe(5);
    r.body.tools.forEach((t: any) => {
      expect(t.canAfford).toBe(false);
    });
  });

  test('custom tool pricing reflected', async () => {
    const ps = makeServer({
      defaultCreditsPerCall: 1,
      toolPricing: { tool_a: { creditsPerCall: 50 }, tool_b: { creditsPerCall: 2 } },
    });
    const pStarted = await ps.start();
    const pk = (await httpPost(pStarted.port, '/keys', { credits: 100 }, { 'X-Admin-Key': pStarted.adminKey })).body.key;
    await discoverTools(pStarted.port, pk);

    const r = await httpGet(pStarted.port, `/tools/available?key=${pk}`, { 'X-Admin-Key': pStarted.adminKey });

    const toolA = r.body.tools.find((t: any) => t.tool === 'tool_a');
    const toolB = r.body.tools.find((t: any) => t.tool === 'tool_b');
    const toolC = r.body.tools.find((t: any) => t.tool === 'tool_c');
    expect(toolA.creditsPerCall).toBe(50);
    expect(toolB.creditsPerCall).toBe(2);
    expect(toolC.creditsPerCall).toBe(1); // default

    await ps.stop();
  });

  test('invalid key returns error', async () => {
    const r = await httpGet(port, '/tools/available?key=pg_invalid', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.error).toBe('invalid_api_key');
    expect(r.body.tools).toEqual([]);
  });

  test('global rate limit info included', async () => {
    // Default config has globalRateLimitPerMin: 60
    const r = await httpGet(port, `/tools/available?key=${apiKey}`, { 'X-Admin-Key': adminKey });

    expect(r.body.globalRateLimit).toBeDefined();
    expect(r.body.globalRateLimit.limit).toBe(60);
  });

  test('custom global rate limit reflected', async () => {
    const rlServer = makeServer({ defaultCreditsPerCall: 1, globalRateLimitPerMin: 100 });
    const rl = await rlServer.start();
    const rlKey = (await httpPost(rl.port, '/keys', { credits: 1000 }, { 'X-Admin-Key': rl.adminKey })).body.key;
    await discoverTools(rl.port, rlKey);

    const r = await httpGet(rl.port, `/tools/available?key=${rlKey}`, { 'X-Admin-Key': rl.adminKey });

    expect(r.body.globalRateLimit).toBeDefined();
    expect(r.body.globalRateLimit.limit).toBe(100);

    await rlServer.stop();
  });

  test('per-tool rate limit included when configured', async () => {
    const ps = makeServer({
      defaultCreditsPerCall: 1,
      toolPricing: { tool_a: { creditsPerCall: 1, rateLimitPerMin: 10 } },
    });
    const pStarted = await ps.start();
    const pk = (await httpPost(pStarted.port, '/keys', { credits: 1000 }, { 'X-Admin-Key': pStarted.adminKey })).body.key;
    await discoverTools(pStarted.port, pk);

    const r = await httpGet(pStarted.port, `/tools/available?key=${pk}`, { 'X-Admin-Key': pStarted.adminKey });

    const toolA = r.body.tools.find((t: any) => t.tool === 'tool_a');
    expect(toolA.rateLimit).toBeDefined();
    expect(toolA.rateLimit.limit).toBe(10);

    // tool_b should have no per-tool rate limit
    const toolB = r.body.tools.find((t: any) => t.tool === 'tool_b');
    expect(toolB.rateLimit).toBeUndefined();

    await ps.stop();
  });

  test('requires admin key', async () => {
    const r = await httpGet(port, `/tools/available?key=${apiKey}`);
    expect(r.status).toBe(401);
  });

  test('requires key parameter', async () => {
    const r = await httpGet(port, '/tools/available', { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('key');
  });

  test('rejects POST method', async () => {
    const r = await httpPost(port, '/tools/available', { key: apiKey }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.toolAvailability).toBeDefined();
    expect(r.body.endpoints.toolAvailability).toContain('/tools/available');
  });

  test('supports alias keys', async () => {
    await httpPost(port, '/keys/alias', { key: apiKey, alias: 'avail-alias' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/tools/available?key=avail-alias', { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.totalTools).toBe(3);
    expect(r.body.accessibleTools).toBe(3);
  });

  test('suspended key still returns tool info', async () => {
    await httpPost(port, '/keys/suspend', { key: apiKey }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, `/tools/available?key=${apiKey}`, { 'X-Admin-Key': adminKey });
    // Suspended keys can still query availability — it's informational
    expect(r.status).toBe(200);
    expect(r.body.totalTools).toBe(3);
  });

  test('mixed ACL and affordability', async () => {
    // Key with 15 credits, tool costs 10 — can afford 1 but not if tool is denied
    const r2 = await httpPost(port, '/keys', { credits: 15, name: 'mixed' }, { 'X-Admin-Key': adminKey });
    const mixedKey = r2.body.key;
    await httpPost(port, '/keys/acl', { key: mixedKey, deniedTools: ['tool_c'] }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, `/tools/available?key=${mixedKey}`, { 'X-Admin-Key': adminKey });

    expect(r.body.accessibleTools).toBe(2);
    const toolA = r.body.tools.find((t: any) => t.tool === 'tool_a');
    expect(toolA.accessible).toBe(true);
    expect(toolA.canAfford).toBe(true);
    const toolC = r.body.tools.find((t: any) => t.tool === 'tool_c');
    expect(toolC.accessible).toBe(false);
    expect(toolC.denyReason).toBe('denied_by_acl');
    // Even denied tools show affordability
    expect(toolC.canAfford).toBe(true);
  });

  test('does not modify credits or rate limits', async () => {
    // Call availability check multiple times
    await httpGet(port, `/tools/available?key=${apiKey}`, { 'X-Admin-Key': adminKey });
    await httpGet(port, `/tools/available?key=${apiKey}`, { 'X-Admin-Key': adminKey });
    await httpGet(port, `/tools/available?key=${apiKey}`, { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': apiKey });
    expect(balance.body.credits).toBe(100);
  });

  test('returns empty tools when no tools discovered', async () => {
    // Create a fresh server but don't trigger tools/list
    const ps = makeServer({ defaultCreditsPerCall: 1 });
    const pStarted = await ps.start();
    const pk = (await httpPost(pStarted.port, '/keys', { credits: 100 }, { 'X-Admin-Key': pStarted.adminKey })).body.key;
    // Intentionally skip discoverTools

    const r = await httpGet(pStarted.port, `/tools/available?key=${pk}`, { 'X-Admin-Key': pStarted.adminKey });

    expect(r.status).toBe(200);
    expect(r.body.totalTools).toBe(0);
    expect(r.body.tools).toHaveLength(0);

    await ps.stop();
  });
});
