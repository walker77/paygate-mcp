/**
 * Tests for v4.5.0 — Key Cloning.
 *
 * Covers:
 *   - KeyStore.cloneKey() method
 *   - POST /keys/clone endpoint
 *   - Config inheritance (ACL, quotas, tags, IP, namespace, group, spending limit, auto-topup, expiry)
 *   - Override support (name, credits, tags, namespace)
 *   - Edge cases: revoked keys, suspended keys, unknown keys
 *   - Fresh counters on cloned keys
 *   - Audit trail events
 */

import { KeyStore } from '../src/store';
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

describe('KeyStore cloneKey', () => {
  let store: KeyStore;
  let sourceKey: string;

  beforeEach(() => {
    store = new KeyStore();
    const record = store.createKey('source-key', 200, {
      allowedTools: ['tool_a', 'tool_b'],
      deniedTools: ['tool_c'],
      expiresAt: '2030-12-31T23:59:59.000Z',
      quota: { dailyCallLimit: 100, monthlyCallLimit: 1000, dailyCreditLimit: 50, monthlyCreditLimit: 500 },
      tags: { env: 'prod', team: 'backend' },
      ipAllowlist: ['192.168.1.0/24'],
      namespace: 'tenant-a',
    });
    sourceKey = record.key;
    // Set spending limit on source directly
    record.spendingLimit = 1000;
  });

  test('cloneKey() creates a new key with same config', () => {
    const cloned = store.cloneKey(sourceKey);
    expect(cloned).not.toBeNull();
    expect(cloned!.key).not.toBe(sourceKey);
    expect(cloned!.key.startsWith('pg_')).toBe(true);
    expect(cloned!.name).toBe('source-key-clone');
    expect(cloned!.credits).toBe(200);
    expect(cloned!.allowedTools).toEqual(['tool_a', 'tool_b']);
    expect(cloned!.deniedTools).toEqual(['tool_c']);
    expect(cloned!.expiresAt).toBe('2030-12-31T23:59:59.000Z');
    expect(cloned!.quota).toEqual({ dailyCallLimit: 100, monthlyCallLimit: 1000, dailyCreditLimit: 50, monthlyCreditLimit: 500 });
    expect(cloned!.tags).toEqual({ env: 'prod', team: 'backend' });
    expect(cloned!.ipAllowlist).toEqual(['192.168.1.0/24']);
    expect(cloned!.namespace).toBe('tenant-a');
    expect(cloned!.spendingLimit).toBe(1000);
  });

  test('cloneKey() with name override', () => {
    const cloned = store.cloneKey(sourceKey, { name: 'my-new-key' });
    expect(cloned).not.toBeNull();
    expect(cloned!.name).toBe('my-new-key');
  });

  test('cloneKey() with credits override', () => {
    const cloned = store.cloneKey(sourceKey, { credits: 500 });
    expect(cloned).not.toBeNull();
    expect(cloned!.credits).toBe(500);
  });

  test('cloneKey() with tags override', () => {
    const cloned = store.cloneKey(sourceKey, { tags: { env: 'staging' } });
    expect(cloned).not.toBeNull();
    expect(cloned!.tags).toEqual({ env: 'staging' });
  });

  test('cloneKey() with namespace override', () => {
    const cloned = store.cloneKey(sourceKey, { namespace: 'tenant-b' });
    expect(cloned).not.toBeNull();
    expect(cloned!.namespace).toBe('tenant-b');
  });

  test('cloneKey() resets counters', () => {
    // Simulate usage on source
    const source = store.getKey(sourceKey)!;
    source.totalSpent = 50;
    source.totalCalls = 10;
    source.lastUsedAt = new Date().toISOString();
    source.quotaDailyCalls = 5;
    source.quotaMonthlyCalls = 20;

    const cloned = store.cloneKey(sourceKey);
    expect(cloned).not.toBeNull();
    expect(cloned!.totalSpent).toBe(0);
    expect(cloned!.totalCalls).toBe(0);
    expect(cloned!.lastUsedAt).toBeNull();
    expect(cloned!.quotaDailyCalls).toBe(0);
    expect(cloned!.quotaMonthlyCalls).toBe(0);
  });

  test('cloneKey() does not copy suspended state', () => {
    store.suspendKey(sourceKey);
    const cloned = store.cloneKey(sourceKey);
    expect(cloned).not.toBeNull();
    expect(cloned!.suspended).toBeUndefined();
  });

  test('cloneKey() returns null for revoked key', () => {
    store.revokeKey(sourceKey);
    expect(store.cloneKey(sourceKey)).toBeNull();
  });

  test('cloneKey() returns null for unknown key', () => {
    expect(store.cloneKey('pg_nonexistent')).toBeNull();
  });

  test('cloneKey() copies group assignment', () => {
    const source = store.getKey(sourceKey)!;
    source.group = 'premium';

    const cloned = store.cloneKey(sourceKey);
    expect(cloned).not.toBeNull();
    expect(cloned!.group).toBe('premium');
  });

  test('cloneKey() copies auto-topup config', () => {
    const source = store.getKey(sourceKey)!;
    source.autoTopup = { threshold: 10, amount: 50, maxDaily: 3 };

    const cloned = store.cloneKey(sourceKey);
    expect(cloned).not.toBeNull();
    expect(cloned!.autoTopup).toEqual({ threshold: 10, amount: 50, maxDaily: 3 });
    // Auto-topup counter should be fresh
    expect(cloned!.autoTopupTodayCount).toBe(0);
  });

  test('cloned key is independently usable', () => {
    const cloned = store.cloneKey(sourceKey)!;
    const fetched = store.getKey(cloned.key);
    expect(fetched).not.toBeNull();
    expect(fetched!.active).toBe(true);
  });

  test('arrays are deep-copied (not shared references)', () => {
    const cloned = store.cloneKey(sourceKey)!;
    const source = store.getKey(sourceKey)!;
    // Modify cloned arrays
    cloned.allowedTools.push('tool_z');
    cloned.ipAllowlist.push('10.0.0.0/8');
    // Source should be unchanged
    expect(source.allowedTools).toEqual(['tool_a', 'tool_b']);
    expect(source.ipAllowlist).toEqual(['192.168.1.0/24']);
  });
});

// ─── Server Endpoint Tests ──────────────────────────────────────────────────

describe('POST /keys/clone', () => {
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
      port: 0,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.stop();
  });

  /** Helper: create a fresh test key with config */
  async function createTestKey(name = 'test', credits = 100, extras?: Record<string, unknown>): Promise<string> {
    const res = await request(port, 'POST', '/keys', { name, credits, ...extras }, { 'X-Admin-Key': adminKey });
    return res.body.key;
  }

  test('clone key successfully', async () => {
    const key = await createTestKey('clone-source', 200);
    const res = await request(port, 'POST', '/keys/clone', { key }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Key cloned');
    expect(res.body.key).toBeDefined();
    expect(res.body.key).not.toBe(key);
    expect(res.body.sourceName).toBe('clone-source');
    expect(res.body.name).toBe('clone-source-clone');
    expect(res.body.credits).toBe(200);
  });

  test('clone with name override', async () => {
    const key = await createTestKey('clone-name', 100);
    const res = await request(port, 'POST', '/keys/clone', { key, name: 'custom-name' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('custom-name');
  });

  test('clone with credits override', async () => {
    const key = await createTestKey('clone-credits', 100);
    const res = await request(port, 'POST', '/keys/clone', { key, credits: 500 }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(201);
    expect(res.body.credits).toBe(500);
  });

  test('clone preserves ACL', async () => {
    const key = await createTestKey('clone-acl', 100);
    await request(port, 'POST', '/keys/acl', { key, allowedTools: ['tool_x'], deniedTools: ['tool_y'] }, { 'X-Admin-Key': adminKey });
    const res = await request(port, 'POST', '/keys/clone', { key }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(201);
    expect(res.body.allowedTools).toEqual(['tool_x']);
    expect(res.body.deniedTools).toEqual(['tool_y']);
  });

  test('clone preserves tags', async () => {
    const key = await createTestKey('clone-tags', 100, { tags: { tier: 'gold' } });
    const res = await request(port, 'POST', '/keys/clone', { key }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(201);
    expect(res.body.tags).toEqual({ tier: 'gold' });
  });

  test('clone preserves IP allowlist', async () => {
    const key = await createTestKey('clone-ip', 100);
    await request(port, 'POST', '/keys/ip', { key, ips: ['10.0.0.0/8'] }, { 'X-Admin-Key': adminKey });
    const res = await request(port, 'POST', '/keys/clone', { key }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(201);
    expect(res.body.ipAllowlist).toEqual(['10.0.0.0/8']);
  });

  test('clone preserves namespace', async () => {
    const key = await createTestKey('clone-ns', 100, { namespace: 'org-123' });
    const res = await request(port, 'POST', '/keys/clone', { key }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(201);
    expect(res.body.namespace).toBe('org-123');
  });

  test('clone with namespace override', async () => {
    const key = await createTestKey('clone-ns-over', 100, { namespace: 'org-old' });
    const res = await request(port, 'POST', '/keys/clone', { key, namespace: 'org-new' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(201);
    expect(res.body.namespace).toBe('org-new');
  });

  test('clone preserves spending limit', async () => {
    const key = await createTestKey('clone-limit', 100);
    await request(port, 'POST', '/limits', { key, spendingLimit: 500 }, { 'X-Admin-Key': adminKey });
    const res = await request(port, 'POST', '/keys/clone', { key }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(201);
    expect(res.body.spendingLimit).toBe(500);
  });

  test('clone preserves expiry', async () => {
    const key = await createTestKey('clone-expiry', 100);
    const expiresAt = '2030-06-15T00:00:00.000Z';
    await request(port, 'POST', '/keys/expiry', { key, expiresAt }, { 'X-Admin-Key': adminKey });
    const res = await request(port, 'POST', '/keys/clone', { key }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(201);
    expect(res.body.expiresAt).toBe(expiresAt);
  });

  test('cloned key works at /mcp gate', async () => {
    const key = await createTestKey('clone-gate', 100);
    const cloneRes = await request(port, 'POST', '/keys/clone', { key }, { 'X-Admin-Key': adminKey });
    const clonedKey = cloneRes.body.key;

    const res = await request(port, 'POST', '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'test_tool', arguments: {} },
    }, { 'X-API-Key': clonedKey });

    expect(res.body.error).toBeUndefined();
  });

  test('clone allows suspended source key', async () => {
    const key = await createTestKey('clone-suspended', 100);
    await request(port, 'POST', '/keys/suspend', { key }, { 'X-Admin-Key': adminKey });
    const res = await request(port, 'POST', '/keys/clone', { key }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(201);
    expect(res.body.key).toBeDefined();
  });

  test('clone requires admin auth', async () => {
    const key = await createTestKey('clone-auth', 100);
    const res = await request(port, 'POST', '/keys/clone', { key });
    expect(res.status).toBe(401);
  });

  test('clone requires POST method', async () => {
    const res = await request(port, 'GET', '/keys/clone', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(405);
  });

  test('clone requires key param', async () => {
    const res = await request(port, 'POST', '/keys/clone', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing key');
  });

  test('clone returns 404 for unknown key', async () => {
    const res = await request(port, 'POST', '/keys/clone', { key: 'pg_nonexistent' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(404);
  });

  test('clone returns 400 for revoked key', async () => {
    const key = await createTestKey('clone-revoked', 100);
    await request(port, 'POST', '/keys/revoke', { key }, { 'X-Admin-Key': adminKey });
    const res = await request(port, 'POST', '/keys/clone', { key }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot clone a revoked key');
  });

  test('clone returns 400 for invalid JSON', async () => {
    const res = await rawRequest(port, '/keys/clone', 'not-json', { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
  });

  // ─── Root listing ──────────────────────────────────────────────────────

  test('root listing includes clone endpoint', async () => {
    const res = await request(port, 'GET', '/');
    expect(res.body.endpoints.cloneKey).toBeDefined();
  });

  // ─── Audit trail ──────────────────────────────────────────────────────

  test('clone creates audit event', async () => {
    const key = await createTestKey('audit-clone', 100);
    await request(port, 'POST', '/keys/clone', { key }, { 'X-Admin-Key': adminKey });
    const res = await request(port, 'GET', '/audit?types=key.cloned', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.events.length).toBeGreaterThanOrEqual(1);
    // Newest first
    const event = res.body.events[0];
    expect(event.type).toBe('key.cloned');
    expect(event.message).toContain('Key cloned');
  });
});
