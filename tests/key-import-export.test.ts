/**
 * Tests for v4.1.0 — Key Import/Export
 *
 * GET  /keys/export — Export all API keys for backup/migration
 * POST /keys/import — Import API keys from backup with conflict resolution
 */

import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';
import http from 'http';

// ─── Echo MCP backend ─────────────────────────────────────────────────────────

const ECHO_CMD = 'node';
const ECHO_ARGS = ['-e', `
  process.stdin.resume();
  process.stdin.on('data', d => {
    const r = JSON.parse(d.toString().trim());
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: {} }) + '\\n');
  });
`];

// ─── Helper: HTTP request ─────────────────────────────────────────────────────

function request(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown> | unknown[],
  headers?: Record<string, string>,
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => (buf += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(buf), headers: res.headers as Record<string, string> });
          } catch {
            resolve({ status: res.statusCode!, body: buf, headers: res.headers as Record<string, string> });
          }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Key Import/Export — GET /keys/export + POST /keys/import', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      ...DEFAULT_CONFIG,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      port: 0,
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop();
  });

  // ─── Export Tests ──────────────────────────────────────────────────────────

  test('should export keys as JSON', async () => {
    // Create some keys first
    await request(port, 'POST', '/keys', { credits: 500, name: 'export-key-1' }, { 'X-Admin-Key': adminKey });
    await request(port, 'POST', '/keys', { credits: 300, name: 'export-key-2' }, { 'X-Admin-Key': adminKey });

    const res = await request(port, 'GET', '/keys/export', undefined, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.version).toBe('1.0');
    expect(res.body.exportedAt).toBeDefined();
    expect(res.body.count).toBeGreaterThanOrEqual(2);
    expect(res.body.keys.length).toBe(res.body.count);

    // Verify full key secrets are included
    const key1 = res.body.keys.find((k: any) => k.name === 'export-key-1');
    expect(key1).toBeDefined();
    expect(key1.key).toMatch(/^pg_/);
    expect(key1.key.length).toBeGreaterThan(10); // Full key, not masked
    expect(key1.credits).toBe(500);
  });

  test('should export keys as CSV', async () => {
    const res = await request(port, 'GET', '/keys/export?format=csv', undefined, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv');
    expect(res.headers['content-disposition']).toContain('.csv');

    // CSV should be a string, not JSON
    const csv = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    expect(csv).toContain('key,name,credits');
  });

  test('should filter export by namespace', async () => {
    await request(port, 'POST', '/keys', { credits: 100, name: 'ns-key', namespace: 'team-a' }, { 'X-Admin-Key': adminKey });

    const res = await request(port, 'GET', '/keys/export?namespace=team-a', undefined, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.keys.length).toBeGreaterThanOrEqual(1);
    for (const k of res.body.keys) {
      expect(k.namespace).toBe('team-a');
    }
  });

  test('should filter export by active status', async () => {
    // Create and revoke a key
    const createRes = await request(port, 'POST', '/keys', { credits: 50, name: 'revoked-export' }, { 'X-Admin-Key': adminKey });
    await request(port, 'POST', '/keys/revoke', { key: createRes.body.key }, { 'X-Admin-Key': adminKey });

    // Export active only
    const activeRes = await request(port, 'GET', '/keys/export?activeOnly=true', undefined, { 'X-Admin-Key': adminKey });
    expect(activeRes.status).toBe(200);
    for (const k of activeRes.body.keys) {
      expect(k.active).toBe(true);
    }

    // Export all (includes revoked)
    const allRes = await request(port, 'GET', '/keys/export', undefined, { 'X-Admin-Key': adminKey });
    expect(allRes.body.count).toBeGreaterThan(activeRes.body.count);
  });

  test('should require admin auth for export', async () => {
    const res = await request(port, 'GET', '/keys/export');
    expect(res.status).toBe(401);
  });

  test('should reject POST for export', async () => {
    const res = await request(port, 'POST', '/keys/export', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(405);
  });

  test('export should include Content-Disposition header', async () => {
    const res = await request(port, 'GET', '/keys/export', undefined, { 'X-Admin-Key': adminKey });
    expect(res.headers['content-disposition']).toContain('paygate-keys-');
    expect(res.headers['content-disposition']).toContain('.json');
  });

  // ─── Import Tests ──────────────────────────────────────────────────────────

  test('should import keys in skip mode (default)', async () => {
    const keysToImport = [
      { key: 'pg_import_test_' + Date.now() + '_aaa', name: 'imported-a', credits: 100, active: true, tags: {} },
      { key: 'pg_import_test_' + Date.now() + '_bbb', name: 'imported-b', credits: 200, active: true, tags: {} },
    ];

    const res = await request(port, 'POST', '/keys/import', { keys: keysToImport }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.imported).toBe(2);
    expect(res.body.skipped).toBe(0);
    expect(res.body.errors).toBe(0);
    expect(res.body.mode).toBe('skip');
  });

  test('should skip existing keys in skip mode', async () => {
    const key = 'pg_skip_test_' + Date.now();
    const keysToImport = [
      { key, name: 'first-import', credits: 100, active: true, tags: {} },
    ];

    // Import once
    await request(port, 'POST', '/keys/import', { keys: keysToImport }, { 'X-Admin-Key': adminKey });

    // Import again — should skip
    const res = await request(port, 'POST', '/keys/import', {
      keys: [{ key, name: 'second-import', credits: 999, active: true, tags: {} }],
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(1);
    expect(res.body.imported).toBe(0);
    expect(res.body.results[0].status).toBe('skipped');
  });

  test('should overwrite existing keys in overwrite mode', async () => {
    const key = 'pg_overwrite_test_' + Date.now();

    // Import once
    await request(port, 'POST', '/keys/import', {
      keys: [{ key, name: 'original', credits: 100, active: true, tags: {} }],
    }, { 'X-Admin-Key': adminKey });

    // Import again with overwrite
    const res = await request(port, 'POST', '/keys/import', {
      keys: [{ key, name: 'updated', credits: 999, active: true, tags: {} }],
      mode: 'overwrite',
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.overwritten).toBe(1);
    expect(res.body.results[0].status).toBe('overwritten');
  });

  test('should error on existing keys in error mode', async () => {
    const key = 'pg_error_test_' + Date.now();

    // Import once
    await request(port, 'POST', '/keys/import', {
      keys: [{ key, name: 'original', credits: 100, active: true, tags: {} }],
    }, { 'X-Admin-Key': adminKey });

    // Import again with error mode
    const res = await request(port, 'POST', '/keys/import', {
      keys: [{ key, name: 'duplicate', credits: 999, active: true, tags: {} }],
      mode: 'error',
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBe(1);
    expect(res.body.results[0].status).toBe('error');
    expect(res.body.results[0].error).toContain('already exists');
  });

  test('should reject keys without pg_ prefix', async () => {
    const res = await request(port, 'POST', '/keys/import', {
      keys: [{ key: 'invalid_key_format', name: 'bad', credits: 100 }],
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBe(1);
    expect(res.body.results[0].status).toBe('error');
    expect(res.body.results[0].error).toContain('pg_');
  });

  test('should reject keys with missing key field', async () => {
    const res = await request(port, 'POST', '/keys/import', {
      keys: [{ name: 'no-key', credits: 100 }],
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.errors).toBe(1);
    expect(res.body.results[0].status).toBe('error');
  });

  test('should reject empty keys array', async () => {
    const res = await request(port, 'POST', '/keys/import', {
      keys: [],
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('empty');
  });

  test('should reject missing keys field', async () => {
    const res = await request(port, 'POST', '/keys/import', {}, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('keys');
  });

  test('should reject more than 1000 keys', async () => {
    const keys = Array.from({ length: 1001 }, (_, i) => ({
      key: `pg_bulk_${i}_${Date.now()}`,
      name: `key-${i}`,
      credits: 10,
    }));

    const res = await request(port, 'POST', '/keys/import', { keys }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('1000');
  });

  test('should require admin auth for import', async () => {
    const res = await request(port, 'POST', '/keys/import', {
      keys: [{ key: 'pg_test', name: 'test', credits: 100 }],
    });
    expect(res.status).toBe(401);
  });

  test('should reject GET for import', async () => {
    const res = await request(port, 'GET', '/keys/import', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(405);
  });

  test('should reject invalid JSON for import', async () => {
    const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/keys/import',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
        },
        (res) => {
          let buf = '';
          res.on('data', (chunk) => (buf += chunk));
          res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(buf) }));
        },
      );
      req.on('error', reject);
      req.write('not json');
      req.end();
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid JSON');
  });

  // ─── Round-trip Test ──────────────────────────────────────────────────────

  test('should round-trip export/import preserving all data', async () => {
    // Create a key with specific settings
    const createRes = await request(port, 'POST', '/keys', {
      credits: 777, name: 'roundtrip-key', tags: { project: 'alpha' },
    }, { 'X-Admin-Key': adminKey });
    const keyId = createRes.body.key;

    // Export
    const exportRes = await request(port, 'GET', '/keys/export', undefined, { 'X-Admin-Key': adminKey });
    expect(exportRes.status).toBe(200);

    const exported = exportRes.body.keys.find((k: any) => k.key === keyId);
    expect(exported).toBeDefined();
    expect(exported.name).toBe('roundtrip-key');
    expect(exported.credits).toBe(777);
    expect(exported.tags).toEqual({ project: 'alpha' });

    // Create new server to import into
    const server2 = new PayGateServer({
      ...DEFAULT_CONFIG,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      port: 0,
    });
    const started2 = await server2.start();

    try {
      // Import the exported key
      const importRes = await request(started2.port, 'POST', '/keys/import', {
        keys: [exported],
      }, { 'X-Admin-Key': started2.adminKey });

      expect(importRes.status).toBe(200);
      expect(importRes.body.imported).toBe(1);

      // Verify the imported key exists in the new server
      const exportRes2 = await request(started2.port, 'GET', '/keys/export', undefined, { 'X-Admin-Key': started2.adminKey });
      const reimported = exportRes2.body.keys.find((k: any) => k.key === keyId);
      expect(reimported).toBeDefined();
      expect(reimported.name).toBe('roundtrip-key');
      expect(reimported.credits).toBe(777);
      expect(reimported.tags).toEqual({ project: 'alpha' });
    } finally {
      await server2.gracefulStop();
    }
  });

  test('should preserve ACL, quota, and namespace on import', async () => {
    const key = 'pg_fulldata_test_' + Date.now();
    const fullRecord = {
      key,
      name: 'full-data-key',
      credits: 500,
      totalSpent: 100,
      totalCalls: 10,
      active: true,
      spendingLimit: 1000,
      allowedTools: ['tool_a', 'tool_b'],
      deniedTools: ['tool_c'],
      expiresAt: '2030-01-01T00:00:00.000Z',
      tags: { env: 'staging', tier: 'premium' },
      ipAllowlist: ['192.168.1.0/24'],
      namespace: 'enterprise',
    };

    const importRes = await request(port, 'POST', '/keys/import', {
      keys: [fullRecord],
    }, { 'X-Admin-Key': adminKey });

    expect(importRes.status).toBe(200);
    expect(importRes.body.imported).toBe(1);

    // Export and verify
    const exportRes = await request(port, 'GET', '/keys/export?namespace=enterprise', undefined, { 'X-Admin-Key': adminKey });
    const imported = exportRes.body.keys.find((k: any) => k.key === key);
    expect(imported).toBeDefined();
    expect(imported.allowedTools).toEqual(['tool_a', 'tool_b']);
    expect(imported.deniedTools).toEqual(['tool_c']);
    expect(imported.spendingLimit).toBe(1000);
    expect(imported.tags).toEqual({ env: 'staging', tier: 'premium' });
    expect(imported.ipAllowlist).toEqual(['192.168.1.0/24']);
    expect(imported.namespace).toBe('enterprise');
    expect(imported.expiresAt).toBe('2030-01-01T00:00:00.000Z');
  });

  test('audit log should record export operations', async () => {
    await request(port, 'GET', '/keys/export', undefined, { 'X-Admin-Key': adminKey });

    const auditRes = await request(port, 'GET', '/audit?types=keys.exported&limit=1', undefined, { 'X-Admin-Key': adminKey });
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.events.length).toBeGreaterThanOrEqual(1);
    expect(auditRes.body.events[0].message).toContain('Exported');
  });

  test('audit log should record import operations', async () => {
    await request(port, 'POST', '/keys/import', {
      keys: [{ key: 'pg_audit_import_' + Date.now(), name: 'audit-test', credits: 10, tags: {} }],
    }, { 'X-Admin-Key': adminKey });

    const auditRes = await request(port, 'GET', '/audit?types=keys.imported&limit=1', undefined, { 'X-Admin-Key': adminKey });
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.events.length).toBeGreaterThanOrEqual(1);
    expect(auditRes.body.events[0].message).toContain('Imported');
  });

  test('root listing should include export and import endpoints', async () => {
    const res = await request(port, 'GET', '/', undefined, {});
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain('/keys/export');
    expect(body).toContain('/keys/import');
  });

  test('should handle mixed valid and invalid keys in import', async () => {
    const res = await request(port, 'POST', '/keys/import', {
      keys: [
        { key: 'pg_valid_' + Date.now(), name: 'good', credits: 100, tags: {} },
        { key: 'bad_prefix', name: 'bad', credits: 50 },
        { key: 'pg_valid2_' + Date.now(), name: 'good2', credits: 200, tags: {} },
      ],
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.imported).toBe(2);
    expect(res.body.errors).toBe(1);
    expect(res.body.results[0].status).toBe('imported');
    expect(res.body.results[1].status).toBe('error');
    expect(res.body.results[2].status).toBe('imported');
  });

  test('imported keys should be masked in results', async () => {
    const key = 'pg_masked_test_' + Date.now();
    const res = await request(port, 'POST', '/keys/import', {
      keys: [{ key, name: 'masked', credits: 100, tags: {} }],
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.results[0].key).toContain('...');
    expect(res.body.results[0].key.length).toBeLessThan(key.length);
  });
});
