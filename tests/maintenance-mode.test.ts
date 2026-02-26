/**
 * Tests for v6.8.0 — Maintenance Mode
 *
 * POST /maintenance enables/disables maintenance mode.
 * GET /maintenance checks current status.
 * When enabled, /mcp returns 503 with custom message; admin endpoints stay operational.
 */

import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';
import http from 'http';

/* ── helpers ─────────────────────────────────────────────── */

const ECHO_CMD = process.execPath;
const ECHO_ARGS = ['-e', `process.stdin.resume(); process.stdin.on('data', d => { const r = JSON.parse(d.toString().trim()); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: {} }) + '\\n'); });`];

function makeServer(overrides: Record<string, any> = {}): PayGateServer {
  return new PayGateServer({
    ...DEFAULT_CONFIG,
    serverCommand: ECHO_CMD,
    serverArgs: ECHO_ARGS,
    port: 0,
    ...overrides,
  });
}

function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        let buf = '';
        res.on('data', (c: Buffer) => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode!, body: buf }); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function httpPost(port: number, path: string, body: any, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let buf = '';
        res.on('data', (c: Buffer) => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode!, body: buf }); }
        });
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

/* ── setup ───────────────────────────────────────────────── */

let server: PayGateServer;
let port: number;
let adminKey: string;

beforeAll(async () => {
  server = makeServer();
  const started = await server.start();
  port = started.port;
  adminKey = started.adminKey;
});

afterAll(async () => {
  await server?.stop();
});

/* ── tests ───────────────────────────────────────────────── */

describe('Maintenance Mode', () => {
  afterEach(async () => {
    // Always disable maintenance mode after each test
    await httpPost(port, '/maintenance', { enabled: false }, { 'x-admin-key': adminKey });
  });

  test('GET /maintenance starts disabled', async () => {
    const r = await httpGet(port, '/maintenance', { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(false);
    expect(r.body.message).toBeUndefined();
    expect(r.body.since).toBeNull();
  });

  test('POST /maintenance enables with default message', async () => {
    const r = await httpPost(port, '/maintenance', { enabled: true }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.message).toBe('Server is under maintenance');
    expect(r.body.since).toBeDefined();
  });

  test('POST /maintenance enables with custom message', async () => {
    const r = await httpPost(port, '/maintenance', { enabled: true, message: 'Upgrading to v7' }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.message).toBe('Upgrading to v7');
  });

  test('POST /maintenance disables', async () => {
    await httpPost(port, '/maintenance', { enabled: true }, { 'x-admin-key': adminKey });
    const r = await httpPost(port, '/maintenance', { enabled: false }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(false);
    expect(r.body.message).toBeUndefined();
    expect(r.body.since).toBeNull();
  });

  test('/mcp returns 503 when maintenance enabled', async () => {
    await httpPost(port, '/maintenance', { enabled: true, message: 'Down for maintenance' }, { 'x-admin-key': adminKey });
    const r = await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { 'x-api-key': 'pg_fake' });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('Down for maintenance');
  });

  test('/mcp works after maintenance disabled', async () => {
    await httpPost(port, '/maintenance', { enabled: true }, { 'x-admin-key': adminKey });
    await httpPost(port, '/maintenance', { enabled: false }, { 'x-admin-key': adminKey });
    // /mcp should no longer return 503 — it might return 401 (no valid key) or other, but NOT 503
    const r = await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { 'x-api-key': 'pg_fake' });
    expect(r.status).not.toBe(503);
  });

  test('admin endpoints work during maintenance', async () => {
    await httpPost(port, '/maintenance', { enabled: true }, { 'x-admin-key': adminKey });
    // Create key should work
    const r = await httpPost(port, '/keys', { credits: 100, name: 'during-maint' }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(201);
    expect(r.body.key).toBeDefined();
  });

  test('GET /health reflects maintenance status', async () => {
    await httpPost(port, '/maintenance', { enabled: true }, { 'x-admin-key': adminKey });
    const r = await httpGet(port, '/health');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('maintenance');
  });

  test('GET /health shows healthy when maintenance disabled', async () => {
    const r = await httpGet(port, '/health');
    expect(r.body.status).toBe('healthy');
  });

  test('GET /maintenance after enable shows since timestamp', async () => {
    const before = new Date().toISOString();
    await httpPost(port, '/maintenance', { enabled: true }, { 'x-admin-key': adminKey });
    const r = await httpGet(port, '/maintenance', { 'x-admin-key': adminKey });
    expect(r.body.since).toBeDefined();
    expect(r.body.since >= before).toBe(true);
  });

  test('requires admin key for GET /maintenance', async () => {
    const r = await httpGet(port, '/maintenance');
    expect(r.status).toBe(401);
  });

  test('requires admin key for POST /maintenance', async () => {
    const r = await httpPost(port, '/maintenance', { enabled: true });
    expect(r.status).toBe(401);
  });

  test('POST /maintenance requires enabled field', async () => {
    const r = await httpPost(port, '/maintenance', { message: 'oops' }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/enabled/i);
  });

  test('POST /maintenance rejects invalid JSON', async () => {
    const r = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/maintenance', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey } },
        (res) => {
          let buf = '';
          res.on('data', (c: Buffer) => (buf += c));
          res.on('end', () => {
            try { resolve({ status: res.statusCode!, body: JSON.parse(buf) }); }
            catch { resolve({ status: res.statusCode!, body: buf }); }
          });
        }
      );
      req.on('error', reject);
      req.end('not valid json');
    });
    expect(r.status).toBe(400);
  });

  test('PUT /maintenance returns 405', async () => {
    const r = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/maintenance', method: 'PUT', headers: { 'x-admin-key': adminKey } },
        (res) => {
          let buf = '';
          res.on('data', (c: Buffer) => (buf += c));
          res.on('end', () => {
            try { resolve({ status: res.statusCode!, body: JSON.parse(buf) }); }
            catch { resolve({ status: res.statusCode!, body: buf }); }
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(r.status).toBe(405);
  });

  test('appears in root listing', async () => {
    const r = await httpGet(port, '/', { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.endpoints.maintenance).toBeDefined();
    expect(r.body.endpoints.maintenance).toMatch(/maintenance/i);
  });

  test('re-enabling updates message and since', async () => {
    await httpPost(port, '/maintenance', { enabled: true, message: 'First' }, { 'x-admin-key': adminKey });
    const r1 = await httpGet(port, '/maintenance', { 'x-admin-key': adminKey });
    const since1 = r1.body.since;

    // Small delay to get different timestamp
    await new Promise(r => setTimeout(r, 10));

    // Re-enable with different message
    await httpPost(port, '/maintenance', { enabled: false }, { 'x-admin-key': adminKey });
    await httpPost(port, '/maintenance', { enabled: true, message: 'Second' }, { 'x-admin-key': adminKey });
    const r2 = await httpGet(port, '/maintenance', { 'x-admin-key': adminKey });
    expect(r2.body.message).toBe('Second');
    expect(r2.body.since).not.toBe(since1);
  });

  test('audit trail records enable/disable', async () => {
    await httpPost(port, '/maintenance', { enabled: true, message: 'Audit test' }, { 'x-admin-key': adminKey });
    await httpPost(port, '/maintenance', { enabled: false }, { 'x-admin-key': adminKey });

    const r = await httpGet(port, '/audit?types=maintenance.enabled', { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBeGreaterThanOrEqual(1);
    expect(r.body.events[0].type).toBe('maintenance.enabled');

    const r2 = await httpGet(port, '/audit?types=maintenance.disabled', { 'x-admin-key': adminKey });
    expect(r2.status).toBe(200);
    expect(r2.body.events.length).toBeGreaterThanOrEqual(1);
    expect(r2.body.events[0].type).toBe('maintenance.disabled');
  });
});
