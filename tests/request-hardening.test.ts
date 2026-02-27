/**
 * Request-level hardening tests — verifies Content-Type enforcement,
 * 405 Method Not Allowed on multi-method endpoints, and connection limits.
 *
 * v8.92.0: POST requests now require Content-Type: application/json (except
 * /oauth/token which also accepts application/x-www-form-urlencoded per RFC 6749).
 * Multi-method endpoints return 405 instead of 404 for unsupported methods.
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

function httpRequest(
  method: string,
  path: string,
  opts: { body?: string; contentType?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'X-Admin-Key': adminKey,
      ...(opts.headers || {}),
    };
    if (opts.body) {
      headers['Content-Length'] = String(Buffer.byteLength(opts.body));
    }
    if (opts.contentType) {
      headers['Content-Type'] = opts.contentType;
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers,
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
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════
// Content-Type enforcement
// ═══════════════════════════════════════════════════════════════════
describe('Content-Type enforcement (415 Unsupported Media Type)', () => {
  test('POST /keys without Content-Type returns 415', async () => {
    const res = await httpRequest('POST', '/keys', {
      body: JSON.stringify({ credits: 100, name: 'test' }),
      // No Content-Type header
    });
    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/Unsupported Media Type/);
  });

  test('POST /keys with text/plain returns 415', async () => {
    const res = await httpRequest('POST', '/keys', {
      body: JSON.stringify({ credits: 100, name: 'test' }),
      contentType: 'text/plain',
    });
    expect(res.status).toBe(415);
  });

  test('POST /keys with multipart/form-data returns 415', async () => {
    const res = await httpRequest('POST', '/keys', {
      body: 'some binary data',
      contentType: 'multipart/form-data; boundary=----Boundary',
    });
    expect(res.status).toBe(415);
  });

  test('POST /keys with application/xml returns 415', async () => {
    const res = await httpRequest('POST', '/keys', {
      body: '<key><credits>100</credits></key>',
      contentType: 'application/xml',
    });
    expect(res.status).toBe(415);
  });

  test('POST /keys with application/json succeeds', async () => {
    const res = await httpRequest('POST', '/keys', {
      body: JSON.stringify({ credits: 100, name: 'ct-test' }),
      contentType: 'application/json',
    });
    expect(res.status).toBe(201);
  });

  test('POST /keys with application/json; charset=utf-8 succeeds', async () => {
    const res = await httpRequest('POST', '/keys', {
      body: JSON.stringify({ credits: 100, name: 'ct-charset-test' }),
      contentType: 'application/json; charset=utf-8',
    });
    expect(res.status).toBe(201);
  });

  test('POST /mcp without JSON Content-Type returns 415', async () => {
    const res = await httpRequest('POST', '/mcp', {
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      contentType: 'text/plain',
      headers: { 'X-API-Key': 'fake-key' },
    });
    expect(res.status).toBe(415);
  });

  test('POST /topup with text/html returns 415', async () => {
    const res = await httpRequest('POST', '/topup', {
      body: JSON.stringify({ key: 'test', credits: 50 }),
      contentType: 'text/html',
    });
    expect(res.status).toBe(415);
  });

  test('GET requests are not affected by Content-Type check', async () => {
    const res = await httpRequest('GET', '/health');
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 405 Method Not Allowed
// ═══════════════════════════════════════════════════════════════════
describe('405 Method Not Allowed on multi-method endpoints', () => {
  const endpoints = [
    { path: '/keys', allowed: 'GET or POST' },
    { path: '/keys/templates', allowed: 'GET or POST' },
    { path: '/alerts', allowed: 'GET or POST' },
    { path: '/webhooks/filters', allowed: 'GET or POST' },
    { path: '/teams', allowed: 'GET or POST' },
    { path: '/admin/keys', allowed: 'GET or POST' },
    { path: '/groups', allowed: 'GET or POST' },
    { path: '/tokens', allowed: 'POST' },
  ];

  for (const ep of endpoints) {
    test(`PUT ${ep.path} returns 405 (not 404)`, async () => {
      const res = await httpRequest('PUT', ep.path);
      expect(res.status).toBe(405);
      expect(res.body.error).toMatch(/Method not allowed/);
    });
  }

  test('DELETE /webhooks/dead-letter is allowed', async () => {
    const res = await httpRequest('DELETE', '/webhooks/dead-letter');
    // Should not be 405 — DELETE is allowed for this endpoint
    expect(res.status).not.toBe(405);
  });

  test('PATCH /webhooks/dead-letter returns 405', async () => {
    const res = await httpRequest('PATCH', '/webhooks/dead-letter');
    expect(res.status).toBe(405);
  });
});
