/**
 * Tests for v4.4.0 — Key Suspension & Resumption.
 *
 * Covers:
 *   - KeyStore.suspendKey() and resumeKey() methods
 *   - Gate.evaluate() denial for suspended keys
 *   - Gate.evaluateBatch() denial for suspended keys
 *   - Shadow mode passthrough for suspended keys
 *   - POST /keys/suspend endpoint
 *   - POST /keys/resume endpoint
 *   - Edge cases: revoked keys, already suspended, not suspended
 *   - Audit trail events
 *   - State file persistence round-trip
 */

import { KeyStore } from '../src/store';
import { Gate } from '../src/gate';
import { DEFAULT_CONFIG } from '../src/types';
import { PayGateServer } from '../src/server';
import http from 'http';

// ─── Helper: make HTTP request ──────────────────────────────────────────────

function request(port: number, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode!, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function rawRequest(port: number, path: string, rawBody: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode!, body: data });
        }
      });
    });
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

// ─── KeyStore Unit Tests ────────────────────────────────────────────────────

describe('KeyStore suspension', () => {
  let store: KeyStore;
  let key: string;

  beforeEach(() => {
    store = new KeyStore();
    const record = store.createKey('test-key', 100);
    key = record.key;
  });

  test('suspendKey() sets suspended=true', () => {
    const result = store.suspendKey(key);
    expect(result).toBe(true);
    const record = store.getKey(key);
    expect(record).not.toBeNull();
    expect(record!.suspended).toBe(true);
  });

  test('resumeKey() sets suspended=false', () => {
    store.suspendKey(key);
    const result = store.resumeKey(key);
    expect(result).toBe(true);
    const record = store.getKey(key);
    expect(record).not.toBeNull();
    expect(record!.suspended).toBe(false);
  });

  test('suspendKey() returns false for revoked key', () => {
    store.revokeKey(key);
    expect(store.suspendKey(key)).toBe(false);
  });

  test('resumeKey() returns false for non-suspended key', () => {
    expect(store.resumeKey(key)).toBe(false);
  });

  test('resumeKey() returns false for revoked key', () => {
    store.suspendKey(key);
    store.revokeKey(key);
    expect(store.resumeKey(key)).toBe(false);
  });

  test('suspendKey() returns false for unknown key', () => {
    expect(store.suspendKey('pg_nonexistent')).toBe(false);
  });

  test('resumeKey() returns false for unknown key', () => {
    expect(store.resumeKey('pg_nonexistent')).toBe(false);
  });

  test('getKey() still returns suspended keys', () => {
    store.suspendKey(key);
    const record = store.getKey(key);
    expect(record).not.toBeNull();
    expect(record!.suspended).toBe(true);
  });

  test('suspended field defaults to undefined for new keys', () => {
    const record = store.getKey(key);
    expect(record!.suspended).toBeUndefined();
  });

  test('listKeys() includes suspended status', () => {
    store.suspendKey(key);
    const keys = store.listKeys();
    expect(keys.length).toBe(1);
    expect(keys[0].suspended).toBe(true);
  });
});

// ─── Gate Unit Tests ────────────────────────────────────────────────────────

describe('Gate suspension check', () => {
  let store: KeyStore;
  let gate: Gate;
  let key: string;

  beforeEach(() => {
    store = new KeyStore();
    const record = store.createKey('test-key', 100);
    key = record.key;
    gate = new Gate({ ...DEFAULT_CONFIG });
    (gate as any).store = store;
  });

  test('evaluate() denies suspended key with reason key_suspended', () => {
    store.suspendKey(key);
    const decision = gate.evaluate(key, { name: 'test_tool' });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('key_suspended');
  });

  test('evaluate() allows key after resumption', () => {
    store.suspendKey(key);
    store.resumeKey(key);
    const decision = gate.evaluate(key, { name: 'test_tool' });
    expect(decision.allowed).toBe(true);
  });

  test('evaluate() includes remaining credits in suspended response', () => {
    store.suspendKey(key);
    const decision = gate.evaluate(key, { name: 'test_tool' });
    expect(decision.remainingCredits).toBe(100);
  });

  test('evaluate() in shadow mode allows suspended key with shadow reason', () => {
    const shadowGate = new Gate({ ...DEFAULT_CONFIG, shadowMode: true });
    (shadowGate as any).store = store;
    store.suspendKey(key);
    const decision = shadowGate.evaluate(key, { name: 'test_tool' });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('shadow:key_suspended');
  });

  test('evaluateBatch() denies all calls for suspended key', () => {
    store.suspendKey(key);
    const result = gate.evaluateBatch(key, [
      { name: 'tool1' },
      { name: 'tool2' },
    ]);
    expect(result.allAllowed).toBe(false);
    expect(result.reason).toBe('key_suspended');
    expect(result.decisions.length).toBe(2);
    expect(result.decisions[0].reason).toBe('key_suspended');
    expect(result.decisions[1].reason).toBe('key_suspended');
  });

  test('evaluateBatch() in shadow mode passes suspended key', () => {
    const shadowGate = new Gate({ ...DEFAULT_CONFIG, shadowMode: true });
    (shadowGate as any).store = store;
    store.suspendKey(key);
    const result = shadowGate.evaluateBatch(key, [{ name: 'tool1' }]);
    expect(result.allAllowed).toBe(true);
  });
});

// ─── Server Endpoint Tests ──────────────────────────────────────────────────

describe('POST /keys/suspend and /keys/resume', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  const ECHO_CMD = 'node';
  const ECHO_ARGS = ['-e', 'process.stdin.resume(); process.stdin.on("data", d => { const r = JSON.parse(d.toString().trim()); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: {} }) + "\\n"); });'];

  beforeAll(async () => {
    server = new PayGateServer({
      ...DEFAULT_CONFIG,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.stop();
  });

  /** Helper: create a fresh test key */
  async function createTestKey(name = 'test', credits = 100): Promise<string> {
    const res = await request(port, 'POST', '/keys', { name, credits }, { 'X-Admin-Key': adminKey });
    return res.body.key;
  }

  // ─── Suspend ────────────────────────────────────────────────────────────

  test('suspend key successfully', async () => {
    const key = await createTestKey('suspend-ok');
    const res = await request(port, 'POST', '/keys/suspend', { key }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.suspended).toBe(true);
    expect(res.body.message).toBe('Key suspended');
  });

  test('suspend requires admin auth', async () => {
    const key = await createTestKey('suspend-auth');
    const res = await request(port, 'POST', '/keys/suspend', { key });
    expect(res.status).toBe(401);
  });

  test('suspend requires POST method', async () => {
    const res = await request(port, 'GET', '/keys/suspend', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(405);
  });

  test('suspend requires key param', async () => {
    const res = await request(port, 'POST', '/keys/suspend', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing key');
  });

  test('suspend returns 404 for unknown key', async () => {
    const res = await request(port, 'POST', '/keys/suspend', { key: 'pg_nonexistent' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(404);
  });

  test('suspend returns 400 for already suspended key', async () => {
    const key = await createTestKey('suspend-dup');
    await request(port, 'POST', '/keys/suspend', { key }, { 'X-Admin-Key': adminKey });
    const res = await request(port, 'POST', '/keys/suspend', { key }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Key is already suspended');
  });

  test('suspend returns 400 for revoked key', async () => {
    const key = await createTestKey('suspend-revoked');
    await request(port, 'POST', '/keys/revoke', { key }, { 'X-Admin-Key': adminKey });
    const res = await request(port, 'POST', '/keys/suspend', { key }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot suspend a revoked key');
  });

  test('suspend with reason', async () => {
    const key = await createTestKey('suspend-reason');
    const res = await request(port, 'POST', '/keys/suspend', { key, reason: 'abuse detected' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.suspended).toBe(true);
  });

  test('suspend returns 400 for invalid JSON', async () => {
    const res = await rawRequest(port, '/keys/suspend', 'not-json', { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
  });

  // ─── Resume ─────────────────────────────────────────────────────────────

  test('resume key successfully', async () => {
    const key = await createTestKey('resume-ok');
    await request(port, 'POST', '/keys/suspend', { key }, { 'X-Admin-Key': adminKey });
    const res = await request(port, 'POST', '/keys/resume', { key }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.suspended).toBe(false);
    expect(res.body.message).toBe('Key resumed');
  });

  test('resume requires admin auth', async () => {
    const key = await createTestKey('resume-auth');
    const res = await request(port, 'POST', '/keys/resume', { key });
    expect(res.status).toBe(401);
  });

  test('resume requires POST method', async () => {
    const res = await request(port, 'GET', '/keys/resume', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(405);
  });

  test('resume requires key param', async () => {
    const res = await request(port, 'POST', '/keys/resume', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing key');
  });

  test('resume returns 404 for unknown key', async () => {
    const res = await request(port, 'POST', '/keys/resume', { key: 'pg_nonexistent' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(404);
  });

  test('resume returns 400 for non-suspended key', async () => {
    const key = await createTestKey('resume-not-suspended');
    const res = await request(port, 'POST', '/keys/resume', { key }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Key is not suspended');
  });

  test('resume returns 400 for revoked key', async () => {
    const key = await createTestKey('resume-revoked');
    await request(port, 'POST', '/keys/suspend', { key }, { 'X-Admin-Key': adminKey });
    await request(port, 'POST', '/keys/revoke', { key }, { 'X-Admin-Key': adminKey });
    const res = await request(port, 'POST', '/keys/resume', { key }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot resume a revoked key');
  });

  test('resume returns 400 for invalid JSON', async () => {
    const res = await rawRequest(port, '/keys/resume', 'not-json', { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
  });

  // ─── Integration: gate enforces suspension ──────────────────────────────

  test('suspended key is denied at /mcp gate', async () => {
    const key = await createTestKey('gate-suspend');
    await request(port, 'POST', '/keys/suspend', { key }, { 'X-Admin-Key': adminKey });

    const res = await request(port, 'POST', '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'test_tool', arguments: {} },
    }, { 'X-API-Key': key });

    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe(-32402);
    expect(res.body.error.message).toContain('key_suspended');
  });

  test('resumed key is allowed at /mcp gate', async () => {
    const key = await createTestKey('gate-resume');
    await request(port, 'POST', '/keys/suspend', { key }, { 'X-Admin-Key': adminKey });
    await request(port, 'POST', '/keys/resume', { key }, { 'X-Admin-Key': adminKey });

    const res = await request(port, 'POST', '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'test_tool', arguments: {} },
    }, { 'X-API-Key': key });

    expect(res.body.error).toBeUndefined();
  });

  // ─── Admin operations still work on suspended keys ──────────────────────

  test('topup works on suspended key', async () => {
    const key = await createTestKey('topup-suspended');
    await request(port, 'POST', '/keys/suspend', { key }, { 'X-Admin-Key': adminKey });
    const res = await request(port, 'POST', '/topup', { key, credits: 50 }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
  });

  test('setAcl works on suspended key', async () => {
    const key = await createTestKey('acl-suspended');
    await request(port, 'POST', '/keys/suspend', { key }, { 'X-Admin-Key': adminKey });
    const res = await request(port, 'POST', '/keys/acl', { key, allowedTools: ['test_tool'] }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
  });

  // ─── Root listing includes suspend/resume ─────────────────────────────

  test('root listing includes suspend and resume endpoints', async () => {
    const res = await request(port, 'GET', '/');
    expect(res.body.endpoints.suspendKey).toBeDefined();
    expect(res.body.endpoints.resumeKey).toBeDefined();
  });

  // ─── Audit trail ──────────────────────────────────────────────────────

  test('suspend creates audit event', async () => {
    const key = await createTestKey('audit-suspend');
    await request(port, 'POST', '/keys/suspend', { key, reason: 'testing' }, { 'X-Admin-Key': adminKey });
    const res = await request(port, 'GET', '/audit?types=key.suspended', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.events.length).toBeGreaterThanOrEqual(1);
    // Audit returns newest-first (reverse chronological), so events[0] is the most recent
    const event = res.body.events[0];
    expect(event.type).toBe('key.suspended');
    expect(event.message).toContain('testing');
  });

  test('resume creates audit event', async () => {
    const key = await createTestKey('audit-resume');
    await request(port, 'POST', '/keys/suspend', { key }, { 'X-Admin-Key': adminKey });
    await request(port, 'POST', '/keys/resume', { key }, { 'X-Admin-Key': adminKey });
    const res = await request(port, 'GET', '/audit?types=key.resumed', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.events.length).toBeGreaterThanOrEqual(1);
    // Audit returns newest-first (reverse chronological), so events[0] is the most recent
    const event = res.body.events[0];
    expect(event.type).toBe('key.resumed');
  });
});

// ─── State File Persistence ─────────────────────────────────────────────────

describe('Key suspension state file persistence', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  test('suspended field survives state file round-trip', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-test-'));
    const statePath = path.join(tmpDir, 'state.json');

    // Create store, key, suspend
    const store1 = new KeyStore(statePath);
    const record = store1.createKey('test-key', 100);
    store1.suspendKey(record.key);

    // Load into new store
    const store2 = new KeyStore(statePath);
    const loaded = store2.getKey(record.key);
    expect(loaded).not.toBeNull();
    expect(loaded!.suspended).toBe(true);

    // Clean up
    fs.rmSync(tmpDir, { recursive: true });
  });
});
