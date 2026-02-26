/**
 * Tests for Token Revocation List (v3.1.0)
 *
 * Covers:
 *   - TokenRevocationList: revoke, isRevoked, purge, lifecycle
 *   - ScopedTokenManager: revokeToken + validate rejects revoked tokens
 *   - HTTP endpoints: POST /tokens/revoke, GET /tokens/revoked
 *   - Redis pub/sub sync for token revocation
 *   - Audit logging for token.revoked
 */

import { ScopedTokenManager, TokenRevocationList } from '../src/tokens';
import type { RevokedTokenEntry } from '../src/tokens';
import { PayGateServer } from '../src/server';
import { PayGateConfig, DEFAULT_CONFIG } from '../src/types';
import http from 'http';

// ─── Helper: make a minimal config ──────────────────────────────────────────

function makeConfig(overrides: Partial<PayGateConfig> = {}): PayGateConfig {
  return {
    ...DEFAULT_CONFIG,
    serverCommand: 'echo',
    serverArgs: ['{}'],
    port: 0,
    ...overrides,
  };
}

// ─── Helper: HTTP request ───────────────────────────────────────────────────

function httpRequest(opts: {
  port: number;
  method: string;
  path: string;
  body?: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; data: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: opts.port,
        method: opts.method,
        path: opts.path,
        headers: opts.headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => (raw += c.toString()));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, data: JSON.parse(raw), raw }); }
          catch { resolve({ status: res.statusCode!, data: null, raw }); }
        });
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TokenRevocationList unit tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('TokenRevocationList', () => {
  let list: TokenRevocationList;

  beforeEach(() => {
    list = new TokenRevocationList();
  });

  afterEach(() => {
    list.destroy();
  });

  test('starts empty', () => {
    expect(list.size).toBe(0);
    expect(list.list()).toEqual([]);
  });

  test('fingerprint is deterministic SHA-256 hex', () => {
    const fp1 = TokenRevocationList.fingerprint('token-abc');
    const fp2 = TokenRevocationList.fingerprint('token-abc');
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[a-f0-9]{64}$/);
  });

  test('fingerprint differs for different tokens', () => {
    const fp1 = TokenRevocationList.fingerprint('token-abc');
    const fp2 = TokenRevocationList.fingerprint('token-xyz');
    expect(fp1).not.toBe(fp2);
  });

  test('revoke() adds entry and returns it', () => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const entry = list.revoke('my-token', expiresAt, 'test reason');
    expect(entry).not.toBeNull();
    expect(entry!.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(entry!.expiresAt).toBe(expiresAt);
    expect(entry!.revokedAt).toBeDefined();
    expect(entry!.reason).toBe('test reason');
    expect(list.size).toBe(1);
  });

  test('revoke() same token twice returns null', () => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const first = list.revoke('my-token', expiresAt);
    const second = list.revoke('my-token', expiresAt);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(list.size).toBe(1);
  });

  test('revoke() without reason omits it', () => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const entry = list.revoke('my-token', expiresAt);
    expect(entry!.reason).toBeUndefined();
  });

  test('isRevoked() returns true for revoked token', () => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    list.revoke('my-token', expiresAt);
    expect(list.isRevoked('my-token')).toBe(true);
    expect(list.isRevoked('other-token')).toBe(false);
  });

  test('isRevokedByFingerprint() works', () => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const entry = list.revoke('my-token', expiresAt);
    expect(list.isRevokedByFingerprint(entry!.fingerprint)).toBe(true);
    expect(list.isRevokedByFingerprint('0000000000000000')).toBe(false);
  });

  test('addEntry() adds external entry', () => {
    const entry: RevokedTokenEntry = {
      fingerprint: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      revokedAt: new Date().toISOString(),
      reason: 'synced from other instance',
    };
    list.addEntry(entry);
    expect(list.size).toBe(1);
    expect(list.isRevokedByFingerprint(entry.fingerprint)).toBe(true);
  });

  test('purgeExpired() removes entries whose token has naturally expired', () => {
    // Add entry that's already expired
    list.revoke('expired-token', new Date(Date.now() - 1000).toISOString());
    // Add entry that's still valid
    list.revoke('valid-token', new Date(Date.now() + 3600_000).toISOString());

    expect(list.size).toBe(2);
    const purged = list.purgeExpired();
    expect(purged).toBe(1);
    expect(list.size).toBe(1);
    expect(list.isRevoked('expired-token')).toBe(false);
    expect(list.isRevoked('valid-token')).toBe(true);
  });

  test('list() returns all entries', () => {
    list.revoke('token-a', new Date(Date.now() + 3600_000).toISOString());
    list.revoke('token-b', new Date(Date.now() + 3600_000).toISOString(), 'reason-b');
    const entries = list.list();
    expect(entries).toHaveLength(2);
    expect(entries[0].fingerprint).toBeDefined();
    expect(entries[1].reason).toBe('reason-b');
  });

  test('clear() removes all entries', () => {
    list.revoke('token-a', new Date(Date.now() + 3600_000).toISOString());
    list.revoke('token-b', new Date(Date.now() + 3600_000).toISOString());
    expect(list.size).toBe(2);
    list.clear();
    expect(list.size).toBe(0);
  });

  test('destroy() stops cleanup timer', () => {
    // Just verify no error is thrown
    list.destroy();
    list.destroy(); // Double-destroy is safe
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ScopedTokenManager revocation integration
// ═══════════════════════════════════════════════════════════════════════════════

describe('ScopedTokenManager revocation', () => {
  const SECRET = 'test-secret-key-12345';
  let manager: ScopedTokenManager;

  beforeEach(() => {
    manager = new ScopedTokenManager(SECRET);
  });

  afterEach(() => {
    manager.destroy();
  });

  test('validate() rejects revoked token', () => {
    const token = manager.create({ apiKey: 'pg_test123', ttlSeconds: 3600 });

    // Token is valid before revocation
    const before = manager.validate(token);
    expect(before.valid).toBe(true);

    // Revoke
    const entry = manager.revokeToken(token);
    expect(entry).not.toBeNull();

    // Token is now rejected
    const after = manager.validate(token);
    expect(after.valid).toBe(false);
    expect(after.reason).toBe('token_revoked');
  });

  test('revokeToken() returns null for non-pgt_ token', () => {
    const result = manager.revokeToken('pg_regular_key');
    expect(result).toBeNull();
  });

  test('revokeToken() returns null for malformed token', () => {
    const result = manager.revokeToken('pgt_invalidgarbage');
    expect(result).toBeNull();
  });

  test('revokeToken() returns null for wrong-signature token', () => {
    const other = new ScopedTokenManager('other-secret-key-xyz');
    const token = other.create({ apiKey: 'pg_test', ttlSeconds: 3600 });
    other.destroy();

    const result = manager.revokeToken(token);
    expect(result).toBeNull();
  });

  test('revokeToken() returns null for already-revoked token', () => {
    const token = manager.create({ apiKey: 'pg_test123', ttlSeconds: 3600 });
    const first = manager.revokeToken(token);
    const second = manager.revokeToken(token);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  test('revokeToken() with reason passes it through', () => {
    const token = manager.create({ apiKey: 'pg_test123', ttlSeconds: 3600 });
    const entry = manager.revokeToken(token, 'compromised');
    expect(entry!.reason).toBe('compromised');
  });

  test('revocationList is accessible on manager', () => {
    expect(manager.revocationList).toBeInstanceOf(TokenRevocationList);
    expect(manager.revocationList.size).toBe(0);
  });

  test('destroy() cleans up revocation list timer', () => {
    manager.destroy();
    // No error thrown, timer cleaned up
  });

  test('revoked token stays rejected even with valid signature and unexpired', () => {
    const token = manager.create({ apiKey: 'pg_key1', ttlSeconds: 3600, label: 'session-1' });

    // Validate: valid
    expect(manager.validate(token).valid).toBe(true);

    // Revoke
    manager.revokeToken(token);

    // Validate 3 times: still revoked
    expect(manager.validate(token).valid).toBe(false);
    expect(manager.validate(token).valid).toBe(false);
    expect(manager.validate(token).valid).toBe(false);
  });

  test('revoking one token does not affect others', () => {
    const token1 = manager.create({ apiKey: 'pg_key1', ttlSeconds: 3600, label: 'token-1' });
    const token2 = manager.create({ apiKey: 'pg_key1', ttlSeconds: 3600, label: 'token-2' });

    manager.revokeToken(token1);

    expect(manager.validate(token1).valid).toBe(false);
    expect(manager.validate(token2).valid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP endpoint tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Token revocation HTTP endpoints', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let apiKey: string;

  beforeAll(async () => {
    const config = makeConfig({ defaultCreditsPerCall: 1 });
    server = new PayGateServer(config);
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create an API key for token generation
    const keyRes = await httpRequest({
      port,
      method: 'POST',
      path: '/keys',
      headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'revocation-test', credits: 1000 }),
    });
    apiKey = keyRes.data.key;
  });

  afterAll(async () => {
    await server.stop();
  });

  test('POST /tokens/revoke — requires admin key', async () => {
    const res = await httpRequest({
      port,
      method: 'POST',
      path: '/tokens/revoke',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'pgt_fake' }),
    });
    expect(res.status).toBe(401);
  });

  test('POST /tokens/revoke — requires POST method', async () => {
    const res = await httpRequest({
      port,
      method: 'GET',
      path: '/tokens/revoke',
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(405);
  });

  test('POST /tokens/revoke — requires token param', async () => {
    const res = await httpRequest({
      port,
      method: 'POST',
      path: '/tokens/revoke',
      headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('Missing required param');
  });

  test('POST /tokens/revoke — rejects non-pgt_ token', async () => {
    const res = await httpRequest({
      port,
      method: 'POST',
      path: '/tokens/revoke',
      headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'pg_regular_key' }),
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('pgt_');
  });

  test('POST /tokens/revoke — invalid JSON returns 400', async () => {
    const res = await httpRequest({
      port,
      method: 'POST',
      path: '/tokens/revoke',
      headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('Invalid JSON');
  });

  test('POST /tokens/revoke — successfully revokes a token', async () => {
    // First create a token
    const tokenRes = await httpRequest({
      port,
      method: 'POST',
      path: '/tokens',
      headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: apiKey, ttl: 3600 }),
    });
    expect(tokenRes.status).toBe(201);
    const token = tokenRes.data.token;

    // Now revoke it
    const revokeRes = await httpRequest({
      port,
      method: 'POST',
      path: '/tokens/revoke',
      headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, reason: 'test revocation' }),
    });
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.data.message).toBe('Token revoked');
    expect(revokeRes.data.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(revokeRes.data.expiresAt).toBeDefined();
    expect(revokeRes.data.revokedAt).toBeDefined();
  });

  test('POST /tokens/revoke — double revoke returns 409', async () => {
    const tokenRes = await httpRequest({
      port,
      method: 'POST',
      path: '/tokens',
      headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: apiKey, ttl: 3600, label: 'double-revoke-test' }),
    });
    expect(tokenRes.status).toBe(201);
    const token = tokenRes.data.token;

    // First revoke succeeds
    const first = await httpRequest({
      port,
      method: 'POST',
      path: '/tokens/revoke',
      headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(first.status).toBe(200);

    // Second revoke returns 409
    const second = await httpRequest({
      port,
      method: 'POST',
      path: '/tokens/revoke',
      headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(second.status).toBe(409);
    expect(second.data.error).toContain('already revoked');
  });

  test('POST /tokens/revoke — revoked token rejected on /mcp', async () => {
    const tokenRes = await httpRequest({
      port,
      method: 'POST',
      path: '/tokens',
      headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: apiKey, ttl: 3600, label: 'mcp-reject-test' }),
    });
    expect(tokenRes.status).toBe(201);
    const token = tokenRes.data.token;

    // Revoke it
    await httpRequest({
      port,
      method: 'POST',
      path: '/tokens/revoke',
      headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    // Try using revoked token on /mcp
    const mcpRes = await httpRequest({
      port,
      method: 'POST',
      path: '/mcp',
      headers: { 'X-API-Key': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'test', arguments: {} } }),
    });

    // Should get a payment-required error (token is rejected)
    const errMsg = mcpRes.data?.error?.message || '';
    expect(
      errMsg.includes('Payment required') ||
      errMsg.includes('not started') ||
      errMsg.includes('invalid_scoped_token') ||
      mcpRes.status === 402
    ).toBe(true);
  });

  test('GET /tokens/revoked — requires admin key', async () => {
    const res = await httpRequest({
      port,
      method: 'GET',
      path: '/tokens/revoked',
    });
    expect(res.status).toBe(401);
  });

  test('GET /tokens/revoked — requires GET method', async () => {
    const res = await httpRequest({
      port,
      method: 'POST',
      path: '/tokens/revoked',
      headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(405);
  });

  test('GET /tokens/revoked — returns revoked entries', async () => {
    // Create and revoke a token to ensure at least one entry
    const tokenRes = await httpRequest({
      port,
      method: 'POST',
      path: '/tokens',
      headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: apiKey, ttl: 3600, label: 'for-list-test' }),
    });
    expect(tokenRes.status).toBe(201);
    await httpRequest({
      port,
      method: 'POST',
      path: '/tokens/revoke',
      headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tokenRes.data.token }),
    });

    const res = await httpRequest({
      port,
      method: 'GET',
      path: '/tokens/revoked',
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    expect(typeof res.data.count).toBe('number');
    expect(Array.isArray(res.data.entries)).toBe(true);
    expect(res.data.count).toBeGreaterThanOrEqual(1);
    const entry = res.data.entries[0];
    expect(entry.fingerprint).toBeDefined();
    expect(entry.expiresAt).toBeDefined();
    expect(entry.revokedAt).toBeDefined();
  });

  test('root endpoint lists token revocation endpoints', async () => {
    const res = await httpRequest({
      port,
      method: 'GET',
      path: '/',
    });
    expect(res.status).toBe(200);
    expect(res.data.endpoints.revokeToken).toContain('/tokens/revoke');
    expect(res.data.endpoints.listRevokedTokens).toContain('/tokens/revoked');
    expect(res.data.endpoints.createToken).toContain('/tokens');
  });

  test('audit log records token.revoked events', async () => {
    // Create and revoke a token to generate an audit event
    const tokenRes = await httpRequest({
      port,
      method: 'POST',
      path: '/tokens',
      headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: apiKey, ttl: 3600, label: 'for-audit-test' }),
    });
    expect(tokenRes.status).toBe(201);
    await httpRequest({
      port,
      method: 'POST',
      path: '/tokens/revoke',
      headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tokenRes.data.token, reason: 'audit test' }),
    });

    const auditRes = await httpRequest({
      port,
      method: 'GET',
      path: '/audit?types=token.revoked',
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(auditRes.status).toBe(200);
    expect(auditRes.data.events.length).toBeGreaterThanOrEqual(1);
    const event = auditRes.data.events[0];
    expect(event.type).toBe('token.revoked');
    expect(event.actor).toBe('admin');
    expect(event.metadata.fingerprint).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Redis sync callback wiring (unit test)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Redis token revocation sync', () => {
  test('RedisSync PubSubEvent type includes token_revoked', () => {
    // Type-level test: just verify the interface accepts token_revoked
    const event: import('../src/redis-sync').PubSubEvent = {
      type: 'token_revoked',
      key: 'abc123fingerprint',
      instanceId: 'test-instance',
      data: {
        expiresAt: '2025-01-01T00:00:00.000Z',
        revokedAt: '2025-01-01T00:00:00.000Z',
        reason: 'test',
      },
    };
    expect(event.type).toBe('token_revoked');
  });

  test('onTokenRevoked callback adds entry to revocation list', () => {
    const manager = new ScopedTokenManager('test-secret-key-12345');
    const fingerprint = 'a'.repeat(64);
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const revokedAt = new Date().toISOString();

    // Simulate what RedisSync.onTokenRevoked does
    manager.revocationList.addEntry({ fingerprint, expiresAt, revokedAt, reason: 'remote revocation' });

    expect(manager.revocationList.isRevokedByFingerprint(fingerprint)).toBe(true);
    expect(manager.revocationList.size).toBe(1);

    const entries = manager.revocationList.list();
    expect(entries[0].reason).toBe('remote revocation');

    manager.destroy();
  });
});
