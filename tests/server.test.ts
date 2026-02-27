import { createServer, Server } from 'http';
import { PayGateServer } from '../src/server';

// Mock the proxy to avoid spawning real processes
jest.mock('../src/proxy', () => {
  return {
    McpProxy: jest.fn().mockImplementation(() => ({
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      handleRequest: jest.fn().mockImplementation(async (request: any, _apiKey: string | null) => {
        // Echo back the request method as result
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: { echo: request.method },
        };
      }),
      isRunning: true,
      on: jest.fn(),
      emit: jest.fn(),
    })),
  };
});

describe('PayGateServer (HTTP)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0, // Random port
    });

    // We need a real port — find one
    port = 3499 + Math.floor(Math.random() * 100);
    (server as any).config.port = port;

    const result = await server.start();
    port = result.port;
    adminKey = result.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  function request(path: string, options: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {}): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const http = require('http');
      const req = http.request({
        hostname: 'localhost',
        port,
        path,
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      }, (res: any) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });
      req.on('error', reject);
      if (options.body) {
        req.write(JSON.stringify(options.body));
      }
      req.end();
    });
  }

  describe('GET /', () => {
    it('should return server info', async () => {
      const res = await request('/');
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('PayGate MCP Server');
      expect(res.body.endpoints).toBeDefined();
    });
  });

  describe('POST /keys', () => {
    it('should require admin key', async () => {
      const res = await request('/keys', {
        method: 'POST',
        body: { name: 'test', credits: 100 },
      });
      expect(res.status).toBe(401);
    });

    it('should create API key with admin auth', async () => {
      const res = await request('/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'client-1', credits: 500 },
      });
      expect(res.status).toBe(201);
      expect(res.body.key).toMatch(/^pg_/);
      expect(res.body.credits).toBe(500);
    });
  });

  describe('GET /keys', () => {
    it('should list keys with admin auth', async () => {
      const res = await request('/keys', {
        headers: { 'X-Admin-Key': adminKey },
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('GET /status', () => {
    it('should return status with admin auth', async () => {
      const res = await request('/status', {
        headers: { 'X-Admin-Key': adminKey },
      });
      expect(res.status).toBe(200);
      expect(res.body.name).toBeDefined();
      expect(res.body.activeKeys).toBeDefined();
    });

    it('should deny without admin key', async () => {
      const res = await request('/status');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /topup', () => {
    it('should add credits to a key', async () => {
      // First create a key
      const createRes = await request('/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'topup-test', credits: 10 },
      });
      const key = createRes.body.key;

      const res = await request('/topup', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { key, credits: 50 },
      });
      expect(res.status).toBe(200);
      expect(res.body.credits).toBe(60);
    });

    it('should reject missing params', async () => {
      const res = await request('/topup', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: {},
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /mcp', () => {
    it('should forward JSON-RPC requests', async () => {
      const res = await request('/mcp', {
        method: 'POST',
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.jsonrpc).toBe('2.0');
    });

    it('should reject non-POST', async () => {
      const res = await request('/mcp');
      expect(res.status).toBe(405);
    });

    it('should reject invalid JSON', async () => {
      return new Promise((resolve, reject) => {
        const http = require('http');
        const req = http.request({
          hostname: 'localhost',
          port,
          path: '/mcp',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, (res: any) => {
          let data = '';
          res.on('data', (chunk: string) => { data += chunk; });
          res.on('end', () => {
            const body = JSON.parse(data);
            expect(res.statusCode).toBe(400);
            expect(body.error.code).toBe(-32700);
            resolve(undefined);
          });
        });
        req.on('error', reject);
        req.write('not json at all');
        req.end();
      });
    });
  });

  // ─── /balance — Client self-service ──────────────────────────────────────

  describe('GET /balance', () => {
    let clientKey: string;

    beforeAll(async () => {
      const res = await request('/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'balance-client', credits: 250 },
      });
      clientKey = res.body.key;
    });

    it('should return balance for valid API key', async () => {
      const res = await request('/balance', {
        headers: { 'X-API-Key': clientKey },
      });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('balance-client');
      expect(res.body.credits).toBe(250);
      expect(res.body.totalSpent).toBe(0);
      expect(res.body.totalCalls).toBe(0);
      expect(res.body.lastUsedAt).toBeNull();
    });

    it('should NOT expose the full API key', async () => {
      const res = await request('/balance', {
        headers: { 'X-API-Key': clientKey },
      });
      expect(res.status).toBe(200);
      // Response should NOT contain the full key
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(clientKey);
    });

    it('should reject missing API key', async () => {
      const res = await request('/balance');
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Missing');
    });

    it('should reject invalid API key', async () => {
      const res = await request('/balance', {
        headers: { 'X-API-Key': 'pg_nonexistent_000000' },
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toContain('Invalid');
    });

    it('should reject revoked key', async () => {
      // Create and revoke a key
      const create = await request('/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'revoked-balance', credits: 100 },
      });
      await request('/keys/revoke', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { key: create.body.key },
      });

      const res = await request('/balance', {
        headers: { 'X-API-Key': create.body.key },
      });
      expect(res.status).toBe(404);
    });

    it('should reject non-GET methods', async () => {
      const res = await request('/balance', {
        method: 'POST',
        headers: { 'X-API-Key': clientKey },
        body: {},
      });
      expect(res.status).toBe(405);
    });
  });

  // ─── /keys/revoke — Admin key revocation ────────────────────────────────────

  describe('POST /keys/revoke', () => {
    it('should revoke an existing key', async () => {
      const create = await request('/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'revoke-target', credits: 100 },
      });
      const key = create.body.key;

      const res = await request('/keys/revoke', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { key },
      });
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('revoked');

      // Verify key is now inactive
      const balance = await request('/balance', {
        headers: { 'X-API-Key': key },
      });
      expect(balance.status).toBe(404);
    });

    it('should require admin key', async () => {
      const res = await request('/keys/revoke', {
        method: 'POST',
        body: { key: 'pg_anything' },
      });
      expect(res.status).toBe(401);
    });

    it('should reject missing key param', async () => {
      const res = await request('/keys/revoke', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: {},
      });
      expect(res.status).toBe(400);
    });

    it('should 404 for nonexistent key', async () => {
      const res = await request('/keys/revoke', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { key: 'pg_nonexistent_key_000000' },
      });
      expect(res.status).toBe(404);
    });

    it('should reject non-POST', async () => {
      const res = await request('/keys/revoke', {
        headers: { 'X-Admin-Key': adminKey },
      });
      expect(res.status).toBe(405);
    });
  });

  // ─── /usage — Admin usage export ────────────────────────────────────────

  describe('GET /usage', () => {
    it('should return usage events as JSON', async () => {
      const res = await request('/usage', {
        headers: { 'X-Admin-Key': adminKey },
      });
      expect(res.status).toBe(200);
      expect(res.body.count).toBeDefined();
      expect(res.body.since).toBe('all');
      expect(Array.isArray(res.body.events)).toBe(true);
    });

    it('should require admin key', async () => {
      const res = await request('/usage');
      expect(res.status).toBe(401);
    });

    it('should mask API keys in JSON output', async () => {
      // Make a tool call to generate usage data first
      const create = await request('/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'usage-test', credits: 100 },
      });
      const key = create.body.key;

      // Call a tool to generate a usage event
      await request('/mcp', {
        method: 'POST',
        headers: { 'X-API-Key': key },
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'test-tool' },
        },
      });

      const res = await request('/usage', {
        headers: { 'X-Admin-Key': adminKey },
      });
      expect(res.status).toBe(200);

      // Check that events have masked keys
      if (res.body.events.length > 0) {
        for (const event of res.body.events) {
          expect(event.apiKey).toContain('...');
          expect(event.apiKey.length).toBeLessThan(20);
        }
      }
    });

    it('should support CSV format', async () => {
      return new Promise((resolve, reject) => {
        const http = require('http');
        const req = http.request({
          hostname: 'localhost',
          port,
          path: '/usage?format=csv',
          method: 'GET',
          headers: {
            'X-Admin-Key': adminKey,
          },
        }, (res: any) => {
          let data = '';
          res.on('data', (chunk: string) => { data += chunk; });
          res.on('end', () => {
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/csv');
            expect(res.headers['content-disposition']).toContain('paygate-usage.csv');
            // First line should be the CSV header
            const lines = data.split('\n');
            expect(lines[0]).toContain('timestamp');
            expect(lines[0]).toContain('apiKey');
            expect(lines[0]).toContain('tool');
            resolve(undefined);
          });
        });
        req.on('error', reject);
        req.end();
      });
    });

    it('should support since filter', async () => {
      // Use a future date to get zero results
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      return new Promise((resolve, reject) => {
        const http = require('http');
        const req = http.request({
          hostname: 'localhost',
          port,
          path: `/usage?since=${encodeURIComponent(futureDate)}`,
          method: 'GET',
          headers: {
            'X-Admin-Key': adminKey,
            'Content-Type': 'application/json',
          },
        }, (res: any) => {
          let data = '';
          res.on('data', (chunk: string) => { data += chunk; });
          res.on('end', () => {
            const body = JSON.parse(data);
            expect(res.statusCode).toBe(200);
            expect(body.count).toBe(0);
            expect(body.events).toEqual([]);
            resolve(undefined);
          });
        });
        req.on('error', reject);
        req.end();
      });
    });

    it('should reject non-GET', async () => {
      const res = await request('/usage', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: {},
      });
      expect(res.status).toBe(405);
    });
  });

  // ─── /stripe/webhook — Stripe integration ────────────────────────────────

  describe('POST /stripe/webhook', () => {
    it('should return 404 when stripe is not configured', async () => {
      const res = await request('/stripe/webhook', {
        method: 'POST',
        body: { type: 'checkout.session.completed' },
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not configured');
    });
  });

  // ─── /dashboard — Admin web UI ──────────────────────────────────────────

  describe('GET /dashboard', () => {
    it('should return HTML', async () => {
      return new Promise((resolve, reject) => {
        const http = require('http');
        const req = http.request({
          hostname: 'localhost',
          port,
          path: '/dashboard',
          method: 'GET',
        }, (res: any) => {
          let data = '';
          res.on('data', (chunk: string) => { data += chunk; });
          res.on('end', () => {
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/html');
            expect(data).toContain('PayGate Dashboard');
            expect(data).toContain('admin-key-input');
            resolve(undefined);
          });
        });
        req.on('error', reject);
        req.end();
      });
    });

    it('should include the server name in the dashboard', async () => {
      return new Promise((resolve, reject) => {
        const http = require('http');
        const req = http.request({
          hostname: 'localhost',
          port,
          path: '/dashboard',
          method: 'GET',
        }, (res: any) => {
          let data = '';
          res.on('data', (chunk: string) => { data += chunk; });
          res.on('end', () => {
            expect(data).toContain('PayGate MCP Server');
            resolve(undefined);
          });
        });
        req.on('error', reject);
        req.end();
      });
    });

    it('should NOT expose admin key in dashboard HTML', async () => {
      return new Promise((resolve, reject) => {
        const http = require('http');
        const req = http.request({
          hostname: 'localhost',
          port,
          path: '/dashboard',
          method: 'GET',
        }, (res: any) => {
          let data = '';
          res.on('data', (chunk: string) => { data += chunk; });
          res.on('end', () => {
            expect(data).not.toContain(adminKey);
            resolve(undefined);
          });
        });
        req.on('error', reject);
        req.end();
      });
    });

    it('should not require authentication (auth is done client-side)', async () => {
      const res = await request('/dashboard');
      // request helper tries to JSON.parse, which will fail on HTML
      // but status should still be 200
      expect(res.status).toBe(200);
    });
  });

  describe('CORS', () => {
    it('should handle OPTIONS preflight', async () => {
      const res = await request('/mcp', { method: 'OPTIONS' });
      expect(res.status).toBe(204);
    });
  });

  describe('404', () => {
    it('should return 404 for unknown paths', async () => {
      const res = await request('/unknown');
      expect(res.status).toBe(404);
    });
  });
});
