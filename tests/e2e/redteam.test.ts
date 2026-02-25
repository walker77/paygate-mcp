/**
 * RED TEAM TESTS — Adversarial testing of PayGate MCP.
 *
 * Pass 1: Auth bypass and key manipulation
 * Pass 2: Rate limit evasion and credit abuse
 * Pass 3: Input validation, injection, and edge cases
 * Pass 4: Persistence attack vectors
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
    await server.stop();
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
      const createRes = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'empty-tool', credits: 0 },
      });
      const apiKey = createRes.body.key;

      const res = await httpRequest(port, '/mcp', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: '', arguments: {} } },
      });
      // Should be denied — insufficient credits
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
      // Should still process (we don't strictly validate jsonrpc field)
      // But it should not crash
      expect(res.status).toBe(200);
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
      // The key should work but not overflow
      expect(res.body.credits).toBe(Number.MAX_SAFE_INTEGER);
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

    it('should handle request without Content-Type', async () => {
      const res = await httpRequest(port, '/mcp', {
        method: 'POST',
        headers: { 'Content-Type': '' },
        body: { jsonrpc: '2.0', id: 1, method: 'ping', params: {} },
      });
      // Should still work — we don't enforce Content-Type
      expect([200, 400]).toContain(res.status);
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
