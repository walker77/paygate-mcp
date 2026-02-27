/**
 * Tests for v6.6.0 — Key Comparison Endpoint.
 *
 * Tests GET /keys/compare?keys=pg_a,pg_b returning side-by-side
 * key comparison: credits, usage, velocity, rate limits, metadata.
 */

import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';
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

describe('GET /keys/compare (HTTP)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let key1: string;
  let key2: string;
  let key3: string;

  beforeAll(async () => {
    server = makeServer();
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    const res1 = await httpPost(port, '/keys', { name: 'compare-key-1', credits: 500, tags: { env: 'prod' } }, { 'x-admin-key': adminKey });
    key1 = res1.body.key;

    const res2 = await httpPost(port, '/keys', { name: 'compare-key-2', credits: 1000, namespace: 'team-a' }, { 'x-admin-key': adminKey });
    key2 = res2.body.key;

    const res3 = await httpPost(port, '/keys', { name: 'compare-key-3', credits: 200 }, { 'x-admin-key': adminKey });
    key3 = res3.body.key;
  });

  afterAll(async () => {
    if (server) await server.gracefulStop(5_000);
  }, 30_000);

  test('compares two keys successfully', async () => {
    const res = await httpGet(port, `/keys/compare?keys=${key1},${key2}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.compared).toBe(2);
    expect(res.body.keys.length).toBe(2);
    expect(res.body.keys[0].name).toBe('compare-key-1');
    expect(res.body.keys[1].name).toBe('compare-key-2');
  });

  test('compares three keys', async () => {
    const res = await httpGet(port, `/keys/compare?keys=${key1},${key2},${key3}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.compared).toBe(3);
    expect(res.body.keys.length).toBe(3);
  });

  test('returns correct credit balances', async () => {
    const res = await httpGet(port, `/keys/compare?keys=${key1},${key2}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.keys[0].credits.current).toBe(500);
    expect(res.body.keys[1].credits.current).toBe(1000);
  });

  test('includes usage data', async () => {
    const res = await httpGet(port, `/keys/compare?keys=${key1},${key2}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.keys[0].usage).toHaveProperty('totalCalls');
    expect(res.body.keys[0].usage).toHaveProperty('totalAllowed');
    expect(res.body.keys[0].usage).toHaveProperty('totalDenied');
  });

  test('includes velocity data', async () => {
    const res = await httpGet(port, `/keys/compare?keys=${key1},${key2}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.keys[0].velocity).toHaveProperty('creditsPerHour');
    expect(res.body.keys[0].velocity).toHaveProperty('creditsPerDay');
    expect(res.body.keys[0].velocity).toHaveProperty('estimatedHoursRemaining');
  });

  test('includes rate limit data', async () => {
    const res = await httpGet(port, `/keys/compare?keys=${key1},${key2}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.keys[0].rateLimit).toHaveProperty('used');
    expect(res.body.keys[0].rateLimit).toHaveProperty('limit');
    expect(res.body.keys[0].rateLimit).toHaveProperty('remaining');
  });

  test('includes metadata with namespace and tags', async () => {
    const res = await httpGet(port, `/keys/compare?keys=${key1},${key2}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    // key1 has tags
    expect(res.body.keys[0].metadata.tags).toEqual({ env: 'prod' });
    // key2 has namespace
    expect(res.body.keys[1].metadata.namespace).toBe('team-a');
    // Both have createdAt
    expect(res.body.keys[0].metadata.createdAt).toBeTruthy();
  });

  test('masks keys in response', async () => {
    const res = await httpGet(port, `/keys/compare?keys=${key1},${key2}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.keys[0].key).toContain('...');
    expect(res.body.keys[1].key).toContain('...');
  });

  test('reports status correctly for active keys', async () => {
    const res = await httpGet(port, `/keys/compare?keys=${key1},${key2}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.keys[0].status).toBe('active');
    expect(res.body.keys[1].status).toBe('active');
  });

  test('handles suspended key status', async () => {
    // Suspend key3
    await httpPost(port, '/keys/suspend', { key: key3 }, { 'x-admin-key': adminKey });

    const res = await httpGet(port, `/keys/compare?keys=${key1},${key3}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.keys[0].status).toBe('active');
    expect(res.body.keys[1].status).toBe('suspended');

    // Resume for later tests
    await httpPost(port, '/keys/resume', { key: key3 }, { 'x-admin-key': adminKey });
  });

  test('reports not found keys', async () => {
    const res = await httpGet(port, `/keys/compare?keys=${key1},pg_nonexistent`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.compared).toBe(1);
    expect(res.body.notFound).toContain('pg_nonexistent');
  });

  test('requires admin auth', async () => {
    const res = await httpGet(port, `/keys/compare?keys=${key1},${key2}`);
    expect(res.status).toBe(401);
  });

  test('requires keys parameter', async () => {
    const res = await httpGet(port, '/keys/compare', { 'x-admin-key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('keys');
  });

  test('requires at least 2 keys', async () => {
    const res = await httpGet(port, `/keys/compare?keys=${key1}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('2');
  });

  test('POST returns 405', async () => {
    const res = await httpPost(port, `/keys/compare?keys=${key1},${key2}`, {}, { 'x-admin-key': adminKey });
    expect(res.status).toBe(405);
  });

  test('root listing includes compare endpoint', async () => {
    const res = await httpGet(port, '/', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    const str = JSON.stringify(res.body);
    expect(str).toContain('/keys/compare');
  });

  test('response shape is correct', async () => {
    const res = await httpGet(port, `/keys/compare?keys=${key1},${key2}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('compared');
    expect(res.body).toHaveProperty('keys');
    expect(Array.isArray(res.body.keys)).toBe(true);
    const key = res.body.keys[0];
    expect(key).toHaveProperty('key');
    expect(key).toHaveProperty('name');
    expect(key).toHaveProperty('status');
    expect(key).toHaveProperty('credits');
    expect(key).toHaveProperty('usage');
    expect(key).toHaveProperty('velocity');
    expect(key).toHaveProperty('rateLimit');
    expect(key).toHaveProperty('metadata');
  });
});
