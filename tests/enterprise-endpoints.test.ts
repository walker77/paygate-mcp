/**
 * Tests for v0.8.0 Enterprise HTTP Endpoints.
 * Covers: POST /keys/acl, POST /keys/expiry, and enhanced POST /keys.
 */

import { PayGateServer } from '../src/server';
import * as http from 'http';
import * as path from 'path';

const MOCK_SERVER = path.join(__dirname, 'e2e', 'mock-mcp-server.js');

function httpRequest(port: number, reqPath: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
} = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port,
      path: reqPath,
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...options.headers },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode!, body: data });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

describe('Enterprise Endpoints (v0.8.0)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    port = 3500 + Math.floor(Math.random() * 100);
    server = new PayGateServer({
      serverCommand: 'node',
      serverArgs: [MOCK_SERVER],
      port,
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 100,
      name: 'Enterprise Test',
      toolPricing: {
        'premium': { creditsPerCall: 5, rateLimitPerMin: 3 },
      },
    });

    const result = await server.start();
    port = result.port;
    adminKey = result.adminKey;
    await new Promise(r => setTimeout(r, 300));
  }, 15000);

  afterAll(async () => {
    await server.stop();
  }, 10000);

  describe('POST /keys — Enhanced with ACL/Expiry', () => {
    it('should create key with allowedTools', async () => {
      const res = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'acl-key', credits: 100, allowedTools: ['search', 'generate'] },
      });
      expect(res.status).toBe(201);
      expect(res.body.allowedTools).toEqual(['search', 'generate']);
      expect(res.body.deniedTools).toEqual([]);
    });

    it('should create key with deniedTools', async () => {
      const res = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'deny-key', credits: 100, deniedTools: ['admin', 'delete'] },
      });
      expect(res.status).toBe(201);
      expect(res.body.deniedTools).toEqual(['admin', 'delete']);
    });

    it('should create key with expiresIn (seconds)', async () => {
      const res = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'ttl-key', credits: 100, expiresIn: 3600 },
      });
      expect(res.status).toBe(201);
      expect(res.body.expiresAt).toBeTruthy();
      const expiry = new Date(res.body.expiresAt).getTime();
      const now = Date.now();
      // Should expire roughly 1 hour from now (allow 10s tolerance)
      expect(expiry).toBeGreaterThan(now + 3500000);
      expect(expiry).toBeLessThan(now + 3700000);
    });

    it('should create key with expiresAt (ISO date)', async () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      const res = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'date-key', credits: 100, expiresAt: future },
      });
      expect(res.status).toBe(201);
      expect(res.body.expiresAt).toBe(future);
    });
  });

  describe('POST /keys/acl', () => {
    let testKey: string;

    beforeAll(async () => {
      const res = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'acl-target', credits: 100 },
      });
      testKey = res.body.key;
    });

    it('should set allowedTools', async () => {
      const res = await httpRequest(port, '/keys/acl', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { key: testKey, allowedTools: ['search'] },
      });
      expect(res.status).toBe(200);
      expect(res.body.allowedTools).toEqual(['search']);
      expect(res.body.message).toBe('ACL updated');
    });

    it('should set deniedTools', async () => {
      const res = await httpRequest(port, '/keys/acl', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { key: testKey, deniedTools: ['admin'] },
      });
      expect(res.status).toBe(200);
      expect(res.body.deniedTools).toEqual(['admin']);
    });

    it('should require admin key', async () => {
      const res = await httpRequest(port, '/keys/acl', {
        method: 'POST',
        body: { key: testKey, allowedTools: ['everything'] },
      });
      expect(res.status).toBe(401);
    });

    it('should reject invalid key', async () => {
      const res = await httpRequest(port, '/keys/acl', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { key: 'invalid', allowedTools: ['search'] },
      });
      expect(res.status).toBe(404);
    });

    it('should reject missing key field', async () => {
      const res = await httpRequest(port, '/keys/acl', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { allowedTools: ['search'] },
      });
      expect(res.status).toBe(400);
    });

    it('should reject GET method', async () => {
      const res = await httpRequest(port, '/keys/acl', {
        method: 'GET',
        headers: { 'X-Admin-Key': adminKey },
      });
      expect(res.status).toBe(405);
    });
  });

  describe('POST /keys/expiry', () => {
    let testKey: string;

    beforeAll(async () => {
      const res = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'expiry-target', credits: 100 },
      });
      testKey = res.body.key;
    });

    it('should set expiry via expiresIn', async () => {
      const res = await httpRequest(port, '/keys/expiry', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { key: testKey, expiresIn: 7200 },
      });
      expect(res.status).toBe(200);
      expect(res.body.expiresAt).toBeTruthy();
      expect(res.body.message).toContain('Key expires at');
    });

    it('should set expiry via expiresAt', async () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      const res = await httpRequest(port, '/keys/expiry', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { key: testKey, expiresAt: future },
      });
      expect(res.status).toBe(200);
      expect(res.body.expiresAt).toBe(future);
    });

    it('should remove expiry when set to null', async () => {
      const res = await httpRequest(port, '/keys/expiry', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { key: testKey, expiresAt: null },
      });
      expect(res.status).toBe(200);
      expect(res.body.expiresAt).toBeNull();
      expect(res.body.message).toContain('never expires');
    });

    it('should require admin key', async () => {
      const res = await httpRequest(port, '/keys/expiry', {
        method: 'POST',
        body: { key: testKey, expiresIn: 3600 },
      });
      expect(res.status).toBe(401);
    });

    it('should reject invalid key', async () => {
      const res = await httpRequest(port, '/keys/expiry', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { key: 'invalid', expiresIn: 3600 },
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /balance — Enhanced', () => {
    it('should return ACL and expiry info', async () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      const createRes = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: {
          name: 'full-info',
          credits: 100,
          allowedTools: ['search'],
          deniedTools: ['admin'],
          expiresAt: future,
        },
      });
      const key = createRes.body.key;

      const balanceRes = await httpRequest(port, '/balance', {
        method: 'GET',
        headers: { 'X-API-Key': key },
      });
      expect(balanceRes.status).toBe(200);
      expect(balanceRes.body.allowedTools).toEqual(['search']);
      expect(balanceRes.body.deniedTools).toEqual(['admin']);
      expect(balanceRes.body.expiresAt).toBe(future);
    });
  });

  describe('Root endpoint — Updated', () => {
    it('should list new endpoints', async () => {
      const res = await httpRequest(port, '/', { method: 'GET' });
      expect(res.status).toBe(200);
      expect(res.body.endpoints.setAcl).toBeTruthy();
      expect(res.body.endpoints.setExpiry).toBeTruthy();
    });
  });
});
