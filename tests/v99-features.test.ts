/**
 * v9.9.0 Feature Tests — IP Access Control, Request Signing, Tenant Isolation
 */

import { IpAccessController } from '../src/ip-access';
import { RequestSigner } from '../src/request-signing';
import { TenantManager } from '../src/tenant-isolation';
import * as http from 'http';
import * as crypto from 'crypto';

// ─── Helper ──────────────────────────────────────────────────────────────────

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const hdrs: Record<string, string> = { 'Content-Type': 'application/json', ...headers };
    if (data) hdrs['Content-Length'] = String(Buffer.byteLength(data));
    const req = http.request(
      { hostname: '127.0.0.1', port, method, path, headers: hdrs },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(chunks) }); }
          catch { resolve({ status: res.statusCode!, body: chunks }); }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// IP Access Controller — Unit Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('IpAccessController', () => {
  let ctrl: IpAccessController;

  beforeEach(() => {
    ctrl = new IpAccessController({ enabled: true });
  });

  test('allows all when disabled', () => {
    const c = new IpAccessController({ enabled: false });
    const result = c.check('1.2.3.4');
    expect(result.allowed).toBe(true);
  });

  test('allows when no rules configured', () => {
    const result = ctrl.check('1.2.3.4');
    expect(result.allowed).toBe(true);
  });

  test('denies IPs in deny list', () => {
    ctrl.configure({ denyList: ['10.0.0.1', '192.168.1.0/24'] });
    expect(ctrl.check('10.0.0.1').allowed).toBe(false);
    expect(ctrl.check('192.168.1.55').allowed).toBe(false);
    expect(ctrl.check('8.8.8.8').allowed).toBe(true);
  });

  test('allow list acts as whitelist', () => {
    ctrl.configure({ allowList: ['10.0.0.0/8'] });
    expect(ctrl.check('10.1.2.3').allowed).toBe(true);
    expect(ctrl.check('192.168.1.1').allowed).toBe(false);
  });

  test('deny list takes precedence over allow list', () => {
    ctrl.configure({ allowList: ['10.0.0.0/8'], denyList: ['10.0.0.1'] });
    expect(ctrl.check('10.0.0.1').allowed).toBe(false);
    expect(ctrl.check('10.0.0.2').allowed).toBe(true);
  });

  test('CIDR matching /16', () => {
    ctrl.configure({ denyList: ['172.16.0.0/16'] });
    expect(ctrl.check('172.16.0.1').allowed).toBe(false);
    expect(ctrl.check('172.16.255.255').allowed).toBe(false);
    expect(ctrl.check('172.17.0.1').allowed).toBe(true);
  });

  test('per-key IP binding', () => {
    ctrl.bindKey('key-123', ['10.0.0.1', '10.0.0.2']);
    expect(ctrl.check('10.0.0.1', 'key-123').allowed).toBe(true);
    expect(ctrl.check('10.0.0.3', 'key-123').allowed).toBe(false);
    expect(ctrl.check('10.0.0.3').allowed).toBe(true); // no key → no binding check
  });

  test('unbind key', () => {
    ctrl.bindKey('key-123', ['10.0.0.1']);
    expect(ctrl.check('10.0.0.3', 'key-123').allowed).toBe(false);
    ctrl.unbindKey('key-123');
    expect(ctrl.check('10.0.0.3', 'key-123').allowed).toBe(true);
  });

  test('manual block and unblock', () => {
    ctrl.blockIp('1.2.3.4', 60000, 'test');
    expect(ctrl.check('1.2.3.4').allowed).toBe(false);
    ctrl.unblockIp('1.2.3.4');
    expect(ctrl.check('1.2.3.4').allowed).toBe(true);
  });

  test('auto-block after threshold', () => {
    ctrl.configure({ autoBlockThreshold: 3, autoBlockWindowMs: 60000, denyList: ['bad-range'] });
    // We need actual denied requests to trigger auto-block
    ctrl.configure({ denyList: ['10.0.0.0/8'] });
    ctrl.check('10.0.0.1'); // denied 1
    ctrl.check('10.0.0.1'); // denied 2
    ctrl.check('10.0.0.1'); // denied 3 → auto-block triggered
    // Now check from the IP — should be auto-blocked
    const result = ctrl.check('10.0.0.1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('auto-blocked');
  });

  test('resolves client IP from X-Forwarded-For', () => {
    const ip = ctrl.resolveClientIp('127.0.0.1', { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' });
    expect(ip).toBe('5.6.7.8');  // trustedProxyDepth=1, takes last
  });

  test('resolves client IP from X-Real-IP', () => {
    const ip = ctrl.resolveClientIp('127.0.0.1', { 'x-real-ip': '9.8.7.6' });
    expect(ip).toBe('9.8.7.6');
  });

  test('normalizes IPv6-mapped IPv4', () => {
    ctrl.configure({ denyList: ['10.0.0.1'] });
    expect(ctrl.check('::ffff:10.0.0.1').allowed).toBe(false);
  });

  test('stats reports correctly', () => {
    ctrl.configure({ denyList: ['10.0.0.1'] });
    ctrl.bindKey('k1', ['1.0.0.1']);
    ctrl.check('10.0.0.1'); // denied
    ctrl.check('8.8.8.8'); // allowed
    const stats = ctrl.stats();
    expect(stats.enabled).toBe(true);
    expect(stats.globalDenyCount).toBe(1);
    expect(stats.perKeyBindings).toBe(1);
    expect(stats.totalBlocked).toBe(1);
    expect(stats.totalAllowed).toBe(1);
    expect(stats.totalChecks).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Request Signer — Unit Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('RequestSigner', () => {
  let signer: RequestSigner;

  beforeEach(() => {
    signer = new RequestSigner({ enabled: true });
  });

  test('allows all when disabled', () => {
    const s = new RequestSigner({ enabled: false });
    const result = s.verify('key-1', 'POST', '/mcp', '{}', '');
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('signing-disabled');
  });

  test('allows when no secret registered for key', () => {
    const result = signer.verify('unregistered-key', 'POST', '/mcp', '{}', '');
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('no-secret-registered');
  });

  test('registers key and generates secret', () => {
    const secret = signer.registerKey('key-1', undefined, 'test');
    expect(secret.apiKey).toBe('key-1');
    expect(secret.secret).toBeTruthy();
    expect(secret.secret.length).toBe(64); // 32 bytes hex
    expect(secret.label).toBe('test');
  });

  test('sign and verify round-trip', () => {
    signer.registerKey('key-1');
    const sig = signer.sign('key-1', 'POST', '/mcp', '{"tool":"test"}');
    expect(sig).toBeTruthy();
    const result = signer.verify('key-1', 'POST', '/mcp', '{"tool":"test"}', sig!);
    expect(result.valid).toBe(true);
  });

  test('rejects invalid signature format', () => {
    signer.registerKey('key-1');
    const result = signer.verify('key-1', 'POST', '/mcp', '{}', 'garbage');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid-signature-format');
  });

  test('rejects expired timestamp', () => {
    signer.registerKey('key-1');
    const oldTimestamp = Date.now() - 600_000; // 10 min ago
    const sig = signer.sign('key-1', 'POST', '/mcp', '{}', oldTimestamp);
    const result = signer.verify('key-1', 'POST', '/mcp', '{}', sig!);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('timestamp-expired');
  });

  test('rejects replayed nonce', () => {
    signer.registerKey('key-1');
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = signer.sign('key-1', 'POST', '/mcp', '{}', Date.now(), nonce);
    // First verify — succeeds
    expect(signer.verify('key-1', 'POST', '/mcp', '{}', sig!).valid).toBe(true);
    // Second verify with same nonce — fails
    expect(signer.verify('key-1', 'POST', '/mcp', '{}', sig!).valid).toBe(false);
    expect(signer.verify('key-1', 'POST', '/mcp', '{}', sig!).reason).toBe('nonce-replayed');
  });

  test('rejects tampered body', () => {
    signer.registerKey('key-1');
    const sig = signer.sign('key-1', 'POST', '/mcp', '{"tool":"test"}');
    const result = signer.verify('key-1', 'POST', '/mcp', '{"tool":"TAMPERED"}', sig!);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature-mismatch');
  });

  test('rejects tampered method', () => {
    signer.registerKey('key-1');
    const sig = signer.sign('key-1', 'POST', '/mcp', '{}');
    const result = signer.verify('key-1', 'GET', '/mcp', '{}', sig!);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature-mismatch');
  });

  test('rotate key generates new secret', () => {
    const original = signer.registerKey('key-1');
    const rotated = signer.rotateKey('key-1');
    expect(rotated).toBeTruthy();
    expect(rotated!.secret).not.toBe(original.secret);
    // Old signatures should fail
    const oldSig = crypto.createHmac('sha256', original.secret).update('test').digest('hex');
    expect(oldSig).not.toBe(crypto.createHmac('sha256', rotated!.secret).update('test').digest('hex'));
  });

  test('remove key stops requiring signatures', () => {
    signer.registerKey('key-1');
    signer.removeKey('key-1');
    const result = signer.verify('key-1', 'POST', '/mcp', '{}', '');
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('no-secret-registered');
  });

  test('stats reports correctly', () => {
    signer.registerKey('key-1');
    const sig = signer.sign('key-1', 'POST', '/mcp', '{}');
    signer.verify('key-1', 'POST', '/mcp', '{}', sig!);
    signer.verify('key-1', 'POST', '/mcp', '{}', 'bad');
    const stats = signer.stats();
    expect(stats.enabled).toBe(true);
    expect(stats.registeredKeys).toBe(1);
    expect(stats.totalVerified).toBe(1);
    expect(stats.totalFailed).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Tenant Manager — Unit Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('TenantManager', () => {
  let tm: TenantManager;

  beforeEach(() => {
    tm = new TenantManager({ enabled: true });
  });

  test('throws when disabled', () => {
    const disabled = new TenantManager({ enabled: false });
    expect(() => disabled.create({ name: 'test' })).toThrow('not enabled');
  });

  test('creates tenant with auto-generated ID', () => {
    const t = tm.create({ name: 'Acme Corp' });
    expect(t.id).toMatch(/^tnt_/);
    expect(t.name).toBe('Acme Corp');
    expect(t.status).toBe('active');
    expect(t.credits).toBe(0);
  });

  test('creates tenant with custom ID', () => {
    const t = tm.create({ id: 'custom-id', name: 'Custom' });
    expect(t.id).toBe('custom-id');
  });

  test('rejects duplicate tenant ID', () => {
    tm.create({ id: 'dup', name: 'First' });
    expect(() => tm.create({ id: 'dup', name: 'Second' })).toThrow('already exists');
  });

  test('lists tenants with status filter', () => {
    tm.create({ id: 't1', name: 'Active 1' });
    tm.create({ id: 't2', name: 'Active 2' });
    tm.create({ id: 't3', name: 'Suspended' });
    tm.suspend('t3');
    expect(tm.list('active').length).toBe(2);
    expect(tm.list('suspended').length).toBe(1);
    expect(tm.list().length).toBe(3);
  });

  test('suspends and activates tenant', () => {
    tm.create({ id: 't1', name: 'Test' });
    expect(tm.suspend('t1')).toBe(true);
    expect(tm.get('t1')!.status).toBe('suspended');
    expect(tm.activate('t1')).toBe(true);
    expect(tm.get('t1')!.status).toBe('active');
  });

  test('binds key to tenant', () => {
    tm.create({ id: 't1', name: 'Test' });
    expect(tm.bindKey('t1', 'key-abc')).toBe(true);
    const tenant = tm.getTenantForKey('key-abc');
    expect(tenant).toBeTruthy();
    expect(tenant!.id).toBe('t1');
  });

  test('prevents binding key to multiple tenants', () => {
    tm.create({ id: 't1', name: 'One' });
    tm.create({ id: 't2', name: 'Two' });
    tm.bindKey('t1', 'key-abc');
    expect(() => tm.bindKey('t2', 'key-abc')).toThrow('already bound');
  });

  test('unbinds key from tenant', () => {
    tm.create({ id: 't1', name: 'Test' });
    tm.bindKey('t1', 'key-abc');
    expect(tm.unbindKey('key-abc')).toBe(true);
    expect(tm.getTenantForKey('key-abc')).toBeUndefined();
  });

  test('checkAccess blocks suspended tenant', () => {
    tm.create({ id: 't1', name: 'Test' });
    tm.bindKey('t1', 'key-abc');
    tm.suspend('t1');
    const result = tm.checkAccess('key-abc');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('tenant-suspended');
  });

  test('checkAccess allows unbound key', () => {
    const result = tm.checkAccess('unbound-key');
    expect(result.allowed).toBe(true);
  });

  test('credit management', () => {
    tm.create({ id: 't1', name: 'Test', credits: 100 });
    expect(tm.addCredits('t1', 50)).toBe(150);
    expect(tm.consumeCredits('t1', 30)).toBe(120);
    expect(tm.consumeCredits('t1', 200)).toBeNull(); // insufficient
    expect(tm.get('t1')!.credits).toBe(120);
  });

  test('recordCall increments tenant call count', () => {
    tm.create({ id: 't1', name: 'Test' });
    tm.bindKey('t1', 'key-abc');
    tm.recordCall('key-abc');
    tm.recordCall('key-abc');
    expect(tm.get('t1')!.totalCalls).toBe(2);
  });

  test('usage report', () => {
    tm.create({ id: 't1', name: 'Test', credits: 100 });
    tm.bindKey('t1', 'key-abc');
    tm.recordCall('key-abc');
    const report = tm.getUsageReport('t1');
    expect(report).toBeTruthy();
    expect(report!.tenantName).toBe('Test');
    expect(report!.keyCount).toBe(1);
    expect(report!.totalCalls).toBe(1);
  });

  test('delete tenant removes key bindings', () => {
    tm.create({ id: 't1', name: 'Test' });
    tm.bindKey('t1', 'key-abc');
    expect(tm.delete('t1')).toBe(true);
    expect(tm.getTenantForKey('key-abc')).toBeUndefined();
    expect(tm.get('t1')).toBeUndefined();
  });

  test('getRateLimit returns tenant override', () => {
    tm.create({ id: 't1', name: 'Test', rateLimitPerMin: 500 });
    tm.bindKey('t1', 'key-abc');
    expect(tm.getRateLimit('key-abc')).toBe(500);
    expect(tm.getRateLimit('unbound-key')).toBe(0);
  });

  test('stats aggregate correctly', () => {
    tm.create({ id: 't1', name: 'A', credits: 100 });
    tm.create({ id: 't2', name: 'B', credits: 200 });
    tm.suspend('t2');
    tm.bindKey('t1', 'k1');
    tm.bindKey('t1', 'k2');
    const stats = tm.stats();
    expect(stats.totalTenants).toBe(2);
    expect(stats.activeTenants).toBe(1);
    expect(stats.suspendedTenants).toBe(1);
    expect(stats.totalKeys).toBe(2);
    expect(stats.totalCredits).toBe(300);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Integration Tests — HTTP Endpoints
// ═══════════════════════════════════════════════════════════════════════════════

describe('v9.9.0 Integration', () => {
  let server: any;
  let port: number;
  let adminKey: string;

  // Inline echo MCP server
  const echoScript = `
    const rl = require('readline').createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } }) + '\\n');
        } else if (msg.method === 'tools/list') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } }] } }) + '\\n');
        } else if (msg.method === 'tools/call') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(msg.params?.arguments || {}) }] } }) + '\\n');
        }
      } catch {}
    });
  `;

  beforeAll(async () => {
    const { PayGateServer } = await import('../src/server');
    server = new PayGateServer({
      serverCommand: process.execPath,
      serverArgs: ['-e', echoScript],
      port: 0,
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 1000,
    } as any);
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
  }, 15000);

  afterAll(async () => {
    if (server) await server.stop();
  });

  // ─── IP Access ────────────────────────────────────────────────────────────

  test('GET /admin/ip-access returns stats', async () => {
    const r = await request(port, 'GET', '/admin/ip-access', undefined, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(false);
    expect(r.body.blocked).toEqual([]);
  });

  test('POST /admin/ip-access configures and enables', async () => {
    const r = await request(port, 'POST', '/admin/ip-access', { enabled: true, denyList: ['192.168.1.1'] }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.globalDenyCount).toBe(1);
    // Disable again for other tests
    await request(port, 'POST', '/admin/ip-access', { enabled: false }, { 'X-Admin-Key': adminKey });
  });

  test('POST /admin/ip-access blocks an IP', async () => {
    const r = await request(port, 'POST', '/admin/ip-access', { block: '1.2.3.4', reason: 'test' }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.blocked).toBe('1.2.3.4');
    // Unblock
    await request(port, 'POST', '/admin/ip-access', { unblock: '1.2.3.4' }, { 'X-Admin-Key': adminKey });
  });

  test('DELETE /admin/ip-access clears all', async () => {
    const r = await request(port, 'DELETE', '/admin/ip-access', undefined, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.cleared).toBe(true);
  });

  // ─── Request Signing ──────────────────────────────────────────────────────

  test('GET /admin/signing returns stats', async () => {
    const r = await request(port, 'GET', '/admin/signing', undefined, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(false);
    expect(r.body.registeredKeys).toBe(0);
  });

  test('POST /admin/signing registers a key', async () => {
    const r = await request(port, 'POST', '/admin/signing', { registerKey: 'test-key-123', label: 'test' }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.registered).toBe(true);
    expect(r.body.secret).toBeTruthy();
    expect(r.body.secret.length).toBe(64);
  });

  test('POST /admin/signing rotates a key', async () => {
    await request(port, 'POST', '/admin/signing', { registerKey: 'rotate-key' }, { 'X-Admin-Key': adminKey });
    const r = await request(port, 'POST', '/admin/signing', { rotateKey: 'rotate-key' }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.rotated).toBe(true);
  });

  test('POST /admin/signing removes a key', async () => {
    await request(port, 'POST', '/admin/signing', { registerKey: 'remove-key' }, { 'X-Admin-Key': adminKey });
    const r = await request(port, 'POST', '/admin/signing', { removeKey: 'remove-key' }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.removed).toBe(true);
  });

  test('DELETE /admin/signing clears all', async () => {
    const r = await request(port, 'DELETE', '/admin/signing', undefined, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.cleared).toBe(true);
  });

  // ─── Tenants ──────────────────────────────────────────────────────────────

  test('GET /admin/tenants returns stats (disabled by default)', async () => {
    const r = await request(port, 'GET', '/admin/tenants', undefined, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(false);
  });

  test('POST /admin/tenants enables and creates tenant', async () => {
    // Enable first
    await request(port, 'POST', '/admin/tenants', { enabled: true }, { 'X-Admin-Key': adminKey });

    // Create tenant
    const r = await request(port, 'POST', '/admin/tenants', {
      name: 'Acme Corp',
      id: 'acme-test',
      credits: 1000,
      rateLimitPerMin: 100,
    }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(201);
    expect(r.body.id).toBe('acme-test');
    expect(r.body.name).toBe('Acme Corp');
    expect(r.body.credits).toBe(1000);
  });

  test('POST /admin/tenants binds key to tenant', async () => {
    const r = await request(port, 'POST', '/admin/tenants', {
      bindKey: 'api-key-for-acme',
      tenantId: 'acme-test',
    }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.bound).toBe(true);
  });

  test('POST /admin/tenants adds credits', async () => {
    const r = await request(port, 'POST', '/admin/tenants', {
      addCredits: 500,
      tenantId: 'acme-test',
    }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.credits).toBe(1500);
  });

  test('POST /admin/tenants suspends tenant', async () => {
    const r = await request(port, 'POST', '/admin/tenants', { suspend: 'acme-test' }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.suspended).toBe(true);
  });

  test('POST /admin/tenants activates tenant', async () => {
    const r = await request(port, 'POST', '/admin/tenants', { activate: 'acme-test' }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.activated).toBe(true);
  });

  test('GET /admin/tenants?id=acme-test returns usage report', async () => {
    const r = await request(port, 'GET', '/admin/tenants?id=acme-test', undefined, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.tenantName).toBe('Acme Corp');
    expect(r.body.credits).toBe(1500);
  });

  test('DELETE /admin/tenants deletes specific tenant', async () => {
    const r = await request(port, 'DELETE', '/admin/tenants', { tenantId: 'acme-test' }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(true);
  });

  // ─── Root listing ─────────────────────────────────────────────────────────

  test('root listing includes v9.9 endpoints', async () => {
    const r = await request(port, 'GET', '/', undefined, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.endpoints.adminIpAccess).toBeTruthy();
    expect(r.body.endpoints.adminSigning).toBeTruthy();
    expect(r.body.endpoints.adminTenants).toBeTruthy();
  });
});
