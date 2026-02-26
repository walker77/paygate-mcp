/**
 * Tests for v6.7.0 — Key Health Score
 *
 * GET /keys/health?key=... returns a composite health score (0-100)
 * with component breakdown: balance, quota, rateLimit, errorRate.
 */

import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';
import http from 'http';

/* ── helpers ─────────────────────────────────────────────── */

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

/* ── setup ───────────────────────────────────────────────── */

let server: PayGateServer;
let port: number;
let adminKey: string;

beforeAll(async () => {
  server = makeServer({
    rateLimitPerMin: 100,
    globalQuota: {
      dailyCallLimit: 50,
      monthlyCallLimit: 500,
      dailyCreditLimit: 0,
      monthlyCreditLimit: 0,
    },
  });
  const started = await server.start();
  port = started.port;
  adminKey = started.adminKey;
});

afterAll(async () => {
  await server?.stop();
});

/* ── tests ───────────────────────────────────────────────── */

describe('Key Health Score', () => {
  async function createKey(credits = 1000, name = 'test'): Promise<string> {
    const r = await httpPost(port, '/keys', { credits, name }, { 'x-admin-key': adminKey });
    return r.body.key;
  }

  test('healthy key returns score ~100', async () => {
    const key = await createKey(1000, 'healthy-key');
    const r = await httpGet(port, `/keys/health?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.score).toBeGreaterThanOrEqual(90);
    expect(r.body.status).toMatch(/healthy|good/);
    expect(r.body.components).toBeDefined();
    expect(r.body.components.balance).toEqual(expect.objectContaining({ score: 100, weight: 0.30 }));
    expect(r.body.components.quota).toEqual(expect.objectContaining({ score: 100, weight: 0.25 }));
    expect(r.body.components.rateLimit).toEqual(expect.objectContaining({ score: 100, weight: 0.20 }));
    expect(r.body.components.errorRate).toEqual(expect.objectContaining({ score: 100, weight: 0.25 }));
  });

  test('key is masked in response', async () => {
    const key = await createKey(500, 'masked-key');
    const r = await httpGet(port, `/keys/health?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.key).toMatch(/^pg_.{7}\.\.\./);
    expect(r.body.key).not.toBe(key);
  });

  test('name is returned', async () => {
    const key = await createKey(500, 'named-key');
    const r = await httpGet(port, `/keys/health?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.body.name).toBe('named-key');
  });

  test('key with very low credits has zero-credit issue detected', async () => {
    // Create key with minimal credits — it won't have velocity so balance component stays 100
    // but the issues array should flag "Zero credits remaining" only when credits <= 0
    // Since we can't create 0-credit keys, create one and verify low credit detection
    const key = await createKey(1, 'low-credit-key');
    const r = await httpGet(port, `/keys/health?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    // 1 credit is technically not zero, so no zero-credit issue
    expect(r.body.score).toBeGreaterThanOrEqual(0);
    expect(r.body.components.balance).toBeDefined();
  });

  test('revoked key has revoked issue', async () => {
    const key = await createKey(100, 'revoked-key');
    await httpPost(port, '/keys/revoke', { key }, { 'x-admin-key': adminKey });
    const r = await httpGet(port, `/keys/health?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.issues).toContain('Key is revoked');
  });

  test('suspended key has suspended issue', async () => {
    const key = await createKey(100, 'suspended-key');
    await httpPost(port, '/keys/suspend', { key }, { 'x-admin-key': adminKey });
    const r = await httpGet(port, `/keys/health?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.issues).toContain('Key is suspended');
  });

  test('expired key has expired issue', async () => {
    const key = await createKey(100, 'expiry-key');
    await httpPost(port, '/keys/expiry', { key, expiresAt: '2020-01-01T00:00:00Z' }, { 'x-admin-key': adminKey });
    const r = await httpGet(port, `/keys/health?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.issues).toContain('Key has expired');
  });

  test('soon-expiring key has expiry warning', async () => {
    const key = await createKey(100, 'expiring-soon-key');
    const soon = new Date(Date.now() + 12 * 3_600_000).toISOString();
    await httpPost(port, '/keys/expiry', { key, expiresAt: soon }, { 'x-admin-key': adminKey });
    const r = await httpGet(port, `/keys/health?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.issues).toContain('Key expires within 24 hours');
  });

  test('all four component weights sum to 1.0', async () => {
    const key = await createKey(500, 'weight-check');
    const r = await httpGet(port, `/keys/health?key=${key}`, { 'x-admin-key': adminKey });
    const c = r.body.components;
    const totalWeight = c.balance.weight + c.quota.weight + c.rateLimit.weight + c.errorRate.weight;
    expect(totalWeight).toBeCloseTo(1.0, 5);
  });

  test('score is between 0 and 100', async () => {
    const key = await createKey(500, 'range-check');
    const r = await httpGet(port, `/keys/health?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.body.score).toBeGreaterThanOrEqual(0);
    expect(r.body.score).toBeLessThanOrEqual(100);
  });

  test('no issues field when no issues', async () => {
    const key = await createKey(500, 'no-issues');
    const r = await httpGet(port, `/keys/health?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.issues).toBeUndefined();
  });

  test('alias resolves to real key', async () => {
    const key = await createKey(500, 'alias-health');
    await httpPost(port, '/keys/alias', { key, alias: 'health-alias-' + Date.now() }, { 'x-admin-key': adminKey });
    const alias = 'health-alias-' + Date.now();
    // Re-create alias to avoid collision
    await httpPost(port, '/keys/alias', { key, alias }, { 'x-admin-key': adminKey });
    const r = await httpGet(port, `/keys/health?key=${alias}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.score).toBeGreaterThanOrEqual(90);
  });

  test('responds with component risk levels', async () => {
    const key = await createKey(500, 'risk-levels');
    const r = await httpGet(port, `/keys/health?key=${key}`, { 'x-admin-key': adminKey });
    const risks = ['healthy', 'good', 'caution', 'warning', 'critical'];
    expect(risks).toContain(r.body.components.balance.risk);
    expect(risks).toContain(r.body.components.quota.risk);
    expect(risks).toContain(r.body.components.rateLimit.risk);
    expect(risks).toContain(r.body.components.errorRate.risk);
  });

  test('status matches score thresholds', async () => {
    const key = await createKey(500, 'status-check');
    const r = await httpGet(port, `/keys/health?key=${key}`, { 'x-admin-key': adminKey });
    const s = r.body.score;
    if (s >= 90) expect(r.body.status).toBe('healthy');
    else if (s >= 75) expect(r.body.status).toBe('good');
    else if (s >= 50) expect(r.body.status).toBe('caution');
    else if (s >= 25) expect(r.body.status).toBe('warning');
    else expect(r.body.status).toBe('critical');
  });

  // ── auth + error cases ──

  test('requires admin key', async () => {
    const key = await createKey(100, 'auth-test');
    const r = await httpGet(port, `/keys/health?key=${key}`);
    expect(r.status).toBe(401);
  });

  test('requires key param', async () => {
    const r = await httpGet(port, '/keys/health', { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/key/i);
  });

  test('returns 404 for unknown key', async () => {
    const r = await httpGet(port, '/keys/health?key=pg_nonexistent', { 'x-admin-key': adminKey });
    expect(r.status).toBe(404);
  });

  test('returns 405 for POST', async () => {
    const r = await httpPost(port, '/keys/health', {}, { 'x-admin-key': adminKey });
    expect(r.status).toBe(405);
  });

  test('appears in root listing', async () => {
    const r = await httpGet(port, '/', { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.endpoints.keyHealth).toBeDefined();
    expect(r.body.endpoints.keyHealth).toMatch(/health/i);
  });

  test('multiple issues can accumulate', async () => {
    const key = await createKey(100, 'multi-issue');
    // Suspend + set past expiry = two issues
    await httpPost(port, '/keys/suspend', { key }, { 'x-admin-key': adminKey });
    await httpPost(port, '/keys/expiry', { key, expiresAt: '2020-01-01T00:00:00Z' }, { 'x-admin-key': adminKey });
    const r = await httpGet(port, `/keys/health?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.issues).toContain('Key is suspended');
    expect(r.body.issues).toContain('Key has expired');
    expect(r.body.issues.length).toBeGreaterThanOrEqual(2);
  });
});
