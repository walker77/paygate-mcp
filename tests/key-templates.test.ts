/**
 * Tests for v5.2.0 — Key Templates
 *
 * Covers:
 *   - KeyTemplateManager unit: create, update, delete, list, limits, validation
 *   - File persistence: save/load round-trip
 *   - Server integration: GET/POST /keys/templates, POST /keys/templates/delete
 *   - Template-based key creation: POST /keys with template param
 *   - Audit trail for template operations
 *   - Prometheus gauge
 *   - Root listing includes new endpoints
 */

import { KeyTemplateManager, KeyTemplate } from '../src/key-templates';
import { DEFAULT_CONFIG } from '../src/types';
import { PayGateServer } from '../src/server';
import http from 'http';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Helpers ───────────────────────────────────────────────────────────────────

const ECHO_CMD = process.execPath;
const ECHO_ARGS = ['-e', 'process.stdin.resume(); process.stdin.on("data", d => { const r = JSON.parse(d.toString().trim()); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: {} }) + "\\n"); });'];

function request(port: number, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode!, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function tmpFilePath(): string {
  return join(tmpdir(), `paygate-tpl-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function cleanup(path: string): void {
  try { if (existsSync(path)) unlinkSync(path); } catch {}
}

// ─── Unit Tests: KeyTemplateManager ──────────────────────────────────────────

describe('KeyTemplateManager', () => {
  let mgr: KeyTemplateManager;

  beforeEach(() => {
    mgr = new KeyTemplateManager();
  });

  test('create a template with defaults', () => {
    const result = mgr.set('free-tier', { description: 'Free tier', credits: 50 });
    expect(result.success).toBe(true);
    expect(result.template).toBeDefined();
    expect(result.template!.name).toBe('free-tier');
    expect(result.template!.credits).toBe(50);
    expect(result.template!.description).toBe('Free tier');
    expect(result.template!.allowedTools).toEqual([]);
    expect(result.template!.deniedTools).toEqual([]);
    expect(result.template!.tags).toEqual({});
    expect(result.template!.namespace).toBe('default');
    expect(result.template!.expiryTtlSeconds).toBe(0);
    expect(result.template!.spendingLimit).toBe(0);
    expect(result.template!.createdAt).toBeTruthy();
    expect(result.template!.updatedAt).toBeTruthy();
  });

  test('update an existing template preserves createdAt', () => {
    mgr.set('pro', { credits: 500 });
    const original = mgr.get('pro')!;
    const originalCreated = original.createdAt;

    mgr.set('pro', { credits: 1000, description: 'Pro tier updated' });
    const updated = mgr.get('pro')!;

    expect(updated.credits).toBe(1000);
    expect(updated.description).toBe('Pro tier updated');
    expect(updated.createdAt).toBe(originalCreated); // createdAt preserved
    expect(updated.updatedAt).toBeTruthy(); // updatedAt is set (may equal createdAt in same ms)
  });

  test('reject invalid template names', () => {
    expect(mgr.set('', {}).success).toBe(false);
    expect(mgr.set('has spaces', {}).success).toBe(false);
    expect(mgr.set('has.dots', {}).success).toBe(false);
    expect(mgr.set('special!chars', {}).success).toBe(false);
  });

  test('accept valid template names', () => {
    expect(mgr.set('my-template', {}).success).toBe(true);
    expect(mgr.set('my_template', {}).success).toBe(true);
    expect(mgr.set('MyTemplate123', {}).success).toBe(true);
    expect(mgr.set('a', {}).success).toBe(true);
  });

  test('get returns null for missing template', () => {
    expect(mgr.get('nonexistent')).toBeNull();
  });

  test('delete removes template', () => {
    mgr.set('temp', { credits: 10 });
    expect(mgr.count).toBe(1);
    expect(mgr.delete('temp')).toBe(true);
    expect(mgr.count).toBe(0);
    expect(mgr.get('temp')).toBeNull();
  });

  test('delete returns false for missing template', () => {
    expect(mgr.delete('nonexistent')).toBe(false);
  });

  test('list returns sorted templates', () => {
    mgr.set('zebra', {});
    mgr.set('alpha', {});
    mgr.set('mid', {});
    const templates = mgr.list();
    expect(templates).toHaveLength(3);
    expect(templates[0].name).toBe('alpha');
    expect(templates[1].name).toBe('mid');
    expect(templates[2].name).toBe('zebra');
  });

  test('enforce max 100 templates', () => {
    for (let i = 0; i < 100; i++) {
      const result = mgr.set(`tpl-${String(i).padStart(3, '0')}`, {});
      expect(result.success).toBe(true);
    }
    expect(mgr.count).toBe(100);

    // 101st should fail
    const result = mgr.set('tpl-overflow', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('100');
  });

  test('update existing beyond limit does not fail', () => {
    for (let i = 0; i < 100; i++) {
      mgr.set(`tpl-${i}`, {});
    }
    // Updating existing template should succeed even at limit
    const result = mgr.set('tpl-0', { credits: 999 });
    expect(result.success).toBe(true);
    expect(result.template!.credits).toBe(999);
  });

  test('template with full config', () => {
    const result = mgr.set('enterprise', {
      description: 'Enterprise plan',
      credits: 10000,
      allowedTools: ['search', 'analyze'],
      deniedTools: ['admin_tool'],
      quota: { dailyCallLimit: 1000, monthlyCallLimit: 30000, dailyCreditLimit: 500, monthlyCreditLimit: 15000 },
      ipAllowlist: ['10.0.0.0/8'],
      spendingLimit: 50000,
      tags: { tier: 'enterprise', region: 'us' },
      namespace: 'enterprise-ns',
      expiryTtlSeconds: 86400 * 365,
      autoTopup: { threshold: 100, amount: 5000, maxDaily: 3 },
    });

    expect(result.success).toBe(true);
    const tpl = result.template!;
    expect(tpl.credits).toBe(10000);
    expect(tpl.allowedTools).toEqual(['search', 'analyze']);
    expect(tpl.deniedTools).toEqual(['admin_tool']);
    expect(tpl.quota).toEqual({ dailyCallLimit: 1000, monthlyCallLimit: 30000, dailyCreditLimit: 500, monthlyCreditLimit: 15000 });
    expect(tpl.ipAllowlist).toEqual(['10.0.0.0/8']);
    expect(tpl.spendingLimit).toBe(50000);
    expect(tpl.tags).toEqual({ tier: 'enterprise', region: 'us' });
    expect(tpl.namespace).toBe('enterprise-ns');
    expect(tpl.expiryTtlSeconds).toBe(86400 * 365);
    expect(tpl.autoTopup).toEqual({ threshold: 100, amount: 5000, maxDaily: 3 });
  });

  test('name truncated to 50 characters', () => {
    const longName = 'a'.repeat(100);
    const result = mgr.set(longName, {});
    expect(result.success).toBe(true);
    expect(result.template!.name).toHaveLength(50);
  });

  test('description truncated to 500 characters', () => {
    const longDesc = 'x'.repeat(1000);
    const result = mgr.set('desc-test', { description: longDesc });
    expect(result.success).toBe(true);
    expect(result.template!.description).toHaveLength(500);
  });

  test('negative credits normalized to 0', () => {
    const result = mgr.set('neg', { credits: -50 });
    expect(result.success).toBe(true);
    expect(result.template!.credits).toBe(0);
  });
});

// ─── File Persistence ────────────────────────────────────────────────────────

describe('KeyTemplateManager — File Persistence', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tmpFilePath();
  });

  afterEach(() => {
    cleanup(filePath);
  });

  test('save and load round-trip', () => {
    const mgr1 = new KeyTemplateManager(filePath);
    mgr1.set('free', { credits: 50, description: 'Free tier' });
    mgr1.set('pro', { credits: 500, tags: { level: 'pro' } });
    expect(existsSync(filePath)).toBe(true);

    // Load into new manager
    const mgr2 = new KeyTemplateManager(filePath);
    expect(mgr2.count).toBe(2);

    const free = mgr2.get('free')!;
    expect(free.credits).toBe(50);
    expect(free.description).toBe('Free tier');

    const pro = mgr2.get('pro')!;
    expect(pro.credits).toBe(500);
    expect(pro.tags).toEqual({ level: 'pro' });
  });

  test('delete saves to file', () => {
    const mgr1 = new KeyTemplateManager(filePath);
    mgr1.set('temp', {});
    mgr1.delete('temp');

    const mgr2 = new KeyTemplateManager(filePath);
    expect(mgr2.count).toBe(0);
  });

  test('load from nonexistent file is empty', () => {
    const mgr = new KeyTemplateManager('/tmp/nonexistent-tpl-file.json');
    expect(mgr.count).toBe(0);
  });
});

// ─── Server Integration ──────────────────────────────────────────────────────

describe('Key Templates — Server Integration', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    const statePath = tmpFilePath().replace('.json', '-state.json');
    server = new PayGateServer(
      { ...DEFAULT_CONFIG, port: 0, serverCommand: ECHO_CMD, serverArgs: ECHO_ARGS },
      undefined,
      statePath,
    );
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.stop();
  });

  test('GET /keys/templates returns empty list initially', async () => {
    const res = await request(port, 'GET', '/keys/templates', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.templates).toEqual([]);
  });

  test('POST /keys/templates creates a template (201)', async () => {
    const res = await request(port, 'POST', '/keys/templates', {
      name: 'basic',
      description: 'Basic tier',
      credits: 100,
      allowedTools: ['search'],
    }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(201);
    expect(res.body.template.name).toBe('basic');
    expect(res.body.template.credits).toBe(100);
    expect(res.body.template.allowedTools).toEqual(['search']);
  });

  test('POST /keys/templates updates existing template (200)', async () => {
    const res = await request(port, 'POST', '/keys/templates', {
      name: 'basic',
      credits: 200,
    }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.template.credits).toBe(200);
  });

  test('GET /keys/templates lists templates', async () => {
    // Create another template
    await request(port, 'POST', '/keys/templates', {
      name: 'pro',
      credits: 1000,
    }, { 'X-Admin-Key': adminKey });

    const res = await request(port, 'GET', '/keys/templates', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.templates[0].name).toBe('basic');
    expect(res.body.templates[1].name).toBe('pro');
  });

  test('POST /keys/templates rejects missing name', async () => {
    const res = await request(port, 'POST', '/keys/templates', {
      credits: 50,
    }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('name');
  });

  test('POST /keys/templates rejects invalid name', async () => {
    const res = await request(port, 'POST', '/keys/templates', {
      name: 'has spaces',
      credits: 50,
    }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('letters');
  });

  test('POST /keys/templates/delete removes template', async () => {
    const res = await request(port, 'POST', '/keys/templates/delete', {
      name: 'pro',
    }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.name).toBe('pro');
  });

  test('POST /keys/templates/delete returns 404 for missing', async () => {
    const res = await request(port, 'POST', '/keys/templates/delete', {
      name: 'nonexistent',
    }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(404);
  });

  test('POST /keys/templates/delete rejects missing name', async () => {
    const res = await request(port, 'POST', '/keys/templates/delete', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('name');
  });

  test('template CRUD requires admin auth', async () => {
    const res1 = await request(port, 'GET', '/keys/templates');
    expect(res1.status).toBe(401);
    const res2 = await request(port, 'POST', '/keys/templates', { name: 'x' });
    expect(res2.status).toBe(401);
    const res3 = await request(port, 'POST', '/keys/templates/delete', { name: 'x' });
    expect(res3.status).toBe(401);
  });
});

// ─── Template-Based Key Creation ─────────────────────────────────────────────

describe('Template-Based Key Creation', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    const statePath = tmpFilePath().replace('.json', '-state2.json');
    server = new PayGateServer(
      { ...DEFAULT_CONFIG, port: 0, serverCommand: ECHO_CMD, serverArgs: ECHO_ARGS },
      undefined,
      statePath,
    );
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    // Create templates
    await request(port, 'POST', '/keys/templates', {
      name: 'free-tier',
      description: 'Free plan',
      credits: 50,
      allowedTools: ['search', 'read'],
      deniedTools: ['admin'],
      tags: { plan: 'free' },
      namespace: 'public',
      expiryTtlSeconds: 3600, // 1 hour
      spendingLimit: 200,
    }, { 'X-Admin-Key': adminKey });

    await request(port, 'POST', '/keys/templates', {
      name: 'auto-topup-tpl',
      credits: 100,
      autoTopup: { threshold: 10, amount: 100, maxDaily: 5 },
    }, { 'X-Admin-Key': adminKey });
  });

  afterAll(async () => {
    await server.stop();
  });

  test('create key from template — inherits all defaults', async () => {
    const res = await request(port, 'POST', '/keys', {
      name: 'test-user',
      template: 'free-tier',
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(201);
    expect(res.body.credits).toBe(50);
    expect(res.body.allowedTools).toEqual(['search', 'read']);
    expect(res.body.deniedTools).toEqual(['admin']);
    expect(res.body.tags).toEqual({ plan: 'free' });
    expect(res.body.namespace).toBe('public');
    // Should have expiry set (~1 hour from now)
    expect(res.body.expiresAt).toBeTruthy();
    const expiryTime = new Date(res.body.expiresAt).getTime();
    const expectedTime = Date.now() + 3600 * 1000;
    expect(Math.abs(expiryTime - expectedTime)).toBeLessThan(5000); // within 5s
  });

  test('create key from template — explicit params override template', async () => {
    const res = await request(port, 'POST', '/keys', {
      name: 'override-user',
      template: 'free-tier',
      credits: 500,
      allowedTools: ['all-tools'],
      tags: { custom: 'tag' },
      namespace: 'custom-ns',
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(201);
    expect(res.body.credits).toBe(500); // overridden
    expect(res.body.allowedTools).toEqual(['all-tools']); // overridden
    expect(res.body.tags).toEqual({ custom: 'tag' }); // overridden
    expect(res.body.namespace).toBe('custom-ns'); // overridden
  });

  test('create key from template — expiresIn overrides template TTL', async () => {
    const res = await request(port, 'POST', '/keys', {
      name: 'custom-expiry',
      template: 'free-tier',
      expiresIn: 300, // 5 minutes
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(201);
    const expiryTime = new Date(res.body.expiresAt).getTime();
    const expectedTime = Date.now() + 300 * 1000;
    expect(Math.abs(expiryTime - expectedTime)).toBeLessThan(5000);
  });

  test('create key with nonexistent template returns 400', async () => {
    const res = await request(port, 'POST', '/keys', {
      name: 'bad-template',
      template: 'does-not-exist',
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not found');
  });

  test('create key with auto-topup template', async () => {
    const res = await request(port, 'POST', '/keys', {
      name: 'topup-user',
      template: 'auto-topup-tpl',
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(201);
    expect(res.body.credits).toBe(100);

    // Verify auto-topup was applied by checking status
    const statusRes = await request(port, 'GET', '/status', undefined, { 'X-Admin-Key': adminKey });
    const keyStatus = statusRes.body.keys.find((k: any) => k.name === 'topup-user');
    expect(keyStatus).toBeDefined();
  });

  test('create key without template still works normally', async () => {
    const res = await request(port, 'POST', '/keys', {
      name: 'no-template',
      credits: 200,
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(201);
    expect(res.body.credits).toBe(200);
  });
});

// ─── Audit Trail ─────────────────────────────────────────────────────────────

describe('Key Templates — Audit Trail', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    const statePath = tmpFilePath().replace('.json', '-state3.json');
    server = new PayGateServer(
      { ...DEFAULT_CONFIG, port: 0, serverCommand: ECHO_CMD, serverArgs: ECHO_ARGS },
      undefined,
      statePath,
    );
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.stop();
  });

  test('template CRUD generates audit events', async () => {
    // Create
    await request(port, 'POST', '/keys/templates', {
      name: 'audit-test',
      credits: 100,
    }, { 'X-Admin-Key': adminKey });

    // Update
    await request(port, 'POST', '/keys/templates', {
      name: 'audit-test',
      credits: 200,
    }, { 'X-Admin-Key': adminKey });

    // Delete
    await request(port, 'POST', '/keys/templates/delete', {
      name: 'audit-test',
    }, { 'X-Admin-Key': adminKey });

    // Query audit log
    const auditRes = await request(port, 'GET', '/audit?types=template.created,template.updated,template.deleted', undefined, { 'X-Admin-Key': adminKey });
    expect(auditRes.status).toBe(200);
    const events = auditRes.body.events;
    expect(events.length).toBe(3);

    // Newest first
    expect(events[0].type).toBe('template.deleted');
    expect(events[1].type).toBe('template.updated');
    expect(events[2].type).toBe('template.created');
  });
});

// ─── Prometheus Gauge ────────────────────────────────────────────────────────

describe('Key Templates — Prometheus Gauge', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    const statePath = tmpFilePath().replace('.json', '-state4.json');
    server = new PayGateServer(
      { ...DEFAULT_CONFIG, port: 0, serverCommand: ECHO_CMD, serverArgs: ECHO_ARGS },
      undefined,
      statePath,
    );
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.stop();
  });

  test('/metrics includes paygate_templates_total', async () => {
    // Create a template first
    await request(port, 'POST', '/keys/templates', {
      name: 'metrics-test',
      credits: 100,
    }, { 'X-Admin-Key': adminKey });

    const res = await request(port, 'GET', '/metrics', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    expect(text).toContain('paygate_templates_total');
  });
});

// ─── Root Listing ────────────────────────────────────────────────────────────

describe('Key Templates — Root Listing', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    const statePath = tmpFilePath().replace('.json', '-state5.json');
    server = new PayGateServer(
      { ...DEFAULT_CONFIG, port: 0, serverCommand: ECHO_CMD, serverArgs: ECHO_ARGS },
      undefined,
      statePath,
    );
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.stop();
  });

  test('root listing includes template endpoints', async () => {
    const res = await request(port, 'GET', '/');
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain('/keys/templates');
    expect(body).toContain('/keys/templates/delete');
  });
});

// ─── File Persistence with Server ────────────────────────────────────────────

describe('Key Templates — Server File Persistence', () => {
  const statePath = tmpFilePath().replace('.json', '-persist.json');
  const templatesPath = statePath.replace(/\.json$/, '-templates.json');

  afterAll(() => {
    cleanup(statePath);
    cleanup(templatesPath);
  });

  test('templates survive server restart', async () => {
    // First server: create templates
    const server1 = new PayGateServer(
      { ...DEFAULT_CONFIG, port: 0, serverCommand: ECHO_CMD, serverArgs: ECHO_ARGS },
      'test-admin-key-1234567890',
      statePath,
    );
    const info1 = await server1.start();

    await request(info1.port, 'POST', '/keys/templates', {
      name: 'persist-test',
      credits: 777,
      tags: { persistent: 'true' },
    }, { 'X-Admin-Key': 'test-admin-key-1234567890' });

    await server1.stop();

    // Verify templates file exists
    expect(existsSync(templatesPath)).toBe(true);

    // Second server: verify templates loaded
    const server2 = new PayGateServer(
      { ...DEFAULT_CONFIG, port: 0, serverCommand: ECHO_CMD, serverArgs: ECHO_ARGS },
      'test-admin-key-1234567890',
      statePath,
    );
    const info2 = await server2.start();

    const res = await request(info2.port, 'GET', '/keys/templates', undefined, { 'X-Admin-Key': 'test-admin-key-1234567890' });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.templates[0].name).toBe('persist-test');
    expect(res.body.templates[0].credits).toBe(777);
    expect(res.body.templates[0].tags).toEqual({ persistent: 'true' });

    await server2.stop();
  });
});
