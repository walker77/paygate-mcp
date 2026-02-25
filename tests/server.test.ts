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
    await server.stop();
  });

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
