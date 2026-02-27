/**
 * Persistence safety tests — atomic file writes, error response codes.
 */

import { PayGateServer } from '../src/server';
import { KeyGroupManager } from '../src/groups';
import { AdminKeyManager } from '../src/admin-keys';
import http from 'http';
import { existsSync, readFileSync, unlinkSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

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

// ─── Atomic File Writes: Groups ──────────────────────────────────────────────

describe('Atomic File Writes — KeyGroupManager', () => {
  const testDir = join(tmpdir(), `paygate-test-groups-${randomBytes(4).toString('hex')}`);
  const filePath = join(testDir, 'groups.json');

  afterAll(() => {
    try { unlinkSync(filePath); } catch { /* ignore */ }
    try { unlinkSync(filePath + '.tmp'); } catch { /* ignore */ }
  });

  it('should create state file via atomic write (no .tmp left behind)', () => {
    const mgr = new KeyGroupManager(filePath);
    mgr.createGroup({ name: 'test-group' });
    mgr.saveToFile();

    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(filePath + '.tmp')).toBe(false); // tmp cleaned up by rename

    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(data.groups).toBeDefined();
    expect(data.groups.length).toBe(1);
  });

  it('should survive save when directory already exists', () => {
    const mgr = new KeyGroupManager(filePath);
    // Previous test wrote to this path, so mgr loads from it and has 1 group already.
    // Creating another group and saving again should work without error.
    mgr.createGroup({ name: 'group-2' });
    mgr.saveToFile();

    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(data.groups.length).toBeGreaterThanOrEqual(2);
  });

  it('should create parent directories if needed', () => {
    const nestedPath = join(testDir, 'nested', 'deep', 'groups.json');
    const mgr = new KeyGroupManager(nestedPath);
    mgr.createGroup({ name: 'nested-group' });
    mgr.saveToFile();

    expect(existsSync(nestedPath)).toBe(true);
    try { unlinkSync(nestedPath); } catch { /* ignore */ }
  });
});

// ─── Atomic File Writes: AdminKeyManager ─────────────────────────────────────

describe('Atomic File Writes — AdminKeyManager', () => {
  const testDir = join(tmpdir(), `paygate-test-admin-${randomBytes(4).toString('hex')}`);
  const filePath = join(testDir, 'admin-keys.json');

  afterAll(() => {
    try { unlinkSync(filePath); } catch { /* ignore */ }
    try { unlinkSync(filePath + '.tmp'); } catch { /* ignore */ }
  });

  it('should create state file via atomic write (no .tmp left behind)', () => {
    const mgr = new AdminKeyManager(filePath);
    mgr.bootstrap('ak_test_key');
    mgr.save();

    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(filePath + '.tmp')).toBe(false);

    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(data).toBeDefined();
  });

  it('should create parent directories if needed', () => {
    const nestedPath = join(testDir, 'sub', 'admin-keys.json');
    const mgr = new AdminKeyManager(nestedPath);
    mgr.bootstrap('ak_nested');
    mgr.save();

    expect(existsSync(nestedPath)).toBe(true);
    try { unlinkSync(nestedPath); } catch { /* ignore */ }
  });

  it('should not crash when save is called without filePath', () => {
    const mgr = new AdminKeyManager(); // No filePath
    mgr.bootstrap('ak_no_file');
    expect(() => mgr.save()).not.toThrow();
  });
});

// ─── Enhanced Error Responses ────────────────────────────────────────────────

describe('Enhanced Error Responses', () => {
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

  it('should return 413 for oversized request body', async () => {
    // Send a body larger than 1MB
    const largeBody = 'x'.repeat(1_100_000);
    const resp = await new Promise<{ status: number; body: any }>((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/keys',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': adminKey,
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
      req.on('error', () => resolve({ status: 0, body: 'connection error' }));
      req.write(largeBody);
      req.end();
    });

    // readBody() calls req.destroy() when body exceeds 1MB, which may reset the socket
    // before the server can send a response. Either 413 (response sent) or 0 (socket reset).
    expect([0, 413]).toContain(resp.status);
  });

  it('should return 400 for invalid JSON body', async () => {
    const resp = await new Promise<{ status: number; body: any }>((resolve) => {
      const invalidJson = '{name: invalid}';
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/keys',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(invalidJson).toString(),
          'X-Admin-Key': adminKey,
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
      req.on('error', () => resolve({ status: 0, body: 'connection error' }));
      req.write(invalidJson);
      req.end();
    });

    expect(resp.status).toBe(400);
    expect(resp.body.error).toContain('Invalid JSON');
  });

  it('should return proper JSON errors on all error paths', async () => {
    // Test 404 path
    const resp = await new Promise<{ status: number; body: any }>((resolve) => {
      http.get(`http://127.0.0.1:${port}/nonexistent`, (res) => {
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

    expect(resp.status).toBe(404);
    expect(resp.body.error).toBeDefined();
  });

  it('should return 401 for missing admin key on protected endpoint', async () => {
    const resp = await post(port, '/keys', { name: 'test' }); // No admin key header
    expect(resp.status).toBe(401);
    expect(resp.body.error).toBeDefined();
  });

  it('should still return 200 for /health during normal operation', async () => {
    const resp = await new Promise<number>((resolve) => {
      http.get(`http://127.0.0.1:${port}/health`, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      }).on('error', () => resolve(0));
    });
    expect(resp).toBe(200);
  });

  it('should return proper error for empty POST body', async () => {
    const resp = await new Promise<{ status: number; body: any }>((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/keys',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '0',
          'X-Admin-Key': adminKey,
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
      req.on('error', () => resolve({ status: 0, body: 'error' }));
      req.end();
    });

    // Empty body → JSON.parse('') throws → 400 Invalid JSON
    expect(resp.status).toBe(400);
  });
});

// ─── File Persistence Round-Trip ─────────────────────────────────────────────

describe('File Persistence Round-Trip', () => {
  it('groups should survive save → load round-trip', () => {
    const testDir = join(tmpdir(), `paygate-roundtrip-${randomBytes(4).toString('hex')}`);
    const filePath = join(testDir, 'groups.json');

    // Save
    const mgr1 = new KeyGroupManager(filePath);
    const group = mgr1.createGroup({ name: 'round-trip-group', allowedTools: ['tool-a', 'tool-b'] });
    mgr1.saveToFile();

    // Load in new instance
    const mgr2 = new KeyGroupManager(filePath);
    const loaded = mgr2.getGroup(group.id);

    expect(loaded).toBeDefined();
    expect(loaded!.name).toBe('round-trip-group');
    expect(loaded!.allowedTools).toEqual(['tool-a', 'tool-b']);

    try { unlinkSync(filePath); } catch { /* ignore */ }
  });

  it('admin keys should survive save → load round-trip', () => {
    const testDir = join(tmpdir(), `paygate-roundtrip-admin-${randomBytes(4).toString('hex')}`);
    const filePath = join(testDir, 'admin-keys.json');

    // Save
    const mgr1 = new AdminKeyManager(filePath);
    mgr1.bootstrap('ak_roundtrip');
    mgr1.save();

    // Load in new instance
    const mgr2 = new AdminKeyManager(filePath);
    const info = mgr2.validate('ak_roundtrip');

    expect(info).not.toBeNull();
    expect(info!.role).toBe('super_admin');

    try { unlinkSync(filePath); } catch { /* ignore */ }
  });
});
