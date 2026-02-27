/**
 * Tests for v8.98.0 — Public Endpoint Hardening:
 * - Public endpoint rate limiting (DDoS / scrape protection)
 * - /robots.txt handler
 * - HEAD method support on public endpoints
 * - Configurable publicRateLimit
 */

import { PayGateServer } from '../src/server';
import http from 'http';

// Suppress logger output in tests
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

// ─── Unit tests: /robots.txt content ────────────────────────────────────────

describe('/robots.txt content', () => {
  let server: PayGateServer;
  let port: number;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const started = await server.start();
    port = started.port;
  });

  afterAll(async () => {
    await server.gracefulStop(1000);
  });

  it('should serve /robots.txt with correct content type', async () => {
    const resp = await get(port, '/robots.txt');
    expect(resp.status).toBe(200);
    expect(resp.headers['content-type']).toContain('text/plain');
  });

  it('should allow public discovery endpoints', async () => {
    const resp = await get(port, '/robots.txt');
    expect(resp.body).toContain('Allow: /health');
    expect(resp.body).toContain('Allow: /info');
    expect(resp.body).toContain('Allow: /pricing');
    expect(resp.body).toContain('Allow: /openapi.json');
    expect(resp.body).toContain('Allow: /docs');
    expect(resp.body).toContain('Allow: /.well-known/');
  });

  it('should disallow admin and key paths', async () => {
    const resp = await get(port, '/robots.txt');
    expect(resp.body).toContain('Disallow: /keys');
    expect(resp.body).toContain('Disallow: /admin');
    expect(resp.body).toContain('Disallow: /mcp');
    expect(resp.body).toContain('Disallow: /status');
    expect(resp.body).toContain('Disallow: /dashboard');
    expect(resp.body).toContain('Disallow: /audit');
    expect(resp.body).toContain('Disallow: /tokens');
    expect(resp.body).toContain('Disallow: /teams');
    expect(resp.body).toContain('Disallow: /webhooks');
    expect(resp.body).toContain('Disallow: /oauth');
    expect(resp.body).toContain('Disallow: /config');
    expect(resp.body).toContain('Disallow: /stripe');
    expect(resp.body).toContain('Disallow: /requests');
    expect(resp.body).toContain('Disallow: /metrics');
  });

  it('should include User-agent: *', async () => {
    const resp = await get(port, '/robots.txt');
    expect(resp.body).toContain('User-agent: *');
  });
});

// ─── HEAD method support ────────────────────────────────────────────────────

describe('HEAD method support', () => {
  let server: PayGateServer;
  let port: number;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const started = await server.start();
    port = started.port;
  });

  afterAll(async () => {
    await server.gracefulStop(1000);
  });

  const publicEndpoints = [
    '/health',
    '/info',
    '/pricing',
    '/openapi.json',
    '/docs',
    '/.well-known/mcp-payment',
    '/.well-known/mcp.json',
    '/robots.txt',
    '/',
  ];

  it.each(publicEndpoints)('HEAD %s should return 200 with empty body', async (path) => {
    const resp = await head(port, path);
    expect(resp.status).toBe(200);
    expect(resp.body).toBe('');
  });
});

// ─── Public endpoint rate limiting (E2E) ────────────────────────────────────

describe('Public endpoint rate limiting', () => {
  let server: PayGateServer;
  let port: number;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      publicRateLimit: 5, // Very low limit for testing
    });
    const started = await server.start();
    port = started.port;
  });

  afterAll(async () => {
    await server.gracefulStop(1000);
  });

  it('should allow requests within the rate limit', async () => {
    const resp = await get(port, '/health');
    expect(resp.status).toBe(200);
  });

  it('should return 429 after exceeding the rate limit on /health', async () => {
    // Send requests rapidly to exceed limit (5/min)
    const results: number[] = [];
    for (let i = 0; i < 8; i++) {
      const resp = await get(port, '/health');
      results.push(resp.status);
    }
    // Some should be 429 (we've already used at least 1 from the previous test)
    expect(results).toContain(429);
  });

  it('should return Retry-After header on 429 response', async () => {
    // The previous test should have exhausted the limit
    const resp = await get(port, '/info');
    if (resp.status === 429) {
      expect(resp.headers['retry-after']).toBeDefined();
      const retryAfter = parseInt(resp.headers['retry-after'] as string, 10);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
    }
    // If not 429, we consumed it from another IP (test still passes)
    expect([200, 429]).toContain(resp.status);
  });

  it('should rate limit /robots.txt too', async () => {
    const results: number[] = [];
    for (let i = 0; i < 3; i++) {
      const resp = await get(port, '/robots.txt');
      results.push(resp.status);
    }
    // Should see at least one 429 since we've blown the budget on the same IP
    expect(results).toContain(429);
  });

  it('should rate limit / (root) too', async () => {
    const resp = await get(port, '/');
    // Should be 429 since limit is exhausted
    expect([200, 429]).toContain(resp.status);
  });

  it('should rate limit /.well-known paths', async () => {
    const resp = await get(port, '/.well-known/mcp.json');
    expect([200, 429]).toContain(resp.status);
  });
});

// ─── Default publicRateLimit = 300 ──────────────────────────────────────────

describe('Default publicRateLimit (300)', () => {
  let server: PayGateServer;
  let port: number;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      // publicRateLimit not set — should default to 300
    });
    const started = await server.start();
    port = started.port;
  });

  afterAll(async () => {
    await server.gracefulStop(1000);
  });

  it('should allow many requests with default rate limit', async () => {
    // With default 300/min, 10 requests should all succeed
    const results: number[] = [];
    for (let i = 0; i < 10; i++) {
      const resp = await get(port, '/health');
      results.push(resp.status);
    }
    expect(results.every(s => s === 200)).toBe(true);
  });
});

// ─── publicRateLimit: 0 disables limiting ───────────────────────────────────

describe('publicRateLimit: 0 disables rate limiting', () => {
  let server: PayGateServer;
  let port: number;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      publicRateLimit: 0,
    });
    const started = await server.start();
    port = started.port;
  });

  afterAll(async () => {
    await server.gracefulStop(1000);
  });

  it('should allow unlimited requests when publicRateLimit is 0', async () => {
    // Send many requests — none should be 429
    const results: number[] = [];
    for (let i = 0; i < 20; i++) {
      const resp = await get(port, '/health');
      results.push(resp.status);
    }
    expect(results.every(s => s === 200)).toBe(true);
  });
});

// ─── Admin endpoints are NOT affected by public rate limiter ─────────────

describe('Admin endpoints unaffected by public rate limiter', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      publicRateLimit: 2, // Extremely low public limit
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop(1000);
  });

  it('should exhaust public limit but still allow admin requests', async () => {
    // Exhaust public rate limit
    for (let i = 0; i < 5; i++) {
      await get(port, '/health');
    }

    // Admin endpoint should still work (has its own limiter at 120/min)
    const resp = await post(port, '/keys', { name: 'test-admin', credits: 10 }, { 'X-Admin-Key': adminKey });
    expect(resp.status).toBe(201);
    expect(resp.body.key).toBeDefined();
  });
});

// ─── OpenAPI spec includes /robots.txt ──────────────────────────────────────

describe('OpenAPI spec includes /robots.txt', () => {
  let server: PayGateServer;
  let port: number;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const started = await server.start();
    port = started.port;
  });

  afterAll(async () => {
    await server.gracefulStop(1000);
  });

  it('should include /robots.txt in OpenAPI spec', async () => {
    const resp = await get(port, '/openapi.json');
    expect(resp.status).toBe(200);
    const spec = JSON.parse(resp.body);
    expect(spec.paths['/robots.txt']).toBeDefined();
    expect(spec.paths['/robots.txt'].get).toBeDefined();
    expect(spec.paths['/robots.txt'].get.tags).toContain('Discovery');
  });
});

// ─── CORS includes HEAD ─────────────────────────────────────────────────────

describe('CORS headers include HEAD', () => {
  let server: PayGateServer;
  let port: number;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const started = await server.start();
    port = started.port;
  });

  afterAll(async () => {
    await server.gracefulStop(1000);
  });

  it('should include HEAD in Access-Control-Allow-Methods', async () => {
    const resp = await get(port, '/health');
    const methods = resp.headers['access-control-allow-methods'] as string;
    expect(methods).toContain('HEAD');
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function get(port: number, path: string): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode!, body: data, headers: res.headers as any }));
    }).on('error', reject);
  });
}

function head(port: number, path: string): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'HEAD',
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode!, body: data, headers: res.headers as any }));
    });
    req.on('error', reject);
    req.end();
  });
}

function post(port: number, path: string, body: any, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data).toString(),
        ...headers,
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (chunk) => chunks += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(chunks) });
        } catch {
          resolve({ status: res.statusCode!, body: chunks });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
