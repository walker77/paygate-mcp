/**
 * Tests for v4.0.0 — Bulk Key Operations
 *
 * POST /keys/bulk — Execute multiple key operations (create, topup, revoke) in one request.
 */

import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';
import http from 'http';

// ─── Echo MCP backend ─────────────────────────────────────────────────────────

const ECHO_CMD = 'node';
const ECHO_ARGS = ['-e', `
  process.stdin.resume();
  process.stdin.on('data', d => {
    const r = JSON.parse(d.toString().trim());
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: {} }) + '\\n');
  });
`];

// ─── Helper: HTTP request ─────────────────────────────────────────────────────

function request(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => (buf += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(buf) });
          } catch {
            resolve({ status: res.statusCode!, body: buf });
          }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Bulk Key Operations — POST /keys/bulk', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      ...DEFAULT_CONFIG,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      port: 0,
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop();
  });

  test('should create multiple keys in one request', async () => {
    const res = await request(port, 'POST', '/keys/bulk', {
      operations: [
        { action: 'create', name: 'bulk-key-1', credits: 500 },
        { action: 'create', name: 'bulk-key-2', credits: 300 },
        { action: 'create', name: 'bulk-key-3', credits: 100 },
      ],
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.succeeded).toBe(3);
    expect(res.body.failed).toBe(0);
    expect(res.body.results[0].result.key).toBeDefined();
    expect(res.body.results[0].result.credits).toBe(500);
    expect(res.body.results[1].result.credits).toBe(300);
    expect(res.body.results[2].result.credits).toBe(100);
  });

  test('should handle mixed create and topup operations', async () => {
    // First create a key to topup
    const createRes = await request(port, 'POST', '/keys', { credits: 200, name: 'topup-target' }, { 'X-Admin-Key': adminKey });
    const existingKey = createRes.body.key;

    const res = await request(port, 'POST', '/keys/bulk', {
      operations: [
        { action: 'create', name: 'new-key', credits: 100 },
        { action: 'topup', key: existingKey, credits: 300 },
      ],
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.succeeded).toBe(2);
    expect(res.body.results[1].result.creditsAdded).toBe(300);
    expect(res.body.results[1].result.newBalance).toBe(500); // 200 + 300
  });

  test('should handle create, topup, and revoke together', async () => {
    const createRes = await request(port, 'POST', '/keys', { credits: 100, name: 'to-revoke' }, { 'X-Admin-Key': adminKey });
    const keyToRevoke = createRes.body.key;

    const createRes2 = await request(port, 'POST', '/keys', { credits: 50, name: 'to-topup' }, { 'X-Admin-Key': adminKey });
    const keyToTopup = createRes2.body.key;

    const res = await request(port, 'POST', '/keys/bulk', {
      operations: [
        { action: 'create', name: 'fresh-key', credits: 250 },
        { action: 'topup', key: keyToTopup, credits: 100 },
        { action: 'revoke', key: keyToRevoke },
      ],
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.succeeded).toBe(3);
    expect(res.body.results[0].action).toBe('create');
    expect(res.body.results[1].action).toBe('topup');
    expect(res.body.results[2].action).toBe('revoke');
  });

  test('should continue processing after individual failures', async () => {
    const res = await request(port, 'POST', '/keys/bulk', {
      operations: [
        { action: 'create', name: 'good-key', credits: 100 },
        { action: 'topup', key: 'pg_nonexistent_key', credits: 50 },
        { action: 'create', name: 'another-good-key', credits: 200 },
      ],
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.succeeded).toBe(2);
    expect(res.body.failed).toBe(1);
    expect(res.body.results[0].success).toBe(true);
    expect(res.body.results[1].success).toBe(false);
    expect(res.body.results[1].error).toContain('not found');
    expect(res.body.results[2].success).toBe(true);
  });

  test('should reject unknown action types', async () => {
    const res = await request(port, 'POST', '/keys/bulk', {
      operations: [
        { action: 'delete', key: 'pg_some_key' },
        { action: 'create', name: 'valid-key', credits: 100 },
      ],
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.succeeded).toBe(1);
    expect(res.body.failed).toBe(1);
    expect(res.body.results[0].success).toBe(false);
    expect(res.body.results[0].error).toContain('Unknown action');
    expect(res.body.results[1].success).toBe(true);
  });

  test('should reject empty operations array', async () => {
    const res = await request(port, 'POST', '/keys/bulk', {
      operations: [],
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('empty');
  });

  test('should reject missing operations field', async () => {
    const res = await request(port, 'POST', '/keys/bulk', {}, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('operations');
  });

  test('should reject more than 100 operations', async () => {
    const operations = Array.from({ length: 101 }, (_, i) => ({
      action: 'create', name: `key-${i}`, credits: 10,
    }));

    const res = await request(port, 'POST', '/keys/bulk', { operations }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('100');
  });

  test('should require admin auth', async () => {
    const res = await request(port, 'POST', '/keys/bulk', {
      operations: [{ action: 'create', name: 'test', credits: 100 }],
    });

    expect(res.status).toBe(401);
  });

  test('should reject GET method', async () => {
    const res = await request(port, 'GET', '/keys/bulk', undefined, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(405);
  });

  test('should reject invalid JSON', async () => {
    const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/keys/bulk',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
        },
        (res) => {
          let buf = '';
          res.on('data', (chunk) => (buf += chunk));
          res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(buf) }));
        },
      );
      req.on('error', reject);
      req.write('not json');
      req.end();
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid JSON');
  });

  test('should handle topup with missing key gracefully', async () => {
    const res = await request(port, 'POST', '/keys/bulk', {
      operations: [
        { action: 'topup', credits: 50 },
      ],
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.results[0].success).toBe(false);
    expect(res.body.results[0].error).toContain('Missing key');
  });

  test('should handle revoke with missing key gracefully', async () => {
    const res = await request(port, 'POST', '/keys/bulk', {
      operations: [
        { action: 'revoke' },
      ],
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.results[0].success).toBe(false);
    expect(res.body.results[0].error).toContain('Missing key');
  });

  test('should handle topup with zero credits', async () => {
    const createRes = await request(port, 'POST', '/keys', { credits: 100, name: 'zero-topup' }, { 'X-Admin-Key': adminKey });

    const res = await request(port, 'POST', '/keys/bulk', {
      operations: [
        { action: 'topup', key: createRes.body.key, credits: 0 },
      ],
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.results[0].success).toBe(false);
    expect(res.body.results[0].error).toContain('positive');
  });

  test('result indices should match operation order', async () => {
    const res = await request(port, 'POST', '/keys/bulk', {
      operations: [
        { action: 'create', name: 'idx-0', credits: 10 },
        { action: 'create', name: 'idx-1', credits: 20 },
        { action: 'create', name: 'idx-2', credits: 30 },
      ],
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.results[0].index).toBe(0);
    expect(res.body.results[1].index).toBe(1);
    expect(res.body.results[2].index).toBe(2);
  });

  test('audit log should record bulk operations', async () => {
    await request(port, 'POST', '/keys/bulk', {
      operations: [
        { action: 'create', name: 'audit-bulk-key', credits: 100 },
      ],
    }, { 'X-Admin-Key': adminKey });

    const auditRes = await request(port, 'GET', '/audit?types=key.created&limit=1', undefined, { 'X-Admin-Key': adminKey });
    expect(auditRes.status).toBe(200);
    const events = auditRes.body.events;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].message).toContain('bulk');
  });

  test('root listing should include bulk endpoint', async () => {
    const res = await request(port, 'GET', '/', undefined, {});
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain('/keys/bulk');
  });

  test('should create keys with tags', async () => {
    const res = await request(port, 'POST', '/keys/bulk', {
      operations: [
        { action: 'create', name: 'tagged-key', credits: 100, tags: { env: 'production', team: 'backend' } },
      ],
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.results[0].success).toBe(true);

    // Verify tags were set via /status (listKeys strips full key, returns keyPrefix + name)
    const statusRes = await request(port, 'GET', '/status', undefined, { 'X-Admin-Key': adminKey });
    const keyEntry = statusRes.body.keys.find((k: any) => k.name === 'tagged-key');
    expect(keyEntry).toBeDefined();
    expect(keyEntry.tags).toEqual({ env: 'production', team: 'backend' });
  });

  test('should handle revoke of non-existent key', async () => {
    const res = await request(port, 'POST', '/keys/bulk', {
      operations: [
        { action: 'revoke', key: 'pg_does_not_exist_12345678' },
      ],
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.results[0].success).toBe(false);
    expect(res.body.results[0].error).toContain('not found');
  });
});
