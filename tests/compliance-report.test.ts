/**
 * Tests for v8.14.0 — Compliance Report
 *
 * GET /admin/compliance — Generates a compliance-ready report with data
 * retention status, key governance, access control coverage, and audit
 * trail completeness for SOC2/GDPR readiness.
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

describe('Compliance Report', () => {
  jest.setTimeout(15000);

  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    await server.stop();
  });

  test('returns complete compliance structure', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/compliance', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.keyGovernance).toBeDefined();
    expect(r.body.accessControl).toBeDefined();
    expect(r.body.auditTrail).toBeDefined();
    expect(typeof r.body.overallScore).toBe('number');
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty system returns baseline compliance', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/compliance', { 'X-Admin-Key': adminKey });

    expect(r.body.keyGovernance.totalKeys).toBe(0);
    expect(r.body.accessControl.keysWithAcl).toBe(0);
    expect(r.body.auditTrail.totalEvents).toBe(0);
  });

  test('tracks keys without expiry', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create keys without expiry
    await httpPost(port, '/keys', { credits: 100, name: 'no-expiry-1' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 100, name: 'no-expiry-2' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/compliance', { 'X-Admin-Key': adminKey });

    expect(r.body.keyGovernance.totalKeys).toBe(2);
    expect(r.body.keyGovernance.keysWithoutExpiry).toBe(2);
  });

  test('keys with expiry improve governance', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create key with expiry
    await httpPost(port, '/keys', { credits: 100, name: 'has-expiry', expiresIn: 86400000 }, { 'X-Admin-Key': adminKey });
    // Create key without expiry
    await httpPost(port, '/keys', { credits: 100, name: 'no-expiry' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/compliance', { 'X-Admin-Key': adminKey });

    expect(r.body.keyGovernance.keysWithExpiry).toBe(1);
    expect(r.body.keyGovernance.keysWithoutExpiry).toBe(1);
  });

  test('tracks ACL coverage', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create key with ACL
    await httpPost(port, '/keys', { credits: 100, name: 'acl-key', allowedTools: ['tool_a'] }, { 'X-Admin-Key': adminKey });
    // Create key without ACL
    await httpPost(port, '/keys', { credits: 100, name: 'open-key' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/compliance', { 'X-Admin-Key': adminKey });

    expect(r.body.accessControl.keysWithAcl).toBe(1);
    expect(r.body.accessControl.keysWithoutAcl).toBe(1);
  });

  test('tracks IP restriction coverage', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create key with IP restriction
    await httpPost(port, '/keys', { credits: 100, name: 'ip-key', ipAllowlist: ['10.0.0.0/8'] }, { 'X-Admin-Key': adminKey });
    // Create key without IP restriction
    await httpPost(port, '/keys', { credits: 100, name: 'any-ip' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/compliance', { 'X-Admin-Key': adminKey });

    expect(r.body.accessControl.keysWithIpRestriction).toBe(1);
    expect(r.body.accessControl.keysWithoutIpRestriction).toBe(1);
  });

  test('tracks spending limit coverage', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'limited' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/limits', { key: k, spendingLimit: 500 }, { 'X-Admin-Key': adminKey });

    await httpPost(port, '/keys', { credits: 100, name: 'unlimited' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/compliance', { 'X-Admin-Key': adminKey });

    expect(r.body.accessControl.keysWithSpendingLimit).toBe(1);
    expect(r.body.accessControl.keysWithoutSpendingLimit).toBe(1);
  });

  test('audit trail tracks events', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 1000, name: 'active' }, { 'X-Admin-Key': adminKey })).body.key;

    // Generate some events
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_b', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/compliance', { 'X-Admin-Key': adminKey });

    expect(r.body.auditTrail.totalEvents).toBeGreaterThanOrEqual(2);
    expect(r.body.auditTrail.uniqueTools).toBeGreaterThanOrEqual(1);
  });

  test('overall score improves with better controls', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Baseline score with no keys
    const baseline = await httpGet(port, '/admin/compliance', { 'X-Admin-Key': adminKey });

    // Create well-governed key
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'governed', allowedTools: ['tool_a'], ipAllowlist: ['10.0.0.0/8'], expiresIn: 86400000 }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/limits', { key: k, spendingLimit: 200 }, { 'X-Admin-Key': adminKey });

    const governed = await httpGet(port, '/admin/compliance', { 'X-Admin-Key': adminKey });

    // Well-governed system should have a good score
    expect(governed.body.overallScore).toBeGreaterThanOrEqual(80);
  });

  test('poor governance lowers score', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create keys with no controls
    await httpPost(port, '/keys', { credits: 100, name: 'open1' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 100, name: 'open2' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 100, name: 'open3' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/compliance', { 'X-Admin-Key': adminKey });

    // No controls = lower score
    expect(r.body.overallScore).toBeLessThan(80);
  });

  test('includes recommendations', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'open' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/compliance', { 'X-Admin-Key': adminKey });

    expect(Array.isArray(r.body.recommendations)).toBe(true);
    expect(r.body.recommendations.length).toBeGreaterThan(0);
    // Should have string recommendations
    expect(typeof r.body.recommendations[0]).toBe('string');
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/compliance');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/compliance', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.complianceReport).toBeDefined();
    expect(r.body.endpoints.complianceReport).toContain('/admin/compliance');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/compliance', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/compliance', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
