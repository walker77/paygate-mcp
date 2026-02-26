/**
 * Tests for v2.4.0 — Admin API Redis Sync.
 * Verifies that all admin HTTP endpoints that modify key state
 * propagate mutations to Redis via redisSync.
 *
 * We create a server with a redis:// URL (which creates redisSync) but
 * mock the Redis client methods to avoid needing a real Redis instance.
 */

import { PayGateServer } from '../src/server';
import * as http from 'http';
import * as path from 'path';

const MOCK_SERVER = path.join(__dirname, 'e2e', 'mock-mcp-server.js');

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function httpRequest(port: number, reqPath: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
} = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port,
      path: reqPath,
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...options.headers },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode!, body: data });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('Admin API Redis Sync (v2.4.0)', () => {
  let server: PayGateServer;
  let port: number;
  const adminKey = 'test-admin-key';
  let apiKey: string;

  // Spies
  let saveKeySpy: jest.SpyInstance;
  let publishEventSpy: jest.SpyInstance;
  let atomicTopupSpy: jest.SpyInstance;
  let revokeKeySpy: jest.SpyInstance;

  beforeAll(async () => {
    port = 4200 + Math.floor(Math.random() * 200);
    server = new PayGateServer(
      {
        serverCommand: 'node',
        serverArgs: [MOCK_SERVER],
        port,
        defaultCreditsPerCall: 1,
        globalRateLimitPerMin: 100,
      },
      adminKey,
      undefined, // statePath
      undefined, // remoteUrl
      undefined, // stripeWebhookSecret
      undefined, // servers
      'redis://localhost:6379' // redisUrl — creates redisSync
    );

    // The server has a redisSync instance, but we don't want to connect to real Redis.
    // Mock all the methods we care about:
    const rs = server.redisSync!;
    saveKeySpy = jest.spyOn(rs, 'saveKey').mockResolvedValue();
    publishEventSpy = jest.spyOn(rs, 'publishEvent').mockResolvedValue();
    atomicTopupSpy = jest.spyOn(rs, 'atomicTopup').mockResolvedValue(true);
    revokeKeySpy = jest.spyOn(rs, 'revokeKey').mockResolvedValue(true);

    // Mock init to skip real Redis connection
    jest.spyOn(rs, 'init').mockResolvedValue();

    const result = await server.start();
    port = result.port;

    // Create a test key via the admin API
    const createRes = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'sync-test', credits: 1000 },
    });
    apiKey = createRes.body.key;
  });

  afterAll(async () => {
    await server.stop();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    saveKeySpy.mockClear();
    publishEventSpy.mockClear();
    atomicTopupSpy.mockClear();
    revokeKeySpy.mockClear();
  });

  // ─── POST /keys — Create key ──────────────────────────────────────────────

  it('POST /keys syncs new key to Redis and publishes key_created', async () => {
    saveKeySpy.mockClear();
    publishEventSpy.mockClear();

    const res = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'new-key', credits: 500 },
    });

    expect(res.status).toBe(201);
    // saveKey called with the new record
    expect(saveKeySpy).toHaveBeenCalled();
    const savedRecord = saveKeySpy.mock.calls[0][0];
    expect(savedRecord.name).toBe('new-key');
    expect(savedRecord.credits).toBe(500);
    // publishEvent called with key_created
    expect(publishEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'key_created' })
    );
  });

  // ─── POST /topup — Uses atomicTopup ───────────────────────────────────────

  it('POST /topup uses atomicTopup when Redis available', async () => {
    const res = await httpRequest(port, '/topup', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { key: apiKey, credits: 100 },
    });

    expect(res.status).toBe(200);
    expect(atomicTopupSpy).toHaveBeenCalledWith(apiKey, 100);
  });

  // ─── POST /keys/revoke — Uses revokeKey ───────────────────────────────────

  it('POST /keys/revoke uses Redis-backed revokeKey', async () => {
    // Create a disposable key for revocation
    const createRes = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'revoke-me', credits: 10 },
    });
    const revokeKey = createRes.body.key;

    revokeKeySpy.mockClear();
    const res = await httpRequest(port, '/keys/revoke', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { key: revokeKey },
    });

    expect(res.status).toBe(200);
    expect(revokeKeySpy).toHaveBeenCalledWith(revokeKey);
  });

  // ─── POST /keys/rotate — Saves new key + publishes events ────────────────

  it('POST /keys/rotate syncs rotated key to Redis', async () => {
    // Create a key to rotate
    const createRes = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'rotate-me', credits: 100 },
    });
    const oldKey = createRes.body.key;

    saveKeySpy.mockClear();
    publishEventSpy.mockClear();

    const res = await httpRequest(port, '/keys/rotate', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { key: oldKey },
    });

    expect(res.status).toBe(200);
    // saveKey called for new key
    expect(saveKeySpy).toHaveBeenCalled();
    // publishEvent called for both key_created (new) and key_revoked (old)
    const publishCalls = publishEventSpy.mock.calls.map((c: any) => c[0].type);
    expect(publishCalls).toContain('key_created');
    expect(publishCalls).toContain('key_revoked');
  });

  // ─── POST /keys/acl — syncKeyMutation ─────────────────────────────────────

  it('POST /keys/acl syncs ACL change to Redis', async () => {
    const res = await httpRequest(port, '/keys/acl', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { key: apiKey, allowedTools: ['tool_a', 'tool_b'] },
    });

    expect(res.status).toBe(200);
    expect(saveKeySpy).toHaveBeenCalled();
    const savedRecord = saveKeySpy.mock.calls[0][0];
    expect(savedRecord.allowedTools).toEqual(['tool_a', 'tool_b']);
  });

  // ─── POST /keys/expiry — syncKeyMutation ──────────────────────────────────

  it('POST /keys/expiry syncs expiry change to Redis', async () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString();

    const res = await httpRequest(port, '/keys/expiry', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { key: apiKey, expiresAt: futureDate },
    });

    expect(res.status).toBe(200);
    expect(saveKeySpy).toHaveBeenCalled();
  });

  // ─── POST /keys/quota — syncKeyMutation (set) ─────────────────────────────

  it('POST /keys/quota syncs quota change to Redis', async () => {
    const res = await httpRequest(port, '/keys/quota', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { key: apiKey, maxDaily: 100, maxMonthly: 1000 },
    });

    expect(res.status).toBe(200);
    expect(saveKeySpy).toHaveBeenCalled();
  });

  // ─── POST /keys/quota — syncKeyMutation (remove) ──────────────────────────

  it('POST /keys/quota remove syncs to Redis', async () => {
    // First set a quota
    await httpRequest(port, '/keys/quota', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { key: apiKey, maxDaily: 100, maxMonthly: 1000 },
    });
    saveKeySpy.mockClear();

    // Remove it
    const res = await httpRequest(port, '/keys/quota', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { key: apiKey, remove: true },
    });

    expect(res.status).toBe(200);
    expect(saveKeySpy).toHaveBeenCalled();
  });

  // ─── POST /keys/tags — syncKeyMutation ─────────────────────────────────────

  it('POST /keys/tags syncs tag change to Redis', async () => {
    const res = await httpRequest(port, '/keys/tags', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { key: apiKey, tags: { env: 'prod', team: 'backend' } },
    });

    expect(res.status).toBe(200);
    expect(saveKeySpy).toHaveBeenCalled();
    const savedRecord = saveKeySpy.mock.calls[0][0];
    expect(savedRecord.tags).toEqual(expect.objectContaining({ env: 'prod', team: 'backend' }));
  });

  // ─── POST /keys/ip — syncKeyMutation ──────────────────────────────────────

  it('POST /keys/ip syncs IP allowlist change to Redis', async () => {
    const res = await httpRequest(port, '/keys/ip', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { key: apiKey, ips: ['10.0.0.0/8', '192.168.1.1'] },
    });

    expect(res.status).toBe(200);
    expect(saveKeySpy).toHaveBeenCalled();
    const savedRecord = saveKeySpy.mock.calls[0][0];
    expect(savedRecord.ipAllowlist).toEqual(['10.0.0.0/8', '192.168.1.1']);
  });

  // ─── POST /keys/spending-limit — syncKeyMutation ──────────────────────────

  it('POST /keys/spending-limit syncs spending limit to Redis', async () => {
    const res = await httpRequest(port, '/limits', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { key: apiKey, spendingLimit: 500 },
    });

    expect(res.status).toBe(200);
    expect(saveKeySpy).toHaveBeenCalled();
  });

  // ─── Negative cases ────────────────────────────────────────────────────────

  it('does not call saveKey when key is not found', async () => {
    const res = await httpRequest(port, '/keys/tags', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { key: 'nonexistent-key', tags: { x: 'y' } },
    });

    expect(res.status).toBe(404);
    expect(saveKeySpy).not.toHaveBeenCalled();
  });

  it('does not call saveKey on invalid params', async () => {
    const res = await httpRequest(port, '/keys/ip', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { key: apiKey }, // missing ips
    });

    expect(res.status).toBe(400);
    expect(saveKeySpy).not.toHaveBeenCalled();
  });

  // ─── Verify all endpoints covered ─────────────────────────────────────────

  it('syncKeyMutation is fire-and-forget (does not block on saveKey errors)', async () => {
    saveKeySpy.mockRejectedValueOnce(new Error('Redis connection lost'));

    const res = await httpRequest(port, '/keys/tags', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { key: apiKey, tags: { test: 'error-resilience' } },
    });

    // Should succeed despite saveKey failure
    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual(expect.objectContaining({ test: 'error-resilience' }));
  });
});

// ─── Unit tests for syncKeyMutation edge cases ──────────────────────────────

describe('syncKeyMutation without Redis', () => {
  it('server without redisUrl has no redisSync', () => {
    const server = new PayGateServer(
      {
        serverCommand: 'echo',
        serverArgs: ['test'],
        port: 0,
        defaultCreditsPerCall: 1,
        globalRateLimitPerMin: 60,
      },
      'admin_key'
    );

    expect(server.redisSync).toBeNull();
  });

  it('topup falls back to local store.addCredits without Redis', async () => {
    const port = 4500 + Math.floor(Math.random() * 200);
    const adminKey = 'admin-no-redis';
    const server = new PayGateServer(
      {
        serverCommand: 'node',
        serverArgs: [path.join(__dirname, 'e2e', 'mock-mcp-server.js')],
        port,
        defaultCreditsPerCall: 1,
        globalRateLimitPerMin: 100,
      },
      adminKey
    );

    const result = await server.start();
    const actualPort = result.port;

    try {
      // Create a key
      const createRes = await httpRequest(actualPort, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'local-test', credits: 100 },
      });
      expect(createRes.status).toBe(201);

      // Topup should use local store
      const topupRes = await httpRequest(actualPort, '/topup', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { key: createRes.body.key, credits: 50 },
      });
      expect(topupRes.status).toBe(200);
      expect(topupRes.body.credits).toBe(150);
    } finally {
      await server.stop();
    }
  });

  it('revoke falls back to local store.revokeKey without Redis', async () => {
    const port = 4700 + Math.floor(Math.random() * 200);
    const adminKey = 'admin-no-redis2';
    const server = new PayGateServer(
      {
        serverCommand: 'node',
        serverArgs: [path.join(__dirname, 'e2e', 'mock-mcp-server.js')],
        port,
        defaultCreditsPerCall: 1,
        globalRateLimitPerMin: 100,
      },
      adminKey
    );

    const result = await server.start();
    const actualPort = result.port;

    try {
      const createRes = await httpRequest(actualPort, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'revoke-local', credits: 10 },
      });
      expect(createRes.status).toBe(201);

      const revokeRes = await httpRequest(actualPort, '/keys/revoke', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { key: createRes.body.key },
      });
      expect(revokeRes.status).toBe(200);
    } finally {
      await server.stop();
    }
  });
});
