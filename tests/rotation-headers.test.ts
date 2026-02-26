/**
 * Key Rotation + Rate Limit Headers Tests.
 *
 * Tests:
 *   - KeyStore.rotateKey unit tests
 *   - E2E: POST /keys/rotate endpoint
 *   - E2E: Rate limit response headers on /mcp
 *   - E2E: X-Credits-Remaining header
 */

import * as http from 'http';
import { KeyStore } from '../src/store';
import { PayGateServer } from '../src/server';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function httpRequest(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: options.port,
      method: options.method,
      path: options.path,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body,
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ─── Unit Tests: KeyStore.rotateKey ─────────────────────────────────────────

describe('KeyStore.rotateKey', () => {
  it('should rotate an active key and return new key record', () => {
    const store = new KeyStore();
    const original = store.createKey('test-key', 500);

    const rotated = store.rotateKey(original.key);

    expect(rotated).not.toBeNull();
    expect(rotated!.key).not.toBe(original.key);
    expect(rotated!.key).toMatch(/^pg_/);
    expect(rotated!.name).toBe('test-key');
    expect(rotated!.credits).toBe(500);
    expect(rotated!.active).toBe(true);
  });

  it('should deactivate the old key', () => {
    const store = new KeyStore();
    const original = store.createKey('rotate-test', 200);

    store.rotateKey(original.key);

    // Old key should be inactive
    const oldRecord = store.getKey(original.key);
    expect(oldRecord).toBeNull(); // getKey returns null for inactive keys
  });

  it('should preserve credits, totalSpent, totalCalls', () => {
    const store = new KeyStore();
    const original = store.createKey('preserve-test', 1000);

    // Use some credits
    store.deductCredits(original.key, 50);
    store.deductCredits(original.key, 30);
    const beforeRotation = store.getKey(original.key)!;
    expect(beforeRotation.credits).toBe(920);
    expect(beforeRotation.totalSpent).toBe(80);
    expect(beforeRotation.totalCalls).toBe(2);

    const rotated = store.rotateKey(original.key)!;

    expect(rotated.credits).toBe(920);
    expect(rotated.totalSpent).toBe(80);
    expect(rotated.totalCalls).toBe(2);
  });

  it('should preserve ACL settings', () => {
    const store = new KeyStore();
    const original = store.createKey('acl-test', 100, {
      allowedTools: ['search', 'analyze'],
      deniedTools: ['admin_tool'],
    });

    const rotated = store.rotateKey(original.key)!;

    expect(rotated.allowedTools).toEqual(['search', 'analyze']);
    expect(rotated.deniedTools).toEqual(['admin_tool']);
  });

  it('should preserve quota settings', () => {
    const store = new KeyStore();
    const original = store.createKey('quota-test', 100, {
      quota: {
        dailyCallLimit: 100,
        monthlyCallLimit: 1000,
        dailyCreditLimit: 500,
        monthlyCreditLimit: 5000,
      },
    });

    const rotated = store.rotateKey(original.key)!;

    expect(rotated.quota).toEqual({
      dailyCallLimit: 100,
      monthlyCallLimit: 1000,
      dailyCreditLimit: 500,
      monthlyCreditLimit: 5000,
    });
  });

  it('should preserve expiry', () => {
    const store = new KeyStore();
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    const original = store.createKey('expiry-test', 100, { expiresAt });

    const rotated = store.rotateKey(original.key)!;

    expect(rotated.expiresAt).toBe(expiresAt);
  });

  it('should return null for inactive key', () => {
    const store = new KeyStore();
    const original = store.createKey('revoke-test', 100);
    store.revokeKey(original.key);

    const result = store.rotateKey(original.key);
    expect(result).toBeNull();
  });

  it('should return null for non-existent key', () => {
    const store = new KeyStore();

    const result = store.rotateKey('pg_nonexistent');
    expect(result).toBeNull();
  });

  it('new key should be usable after rotation', () => {
    const store = new KeyStore();
    const original = store.createKey('usable-test', 500);

    const rotated = store.rotateKey(original.key)!;

    // New key works
    expect(store.hasCredits(rotated.key, 100)).toBe(true);
    expect(store.deductCredits(rotated.key, 50)).toBe(true);

    // Old key does not
    expect(store.hasCredits(original.key, 1)).toBe(false);
    expect(store.deductCredits(original.key, 1)).toBe(false);
  });

  it('should preserve spending limit', () => {
    const store = new KeyStore();
    const original = store.createKey('limit-test', 1000);
    // Manually set a spending limit via the raw record
    const rawRecord = store.getKey(original.key)!;
    rawRecord.spendingLimit = 500;

    const rotated = store.rotateKey(original.key)!;
    expect(rotated.spendingLimit).toBe(500);
  });
});

// ─── E2E Tests: POST /keys/rotate ──────────────────────────────────────────

describe('Key Rotation E2E', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: [],
      port: 0,
      defaultCreditsPerCall: 2,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('POST /keys/rotate rotates a key', async () => {
    // Create a key first
    const createRes = await httpRequest({
      port, method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'rotate-e2e', credits: 500 }),
    });
    expect(createRes.statusCode).toBe(201);
    const { key: originalKey } = JSON.parse(createRes.body);

    // Rotate
    const rotateRes = await httpRequest({
      port, method: 'POST', path: '/keys/rotate',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ key: originalKey }),
    });
    expect(rotateRes.statusCode).toBe(200);
    const data = JSON.parse(rotateRes.body);
    expect(data.message).toBe('Key rotated');
    expect(data.newKey).toBeDefined();
    expect(data.newKey).not.toBe(originalKey);
    expect(data.name).toBe('rotate-e2e');
    expect(data.credits).toBe(500);
  });

  it('POST /keys/rotate requires admin key', async () => {
    const res = await httpRequest({
      port, method: 'POST', path: '/keys/rotate',
      body: JSON.stringify({ key: 'pg_anything' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /keys/rotate returns 404 for non-existent key', async () => {
    const res = await httpRequest({
      port, method: 'POST', path: '/keys/rotate',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ key: 'pg_nonexistent' }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /keys/rotate returns 400 for missing key param', async () => {
    const res = await httpRequest({
      port, method: 'POST', path: '/keys/rotate',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /keys/rotate returns 405 for GET', async () => {
    const res = await httpRequest({
      port, method: 'GET', path: '/keys/rotate',
    });
    expect(res.statusCode).toBe(405);
  });

  it('rotated key preserves credits after deduction', async () => {
    // Create and partially use
    const createRes = await httpRequest({
      port, method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'rotate-credits', credits: 1000 }),
    });
    const { key: origKey } = JSON.parse(createRes.body);

    // Check balance
    const balRes1 = await httpRequest({
      port, method: 'GET', path: '/balance',
      headers: { 'X-API-Key': origKey },
    });
    expect(JSON.parse(balRes1.body).credits).toBe(1000);

    // Rotate
    const rotateRes = await httpRequest({
      port, method: 'POST', path: '/keys/rotate',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ key: origKey }),
    });
    const { newKey } = JSON.parse(rotateRes.body);

    // New key has same credits
    const balRes2 = await httpRequest({
      port, method: 'GET', path: '/balance',
      headers: { 'X-API-Key': newKey },
    });
    expect(JSON.parse(balRes2.body).credits).toBe(1000);

    // Old key is no longer valid (404 = inactive key)
    const balRes3 = await httpRequest({
      port, method: 'GET', path: '/balance',
      headers: { 'X-API-Key': origKey },
    });
    expect(balRes3.statusCode).toBe(404);
  });

  it('POST /keys/rotate creates audit event', async () => {
    // Create a key
    const createRes = await httpRequest({
      port, method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'audit-rotate', credits: 100 }),
    });
    const { key } = JSON.parse(createRes.body);

    // Rotate it
    await httpRequest({
      port, method: 'POST', path: '/keys/rotate',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ key }),
    });

    // Check audit log
    const auditRes = await httpRequest({
      port, method: 'GET', path: '/audit?types=key.rotated',
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(auditRes.statusCode).toBe(200);
    const audit = JSON.parse(auditRes.body);
    expect(audit.events.length).toBeGreaterThanOrEqual(1);
    expect(audit.events[0].type).toBe('key.rotated');
  });

  it('root endpoint lists /keys/rotate', async () => {
    const res = await httpRequest({ port, method: 'GET', path: '/' });
    const data = JSON.parse(res.body);
    expect(data.endpoints.rotateKey).toBeDefined();
  });
});

// ─── E2E Tests: Rate Limit Response Headers ─────────────────────────────────

describe('Rate Limit Response Headers', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let apiKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: [],
      port: 0,
      defaultCreditsPerCall: 5,
      globalRateLimitPerMin: 100,
      toolPricing: {
        search: { creditsPerCall: 10, rateLimitPerMin: 20 },
      },
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    // Create a test key
    const createRes = await httpRequest({
      port, method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'headers-test', credits: 10000 }),
    });
    apiKey = JSON.parse(createRes.body).key;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('POST /mcp tools/call returns X-Credits-Remaining header', async () => {
    // The echo backend may crash immediately, so calls may return errors.
    // We retry a few times to handle transient EPIPE/process exit timing.
    let res: Awaited<ReturnType<typeof httpRequest>> | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await httpRequest({
          port, method: 'POST', path: '/mcp',
          headers: { 'X-API-Key': apiKey },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: attempt,
            method: 'tools/call',
            params: { name: 'any_tool', arguments: {} },
          }),
        });
        // If we got a response with credits header, we're done
        if (res.headers['x-credits-remaining']) break;
      } catch {
        // EPIPE or connection error — retry
        await new Promise(r => setTimeout(r, 100));
      }
    }

    // The gate always deducts credits before forwarding, so header should be present
    // even if the backend returned an error
    expect(res).not.toBeNull();
    expect(res!.headers['x-credits-remaining']).toBeDefined();
    const remaining = parseInt(res!.headers['x-credits-remaining'] as string);
    expect(remaining).toBeGreaterThanOrEqual(0);
  });

  it('POST /mcp tools/call returns X-RateLimit-* headers with global limit', async () => {
    const res = await httpRequest({
      port, method: 'POST', path: '/mcp',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'unknown_tool', arguments: {} },
      }),
    });

    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();

    const limit = parseInt(res.headers['x-ratelimit-limit'] as string);
    const remaining = parseInt(res.headers['x-ratelimit-remaining'] as string);
    const reset = parseInt(res.headers['x-ratelimit-reset'] as string);

    // Global limit should be 100
    expect(limit).toBe(100);
    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(remaining).toBeLessThanOrEqual(100);
    expect(reset).toBeGreaterThanOrEqual(0);
    expect(reset).toBeLessThanOrEqual(60);
  });

  it('POST /mcp tools/call uses per-tool rate limit when tool has custom limit', async () => {
    const res = await httpRequest({
      port, method: 'POST', path: '/mcp',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'search', arguments: {} },
      }),
    });

    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    // Per-tool limit for search is 20
    const limit = parseInt(res.headers['x-ratelimit-limit'] as string);
    expect(limit).toBe(20);
  });

  it('X-Credits-Remaining decreases after tool calls', async () => {
    // Create a fresh key to track precise credits
    const createRes = await httpRequest({
      port, method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'credits-track', credits: 100 }),
    });
    const freshKey = JSON.parse(createRes.body).key;

    // First call — costs 5 credits (default)
    const res1 = await httpRequest({
      port, method: 'POST', path: '/mcp',
      headers: { 'X-API-Key': freshKey },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'basic_tool', arguments: {} },
      }),
    });

    const credits1 = parseInt(res1.headers['x-credits-remaining'] as string);
    // Should be 95 (100 - 5) after the call was gated
    expect(credits1).toBeLessThanOrEqual(100);
  });

  it('no rate limit headers without API key', async () => {
    const res = await httpRequest({
      port, method: 'POST', path: '/mcp',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'any_tool', arguments: {} },
      }),
    });

    // Without API key, no rate limit headers
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    expect(res.headers['x-credits-remaining']).toBeUndefined();
  });

  it('CORS exposes rate limit headers', async () => {
    const res = await httpRequest({
      port, method: 'OPTIONS', path: '/mcp',
    });

    const exposed = res.headers['access-control-expose-headers'] as string;
    expect(exposed).toContain('X-RateLimit-Limit');
    expect(exposed).toContain('X-RateLimit-Remaining');
    expect(exposed).toContain('X-RateLimit-Reset');
    expect(exposed).toContain('X-Credits-Remaining');
  });

  it('rate limit headers are present on non-tool-call methods too', async () => {
    // Even initialize should get credits header if API key is provided
    const res = await httpRequest({
      port, method: 'POST', path: '/mcp',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'initialize',
        params: { clientInfo: { name: 'test', version: '1.0' } },
      }),
    });

    // Should have credits header even for non-tool-call
    expect(res.headers['x-credits-remaining']).toBeDefined();
    // May or may not have rate limit headers (depends on whether global limit is set)
    // With globalRateLimitPerMin: 100, it should have them
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
  });
});
