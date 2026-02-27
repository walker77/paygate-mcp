/**
 * Admin endpoint body size limit tests — verifies that all admin POST
 * endpoints that read request bodies are protected by readBody() size
 * limits (MAX_BODY_SIZE = 1 MB) and timeout protection.
 *
 * v8.85.0: These endpoints previously used unprotected inline body readers
 * that allowed unlimited request body sizes (DoS via memory exhaustion).
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

  // Create a regular API key for endpoints that need one
  const res = await postJson('/keys', { credits: 1000 });
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

/**
 * Send an oversized body (2 MB) to an admin endpoint.
 * Uses raw HTTP to bypass JSON.stringify limitations.
 */
function postOversized(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const oversized = Buffer.alloc(2 * 1024 * 1024, 0x41); // 2 MB of 'A'
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': oversized.length,
        'X-Admin-Key': adminKey,
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
    req.on('error', (err) => {
      // Connection reset is expected when server rejects oversized body
      resolve({ status: 0, body: { error: err.message } });
    });
    req.write(oversized);
    req.end();
  });
}

describe('Admin endpoint body size limits', () => {
  // ── /maintenance ────────────────────────────────────────────
  test('POST /maintenance rejects oversized body', async () => {
    const res = await postOversized('/maintenance');
    expect([0, 413]).toContain(res.status);
    if (res.status === 413) {
      expect(res.body.error).toBeDefined();
    }
  });

  test('POST /maintenance still works with normal body', async () => {
    const res = await postJson('/maintenance', { enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  // ── /keys/notes ─────────────────────────────────────────────
  test('POST /keys/notes rejects oversized body', async () => {
    const res = await postOversized('/keys/notes');
    expect([0, 413]).toContain(res.status);
    if (res.status === 413) {
      expect(res.body.error).toBeDefined();
    }
  });

  test('POST /keys/notes still works with normal body', async () => {
    const res = await postJson('/keys/notes', {
      key: testKey,
      text: 'Test note from body limit test',
    });
    expect(res.status).toBe(201);
    expect(res.body.note).toBeDefined();
  });

  // ── /keys/schedule ──────────────────────────────────────────
  test('POST /keys/schedule rejects oversized body', async () => {
    const res = await postOversized('/keys/schedule');
    expect([0, 413]).toContain(res.status);
    if (res.status === 413) {
      expect(res.body.error).toBeDefined();
    }
  });

  test('POST /keys/schedule still works with normal body', async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const res = await postJson('/keys/schedule', {
      key: testKey,
      action: 'suspend',
      executeAt: future,
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
  });

  // ── /keys/reserve ───────────────────────────────────────────
  test('POST /keys/reserve rejects oversized body', async () => {
    const res = await postOversized('/keys/reserve');
    expect([0, 413]).toContain(res.status);
    if (res.status === 413) {
      expect(res.body.error).toBeDefined();
    }
  });

  test('POST /keys/reserve still works with normal body', async () => {
    const res = await postJson('/keys/reserve', {
      key: testKey,
      credits: 10,
      ttlSeconds: 60,
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
  });

  // ── /keys/reserve/commit ────────────────────────────────────
  test('POST /keys/reserve/commit rejects oversized body', async () => {
    const res = await postOversized('/keys/reserve/commit');
    expect([0, 413]).toContain(res.status);
    if (res.status === 413) {
      expect(res.body.error).toBeDefined();
    }
  });

  test('commit endpoint works with normal body', async () => {
    // Create a reservation first
    const createRes = await postJson('/keys/reserve', {
      key: testKey,
      credits: 5,
      ttlSeconds: 60,
    });
    expect(createRes.status).toBe(201);
    const reservationId = createRes.body.id;

    // Commit it
    const commitRes = await postJson('/keys/reserve/commit', {
      reservationId,
    });
    expect(commitRes.status).toBe(200);
    expect(commitRes.body.committed).toBeDefined();
  });

  // ── /keys/reserve/release ───────────────────────────────────
  test('POST /keys/reserve/release rejects oversized body', async () => {
    const res = await postOversized('/keys/reserve/release');
    expect([0, 413]).toContain(res.status);
    if (res.status === 413) {
      expect(res.body.error).toBeDefined();
    }
  });

  test('release endpoint works with normal body', async () => {
    // Create a reservation first
    const createRes = await postJson('/keys/reserve', {
      key: testKey,
      credits: 5,
      ttlSeconds: 60,
    });
    expect(createRes.status).toBe(201);
    const reservationId = createRes.body.id;

    // Release it
    const releaseRes = await postJson('/keys/reserve/release', {
      reservationId,
    });
    expect(releaseRes.status).toBe(200);
    expect(releaseRes.body.released).toBeDefined();
  });
});
