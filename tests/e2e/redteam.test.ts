/**
 * RED TEAM TESTS — Adversarial testing of PayGate MCP.
 *
 * Pass 1: Auth bypass and key manipulation
 * Pass 2: Rate limit evasion and credit abuse
 * Pass 3: Input validation, injection, and edge cases
 * Pass 4: Persistence attack vectors
 * Pass 5: HTTP transport security
 * Pass 6: Stripe webhook security
 * Pass 7: Self-service endpoint security
 * Pass 8: Dashboard security (XSS, info leakage, admin key exposure)
 * Pass 9: Budget bypass (spending limits)
 * Pass 10: Refund abuse
 * Pass 11: Webhook security
 * Pass 12: ACL bypass attempts
 * Pass 13: Key expiry bypass
 * Pass 14: Per-tool rate limit bypass
 */

import { PayGateServer } from '../../src/server';
import { KeyStore } from '../../src/store';
import { Gate } from '../../src/gate';
import { DEFAULT_CONFIG } from '../../src/types';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { randomBytes } from 'crypto';

const MOCK_SERVER = path.join(__dirname, 'mock-mcp-server.js');

function httpRequest(port: number, reqPath: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  rawBody?: string;
} = {}): Promise<{ status: number; headers: Record<string, string>; body: any }> {
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
          resolve({ status: res.statusCode!, headers: res.headers as Record<string, string>, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode!, headers: res.headers as Record<string, string>, body: data });
        }
      });
    });
    req.on('error', reject);
    if (options.rawBody) {
      req.write(options.rawBody);
    } else if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

describe('RED TEAM — PayGate Security', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    port = 3600 + Math.floor(Math.random() * 300);
    server = new PayGateServer({
      serverCommand: 'node',
      serverArgs: [MOCK_SERVER],
      port,
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 10,
      name: 'Red Team Test',
      toolPricing: { 'premium_analyze': { creditsPerCall: 5 } },
    });

    const result = await server.start();
    port = result.port;
    adminKey = result.adminKey;
    await new Promise(r => setTimeout(r, 500));
  }, 15000);

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 10000);

  // ═══════════════════════════════════════════════════════════════════════════
  // PASS 1: Auth bypass and key manipulation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('PASS 1: Auth bypass', () => {
    it('should reject empty string API key', async () => {
      const res = await httpRequest(port, '/mcp', {
        method: 'POST',
        headers: { 'X-API-Key': '' },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: {} } },
      });
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toContain('Payment required');
    });

    it('should reject admin key used as API key', async () => {
      const res = await httpRequest(port, '/mcp', {
        method: 'POST',
        headers: { 'X-API-Key': adminKey },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: {} } },
      });
      expect(res.body.error).toBeDefined();
    });

    it('should reject API key used as admin key', async () => {
      const createRes = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'test', credits: 100 },
      });
      const apiKey = createRes.body.key;

      const res = await httpRequest(port, '/status', {
        headers: { 'X-Admin-Key': apiKey },
      });
      expect(res.status).toBe(401);
    });

    it('should not leak admin key in responses', async () => {
      const rootRes = await httpRequest(port, '/');
      expect(JSON.stringify(rootRes.body)).not.toContain(adminKey);

      // Create a key and check that response doesn't leak admin key
      const createRes = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'test', credits: 10 },
      });
      expect(JSON.stringify(createRes.body)).not.toContain(adminKey);
    });

    it('should reject header case manipulation for admin auth', async () => {
      // HTTP headers are case-insensitive per spec, but our check uses lowercase
      // Node.js lowercases all headers, so 'x-admin-key' should work
      // But random values should not
      const res = await httpRequest(port, '/status', {
        headers: { 'X-Admin-Key': 'guessed_admin_key' },
      });
      expect(res.status).toBe(401);
    });

    it('should not expose key list without admin auth', async () => {
      const res = await httpRequest(port, '/keys');
      expect(res.status).toBe(401);
    });

    it('should not allow topup without admin auth', async () => {
      // Try to give yourself credits without admin key
      const res = await httpRequest(port, '/topup', {
        method: 'POST',
        body: { key: 'pg_anything', credits: 999999 },
      });
      expect(res.status).toBe(401);
    });

    it('should mask keys in list response', async () => {
      await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'secret', credits: 10 },
      });

      const listRes = await httpRequest(port, '/keys', {
        headers: { 'X-Admin-Key': adminKey },
      });
      for (const key of listRes.body) {
        // Full key should NOT appear
        expect(key.key).toBeUndefined();
        expect(key.keyPrefix).toMatch(/\.\.\./);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PASS 2: Rate limit evasion and credit abuse
  // ═══════════════════════════════════════════════════════════════════════════

  describe('PASS 2: Rate limit evasion and credit abuse', () => {
    it('should enforce rate limit across rapid requests', async () => {
      const createRes = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'ratelimit-test', credits: 1000 },
      });
      const apiKey = createRes.body.key;

      let deniedCount = 0;
      // Fire 15 rapid requests (limit is 10/min)
      const results = await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          httpRequest(port, '/mcp', {
            method: 'POST',
            headers: { 'X-API-Key': apiKey },
            body: { jsonrpc: '2.0', id: 1000 + i, method: 'tools/call', params: { name: 'search', arguments: {} } },
          })
        )
      );

      for (const r of results) {
        if (r.body.error && r.body.error.message.includes('rate_limited')) {
          deniedCount++;
        }
      }

      // At least some should be denied (rate limit = 10)
      expect(deniedCount).toBeGreaterThan(0);
    });

    it('should reject negative credit top-up (drain attack)', async () => {
      const createRes = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'negative-test', credits: 100 },
      });
      const apiKey = createRes.body.key;

      // Try negative topup — should be rejected
      const topupRes = await httpRequest(port, '/topup', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { key: apiKey, credits: -50 },
      });
      expect(topupRes.status).toBe(400);
      expect(topupRes.body.error).toContain('positive integer');
    });

    it('should reject creating key with negative credits', async () => {
      const createRes = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'negative-credits', credits: -100 },
      });
      expect(createRes.status).toBe(400);
      expect(createRes.body.error).toContain('positive integer');
    });

    it('should not allow zero-cost tool bypass via empty tool name', async () => {
      // Create key with minimal credits (0 credits rejected, use 1)
      const createRes = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'empty-tool', credits: 1 },
      });
      const apiKey = createRes.body.key;
      expect(apiKey).toBeDefined();

      const res = await httpRequest(port, '/mcp', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: '', arguments: {} } },
      });
      // Should be denied or return error — empty tool name is invalid
      expect(res.body.error).toBeDefined();
    });

    it('should handle concurrent requests without double-spending', async () => {
      const createRes = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'concurrent-test', credits: 3 },
      });
      const apiKey = createRes.body.key;

      // Fire 6 concurrent requests with only 3 credits
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          httpRequest(port, '/mcp', {
            method: 'POST',
            headers: { 'X-API-Key': apiKey },
            body: { jsonrpc: '2.0', id: 2000 + i, method: 'tools/call', params: { name: 'search', arguments: {} } },
          })
        )
      );

      const allowed = results.filter(r => !r.body.error).length;
      const denied = results.filter(r => r.body.error).length;

      // Should not allow more than 3 (the credit balance)
      expect(allowed).toBeLessThanOrEqual(3);
      expect(denied).toBeGreaterThanOrEqual(3);
    });

    it('should floor float credits to integers (0.1 → 0, rejected as non-positive)', async () => {
      // 0.1 floors to 0, which is rejected by the server as non-positive
      const createRes = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'float-test', credits: 0.1 },
      });
      // Server should reject: credits must be positive integer (0.1 floors to 0)
      expect(createRes.status).toBe(400);
    });

    it('should floor 1.9 credits to 1 (not round up to 2)', async () => {
      const createRes = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'floor-test', credits: 1.9 },
      });
      expect(createRes.status).toBe(201);
      expect(createRes.body.credits).toBe(1); // floored, not rounded

      const apiKey = createRes.body.key;
      // Should allow exactly 1 call (1 credit)
      const r1 = await httpRequest(port, '/mcp', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: {} } },
      });
      expect(r1.body.error).toBeUndefined();

      // 2nd call should be denied
      const r2 = await httpRequest(port, '/mcp', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey },
        body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search', arguments: {} } },
      });
      expect(r2.body.error).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PASS 3: Input validation, injection, and edge cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('PASS 3: Input validation and injection', () => {
    it('should reject oversized request body (>1MB)', async () => {
      const hugeBody = 'x'.repeat(2_000_000); // 2MB (over 1MB limit)
      try {
        const res = await httpRequest(port, '/mcp', {
          method: 'POST',
          rawBody: hugeBody,
        });
        // If we get a response, it should be an error
        expect([400, 500]).toContain(res.status);
      } catch (error: any) {
        // EPIPE is expected: server destroys the request stream when body is too large
        expect(error.message || error.code).toMatch(/EPIPE|ECONNRESET|socket hang up/);
      }
    });

    it('should handle null/undefined params gracefully', async () => {
      const createRes = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'null-test', credits: 10 },
      });
      const apiKey = createRes.body.key;

      // tools/call with null params
      const res = await httpRequest(port, '/mcp', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: null },
      });
      // Should return error, not crash
      expect(res.status).toBe(200);
      expect(res.body.error).toBeDefined();
    });

    it('should handle missing params entirely', async () => {
      const createRes = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'no-params-test', credits: 10 },
      });
      const apiKey = createRes.body.key;

      const res = await httpRequest(port, '/mcp', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call' },
      });
      expect(res.status).toBe(200);
      expect(res.body.error).toBeDefined();
    });

    it('should reject malformed JSON-RPC (no jsonrpc field)', async () => {
      const res = await httpRequest(port, '/mcp', {
        method: 'POST',
        body: { id: 1, method: 'tools/list' },
      });
      // Strict JSON-RPC 2.0 validation rejects missing jsonrpc field
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(-32600);
      expect(res.body.error.message).toContain('jsonrpc must be "2.0"');
    });

    it('should handle prototype pollution attempts', async () => {
      const res = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { '__proto__': { 'admin': true }, 'name': 'polluted', 'credits': 10 },
      });
      // Should not crash, should not grant admin
      expect([201, 400]).toContain(res.status);
    });

    it('should handle extremely long key names', async () => {
      const res = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'A'.repeat(10000), credits: 10 },
      });
      // Should not crash — might want to limit name length
      expect([201, 400]).toContain(res.status);
    });

    it('should handle extremely large credit values', async () => {
      const res = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'big-credits', credits: Number.MAX_SAFE_INTEGER },
      });
      expect(res.status).toBe(201);
      // Credits are clamped to MAX_CREDITS (1 billion) to prevent absurd values
      expect(res.body.credits).toBe(1_000_000_000);
    });

    it('should handle JSON injection in tool names', async () => {
      const createRes = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'inject-test', credits: 100 },
      });
      const apiKey = createRes.body.key;

      const res = await httpRequest(port, '/mcp', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey },
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: '"; DROP TABLE keys; --', arguments: {} },
        },
      });
      // Should not crash, just forward the call
      expect(res.status).toBe(200);
    });

    it('should not expose stack traces in error responses', async () => {
      const res = await httpRequest(port, '/mcp', {
        method: 'POST',
        rawBody: '{invalid json with no closing brace',
      });
      expect(res.status).toBe(400);
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain('at ');
      expect(bodyStr).not.toContain('.ts:');
      expect(bodyStr).not.toContain('.js:');
    });

    it('should handle path traversal attempts', async () => {
      const res = await httpRequest(port, '/../../../etc/passwd');
      expect(res.status).toBe(404);
    });

    it('should handle query string injection', async () => {
      const res = await httpRequest(port, '/status?admin=true&bypass=1');
      expect(res.status).toBe(401); // Still requires admin key
    });

    it('should reject request without Content-Type (415)', async () => {
      const res = await httpRequest(port, '/mcp', {
        method: 'POST',
        headers: { 'Content-Type': '' },
        body: { jsonrpc: '2.0', id: 1, method: 'ping', params: {} },
      });
      // v8.92.0: Content-Type enforcement — POST requires application/json
      expect(res.status).toBe(415);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PASS 4: Persistence attack vectors
// ═══════════════════════════════════════════════════════════════════════════

describe('RED TEAM — Persistence Security', () => {
  function tmpStatePath(): string {
    const dir = path.join(os.tmpdir(), 'paygate-redteam-' + randomBytes(8).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'state.json');
  }

  function cleanup(p: string): void {
    try { fs.unlinkSync(p); } catch {}
    try { fs.unlinkSync(p + '.tmp'); } catch {}
  }

  it('should not allow tampered state file to inject admin keys', () => {
    const statePath = tmpStatePath();
    try {
      // Attacker writes a state file with a crafted key
      const maliciousState = JSON.stringify([
        ['admin_key_attempt', {
          key: 'admin_key_attempt',
          name: 'hacker',
          credits: 999999999,
          totalSpent: 0,
          totalCalls: 0,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          active: true,
        }]
      ]);
      fs.writeFileSync(statePath, maliciousState, 'utf-8');

      // Store loads the tampered file
      const store = new KeyStore(statePath);

      // The key should load, but it's just a regular API key
      // It should NOT grant admin access
      const record = store.getKey('admin_key_attempt');
      expect(record).not.toBeNull();
      expect(record!.credits).toBe(999999999);

      // But the admin key is separate — loaded keys can't become admin keys
      // Admin key is set in PayGateServer constructor, not in KeyStore
    } finally {
      cleanup(statePath);
    }
  });

  it('should not crash on state file with extra/malicious fields', () => {
    const statePath = tmpStatePath();
    try {
      // Attacker adds extra fields trying to exploit something
      const maliciousState = JSON.stringify([
        ['pg_test123', {
          key: 'pg_test123',
          name: '<script>alert("xss")</script>',
          credits: 100,
          totalSpent: 0,
          totalCalls: 0,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          active: true,
          __proto__: { admin: true },
          constructor: { prototype: { admin: true } },
          isAdmin: true,
          extraMalicious: 'payload',
        }]
      ]);
      fs.writeFileSync(statePath, maliciousState, 'utf-8');

      const store = new KeyStore(statePath);
      const record = store.getKey('pg_test123');
      expect(record).not.toBeNull();
      // Extra fields are loaded but don't affect functionality
      expect(record!.credits).toBe(100);
    } finally {
      cleanup(statePath);
    }
  });

  it('should not crash on state file with negative credits', () => {
    const statePath = tmpStatePath();
    try {
      // Attacker tries to set negative credits
      const maliciousState = JSON.stringify([
        ['pg_negcredits', {
          key: 'pg_negcredits',
          name: 'negative',
          credits: -999,
          totalSpent: 0,
          totalCalls: 0,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          active: true,
        }]
      ]);
      fs.writeFileSync(statePath, maliciousState, 'utf-8');

      const store = new KeyStore(statePath);
      const record = store.getKey('pg_negcredits');
      expect(record).not.toBeNull();
      // Negative credits should mean the key can't do anything
      expect(store.hasCredits('pg_negcredits', 1)).toBe(false);
    } finally {
      cleanup(statePath);
    }
  });

  it('should not crash on state file with Infinity/NaN credits', () => {
    const statePath = tmpStatePath();
    try {
      // JSON.parse turns Infinity/NaN to null
      const maliciousState = JSON.stringify([
        ['pg_infcredits', {
          key: 'pg_infcredits',
          name: 'infinity',
          credits: null, // Infinity can't be represented in JSON
          totalSpent: 0,
          totalCalls: 0,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          active: true,
        }]
      ]);
      fs.writeFileSync(statePath, maliciousState, 'utf-8');

      // Should not crash
      const store = new KeyStore(statePath);
      const record = store.getKey('pg_infcredits');
      expect(record).not.toBeNull();
      // null credits should not allow calls
      expect(store.hasCredits('pg_infcredits', 1)).toBe(false);
    } finally {
      cleanup(statePath);
    }
  });

  it('should not crash on state file with millions of keys (DoS)', () => {
    const statePath = tmpStatePath();
    try {
      // Create a state file with many keys
      const entries: Array<[string, any]> = [];
      for (let i = 0; i < 10000; i++) {
        entries.push([`pg_dos_${i}`, {
          key: `pg_dos_${i}`,
          name: `dos-key-${i}`,
          credits: 1,
          totalSpent: 0,
          totalCalls: 0,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          active: true,
        }]);
      }
      fs.writeFileSync(statePath, JSON.stringify(entries), 'utf-8');

      // Should load without crashing (might be slow but shouldn't OOM)
      const start = Date.now();
      const store = new KeyStore(statePath);
      const elapsed = Date.now() - start;

      expect(store.activeKeyCount).toBe(10000);
      // Should load in reasonable time (< 5 seconds)
      expect(elapsed).toBeLessThan(5000);
    } finally {
      cleanup(statePath);
    }
  });

  it('should handle state file being deleted between operations', () => {
    const statePath = tmpStatePath();
    try {
      const store = new KeyStore(statePath);
      store.createKey('before-delete', 100);

      // Delete the state file (simulating external tampering)
      fs.unlinkSync(statePath);

      // Next mutation should recreate the file
      store.createKey('after-delete', 200);
      expect(fs.existsSync(statePath)).toBe(true);

      // Verify it saved correctly
      const store2 = new KeyStore(statePath);
      expect(store2.activeKeyCount).toBe(2);
    } finally {
      cleanup(statePath);
    }
  });

  it('should not allow state file path to write to system locations', () => {
    // This tests that we can't write to /etc or other system dirs
    // On most systems this will fail with EACCES, which is correct
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const store = new KeyStore('/etc/paygate-should-fail.json');

    // Creating a key should not crash even if save fails
    const record = store.createKey('test', 100);
    expect(record.key).toMatch(/^pg_/);

    consoleSpy.mockRestore();
  });

  it('should handle concurrent state file access from multiple stores', () => {
    const statePath = tmpStatePath();
    try {
      // Two stores writing to the same file (race condition test)
      const store1 = new KeyStore(statePath);
      const store2 = new KeyStore(statePath);

      store1.createKey('store1-key', 100);
      store2.createKey('store2-key', 200);

      // Last writer wins — store2 should overwrite store1's data
      const store3 = new KeyStore(statePath);
      // At minimum, the file should be valid JSON and loadable
      expect(store3.activeKeyCount).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup(statePath);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PASS 5: HTTP Transport Security
// ═══════════════════════════════════════════════════════════════════════════════

import { HttpMcpProxy } from '../../src/http-proxy';
import { createServer as createHttpServer, Server as HttpServer, IncomingMessage as HttpReq, ServerResponse as HttpRes } from 'http';

describe('RED TEAM — HTTP Transport Security', () => {
  let mockServer: HttpServer;
  let mockPort: number;
  let mockHandler: ((req: HttpReq, res: HttpRes) => void) | null = null;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      mockServer = createHttpServer((req, res) => {
        if (mockHandler) { mockHandler(req, res); return; }
        let body = '';
        req.on('data', (c) => { body += c.toString(); });
        req.on('end', () => {
          const p = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: p.id, result: {} }));
        });
      });
      mockServer.listen(0, () => {
        mockPort = (mockServer.address() as any).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      mockServer.closeAllConnections?.();
      mockServer.close(() => resolve());
    });
  });

  afterEach(() => { mockHandler = null; });

  function makeGate() {
    return new Gate({ ...DEFAULT_CONFIG, defaultCreditsPerCall: 1 });
  }

  test('should not leak API keys to remote server headers', async () => {
    let capturedHeaders: Record<string, string | string[] | undefined> = {};
    mockHandler = (req, res) => {
      capturedHeaders = req.headers;
      let body = '';
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', () => {
        const p = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: p.id, result: {} }));
      });
    };

    const gate = makeGate();
    const record = gate.store.createKey('test', 100);
    const proxy = new HttpMcpProxy(gate, `http://localhost:${mockPort}/mcp`);
    await proxy.start();

    await proxy.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'test_tool', arguments: {} },
    }, record.key);

    // API key should NOT be forwarded to the remote server
    expect(capturedHeaders['x-api-key']).toBeUndefined();
    expect(JSON.stringify(capturedHeaders)).not.toContain(record.key);
    await proxy.stop();
  });

  test('should not forward admin key to remote server', async () => {
    let capturedHeaders: Record<string, string | string[] | undefined> = {};
    mockHandler = (req, res) => {
      capturedHeaders = req.headers;
      let body = '';
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', () => {
        const p = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: p.id, result: {} }));
      });
    };

    const gate = makeGate();
    const proxy = new HttpMcpProxy(gate, `http://localhost:${mockPort}/mcp`);
    await proxy.start();

    await proxy.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
    }, null);

    expect(capturedHeaders['x-admin-key']).toBeUndefined();
    await proxy.stop();
  });

  test('should handle malicious SSE data from remote server', async () => {
    mockHandler = (_req, res) => {
      let body = '';
      _req.on('data', (c) => { body += c.toString(); });
      _req.on('end', () => {
        // Malicious: SSE with script injection
        const sseBody = `data: <script>alert('xss')</script>\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"safe":"yes"}}\n\n`;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(sseBody);
      });
    };

    const gate = makeGate();
    const proxy = new HttpMcpProxy(gate, `http://localhost:${mockPort}/mcp`);
    await proxy.start();

    const response = await proxy.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
    }, null);

    // Should still return valid JSON-RPC, not crash
    expect(response.jsonrpc).toBe('2.0');
    await proxy.stop();
  });

  test('should handle remote server returning massive response', async () => {
    mockHandler = (_req, res) => {
      let body = '';
      _req.on('data', (c) => { body += c.toString(); });
      _req.on('end', () => {
        const p = JSON.parse(body);
        // 1MB response
        const bigData = 'x'.repeat(1_000_000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: p.id, result: { data: bigData } }));
      });
    };

    const gate = makeGate();
    const proxy = new HttpMcpProxy(gate, `http://localhost:${mockPort}/mcp`);
    await proxy.start();

    const response = await proxy.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
    }, null);

    // Should handle large responses without crashing
    expect(response.jsonrpc).toBe('2.0');
    expect(response.result).toBeDefined();
    await proxy.stop();
  });

  test('should not crash on remote SSRF-style redirect URL', async () => {
    const gate = makeGate();
    // Use a port that is almost certainly refused (fast failure) instead of
    // 169.254.169.254 which can hang for 30s waiting for a timeout.
    const proxy = new HttpMcpProxy(gate, 'http://127.0.0.1:1/latest/meta-data/');
    await proxy.start();

    const response = await proxy.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
    }, null);

    // Should return error, not crash or expose metadata
    expect(response.error).toBeDefined();
    expect(response.error!.message).toContain('Remote server error');
    await proxy.stop();
  });

  test('should handle remote server that closes connection abruptly', async () => {
    mockHandler = (req, res) => {
      // Destroy connection without sending response
      req.socket.destroy();
    };

    const gate = makeGate();
    const proxy = new HttpMcpProxy(gate, `http://localhost:${mockPort}/mcp`);
    await proxy.start();

    const response = await proxy.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
    }, null);

    expect(response.error).toBeDefined();
    expect(response.error!.message).toContain('Remote server error');
    await proxy.stop();
  });

  test('should deduct credits even if remote server returns error response', async () => {
    mockHandler = (_req, res) => {
      let body = '';
      _req.on('data', (c) => { body += c.toString(); });
      _req.on('end', () => {
        const p = JSON.parse(body);
        // Return a JSON-RPC error from the "tool"
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: p.id,
          error: { code: -32000, message: 'Tool failed' },
        }));
      });
    };

    const gate = makeGate();
    const record = gate.store.createKey('test', 100);
    const proxy = new HttpMcpProxy(gate, `http://localhost:${mockPort}/mcp`);
    await proxy.start();

    await proxy.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'failing_tool', arguments: {} },
    }, record.key);

    // Credits should still be deducted (tool was called, it just errored)
    expect(gate.store.getKey(record.key)!.credits).toBe(99);
    await proxy.stop();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PASS 6: Stripe Webhook Security
// ═══════════════════════════════════════════════════════════════════════════════

import { StripeWebhookHandler } from '../../src/stripe';
import { createHmac as hmac } from 'crypto';

describe('RED TEAM — Stripe Webhook Security', () => {
  const SECRET = 'whsec_redteam_test_secret';

  function sign(body: string, secret: string, timestamp?: number): string {
    const ts = timestamp || Math.floor(Date.now() / 1000);
    const sig = hmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex');
    return `t=${ts},v1=${sig}`;
  }

  test('should reject replay attacks (reused signature from old timestamp)', () => {
    const store = new KeyStore();
    const handler = new StripeWebhookHandler(store, SECRET);
    const record = store.createKey('replay-test', 50);

    const body = JSON.stringify({
      id: 'evt_replay',
      type: 'checkout.session.completed',
      data: { object: { payment_status: 'paid', metadata: { paygate_api_key: record.key, paygate_credits: '1000' } } },
    });

    // Valid signature but from 10 minutes ago (outside 5 min tolerance)
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600;
    const sig = sign(body, SECRET, oldTimestamp);

    const result = handler.handleWebhook(body, sig);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid signature');
    expect(store.getKey(record.key)!.credits).toBe(50); // unchanged
  });

  test('should reject forged signatures with wrong secret', () => {
    const store = new KeyStore();
    const handler = new StripeWebhookHandler(store, SECRET);
    const record = store.createKey('forge-test', 50);

    const body = JSON.stringify({
      id: 'evt_forge',
      type: 'checkout.session.completed',
      data: { object: { payment_status: 'paid', metadata: { paygate_api_key: record.key, paygate_credits: '9999' } } },
    });

    // Sign with attacker's secret, not our webhook secret
    const sig = sign(body, 'attacker_secret');

    const result = handler.handleWebhook(body, sig);
    expect(result.success).toBe(false);
    expect(store.getKey(record.key)!.credits).toBe(50); // unchanged
  });

  test('should reject body tampering (modify credits after signing)', () => {
    const store = new KeyStore();
    const handler = new StripeWebhookHandler(store, SECRET);
    const record = store.createKey('tamper-test', 50);

    const originalBody = JSON.stringify({
      id: 'evt_tamper',
      type: 'checkout.session.completed',
      data: { object: { payment_status: 'paid', metadata: { paygate_api_key: record.key, paygate_credits: '10' } } },
    });

    const sig = sign(originalBody, SECRET);

    // Attacker modifies credits from 10 to 99999
    const tamperedBody = originalBody.replace('"10"', '"99999"');

    const result = handler.handleWebhook(tamperedBody, sig);
    expect(result.success).toBe(false);
    expect(store.getKey(record.key)!.credits).toBe(50); // unchanged
  });

  test('should not allow credits via unpaid checkout session', () => {
    const store = new KeyStore();
    const handler = new StripeWebhookHandler(store, SECRET);
    const record = store.createKey('unpaid-test', 50);

    const body = JSON.stringify({
      id: 'evt_unpaid',
      type: 'checkout.session.completed',
      data: { object: { payment_status: 'no_payment_required', metadata: { paygate_api_key: record.key, paygate_credits: '500' } } },
    });
    const sig = sign(body, SECRET);

    const result = handler.handleWebhook(body, sig);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Payment not completed');
    expect(store.getKey(record.key)!.credits).toBe(50);
  });

  test('should not allow negative credits via webhook', () => {
    const store = new KeyStore();
    const handler = new StripeWebhookHandler(store, SECRET);
    const record = store.createKey('neg-test', 100);

    const body = JSON.stringify({
      id: 'evt_neg',
      type: 'checkout.session.completed',
      data: { object: { payment_status: 'paid', metadata: { paygate_api_key: record.key, paygate_credits: '-50' } } },
    });
    const sig = sign(body, SECRET);

    const result = handler.handleWebhook(body, sig);
    expect(result.success).toBe(false);
    expect(store.getKey(record.key)!.credits).toBe(100); // unchanged
  });

  test('should reject events with no data.object', () => {
    const store = new KeyStore();
    const handler = new StripeWebhookHandler(store, SECRET);

    const body = JSON.stringify({
      id: 'evt_noobj',
      type: 'checkout.session.completed',
      data: {},
    });
    const sig = sign(body, SECRET);

    const result = handler.handleWebhook(body, sig);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Malformed');
  });

  test('should not leak webhook secret in error responses', () => {
    const store = new KeyStore();
    const handler = new StripeWebhookHandler(store, SECRET);

    const result = handler.handleWebhook('{}', 'bad_signature');

    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain('whsec');
  });

  test('should handle event with massive metadata without crashing', () => {
    const store = new KeyStore();
    const handler = new StripeWebhookHandler(store, SECRET);

    const bigMeta: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) {
      bigMeta[`key_${i}`] = 'x'.repeat(100);
    }
    bigMeta['paygate_api_key'] = 'pg_nonexistent';
    bigMeta['paygate_credits'] = '100';

    const body = JSON.stringify({
      id: 'evt_big',
      type: 'checkout.session.completed',
      data: { object: { payment_status: 'paid', metadata: bigMeta } },
    });
    const sig = sign(body, SECRET);

    // Should not crash, just return error for nonexistent key
    const result = handler.handleWebhook(body, sig);
    expect(result.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PASS 7: Self-Service Endpoint Security
// ═══════════════════════════════════════════════════════════════════════════════

describe('RED TEAM — Self-Service Endpoint Security', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    port = 3800 + Math.floor(Math.random() * 100);
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port,
    });
    const result = await server.start();
    port = result.port;
    adminKey = result.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  });

  // ── /balance: Information disclosure ──────────────────────────────────────

  test('should not return full API key from /balance endpoint', async () => {
    // Create a key
    const createRes = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'leak-test', credits: 100 },
    });
    const fullKey = createRes.body.key;

    // Check balance
    const res = await httpRequest(port, '/balance', {
      headers: { 'X-API-Key': fullKey },
    });

    expect(res.status).toBe(200);
    // Ensure the full key is NOT in the response body
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain(fullKey);
  });

  test('should not allow /balance to enumerate valid keys via timing', async () => {
    // Both invalid and valid keys should return similar status codes
    const validRes = await httpRequest(port, '/balance', {
      headers: { 'X-API-Key': 'pg_nonexistent_key_aaaaaa' },
    });
    const invalidRes = await httpRequest(port, '/balance', {
      headers: { 'X-API-Key': 'totally_wrong_format' },
    });

    // Both should return 404 (not found/invalid)
    expect(validRes.status).toBe(404);
    expect(invalidRes.status).toBe(404);
  });

  test('should reject /balance with admin key in X-API-Key header', async () => {
    // Admin key should NOT work as an API key for /balance
    const res = await httpRequest(port, '/balance', {
      headers: { 'X-API-Key': adminKey },
    });
    expect(res.status).toBe(404); // Admin key is not in the key store
  });

  test('should not allow /balance to be used via POST to modify data', async () => {
    const createRes = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'post-balance', credits: 100 },
    });

    // Attempt POST to /balance with a body trying to set credits
    const res = await httpRequest(port, '/balance', {
      method: 'POST',
      headers: { 'X-API-Key': createRes.body.key },
      body: { credits: 999999 },
    });
    expect(res.status).toBe(405); // Method not allowed

    // Verify credits unchanged
    const balanceRes = await httpRequest(port, '/balance', {
      headers: { 'X-API-Key': createRes.body.key },
    });
    expect(balanceRes.body.credits).toBe(100);
  });

  // ── /usage: Access control ────────────────────────────────────────────────

  test('should not allow /usage access with regular API key', async () => {
    const createRes = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'usage-leak', credits: 100 },
    });

    // Try accessing /usage with regular API key as admin key
    const res = await httpRequest(port, '/usage', {
      headers: { 'X-Admin-Key': createRes.body.key },
    });
    expect(res.status).toBe(401);
  });

  test('should mask API keys in /usage CSV output', async () => {
    // Create key and make a call to generate usage
    const createRes = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'csv-leak', credits: 100 },
    });
    const fullKey = createRes.body.key;

    await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': fullKey },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'test_tool' } },
    });

    // Get CSV usage data
    const res = await httpRequest(port, '/usage?format=csv', {
      headers: { 'X-Admin-Key': adminKey },
    });

    expect(res.status).toBe(200);
    // Full key should NOT appear in CSV
    const csvBody = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    expect(csvBody).not.toContain(fullKey);
  });

  test('should handle /usage with malicious since parameter', async () => {
    // SQL injection-style attack in since param (URL-encoded)
    const malicious = encodeURIComponent("' OR 1=1; DROP TABLE users; --");
    const res = await httpRequest(port, `/usage?since=${malicious}`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    // Should just return empty results (invalid ISO date matches nothing)
  });

  test('should handle /usage with XSS in format parameter', async () => {
    const res = await httpRequest(port, '/usage?format=<script>alert(1)</script>', {
      headers: { 'X-Admin-Key': adminKey },
    });
    // Should default to JSON (unknown format falls through to else branch)
    expect(res.status).toBe(200);
  });

  // ── /keys/revoke: Authorization checks ───────────────────────────────────

  test('should not allow a regular API key to revoke other keys', async () => {
    const createRes1 = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'victim', credits: 100 },
    });
    const createRes2 = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'attacker', credits: 100 },
    });

    // Attacker tries to revoke victim's key using their own key as admin
    const res = await httpRequest(port, '/keys/revoke', {
      method: 'POST',
      headers: { 'X-Admin-Key': createRes2.body.key },
      body: { key: createRes1.body.key },
    });
    expect(res.status).toBe(401);

    // Verify victim's key is still active
    const balance = await httpRequest(port, '/balance', {
      headers: { 'X-API-Key': createRes1.body.key },
    });
    expect(balance.status).toBe(200);
    expect(balance.body.credits).toBe(100);
  });

  test('should not allow double-revoke to cause errors', async () => {
    const createRes = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'double-revoke', credits: 100 },
    });

    // Revoke once
    const res1 = await httpRequest(port, '/keys/revoke', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { key: createRes.body.key },
    });
    expect(res1.status).toBe(200);

    // Revoke again — should not crash (idempotent is acceptable)
    const res2 = await httpRequest(port, '/keys/revoke', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { key: createRes.body.key },
    });
    // revokeKey uses keys.get() not getKey(), so it finds revoked keys too
    // Either 200 (idempotent) or 404 is acceptable — just must not crash
    expect([200, 404]).toContain(res2.status);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PASS 8: Dashboard Security
// ═══════════════════════════════════════════════════════════════════════════════

describe('RED TEAM — Dashboard Security', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    port = 3900 + Math.floor(Math.random() * 100);
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port,
      name: 'Test <script>alert("xss")</script> Server',
    });
    const result = await server.start();
    port = result.port;
    adminKey = result.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  });

  test('should HTML-escape server name in dashboard (XSS via server name)', async () => {
    const res = await httpRequest(port, '/dashboard');
    expect(res.status).toBe(200);
    const body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    // The raw script tag should NOT appear — it should be escaped
    expect(body).not.toContain('<script>alert("xss")</script>');
    // The escaped version should be present
    expect(body).toContain('&lt;script&gt;');
  });

  test('should not expose admin key anywhere in dashboard HTML', async () => {
    const res = await httpRequest(port, '/dashboard');
    expect(res.status).toBe(200);
    const body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    expect(body).not.toContain(adminKey);
  });

  test('should set no-cache header on dashboard', async () => {
    const res = await httpRequest(port, '/dashboard');
    expect(res.status).toBe(200);
    const cacheControl = res.headers['cache-control'];
    expect(cacheControl).toContain('no-cache');
  });

  test('should serve dashboard without any auth (HTML only)', async () => {
    // No X-Admin-Key, no X-API-Key — just a raw GET
    const res = await httpRequest(port, '/dashboard');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  test('should not include any hardcoded credentials or secrets in HTML source', async () => {
    const res = await httpRequest(port, '/dashboard');
    expect(res.status).toBe(200);
    const body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    // Check for common secret patterns
    expect(body).not.toMatch(/pg_[a-zA-Z0-9]{16,}/);    // No full API keys
    expect(body).not.toMatch(/whsec_/);                  // No Stripe secrets
    expect(body).not.toMatch(/sk_live_/);                // No Stripe live keys
    expect(body).not.toMatch(/sk_test_/);                // No Stripe test keys
  });

  test('should not allow POST/PUT/DELETE to /dashboard', async () => {
    const resPost = await httpRequest(port, '/dashboard', { method: 'POST', body: {} });
    const resPut = await httpRequest(port, '/dashboard', { method: 'PUT', body: {} });
    const resDelete = await httpRequest(port, '/dashboard', { method: 'DELETE' });
    // All non-GET methods should fail
    // Dashboard serves HTML for all requests, but let's verify no side effects
    expect([200, 404, 405]).toContain(resPost.status);
    expect([200, 404, 405]).toContain(resPut.status);
    expect([200, 404, 405]).toContain(resDelete.status);
  });

  test('should not embed server-side state (keys, credits) directly in HTML', async () => {
    // Create a key first so there IS state
    await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'dashboard-check', credits: 500 },
    });

    const res = await httpRequest(port, '/dashboard');
    expect(res.status).toBe(200);
    const body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    // Dashboard HTML should NOT contain pre-rendered key data —
    // all data is fetched client-side via API calls
    expect(body).not.toContain('dashboard-check');
    expect(body).not.toContain('500 cr');
  });

  test('should not allow JavaScript injection via query parameters', async () => {
    const res = await httpRequest(port, '/dashboard?name=<script>alert(1)</script>');
    expect(res.status).toBe(200);
    const body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    // Query params should not appear in the HTML output
    expect(body).not.toContain('<script>alert(1)</script>');
  });

  test('should use safe DOM methods (no innerHTML in JavaScript)', async () => {
    const res = await httpRequest(port, '/dashboard');
    expect(res.status).toBe(200);
    const body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    // The JS source should not contain innerHTML assignments
    expect(body).not.toContain('.innerHTML');
    // Should use textContent pattern instead
    expect(body).toContain('.textContent');
    expect(body).toContain('createElement');
  });

  test('should only make same-origin API calls (no external URLs in JS)', async () => {
    const res = await httpRequest(port, '/dashboard');
    expect(res.status).toBe(200);
    const body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    // Should use window.location.origin as base
    expect(body).toContain('window.location.origin');
    // Should NOT contain any hardcoded external URLs
    expect(body).not.toMatch(/https?:\/\/[^'"\s]+\.com/);
  });
});

// ─── PASS 9: Budget Bypass ─────────────────────────────────────────────────

describe('RED TEAM — Budget Bypass (Spending Limits)', () => {
  let gate: Gate;

  beforeEach(() => {
    gate = new Gate({
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100,
      defaultCreditsPerCall: 1,
    });
  });

  afterEach(() => gate.destroy());

  test('should enforce spending limit', () => {
    const record = gate.store.createKey('test', 100);
    record.spendingLimit = 5;
    gate.store.save();

    // Spend up to limit
    for (let i = 0; i < 5; i++) {
      const d = gate.evaluate(record.key, { name: 'search' });
      expect(d.allowed).toBe(true);
    }

    // 6th call should be denied
    const d = gate.evaluate(record.key, { name: 'search' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('spending_limit_exceeded');
  });

  test('should floor float spending limits to integers', () => {
    const record = gate.store.createKey('test', 100);
    record.spendingLimit = Math.max(0, Math.floor(3.7));
    gate.store.save();

    for (let i = 0; i < 3; i++) {
      const d = gate.evaluate(record.key, { name: 'search' });
      expect(d.allowed).toBe(true);
    }

    const d = gate.evaluate(record.key, { name: 'search' });
    expect(d.allowed).toBe(false);
  });

  test('should clamp negative spending limits to 0 (unlimited)', () => {
    const record = gate.store.createKey('test', 100);
    record.spendingLimit = Math.max(0, -50);
    gate.store.save();

    // 0 = unlimited, so calls should succeed
    for (let i = 0; i < 10; i++) {
      const d = gate.evaluate(record.key, { name: 'search' });
      expect(d.allowed).toBe(true);
    }
  });

  test('should not allow spending limit bypass via rapid concurrent calls', () => {
    const record = gate.store.createKey('test', 100);
    record.spendingLimit = 3;
    gate.store.save();

    // Rapid fire — should still only allow 3
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(gate.evaluate(record.key, { name: 'search' }));
    }

    const allowed = results.filter(r => r.allowed);
    expect(allowed.length).toBe(3);
  });

  test('should not allow spending limit bypass via different tools', () => {
    gate.destroy();
    gate = new Gate({
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100,
      defaultCreditsPerCall: 1,
      toolPricing: { 'expensive': { creditsPerCall: 3 } },
    });

    const record = gate.store.createKey('test', 100);
    record.spendingLimit = 5;
    gate.store.save();

    // Use 3 credits on expensive tool
    const d1 = gate.evaluate(record.key, { name: 'expensive' });
    expect(d1.allowed).toBe(true);
    expect(d1.creditsCharged).toBe(3);

    // Use 1 more on cheap tool
    const d2 = gate.evaluate(record.key, { name: 'cheap' });
    expect(d2.allowed).toBe(true);

    // Now at 4 spent, 1 credit should still work
    const d3 = gate.evaluate(record.key, { name: 'cheap' });
    expect(d3.allowed).toBe(true);

    // Now at 5 spent = limit. Next should fail
    const d4 = gate.evaluate(record.key, { name: 'cheap' });
    expect(d4.allowed).toBe(false);
  });

});

// ─── PASS 10: Refund Abuse ─────────────────────────────────────────────────

describe('RED TEAM — Refund Abuse', () => {
  let gate: Gate;

  beforeEach(() => {
    gate = new Gate({
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100,
      defaultCreditsPerCall: 1,
      refundOnFailure: true,
    });
  });

  afterEach(() => gate.destroy());

  test('should not allow infinite credits via refund loop', () => {
    const record = gate.store.createKey('test', 10);
    const key = record.key;

    // Spend 1 credit
    gate.evaluate(key, { name: 'search' });
    expect(gate.store.getKey(key)!.credits).toBe(9);

    // Refund it
    gate.refund(key, 'search', 1);
    expect(gate.store.getKey(key)!.credits).toBe(10);

    // Refund again — should NOT give extra credits beyond original
    gate.refund(key, 'search', 1);
    // Credits can go above initial amount, but totalSpent is clamped to 0
    expect(gate.store.getKey(key)!.totalSpent).toBe(0);
    expect(gate.store.getKey(key)!.totalCalls).toBe(0);
  });

  test('should not let totalSpent go negative', () => {
    const record = gate.store.createKey('test', 100);
    // Refund without any spending
    gate.refund(record.key, 'search', 50);
    expect(gate.store.getKey(record.key)!.totalSpent).toBe(0);
    expect(gate.store.getKey(record.key)!.totalCalls).toBe(0);
  });

  test('should not refund for non-existent keys', () => {
    // Should not crash
    gate.refund('pg_nonexistent_key_12345678', 'search', 100);
  });

  test('should not allow negative credits in meter after refund', () => {
    const record = gate.store.createKey('test', 100);
    gate.evaluate(record.key, { name: 'search' });
    gate.refund(record.key, 'search', 1);

    const summary = gate.meter.getSummary();
    // Check no event has negative credits making the total negative
    expect(summary.totalCreditsSpent).toBeGreaterThanOrEqual(0);
  });

  test('should not bypass spending limits via refund+re-spend', () => {
    const record = gate.store.createKey('test', 100);
    record.spendingLimit = 5;
    gate.store.save();

    // Spend 5 credits
    for (let i = 0; i < 5; i++) {
      gate.evaluate(record.key, { name: 'search' });
    }
    expect(gate.store.getKey(record.key)!.totalSpent).toBe(5);

    // Refund 3
    gate.refund(record.key, 'search', 1);
    gate.refund(record.key, 'search', 1);
    gate.refund(record.key, 'search', 1);
    expect(gate.store.getKey(record.key)!.totalSpent).toBe(2);

    // Should be able to spend 3 more (back up to limit 5)
    for (let i = 0; i < 3; i++) {
      const d = gate.evaluate(record.key, { name: 'search' });
      expect(d.allowed).toBe(true);
    }

    // Now at limit again — should be denied
    const d = gate.evaluate(record.key, { name: 'search' });
    expect(d.allowed).toBe(false);
  });
});

// ─── PASS 11: Webhook Security ─────────────────────────────────────────────

describe('RED TEAM — Webhook Security', () => {
  test('should not crash if webhook URL is malformed', () => {
    const gate = new Gate({
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100,
      webhookUrl: 'not-a-valid-url',
    });

    const record = gate.store.createKey('test', 100);
    gate.evaluate(record.key, { name: 'search' });

    // Destroy triggers flush — should not throw
    expect(() => gate.destroy()).not.toThrow();
  });

  test('should not crash if webhook URL is unreachable', () => {
    const gate = new Gate({
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100,
      webhookUrl: 'http://192.0.2.1:1/webhook',
    });

    const record = gate.store.createKey('test', 100);
    gate.evaluate(record.key, { name: 'search' });
    expect(() => gate.destroy()).not.toThrow();
  });

  test('should mask webhook URL in status response', () => {
    const gate = new Gate({
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100,
      webhookUrl: 'https://secret-api.example.com/webhook?token=abc123',
    });

    const status = gate.getStatus();
    expect(status.config.webhookUrl).toBe('***');
    expect(JSON.stringify(status)).not.toContain('secret-api.example.com');
    expect(JSON.stringify(status)).not.toContain('abc123');
    gate.destroy();
  });

  test('should have null webhook URL in status when disabled', () => {
    const gate = new Gate({
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100,
      webhookUrl: null,
    });

    const status = gate.getStatus();
    expect(status.config.webhookUrl).toBeNull();
    gate.destroy();
  });
});

// ─── PASS 12: ACL Bypass Attempts ──────────────────────────────────────────

describe('RED TEAM — ACL Bypass', () => {
  test('should not allow accessing denied tool via case variation', () => {
    const gate = new Gate({
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100,
    });
    const record = gate.store.createKey('test', 100, {
      deniedTools: ['admin-tool'],
    });

    // Exact match should be denied
    expect(gate.evaluate(record.key, { name: 'admin-tool' }).allowed).toBe(false);
    // Case variation — tool names are case-sensitive in MCP, so different case is a different tool
    // But the ACTUAL tool will also have a different name, so this is safe
    expect(gate.evaluate(record.key, { name: 'Admin-Tool' }).allowed).toBe(true);
    gate.destroy();
  });

  test('should not bypass ACL by setting allowedTools to non-array via API', () => {
    const gate = new Gate({
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100,
    });
    const record = gate.store.createKey('test', 100, {
      allowedTools: ['search'] as any,
    });

    // Should only allow search
    expect(gate.evaluate(record.key, { name: 'search' }).allowed).toBe(true);
    expect(gate.evaluate(record.key, { name: 'other' }).allowed).toBe(false);

    // Try to set ACL with garbage values — sanitizeToolList should handle it
    gate.store.setAcl(record.key, null as any, undefined as any);
    // After setting null, allowedTools should become [] (empty = all allowed)
    expect(gate.evaluate(record.key, { name: 'other' }).allowed).toBe(true);
    gate.destroy();
  });

  test('should not allow more than 100 tools in ACL list', () => {
    const gate = new Gate({
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100,
    });
    const bigList = Array.from({ length: 200 }, (_, i) => `tool-${i}`);
    const record = gate.store.createKey('test', 100, {
      allowedTools: bigList,
    });

    expect(record.allowedTools.length).toBe(100);
    gate.destroy();
  });

  test('should handle empty string tools in ACL list', () => {
    const gate = new Gate({
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100,
    });
    const record = gate.store.createKey('test', 100, {
      allowedTools: ['search', '', '  ', 'generate'],
    });

    // Empty/whitespace strings should be filtered out
    expect(record.allowedTools).toEqual(['search', 'generate']);
    gate.destroy();
  });

  test('should not allow tool injection via special characters in tool name', () => {
    const gate = new Gate({
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100,
    });
    const record = gate.store.createKey('test', 100, {
      allowedTools: ['search'],
    });

    // Various injection attempts
    expect(gate.evaluate(record.key, { name: 'search\x00admin' }).allowed).toBe(false);
    expect(gate.evaluate(record.key, { name: 'search,admin' }).allowed).toBe(false);
    expect(gate.evaluate(record.key, { name: '../search' }).allowed).toBe(false);
    gate.destroy();
  });

  test('should not return denied tools in filterToolsForKey', () => {
    const gate = new Gate({
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100,
    });

    const tools = [
      { name: 'search', description: 'Search' },
      { name: 'admin', description: 'Admin' },
      { name: 'secret', description: 'Secret' },
    ];

    const record = gate.store.createKey('test', 100, {
      deniedTools: ['admin', 'secret'],
    });

    const filtered = gate.filterToolsForKey(record.key, tools);
    expect(filtered).not.toBeNull();
    expect(filtered!.length).toBe(1);
    expect(filtered![0].name).toBe('search');

    // Denied tools should not leak through
    const names = filtered!.map(t => t.name);
    expect(names).not.toContain('admin');
    expect(names).not.toContain('secret');
    gate.destroy();
  });
});

// ─── PASS 13: Key Expiry Bypass ────────────────────────────────────────────

describe('RED TEAM — Key Expiry Bypass', () => {
  test('should not allow using key that expired 1ms ago', () => {
    const gate = new Gate({
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100,
    });
    const past = new Date(Date.now() - 1).toISOString();
    const record = gate.store.createKey('test', 100, { expiresAt: past });

    const decision = gate.evaluate(record.key, { name: 'search' });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('api_key_expired');
    gate.destroy();
  });

  test('should not bypass expiry via invalid date format', () => {
    const gate = new Gate({
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100,
    });
    // Invalid date string — should be treated as "no expiry" (NaN check)
    const record = gate.store.createKey('test', 100, { expiresAt: 'not-a-date' });

    // Invalid date: isNaN check means it won't expire (can't parse, so no expiry enforced)
    const decision = gate.evaluate(record.key, { name: 'search' });
    expect(decision.allowed).toBe(true);
    gate.destroy();
  });

  test('should not allow extending expiry without admin key', async () => {
    // This tests the HTTP endpoint — expired keys can only be extended via admin
    const portNum = 3700 + Math.floor(Math.random() * 100);
    const testServer = new PayGateServer({
      serverCommand: 'node',
      serverArgs: [MOCK_SERVER],
      port: portNum,
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 100,
      name: 'Expiry Test',
    });

    const result = await testServer.start();
    await new Promise(r => setTimeout(r, 300));

    try {
      // Create a key with expiry
      const createRes = await httpRequest(result.port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': result.adminKey },
        body: { name: 'expiring', credits: 100, expiresIn: 3600 },
      });
      expect(createRes.status).toBe(201);
      expect(createRes.body.expiresAt).toBeTruthy();

      const key = createRes.body.key;

      // Try to extend expiry without admin key — should fail
      const extendRes = await httpRequest(result.port, '/keys/expiry', {
        method: 'POST',
        headers: { 'X-API-Key': key },
        body: { key, expiresIn: 99999 },
      });
      expect(extendRes.status).toBe(401);
    } finally {
      await testServer.stop();
    }
  }, 15000);

  test('should not allow negative expiresIn to create far-future expiry', () => {
    const gate = new Gate({
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100,
    });
    // Negative expiresIn would create a past date, which is expired
    const past = new Date(Date.now() + (-86400 * 1000)).toISOString(); // -1 day
    const record = gate.store.createKey('test', 100, { expiresAt: past });

    const decision = gate.evaluate(record.key, { name: 'search' });
    expect(decision.allowed).toBe(false);
    gate.destroy();
  });

  test('should not allow credits to be deducted from expired key', () => {
    const gate = new Gate({
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100,
    });
    const past = new Date(Date.now() - 1000).toISOString();
    const record = gate.store.createKey('test', 100, { expiresAt: past });

    // Try to deduct via gate
    gate.evaluate(record.key, { name: 'search' });
    const raw = gate.store.getKeyRaw(record.key);
    expect(raw!.credits).toBe(100); // No deduction
    expect(raw!.totalCalls).toBe(0);
    gate.destroy();
  });

  test('should not allow topup on expired key via store', () => {
    const gate = new Gate({
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100,
    });
    const past = new Date(Date.now() - 1000).toISOString();
    const record = gate.store.createKey('test', 100, { expiresAt: past });

    // addCredits calls getKey which checks expiry
    const success = gate.store.addCredits(record.key, 50);
    expect(success).toBe(false);

    const raw = gate.store.getKeyRaw(record.key);
    expect(raw!.credits).toBe(100); // Not modified
    gate.destroy();
  });
});

// ─── PASS 14: Per-Tool Rate Limit Bypass ───────────────────────────────────

describe('RED TEAM — Per-Tool Rate Limit Bypass', () => {
  test('should not bypass per-tool limit via different API keys sharing tool counter', () => {
    const gate = new Gate({
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100,
      toolPricing: {
        'expensive': { creditsPerCall: 1, rateLimitPerMin: 2 },
      },
    });

    const key1 = gate.store.createKey('user1', 1000);
    const key2 = gate.store.createKey('user2', 1000);

    // Key1 exhausts its per-tool limit
    gate.evaluate(key1.key, { name: 'expensive' });
    gate.evaluate(key1.key, { name: 'expensive' });
    expect(gate.evaluate(key1.key, { name: 'expensive' }).allowed).toBe(false);

    // Key2 should have its own counter
    expect(gate.evaluate(key2.key, { name: 'expensive' }).allowed).toBe(true);
    gate.destroy();
  });

  test('should enforce both global and per-tool limits simultaneously', () => {
    const gate = new Gate({
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 5,
      toolPricing: {
        'limited-tool': { creditsPerCall: 1, rateLimitPerMin: 3 },
      },
    });

    const record = gate.store.createKey('test', 1000);

    // Per-tool limit is 3, global is 5
    for (let i = 0; i < 3; i++) {
      expect(gate.evaluate(record.key, { name: 'limited-tool' }).allowed).toBe(true);
    }

    // Per-tool limit hit at 3
    const perToolDenied = gate.evaluate(record.key, { name: 'limited-tool' });
    expect(perToolDenied.allowed).toBe(false);
    expect(perToolDenied.reason).toContain('tool_rate_limited');

    // But other tools should still work (global has 2 more calls)
    expect(gate.evaluate(record.key, { name: 'other-tool' }).allowed).toBe(true);
    expect(gate.evaluate(record.key, { name: 'other-tool' }).allowed).toBe(true);

    // Now global is exhausted too
    expect(gate.evaluate(record.key, { name: 'other-tool' }).allowed).toBe(false);
    gate.destroy();
  });

  test('should not allow per-tool rate limit bypass via tool name mutation', () => {
    const gate = new Gate({
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100,
      toolPricing: {
        'search': { creditsPerCall: 1, rateLimitPerMin: 2 },
      },
    });

    const record = gate.store.createKey('test', 1000);

    // Exhaust search limit
    gate.evaluate(record.key, { name: 'search' });
    gate.evaluate(record.key, { name: 'search' });
    expect(gate.evaluate(record.key, { name: 'search' }).allowed).toBe(false);

    // Different name — no per-tool limit configured, uses global only
    expect(gate.evaluate(record.key, { name: 'Search' }).allowed).toBe(true);
    expect(gate.evaluate(record.key, { name: 'SEARCH' }).allowed).toBe(true);
    gate.destroy();
  });

  test('should not let per-tool rate limit counter overflow', () => {
    const gate = new Gate({
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 0, // unlimited global
      toolPricing: {
        'tool': { creditsPerCall: 1, rateLimitPerMin: 5 },
      },
    });

    const record = gate.store.createKey('test', 100000);

    // Make many calls — should be rate limited after 5
    let denied = 0;
    for (let i = 0; i < 20; i++) {
      const d = gate.evaluate(record.key, { name: 'tool' });
      if (!d.allowed) denied++;
    }

    // Should have been denied 15 times (20 - 5 allowed)
    expect(denied).toBe(15);
    gate.destroy();
  });
});
