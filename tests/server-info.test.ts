/**
 * Tests for v5.5.0 — Server Info Endpoint
 *
 * Covers:
 *   - GET /info returns 200 with JSON body
 *   - Response includes version, name, transport, port
 *   - Response includes auth methods
 *   - Response includes features flags
 *   - Response includes pricing summary
 *   - Response includes rate limit info
 *   - Response includes endpoints list
 *   - /info is public (no admin key required)
 *   - POST /info returns 405
 *   - Features reflect actual server config
 *   - /info listed in status endpoint
 */

import { PayGateServer } from '../src/server';
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

// ─── Integration Tests ───────────────────────────────────────────────────────

describe('GET /info — Server Info Endpoint', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer(
      {
        ...DEFAULT_CONFIG,
        port: 0,
        serverCommand: ECHO_CMD,
        serverArgs: ECHO_ARGS,
        name: 'test-info-server',
        defaultCreditsPerCall: 3,
        globalRateLimitPerMin: 120,
        toolPricing: { 'expensive-tool': { creditsPerCall: 10 } },
        webhookUrl: 'https://test.example.com/hook',
        webhookSecret: 'test-secret-123',
        refundOnFailure: true,
        shadowMode: false,
      },
      'info-admin-key',
    );
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.stop();
  });

  test('returns 200 with JSON body', async () => {
    const res = await request(port, 'GET', '/info');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(typeof res.body).toBe('object');
  });

  test('includes server name', async () => {
    const res = await request(port, 'GET', '/info');
    expect(res.body.name).toBe('test-info-server');
  });

  test('includes version string', async () => {
    const res = await request(port, 'GET', '/info');
    expect(res.body.version).toBeDefined();
    expect(typeof res.body.version).toBe('string');
    expect(res.body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('includes transport type', async () => {
    const res = await request(port, 'GET', '/info');
    expect(res.body.transport).toBe('stdio');
  });

  test('includes port', async () => {
    const res = await request(port, 'GET', '/info');
    expect(res.body.port).toBeDefined();
  });

  test('includes auth methods', async () => {
    const res = await request(port, 'GET', '/info');
    expect(res.body.auth).toContain('api_key');
    expect(res.body.auth).toContain('scoped_token');
    expect(Array.isArray(res.body.auth)).toBe(true);
  });

  test('includes features flags', async () => {
    const res = await request(port, 'GET', '/info');
    expect(res.body.features).toBeDefined();
    expect(typeof res.body.features).toBe('object');
    // Feature flags reflect config
    expect(res.body.features.webhooks).toBe(true);
    expect(res.body.features.webhookSignatures).toBe(true);
    expect(res.body.features.refundOnFailure).toBe(true);
    expect(res.body.features.shadowMode).toBe(false);
    expect(res.body.features.redis).toBe(false);
    expect(res.body.features.oauth).toBe(false);
  });

  test('includes pricing summary', async () => {
    const res = await request(port, 'GET', '/info');
    expect(res.body.pricing).toBeDefined();
    expect(res.body.pricing.defaultCreditsPerCall).toBe(3);
    expect(res.body.pricing.toolPricing).toBeDefined();
    expect(res.body.pricing.toolPricing['expensive-tool']).toBeDefined();
    expect(res.body.pricing.toolPricing['expensive-tool'].creditsPerCall).toBe(10);
  });

  test('includes rate limit info', async () => {
    const res = await request(port, 'GET', '/info');
    expect(res.body.rateLimit).toBeDefined();
    expect(res.body.rateLimit.globalPerMin).toBe(120);
  });

  test('includes endpoints list', async () => {
    const res = await request(port, 'GET', '/info');
    expect(res.body.endpoints).toBeDefined();
    expect(res.body.endpoints.mcp).toBe('/mcp');
    expect(res.body.endpoints.health).toBe('/health');
    expect(res.body.endpoints.info).toBe('/info');
    expect(res.body.endpoints.metrics).toBe('/metrics');
    expect(res.body.endpoints.pricing).toBe('/pricing');
  });

  test('is public (no admin key needed)', async () => {
    const res = await request(port, 'GET', '/info');
    expect(res.status).toBe(200);
    // No X-Admin-Key header sent, should still work
  });

  test('POST returns 405', async () => {
    const res = await request(port, 'POST', '/info', { data: 'test' });
    expect(res.status).toBe(405);
  });

  test('includes X-Request-Id header', async () => {
    const res = await request(port, 'GET', '/info');
    expect(res.headers['x-request-id']).toBeDefined();
  });
});

// ─── Minimal config — feature flags off ──────────────────────────────────────

describe('GET /info — Minimal Config', () => {
  let server: PayGateServer;
  let port: number;

  beforeAll(async () => {
    server = new PayGateServer(
      { ...DEFAULT_CONFIG, port: 0, serverCommand: ECHO_CMD, serverArgs: ECHO_ARGS },
      undefined,
    );
    const info = await server.start();
    port = info.port;
  });

  afterAll(async () => {
    await server.stop();
  });

  test('features reflect minimal config', async () => {
    const res = await request(port, 'GET', '/info');
    expect(res.body.features.webhooks).toBe(false);
    expect(res.body.features.webhookSignatures).toBe(false);
    expect(res.body.features.refundOnFailure).toBe(false);
    expect(res.body.features.oauth).toBe(false);
    expect(res.body.features.redis).toBe(false);
    expect(res.body.features.multiServer).toBe(false);
  });

  test('empty tool pricing when no overrides', async () => {
    const res = await request(port, 'GET', '/info');
    expect(res.body.pricing.toolPricing).toEqual({});
  });
});

// ─── /info listed in status endpoint ─────────────────────────────────────────

describe('GET /info — Listed in Status', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer(
      { ...DEFAULT_CONFIG, port: 0, serverCommand: ECHO_CMD, serverArgs: ECHO_ARGS },
      'status-info-key',
    );
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.stop();
  });

  test('root endpoint lists /info in endpoints', async () => {
    const res = await request(port, 'GET', '/');
    expect(res.status).toBe(200);
    const endpointsJson = JSON.stringify(res.body.endpoints || {});
    expect(endpointsJson).toContain('/info');
  });
});
