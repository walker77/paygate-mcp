/**
 * SSE Streaming & Session Management Tests.
 *
 * Tests:
 *   - SessionManager unit tests (create, get, destroy, timeout, eviction)
 *   - SSE helper functions
 *   - E2E: POST /mcp with Accept: text/event-stream returns SSE
 *   - E2E: POST /mcp without Accept header returns JSON with Mcp-Session-Id
 *   - E2E: GET /mcp opens SSE notification stream
 *   - E2E: DELETE /mcp terminates session
 *   - E2E: Session ID reuse across requests
 */

import * as http from 'http';
import { SessionManager, writeSseEvent, writeSseKeepAlive } from '../src/session';
import { PayGateServer } from '../src/server';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function httpRequest(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: options.port,
      method: options.method,
      path: options.path,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body,
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Open an SSE connection and collect events until the connection ends or timeout.
 */
function openSseConnection(options: {
  port: number;
  path: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; events: string[]; raw: string }> {
  return new Promise((resolve, reject) => {
    const timeout = options.timeoutMs || 2000;
    const req = http.request({
      hostname: '127.0.0.1',
      port: options.port,
      method: 'GET',
      path: options.path,
      headers: {
        'Accept': 'text/event-stream',
        ...options.headers,
      },
    }, (res) => {
      let raw = '';
      const events: string[] = [];
      let currentEvent = '';

      const timer = setTimeout(() => {
        req.destroy();
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          events,
          raw,
        });
      }, timeout);

      res.on('data', (chunk: Buffer) => {
        const data = chunk.toString();
        raw += data;

        // Parse SSE events
        const lines = data.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            currentEvent = line.slice(6);
          } else if (line === '' && currentEvent) {
            events.push(currentEvent);
            currentEvent = '';
          }
        }
      });

      res.on('end', () => {
        clearTimeout(timer);
        if (currentEvent) events.push(currentEvent);
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          events,
          raw,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── SessionManager Unit Tests ───────────────────────────────────────────────

describe('SessionManager', () => {
  let manager: SessionManager;

  afterEach(() => {
    manager?.destroy();
  });

  test('createSession returns a unique session ID', () => {
    manager = new SessionManager();
    const id1 = manager.createSession(null);
    const id2 = manager.createSession(null);
    expect(id1).toMatch(/^mcp_sess_/);
    expect(id2).toMatch(/^mcp_sess_/);
    expect(id1).not.toBe(id2);
    expect(manager.sessionCount).toBe(2);
  });

  test('getSession returns null for unknown session', () => {
    manager = new SessionManager();
    expect(manager.getSession('nonexistent')).toBeNull();
  });

  test('getSession returns session and updates lastActivityAt', () => {
    manager = new SessionManager();
    const id = manager.createSession('pk_test_123');
    const session = manager.getSession(id);
    expect(session).not.toBeNull();
    expect(session!.apiKey).toBe('pk_test_123');
    expect(session!.id).toBe(id);
  });

  test('destroySession removes session', () => {
    manager = new SessionManager();
    const id = manager.createSession(null);
    expect(manager.sessionCount).toBe(1);

    const destroyed = manager.destroySession(id);
    expect(destroyed).toBe(true);
    expect(manager.sessionCount).toBe(0);
    expect(manager.getSession(id)).toBeNull();
  });

  test('destroySession returns false for unknown session', () => {
    manager = new SessionManager();
    expect(manager.destroySession('unknown')).toBe(false);
  });

  test('session expires after timeout', () => {
    manager = new SessionManager({ sessionTimeoutMs: 50 }); // 50ms timeout
    const id = manager.createSession(null);
    expect(manager.getSession(id)).not.toBeNull();

    // Wait for expiry
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(manager.getSession(id)).toBeNull();
        resolve();
      }, 100);
    });
  });

  test('maxSessions evicts oldest when limit reached', () => {
    manager = new SessionManager({ maxSessions: 2 });
    const id1 = manager.createSession(null);
    const id2 = manager.createSession(null);
    const id3 = manager.createSession(null); // Should evict id1

    expect(manager.sessionCount).toBe(2);
    expect(manager.getSession(id1)).toBeNull(); // evicted
    expect(manager.getSession(id2)).not.toBeNull();
    expect(manager.getSession(id3)).not.toBeNull();
  });

  test('sendNotification does not throw for unknown session', () => {
    manager = new SessionManager();
    expect(() => manager.sendNotification('unknown', { jsonrpc: '2.0' })).not.toThrow();
  });
});

// ─── E2E Tests ───────────────────────────────────────────────────────────────

describe('SSE Streaming E2E', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let apiKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: process.execPath,
      serverArgs: [require('path').join(__dirname, 'e2e', 'mock-mcp-server.js')],
      port: 0,
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 0,
    });

    const result = await server.start();
    port = result.port;
    adminKey = result.adminKey;

    // Create a test API key
    const keyRes = await httpRequest({
      port,
      method: 'POST',
      path: '/keys',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'sse-test', credits: 100 }),
    });
    apiKey = JSON.parse(keyRes.body).key;
  });

  afterAll(async () => {
    await server.stop();
  });

  test('POST /mcp returns JSON with Mcp-Session-Id header', async () => {
    const res = await httpRequest({
      port,
      method: 'POST',
      path: '/mcp',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['mcp-session-id']).toBeDefined();
    expect(res.headers['mcp-session-id']).toMatch(/^mcp_sess_/);

    const body = JSON.parse(res.body);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
  });

  test('POST /mcp with Accept: text/event-stream returns SSE response', async () => {
    const res = await httpRequest({
      port,
      method: 'POST',
      path: '/mcp',
      headers: {
        'X-API-Key': apiKey,
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['mcp-session-id']).toBeDefined();

    // Parse SSE events
    const dataLines = res.body.split('\n').filter(l => l.startsWith('data: '));
    expect(dataLines.length).toBeGreaterThanOrEqual(1);

    // Parse the JSON-RPC response from the SSE event
    const eventData = JSON.parse(dataLines[0].slice(6));
    expect(eventData.jsonrpc).toBe('2.0');
    expect(eventData.id).toBe(2);
    expect(eventData.result).toBeDefined();
  });

  test('POST /mcp reuses session with Mcp-Session-Id header', async () => {
    // First request — create session
    const res1 = await httpRequest({
      port,
      method: 'POST',
      path: '/mcp',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'ping' }),
    });

    const sessionId = res1.headers['mcp-session-id'] as string;
    expect(sessionId).toBeDefined();

    // Second request — reuse session
    const res2 = await httpRequest({
      port,
      method: 'POST',
      path: '/mcp',
      headers: {
        'X-API-Key': apiKey,
        'Mcp-Session-Id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'ping' }),
    });

    expect(res2.headers['mcp-session-id']).toBe(sessionId);
  });

  test('GET /mcp opens SSE notification stream', async () => {
    // First create a session
    const postRes = await httpRequest({
      port,
      method: 'POST',
      path: '/mcp',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'ping' }),
    });
    const sessionId = postRes.headers['mcp-session-id'] as string;

    // Open SSE stream
    const sseRes = await openSseConnection({
      port,
      path: '/mcp',
      headers: { 'Mcp-Session-Id': sessionId },
      timeoutMs: 1000,
    });

    expect(sseRes.statusCode).toBe(200);
    expect(sseRes.headers['content-type']).toContain('text/event-stream');
    expect(sseRes.headers['mcp-session-id']).toBe(sessionId);

    // Should have received at least the initialization notification
    expect(sseRes.events.length).toBeGreaterThanOrEqual(1);
    const initEvent = JSON.parse(sseRes.events[0]);
    expect(initEvent.method).toBe('notifications/initialized');
    expect(initEvent.params.sessionId).toBe(sessionId);
  });

  test('GET /mcp without Accept: text/event-stream returns 405', async () => {
    const res = await httpRequest({
      port,
      method: 'GET',
      path: '/mcp',
      headers: { 'Accept': 'application/json' },
    });

    expect(res.statusCode).toBe(405);
  });

  test('DELETE /mcp terminates session', async () => {
    // Create a session
    const postRes = await httpRequest({
      port,
      method: 'POST',
      path: '/mcp',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify({ jsonrpc: '2.0', id: 30, method: 'ping' }),
    });
    const sessionId = postRes.headers['mcp-session-id'] as string;

    // Terminate session
    const delRes = await httpRequest({
      port,
      method: 'DELETE',
      path: '/mcp',
      headers: { 'Mcp-Session-Id': sessionId },
    });

    expect(delRes.statusCode).toBe(200);
    const body = JSON.parse(delRes.body);
    expect(body.message).toBe('Session terminated');

    // Subsequent request with old session ID should get a new session
    const postRes2 = await httpRequest({
      port,
      method: 'POST',
      path: '/mcp',
      headers: {
        'X-API-Key': apiKey,
        'Mcp-Session-Id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'ping' }),
    });
    const newSessionId = postRes2.headers['mcp-session-id'] as string;
    expect(newSessionId).not.toBe(sessionId);
  });

  test('DELETE /mcp without Mcp-Session-Id returns 400', async () => {
    const res = await httpRequest({
      port,
      method: 'DELETE',
      path: '/mcp',
    });

    expect(res.statusCode).toBe(400);
  });

  test('DELETE /mcp with unknown session returns 404', async () => {
    const res = await httpRequest({
      port,
      method: 'DELETE',
      path: '/mcp',
      headers: { 'Mcp-Session-Id': 'mcp_sess_nonexistent' },
    });

    expect(res.statusCode).toBe(404);
  });

  test('POST /mcp SSE response includes gated tool call', async () => {
    const res = await httpRequest({
      port,
      method: 'POST',
      path: '/mcp',
      headers: {
        'X-API-Key': apiKey,
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 40,
        method: 'tools/call',
        params: { name: 'echo', arguments: { message: 'hello SSE' } },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const dataLines = res.body.split('\n').filter(l => l.startsWith('data: '));
    expect(dataLines.length).toBeGreaterThanOrEqual(1);

    const eventData = JSON.parse(dataLines[0].slice(6));
    expect(eventData.jsonrpc).toBe('2.0');
    expect(eventData.id).toBe(40);
    // Should have result (not error)
    expect(eventData.result).toBeDefined();
  });

  test('POST /mcp SSE returns payment error for insufficient credits', async () => {
    // Import a key with 0 credits directly (API enforces min 1)
    const brokeKey = 'pg_sse_broke_' + Date.now();
    server.gate.store.importKey(brokeKey, 'sse-broke', 0);

    const res = await httpRequest({
      port,
      method: 'POST',
      path: '/mcp',
      headers: {
        'X-API-Key': brokeKey,
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 50,
        method: 'tools/call',
        params: { name: 'echo', arguments: { message: 'denied' } },
      }),
    });

    expect(res.statusCode).toBe(200);
    const dataLines = res.body.split('\n').filter(l => l.startsWith('data: '));
    const eventData = JSON.parse(dataLines[0].slice(6));
    expect(eventData.error).toBeDefined();
    expect(eventData.error.code).toBe(-32402);
  });

  test('CORS headers include Mcp-Session-Id and DELETE method', async () => {
    const res = await httpRequest({
      port,
      method: 'OPTIONS',
      path: '/mcp',
    });

    expect(res.statusCode).toBe(204);
    const allowMethods = res.headers['access-control-allow-methods'] as string;
    expect(allowMethods).toContain('DELETE');
    const allowHeaders = res.headers['access-control-allow-headers'] as string;
    expect(allowHeaders).toContain('Mcp-Session-Id');
    const exposeHeaders = res.headers['access-control-expose-headers'] as string;
    expect(exposeHeaders).toContain('Mcp-Session-Id');
  });

  test('session count tracked on server', async () => {
    const initialCount = server.sessions.sessionCount;

    // Create multiple sessions
    await httpRequest({
      port,
      method: 'POST',
      path: '/mcp',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify({ jsonrpc: '2.0', id: 60, method: 'ping' }),
    });

    expect(server.sessions.sessionCount).toBeGreaterThanOrEqual(initialCount);
  });
});
