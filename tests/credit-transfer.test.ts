/**
 * Tests for v3.9.0 — Credit Transfers
 *
 * POST /keys/transfer — Transfer credits between API keys atomically
 * with full validation, audit trail, and webhook events.
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

// ─── Helper: HTTP request to server ───────────────────────────────────────────

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

describe('Credit Transfer — POST /keys/transfer', () => {
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

  // Helper to create a key with a given amount of credits
  async function createKey(credits: number, name?: string): Promise<string> {
    const res = await request(port, 'POST', '/keys', { credits, name }, { 'X-Admin-Key': adminKey });
    return res.body.key;
  }

  test('should transfer credits between two keys', async () => {
    const fromKey = await createKey(1000, 'source-key');
    const toKey = await createKey(200, 'dest-key');

    const res = await request(port, 'POST', '/keys/transfer', {
      from: fromKey,
      to: toKey,
      credits: 300,
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.transferred).toBe(300);
    expect(res.body.from.balance).toBe(700);
    expect(res.body.to.balance).toBe(500);
    expect(res.body.message).toContain('300');
  });

  test('should support optional memo field', async () => {
    const fromKey = await createKey(500, 'memo-source');
    const toKey = await createKey(100, 'memo-dest');

    const res = await request(port, 'POST', '/keys/transfer', {
      from: fromKey,
      to: toKey,
      credits: 50,
      memo: 'Monthly allocation',
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.memo).toBe('Monthly allocation');
  });

  test('should reject transfer with insufficient credits', async () => {
    const fromKey = await createKey(100, 'poor-source');
    const toKey = await createKey(50, 'dest');

    const res = await request(port, 'POST', '/keys/transfer', {
      from: fromKey,
      to: toKey,
      credits: 500,
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Insufficient credits');
  });

  test('should reject transfer to same key', async () => {
    const key = await createKey(500, 'self-key');

    const res = await request(port, 'POST', '/keys/transfer', {
      from: key,
      to: key,
      credits: 100,
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('same key');
  });

  test('should reject transfer with non-existent source key', async () => {
    const toKey = await createKey(100, 'exists-dest');

    const res = await request(port, 'POST', '/keys/transfer', {
      from: 'pg_nonexistent_key_12345',
      to: toKey,
      credits: 50,
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Source key not found');
  });

  test('should reject transfer with non-existent destination key', async () => {
    const fromKey = await createKey(500, 'exists-source');

    const res = await request(port, 'POST', '/keys/transfer', {
      from: fromKey,
      to: 'pg_nonexistent_key_12345',
      credits: 50,
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Destination key not found');
  });

  test('should reject transfer from revoked source key', async () => {
    const fromKey = await createKey(500, 'revoked-source');
    const toKey = await createKey(100, 'active-dest');

    // Revoke the source key
    await request(port, 'POST', '/keys/revoke', { key: fromKey }, { 'X-Admin-Key': adminKey });

    const res = await request(port, 'POST', '/keys/transfer', {
      from: fromKey,
      to: toKey,
      credits: 50,
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Source key not found');
  });

  test('should reject transfer to revoked destination key', async () => {
    const fromKey = await createKey(500, 'active-source');
    const toKey = await createKey(100, 'revoked-dest');

    // Revoke the destination key (getKey returns null for inactive keys)
    await request(port, 'POST', '/keys/revoke', { key: toKey }, { 'X-Admin-Key': adminKey });

    const res = await request(port, 'POST', '/keys/transfer', {
      from: fromKey,
      to: toKey,
      credits: 50,
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Destination key not found');
  });

  test('should reject missing from/to fields', async () => {
    const res = await request(port, 'POST', '/keys/transfer', {
      credits: 50,
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing');
  });

  test('should reject zero credits', async () => {
    const fromKey = await createKey(500, 'zero-source');
    const toKey = await createKey(100, 'zero-dest');

    const res = await request(port, 'POST', '/keys/transfer', {
      from: fromKey,
      to: toKey,
      credits: 0,
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('positive integer');
  });

  test('should reject negative credits', async () => {
    const fromKey = await createKey(500, 'neg-source');
    const toKey = await createKey(100, 'neg-dest');

    const res = await request(port, 'POST', '/keys/transfer', {
      from: fromKey,
      to: toKey,
      credits: -50,
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('positive integer');
  });

  test('should reject invalid JSON body', async () => {
    const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/keys/transfer',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Admin-Key': adminKey,
          },
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

  test('should require admin auth', async () => {
    const res = await request(port, 'POST', '/keys/transfer', {
      from: 'a', to: 'b', credits: 100,
    });

    expect(res.status).toBe(401);
  });

  test('should reject GET method', async () => {
    const res = await request(port, 'GET', '/keys/transfer', undefined, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(405);
  });

  test('should floor fractional credits', async () => {
    const fromKey = await createKey(1000, 'frac-source');
    const toKey = await createKey(100, 'frac-dest');

    const res = await request(port, 'POST', '/keys/transfer', {
      from: fromKey,
      to: toKey,
      credits: 99.7,
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.transferred).toBe(99); // floored
    expect(res.body.from.balance).toBe(901);
    expect(res.body.to.balance).toBe(199);
  });

  test('should appear in audit log', async () => {
    const fromKey = await createKey(500, 'audit-source');
    const toKey = await createKey(100, 'audit-dest');

    await request(port, 'POST', '/keys/transfer', {
      from: fromKey,
      to: toKey,
      credits: 75,
      memo: 'Audit test',
    }, { 'X-Admin-Key': adminKey });

    const auditRes = await request(port, 'GET', '/audit?types=key.credits_transferred&limit=1', undefined, { 'X-Admin-Key': adminKey });
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.events.length).toBeGreaterThanOrEqual(1);
    const event = auditRes.body.events[0];
    expect(event.type).toBe('key.credits_transferred');
    expect(event.metadata.credits).toBe(75);
    expect(event.metadata.memo).toBe('Audit test');
  });

  test('root listing should include transfer endpoint', async () => {
    const res = await request(port, 'GET', '/', undefined, {});
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain('/keys/transfer');
  });

  test('should transfer exact amount (full balance)', async () => {
    const fromKey = await createKey(250, 'exact-source');
    const toKey = await createKey(50, 'exact-dest');

    const res = await request(port, 'POST', '/keys/transfer', {
      from: fromKey,
      to: toKey,
      credits: 250,
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.from.balance).toBe(0);
    expect(res.body.to.balance).toBe(300); // 50 + 250
  });

  test('multiple transfers should be consistent', async () => {
    const fromKey = await createKey(1000, 'multi-source');
    const toKey = await createKey(50, 'multi-dest');

    // Transfer 3 times
    await request(port, 'POST', '/keys/transfer', { from: fromKey, to: toKey, credits: 200 }, { 'X-Admin-Key': adminKey });
    await request(port, 'POST', '/keys/transfer', { from: fromKey, to: toKey, credits: 300 }, { 'X-Admin-Key': adminKey });
    const res = await request(port, 'POST', '/keys/transfer', { from: fromKey, to: toKey, credits: 100 }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.from.balance).toBe(400); // 1000 - 200 - 300 - 100
    expect(res.body.to.balance).toBe(650);   // 50 + 200 + 300 + 100
  });
});
