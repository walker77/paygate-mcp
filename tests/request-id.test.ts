/**
 * Tests for v5.4.0 — Request ID Tracking
 *
 * Covers:
 *   - X-Request-Id header generated on every response
 *   - X-Request-Id propagated from incoming request
 *   - Request ID format (req_ prefix + 16 hex chars)
 *   - Request ID in CORS exposed headers
 *   - Request ID on health endpoint
 *   - Request ID on admin endpoints
 *   - Request ID on /mcp endpoint
 *   - Request ID in audit log metadata
 *   - generateRequestId() export
 *   - getRequestId() export
 */

import { PayGateServer, generateRequestId, getRequestId } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';
import http from 'http';

// ─── Helpers ───────────────────────────────────────────────────────────────────

const ECHO_CMD = process.execPath;
const ECHO_ARGS = ['-e', 'process.stdin.resume(); process.stdin.on("data", d => { const r = JSON.parse(d.toString().trim()); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: {} }) + "\\n"); });'];

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(data), headers: res.headers }); }
        catch { resolve({ status: res.statusCode!, body: data, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Unit: generateRequestId ─────────────────────────────────────────────────

describe('generateRequestId', () => {
  test('returns string with req_ prefix', () => {
    const id = generateRequestId();
    expect(id).toMatch(/^req_[0-9a-f]{16}$/);
  });

  test('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateRequestId()));
    expect(ids.size).toBe(100);
  });
});

// ─── Unit: getRequestId ──────────────────────────────────────────────────────

describe('getRequestId', () => {
  test('returns undefined for plain request', () => {
    const fakeReq = {} as any;
    expect(getRequestId(fakeReq)).toBeUndefined();
  });

  test('returns _requestId when set', () => {
    const fakeReq = { _requestId: 'req_abc123' } as any;
    expect(getRequestId(fakeReq)).toBe('req_abc123');
  });
});

// ─── Integration: Request ID on HTTP responses ───────────────────────────────

describe('Request ID — HTTP Integration', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer(
      { ...DEFAULT_CONFIG, port: 0, serverCommand: ECHO_CMD, serverArgs: ECHO_ARGS },
      'reqid-admin-key',
    );
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.stop();
  });

  test('health endpoint returns X-Request-Id header', async () => {
    const res = await request(port, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-request-id']).toMatch(/^req_[0-9a-f]{16}$/);
  });

  test('admin /keys endpoint returns X-Request-Id header', async () => {
    const res = await request(port, 'GET', '/keys', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-request-id']).toMatch(/^req_[0-9a-f]{16}$/);
  });

  test('each request gets a unique request ID', async () => {
    const res1 = await request(port, 'GET', '/health');
    const res2 = await request(port, 'GET', '/health');
    expect(res1.headers['x-request-id']).not.toBe(res2.headers['x-request-id']);
  });

  test('propagates incoming X-Request-Id header', async () => {
    const customId = 'req_custom_trace_id_1234';
    const res = await request(port, 'GET', '/health', undefined, { 'X-Request-Id': customId });
    expect(res.headers['x-request-id']).toBe(customId);
  });

  test('OPTIONS preflight returns X-Request-Id header', async () => {
    const res = await request(port, 'OPTIONS', '/mcp');
    expect(res.status).toBe(204);
    expect(res.headers['x-request-id']).toBeDefined();
  });

  test('X-Request-Id is in Access-Control-Expose-Headers', async () => {
    const res = await request(port, 'GET', '/health');
    const exposeHeaders = res.headers['access-control-expose-headers'] as string;
    expect(exposeHeaders).toContain('X-Request-Id');
  });

  test('X-Request-Id is in Access-Control-Allow-Headers', async () => {
    const res = await request(port, 'OPTIONS', '/mcp');
    const allowHeaders = res.headers['access-control-allow-headers'] as string;
    expect(allowHeaders).toContain('X-Request-Id');
  });

  test('/mcp endpoint returns X-Request-Id on tool call', async () => {
    // Create a key first
    const keyRes = await request(port, 'POST', '/keys', { name: 'reqid-test', credits: 100 }, { 'X-Admin-Key': adminKey });
    const apiKey = keyRes.body.key;

    const mcpRes = await request(port, 'POST', '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'test-tool', arguments: {} },
    }, { 'X-API-Key': apiKey });

    expect(mcpRes.headers['x-request-id']).toBeDefined();
    expect(mcpRes.headers['x-request-id']).toMatch(/^req_[0-9a-f]{16}$/);
  });

  test('/mcp with custom X-Request-Id propagates to response', async () => {
    const keyRes = await request(port, 'POST', '/keys', { name: 'reqid-test-2', credits: 100 }, { 'X-Admin-Key': adminKey });
    const apiKey = keyRes.body.key;
    const traceId = 'trace-abc-123-xyz';

    const mcpRes = await request(port, 'POST', '/mcp', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'test-tool', arguments: {} },
    }, { 'X-API-Key': apiKey, 'X-Request-Id': traceId });

    expect(mcpRes.headers['x-request-id']).toBe(traceId);
  });

  test('error responses include X-Request-Id', async () => {
    // No API key — should get auth error but still have request ID
    const res = await request(port, 'POST', '/mcp', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'test-tool', arguments: {} },
    });

    expect(res.headers['x-request-id']).toBeDefined();
  });

  test('status endpoint returns X-Request-Id', async () => {
    const res = await request(port, 'GET', '/status', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeDefined();
  });
});

// ─── Integration: Request ID in Audit Log ────────────────────────────────────

describe('Request ID — Audit Trail', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer(
      { ...DEFAULT_CONFIG, port: 0, serverCommand: ECHO_CMD, serverArgs: ECHO_ARGS },
      'audit-reqid-key',
    );
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.stop();
  });

  test('gate.allow audit event includes requestId in metadata', async () => {
    // Create a key and make a tool call
    const keyRes = await request(port, 'POST', '/keys', { name: 'audit-reqid', credits: 100 }, { 'X-Admin-Key': adminKey });
    const apiKey = keyRes.body.key;
    const traceId = 'trace-audit-test-001';

    await request(port, 'POST', '/mcp', {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'test-tool', arguments: {} },
    }, { 'X-API-Key': apiKey, 'X-Request-Id': traceId });

    // Query audit log for gate.allow events
    const auditRes = await request(port, 'GET', '/audit?type=gate.allow&limit=10', undefined, { 'X-Admin-Key': adminKey });
    expect(auditRes.status).toBe(200);

    const events = auditRes.body.events || [];
    const matchingEvent = events.find((e: any) => e.metadata?.requestId === traceId);
    expect(matchingEvent).toBeDefined();
    expect(matchingEvent.metadata.requestId).toBe(traceId);
  });

  test('gate.deny audit event includes requestId', async () => {
    // Use an invalid API key to trigger denial
    const traceId = 'trace-deny-test-002';
    await request(port, 'POST', '/mcp', {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'test-tool', arguments: {} },
    }, { 'X-API-Key': 'pg_invalid_key_for_denial', 'X-Request-Id': traceId });

    const auditRes = await request(port, 'GET', '/audit?type=gate.deny&limit=10', undefined, { 'X-Admin-Key': adminKey });
    expect(auditRes.status).toBe(200);

    const events = auditRes.body.events || [];
    const matchingEvent = events.find((e: any) => e.metadata?.requestId === traceId);
    expect(matchingEvent).toBeDefined();
  });

  test('session.created audit event includes requestId', async () => {
    const keyRes = await request(port, 'POST', '/keys', { name: 'session-reqid', credits: 100 }, { 'X-Admin-Key': adminKey });
    const apiKey = keyRes.body.key;
    const traceId = 'trace-session-test-003';

    await request(port, 'POST', '/mcp', {
      jsonrpc: '2.0',
      id: 12,
      method: 'initialize',
      params: {},
    }, { 'X-API-Key': apiKey, 'X-Request-Id': traceId });

    const auditRes = await request(port, 'GET', '/audit?type=session.created&limit=10', undefined, { 'X-Admin-Key': adminKey });
    expect(auditRes.status).toBe(200);

    const events = auditRes.body.events || [];
    const matchingEvent = events.find((e: any) => e.metadata?.requestId === traceId);
    expect(matchingEvent).toBeDefined();
  });
});
