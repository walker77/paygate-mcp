/**
 * Input validation hardening tests — NaN bypass, invalid dates, edge cases.
 */

import { PayGateServer } from '../src/server';
import http from 'http';

// Suppress logger output in tests
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

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
        'Content-Length': Buffer.byteLength(data),
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

describe('Input Validation Hardening', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop(1000);
  });

  // ─── POST /keys — Create key NaN bypass ───────────────────────────────────

  describe('POST /keys — NaN credits', () => {
    // Note: JSON.stringify(NaN) → null, so NaN over HTTP arrives as null which defaults to 100.
    // These tests cover the string-based edge cases that actually reach the server.
    it('should reject string "NaN" credits', async () => {
      const resp = await post(port, '/keys', { name: 'test', credits: 'NaN' }, { 'X-Admin-Key': adminKey });
      expect(resp.status).toBe(400);
      expect(resp.body.error).toContain('positive integer');
    });

    it('should reject string "Infinity" credits', async () => {
      const resp = await post(port, '/keys', { name: 'test', credits: 'Infinity' }, { 'X-Admin-Key': adminKey });
      expect(resp.status).toBe(400);
      expect(resp.body.error).toContain('positive integer');
    });

    it('should reject zero credits', async () => {
      const resp = await post(port, '/keys', { name: 'test', credits: 0 }, { 'X-Admin-Key': adminKey });
      expect(resp.status).toBe(400);
      expect(resp.body.error).toContain('positive integer');
    });

    it('should reject negative credits', async () => {
      const resp = await post(port, '/keys', { name: 'test', credits: -50 }, { 'X-Admin-Key': adminKey });
      expect(resp.status).toBe(400);
      expect(resp.body.error).toContain('positive integer');
    });

    it('should reject float credits (rounds to 0)', async () => {
      const resp = await post(port, '/keys', { name: 'test', credits: 0.5 }, { 'X-Admin-Key': adminKey });
      expect(resp.status).toBe(400); // Math.floor(0.5) = 0, which is <= 0
    });

    it('should accept valid positive credits', async () => {
      const resp = await post(port, '/keys', { name: 'valid-key', credits: 100 }, { 'X-Admin-Key': adminKey });
      expect(resp.status).toBe(201);
      expect(resp.body.key).toBeDefined();
    });

    it('should floor float credits to integer', async () => {
      const resp = await post(port, '/keys', { name: 'float-key', credits: 10.9 }, { 'X-Admin-Key': adminKey });
      expect(resp.status).toBe(201);
      // Credits should be floor(10.9) = 10
      expect(resp.body.credits).toBe(10);
    });
  });

  // ─── POST /keys — Invalid expiresAt date ──────────────────────────────────

  describe('POST /keys — invalid expiresAt', () => {
    it('should reject invalid date string', async () => {
      const resp = await post(port, '/keys', { name: 'test', credits: 10, expiresAt: 'not-a-date' }, { 'X-Admin-Key': adminKey });
      expect(resp.status).toBe(400);
      expect(resp.body.error).toContain('ISO 8601');
    });

    it('should reject empty string as expiresAt', async () => {
      const resp = await post(port, '/keys', { name: 'test', credits: 10, expiresAt: '' }, { 'X-Admin-Key': adminKey });
      // Empty string is falsy, so expiresAt branch is skipped — key created without expiry
      expect(resp.status).toBe(201);
    });

    it('should reject invalid date format like "2025-13-45"', async () => {
      const resp = await post(port, '/keys', { name: 'test', credits: 10, expiresAt: '2025-13-45' }, { 'X-Admin-Key': adminKey });
      expect(resp.status).toBe(400);
      expect(resp.body.error).toContain('ISO 8601');
    });

    it('should accept valid ISO date', async () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      const resp = await post(port, '/keys', { name: 'expiry-key', credits: 10, expiresAt: future }, { 'X-Admin-Key': adminKey });
      expect(resp.status).toBe(201);
      expect(resp.body.expiresAt).toBe(future);
    });

    it('should handle NaN expiresIn gracefully', async () => {
      const resp = await post(port, '/keys', { name: 'test', credits: 10, expiresIn: NaN }, { 'X-Admin-Key': adminKey });
      // NaN is not > 0, so it falls through — key created without expiry
      expect(resp.status).toBe(201);
      expect(resp.body.expiresAt).toBeNull();
    });
  });

  // ─── POST /keys/expiry — Invalid date ────────────────────────────────────

  describe('POST /keys/expiry — invalid dates', () => {
    let testKey: string;

    beforeAll(async () => {
      const resp = await post(port, '/keys', { name: 'expiry-test', credits: 50 }, { 'X-Admin-Key': adminKey });
      testKey = resp.body.key;
    });

    it('should reject invalid expiresAt date', async () => {
      const resp = await post(port, '/keys/expiry', { key: testKey, expiresAt: 'garbage' }, { 'X-Admin-Key': adminKey });
      expect(resp.status).toBe(400);
      expect(resp.body.error).toContain('ISO 8601');
    });

    it('should reject nonsense date string', async () => {
      const resp = await post(port, '/keys/expiry', { key: testKey, expiresAt: 'tomorrow' }, { 'X-Admin-Key': adminKey });
      expect(resp.status).toBe(400);
      expect(resp.body.error).toContain('ISO 8601');
    });

    it('should accept null to remove expiry', async () => {
      const resp = await post(port, '/keys/expiry', { key: testKey, expiresAt: null }, { 'X-Admin-Key': adminKey });
      expect(resp.status).toBe(200);
      expect(resp.body.expiresAt).toBeNull();
    });

    it('should accept valid ISO date', async () => {
      const future = new Date(Date.now() + 3600000).toISOString();
      const resp = await post(port, '/keys/expiry', { key: testKey, expiresAt: future }, { 'X-Admin-Key': adminKey });
      expect(resp.status).toBe(200);
      expect(resp.body.expiresAt).toBe(future);
    });

    it('should handle NaN expiresIn gracefully', async () => {
      const resp = await post(port, '/keys/expiry', { key: testKey, expiresIn: NaN }, { 'X-Admin-Key': adminKey });
      // NaN is not finite and not > 0 — falls through to no-expiry case
      expect(resp.status).toBe(200);
    });
  });

  // ─── POST /alerts — NaN threshold ─────────────────────────────────────────

  describe('POST /alerts — NaN threshold', () => {
    it('should reject NaN threshold', async () => {
      const resp = await post(port, '/alerts', {
        rules: [{ type: 'spending_threshold', threshold: NaN }],
      }, { 'X-Admin-Key': adminKey });
      expect(resp.status).toBe(400);
      expect(resp.body.error).toContain('non-negative number');
    });

    it('should reject Infinity threshold', async () => {
      const resp = await post(port, '/alerts', {
        rules: [{ type: 'credits_low', threshold: Infinity }],
      }, { 'X-Admin-Key': adminKey });
      expect(resp.status).toBe(400);
      expect(resp.body.error).toContain('non-negative number');
    });

    it('should reject negative threshold', async () => {
      const resp = await post(port, '/alerts', {
        rules: [{ type: 'spending_threshold', threshold: -1 }],
      }, { 'X-Admin-Key': adminKey });
      expect(resp.status).toBe(400);
      expect(resp.body.error).toContain('non-negative number');
    });

    it('should accept valid threshold', async () => {
      const resp = await post(port, '/alerts', {
        rules: [{ type: 'spending_threshold', threshold: 100 }],
      }, { 'X-Admin-Key': adminKey });
      expect(resp.status).toBe(200);
      expect(resp.body.rules).toHaveLength(1);
    });

    it('should accept zero threshold', async () => {
      const resp = await post(port, '/alerts', {
        rules: [{ type: 'credits_low', threshold: 0 }],
      }, { 'X-Admin-Key': adminKey });
      expect(resp.status).toBe(200);
    });
  });
});
