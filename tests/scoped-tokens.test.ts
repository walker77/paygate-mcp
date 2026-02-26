/**
 * Tests for Scoped Tokens (v3.0.0)
 *
 * Covers:
 *   - ScopedTokenManager: create, validate, expiry, signature, edge cases
 *   - Gate ACL narrowing with scopedTokenTools
 *   - Gate batch with scopedTokenTools
 *   - Gate filterToolsForKey with scopedTokenTools
 *   - HTTP endpoints: POST /tokens, X-API-Key with pgt_ token, Bearer with pgt_ token
 */

import { ScopedTokenManager, TokenPayload } from '../src/tokens';
import { Gate } from '../src/gate';
import { PayGateConfig, DEFAULT_CONFIG } from '../src/types';
import { PayGateServer } from '../src/server';
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
// ScopedTokenManager unit tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('ScopedTokenManager', () => {
  const SECRET = 'test-secret-key-12345';
  let manager: ScopedTokenManager;

  beforeEach(() => {
    manager = new ScopedTokenManager(SECRET);
  });

  test('constructor requires secret >= 8 chars', () => {
    expect(() => new ScopedTokenManager('')).toThrow('at least 8 characters');
    expect(() => new ScopedTokenManager('short')).toThrow('at least 8 characters');
    expect(() => new ScopedTokenManager('12345678')).not.toThrow();
  });

  test('create() returns token with pgt_ prefix', () => {
    const token = manager.create({ apiKey: 'key-123' });
    expect(token).toMatch(/^pgt_/);
    expect(token).toContain('.');
  });

  test('validate() returns valid for fresh token', () => {
    const token = manager.create({ apiKey: 'key-123' });
    const result = manager.validate(token);
    expect(result.valid).toBe(true);
    expect(result.payload?.apiKey).toBe('key-123');
    expect(result.payload?.issuedAt).toBeDefined();
    expect(result.payload?.expiresAt).toBeDefined();
  });

  test('validate() preserves allowedTools', () => {
    const token = manager.create({ apiKey: 'key-123', allowedTools: ['tool-a', 'tool-b'] });
    const result = manager.validate(token);
    expect(result.valid).toBe(true);
    expect(result.payload?.allowedTools).toEqual(['tool-a', 'tool-b']);
  });

  test('validate() preserves label', () => {
    const token = manager.create({ apiKey: 'key-123', label: 'temp-agent' });
    const result = manager.validate(token);
    expect(result.valid).toBe(true);
    expect(result.payload?.label).toBe('temp-agent');
  });

  test('create() omits empty allowedTools and label', () => {
    const token = manager.create({ apiKey: 'key-123', allowedTools: [] });
    const result = manager.validate(token);
    expect(result.valid).toBe(true);
    expect(result.payload?.allowedTools).toBeUndefined();
    expect(result.payload?.label).toBeUndefined();
  });

  test('validate() rejects expired token', () => {
    const token = manager.create({
      apiKey: 'key-123',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const result = manager.validate(token);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('token_expired');
  });

  test('validate() rejects tampered signature', () => {
    const token = manager.create({ apiKey: 'key-123' });
    const parts = token.split('.');
    parts[parts.length - 1] = 'tampered' + parts[parts.length - 1].slice(8);
    const tampered = parts.join('.');
    const result = manager.validate(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });

  test('validate() rejects tampered payload', () => {
    const token = manager.create({ apiKey: 'key-123' });
    const body = token.slice(4);
    const dotIdx = body.lastIndexOf('.');
    const payloadPart = body.slice(0, dotIdx);
    const sigPart = body.slice(dotIdx + 1);
    const tamperedPayload = payloadPart.slice(0, -1) + (payloadPart.slice(-1) === 'A' ? 'B' : 'A');
    const tampered = `pgt_${tamperedPayload}.${sigPart}`;
    const result = manager.validate(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });

  test('validate() rejects token without prefix', () => {
    const result = manager.validate('not-a-token');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('not_a_scoped_token');
  });

  test('validate() rejects malformed token (no dot)', () => {
    const result = manager.validate('pgt_nodothere');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('malformed_token');
  });

  test('validate() rejects token signed with different secret', () => {
    const other = new ScopedTokenManager('other-secret-key-12345');
    const token = other.create({ apiKey: 'key-123' });
    const result = manager.validate(token);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });

  test('create() respects ttlSeconds', () => {
    const token = manager.create({ apiKey: 'key-123', ttlSeconds: 60 });
    const result = manager.validate(token);
    expect(result.valid).toBe(true);
    const expiresAt = new Date(result.payload!.expiresAt).getTime();
    const issuedAt = new Date(result.payload!.issuedAt).getTime();
    expect(expiresAt - issuedAt).toBeLessThanOrEqual(61_000);
    expect(expiresAt - issuedAt).toBeGreaterThanOrEqual(59_000);
  });

  test('create() caps TTL at 24 hours', () => {
    const token = manager.create({ apiKey: 'key-123', ttlSeconds: 999999 });
    const result = manager.validate(token);
    expect(result.valid).toBe(true);
    const expiresAt = new Date(result.payload!.expiresAt).getTime();
    const issuedAt = new Date(result.payload!.issuedAt).getTime();
    expect(expiresAt - issuedAt).toBeLessThanOrEqual(86401_000);
  });

  test('validate() rejects TTL > 24h if manually crafted', () => {
    const token = manager.create({
      apiKey: 'key-123',
      expiresAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    });
    const result = manager.validate(token);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('token_ttl_exceeded');
  });

  test('isToken() returns true for pgt_ prefix', () => {
    expect(ScopedTokenManager.isToken('pgt_abc.def')).toBe(true);
    expect(ScopedTokenManager.isToken('pgt_')).toBe(true);
  });

  test('isToken() returns false for non-pgt_ strings', () => {
    expect(ScopedTokenManager.isToken('sk-12345')).toBe(false);
    expect(ScopedTokenManager.isToken('admin_key')).toBe(false);
    expect(ScopedTokenManager.isToken('')).toBe(false);
  });

  test('default TTL is 1 hour', () => {
    const token = manager.create({ apiKey: 'key-123' });
    const result = manager.validate(token);
    const expiresAt = new Date(result.payload!.expiresAt).getTime();
    const issuedAt = new Date(result.payload!.issuedAt).getTime();
    expect(expiresAt - issuedAt).toBeLessThanOrEqual(3601_000);
    expect(expiresAt - issuedAt).toBeGreaterThanOrEqual(3599_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Gate ACL narrowing with scopedTokenTools
// ═══════════════════════════════════════════════════════════════════════════════

describe('Gate scoped token ACL narrowing', () => {
  test('evaluate() denies tool not in scopedTokenTools', () => {
    const gate = new Gate(makeConfig());
    const record = gate.store.createKey('test-key', 100);
    const decision = gate.evaluate(record.key, { name: 'tool-a', arguments: {} }, undefined, ['tool-b', 'tool-c']);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('token_tool_not_allowed');
  });

  test('evaluate() allows tool that IS in scopedTokenTools', () => {
    const gate = new Gate(makeConfig());
    const record = gate.store.createKey('test-key', 100);
    const decision = gate.evaluate(record.key, { name: 'tool-a', arguments: {} }, undefined, ['tool-a', 'tool-b']);
    expect(decision.allowed).toBe(true);
  });

  test('evaluate() ignores scopedTokenTools when empty', () => {
    const gate = new Gate(makeConfig());
    const record = gate.store.createKey('test-key', 100);
    const decision = gate.evaluate(record.key, { name: 'tool-a', arguments: {} }, undefined, []);
    expect(decision.allowed).toBe(true);
  });

  test('evaluate() ignores scopedTokenTools when undefined', () => {
    const gate = new Gate(makeConfig());
    const record = gate.store.createKey('test-key', 100);
    const decision = gate.evaluate(record.key, { name: 'tool-a', arguments: {} }, undefined, undefined);
    expect(decision.allowed).toBe(true);
  });

  test('evaluate() applies both key ACL AND scoped token ACL (intersection)', () => {
    const gate = new Gate(makeConfig());
    const record = gate.store.createKey('test-key', 100);
    gate.store.setAcl(record.key, ['tool-a', 'tool-b'], []);

    const decisionA = gate.evaluate(record.key, { name: 'tool-a', arguments: {} }, undefined, ['tool-b', 'tool-c']);
    expect(decisionA.allowed).toBe(false); // key allows tool-a, but token doesn't

    const decisionB = gate.evaluate(record.key, { name: 'tool-b', arguments: {} }, undefined, ['tool-b', 'tool-c']);
    expect(decisionB.allowed).toBe(true); // both key and token allow tool-b

    const decisionC = gate.evaluate(record.key, { name: 'tool-c', arguments: {} }, undefined, ['tool-b', 'tool-c']);
    expect(decisionC.allowed).toBe(false); // token allows tool-c, but key doesn't
  });

  test('scoped token denial in shadow mode still allows', () => {
    const gate = new Gate(makeConfig({ shadowMode: true }));
    const record = gate.store.createKey('test-key', 100);
    const decision = gate.evaluate(record.key, { name: 'tool-a', arguments: {} }, undefined, ['tool-b']);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain('shadow:token_tool_not_allowed');
  });

  test('scoped token denial records usage event', () => {
    const gate = new Gate(makeConfig());
    const record = gate.store.createKey('test-key', 100);
    gate.evaluate(record.key, { name: 'tool-a', arguments: {} }, undefined, ['tool-b']);
    const events = gate.meter.getEvents();
    expect(events.length).toBe(1);
    expect(events[0].allowed).toBe(false);
    expect(events[0].denyReason).toContain('token_tool_not_allowed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Gate batch with scopedTokenTools
// ═══════════════════════════════════════════════════════════════════════════════

describe('Gate batch scoped token ACL narrowing', () => {
  test('evaluateBatch() denies batch when any call not in scopedTokenTools', () => {
    const gate = new Gate(makeConfig());
    const record = gate.store.createKey('test-key', 100);
    const result = gate.evaluateBatch(record.key, [
      { name: 'tool-a', arguments: {} },
      { name: 'tool-b', arguments: {} },
    ], undefined, ['tool-a']);
    expect(result.allAllowed).toBe(false);
    expect(result.reason).toContain('token_tool_not_allowed');
    expect(result.failedIndex).toBe(1);
  });

  test('evaluateBatch() allows batch when all calls in scopedTokenTools', () => {
    const gate = new Gate(makeConfig());
    const record = gate.store.createKey('test-key', 100);
    const result = gate.evaluateBatch(record.key, [
      { name: 'tool-a', arguments: {} },
      { name: 'tool-b', arguments: {} },
    ], undefined, ['tool-a', 'tool-b']);
    expect(result.allAllowed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Gate filterToolsForKey with scopedTokenTools
// ═══════════════════════════════════════════════════════════════════════════════

describe('Gate filterToolsForKey with scopedTokenTools', () => {
  test('filters tools list by scoped token allowedTools', () => {
    const gate = new Gate(makeConfig());
    const record = gate.store.createKey('test-key', 100);
    const tools = [{ name: 'tool-a' }, { name: 'tool-b' }, { name: 'tool-c' }];
    const filtered = gate.filterToolsForKey(record.key, tools, ['tool-a', 'tool-c']);
    expect(filtered).toHaveLength(2);
    expect(filtered!.map(t => t.name)).toEqual(['tool-a', 'tool-c']);
  });

  test('applies intersection of key ACL and token ACL', () => {
    const gate = new Gate(makeConfig());
    const record = gate.store.createKey('test-key', 100);
    gate.store.setAcl(record.key, ['tool-a', 'tool-b'], []);
    const tools = [{ name: 'tool-a' }, { name: 'tool-b' }, { name: 'tool-c' }];
    const filtered = gate.filterToolsForKey(record.key, tools, ['tool-b', 'tool-c']);
    expect(filtered).toHaveLength(1);
    expect(filtered![0].name).toBe('tool-b');
  });

  test('returns null when no ACL restrictions', () => {
    const gate = new Gate(makeConfig());
    const record = gate.store.createKey('test-key', 100);
    const tools = [{ name: 'tool-a' }, { name: 'tool-b' }];
    const filtered = gate.filterToolsForKey(record.key, tools);
    expect(filtered).toBeNull();
  });

  test('applies token ACL even with no key ACL', () => {
    const gate = new Gate(makeConfig());
    const record = gate.store.createKey('test-key', 100);
    const tools = [{ name: 'tool-a' }, { name: 'tool-b' }, { name: 'tool-c' }];
    const filtered = gate.filterToolsForKey(record.key, tools, ['tool-a']);
    expect(filtered).toHaveLength(1);
    expect(filtered![0].name).toBe('tool-a');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP endpoint tests (admin endpoints — no /mcp since we need a real proxy)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Scoped token HTTP endpoints', () => {
  const ADMIN_KEY = 'test-admin-key-scoped-tokens';
  let server: PayGateServer;
  let port: number;

  beforeAll(async () => {
    port = 30000 + Math.floor(Math.random() * 10000);
    server = new PayGateServer(
      { ...DEFAULT_CONFIG, port, name: 'Token Test', serverCommand: 'echo', serverArgs: ['{}'] },
      ADMIN_KEY,
    );
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  test('POST /tokens creates a scoped token', async () => {
    // First create an API key
    const keyRes = await httpRequest({
      port, method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ credits: 100, name: 'parent-key' }),
    });
    expect(keyRes.status).toBe(201);
    const apiKey = keyRes.data.key;

    // Create a scoped token
    const tokenRes = await httpRequest({
      port, method: 'POST', path: '/tokens',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: apiKey, ttl: 300, allowedTools: ['tool-a'], label: 'test-token' }),
    });

    expect(tokenRes.status).toBe(201);
    expect(tokenRes.data.token).toMatch(/^pgt_/);
    expect(tokenRes.data.ttl).toBe(300);
    expect(tokenRes.data.parentKey).toBe('parent-key');
    expect(tokenRes.data.allowedTools).toEqual(['tool-a']);
    expect(tokenRes.data.label).toBe('test-token');
    expect(tokenRes.data.expiresAt).toBeDefined();
    expect(tokenRes.data.message).toContain('X-API-Key');
  });

  test('POST /tokens requires admin key', async () => {
    const res = await httpRequest({
      port, method: 'POST', path: '/tokens',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'fake' }),
    });
    expect(res.status).toBe(401);
  });

  test('POST /tokens requires key param', async () => {
    const res = await httpRequest({
      port, method: 'POST', path: '/tokens',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('Missing required param');
  });

  test('POST /tokens validates parent key exists', async () => {
    const res = await httpRequest({
      port, method: 'POST', path: '/tokens',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'nonexistent' }),
    });
    expect(res.status).toBe(404);
    expect(res.data.error).toContain('not found');
  });

  test('POST /tokens validates parent key is active', async () => {
    // Create and revoke a key
    const keyRes = await httpRequest({
      port, method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ credits: 100, name: 'revoked-key' }),
    });
    const revokedKey = keyRes.data.key;
    await httpRequest({
      port, method: 'POST', path: '/keys/revoke',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: revokedKey }),
    });

    const res = await httpRequest({
      port, method: 'POST', path: '/tokens',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: revokedKey }),
    });
    expect(res.status).toBe(404);
    expect(res.data.error).toContain('not found or inactive');
  });

  test('POST /tokens defaults TTL to 3600 when not provided', async () => {
    const keyRes = await httpRequest({
      port, method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ credits: 100, name: 'default-ttl-key' }),
    });
    const apiKey = keyRes.data.key;

    const tokenRes = await httpRequest({
      port, method: 'POST', path: '/tokens',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: apiKey }),
    });
    expect(tokenRes.status).toBe(201);
    expect(tokenRes.data.ttl).toBe(3600);
  });

  test('POST /tokens caps TTL at 86400', async () => {
    const keyRes = await httpRequest({
      port, method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ credits: 100, name: 'capped-ttl-key' }),
    });
    const apiKey = keyRes.data.key;

    const tokenRes = await httpRequest({
      port, method: 'POST', path: '/tokens',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: apiKey, ttl: 999999 }),
    });
    expect(tokenRes.status).toBe(201);
    expect(tokenRes.data.ttl).toBe(86400);
  });

  test('scoped token resolves to parent key on /mcp (invalid token rejected)', async () => {
    // Use a fabricated invalid token — should be treated as invalid API key
    const mcpRes = await httpRequest({
      port, method: 'POST', path: '/mcp',
      headers: { 'X-API-Key': 'pgt_invalid.token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'some-tool', arguments: {} },
      }),
    });
    expect(mcpRes.status).toBe(200);
    expect(mcpRes.data.error).toBeDefined();
    expect(mcpRes.data.error.message).toContain('Payment required');
  });

  test('valid scoped token resolves to parent key for free methods', async () => {
    // Create a key and token
    const keyRes = await httpRequest({
      port, method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ credits: 100, name: 'token-mcp-key' }),
    });
    const apiKey = keyRes.data.key;

    const tokenRes = await httpRequest({
      port, method: 'POST', path: '/tokens',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: apiKey }),
    });
    const token = tokenRes.data.token;

    // Use token as X-API-Key on /mcp — initialize is free method
    const mcpRes = await httpRequest({
      port, method: 'POST', path: '/mcp',
      headers: { 'X-API-Key': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      }),
    });
    // Should not get missing_api_key error (token resolved to parent key)
    // May get "Server not started" since echo isn't a real MCP server, that's fine
    if (mcpRes.data?.error) {
      const errMsg = mcpRes.data.error.message || '';
      expect(errMsg).not.toContain('missing_api_key');
    }
  });

  test('scoped token works as Bearer token', async () => {
    // Create a key and token
    const keyRes = await httpRequest({
      port, method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ credits: 100, name: 'bearer-token-key' }),
    });
    const apiKey = keyRes.data.key;

    const tokenRes = await httpRequest({
      port, method: 'POST', path: '/tokens',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: apiKey }),
    });
    const token = tokenRes.data.token;

    // Use token as Bearer on /mcp
    const mcpRes = await httpRequest({
      port, method: 'POST', path: '/mcp',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      }),
    });
    // Should not get missing_api_key error (token resolved)
    if (mcpRes.data?.error) {
      expect(mcpRes.data.error.message).not.toContain('missing_api_key');
    }
  });
});
