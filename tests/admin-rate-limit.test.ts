/**
 * Admin endpoint rate limiting tests — brute-force protection.
 *
 * Each describe block uses its own server to get a clean rate limit state,
 * because all tests from the same process share IP 127.0.0.1.
 *
 * Tests use adminRateLimit: 10 for fast, deterministic assertions.
 * Default in production is 60 requests/min per source IP.
 */

import { PayGateServer } from '../src/server';
import http from 'http';

// Suppress logger output in tests
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

const TEST_RATE_LIMIT = 10;

function post(port: number, path: string, body: any, headers: Record<string, string> = {}): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (chunk) => chunks += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(chunks), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode!, body: chunks, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, { headers }, (res) => {
      let chunks = '';
      res.on('data', (chunk) => chunks += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(chunks), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode!, body: chunks, headers: res.headers });
        }
      });
    }).on('error', reject);
  });
}

function makeServer() {
  return new PayGateServer({
    serverCommand: 'echo',
    serverArgs: ['test'],
    port: 0,
    adminRateLimit: TEST_RATE_LIMIT,
  });
}

// ─── Test 1: Basic rate limit behavior ──────────────────────────────────────

describe('Admin Rate Limit — Basic Enforcement', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = makeServer();
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop(1000);
  });

  it(`should allow up to ${TEST_RATE_LIMIT} admin requests within a minute`, async () => {
    const results: number[] = [];
    for (let i = 0; i < TEST_RATE_LIMIT; i++) {
      const resp = await get(port, '/status', { 'X-Admin-Key': adminKey });
      results.push(resp.status);
    }
    expect(results.every(s => s === 200)).toBe(true);
  });

  it('should return 429 once limit is exceeded', async () => {
    // Previous test used all 10 slots, this should be blocked
    const resp = await get(port, '/status', { 'X-Admin-Key': adminKey });
    expect(resp.status).toBe(429);
  });

  it('should include Retry-After header in 429 response', async () => {
    const resp = await get(port, '/status', { 'X-Admin-Key': adminKey });
    expect(resp.status).toBe(429);
    expect(resp.headers['retry-after']).toBeDefined();
    expect(parseInt(resp.headers['retry-after'] as string)).toBeGreaterThan(0);
  });

  it('should return JSON error body in 429 response', async () => {
    const resp = await get(port, '/status', { 'X-Admin-Key': adminKey });
    expect(resp.status).toBe(429);
    expect(resp.body.error).toContain('Too many admin requests');
  });
});

// ─── Test 2: Brute-force protection (invalid keys rate-limited by IP) ───────

describe('Admin Rate Limit — Brute Force Protection', () => {
  let server: PayGateServer;
  let port: number;

  beforeAll(async () => {
    server = makeServer();
    const started = await server.start();
    port = started.port;
  });

  afterAll(async () => {
    await server.gracefulStop(1000);
  });

  it('should rate-limit invalid admin keys by source IP', async () => {
    const results: number[] = [];
    for (let i = 0; i < TEST_RATE_LIMIT + 5; i++) {
      const resp = await get(port, '/status', { 'X-Admin-Key': `wrong_key_${i}` });
      results.push(resp.status);
    }

    // First TEST_RATE_LIMIT should get 401 (auth failed), rest should get 429
    const authFailed = results.filter(s => s === 401);
    const rateLimited = results.filter(s => s === 429);
    expect(authFailed.length).toBe(TEST_RATE_LIMIT);
    expect(rateLimited.length).toBe(5);
  });
});

// ─── Test 3: POST admin endpoints are rate-limited ──────────────────────────

describe('Admin Rate Limit — POST Endpoints', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = makeServer();
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop(1000);
  });

  it(`should rate-limit POST /keys after ${TEST_RATE_LIMIT} requests`, async () => {
    const results: number[] = [];
    for (let i = 0; i < TEST_RATE_LIMIT + 3; i++) {
      const resp = await post(port, '/keys', { name: `rate-test-${i}`, credits: 1 }, { 'X-Admin-Key': adminKey });
      results.push(resp.status);
    }

    const created = results.filter(s => s === 201);
    const limited = results.filter(s => s === 429);
    expect(created.length).toBe(TEST_RATE_LIMIT);
    expect(limited.length).toBe(3);
  });
});

// ─── Test 4: /health bypasses rate limit ────────────────────────────────────

describe('Admin Rate Limit — Health Endpoint Bypass', () => {
  let server: PayGateServer;
  let port: number;

  beforeAll(async () => {
    server = makeServer();
    const started = await server.start();
    port = started.port;
  });

  afterAll(async () => {
    await server.gracefulStop(1000);
  });

  it('should not rate-limit /health endpoint', async () => {
    const results: number[] = [];
    for (let i = 0; i < TEST_RATE_LIMIT + 10; i++) {
      const resp = await new Promise<number>((resolve) => {
        http.get(`http://127.0.0.1:${port}/health`, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode!));
        }).on('error', () => resolve(0));
      });
      results.push(resp);
    }

    // All should be 200 (no rate limiting on /health)
    expect(results.every(s => s === 200)).toBe(true);
  });
});

// ─── Test 5: Disabled admin rate limit ──────────────────────────────────────

describe('Admin Rate Limit — Disabled (adminRateLimit: 0)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      adminRateLimit: 0,
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop(1000);
  });

  it('should allow unlimited admin requests when rate limit is 0', async () => {
    const results: number[] = [];
    for (let i = 0; i < 30; i++) {
      const resp = await get(port, '/status', { 'X-Admin-Key': adminKey });
      results.push(resp.status);
    }

    // All should be 200 (no rate limiting)
    expect(results.every(s => s === 200)).toBe(true);
  });
});
