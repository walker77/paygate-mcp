/**
 * Tests for v6.2.0 — Rate Limit Status Endpoint.
 *
 * Tests GET /keys/rate-limit-status?key=... returning current rate limit
 * window state: global limit (used/remaining/resetInMs), per-tool limits,
 * key validation, and auth requirements.
 */

import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';
import { RateLimiter } from '../src/rate-limiter';
import http from 'http';

const ECHO_CMD = process.execPath;
const ECHO_ARGS = ['-e', `process.stdin.resume(); process.stdin.on('data', d => { const r = JSON.parse(d.toString().trim()); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: {} }) + '\\n'); });`];

function makeServer(overrides: Record<string, any> = {}): PayGateServer {
  return new PayGateServer({
    ...DEFAULT_CONFIG,
    serverCommand: ECHO_CMD,
    serverArgs: ECHO_ARGS,
    port: 0,
    ...overrides,
  });
}

async function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
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

async function httpPost(port: number, path: string, body: object, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode!, body: buf }); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── Unit tests for RateLimiter.getStatus ───
describe('RateLimiter.getStatus (unit)', () => {
  test('returns full remaining when no calls recorded', () => {
    const rl = new RateLimiter(60);
    const status = rl.getStatus('key1');
    expect(status.used).toBe(0);
    expect(status.limit).toBe(60);
    expect(status.remaining).toBe(60);
    expect(status.resetInMs).toBe(60000);
    rl.destroy();
  });

  test('reflects recorded calls', () => {
    const rl = new RateLimiter(10);
    rl.record('key1');
    rl.record('key1');
    rl.record('key1');
    const status = rl.getStatus('key1');
    expect(status.used).toBe(3);
    expect(status.limit).toBe(10);
    expect(status.remaining).toBe(7);
    expect(status.resetInMs).toBeGreaterThan(0);
    expect(status.resetInMs).toBeLessThanOrEqual(60000);
    rl.destroy();
  });

  test('returns 0 remaining when at limit', () => {
    const rl = new RateLimiter(3);
    rl.record('key1');
    rl.record('key1');
    rl.record('key1');
    const status = rl.getStatus('key1');
    expect(status.used).toBe(3);
    expect(status.remaining).toBe(0);
    rl.destroy();
  });

  test('custom limit override', () => {
    const rl = new RateLimiter(60);
    const compositeKey = 'key1:tool:search';
    rl.recordCustom(compositeKey);
    rl.recordCustom(compositeKey);
    const status = rl.getStatus(compositeKey, 5);
    expect(status.used).toBe(2);
    expect(status.limit).toBe(5);
    expect(status.remaining).toBe(3);
    rl.destroy();
  });

  test('unlimited rate limit returns Infinity remaining', () => {
    const rl = new RateLimiter(0);
    const status = rl.getStatus('key1');
    expect(status.used).toBe(0);
    expect(status.limit).toBe(0);
    expect(status.remaining).toBe(Infinity);
    expect(status.resetInMs).toBe(0);
    rl.destroy();
  });

  test('does not record a call (read-only)', () => {
    const rl = new RateLimiter(10);
    rl.getStatus('key1');
    rl.getStatus('key1');
    rl.getStatus('key1');
    const status = rl.getStatus('key1');
    expect(status.used).toBe(0); // getStatus should not record
    rl.destroy();
  });
});

// ─── HTTP integration tests ───
describe('GET /keys/rate-limit-status (HTTP)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let testKey: string;

  beforeAll(async () => {
    server = makeServer({
      globalRateLimitPerMin: 100,
      toolPricing: {
        'search': { creditsPerCall: 2, rateLimitPerMin: 10 },
        'translate': { creditsPerCall: 5, rateLimitPerMin: 20 },
        'echo': { creditsPerCall: 1 },
      },
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    // Create a test key
    const res = await httpPost(port, '/keys', { name: 'test-key', credits: 1000 }, { 'x-admin-key': adminKey });
    testKey = res.body.key;
  });

  afterAll(async () => {
    if (server) await server.stop();
  });

  test('returns global rate limit status', async () => {
    const res = await httpGet(port, `/keys/rate-limit-status?key=${testKey}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.global).toBeDefined();
    expect(res.body.global.limit).toBe(100);
    expect(res.body.global.used).toBe(0);
    expect(res.body.global.remaining).toBe(100);
    expect(res.body.global.windowMs).toBe(60000);
    expect(typeof res.body.global.resetInMs).toBe('number');
  });

  test('returns per-tool rate limits for tools with custom limits', async () => {
    const res = await httpGet(port, `/keys/rate-limit-status?key=${testKey}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.perTool).toBeDefined();
    expect(res.body.perTool.search).toBeDefined();
    expect(res.body.perTool.search.limit).toBe(10);
    expect(res.body.perTool.search.used).toBe(0);
    expect(res.body.perTool.search.remaining).toBe(10);
    expect(res.body.perTool.translate).toBeDefined();
    expect(res.body.perTool.translate.limit).toBe(20);
    // 'echo' has no rateLimitPerMin, should NOT appear
    expect(res.body.perTool.echo).toBeUndefined();
  });

  test('masks key in response', async () => {
    const res = await httpGet(port, `/keys/rate-limit-status?key=${testKey}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.key).toContain('...');
    expect(res.body.key.length).toBeLessThan(testKey.length);
    expect(res.body.name).toBe('test-key');
  });

  test('requires admin auth', async () => {
    const res = await httpGet(port, `/keys/rate-limit-status?key=${testKey}`);
    expect(res.status).toBe(401);
  });

  test('requires key parameter', async () => {
    const res = await httpGet(port, '/keys/rate-limit-status', { 'x-admin-key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('key');
  });

  test('returns 404 for nonexistent key', async () => {
    const res = await httpGet(port, '/keys/rate-limit-status?key=pg_nonexistent', { 'x-admin-key': adminKey });
    expect(res.status).toBe(404);
  });

  test('POST returns 405', async () => {
    const res = await httpPost(port, `/keys/rate-limit-status?key=${testKey}`, {}, { 'x-admin-key': adminKey });
    expect(res.status).toBe(405);
  });

  test('reflects usage after rate limit recording', async () => {
    // Manually record some global calls
    server.gate.rateLimiter.record(testKey);
    server.gate.rateLimiter.record(testKey);

    // Manually record some per-tool calls
    server.gate.rateLimiter.recordCustom(`${testKey}:tool:search`);

    const res = await httpGet(port, `/keys/rate-limit-status?key=${testKey}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.global.used).toBe(2);
    expect(res.body.global.remaining).toBe(98);
    expect(res.body.perTool.search.used).toBe(1);
    expect(res.body.perTool.search.remaining).toBe(9);
    expect(res.body.perTool.translate.used).toBe(0);
    expect(res.body.perTool.translate.remaining).toBe(20);
  });

  test('root listing includes rate-limit-status', async () => {
    const res = await httpGet(port, '/', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    const body = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
    const str = JSON.stringify(body);
    expect(str).toContain('/keys/rate-limit-status');
  });
});

// ─── No per-tool limits configured ───
describe('Rate limit status without per-tool limits', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let testKey: string;

  beforeAll(async () => {
    server = makeServer({ globalRateLimitPerMin: 30 });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    const res = await httpPost(port, '/keys', { name: 'simple-key', credits: 500 }, { 'x-admin-key': adminKey });
    testKey = res.body.key;
  });

  afterAll(async () => {
    if (server) await server.stop();
  });

  test('perTool is undefined when no per-tool limits configured', async () => {
    const res = await httpGet(port, `/keys/rate-limit-status?key=${testKey}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.global.limit).toBe(30);
    expect(res.body.perTool).toBeUndefined();
  });
});

// ─── Unlimited rate limit ───
describe('Rate limit status with unlimited rate limit', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let testKey: string;

  beforeAll(async () => {
    server = makeServer({ globalRateLimitPerMin: 0 });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    const res = await httpPost(port, '/keys', { name: 'unlimited-key', credits: 500 }, { 'x-admin-key': adminKey });
    testKey = res.body.key;
  });

  afterAll(async () => {
    if (server) await server.stop();
  });

  test('returns unlimited status', async () => {
    const res = await httpGet(port, `/keys/rate-limit-status?key=${testKey}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.global.limit).toBe(0);
    expect(res.body.global.remaining).toBe(null); // Infinity becomes null in JSON
    expect(res.body.global.used).toBe(0);
  });
});
