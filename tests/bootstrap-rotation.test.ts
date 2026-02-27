/**
 * Bootstrap admin key rotation tests — unit + integration.
 */

import { AdminKeyManager } from '../src/admin-keys';
import { PayGateServer } from '../src/server';
import http from 'http';

// Suppress logger output in tests
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

function post(port: number, path: string, body: any, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
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
}

// ─── Unit: AdminKeyManager.rotateBootstrap ──────────────────────────────────

describe('AdminKeyManager.rotateBootstrap', () => {
  it('should rotate bootstrap key and return new key', () => {
    const mgr = new AdminKeyManager();
    mgr.bootstrap('admin_original_key_1234');

    const result = mgr.rotateBootstrap('admin_original_key_1234');
    expect('newKey' in result).toBe(true);
    if ('newKey' in result) {
      expect(result.newKey).toMatch(/^admin_/);
      expect(result.newKey).not.toBe('admin_original_key_1234');
    }
  });

  it('should revoke old key after rotation', () => {
    const mgr = new AdminKeyManager();
    mgr.bootstrap('admin_old_boot');

    const result = mgr.rotateBootstrap('admin_old_boot');
    expect('newKey' in result).toBe(true);

    // Old key should no longer validate
    expect(mgr.validate('admin_old_boot')).toBeNull();
  });

  it('should make new key valid after rotation', () => {
    const mgr = new AdminKeyManager();
    mgr.bootstrap('admin_boot_check');

    const result = mgr.rotateBootstrap('admin_boot_check');
    expect('newKey' in result).toBe(true);
    if ('newKey' in result) {
      const record = mgr.validate(result.newKey);
      expect(record).not.toBeNull();
      expect(record!.role).toBe('super_admin');
      expect(record!.createdBy).toBe('bootstrap');
    }
  });

  it('should error for unknown key', () => {
    const mgr = new AdminKeyManager();
    mgr.bootstrap('admin_known');

    const result = mgr.rotateBootstrap('admin_unknown');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('not found');
    }
  });

  it('should error for revoked key', () => {
    const mgr = new AdminKeyManager();
    mgr.bootstrap('admin_to_revoke');
    // Create another super_admin so we can revoke bootstrap
    mgr.create('Backup SA', 'super_admin', 'admin_to_revoke');
    mgr.revoke('admin_to_revoke');

    const result = mgr.rotateBootstrap('admin_to_revoke');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('revoked');
    }
  });

  it('should error for non-bootstrap key', () => {
    const mgr = new AdminKeyManager();
    mgr.bootstrap('admin_bootstrap_real');
    const created = mgr.create('Regular SA', 'super_admin', 'admin_bootstrap_real');

    const result = mgr.rotateBootstrap(created.key);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('not the bootstrap');
    }
  });

  it('should allow multiple successive rotations', () => {
    const mgr = new AdminKeyManager();
    mgr.bootstrap('admin_first');

    const r1 = mgr.rotateBootstrap('admin_first');
    expect('newKey' in r1).toBe(true);

    const r2 = mgr.rotateBootstrap((r1 as { newKey: string }).newKey);
    expect('newKey' in r2).toBe(true);

    const r3 = mgr.rotateBootstrap((r2 as { newKey: string }).newKey);
    expect('newKey' in r3).toBe(true);

    // Only latest key should be valid
    expect(mgr.validate('admin_first')).toBeNull();
    expect(mgr.validate((r1 as { newKey: string }).newKey)).toBeNull();
    expect(mgr.validate((r2 as { newKey: string }).newKey)).toBeNull();
    expect(mgr.validate((r3 as { newKey: string }).newKey)).not.toBeNull();
  });
});

// ─── Integration: HTTP Endpoint ─────────────────────────────────────────────

describe('Bootstrap Rotation HTTP Endpoint', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop(1000);
  });

  it('should rotate bootstrap key via HTTP', async () => {
    const resp = await post(port, '/admin/keys/rotate-bootstrap', {}, { 'X-Admin-Key': adminKey });
    expect(resp.status).toBe(200);
    expect(resp.body.rotated).toBe(true);
    expect(resp.body.newKey).toBeDefined();
    expect(resp.body.newKey).toMatch(/^admin_/);
    expect(resp.body.message).toContain('rotated');

    // Update adminKey for subsequent tests
    adminKey = resp.body.newKey;
  });

  it('should accept new key after rotation', async () => {
    // Use the rotated key to hit a protected endpoint
    const resp = await post(port, '/status', {}, { 'X-Admin-Key': adminKey });
    expect(resp.status).toBe(200);
  });

  it('should reject old key after rotation', async () => {
    // The original adminKey was replaced in the first test
    const resp = await post(port, '/status', {}, { 'X-Admin-Key': 'admin_definitely_wrong' });
    expect(resp.status).toBe(401);
  });

  it('should reject non-POST method', async () => {
    const resp = await new Promise<{ status: number; body: any }>((resolve) => {
      http.get(`http://127.0.0.1:${port}/admin/keys/rotate-bootstrap`, {
        headers: { 'X-Admin-Key': adminKey },
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
      }).on('error', () => resolve({ status: 0, body: 'error' }));
    });

    expect(resp.status).toBe(405);
  });

  it('should reject rotation by non-super_admin', async () => {
    // Create a viewer key
    const createResp = await post(port, '/admin/keys', { name: 'viewer', role: 'viewer' }, { 'X-Admin-Key': adminKey });
    expect(createResp.status).toBe(201);

    const viewerKey = createResp.body.key;
    const resp = await post(port, '/admin/keys/rotate-bootstrap', {}, { 'X-Admin-Key': viewerKey });
    expect(resp.status).toBe(403);
  });

  it('should reject rotation by non-bootstrap super_admin', async () => {
    // Create another super_admin
    const createResp = await post(port, '/admin/keys', { name: 'other-sa', role: 'super_admin' }, { 'X-Admin-Key': adminKey });
    expect(createResp.status).toBe(201);

    const otherSaKey = createResp.body.key;
    const resp = await post(port, '/admin/keys/rotate-bootstrap', {}, { 'X-Admin-Key': otherSaKey });
    expect(resp.status).toBe(400);
    expect(resp.body.error).toContain('not the bootstrap');
  });

  it('should allow double rotation via HTTP', async () => {
    // First rotation
    const r1 = await post(port, '/admin/keys/rotate-bootstrap', {}, { 'X-Admin-Key': adminKey });
    expect(r1.status).toBe(200);
    const newKey1 = r1.body.newKey;

    // Second rotation with new key
    const r2 = await post(port, '/admin/keys/rotate-bootstrap', {}, { 'X-Admin-Key': newKey1 });
    expect(r2.status).toBe(200);
    const newKey2 = r2.body.newKey;

    // Old keys rejected, new key works
    expect((await post(port, '/status', {}, { 'X-Admin-Key': adminKey })).status).toBe(401);
    expect((await post(port, '/status', {}, { 'X-Admin-Key': newKey1 })).status).toBe(401);
    expect((await post(port, '/status', {}, { 'X-Admin-Key': newKey2 })).status).toBe(200);

    // Update for any further tests
    adminKey = newKey2;
  });
});
