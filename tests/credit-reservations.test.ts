/**
 * Tests for v7.3.0 — Credit Reservations
 *
 * POST /keys/reserve creates a credit hold.
 * POST /keys/reserve/commit deducts held credits.
 * POST /keys/reserve/release frees held credits.
 * GET  /keys/reserve lists active reservations.
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

describe('Credit Reservations', () => {
  async function createKey(credits = 1000, name = 'test'): Promise<string> {
    const r = await httpPost(port, '/keys', { credits, name }, { 'x-admin-key': adminKey });
    return r.body.key;
  }

  // ── Create reservation ──

  test('POST /keys/reserve creates a reservation', async () => {
    const key = await createKey(1000, 'rsv-create');
    const r = await httpPost(port, '/keys/reserve', { key, credits: 200 }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(201);
    expect(r.body.id).toMatch(/^rsv_/);
    expect(r.body.credits).toBe(200);
    expect(r.body.key).toMatch(/^pg_.+\.\.\./);
    expect(r.body.createdAt).toBeDefined();
    expect(r.body.expiresAt).toBeDefined();
    expect(r.body.available).toBe(800); // 1000 - 200
  });

  test('multiple reservations reduce available credits', async () => {
    const key = await createKey(1000, 'rsv-multi');
    const r1 = await httpPost(port, '/keys/reserve', { key, credits: 300 }, { 'x-admin-key': adminKey });
    expect(r1.body.available).toBe(700);

    const r2 = await httpPost(port, '/keys/reserve', { key, credits: 400 }, { 'x-admin-key': adminKey });
    expect(r2.body.available).toBe(300);
  });

  test('rejects reservation exceeding available credits', async () => {
    const key = await createKey(500, 'rsv-exceed');
    await httpPost(port, '/keys/reserve', { key, credits: 300 }, { 'x-admin-key': adminKey });

    const r = await httpPost(port, '/keys/reserve', { key, credits: 300 }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/insufficient/i);
    expect(r.body.available).toBe(200);
    expect(r.body.held).toBe(300);
  });

  test('respects custom ttlSeconds', async () => {
    const key = await createKey(1000, 'rsv-ttl');
    const r = await httpPost(port, '/keys/reserve', { key, credits: 100, ttlSeconds: 60 }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(201);
    const expiresAt = new Date(r.body.expiresAt).getTime();
    const createdAt = new Date(r.body.createdAt).getTime();
    // Should expire ~60s after creation
    expect(expiresAt - createdAt).toBeGreaterThanOrEqual(55000);
    expect(expiresAt - createdAt).toBeLessThanOrEqual(65000);
  });

  test('supports memo field', async () => {
    const key = await createKey(1000, 'rsv-memo');
    const r = await httpPost(port, '/keys/reserve', { key, credits: 100, memo: 'For batch processing' }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(201);
    expect(r.body.memo).toBe('For batch processing');
  });

  test('resolves alias for reservation', async () => {
    const key = await createKey(1000, 'rsv-alias');
    const alias = 'rsv-alias-' + Date.now();
    await httpPost(port, '/keys/alias', { key, alias }, { 'x-admin-key': adminKey });

    const r = await httpPost(port, '/keys/reserve', { key: alias, credits: 100 }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(201);
  });

  // ── Commit reservation ──

  test('POST /keys/reserve/commit deducts credits', async () => {
    const key = await createKey(1000, 'rsv-commit');
    const created = await httpPost(port, '/keys/reserve', { key, credits: 300 }, { 'x-admin-key': adminKey });

    const r = await httpPost(port, '/keys/reserve/commit', { reservationId: created.body.id }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.committed.credits).toBe(300);
    expect(r.body.remainingCredits).toBe(700);

    // Verify credits actually deducted
    const record = (server as any).gate.store.resolveKeyRaw(key);
    expect(record.credits).toBe(700);
  });

  test('committed reservation is removed from list', async () => {
    const key = await createKey(1000, 'rsv-commit-remove');
    const created = await httpPost(port, '/keys/reserve', { key, credits: 200 }, { 'x-admin-key': adminKey });
    await httpPost(port, '/keys/reserve/commit', { reservationId: created.body.id }, { 'x-admin-key': adminKey });

    const r = await httpGet(port, `/keys/reserve?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.body.reservations.length).toBe(0);
  });

  test('commit returns 404 for unknown reservation', async () => {
    const r = await httpPost(port, '/keys/reserve/commit', { reservationId: 'rsv_99999' }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(404);
  });

  // ── Release reservation ──

  test('POST /keys/reserve/release frees credits', async () => {
    const key = await createKey(1000, 'rsv-release');
    const created = await httpPost(port, '/keys/reserve', { key, credits: 400 }, { 'x-admin-key': adminKey });

    const r = await httpPost(port, '/keys/reserve/release', { reservationId: created.body.id }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.released.credits).toBe(400);

    // Credits should NOT be deducted
    const record = (server as any).gate.store.resolveKeyRaw(key);
    expect(record.credits).toBe(1000);
  });

  test('released reservation is removed from list', async () => {
    const key = await createKey(1000, 'rsv-release-remove');
    const created = await httpPost(port, '/keys/reserve', { key, credits: 200 }, { 'x-admin-key': adminKey });
    await httpPost(port, '/keys/reserve/release', { reservationId: created.body.id }, { 'x-admin-key': adminKey });

    const r = await httpGet(port, `/keys/reserve?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.body.reservations.length).toBe(0);
  });

  test('release returns 404 for unknown reservation', async () => {
    const r = await httpPost(port, '/keys/reserve/release', { reservationId: 'rsv_99999' }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(404);
  });

  // ── List reservations ──

  test('GET /keys/reserve lists active reservations', async () => {
    const key = await createKey(1000, 'rsv-list');
    await httpPost(port, '/keys/reserve', { key, credits: 100 }, { 'x-admin-key': adminKey });
    await httpPost(port, '/keys/reserve', { key, credits: 200 }, { 'x-admin-key': adminKey });

    const r = await httpGet(port, `/keys/reserve?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.reservations.length).toBe(2);
    expect(r.body.count).toBe(2);
    expect(r.body.totalHeld).toBe(300);
  });

  test('list filters by key', async () => {
    const key1 = await createKey(1000, 'rsv-filter-a');
    const key2 = await createKey(1000, 'rsv-filter-b');
    await httpPost(port, '/keys/reserve', { key: key1, credits: 100 }, { 'x-admin-key': adminKey });
    await httpPost(port, '/keys/reserve', { key: key2, credits: 200 }, { 'x-admin-key': adminKey });

    const r = await httpGet(port, `/keys/reserve?key=${key1}`, { 'x-admin-key': adminKey });
    expect(r.body.reservations.length).toBe(1);
    expect(r.body.totalHeld).toBe(100);
  });

  test('key is masked in list response', async () => {
    const key = await createKey(1000, 'rsv-mask');
    await httpPost(port, '/keys/reserve', { key, credits: 100 }, { 'x-admin-key': adminKey });

    const r = await httpGet(port, `/keys/reserve?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.body.reservations[0].key).toMatch(/^pg_.+\.\.\./);
  });

  // ── Audit trail ──

  test('reservation creates audit event', async () => {
    const key = await createKey(1000, 'rsv-audit-create');
    await httpPost(port, '/keys/reserve', { key, credits: 100 }, { 'x-admin-key': adminKey });

    const r = await httpGet(port, '/audit?types=credits.reserved', { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBeGreaterThanOrEqual(1);
    expect(r.body.events[0].type).toBe('credits.reserved');
  });

  test('commit creates audit event', async () => {
    const key = await createKey(1000, 'rsv-audit-commit');
    const created = await httpPost(port, '/keys/reserve', { key, credits: 100 }, { 'x-admin-key': adminKey });
    await httpPost(port, '/keys/reserve/commit', { reservationId: created.body.id }, { 'x-admin-key': adminKey });

    const r = await httpGet(port, '/audit?types=credits.committed', { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBeGreaterThanOrEqual(1);
    expect(r.body.events[0].type).toBe('credits.committed');
  });

  test('release creates audit event', async () => {
    const key = await createKey(1000, 'rsv-audit-release');
    const created = await httpPost(port, '/keys/reserve', { key, credits: 100 }, { 'x-admin-key': adminKey });
    await httpPost(port, '/keys/reserve/release', { reservationId: created.body.id }, { 'x-admin-key': adminKey });

    const r = await httpGet(port, '/audit?types=credits.released', { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBeGreaterThanOrEqual(1);
    expect(r.body.events[0].type).toBe('credits.released');
  });

  // ── Validation & error cases ──

  test('requires admin key for GET', async () => {
    const r = await httpGet(port, '/keys/reserve');
    expect(r.status).toBe(401);
  });

  test('requires admin key for POST', async () => {
    const r = await httpPost(port, '/keys/reserve', { key: 'pg_fake', credits: 100 });
    expect(r.status).toBe(401);
  });

  test('requires admin key for commit', async () => {
    const r = await httpPost(port, '/keys/reserve/commit', { reservationId: 'rsv_1' });
    expect(r.status).toBe(401);
  });

  test('requires admin key for release', async () => {
    const r = await httpPost(port, '/keys/reserve/release', { reservationId: 'rsv_1' });
    expect(r.status).toBe(401);
  });

  test('POST requires key field', async () => {
    const r = await httpPost(port, '/keys/reserve', { credits: 100 }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/key/i);
  });

  test('POST requires credits field', async () => {
    const key = await createKey(1000, 'rsv-no-credits');
    const r = await httpPost(port, '/keys/reserve', { key }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/credits/i);
  });

  test('POST rejects zero credits', async () => {
    const key = await createKey(1000, 'rsv-zero');
    const r = await httpPost(port, '/keys/reserve', { key, credits: 0 }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
  });

  test('POST rejects negative credits', async () => {
    const key = await createKey(1000, 'rsv-neg');
    const r = await httpPost(port, '/keys/reserve', { key, credits: -50 }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
  });

  test('POST returns 404 for unknown key', async () => {
    const r = await httpPost(port, '/keys/reserve', { key: 'pg_nonexistent', credits: 100 }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(404);
  });

  test('POST rejects revoked key', async () => {
    const key = await createKey(1000, 'rsv-revoked');
    await httpPost(port, '/keys/revoke', { key }, { 'x-admin-key': adminKey });

    const r = await httpPost(port, '/keys/reserve', { key, credits: 100 }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/revoked/i);
  });

  test('POST rejects suspended key', async () => {
    const key = await createKey(1000, 'rsv-suspended');
    await httpPost(port, '/keys/suspend', { key }, { 'x-admin-key': adminKey });

    const r = await httpPost(port, '/keys/reserve', { key, credits: 100 }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/suspended/i);
  });

  test('commit requires reservationId', async () => {
    const r = await httpPost(port, '/keys/reserve/commit', {}, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/reservationId/i);
  });

  test('release requires reservationId', async () => {
    const r = await httpPost(port, '/keys/reserve/release', {}, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/reservationId/i);
  });

  test('POST rejects invalid JSON', async () => {
    const r = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/keys/reserve', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey } },
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
      req.end('not json');
    });
    expect(r.status).toBe(400);
  });

  test('PUT /keys/reserve returns 405', async () => {
    const r = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/keys/reserve', method: 'PUT', headers: { 'x-admin-key': adminKey } },
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

  test('GET /keys/reserve returns 404 for unknown key', async () => {
    const r = await httpGet(port, '/keys/reserve?key=pg_nonexistent', { 'x-admin-key': adminKey });
    expect(r.status).toBe(404);
  });

  test('appears in root listing', async () => {
    const r = await httpGet(port, '/', { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.endpoints.creditReservations).toBeDefined();
    expect(r.body.endpoints.creditReservations).toMatch(/reserve/i);
  });
});
