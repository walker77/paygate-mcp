/**
 * Array length bounds tests — verifies that admin endpoints enforce
 * upper limits on array-type fields (allowedTools, deniedTools, ipAllowlist)
 * to prevent memory exhaustion DoS via unbounded lists.
 *
 * v8.90.0: Array fields previously accepted unbounded lists. Now clamped
 * via clampArray() to sane maximums (ACL: 1000, IP allowlist: 200).
 */

import { PayGateServer } from '../src/server';
import http from 'http';

// Suppress logger output in tests
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

let server: PayGateServer;
let port: number;
let adminKey: string;
let testKey: string;

beforeAll(async () => {
  server = new PayGateServer({
    serverCommand: 'echo',
    serverArgs: ['test'],
    port: 0,
    requestTimeoutMs: 3000,
  });
  const started = await server.start();
  port = started.port;
  adminKey = started.adminKey;

  // Create a test key
  const res = await postJson('/keys', { credits: 1000, name: 'array-bounds-test' });
  testKey = res.body.key;
});

afterAll(async () => {
  await server.gracefulStop(1000);
});

function postJson(path: string, body: any, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
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
        'X-Admin-Key': adminKey,
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

/** Generate an array of N tool names */
function genTools(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `tool_${i}`);
}

/** Generate an array of N IP addresses */
function genIps(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `10.0.${Math.floor(i / 256)}.${i % 256}`);
}

describe('Array length bounds enforcement', () => {
  // ── Key creation ACL clamping ───────────────────────────────────
  describe('POST /keys — ACL clamping', () => {
    test('allowedTools clamped to 1000 items', async () => {
      const tools = genTools(1500);
      const res = await postJson('/keys', {
        credits: 100,
        name: 'acl-clamp-test',
        allowedTools: tools,
      });
      expect(res.status).toBe(201);
      expect(res.body.allowedTools.length).toBeLessThanOrEqual(1000);
    });

    test('deniedTools clamped to 1000 items', async () => {
      const tools = genTools(1500);
      const res = await postJson('/keys', {
        credits: 100,
        name: 'denied-clamp-test',
        deniedTools: tools,
      });
      expect(res.status).toBe(201);
      expect(res.body.deniedTools.length).toBeLessThanOrEqual(1000);
    });

    test('ipAllowlist clamped to 200 items', async () => {
      const ips = genIps(300);
      const res = await postJson('/keys', {
        credits: 100,
        name: 'ip-clamp-test',
        ipAllowlist: ips,
      });
      expect(res.status).toBe(201);
      expect(res.body.ipAllowlist.length).toBeLessThanOrEqual(200);
    });
  });

  // ── setAcl endpoint clamping ────────────────────────────────────
  describe('POST /keys/acl — ACL update clamping', () => {
    test('allowedTools clamped on setAcl', async () => {
      const tools = genTools(1500);
      const res = await postJson('/keys/acl', {
        key: testKey,
        allowedTools: tools,
      });
      expect(res.status).toBe(200);
      expect(res.body.allowedTools.length).toBeLessThanOrEqual(1000);
    });

    test('deniedTools clamped on setAcl', async () => {
      const tools = genTools(1500);
      const res = await postJson('/keys/acl', {
        key: testKey,
        deniedTools: tools,
        allowedTools: [],
      });
      expect(res.status).toBe(200);
      expect(res.body.deniedTools.length).toBeLessThanOrEqual(1000);
    });
  });

  // ── IP allowlist endpoint clamping ──────────────────────────────
  describe('POST /keys/ip — IP allowlist clamping', () => {
    test('IPs clamped to 200 items', async () => {
      const ips = genIps(300);
      const res = await postJson('/keys/ip', {
        key: testKey,
        ips: ips,
      });
      expect(res.status).toBe(200);
      expect(res.body.ipAllowlist.length).toBeLessThanOrEqual(200);
    });
  });

  // ── Scoped token ACL clamping ───────────────────────────────────
  describe('POST /tokens — token ACL clamping', () => {
    test('allowedTools clamped on token creation', async () => {
      const tools = genTools(1500);
      const res = await postJson('/tokens', {
        key: testKey,
        allowedTools: tools,
        ttl: 60,
      });
      expect(res.status).toBe(201);
      expect(res.body.allowedTools.length).toBeLessThanOrEqual(1000);
    });
  });

  // ── Reasonable arrays pass through ─────────────────────────────
  describe('Reasonable arrays pass through unchanged', () => {
    test('10 allowedTools preserved exactly', async () => {
      const tools = genTools(10);
      const res = await postJson('/keys', {
        credits: 100,
        name: 'small-acl-test',
        allowedTools: tools,
      });
      expect(res.status).toBe(201);
      expect(res.body.allowedTools.length).toBe(10);
    });

    test('50 IPs preserved exactly', async () => {
      const ips = genIps(50);
      const res = await postJson('/keys/ip', {
        key: testKey,
        ips: ips,
      });
      expect(res.status).toBe(200);
      expect(res.body.ipAllowlist.length).toBe(50);
    });
  });
});
