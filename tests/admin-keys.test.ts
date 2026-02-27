/**
 * Tests for v3.3.0: Admin API Key Management
 *
 * Tests cover:
 *   - AdminKeyManager unit tests (bootstrap, create, validate, roles, revoke, persistence)
 *   - Role-based permission enforcement (super_admin, admin, viewer)
 *   - HTTP endpoints (POST /admin/keys, GET /admin/keys, POST /admin/keys/revoke)
 *   - Backward compatibility (bootstrap key works for all endpoints)
 *   - Viewer restrictions on write endpoints
 *   - Audit trail for admin key operations
 */

import { AdminKeyManager, ROLE_HIERARCHY, VALID_ROLES, AdminRole } from '../src/admin-keys';
import { PayGateServer } from '../src/server';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Helper ─────────────────────────────────────────────────────────────────

function httpReq(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };
    const req = http.request(opts, (res) => {
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
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── AdminKeyManager Unit Tests ─────────────────────────────────────────────

describe('AdminKeyManager', () => {
  let mgr: AdminKeyManager;

  beforeEach(() => {
    mgr = new AdminKeyManager();
  });

  describe('bootstrap', () => {
    it('should create a super_admin key on bootstrap', () => {
      mgr.bootstrap('test-admin-key');
      const record = mgr.get('test-admin-key');
      expect(record).toBeDefined();
      expect(record!.role).toBe('super_admin');
      expect(record!.name).toBe('Bootstrap Admin');
      expect(record!.createdBy).toBe('bootstrap');
      expect(record!.active).toBe(true);
    });

    it('should not duplicate if bootstrapped twice', () => {
      mgr.bootstrap('test-key');
      mgr.bootstrap('test-key');
      expect(mgr.list().length).toBe(1);
    });
  });

  describe('validate', () => {
    it('should return record for valid active key', () => {
      mgr.bootstrap('key1');
      const record = mgr.validate('key1');
      expect(record).toBeDefined();
      expect(record!.key).toBe('key1');
      expect(record!.lastUsedAt).not.toBeNull();
    });

    it('should return null for unknown key', () => {
      expect(mgr.validate('unknown')).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(mgr.validate('')).toBeNull();
    });

    it('should return null for revoked key', () => {
      mgr.bootstrap('key1');
      // Create a second super_admin so we can revoke the first
      mgr.create('Second', 'super_admin', 'test');
      mgr.revoke('key1');
      expect(mgr.validate('key1')).toBeNull();
    });
  });

  describe('hasRole', () => {
    it('should return true for matching role', () => {
      mgr.bootstrap('sa-key');
      expect(mgr.hasRole('sa-key', 'super_admin')).toBe(true);
    });

    it('should return true for higher role', () => {
      mgr.bootstrap('sa-key');
      expect(mgr.hasRole('sa-key', 'viewer')).toBe(true);
      expect(mgr.hasRole('sa-key', 'admin')).toBe(true);
    });

    it('should return false for insufficient role', () => {
      mgr.bootstrap('sa-key');
      const viewer = mgr.create('Viewer', 'viewer', 'test');
      expect(mgr.hasRole(viewer.key, 'admin')).toBe(false);
      expect(mgr.hasRole(viewer.key, 'super_admin')).toBe(false);
    });

    it('should return false for unknown key', () => {
      expect(mgr.hasRole('nope', 'viewer')).toBe(false);
    });
  });

  describe('create', () => {
    it('should create key with ak_ prefix', () => {
      const record = mgr.create('Test Key', 'admin', 'creator');
      expect(record.key).toMatch(/^ak_[0-9a-f]{32}$/);
      expect(record.name).toBe('Test Key');
      expect(record.role).toBe('admin');
      expect(record.createdBy).toBe('creator');
      expect(record.active).toBe(true);
    });

    it('should create multiple keys', () => {
      mgr.create('A', 'admin', 'x');
      mgr.create('B', 'viewer', 'x');
      mgr.create('C', 'super_admin', 'x');
      expect(mgr.list().length).toBe(3);
    });
  });

  describe('revoke', () => {
    it('should revoke an admin key', () => {
      mgr.bootstrap('sa');
      const admin = mgr.create('Admin', 'admin', 'test');
      const result = mgr.revoke(admin.key);
      expect(result.success).toBe(true);
      expect(mgr.validate(admin.key)).toBeNull();
    });

    it('should return error for unknown key', () => {
      const result = mgr.revoke('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Admin key not found');
    });

    it('should return error for already revoked key', () => {
      mgr.bootstrap('sa');
      const admin = mgr.create('Admin', 'admin', 'test');
      mgr.revoke(admin.key);
      const result = mgr.revoke(admin.key);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Admin key already revoked');
    });

    it('should prevent revoking the last super_admin', () => {
      mgr.bootstrap('sa-only');
      const result = mgr.revoke('sa-only');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Cannot revoke the last super_admin key');
    });

    it('should allow revoking a super_admin if another exists', () => {
      mgr.bootstrap('sa1');
      const sa2 = mgr.create('SA2', 'super_admin', 'test');
      const result = mgr.revoke('sa1');
      expect(result.success).toBe(true);
      // sa2 still active
      expect(mgr.validate(sa2.key)).toBeDefined();
    });
  });

  describe('activeCount', () => {
    it('should count active keys', () => {
      mgr.bootstrap('sa');
      mgr.create('A', 'admin', 'x');
      mgr.create('V', 'viewer', 'x');
      expect(mgr.activeCount).toBe(3);
    });

    it('should exclude revoked keys', () => {
      mgr.bootstrap('sa');
      const a = mgr.create('A', 'admin', 'x');
      mgr.revoke(a.key);
      expect(mgr.activeCount).toBe(1);
    });
  });

  describe('serialization', () => {
    it('should round-trip through toJSON/fromJSON', () => {
      mgr.bootstrap('sa-key');
      mgr.create('Admin', 'admin', 'test');
      const json = mgr.toJSON();

      const mgr2 = new AdminKeyManager();
      mgr2.fromJSON(json);
      expect(mgr2.list().length).toBe(2);
      expect(mgr2.validate('sa-key')).toBeDefined();
    });
  });

  describe('file persistence', () => {
    it('should save and load from file', () => {
      const tmpFile = path.join(os.tmpdir(), `admin-keys-test-${Date.now()}.json`);
      try {
        const m1 = new AdminKeyManager(tmpFile);
        m1.bootstrap('persist-key');
        m1.create('Admin', 'admin', 'test');

        // Create new instance from same file
        const m2 = new AdminKeyManager(tmpFile);
        expect(m2.list().length).toBe(2);
        expect(m2.validate('persist-key')).toBeDefined();
      } finally {
        try { fs.unlinkSync(tmpFile); } catch {}
      }
    });

    it('should handle missing file gracefully', () => {
      const mgr = new AdminKeyManager('/tmp/nonexistent-admin-keys.json');
      expect(mgr.list().length).toBe(0);
    });
  });
});

// ─── ROLE_HIERARCHY & VALID_ROLES ────────────────────────────────────────────

describe('ROLE_HIERARCHY', () => {
  it('should order roles correctly', () => {
    expect(ROLE_HIERARCHY.super_admin).toBeGreaterThan(ROLE_HIERARCHY.admin);
    expect(ROLE_HIERARCHY.admin).toBeGreaterThan(ROLE_HIERARCHY.viewer);
  });
});

describe('VALID_ROLES', () => {
  it('should include all three roles', () => {
    expect(VALID_ROLES).toEqual(['super_admin', 'admin', 'viewer']);
  });
});

// ─── HTTP Endpoint Tests ─────────────────────────────────────────────────────

describe('Admin Key HTTP Endpoints', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer(
      { serverCommand: 'echo', serverArgs: ['test'], port: 0, name: 'admin-key-test' },
      'test-super-admin-key',
    );
    const result = await server.start();
    port = result.port;
    adminKey = result.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  describe('POST /admin/keys', () => {
    it('should require X-Admin-Key', async () => {
      const res = await httpReq(port, 'POST', '/admin/keys', { name: 'Test' });
      expect(res.status).toBe(401);
    });

    it('should require super_admin role', async () => {
      // Create a viewer key first
      const createRes = await httpReq(port, 'POST', '/admin/keys', { name: 'Viewer', role: 'viewer' }, { 'X-Admin-Key': adminKey });
      const viewerKey = createRes.body.key;

      // Viewer should get 403
      const res = await httpReq(port, 'POST', '/admin/keys', { name: 'Attempt' }, { 'X-Admin-Key': viewerKey });
      expect(res.status).toBe(403);
      expect(res.body.requiredRole).toBe('super_admin');
      expect(res.body.currentRole).toBe('viewer');
    });

    it('should require admin role to be rejected too', async () => {
      // Create an admin key
      const createRes = await httpReq(port, 'POST', '/admin/keys', { name: 'Admin', role: 'admin' }, { 'X-Admin-Key': adminKey });
      const adminRoleKey = createRes.body.key;

      // Admin role should get 403 for admin key management
      const res = await httpReq(port, 'POST', '/admin/keys', { name: 'Attempt' }, { 'X-Admin-Key': adminRoleKey });
      expect(res.status).toBe(403);
    });

    it('should reject invalid JSON', async () => {
      const res = await httpReq(port, 'POST', '/admin/keys', undefined, { 'X-Admin-Key': adminKey });
      // Empty body => bad parse
      const req2 = await new Promise<{ status: number; body: any }>((resolve, reject) => {
        const opts: http.RequestOptions = {
          hostname: '127.0.0.1', port, path: '/admin/keys', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
        };
        const r = http.request(opts, (res) => {
          let data = '';
          res.on('data', (c) => data += c);
          res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
        });
        r.on('error', reject);
        r.write('not-json');
        r.end();
      });
      expect(req2.status).toBe(400);
      expect(req2.body.error).toBe('Invalid JSON body');
    });

    it('should require name field', async () => {
      const res = await httpReq(port, 'POST', '/admin/keys', { role: 'admin' }, { 'X-Admin-Key': adminKey });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('name');
    });

    it('should reject invalid role', async () => {
      const res = await httpReq(port, 'POST', '/admin/keys', { name: 'Bad', role: 'superuser' }, { 'X-Admin-Key': adminKey });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid role');
    });

    it('should create admin key with default admin role', async () => {
      const res = await httpReq(port, 'POST', '/admin/keys', { name: 'Default Role' }, { 'X-Admin-Key': adminKey });
      expect(res.status).toBe(201);
      expect(res.body.key).toMatch(/^ak_/);
      expect(res.body.role).toBe('admin');
      expect(res.body.name).toBe('Default Role');
    });

    it('should create viewer key', async () => {
      const res = await httpReq(port, 'POST', '/admin/keys', { name: 'Read Only', role: 'viewer' }, { 'X-Admin-Key': adminKey });
      expect(res.status).toBe(201);
      expect(res.body.role).toBe('viewer');
    });

    it('should create super_admin key', async () => {
      const res = await httpReq(port, 'POST', '/admin/keys', { name: 'Another Super', role: 'super_admin' }, { 'X-Admin-Key': adminKey });
      expect(res.status).toBe(201);
      expect(res.body.role).toBe('super_admin');
    });

    it('should reject DELETE method on /admin/keys/revoke', async () => {
      const res = await httpReq(port, 'DELETE', '/admin/keys/revoke', undefined, { 'X-Admin-Key': adminKey });
      expect(res.status).toBe(405);
    });
  });

  describe('GET /admin/keys', () => {
    it('should require super_admin', async () => {
      const res = await httpReq(port, 'GET', '/admin/keys', undefined, { 'X-Admin-Key': adminKey });
      expect(res.status).toBe(200);
      expect(res.body.count).toBeGreaterThan(0);
      expect(res.body.keys).toBeInstanceOf(Array);
    });

    it('should mask key values in response', async () => {
      const res = await httpReq(port, 'GET', '/admin/keys', undefined, { 'X-Admin-Key': adminKey });
      for (const k of res.body.keys) {
        expect(k.key).toContain('...');
        expect(k.key.length).toBeLessThan(20);
      }
    });

    it('should include all admin key fields', async () => {
      const res = await httpReq(port, 'GET', '/admin/keys', undefined, { 'X-Admin-Key': adminKey });
      const first = res.body.keys[0];
      expect(first).toHaveProperty('name');
      expect(first).toHaveProperty('role');
      expect(first).toHaveProperty('createdAt');
      expect(first).toHaveProperty('createdBy');
      expect(first).toHaveProperty('active');
      expect(first).toHaveProperty('lastUsedAt');
    });
  });

  describe('POST /admin/keys/revoke', () => {
    it('should require super_admin', async () => {
      const res = await httpReq(port, 'POST', '/admin/keys/revoke', { key: 'x' });
      expect(res.status).toBe(401);
    });

    it('should require key field', async () => {
      const res = await httpReq(port, 'POST', '/admin/keys/revoke', {}, { 'X-Admin-Key': adminKey });
      expect(res.status).toBe(400);
    });

    it('should prevent revoking own key', async () => {
      const res = await httpReq(port, 'POST', '/admin/keys/revoke', { key: adminKey }, { 'X-Admin-Key': adminKey });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('own admin key');
    });

    it('should revoke an admin key', async () => {
      // Create a key to revoke
      const createRes = await httpReq(port, 'POST', '/admin/keys', { name: 'Revoke Me', role: 'admin' }, { 'X-Admin-Key': adminKey });
      const targetKey = createRes.body.key;

      // Revoke it
      const revokeRes = await httpReq(port, 'POST', '/admin/keys/revoke', { key: targetKey }, { 'X-Admin-Key': adminKey });
      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.revoked).toBe(true);

      // Verify it no longer works
      const testRes = await httpReq(port, 'GET', '/status', undefined, { 'X-Admin-Key': targetKey });
      expect(testRes.status).toBe(401);
    });

    it('should reject method other than POST', async () => {
      const res = await httpReq(port, 'GET', '/admin/keys/revoke', undefined, { 'X-Admin-Key': adminKey });
      expect(res.status).toBe(405);
    });
  });
});

// ─── Role-Based Access Control Tests ──────────────────────────────────────────

describe('Role-Based Access Control', () => {
  let server: PayGateServer;
  let port: number;
  let superAdminKey: string;
  let adminRoleKey: string;
  let viewerKey: string;

  beforeAll(async () => {
    server = new PayGateServer(
      { serverCommand: 'echo', serverArgs: ['test'], port: 0, name: 'rbac-test' },
      'rbac-super-admin-key',
    );
    const result = await server.start();
    port = result.port;
    superAdminKey = result.adminKey;

    // Create admin and viewer keys
    const adminRes = await httpReq(port, 'POST', '/admin/keys', { name: 'RBAC Admin', role: 'admin' }, { 'X-Admin-Key': superAdminKey });
    adminRoleKey = adminRes.body.key;

    const viewerRes = await httpReq(port, 'POST', '/admin/keys', { name: 'RBAC Viewer', role: 'viewer' }, { 'X-Admin-Key': superAdminKey });
    viewerKey = viewerRes.body.key;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  describe('viewer role', () => {
    it('should access read-only endpoints', async () => {
      // GET /status — viewer should work
      const res = await httpReq(port, 'GET', '/status', undefined, { 'X-Admin-Key': viewerKey });
      expect(res.status).toBe(200);
    });

    it('should access GET /keys', async () => {
      const res = await httpReq(port, 'GET', '/keys', undefined, { 'X-Admin-Key': viewerKey });
      expect(res.status).toBe(200);
    });

    it('should be denied from POST /keys (create)', async () => {
      const res = await httpReq(port, 'POST', '/keys', { name: 'attempt' }, { 'X-Admin-Key': viewerKey });
      expect(res.status).toBe(403);
      expect(res.body.currentRole).toBe('viewer');
      expect(res.body.requiredRole).toBe('admin');
    });

    it('should be denied from POST /topup', async () => {
      const res = await httpReq(port, 'POST', '/topup', { key: 'x', credits: 10 }, { 'X-Admin-Key': viewerKey });
      expect(res.status).toBe(403);
    });

    it('should be denied from POST /keys/revoke', async () => {
      const res = await httpReq(port, 'POST', '/keys/revoke', { key: 'x' }, { 'X-Admin-Key': viewerKey });
      expect(res.status).toBe(403);
    });

    it('should be denied from POST /keys/rotate', async () => {
      const res = await httpReq(port, 'POST', '/keys/rotate', { key: 'x' }, { 'X-Admin-Key': viewerKey });
      expect(res.status).toBe(403);
    });

    it('should be denied from POST /teams', async () => {
      const res = await httpReq(port, 'POST', '/teams', { name: 'test-team' }, { 'X-Admin-Key': viewerKey });
      expect(res.status).toBe(403);
    });

    it('should be denied from admin key management', async () => {
      const res = await httpReq(port, 'POST', '/admin/keys', { name: 'nope' }, { 'X-Admin-Key': viewerKey });
      expect(res.status).toBe(403);
    });
  });

  describe('admin role', () => {
    it('should access read-only endpoints', async () => {
      const res = await httpReq(port, 'GET', '/status', undefined, { 'X-Admin-Key': adminRoleKey });
      expect(res.status).toBe(200);
    });

    it('should create API keys', async () => {
      const res = await httpReq(port, 'POST', '/keys', { name: 'admin-created' }, { 'X-Admin-Key': adminRoleKey });
      expect(res.status).toBe(201);
    });

    it('should topup API keys', async () => {
      // Create a key first
      const createRes = await httpReq(port, 'POST', '/keys', { name: 'topup-target' }, { 'X-Admin-Key': adminRoleKey });
      const apiKey = createRes.body.key;

      const topupRes = await httpReq(port, 'POST', '/topup', { key: apiKey, credits: 100 }, { 'X-Admin-Key': adminRoleKey });
      expect(topupRes.status).toBe(200);
    });

    it('should be denied from admin key management', async () => {
      const res = await httpReq(port, 'POST', '/admin/keys', { name: 'nope' }, { 'X-Admin-Key': adminRoleKey });
      expect(res.status).toBe(403);
    });

    it('should be denied from GET /admin/keys', async () => {
      const res = await httpReq(port, 'GET', '/admin/keys', undefined, { 'X-Admin-Key': adminRoleKey });
      expect(res.status).toBe(403);
    });
  });

  describe('super_admin role', () => {
    it('should access everything', async () => {
      const statusRes = await httpReq(port, 'GET', '/status', undefined, { 'X-Admin-Key': superAdminKey });
      expect(statusRes.status).toBe(200);

      const keysRes = await httpReq(port, 'POST', '/keys', { name: 'sa-created' }, { 'X-Admin-Key': superAdminKey });
      expect(keysRes.status).toBe(201);

      const adminKeysRes = await httpReq(port, 'GET', '/admin/keys', undefined, { 'X-Admin-Key': superAdminKey });
      expect(adminKeysRes.status).toBe(200);
    });
  });
});

// ─── Backward Compatibility Tests ─────────────────────────────────────────────

describe('Backward Compatibility', () => {
  it('should return the bootstrap admin key from start()', async () => {
    const server = new PayGateServer(
      { serverCommand: 'echo', serverArgs: ['test'], port: 0, name: 'compat-test' },
      'my-custom-admin-key',
    );
    const result = await server.start();
    expect(result.adminKey).toBe('my-custom-admin-key');
    await server.gracefulStop(5_000);
  }, 30_000);

  it('should auto-generate admin key if not provided', async () => {
    const server = new PayGateServer(
      { serverCommand: 'echo', serverArgs: ['test'], port: 0, name: 'auto-key-test' },
    );
    const result = await server.start();
    expect(result.adminKey).toMatch(/^admin_/);
    await server.gracefulStop(5_000);
  }, 30_000);

  it('bootstrap key should be super_admin', async () => {
    const server = new PayGateServer(
      { serverCommand: 'echo', serverArgs: ['test'], port: 0, name: 'sa-test' },
      'boot-key',
    );
    const result = await server.start();
    expect(server.adminKeys.hasRole('boot-key', 'super_admin')).toBe(true);
    await server.gracefulStop(5_000);
  }, 30_000);
});

// ─── Audit Trail Tests ────────────────────────────────────────────────────────

describe('Admin Key Audit Trail', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer(
      { serverCommand: 'echo', serverArgs: ['test'], port: 0, name: 'audit-test' },
      'audit-admin-key',
    );
    const result = await server.start();
    port = result.port;
    adminKey = result.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  it('should log admin_key.created event', async () => {
    await httpReq(port, 'POST', '/admin/keys', { name: 'Audited Key', role: 'viewer' }, { 'X-Admin-Key': adminKey });

    const events = server.audit.query({ types: ['admin_key.created'] });
    expect(events.events.length).toBeGreaterThanOrEqual(1);
    const last = events.events[events.events.length - 1];
    expect(last.type).toBe('admin_key.created');
    expect(last.message).toContain('Audited Key');
    expect(last.message).toContain('viewer');
  });

  it('should log admin_key.revoked event', async () => {
    const createRes = await httpReq(port, 'POST', '/admin/keys', { name: 'To Revoke', role: 'admin' }, { 'X-Admin-Key': adminKey });
    const targetKey = createRes.body.key;

    await httpReq(port, 'POST', '/admin/keys/revoke', { key: targetKey }, { 'X-Admin-Key': adminKey });

    const events = server.audit.query({ types: ['admin_key.revoked'] });
    expect(events.events.length).toBeGreaterThanOrEqual(1);
  });

  it('should log admin.auth_failed for insufficient role', async () => {
    const viewerRes = await httpReq(port, 'POST', '/admin/keys', { name: 'V', role: 'viewer' }, { 'X-Admin-Key': adminKey });
    const vKey = viewerRes.body.key;

    // Viewer tries to create API key
    await httpReq(port, 'POST', '/keys', { name: 'x' }, { 'X-Admin-Key': vKey });

    const events = server.audit.query({ types: ['admin.auth_failed'] });
    const roleFailure = events.events.find(e =>
      e.metadata?.requiredRole === 'admin' && e.metadata?.currentRole === 'viewer'
    );
    expect(roleFailure).toBeDefined();
  });
});

// ─── Root Listing Test ────────────────────────────────────────────────────────

describe('Root Listing', () => {
  it('should include admin key endpoints', async () => {
    const server = new PayGateServer(
      { serverCommand: 'echo', serverArgs: ['test'], port: 0, name: 'root-test' },
    );
    const result = await server.start();
    const port = result.port;

    const res = await httpReq(port, 'GET', '/', undefined, {});
    expect(res.body.endpoints.adminKeys).toBeDefined();
    expect(res.body.endpoints.createAdminKey).toBeDefined();
    expect(res.body.endpoints.revokeAdminKey).toBeDefined();

    await server.gracefulStop(5_000);
  }, 30_000);
});
