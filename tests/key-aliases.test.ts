/**
 * Tests for v5.0.0 — Key Aliases.
 *
 * Covers:
 *   - POST /keys/alias sets and clears aliases
 *   - Alias uniqueness enforcement
 *   - Alias format validation (alphanumeric, hyphens, underscores)
 *   - Alias cannot collide with existing key IDs
 *   - Alias resolution in admin endpoints (topup, revoke, suspend, resume, clone, usage, transfer)
 *   - Aliases do NOT work for API key auth (/mcp tools/call)
 *   - State file persistence (alias survives reload)
 *   - Audit trail for alias operations
 *   - Admin auth required
 *   - Method validation (POST only)
 *   - Root listing includes endpoint
 *   - Clone does NOT copy alias
 */

import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';
import http from 'http';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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

const ECHO_CMD = 'node';
const ECHO_ARGS = ['-e', 'process.stdin.resume(); process.stdin.on("data", d => { const r = JSON.parse(d.toString().trim()); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: {} }) + "\\n"); });'];

const STATE_PATH = join(tmpdir(), `paygate-alias-test-${Date.now()}.json`);

// ─── POST /keys/alias — Core alias operations ──────────────────────────────

describe('POST /keys/alias', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let apiKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      ...DEFAULT_CONFIG,
      port: 0,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    const res = await request(port, 'POST', '/keys', { credits: 100, name: 'test-key' }, { 'X-Admin-Key': adminKey });
    apiKey = res.body.key;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('sets alias for a key', async () => {
    const res = await request(port, 'POST', '/keys/alias', { key: apiKey, alias: 'my-service' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.alias).toBe('my-service');
    expect(res.body.message).toContain('set');
  });

  test('clears alias with null', async () => {
    await request(port, 'POST', '/keys/alias', { key: apiKey, alias: 'temp-alias' }, { 'X-Admin-Key': adminKey });
    const res = await request(port, 'POST', '/keys/alias', { key: apiKey, alias: null }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.alias).toBeNull();
    expect(res.body.message).toContain('cleared');
  });

  test('clears alias with empty string', async () => {
    await request(port, 'POST', '/keys/alias', { key: apiKey, alias: 'temp2' }, { 'X-Admin-Key': adminKey });
    const res = await request(port, 'POST', '/keys/alias', { key: apiKey, alias: '' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.alias).toBeNull();
  });

  test('rejects invalid alias format (spaces)', async () => {
    const res = await request(port, 'POST', '/keys/alias', { key: apiKey, alias: 'has spaces' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('letters, numbers, hyphens');
  });

  test('rejects invalid alias format (special chars)', async () => {
    const res = await request(port, 'POST', '/keys/alias', { key: apiKey, alias: 'bad@alias!' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
  });

  test('allows hyphens and underscores in alias', async () => {
    const res = await request(port, 'POST', '/keys/alias', { key: apiKey, alias: 'my-service_v2' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.alias).toBe('my-service_v2');
  });

  test('rejects duplicate alias across keys', async () => {
    await request(port, 'POST', '/keys/alias', { key: apiKey, alias: 'unique-name' }, { 'X-Admin-Key': adminKey });

    const key2Res = await request(port, 'POST', '/keys', { credits: 50 }, { 'X-Admin-Key': adminKey });
    const key2 = key2Res.body.key;

    const res = await request(port, 'POST', '/keys/alias', { key: key2, alias: 'unique-name' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('already in use');
  });

  test('rejects alias that collides with existing key ID', async () => {
    const res = await request(port, 'POST', '/keys/alias', { key: apiKey, alias: apiKey }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('conflicts');
  });

  test('requires admin key', async () => {
    const res = await request(port, 'POST', '/keys/alias', { key: apiKey, alias: 'nope' });
    expect(res.status).toBe(401);
  });

  test('rejects non-POST methods', async () => {
    const res = await request(port, 'GET', '/keys/alias', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(405);
  });

  test('returns 400 when key param missing', async () => {
    const res = await request(port, 'POST', '/keys/alias', { alias: 'test' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('key');
  });

  test('returns 400 when alias param missing', async () => {
    const res = await request(port, 'POST', '/keys/alias', { key: apiKey }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('alias');
  });

  test('returns 404 for unknown key', async () => {
    const res = await request(port, 'POST', '/keys/alias', { key: 'pg_nonexistent', alias: 'test' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(404);
  });

  test('allows re-setting same alias on same key', async () => {
    await request(port, 'POST', '/keys/alias', { key: apiKey, alias: 'same-alias' }, { 'X-Admin-Key': adminKey });
    const res = await request(port, 'POST', '/keys/alias', { key: apiKey, alias: 'same-alias' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.alias).toBe('same-alias');
  });

  test('allows changing alias on same key', async () => {
    await request(port, 'POST', '/keys/alias', { key: apiKey, alias: 'old-alias' }, { 'X-Admin-Key': adminKey });
    const res = await request(port, 'POST', '/keys/alias', { key: apiKey, alias: 'new-alias' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.alias).toBe('new-alias');
  });
});

// ─── Alias Resolution in Admin Endpoints ────────────────────────────────────

describe('Alias resolution in admin endpoints', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let apiKey: string;
  const alias = 'service-alpha';

  beforeAll(async () => {
    server = new PayGateServer({
      ...DEFAULT_CONFIG,
      port: 0,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    const res = await request(port, 'POST', '/keys', { credits: 500, name: 'aliased-key' }, { 'X-Admin-Key': adminKey });
    apiKey = res.body.key;
    await request(port, 'POST', '/keys/alias', { key: apiKey, alias }, { 'X-Admin-Key': adminKey });
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('POST /topup resolves alias', async () => {
    const res = await request(port, 'POST', '/topup', { key: alias, credits: 100 }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.credits).toBe(600);
  });

  test('POST /keys/suspend resolves alias', async () => {
    const res = await request(port, 'POST', '/keys/suspend', { key: alias, reason: 'test' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.suspended).toBe(true);
  });

  test('POST /keys/resume resolves alias', async () => {
    const res = await request(port, 'POST', '/keys/resume', { key: alias }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.suspended).toBe(false);
  });

  test('POST /keys/clone resolves alias', async () => {
    const res = await request(port, 'POST', '/keys/clone', { key: alias }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(201);
    expect(res.body.clonedFrom).toBeDefined();
  });

  test('GET /keys/usage resolves alias', async () => {
    const res = await request(port, 'GET', `/keys/usage?key=${alias}`, undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.key).toBeDefined();
  });

  test('POST /revoke resolves alias', async () => {
    // Create a separate key to revoke
    const newRes = await request(port, 'POST', '/keys', { credits: 10 }, { 'X-Admin-Key': adminKey });
    const newKey = newRes.body.key;
    await request(port, 'POST', '/keys/alias', { key: newKey, alias: 'revoke-me' }, { 'X-Admin-Key': adminKey });

    const res = await request(port, 'POST', '/keys/revoke', { key: 'revoke-me' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);
  });

  test('can reference alias after setting it via alias itself', async () => {
    // Use the alias to set alias on the same key (resolveKeyRaw in handleSetAlias)
    const res = await request(port, 'POST', '/keys/alias', { key: alias, alias: 'renamed-alpha' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.alias).toBe('renamed-alpha');

    // Verify new alias works for topup
    const topupRes = await request(port, 'POST', '/topup', { key: 'renamed-alpha', credits: 10 }, { 'X-Admin-Key': adminKey });
    expect(topupRes.status).toBe(200);
  });
});

// ─── Alias does NOT work for API key auth ───────────────────────────────────

describe('Alias does NOT work for MCP auth', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let apiKey: string;
  const alias = 'auth-alias';

  beforeAll(async () => {
    server = new PayGateServer({
      ...DEFAULT_CONFIG,
      port: 0,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    const res = await request(port, 'POST', '/keys', { credits: 100 }, { 'X-Admin-Key': adminKey });
    apiKey = res.body.key;
    await request(port, 'POST', '/keys/alias', { key: apiKey, alias }, { 'X-Admin-Key': adminKey });
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('alias as X-API-Key on tools/call returns auth error', async () => {
    const mcpReq = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'echo', arguments: {} },
    };
    const res = await request(port, 'POST', '/mcp', mcpReq, { 'X-API-Key': alias });
    // Aliases don't work as API keys — should get auth error (401 or payment-required)
    expect([401, 200]).toContain(res.status);
    if (res.status === 200) {
      // If 200, the response body should contain an error (payment required)
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(-32402);
    }
  });
});

// ─── State file persistence ─────────────────────────────────────────────────

describe('Alias persistence across restart', () => {
  const statePath = STATE_PATH;

  afterAll(() => {
    try { if (existsSync(statePath)) unlinkSync(statePath); } catch {}
    try { if (existsSync(statePath.replace('.json', '-groups.json'))) unlinkSync(statePath.replace('.json', '-groups.json')); } catch {}
  });

  test('alias survives server restart', async () => {
    const server1 = new PayGateServer(
      { ...DEFAULT_CONFIG, port: 0, serverCommand: ECHO_CMD, serverArgs: ECHO_ARGS },
      undefined,
      statePath,
    );
    const info1 = await server1.start();

    // Create key and set alias
    const keyRes = await request(info1.port, 'POST', '/keys', { credits: 100, name: 'persist-test' }, { 'X-Admin-Key': info1.adminKey });
    const apiKey = keyRes.body.key;
    await request(info1.port, 'POST', '/keys/alias', { key: apiKey, alias: 'persistent-alias' }, { 'X-Admin-Key': info1.adminKey });

    // Verify alias works via topup
    const topup1 = await request(info1.port, 'POST', '/topup', { key: 'persistent-alias', credits: 10 }, { 'X-Admin-Key': info1.adminKey });
    expect(topup1.status).toBe(200);
    expect(topup1.body.credits).toBe(110);

    await server1.stop();

    // Start server 2 with same state file
    const server2 = new PayGateServer(
      { ...DEFAULT_CONFIG, port: 0, serverCommand: ECHO_CMD, serverArgs: ECHO_ARGS },
      info1.adminKey,
      statePath,
    );
    const info2 = await server2.start();

    // Verify alias still works after restart (topup again)
    const topup2 = await request(info2.port, 'POST', '/topup', { key: 'persistent-alias', credits: 5 }, { 'X-Admin-Key': info2.adminKey });
    expect(topup2.status).toBe(200);
    expect(topup2.body.credits).toBe(115);

    await server2.stop();
  });
});

// ─── Audit trail ────────────────────────────────────────────────────────────

describe('Alias audit trail', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let apiKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      ...DEFAULT_CONFIG,
      port: 0,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    const res = await request(port, 'POST', '/keys', { credits: 100 }, { 'X-Admin-Key': adminKey });
    apiKey = res.body.key;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('setting alias creates audit event', async () => {
    await request(port, 'POST', '/keys/alias', { key: apiKey, alias: 'audit-test' }, { 'X-Admin-Key': adminKey });

    const auditRes = await request(port, 'GET', '/audit?types=key.alias_set&limit=1', undefined, { 'X-Admin-Key': adminKey });
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.events.length).toBeGreaterThanOrEqual(1);
    expect(auditRes.body.events[0].type).toBe('key.alias_set');
    expect(auditRes.body.events[0].metadata.alias).toBe('audit-test');
  });

  test('clearing alias creates audit event', async () => {
    await request(port, 'POST', '/keys/alias', { key: apiKey, alias: null }, { 'X-Admin-Key': adminKey });

    const auditRes = await request(port, 'GET', '/audit?types=key.alias_set&limit=1', undefined, { 'X-Admin-Key': adminKey });
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.events[0].type).toBe('key.alias_set');
    expect(auditRes.body.events[0].metadata.alias).toBeNull();
  });
});

// ─── Root listing ───────────────────────────────────────────────────────────

describe('Root listing includes alias endpoint', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      ...DEFAULT_CONFIG,
      port: 0,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('GET / includes keyAlias endpoint', async () => {
    const res = await request(port, 'GET', '/', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.endpoints).toBeDefined();
    const endpoints = res.body.endpoints;
    const aliasEndpoint = Object.entries(endpoints).find(([k]) => k.includes('alias') || k.includes('Alias'));
    expect(aliasEndpoint).toBeDefined();
  });
});

// ─── Credit transfer with alias ─────────────────────────────────────────────

describe('Credit transfer with alias', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      ...DEFAULT_CONFIG,
      port: 0,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    const res1 = await request(port, 'POST', '/keys', { credits: 200 }, { 'X-Admin-Key': adminKey });
    const res2 = await request(port, 'POST', '/keys', { credits: 50 }, { 'X-Admin-Key': adminKey });

    await request(port, 'POST', '/keys/alias', { key: res1.body.key, alias: 'sender' }, { 'X-Admin-Key': adminKey });
    await request(port, 'POST', '/keys/alias', { key: res2.body.key, alias: 'receiver' }, { 'X-Admin-Key': adminKey });
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('transfer credits using aliases for both from and to', async () => {
    const res = await request(port, 'POST', '/keys/transfer', {
      from: 'sender',
      to: 'receiver',
      credits: 50,
    }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.from.credits).toBe(150);
    expect(res.body.to.credits).toBe(100);
  });
});

// ─── Clone does NOT copy alias ──────────────────────────────────────────────

describe('Clone does NOT copy alias', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let apiKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      ...DEFAULT_CONFIG,
      port: 0,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    const res = await request(port, 'POST', '/keys', { credits: 100 }, { 'X-Admin-Key': adminKey });
    apiKey = res.body.key;
    await request(port, 'POST', '/keys/alias', { key: apiKey, alias: 'original' }, { 'X-Admin-Key': adminKey });
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('cloned key does not have original alias', async () => {
    const cloneRes = await request(port, 'POST', '/keys/clone', { key: apiKey }, { 'X-Admin-Key': adminKey });
    expect(cloneRes.status).toBe(201);

    // Verify cloned key exists (topup with full key should work)
    const cloneKey = cloneRes.body.key;
    const topupRes = await request(port, 'POST', '/topup', { key: cloneKey, credits: 1 }, { 'X-Admin-Key': adminKey });
    expect(topupRes.status).toBe(200);

    // Original alias should still resolve to original key (not the clone)
    const origTopup = await request(port, 'POST', '/topup', { key: 'original', credits: 1 }, { 'X-Admin-Key': adminKey });
    expect(origTopup.status).toBe(200);
  });
});
