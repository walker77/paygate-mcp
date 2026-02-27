/**
 * Error message sanitization tests — verifies that admin/OAuth endpoints
 * never leak raw exception details (stack traces, filesystem paths, internal
 * class names) to clients. Only known-safe validation messages pass through.
 *
 * v8.91.0: Catch blocks previously forwarded raw err.message to clients.
 * Now sanitized via safeErrorMessage() with an allowlist of safe patterns.
 */

import { PayGateServer } from '../src/server';
import { PayGateConfig } from '../src/types';
import http from 'http';
import * as path from 'path';

// Suppress logger output in tests
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

const MOCK_SERVER = path.join(__dirname, 'e2e', 'mock-mcp-server.js');

function makePostJson(portRef: { port: number }, adminKeyRef: { adminKey: string }) {
  return function postJson(urlPath: string, body: any, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1',
        port: portRef.port,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'X-Admin-Key': adminKeyRef.adminKey,
          ...headers,
        },
      }, (res) => {
        let chunks = '';
        res.on('data', (chunk) => chunks += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(chunks) });
          } catch {
            resolve({ status: res.statusCode!, body: chunks });
          }
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  };
}

/** List of strings that should NEVER appear in client-facing error responses */
const DANGEROUS_PATTERNS = [
  'ENOENT',
  'EACCES',
  'EISDIR',
  'ECONNREFUSED',
  'TypeError',
  'ReferenceError',
  'Cannot read prop',
  'undefined is not',
  '.ts:',          // TypeScript file paths
  '/home/',        // Unix paths
  '/Users/',       // macOS paths
  'node_modules',  // dependency paths
  'at Object.',    // stack trace frames
  'at Module.',    // stack trace frames
];

function assertNoLeakedDetails(responseBody: any): void {
  const bodyStr = JSON.stringify(responseBody);
  for (const pattern of DANGEROUS_PATTERNS) {
    expect(bodyStr).not.toContain(pattern);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Test suite 1: Admin endpoints (no OAuth)
// ═══════════════════════════════════════════════════════════════════
describe('Error message sanitization — admin endpoints', () => {
  let server: PayGateServer;
  const portRef = { port: 0 };
  const adminKeyRef = { adminKey: '' };
  let postJson: ReturnType<typeof makePostJson>;
  let testKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      requestTimeoutMs: 3000,
    });
    const started = await server.start();
    portRef.port = started.port;
    adminKeyRef.adminKey = started.adminKey;
    postJson = makePostJson(portRef, adminKeyRef);

    const res = await postJson('/keys', { credits: 1000, name: 'error-sanitization-test' });
    testKey = res.body.key;
  });

  afterAll(async () => {
    await server.gracefulStop(1000);
  });

  // ── Config reload ──────────────────────────────────────────────
  describe('POST /config/reload — filesystem error sanitization', () => {
    test('does not leak filesystem paths on missing config file', async () => {
      const res = await postJson('/config/reload', {
        path: '/nonexistent/path/config.json',
      });
      expect(res.status).toBe(400);
      assertNoLeakedDetails(res.body);
      expect(res.body.error).not.toMatch(/ENOENT/);
      expect(res.body.error).not.toMatch(/\/nonexistent/);
    });

    test('does not leak JSON parse errors', async () => {
      const res = await postJson('/config/reload', {
        path: '/dev/null',
      });
      expect(res.status).toBe(400);
      assertNoLeakedDetails(res.body);
    });
  });

  // ── Webhook filters ────────────────────────────────────────────
  describe('Webhook filter endpoints — error sanitization', () => {
    test('missing URL returns sanitized error', async () => {
      const res = await postJson('/webhooks/filters', {
        name: 'test-filter',
        events: ['key.created'],
      });
      expect(res.status).toBe(400);
      assertNoLeakedDetails(res.body);
    });

    test('missing events returns sanitized error', async () => {
      const res = await postJson('/webhooks/filters', {
        name: 'test-filter',
        url: 'https://example.com/webhook',
        events: [],
      });
      expect(res.status).toBe(400);
      assertNoLeakedDetails(res.body);
    });

    test('update non-existent filter returns sanitized error', async () => {
      const res = await postJson('/webhooks/filters/update', {
        id: 'nonexistent-filter-id',
        name: 'updated-name',
      });
      expect(res.status).toBe(400);
      assertNoLeakedDetails(res.body);
    });
  });

  // ── Groups ─────────────────────────────────────────────────────
  describe('Group endpoints — error sanitization', () => {
    test('create group without name returns sanitized error', async () => {
      const res = await postJson('/groups', {});
      expect(res.status).toBe(400);
      assertNoLeakedDetails(res.body);
    });

    test('update non-existent group returns sanitized error', async () => {
      const res = await postJson('/groups/update', {
        id: 'nonexistent-group-id',
        name: 'updated-group',
      });
      expect(res.status).toBe(400);
      assertNoLeakedDetails(res.body);
    });

    test('assign key to non-existent group returns sanitized error', async () => {
      const res = await postJson('/groups/assign', {
        key: testKey,
        groupId: 'nonexistent-group-id',
      });
      expect(res.status).toBe(400);
      assertNoLeakedDetails(res.body);
    });
  });

  // ── Bulk operations ────────────────────────────────────────────
  describe('Bulk operations — error sanitization', () => {
    test('bulk operation errors do not leak internal details', async () => {
      const res = await postJson('/keys/bulk', {
        operations: [
          { action: 'topup', key: 'nonexistent-key-12345', credits: 100 },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.results[0].success).toBe(false);
      assertNoLeakedDetails(res.body);
    });
  });

  // ── Known-safe messages pass through ──────────────────────────
  describe('Known-safe validation messages pass through', () => {
    test('duplicate group name shows original message', async () => {
      const createRes = await postJson('/groups', {
        name: 'unique-error-test-group',
      });
      expect(createRes.status).toBe(201);

      const dupRes = await postJson('/groups', {
        name: 'unique-error-test-group',
      });
      expect(dupRes.status).toBe(400);
      expect(dupRes.body.error).toMatch(/already exists/i);
    });

    test('webhook filter missing URL shows safe validation message', async () => {
      const res = await postJson('/webhooks/filters', {
        name: 'no-url-filter',
        events: ['key.created'],
      });
      expect(res.status).toBe(400);
      assertNoLeakedDetails(res.body);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Test suite 2: OAuth endpoints (requires OAuth config)
// ═══════════════════════════════════════════════════════════════════
describe('Error message sanitization — OAuth endpoints', () => {
  let server: PayGateServer;
  const portRef = { port: 0 };
  const adminKeyRef = { adminKey: '' };
  let postJson: ReturnType<typeof makePostJson>;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'node',
      serverArgs: [MOCK_SERVER],
      port: 0,
      requestTimeoutMs: 5000,
      oauth: { issuer: 'http://localhost' },
    } as PayGateConfig & { serverCommand: string });
    const started = await server.start();
    portRef.port = started.port;
    adminKeyRef.adminKey = started.adminKey;
    postJson = makePostJson(portRef, adminKeyRef);
  });

  afterAll(async () => {
    await server.gracefulStop(1000);
  });

  test('register with missing fields returns sanitized error', async () => {
    const res = await postJson('/oauth/register', {});
    expect(res.status).toBe(400);
    assertNoLeakedDetails(res.body);
    expect(res.body.error).toBe('invalid_client_metadata');
    // error_description should exist but not leak internal stack
    expect(res.body.error_description).toBeDefined();
    expect(res.body.error_description).not.toMatch(/at /);
  });

  test('token exchange with invalid grant returns sanitized error', async () => {
    const res = await postJson('/oauth/token', {
      grant_type: 'authorization_code',
      code: 'invalid-auth-code',
      client_id: 'nonexistent-client',
      redirect_uri: 'https://example.com/callback',
      code_verifier: 'test-verifier',
    });
    expect(res.status).toBe(400);
    assertNoLeakedDetails(res.body);
    expect(res.body.error).toBeDefined();
  });

  test('register with invalid redirect URI returns sanitized error', async () => {
    const res = await postJson('/oauth/register', {
      client_name: 'test-client',
      redirect_uris: ['not-a-valid-uri'],
    });
    expect(res.status).toBe(400);
    assertNoLeakedDetails(res.body);
    expect(res.body.error).toBe('invalid_client_metadata');
  });
});
