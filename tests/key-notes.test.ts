/**
 * Tests for v7.0.0 — Key Notes
 *
 * POST /keys/notes adds a timestamped note to an API key.
 * GET /keys/notes?key=... returns all notes for a key.
 * DELETE /keys/notes?key=...&index=N removes a specific note.
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

describe('Key Notes', () => {
  async function createKey(credits = 1000, name = 'test'): Promise<string> {
    const r = await httpPost(port, '/keys', { credits, name }, { 'x-admin-key': adminKey });
    return r.body.key;
  }

  test('GET /keys/notes returns empty array for new key', async () => {
    const key = await createKey(100, 'empty-notes');
    const r = await httpGet(port, `/keys/notes?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.notes).toEqual([]);
    expect(r.body.count).toBe(0);
  });

  test('POST /keys/notes adds a note', async () => {
    const key = await createKey(100, 'add-note');
    const r = await httpPost(port, '/keys/notes', { key, text: 'Initial setup completed' }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(201);
    expect(r.body.note.text).toBe('Initial setup completed');
    expect(r.body.note.author).toBe('admin');
    expect(r.body.note.timestamp).toBeDefined();
    expect(r.body.count).toBe(1);
  });

  test('notes persist after adding', async () => {
    const key = await createKey(100, 'persist-notes');
    await httpPost(port, '/keys/notes', { key, text: 'Note one' }, { 'x-admin-key': adminKey });
    await httpPost(port, '/keys/notes', { key, text: 'Note two' }, { 'x-admin-key': adminKey });

    const r = await httpGet(port, `/keys/notes?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.notes.length).toBe(2);
    expect(r.body.notes[0].text).toBe('Note one');
    expect(r.body.notes[1].text).toBe('Note two');
    expect(r.body.count).toBe(2);
  });

  test('key is masked in GET response', async () => {
    const key = await createKey(100, 'masked-note');
    await httpPost(port, '/keys/notes', { key, text: 'Test' }, { 'x-admin-key': adminKey });
    const r = await httpGet(port, `/keys/notes?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.body.key).toMatch(/^pg_.+\.\.\./);
    expect(r.body.key).not.toBe(key);
  });

  test('DELETE /keys/notes removes a note by index', async () => {
    const key = await createKey(100, 'delete-note');
    await httpPost(port, '/keys/notes', { key, text: 'Keep this' }, { 'x-admin-key': adminKey });
    await httpPost(port, '/keys/notes', { key, text: 'Delete this' }, { 'x-admin-key': adminKey });
    await httpPost(port, '/keys/notes', { key, text: 'Also keep' }, { 'x-admin-key': adminKey });

    const r = await httpDelete(port, `/keys/notes?key=${key}&index=1`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.deleted.text).toBe('Delete this');
    expect(r.body.remaining).toBe(2);

    // Verify remaining notes
    const r2 = await httpGet(port, `/keys/notes?key=${key}`, { 'x-admin-key': adminKey });
    expect(r2.body.notes.length).toBe(2);
    expect(r2.body.notes[0].text).toBe('Keep this');
    expect(r2.body.notes[1].text).toBe('Also keep');
  });

  test('note text is trimmed', async () => {
    const key = await createKey(100, 'trim-note');
    const r = await httpPost(port, '/keys/notes', { key, text: '  Trimmed text  ' }, { 'x-admin-key': adminKey });
    expect(r.body.note.text).toBe('Trimmed text');
  });

  test('resolves alias to key', async () => {
    const key = await createKey(100, 'alias-notes');
    const alias = 'notes-alias-' + Date.now();
    await httpPost(port, '/keys/alias', { key, alias }, { 'x-admin-key': adminKey });

    await httpPost(port, '/keys/notes', { key: alias, text: 'Via alias' }, { 'x-admin-key': adminKey });
    const r = await httpGet(port, `/keys/notes?key=${alias}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.notes[0].text).toBe('Via alias');
  });

  test('works on suspended key', async () => {
    const key = await createKey(100, 'suspended-notes');
    await httpPost(port, '/keys/suspend', { key }, { 'x-admin-key': adminKey });

    const r = await httpPost(port, '/keys/notes', { key, text: 'Note on suspended key' }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(201);
    expect(r.body.note.text).toBe('Note on suspended key');
  });

  test('works on revoked key', async () => {
    const key = await createKey(100, 'revoked-notes');
    await httpPost(port, '/keys/revoke', { key }, { 'x-admin-key': adminKey });

    const r = await httpPost(port, '/keys/notes', { key, text: 'Post-revocation note' }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(201);
  });

  // ── audit trail ──

  test('add note creates audit event', async () => {
    const key = await createKey(100, 'audit-note');
    await httpPost(port, '/keys/notes', { key, text: 'Audit test note' }, { 'x-admin-key': adminKey });

    const r = await httpGet(port, '/audit?types=key.note_added', { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBeGreaterThanOrEqual(1);
    expect(r.body.events[0].type).toBe('key.note_added');
  });

  test('delete note creates audit event', async () => {
    const key = await createKey(100, 'audit-delete');
    await httpPost(port, '/keys/notes', { key, text: 'Will be deleted' }, { 'x-admin-key': adminKey });
    await httpDelete(port, `/keys/notes?key=${key}&index=0`, { 'x-admin-key': adminKey });

    const r = await httpGet(port, '/audit?types=key.note_deleted', { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBeGreaterThanOrEqual(1);
    expect(r.body.events[0].type).toBe('key.note_deleted');
  });

  // ── validation + error cases ──

  test('requires admin key for GET', async () => {
    const key = await createKey(100, 'auth-get');
    const r = await httpGet(port, `/keys/notes?key=${key}`);
    expect(r.status).toBe(401);
  });

  test('requires admin key for POST', async () => {
    const r = await httpPost(port, '/keys/notes', { key: 'pg_fake', text: 'test' });
    expect(r.status).toBe(401);
  });

  test('requires admin key for DELETE', async () => {
    const r = await httpDelete(port, '/keys/notes?key=pg_fake&index=0');
    expect(r.status).toBe(401);
  });

  test('GET requires key param', async () => {
    const r = await httpGet(port, '/keys/notes', { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/key/i);
  });

  test('POST requires key field', async () => {
    const r = await httpPost(port, '/keys/notes', { text: 'no key' }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/key/i);
  });

  test('POST requires text field', async () => {
    const key = await createKey(100, 'no-text');
    const r = await httpPost(port, '/keys/notes', { key }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/text/i);
  });

  test('POST rejects empty text', async () => {
    const key = await createKey(100, 'empty-text');
    const r = await httpPost(port, '/keys/notes', { key, text: '   ' }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
  });

  test('POST rejects text over 1000 chars', async () => {
    const key = await createKey(100, 'long-text');
    const r = await httpPost(port, '/keys/notes', { key, text: 'x'.repeat(1001) }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/1000/);
  });

  test('POST rejects invalid JSON', async () => {
    const r = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/keys/notes', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey } },
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

  test('GET returns 404 for unknown key', async () => {
    const r = await httpGet(port, '/keys/notes?key=pg_nonexistent', { 'x-admin-key': adminKey });
    expect(r.status).toBe(404);
  });

  test('POST returns 404 for unknown key', async () => {
    const r = await httpPost(port, '/keys/notes', { key: 'pg_nonexistent', text: 'test' }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(404);
  });

  test('DELETE returns 404 for unknown key', async () => {
    const r = await httpDelete(port, '/keys/notes?key=pg_nonexistent&index=0', { 'x-admin-key': adminKey });
    expect(r.status).toBe(404);
  });

  test('DELETE returns 400 for invalid index', async () => {
    const key = await createKey(100, 'bad-index');
    await httpPost(port, '/keys/notes', { key, text: 'Only note' }, { 'x-admin-key': adminKey });

    const r = await httpDelete(port, `/keys/notes?key=${key}&index=5`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/index/i);
  });

  test('DELETE requires index param', async () => {
    const key = await createKey(100, 'no-index');
    const r = await httpDelete(port, `/keys/notes?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/index/i);
  });

  test('PUT returns 405', async () => {
    const r = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/keys/notes', method: 'PUT', headers: { 'x-admin-key': adminKey } },
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
    expect(r.body.endpoints.keyNotes).toBeDefined();
    expect(r.body.endpoints.keyNotes).toMatch(/notes/i);
  });

  test('timestamps are in chronological order', async () => {
    const key = await createKey(100, 'chrono-notes');
    await httpPost(port, '/keys/notes', { key, text: 'First' }, { 'x-admin-key': adminKey });
    await new Promise(r => setTimeout(r, 10));
    await httpPost(port, '/keys/notes', { key, text: 'Second' }, { 'x-admin-key': adminKey });

    const r = await httpGet(port, `/keys/notes?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.body.notes[0].timestamp <= r.body.notes[1].timestamp).toBe(true);
  });
});
