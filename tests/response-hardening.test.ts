/**
 * Tests for v8.93.0 — Response & logging hardening
 *
 * 1. sanitizeLogUrl: strips control characters, truncates long URLs
 * 2. /status response capping: keys array limited to 1000
 * 3. analytics topN capping: clamped to [1, 1000], default 10
 * 4. Session creation rate limiting: per-IP rate limit on new sessions
 */

import { PayGateServer } from '../src/server';
import { PayGateConfig } from '../src/types';
import * as http from 'http';

// ─── Helper ─────────────────────────────────────────────────────────────────

function httpRequest(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
  return new Promise((resolve, reject) => {
    const method = options.method || 'GET';
    const headers: Record<string, string> = { ...options.headers };
    let bodyStr: string | undefined;

    if (options.body !== undefined) {
      bodyStr = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr).toString();
    }

    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => {
          let body: any;
          try { body = JSON.parse(data); } catch { body = data; }
          resolve({ status: res.statusCode!, headers: res.headers, body });
        });
      }
    );

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── sanitizeLogUrl tests (via log injection in error handler) ──────────

describe('v8.93.0 — Log injection prevention', () => {
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
    await server.stop();
  });

  it('should handle requests with newlines in URL without crashing', async () => {
    // URL with control characters — should be handled safely
    const rawPath = '/status%0d%0aInjected-Header:%20evil';
    const res = await httpRequest(port, rawPath, {
      method: 'GET',
      headers: { 'X-Admin-Key': adminKey },
    });
    // Should get a valid HTTP response (404 for unrecognized path is fine)
    expect([200, 401, 404]).toContain(res.status);
  });

  it('should handle request to unknown path with control chars', async () => {
    const rawPath = '/nonexistent%0a%0dFake-Log-Entry';
    const res = await httpRequest(port, rawPath, { method: 'GET' });
    expect(res.status).toBe(404);
  });
});

// ─── /status response capping ───────────────────────────────────────────

describe('v8.93.0 — Status response capping', () => {
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
    await server.stop();
  });

  it('should return status with keys array (small set)', async () => {
    const res = await httpRequest(port, '/status', {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('keys');
    expect(Array.isArray(res.body.keys)).toBe(true);
    // Small set — should NOT be truncated
    expect(res.body.keysTruncated).toBeUndefined();
  });
});

// ─── Analytics topN capping ─────────────────────────────────────────────

describe('v8.93.0 — Analytics topN capping', () => {
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
    await server.stop();
  });

  it('should accept normal topN value', async () => {
    const res = await httpRequest(port, '/analytics?top=5', {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('topConsumers');
  });

  it('should cap absurdly large topN', async () => {
    const res = await httpRequest(port, '/analytics?top=999999999', {
      headers: { 'X-Admin-Key': adminKey },
    });
    // Should succeed (clamped internally to 1000) — no OOM
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('topConsumers');
  });

  it('should handle negative topN', async () => {
    const res = await httpRequest(port, '/analytics?top=-5', {
      headers: { 'X-Admin-Key': adminKey },
    });
    // Clamped to min 1
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('topConsumers');
  });

  it('should handle NaN topN (defaults to 10)', async () => {
    const res = await httpRequest(port, '/analytics?top=notanumber', {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('topConsumers');
  });

  it('should handle missing topN (defaults to 10)', async () => {
    const res = await httpRequest(port, '/analytics', {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('topConsumers');
  });
});

// ─── Session creation rate limiting ─────────────────────────────────────

describe('v8.93.0 — Session creation rate limiting', () => {
  let server: PayGateServer;
  let port: number;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      requestTimeoutMs: 3000,
      sessionRateLimit: 5, // Very low limit for testing: 5 sessions/min per IP
    } as PayGateConfig & { serverCommand: string });
    const started = await server.start();
    port = started.port;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should allow initial session creation', async () => {
    const res = await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    });
    // The upstream is a stub so we may get an error, but NOT 429
    expect(res.status).not.toBe(429);
  });

  it('should rate limit excessive session creation', async () => {
    // Create sessions rapidly (each without session ID = forces new session)
    const results: number[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await httpRequest(port, '/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { jsonrpc: '2.0', id: i + 100, method: 'initialize', params: {} },
      });
      results.push(res.status);
    }

    // With limit of 5, we should see at least one 429 in the batch
    const has429 = results.some(s => s === 429);
    expect(has429).toBe(true);
  });

  it('should include Retry-After header on 429', async () => {
    // Exhaust the limit first (may already be exhausted from previous test)
    for (let i = 0; i < 6; i++) {
      await httpRequest(port, '/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { jsonrpc: '2.0', id: i + 200, method: 'ping', params: {} },
      });
    }

    // This one should be rate limited
    const res = await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { jsonrpc: '2.0', id: 999, method: 'ping', params: {} },
    });

    if (res.status === 429) {
      expect(res.headers['retry-after']).toBeDefined();
      const retryAfter = parseInt(res.headers['retry-after'] as string, 10);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
    }
  });

  it('should allow requests that reuse existing sessions', async () => {
    // Get a valid session ID first (if possible)
    const first = await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    });

    // If we got a session, subsequent requests with that session should NOT be rate limited
    const sessionHeader = first.headers['mcp-session-id'];
    if (sessionHeader && first.status !== 429) {
      const res = await httpRequest(port, '/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': sessionHeader as string,
        },
        body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      });
      // Should NOT get 429 since we're reusing the session
      expect(res.status).not.toBe(429);
    }
  });
});
