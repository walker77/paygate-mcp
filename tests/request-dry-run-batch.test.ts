/**
 * Tests for v7.8.0 — Batch Dry Run
 *
 * POST /requests/dry-run/batch — Simulate multiple tool calls at once
 * without executing, returning aggregate and per-tool predictions.
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

/* ── tests ───────────────────────────────────────────────── */

describe('Batch Dry Run', () => {
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

  test('all allowed when sufficient credits', async () => {
    const r = await httpPost(port, '/requests/dry-run/batch', {
      key: apiKey,
      tools: [{ name: 'tool_a' }, { name: 'tool_b' }],
    }, { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.allAllowed).toBe(true);
    expect(r.body.totalCreditsRequired).toBe(10); // 5 + 5
    expect(r.body.creditsAvailable).toBe(100);
    expect(r.body.creditsAfter).toBe(90);
    expect(r.body.results).toHaveLength(2);
    expect(r.body.results[0].tool).toBe('tool_a');
    expect(r.body.results[0].allowed).toBe(true);
    expect(r.body.results[0].creditsRequired).toBe(5);
    expect(r.body.results[1].tool).toBe('tool_b');
    expect(r.body.results[1].allowed).toBe(true);
  });

  test('denied when aggregate credits exceed balance', async () => {
    // Create key with 8 credits — enough for one call but not two
    const r2 = await httpPost(port, '/keys', { credits: 8, name: 'tight' }, { 'X-Admin-Key': adminKey });
    const tightKey = r2.body.key;

    const r = await httpPost(port, '/requests/dry-run/batch', {
      key: tightKey,
      tools: [{ name: 'tool_a' }, { name: 'tool_b' }],
    }, { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.allAllowed).toBe(false);
    expect(r.body.reason).toContain('insufficient_credits');
    expect(r.body.totalCreditsRequired).toBe(10);
    expect(r.body.creditsAvailable).toBe(8);
    // Individual tools still show their credits
    expect(r.body.results[0].allowed).toBe(true);
    expect(r.body.results[0].creditsRequired).toBe(5);
  });

  test('denied for invalid key', async () => {
    const r = await httpPost(port, '/requests/dry-run/batch', {
      key: 'pg_invalid',
      tools: [{ name: 'tool_a' }],
    }, { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.allAllowed).toBe(false);
    expect(r.body.reason).toBe('invalid_api_key');
    expect(r.body.results[0].allowed).toBe(false);
  });

  test('denied for suspended key', async () => {
    await httpPost(port, '/keys/suspend', { key: apiKey }, { 'X-Admin-Key': adminKey });

    const r = await httpPost(port, '/requests/dry-run/batch', {
      key: apiKey,
      tools: [{ name: 'tool_a' }],
    }, { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.allAllowed).toBe(false);
    expect(r.body.reason).toBe('key_suspended');
  });

  test('per-tool ACL denial', async () => {
    await httpPost(port, '/keys/acl', { key: apiKey, deniedTools: ['tool_b'] }, { 'X-Admin-Key': adminKey });

    const r = await httpPost(port, '/requests/dry-run/batch', {
      key: apiKey,
      tools: [{ name: 'tool_a' }, { name: 'tool_b' }],
    }, { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.allAllowed).toBe(false);
    expect(r.body.results[0].allowed).toBe(true);
    expect(r.body.results[1].allowed).toBe(false);
    expect(r.body.results[1].reason).toContain('tool_not_allowed');
  });

  test('spending limit check', async () => {
    await httpPost(port, '/limits', { key: apiKey, spendingLimit: 8 }, { 'X-Admin-Key': adminKey });

    const r = await httpPost(port, '/requests/dry-run/batch', {
      key: apiKey,
      tools: [{ name: 'tool_a' }, { name: 'tool_b' }],
    }, { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.allAllowed).toBe(false);
    expect(r.body.reason).toContain('spending_limit_exceeded');
  });

  test('does not deduct credits', async () => {
    await httpPost(port, '/requests/dry-run/batch', {
      key: apiKey,
      tools: [{ name: 'tool_a' }, { name: 'tool_b' }, { name: 'tool_a' }],
    }, { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': apiKey });
    expect(balance.body.credits).toBe(100);
  });

  test('does not appear in request log', async () => {
    await httpPost(port, '/requests/dry-run/batch', {
      key: apiKey,
      tools: [{ name: 'tool_a' }],
    }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/requests', { 'X-Admin-Key': adminKey });
    expect(r.body.total).toBe(0);
  });

  test('requires admin key', async () => {
    const r = await httpPost(port, '/requests/dry-run/batch', {
      key: apiKey,
      tools: [{ name: 'tool_a' }],
    });
    expect(r.status).toBe(401);
  });

  test('rejects GET method', async () => {
    const r = await httpGet(port, '/requests/dry-run/batch', { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('requires key field', async () => {
    const r = await httpPost(port, '/requests/dry-run/batch', {
      tools: [{ name: 'tool_a' }],
    }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('key');
  });

  test('requires tools field', async () => {
    const r = await httpPost(port, '/requests/dry-run/batch', {
      key: apiKey,
    }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('tools');
  });

  test('rejects empty tools array', async () => {
    const r = await httpPost(port, '/requests/dry-run/batch', {
      key: apiKey,
      tools: [],
    }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(400);
  });

  test('rejects tools without name', async () => {
    const r = await httpPost(port, '/requests/dry-run/batch', {
      key: apiKey,
      tools: [{ foo: 'bar' }],
    }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('tools[0]');
  });

  test('max 100 tools', async () => {
    const tools = Array.from({ length: 101 }, (_, i) => ({ name: `tool_${i}` }));
    const r = await httpPost(port, '/requests/dry-run/batch', {
      key: apiKey,
      tools,
    }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('100');
  });

  test('root listing includes endpoint', async () => {
    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.requestDryRunBatch).toBeDefined();
    expect(r.body.endpoints.requestDryRunBatch).toContain('/requests/dry-run/batch');
  });

  test('supports alias keys', async () => {
    await httpPost(port, '/keys/alias', { key: apiKey, alias: 'batch-alias' }, { 'X-Admin-Key': adminKey });

    const r = await httpPost(port, '/requests/dry-run/batch', {
      key: 'batch-alias',
      tools: [{ name: 'tool_a' }],
    }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.allAllowed).toBe(true);
  });

  test('custom tool pricing applied', async () => {
    const ps = makeServer({
      defaultCreditsPerCall: 1,
      toolPricing: { expensive: { creditsPerCall: 50 }, cheap: { creditsPerCall: 2 } },
    });
    const pStarted = await ps.start();
    const pk = (await httpPost(pStarted.port, '/keys', { credits: 100 }, { 'X-Admin-Key': pStarted.adminKey })).body.key;

    const r = await httpPost(pStarted.port, '/requests/dry-run/batch', {
      key: pk,
      tools: [{ name: 'expensive' }, { name: 'cheap' }],
    }, { 'X-Admin-Key': pStarted.adminKey });

    expect(r.body.allAllowed).toBe(true);
    expect(r.body.totalCreditsRequired).toBe(52);
    expect(r.body.results[0].creditsRequired).toBe(50);
    expect(r.body.results[1].creditsRequired).toBe(2);

    await ps.stop();
  });

  test('includes rate limit info when available', async () => {
    const rlServer = makeServer({ defaultCreditsPerCall: 1, globalRateLimitPerMin: 100 });
    const rl = await rlServer.start();
    const rlKey = (await httpPost(rl.port, '/keys', { credits: 1000 }, { 'X-Admin-Key': rl.adminKey })).body.key;

    const r = await httpPost(rl.port, '/requests/dry-run/batch', {
      key: rlKey,
      tools: [{ name: 'tool_a' }],
    }, { 'X-Admin-Key': rl.adminKey });

    expect(r.body.rateLimit).toBeDefined();
    expect(r.body.rateLimit.limit).toBe(100);

    await rlServer.stop();
  });
});
