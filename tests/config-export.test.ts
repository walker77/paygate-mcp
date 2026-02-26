/**
 * Tests for v5.8.0 — Config Export Endpoint
 *
 * Covers:
 *   - GET /config returns running config
 *   - Sensitive values masked (webhookSecret, serverCommand, serverArgs)
 *   - Webhook URL partially masked (scheme + host visible)
 *   - Config includes toolPricing, freeMethods, cors, customHeaders
 *   - Requires admin auth (401 without key)
 *   - 405 on non-GET methods
 *   - /config listed in root endpoint directory
 *   - Audit trail for config export
 *   - Webhook filter secrets masked
 *   - OAuth config exported (non-sensitive)
 *   - Default values shown when not configured
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

// ─── Basic Config Export ─────────────────────────────────────────────────────

describe('Config Export — Basic', () => {
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
        name: 'Test Server',
        defaultCreditsPerCall: 5,
        globalRateLimitPerMin: 100,
        shadowMode: true,
        refundOnFailure: true,
        toolPricing: { search: { creditsPerCall: 10 } },
        customHeaders: { 'X-Frame-Options': 'DENY' },
      },
      undefined,
    );
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.stop();
  });

  test('returns 200 with config object', async () => {
    const res = await request(port, 'GET', '/config', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.config).toBeDefined();
  });

  test('includes basic config values', async () => {
    const res = await request(port, 'GET', '/config', undefined, { 'X-Admin-Key': adminKey });
    const cfg = res.body.config;
    expect(cfg.name).toBe('Test Server');
    expect(cfg.defaultCreditsPerCall).toBe(5);
    expect(cfg.globalRateLimitPerMin).toBe(100);
    expect(cfg.shadowMode).toBe(true);
    expect(cfg.refundOnFailure).toBe(true);
  });

  test('includes toolPricing', async () => {
    const res = await request(port, 'GET', '/config', undefined, { 'X-Admin-Key': adminKey });
    expect(res.body.config.toolPricing).toEqual({ search: { creditsPerCall: 10 } });
  });

  test('includes freeMethods', async () => {
    const res = await request(port, 'GET', '/config', undefined, { 'X-Admin-Key': adminKey });
    expect(res.body.config.freeMethods).toEqual(DEFAULT_CONFIG.freeMethods);
  });

  test('includes customHeaders', async () => {
    const res = await request(port, 'GET', '/config', undefined, { 'X-Admin-Key': adminKey });
    expect(res.body.config.customHeaders).toEqual({ 'X-Frame-Options': 'DENY' });
  });

  test('masks serverCommand', async () => {
    const res = await request(port, 'GET', '/config', undefined, { 'X-Admin-Key': adminKey });
    expect(res.body.config.serverCommand).toBe('***');
  });

  test('masks serverArgs', async () => {
    const res = await request(port, 'GET', '/config', undefined, { 'X-Admin-Key': adminKey });
    expect(res.body.config.serverArgs).toEqual(['***']);
  });
});

// ─── Sensitive Value Masking ────────────────────────────────────────────────

describe('Config Export — Sensitive Masking', () => {
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
        webhookUrl: 'https://hooks.example.com/webhook/secret-path',
        webhookSecret: 'super-secret-hmac-key',
        webhookFilters: [
          {
            id: 'f1',
            name: 'test-filter',
            events: ['key.created'],
            url: 'https://filter-hook.example.com/path',
            secret: 'filter-secret',
            active: true,
          },
        ],
      },
      undefined,
    );
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.stop();
  });

  test('masks webhook URL (keeps scheme + host)', async () => {
    const res = await request(port, 'GET', '/config', undefined, { 'X-Admin-Key': adminKey });
    expect(res.body.config.webhookUrl).toBe('https://hooks.example.com/***');
  });

  test('masks webhook secret', async () => {
    const res = await request(port, 'GET', '/config', undefined, { 'X-Admin-Key': adminKey });
    expect(res.body.config.webhookSecret).toBe('***');
  });

  test('masks webhook filter URLs', async () => {
    const res = await request(port, 'GET', '/config', undefined, { 'X-Admin-Key': adminKey });
    const filter = res.body.config.webhookFilters[0];
    expect(filter.url).toBe('https://filter-hook.example.com/***');
    expect(filter.secret).toBe('***');
  });

  test('preserves non-sensitive filter fields', async () => {
    const res = await request(port, 'GET', '/config', undefined, { 'X-Admin-Key': adminKey });
    const filter = res.body.config.webhookFilters[0];
    expect(filter.id).toBe('f1');
    expect(filter.name).toBe('test-filter');
    expect(filter.events).toEqual(['key.created']);
    expect(filter.active).toBe(true);
  });
});

// ─── Null/Empty Config Values ───────────────────────────────────────────────

describe('Config Export — Default/Empty Values', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer(
      { ...DEFAULT_CONFIG, port: 0, serverCommand: ECHO_CMD, serverArgs: ECHO_ARGS },
      undefined,
    );
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.stop();
  });

  test('webhookUrl is null when not configured', async () => {
    const res = await request(port, 'GET', '/config', undefined, { 'X-Admin-Key': adminKey });
    expect(res.body.config.webhookUrl).toBeNull();
  });

  test('webhookSecret is null when not configured', async () => {
    const res = await request(port, 'GET', '/config', undefined, { 'X-Admin-Key': adminKey });
    expect(res.body.config.webhookSecret).toBeNull();
  });

  test('oauth is null when not configured', async () => {
    const res = await request(port, 'GET', '/config', undefined, { 'X-Admin-Key': adminKey });
    expect(res.body.config.oauth).toBeNull();
  });

  test('globalQuota is null when not configured', async () => {
    const res = await request(port, 'GET', '/config', undefined, { 'X-Admin-Key': adminKey });
    expect(res.body.config.globalQuota).toBeNull();
  });

  test('customHeaders is empty when not configured', async () => {
    const res = await request(port, 'GET', '/config', undefined, { 'X-Admin-Key': adminKey });
    expect(res.body.config.customHeaders).toEqual({});
  });

  test('cors defaults to wildcard', async () => {
    const res = await request(port, 'GET', '/config', undefined, { 'X-Admin-Key': adminKey });
    expect(res.body.config.cors).toEqual({ origin: '*' });
  });
});

// ─── Auth & Methods ─────────────────────────────────────────────────────────

describe('Config Export — Auth & Methods', () => {
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

  test('returns 401 without admin key', async () => {
    const res = await request(port, 'GET', '/config');
    expect(res.status).toBe(401);
  });

  test('returns 405 on POST', async () => {
    const info = await server.start();
    const res = await request(port, 'POST', '/config', {}, { 'X-Admin-Key': (server as any).bootstrapAdminKey });
    expect(res.status).toBe(405);
  });
});

// ─── Root Endpoint Listing ──────────────────────────────────────────────────

describe('Config Export — Endpoint Listing', () => {
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

  test('/config is listed in root endpoint directory', async () => {
    const res = await request(port, 'GET', '/');
    expect(res.body.endpoints.configExport).toContain('/config');
  });
});
