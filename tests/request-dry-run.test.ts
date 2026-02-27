/**
 * Tests for v7.7.0 — Tool Call Dry Run
 *
 * POST /requests/dry-run — Simulate a tool call without executing,
 * returning whether it would be allowed and why.
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
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { tools: [{ name: 'dry_tool', inputSchema: { type: 'object' } }] } }) + '\\n');
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

describe('Tool Call Dry Run', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let apiKey: string;

  beforeEach(async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
    const r = await httpPost(port, '/keys', { credits: 100, name: 'test-key' }, { 'X-Admin-Key': adminKey });
    apiKey = r.body.key;
  }, 30_000);

  afterEach(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('returns allowed for valid key with sufficient credits', async () => {
    const r = await httpPost(port, '/requests/dry-run', { key: apiKey, tool: 'dry_tool' }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.allowed).toBe(true);
    expect(r.body.tool).toBe('dry_tool');
    expect(r.body.creditsRequired).toBe(5);
    expect(r.body.creditsAvailable).toBe(100);
    expect(r.body.creditsAfter).toBe(95);
  });

  test('does not deduct credits (dry run)', async () => {
    await httpPost(port, '/requests/dry-run', { key: apiKey, tool: 'dry_tool' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/requests/dry-run', { key: apiKey, tool: 'dry_tool' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/requests/dry-run', { key: apiKey, tool: 'dry_tool' }, { 'X-Admin-Key': adminKey });

    // Credits should be unchanged — check via balance endpoint
    const balance = await httpGet(port, '/balance', { 'X-API-Key': apiKey });
    expect(balance.body.credits).toBe(100);
  });

  test('returns denied for insufficient credits', async () => {
    const r2 = await httpPost(port, '/keys', { credits: 2, name: 'poor-key' }, { 'X-Admin-Key': adminKey });
    const poorKey = r2.body.key;

    const r = await httpPost(port, '/requests/dry-run', { key: poorKey, tool: 'dry_tool' }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.allowed).toBe(false);
    expect(r.body.reason).toContain('insufficient_credits');
    expect(r.body.creditsRequired).toBe(5);
    expect(r.body.creditsAvailable).toBe(2);
  });

  test('returns denied for invalid key', async () => {
    const r = await httpPost(port, '/requests/dry-run', { key: 'pg_invalid_key', tool: 'dry_tool' }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.allowed).toBe(false);
    expect(r.body.reason).toBe('invalid_api_key');
  });

  test('returns denied for suspended key', async () => {
    // Suspend the key
    await httpPost(port, '/keys/suspend', { key: apiKey }, { 'X-Admin-Key': adminKey });

    const r = await httpPost(port, '/requests/dry-run', { key: apiKey, tool: 'dry_tool' }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.allowed).toBe(false);
    expect(r.body.reason).toBe('key_suspended');
  });

  test('returns denied for denied tool (ACL)', async () => {
    // Set deniedTools
    await httpPost(port, '/keys/acl', { key: apiKey, deniedTools: ['dry_tool'] }, { 'X-Admin-Key': adminKey });

    const r = await httpPost(port, '/requests/dry-run', { key: apiKey, tool: 'dry_tool' }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.allowed).toBe(false);
    expect(r.body.reason).toContain('tool_not_allowed');
  });

  test('returns denied for tool not in allowedTools (ACL)', async () => {
    // Set allowedTools to something else
    await httpPost(port, '/keys/acl', { key: apiKey, allowedTools: ['other_tool'] }, { 'X-Admin-Key': adminKey });

    const r = await httpPost(port, '/requests/dry-run', { key: apiKey, tool: 'dry_tool' }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.allowed).toBe(false);
    expect(r.body.reason).toContain('tool_not_allowed');
  });

  test('returns denied for rate limited key', async () => {
    const rlServer = makeServer({ defaultCreditsPerCall: 1, globalRateLimitPerMin: 1 });
    const rl = await rlServer.start();
    const rlKey = (await httpPost(rl.port, '/keys', { credits: 100 }, { 'X-Admin-Key': rl.adminKey })).body.key;

    // Make one real call to consume the rate limit
    await mcpCall(rl.port, 'dry_tool', rlKey);

    // Dry run should show rate limited
    const r = await httpPost(rl.port, '/requests/dry-run', { key: rlKey, tool: 'dry_tool' }, { 'X-Admin-Key': rl.adminKey });
    expect(r.status).toBe(200);
    expect(r.body.allowed).toBe(false);
    expect(r.body.reason).toBe('rate_limited');
    expect(r.body.rateLimit).toBeDefined();
    expect(r.body.rateLimit.remaining).toBe(0);

    await rlServer.stop();
  });

  test('returns denied for spending limit exceeded', async () => {
    // Set spending limit
    await httpPost(port, '/limits', { key: apiKey, spendingLimit: 3 }, { 'X-Admin-Key': adminKey });

    const r = await httpPost(port, '/requests/dry-run', { key: apiKey, tool: 'dry_tool' }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.allowed).toBe(false);
    expect(r.body.reason).toContain('spending_limit_exceeded');
  });

  test('includes rate limit info when allowed', async () => {
    const rlServer = makeServer({ defaultCreditsPerCall: 1, globalRateLimitPerMin: 10 });
    const rl = await rlServer.start();
    const rlKey = (await httpPost(rl.port, '/keys', { credits: 100 }, { 'X-Admin-Key': rl.adminKey })).body.key;

    const r = await httpPost(rl.port, '/requests/dry-run', { key: rlKey, tool: 'dry_tool' }, { 'X-Admin-Key': rl.adminKey });
    expect(r.status).toBe(200);
    expect(r.body.allowed).toBe(true);
    expect(r.body.rateLimit).toBeDefined();
    expect(r.body.rateLimit.limit).toBe(10);
    expect(r.body.rateLimit.remaining).toBe(10);

    await rlServer.stop();
  });

  test('requires admin key', async () => {
    const r = await httpPost(port, '/requests/dry-run', { key: apiKey, tool: 'dry_tool' });
    expect(r.status).toBe(401);
  });

  test('rejects GET method', async () => {
    const r = await httpGet(port, '/requests/dry-run', { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('requires key field', async () => {
    const r = await httpPost(port, '/requests/dry-run', { tool: 'dry_tool' }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('key');
  });

  test('requires tool field', async () => {
    const r = await httpPost(port, '/requests/dry-run', { key: apiKey }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('tool');
  });

  test('root listing includes requestDryRun endpoint', async () => {
    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.requestDryRun).toBeDefined();
    expect(r.body.endpoints.requestDryRun).toContain('/requests/dry-run');
  });

  test('does not increment rate limiter', async () => {
    const rlServer = makeServer({ defaultCreditsPerCall: 1, globalRateLimitPerMin: 2 });
    const rl = await rlServer.start();
    const rlKey = (await httpPost(rl.port, '/keys', { credits: 100 }, { 'X-Admin-Key': rl.adminKey })).body.key;

    // Dry run 5 times — should NOT consume rate limit
    for (let i = 0; i < 5; i++) {
      await httpPost(rl.port, '/requests/dry-run', { key: rlKey, tool: 'dry_tool' }, { 'X-Admin-Key': rl.adminKey });
    }

    // Real call should still succeed (rate limit = 2/min, none used)
    const call1 = await mcpCall(rl.port, 'dry_tool', rlKey);
    expect(call1.body.result).toBeDefined();
    const call2 = await mcpCall(rl.port, 'dry_tool', rlKey);
    expect(call2.body.result).toBeDefined();

    await rlServer.stop();
  });

  test('does not appear in request log', async () => {
    await httpPost(port, '/requests/dry-run', { key: apiKey, tool: 'dry_tool' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/requests', { 'X-Admin-Key': adminKey });
    expect(r.body.total).toBe(0);
  });

  test('handles alias keys', async () => {
    // Set an alias
    await httpPost(port, '/keys/alias', { key: apiKey, alias: 'my-alias' }, { 'X-Admin-Key': adminKey });

    const r = await httpPost(port, '/requests/dry-run', { key: 'my-alias', tool: 'dry_tool' }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.allowed).toBe(true);
    expect(r.body.creditsAvailable).toBe(100);
  });

  test('supports custom tool pricing via arguments', async () => {
    const pricedServer = makeServer({
      defaultCreditsPerCall: 1,
      toolPricing: { expensive_tool: { creditsPerCall: 50 } },
    });
    const ps = await pricedServer.start();
    const pk = (await httpPost(ps.port, '/keys', { credits: 100 }, { 'X-Admin-Key': ps.adminKey })).body.key;

    const r = await httpPost(ps.port, '/requests/dry-run', { key: pk, tool: 'expensive_tool' }, { 'X-Admin-Key': ps.adminKey });
    expect(r.status).toBe(200);
    expect(r.body.allowed).toBe(true);
    expect(r.body.creditsRequired).toBe(50);
    expect(r.body.creditsAfter).toBe(50);

    await pricedServer.stop();
  });
});
