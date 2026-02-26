/**
 * Tests for v7.1.0 — Scheduled Actions
 *
 * POST /keys/schedule creates a future-dated action (revoke/suspend/topup).
 * GET  /keys/schedule lists pending schedules, optional ?key= filter.
 * DELETE /keys/schedule?id=... cancels a pending schedule.
 * Background timer executes due actions automatically.
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

function httpDelete(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'DELETE', headers },
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

describe('Scheduled Actions', () => {
  async function createKey(credits = 1000, name = 'test'): Promise<string> {
    const r = await httpPost(port, '/keys', { credits, name }, { 'x-admin-key': adminKey });
    return r.body.key;
  }

  const futureDate = () => new Date(Date.now() + 3600_000).toISOString(); // +1h

  test('GET /keys/schedule returns empty array initially', async () => {
    const r = await httpGet(port, '/keys/schedule', { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.schedules).toEqual([]);
    expect(r.body.count).toBe(0);
  });

  test('POST /keys/schedule creates a revoke schedule', async () => {
    const key = await createKey(100, 'sched-revoke');
    const r = await httpPost(port, '/keys/schedule', {
      key, action: 'revoke', executeAt: futureDate(),
    }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(201);
    expect(r.body.id).toMatch(/^sched_/);
    expect(r.body.action).toBe('revoke');
    expect(r.body.key).toMatch(/^pg_.+\.\.\./);
    expect(r.body.executeAt).toBeDefined();
    expect(r.body.createdAt).toBeDefined();
  });

  test('POST /keys/schedule creates a suspend schedule', async () => {
    const key = await createKey(100, 'sched-suspend');
    const r = await httpPost(port, '/keys/schedule', {
      key, action: 'suspend', executeAt: futureDate(),
    }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(201);
    expect(r.body.action).toBe('suspend');
  });

  test('POST /keys/schedule creates a topup schedule', async () => {
    const key = await createKey(100, 'sched-topup');
    const r = await httpPost(port, '/keys/schedule', {
      key, action: 'topup', executeAt: futureDate(), params: { credits: 500 },
    }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(201);
    expect(r.body.action).toBe('topup');
    expect(r.body.params).toEqual({ credits: 500 });
  });

  test('GET /keys/schedule lists all pending schedules', async () => {
    const key = await createKey(100, 'sched-list');
    await httpPost(port, '/keys/schedule', { key, action: 'revoke', executeAt: futureDate() }, { 'x-admin-key': adminKey });
    await httpPost(port, '/keys/schedule', { key, action: 'suspend', executeAt: futureDate() }, { 'x-admin-key': adminKey });

    const r = await httpGet(port, '/keys/schedule', { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.schedules.length).toBeGreaterThanOrEqual(2);
    expect(r.body.count).toBe(r.body.schedules.length);
  });

  test('GET /keys/schedule?key= filters by key', async () => {
    const key1 = await createKey(100, 'sched-filter-a');
    const key2 = await createKey(100, 'sched-filter-b');
    await httpPost(port, '/keys/schedule', { key: key1, action: 'revoke', executeAt: futureDate() }, { 'x-admin-key': adminKey });
    await httpPost(port, '/keys/schedule', { key: key2, action: 'suspend', executeAt: futureDate() }, { 'x-admin-key': adminKey });

    const r = await httpGet(port, `/keys/schedule?key=${key1}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.schedules.length).toBe(1);
    expect(r.body.schedules[0].action).toBe('revoke');
  });

  test('key is masked in response', async () => {
    const key = await createKey(100, 'sched-masked');
    const r = await httpPost(port, '/keys/schedule', {
      key, action: 'revoke', executeAt: futureDate(),
    }, { 'x-admin-key': adminKey });
    expect(r.body.key).toMatch(/^pg_.+\.\.\./);
    expect(r.body.key).not.toBe(key);
  });

  test('DELETE /keys/schedule?id= cancels a schedule', async () => {
    const key = await createKey(100, 'sched-cancel');
    const created = await httpPost(port, '/keys/schedule', {
      key, action: 'revoke', executeAt: futureDate(),
    }, { 'x-admin-key': adminKey });
    const scheduleId = created.body.id;

    const r = await httpDelete(port, `/keys/schedule?id=${scheduleId}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.cancelled.id).toBe(scheduleId);
    expect(r.body.cancelled.action).toBe('revoke');
  });

  test('cancelled schedule no longer appears in list', async () => {
    const key = await createKey(100, 'sched-cancel-verify');
    const created = await httpPost(port, '/keys/schedule', {
      key, action: 'suspend', executeAt: futureDate(),
    }, { 'x-admin-key': adminKey });
    await httpDelete(port, `/keys/schedule?id=${created.body.id}`, { 'x-admin-key': adminKey });

    const r = await httpGet(port, `/keys/schedule?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.body.schedules.length).toBe(0);
  });

  test('resolves alias to key for GET', async () => {
    const key = await createKey(100, 'sched-alias');
    const alias = 'sched-alias-' + Date.now();
    await httpPost(port, '/keys/alias', { key, alias }, { 'x-admin-key': adminKey });
    await httpPost(port, '/keys/schedule', { key, action: 'revoke', executeAt: futureDate() }, { 'x-admin-key': adminKey });

    const r = await httpGet(port, `/keys/schedule?key=${alias}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.schedules.length).toBe(1);
  });

  test('resolves alias to key for POST', async () => {
    const key = await createKey(100, 'sched-alias-post');
    const alias = 'sched-alias-post-' + Date.now();
    await httpPost(port, '/keys/alias', { key, alias }, { 'x-admin-key': adminKey });

    const r = await httpPost(port, '/keys/schedule', {
      key: alias, action: 'suspend', executeAt: futureDate(),
    }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(201);
  });

  // ── execution tests ──

  test('due actions are executed (revoke)', async () => {
    const key = await createKey(100, 'sched-exec-revoke');
    const pastDate = new Date(Date.now() + 100).toISOString();

    await httpPost(port, '/keys/schedule', {
      key, action: 'revoke', executeAt: pastDate,
    }, { 'x-admin-key': adminKey });

    // Wait for the schedule to become due, then manually trigger
    await new Promise(r => setTimeout(r, 200));
    (server as any).executeScheduledActions();

    // Key should now be revoked — check via gate store directly
    const record = (server as any).gate.store.resolveKeyRaw(key);
    expect(record.active).toBe(false);
  });

  test('due actions are executed (suspend)', async () => {
    const key = await createKey(100, 'sched-exec-suspend');
    const pastDate = new Date(Date.now() + 100).toISOString();

    await httpPost(port, '/keys/schedule', {
      key, action: 'suspend', executeAt: pastDate,
    }, { 'x-admin-key': adminKey });

    await new Promise(r => setTimeout(r, 200));
    (server as any).executeScheduledActions();

    const record = (server as any).gate.store.resolveKeyRaw(key);
    expect(record.suspended).toBe(true);
  });

  test('due actions are executed (topup)', async () => {
    const key = await createKey(100, 'sched-exec-topup');
    const pastDate = new Date(Date.now() + 100).toISOString();

    await httpPost(port, '/keys/schedule', {
      key, action: 'topup', executeAt: pastDate, params: { credits: 500 },
    }, { 'x-admin-key': adminKey });

    await new Promise(r => setTimeout(r, 200));
    (server as any).executeScheduledActions();

    const record = (server as any).gate.store.resolveKeyRaw(key);
    expect(record.credits).toBe(600); // 100 + 500
  });

  test('executed schedule is removed from list', async () => {
    const key = await createKey(100, 'sched-exec-remove');
    const pastDate = new Date(Date.now() + 100).toISOString();

    await httpPost(port, '/keys/schedule', {
      key, action: 'revoke', executeAt: pastDate,
    }, { 'x-admin-key': adminKey });

    await new Promise(r => setTimeout(r, 200));
    (server as any).executeScheduledActions();

    const r = await httpGet(port, `/keys/schedule?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.body.schedules.length).toBe(0);
  });

  // ── audit trail ──

  test('schedule creation creates audit event', async () => {
    const key = await createKey(100, 'sched-audit-create');
    await httpPost(port, '/keys/schedule', {
      key, action: 'revoke', executeAt: futureDate(),
    }, { 'x-admin-key': adminKey });

    const r = await httpGet(port, '/audit?types=schedule.created', { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBeGreaterThanOrEqual(1);
    expect(r.body.events[0].type).toBe('schedule.created');
  });

  test('schedule cancellation creates audit event', async () => {
    const key = await createKey(100, 'sched-audit-cancel');
    const created = await httpPost(port, '/keys/schedule', {
      key, action: 'suspend', executeAt: futureDate(),
    }, { 'x-admin-key': adminKey });
    await httpDelete(port, `/keys/schedule?id=${created.body.id}`, { 'x-admin-key': adminKey });

    const r = await httpGet(port, '/audit?types=schedule.cancelled', { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBeGreaterThanOrEqual(1);
    expect(r.body.events[0].type).toBe('schedule.cancelled');
  });

  test('schedule execution creates audit event', async () => {
    const key = await createKey(100, 'sched-audit-exec');
    const pastDate = new Date(Date.now() + 100).toISOString();

    await httpPost(port, '/keys/schedule', {
      key, action: 'revoke', executeAt: pastDate,
    }, { 'x-admin-key': adminKey });

    await new Promise(r => setTimeout(r, 200));
    (server as any).executeScheduledActions();

    const r = await httpGet(port, '/audit?types=schedule.executed', { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBeGreaterThanOrEqual(1);
    expect(r.body.events[0].type).toBe('schedule.executed');
  });

  // ── validation + error cases ──

  test('requires admin key for GET', async () => {
    const r = await httpGet(port, '/keys/schedule');
    expect(r.status).toBe(401);
  });

  test('requires admin key for POST', async () => {
    const r = await httpPost(port, '/keys/schedule', { key: 'pg_fake', action: 'revoke', executeAt: futureDate() });
    expect(r.status).toBe(401);
  });

  test('requires admin key for DELETE', async () => {
    const r = await httpDelete(port, '/keys/schedule?id=sched_1');
    expect(r.status).toBe(401);
  });

  test('POST requires key field', async () => {
    const r = await httpPost(port, '/keys/schedule', { action: 'revoke', executeAt: futureDate() }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/key/i);
  });

  test('POST requires valid action', async () => {
    const key = await createKey(100, 'sched-bad-action');
    const r = await httpPost(port, '/keys/schedule', {
      key, action: 'delete', executeAt: futureDate(),
    }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/action/i);
  });

  test('POST requires executeAt field', async () => {
    const key = await createKey(100, 'sched-no-time');
    const r = await httpPost(port, '/keys/schedule', {
      key, action: 'revoke',
    }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/executeAt/i);
  });

  test('POST rejects invalid timestamp', async () => {
    const key = await createKey(100, 'sched-bad-time');
    const r = await httpPost(port, '/keys/schedule', {
      key, action: 'revoke', executeAt: 'not-a-date',
    }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/timestamp/i);
  });

  test('POST rejects past timestamp', async () => {
    const key = await createKey(100, 'sched-past');
    const r = await httpPost(port, '/keys/schedule', {
      key, action: 'revoke', executeAt: new Date(Date.now() - 60000).toISOString(),
    }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/future/i);
  });

  test('POST requires credits for topup action', async () => {
    const key = await createKey(100, 'sched-topup-no-creds');
    const r = await httpPost(port, '/keys/schedule', {
      key, action: 'topup', executeAt: futureDate(),
    }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/credits/i);
  });

  test('POST rejects topup with zero credits', async () => {
    const key = await createKey(100, 'sched-topup-zero');
    const r = await httpPost(port, '/keys/schedule', {
      key, action: 'topup', executeAt: futureDate(), params: { credits: 0 },
    }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/credits/i);
  });

  test('POST returns 404 for unknown key', async () => {
    const r = await httpPost(port, '/keys/schedule', {
      key: 'pg_nonexistent', action: 'revoke', executeAt: futureDate(),
    }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(404);
  });

  test('GET returns 404 for unknown key filter', async () => {
    const r = await httpGet(port, '/keys/schedule?key=pg_nonexistent', { 'x-admin-key': adminKey });
    expect(r.status).toBe(404);
  });

  test('DELETE returns 404 for unknown schedule ID', async () => {
    const r = await httpDelete(port, '/keys/schedule?id=sched_99999', { 'x-admin-key': adminKey });
    expect(r.status).toBe(404);
  });

  test('DELETE requires id param', async () => {
    const r = await httpDelete(port, '/keys/schedule', { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
  });

  test('max 20 schedules per key', async () => {
    const key = await createKey(100, 'sched-max');
    for (let i = 0; i < 20; i++) {
      await httpPost(port, '/keys/schedule', {
        key, action: 'revoke', executeAt: futureDate(),
      }, { 'x-admin-key': adminKey });
    }
    const r = await httpPost(port, '/keys/schedule', {
      key, action: 'revoke', executeAt: futureDate(),
    }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/20/);
  });

  test('POST rejects invalid JSON', async () => {
    const r = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/keys/schedule', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey } },
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

  test('PUT returns 405', async () => {
    const r = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/keys/schedule', method: 'PUT', headers: { 'x-admin-key': adminKey } },
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
    expect(r.body.endpoints.keySchedule).toBeDefined();
    expect(r.body.endpoints.keySchedule).toMatch(/schedule/i);
  });
});
