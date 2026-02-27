/**
 * Tests for v5.7.0 — Custom Response Headers
 *
 * Covers:
 *   - Custom headers applied to all endpoints (health, info, admin, MCP)
 *   - Multiple custom headers
 *   - Custom headers on preflight (OPTIONS)
 *   - No custom headers when not configured
 *   - Custom headers don't override CORS or Request-Id
 *   - /info features.customHeaders flag
 *   - ENV_VAR_MAP includes PAYGATE_CUSTOM_HEADERS
 *   - Config file customHeaders
 */

import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';
import { ENV_VAR_MAP } from '../src/cli';
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

// ─── Custom Headers on All Endpoints ─────────────────────────────────────────

describe('Custom Headers — Applied to responses', () => {
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
        customHeaders: {
          'X-Frame-Options': 'DENY',
          'X-Content-Type-Options': 'nosniff',
          'X-Custom-Tag': 'paygate-v5.7',
        },
      },
      undefined,
    );
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('custom headers on /health', async () => {
    const res = await request(port, 'GET', '/health');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-custom-tag']).toBe('paygate-v5.7');
  });

  test('custom headers on /info', async () => {
    const res = await request(port, 'GET', '/info');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  test('custom headers on admin endpoint /keys', async () => {
    const res = await request(port, 'GET', '/keys', undefined, { 'X-Admin-Key': adminKey });
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  test('custom headers on OPTIONS preflight', async () => {
    const res = await request(port, 'OPTIONS', '/mcp');
    expect(res.status).toBe(204);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  test('custom headers coexist with CORS headers', async () => {
    const res = await request(port, 'GET', '/health');
    // Custom headers present
    expect(res.headers['x-frame-options']).toBe('DENY');
    // CORS headers still present
    expect(res.headers['access-control-allow-origin']).toBe('*');
    // Request ID still present
    expect(res.headers['x-request-id']).toBeDefined();
  });

  test('custom headers on error responses (401)', async () => {
    const res = await request(port, 'GET', '/status');
    expect(res.status).toBe(401);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  test('custom headers on /mcp endpoint', async () => {
    // Create a key first
    const createRes = await request(port, 'POST', '/keys', { name: 'test', credits: 100 }, { 'X-Admin-Key': adminKey });
    const key = createRes.body.key;

    const res = await request(port, 'POST', '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    }, { 'X-API-Key': key });
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-custom-tag']).toBe('paygate-v5.7');
  });
});

// ─── No Custom Headers When Not Configured ───────────────────────────────────

describe('Custom Headers — Not configured', () => {
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
    await server.gracefulStop(5_000);
  }, 30_000);

  test('no custom headers when not configured (security headers still present)', async () => {
    const res = await request(port, 'GET', '/health');
    // Security headers are always present (since v8.71.0)
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // But arbitrary custom headers are not set
    expect(res.headers['x-custom-tag']).toBeUndefined();
  });

  test('standard headers still present', async () => {
    const res = await request(port, 'GET', '/health');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['x-request-id']).toBeDefined();
  });
});

// ─── Empty Custom Headers ────────────────────────────────────────────────────

describe('Custom Headers — Empty object', () => {
  let server: PayGateServer;
  let port: number;

  beforeAll(async () => {
    server = new PayGateServer(
      { ...DEFAULT_CONFIG, port: 0, serverCommand: ECHO_CMD, serverArgs: ECHO_ARGS, customHeaders: {} },
      undefined,
    );
    const info = await server.start();
    port = info.port;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('empty customHeaders object does not add custom headers (security headers still present)', async () => {
    const res = await request(port, 'GET', '/health');
    // Security headers are always present even with empty customHeaders
    expect(res.headers['x-frame-options']).toBe('DENY');
    // But no arbitrary custom headers are added
    expect(res.headers['x-custom-tag']).toBeUndefined();
  });
});

// ─── /info features.customHeaders flag ───────────────────────────────────────

describe('Custom Headers — Info Endpoint Flag', () => {
  test('customHeaders is false when not configured', async () => {
    const server = new PayGateServer(
      { ...DEFAULT_CONFIG, port: 0, serverCommand: ECHO_CMD, serverArgs: ECHO_ARGS },
      undefined,
    );
    const info = await server.start();
    try {
      const res = await request(info.port, 'GET', '/info');
      expect(res.body.features.customHeaders).toBe(false);
    } finally {
      await server.stop();
    }
  });

  test('customHeaders is false when empty object', async () => {
    const server = new PayGateServer(
      { ...DEFAULT_CONFIG, port: 0, serverCommand: ECHO_CMD, serverArgs: ECHO_ARGS, customHeaders: {} },
      undefined,
    );
    const info = await server.start();
    try {
      const res = await request(info.port, 'GET', '/info');
      expect(res.body.features.customHeaders).toBe(false);
    } finally {
      await server.stop();
    }
  });

  test('customHeaders is true when headers are configured', async () => {
    const server = new PayGateServer(
      {
        ...DEFAULT_CONFIG,
        port: 0,
        serverCommand: ECHO_CMD,
        serverArgs: ECHO_ARGS,
        customHeaders: { 'X-Frame-Options': 'DENY' },
      },
      undefined,
    );
    const info = await server.start();
    try {
      const res = await request(info.port, 'GET', '/info');
      expect(res.body.features.customHeaders).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

// ─── ENV_VAR_MAP includes custom headers ─────────────────────────────────────

describe('Custom Headers — ENV_VAR_MAP', () => {
  test('PAYGATE_CUSTOM_HEADERS is in ENV_VAR_MAP', () => {
    expect(ENV_VAR_MAP).toHaveProperty('PAYGATE_CUSTOM_HEADERS');
  });

  test('maps to --header flag', () => {
    expect(ENV_VAR_MAP.PAYGATE_CUSTOM_HEADERS).toContain('--header');
  });
});
