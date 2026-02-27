/**
 * Tests for v8.9.0 — Security Audit
 *
 * GET /admin/security — Security posture analysis identifying keys without
 * IP allowlists, without quotas, with wide-open ACLs, stale/expired keys,
 * and overall security score.
 */

import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';
import http from 'http';

/* ── helpers ─────────────────────────────────────────────── */

const ECHO_CMD = process.execPath;
const ECHO_ARGS = ['-e', `
  process.stdin.resume();
  process.stdin.on('data', d => {
    const r = JSON.parse(d.toString().trim());
    if (r.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { tools: [
        { name: 'tool_a', inputSchema: { type: 'object' } },
        { name: 'tool_b', inputSchema: { type: 'object' } },
      ] } }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { content: [{ type: 'text', text: 'ok' }] } }) + '\\n');
    }
  });
`];

function makeServer(overrides: Record<string, any> = {}): PayGateServer {
  return new PayGateServer({
    ...DEFAULT_CONFIG,
    serverCommand: ECHO_CMD,
    serverArgs: ECHO_ARGS,
    port: 0,
    ...overrides,
  });
}

function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        let buf = '';
        res.on('data', (c: Buffer) => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode!, body: buf }); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function httpPost(port: number, path: string, body: any, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let buf = '';
        res.on('data', (c: Buffer) => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode!, body: buf }); }
        });
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

/* ── tests ───────────────────────────────────────────────── */

describe('Security Audit', () => {
  jest.setTimeout(15000);

  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    await server.stop();
  });

  test('returns complete security audit structure', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/security', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(typeof r.body.score).toBe('number');
    expect(r.body.score).toBeGreaterThanOrEqual(0);
    expect(r.body.score).toBeLessThanOrEqual(100);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalKeys).toBe('number');
    expect(typeof r.body.summary.totalFindings).toBe('number');
    expect(Array.isArray(r.body.findings)).toBe(true);
  });

  test('empty system has perfect score', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/security', { 'X-Admin-Key': adminKey });

    expect(r.body.score).toBe(100);
    expect(r.body.summary.totalKeys).toBe(0);
    expect(r.body.summary.totalFindings).toBe(0);
    expect(r.body.findings).toHaveLength(0);
  });

  test('flags keys without IP allowlist', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'no-ip' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/security', { 'X-Admin-Key': adminKey });

    const finding = r.body.findings.find((f: any) => f.type === 'no_ip_allowlist');
    expect(finding).toBeDefined();
    expect(finding.keys.length).toBeGreaterThanOrEqual(1);
    expect(finding.severity).toBe('warning');
  });

  test('flags keys without quotas', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'no-quota' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/security', { 'X-Admin-Key': adminKey });

    const finding = r.body.findings.find((f: any) => f.type === 'no_quota');
    expect(finding).toBeDefined();
    expect(finding.keys.length).toBeGreaterThanOrEqual(1);
    expect(finding.severity).toBe('info');
  });

  test('flags keys with wide-open ACL', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Key with no allowedTools = all tools accessible
    await httpPost(port, '/keys', { credits: 100, name: 'wide-open' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/security', { 'X-Admin-Key': adminKey });

    const finding = r.body.findings.find((f: any) => f.type === 'no_acl_restriction');
    expect(finding).toBeDefined();
    expect(finding.keys.length).toBeGreaterThanOrEqual(1);
    expect(finding.severity).toBe('info');
  });

  test('does not flag keys with ACL restrictions', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', {
      credits: 100, name: 'restricted',
      allowedTools: ['tool_a'],
    }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/security', { 'X-Admin-Key': adminKey });

    const finding = r.body.findings.find((f: any) => f.type === 'no_acl_restriction');
    if (finding) {
      expect(finding.keys).not.toContain('restricted');
    }
  });

  test('flags keys without spending limit', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 1000, name: 'no-limit' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/security', { 'X-Admin-Key': adminKey });

    const finding = r.body.findings.find((f: any) => f.type === 'no_spending_limit');
    expect(finding).toBeDefined();
    expect(finding.keys.length).toBeGreaterThanOrEqual(1);
    expect(finding.severity).toBe('info');
  });

  test('flags keys without expiry', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'no-expiry' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/security', { 'X-Admin-Key': adminKey });

    const finding = r.body.findings.find((f: any) => f.type === 'no_expiry');
    expect(finding).toBeDefined();
    expect(finding.keys.length).toBeGreaterThanOrEqual(1);
    expect(finding.severity).toBe('info');
  });

  test('flags high-credit keys as high-value targets', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100000, name: 'whale' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/security', { 'X-Admin-Key': adminKey });

    const finding = r.body.findings.find((f: any) => f.type === 'high_credit_balance');
    expect(finding).toBeDefined();
    expect(finding.severity).toBe('warning');
  });

  test('well-configured key reduces findings', async () => {
    server = makeServer({
      defaultCreditsPerCall: 5,
      globalQuota: { dailyCallLimit: 100, monthlyCallLimit: 1000, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Well-configured key with IP, ACL, expiry, spending limit
    const created = await httpPost(port, '/keys', {
      credits: 100,
      name: 'secure-key',
      allowedTools: ['tool_a'],
      ipAllowlist: ['10.0.0.0/8'],
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    }, { 'X-Admin-Key': adminKey });

    // Set spending limit via dedicated endpoint
    await httpPost(port, '/limits', {
      key: created.body.key,
      spendingLimit: 500,
    }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/security', { 'X-Admin-Key': adminKey });

    // Secure key should not appear in any findings
    for (const finding of r.body.findings) {
      expect(finding.keys).not.toContain('secure-key');
    }
  });

  test('score decreases with more findings', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create key with many security gaps
    await httpPost(port, '/keys', { credits: 100000, name: 'insecure' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/security', { 'X-Admin-Key': adminKey });

    expect(r.body.score).toBeLessThan(100);
    expect(r.body.summary.totalFindings).toBeGreaterThan(0);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/security');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/security', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.securityAudit).toBeDefined();
    expect(r.body.endpoints.securityAudit).toContain('/admin/security');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/security', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/security', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
