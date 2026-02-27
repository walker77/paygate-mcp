/**
 * Prototype pollution prevention tests — verifies that safeJsonParse()
 * strips __proto__, constructor, and prototype keys from user-supplied
 * JSON payloads to prevent Object.prototype pollution attacks.
 *
 * v8.86.0: All JSON.parse() calls on user input in server.ts now use
 * safeJsonParse() which strips dangerous keys via a reviver function.
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
});

afterAll(async () => {
  await server.gracefulStop(1000);
});

function postJson(path: string, body: string | object, headers: Record<string, string> = {}): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
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
          resolve({ status: res.statusCode!, body: JSON.parse(chunks), raw: chunks });
        } catch {
          resolve({ status: res.statusCode!, body: chunks, raw: chunks });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJson(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: {
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
    req.end();
  });
}

describe('Prototype pollution prevention', () => {
  // ── Baseline: Object.prototype must remain clean ──────────────
  test('Object.prototype has no admin property before tests', () => {
    expect((Object.prototype as any).admin).toBeUndefined();
    expect((Object.prototype as any).isAdmin).toBeUndefined();
    expect((Object.prototype as any).role).toBeUndefined();
  });

  // ── POST /keys with __proto__ payload ─────────────────────────
  test('__proto__ in key creation body does not pollute Object.prototype', async () => {
    // Craft a payload with __proto__ attempting to set admin: true
    const malicious = '{"credits": 100, "__proto__": {"admin": true, "isAdmin": true}}';
    const res = await postJson('/keys', malicious);
    expect(res.status).toBe(201);
    expect(res.body.key).toBeDefined();

    // Object.prototype must NOT be polluted
    expect((Object.prototype as any).admin).toBeUndefined();
    expect((Object.prototype as any).isAdmin).toBeUndefined();

    // A fresh plain object must not have polluted properties
    const fresh: any = {};
    expect(fresh.admin).toBeUndefined();
    expect(fresh.isAdmin).toBeUndefined();
  });

  // ── POST /keys with constructor.prototype payload ─────────────
  test('constructor.prototype in body does not pollute Object.prototype', async () => {
    const malicious = '{"credits": 100, "constructor": {"prototype": {"role": "superadmin"}}}';
    const res = await postJson('/keys', malicious);
    expect(res.status).toBe(201);

    // Object.prototype must NOT be polluted
    expect((Object.prototype as any).role).toBeUndefined();
    const fresh: any = {};
    expect(fresh.role).toBeUndefined();
  });

  // ── POST /keys with nested __proto__ ──────────────────────────
  test('nested __proto__ in body is stripped', async () => {
    const malicious = '{"credits": 100, "metadata": {"__proto__": {"polluted": true}}}';
    const res = await postJson('/keys', malicious);
    expect(res.status).toBe(201);

    expect((Object.prototype as any).polluted).toBeUndefined();
    const fresh: any = {};
    expect(fresh.polluted).toBeUndefined();
  });

  // ── POST /maintenance with __proto__ ──────────────────────────
  test('__proto__ in maintenance body does not pollute', async () => {
    const malicious = '{"enabled": false, "__proto__": {"hacked": true}}';
    const res = await postJson('/maintenance', malicious);
    expect(res.status).toBe(200);

    expect((Object.prototype as any).hacked).toBeUndefined();
  });

  // ── POST /keys/notes with prototype pollution attempt ─────────
  test('__proto__ in notes body does not pollute', async () => {
    // First create a key to add notes to
    const keyRes = await postJson('/keys', { credits: 100 });
    const key = keyRes.body.key;

    const malicious = `{"key": "${key}", "text": "note", "__proto__": {"pwned": true}}`;
    const res = await postJson('/keys/notes', malicious);
    expect(res.status).toBe(201);

    expect((Object.prototype as any).pwned).toBeUndefined();
  });

  // ── Normal JSON still works correctly ─────────────────────────
  test('normal JSON payloads work correctly after safeJsonParse', async () => {
    const res = await postJson('/keys', { credits: 500 });
    expect(res.status).toBe(201);
    expect(res.body.key).toBeDefined();
    expect(res.body.credits).toBe(500);
  });

  test('complex JSON objects with allowed keys parse correctly', async () => {
    const res = await postJson('/keys', {
      credits: 200,
      tags: { env: 'test', tier: 'free' },
      rateLimit: 100,
    });
    expect(res.status).toBe(201);
    expect(res.body.key).toBeDefined();
  });

  // ── POST /keys/schedule with __proto__ ────────────────────────
  test('__proto__ in schedule body does not pollute', async () => {
    const keyRes = await postJson('/keys', { credits: 100 });
    const key = keyRes.body.key;
    const future = new Date(Date.now() + 86400000).toISOString();

    const malicious = `{"key": "${key}", "action": "suspend", "executeAt": "${future}", "__proto__": {"escalated": true}}`;
    const res = await postJson('/keys/schedule', malicious);
    expect(res.status).toBe(201);

    expect((Object.prototype as any).escalated).toBeUndefined();
  });

  // ── POST /keys/reserve with __proto__ ─────────────────────────
  test('__proto__ in reserve body does not pollute', async () => {
    const keyRes = await postJson('/keys', { credits: 100 });
    const key = keyRes.body.key;

    const malicious = `{"key": "${key}", "credits": 10, "ttlSeconds": 60, "__proto__": {"bypass": true}}`;
    const res = await postJson('/keys/reserve', malicious);
    expect(res.status).toBe(201);

    expect((Object.prototype as any).bypass).toBeUndefined();
  });

  // ── Verify stripping doesn't break error paths ────────────────
  test('invalid JSON still returns proper error', async () => {
    const res = await postJson('/keys', 'not-valid-json');
    expect(res.status).toBe(400);
  });

  // ── Verify prototype key is stripped from deep nesting ────────
  test('deeply nested __proto__ is stripped', async () => {
    const malicious = '{"credits": 100, "a": {"b": {"c": {"__proto__": {"deep": true}}}}}';
    const res = await postJson('/keys', malicious);
    expect(res.status).toBe(201);

    expect((Object.prototype as any).deep).toBeUndefined();
    const fresh: any = {};
    expect(fresh.deep).toBeUndefined();
  });

  // ── Verify "prototype" key (not just __proto__) is stripped ───
  test('"prototype" key in body is stripped', async () => {
    const malicious = '{"credits": 100, "prototype": {"injected": true}}';
    const res = await postJson('/keys', malicious);
    expect(res.status).toBe(201);

    expect((Object.prototype as any).injected).toBeUndefined();
  });

  // ── Final sanity check: Object.prototype still clean ──────────
  test('Object.prototype remains clean after all tests', () => {
    const proto = Object.prototype as any;
    expect(proto.admin).toBeUndefined();
    expect(proto.isAdmin).toBeUndefined();
    expect(proto.role).toBeUndefined();
    expect(proto.hacked).toBeUndefined();
    expect(proto.pwned).toBeUndefined();
    expect(proto.polluted).toBeUndefined();
    expect(proto.escalated).toBeUndefined();
    expect(proto.bypass).toBeUndefined();
    expect(proto.deep).toBeUndefined();
    expect(proto.injected).toBeUndefined();
  });
});
