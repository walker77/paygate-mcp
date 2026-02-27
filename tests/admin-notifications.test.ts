/**
 * Tests for v8.1.0 — Admin Notifications
 *
 * GET /admin/notifications — Actionable notifications for expiring keys,
 * low credits, high error rates, and rate limit pressure.
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

/** Discover tools so the MCP proxy populates the tool registry. */
async function discoverTools(port: number, apiKey: string): Promise<void> {
  await httpPost(port, '/mcp', {
    jsonrpc: '2.0', id: 999, method: 'tools/list', params: {},
  }, { 'X-API-Key': apiKey });
}

/** Create a key with 5 credits, discover tools, make one tool call (costs 5) → 0 credits. */
async function createZeroCreditKey(
  port: number, adminKey: string, name: string, extra: Record<string, any> = {},
): Promise<string> {
  const k = (await httpPost(port, '/keys', { credits: 5, name, ...extra }, { 'X-Admin-Key': adminKey })).body.key;
  await discoverTools(port, k);
  await httpPost(port, '/mcp', {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'tool_a', arguments: {} },
  }, { 'X-API-Key': k });
  return k;
}

/* ── tests ───────────────────────────────────────────────── */

describe('Admin Notifications', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeEach(async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
  }, 30_000);

  afterEach(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('returns empty notifications when all keys are healthy', async () => {
    await httpPost(port, '/keys', { credits: 1000, name: 'healthy' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/notifications', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.total).toBe(0);
    expect(r.body.critical).toBe(0);
    expect(r.body.warning).toBe(0);
    expect(r.body.info).toBe(0);
    expect(r.body.notifications).toHaveLength(0);
  });

  test('reports zero-credit keys as critical', async () => {
    await createZeroCreditKey(port, adminKey, 'broke-key');

    const r = await httpGet(port, '/admin/notifications', { 'X-Admin-Key': adminKey });

    const zeroCredit = r.body.notifications.find((n: any) => n.category === 'zero_credits');
    expect(zeroCredit).toBeDefined();
    expect(zeroCredit.severity).toBe('critical');
    expect(zeroCredit.key).toMatch(/^pg_.+\.\.\./);
    expect(zeroCredit.keyName).toBe('broke-key');
  });

  test('reports suspended keys as info', async () => {
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'susp' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys/suspend', { key: k }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/notifications', { 'X-Admin-Key': adminKey });

    const suspended = r.body.notifications.find((n: any) => n.category === 'key_suspended');
    expect(suspended).toBeDefined();
    expect(suspended.severity).toBe('info');
  });

  test('reports expired keys as critical', async () => {
    // Create key that expires immediately
    const k = (await httpPost(port, '/keys', {
      credits: 100, name: 'expiring',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }, { 'X-Admin-Key': adminKey })).body.key;

    const r = await httpGet(port, '/admin/notifications', { 'X-Admin-Key': adminKey });

    const expired = r.body.notifications.find((n: any) => n.category === 'key_expired');
    expect(expired).toBeDefined();
    expect(expired.severity).toBe('critical');
  });

  test('reports keys expiring within 24h as critical', async () => {
    const k = (await httpPost(port, '/keys', {
      credits: 100, name: 'soon',
      expiresAt: new Date(Date.now() + 12 * 3_600_000).toISOString(), // 12 hours
    }, { 'X-Admin-Key': adminKey })).body.key;

    const r = await httpGet(port, '/admin/notifications', { 'X-Admin-Key': adminKey });

    const expiring = r.body.notifications.find((n: any) => n.category === 'key_expiring_soon' && n.severity === 'critical');
    expect(expiring).toBeDefined();
    expect(expiring.details.hoursRemaining).toBeLessThan(24);
  });

  test('reports keys expiring within 7 days as warning', async () => {
    const k = (await httpPost(port, '/keys', {
      credits: 100, name: 'week',
      expiresAt: new Date(Date.now() + 3 * 24 * 3_600_000).toISOString(), // 3 days
    }, { 'X-Admin-Key': adminKey })).body.key;

    const r = await httpGet(port, '/admin/notifications', { 'X-Admin-Key': adminKey });

    const expiring = r.body.notifications.find((n: any) => n.category === 'key_expiring_soon' && n.severity === 'warning');
    expect(expiring).toBeDefined();
    expect(expiring.details.daysRemaining).toBeLessThan(7);
  });

  test('filters by severity', async () => {
    await createZeroCreditKey(port, adminKey, 'crit');
    const sk = (await httpPost(port, '/keys', { credits: 100, name: 'susp-key' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys/suspend', { key: sk }, { 'X-Admin-Key': adminKey });

    // Filter critical only
    const critOnly = await httpGet(port, '/admin/notifications?severity=critical', { 'X-Admin-Key': adminKey });
    expect(critOnly.body.notifications.every((n: any) => n.severity === 'critical')).toBe(true);

    // Filter info only
    const infoOnly = await httpGet(port, '/admin/notifications?severity=info', { 'X-Admin-Key': adminKey });
    expect(infoOnly.body.notifications.every((n: any) => n.severity === 'info')).toBe(true);
  });

  test('sorts by severity: critical first', async () => {
    await createZeroCreditKey(port, adminKey, 'crit-key');
    const sk = (await httpPost(port, '/keys', { credits: 100, name: 'info-key' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys/suspend', { key: sk }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/notifications', { 'X-Admin-Key': adminKey });

    if (r.body.notifications.length >= 2) {
      const severities = r.body.notifications.map((n: any) => n.severity);
      const criticalIdx = severities.indexOf('critical');
      const infoIdx = severities.indexOf('info');
      if (criticalIdx >= 0 && infoIdx >= 0) {
        expect(criticalIdx).toBeLessThan(infoIdx);
      }
    }
  });

  test('skips revoked keys', async () => {
    const k = await createZeroCreditKey(port, adminKey, 'revoked-broke');
    await httpPost(port, '/keys/revoke', { key: k }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/notifications', { 'X-Admin-Key': adminKey });

    // Should not have zero_credits for the revoked key
    const revokedNotif = r.body.notifications.find((n: any) => n.keyName === 'revoked-broke');
    expect(revokedNotif).toBeUndefined();
  });

  test('includes notification counts in summary', async () => {
    await createZeroCreditKey(port, adminKey, 'n1');
    await createZeroCreditKey(port, adminKey, 'n2');
    const sk = (await httpPost(port, '/keys', { credits: 100, name: 'n3' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys/suspend', { key: sk }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/notifications', { 'X-Admin-Key': adminKey });

    expect(r.body.total).toBe(r.body.critical + r.body.warning + r.body.info);
    expect(r.body.critical).toBeGreaterThanOrEqual(2); // 2 zero-credit keys
    expect(r.body.info).toBeGreaterThanOrEqual(1); // 1 suspended key
  });

  test('requires admin key', async () => {
    const r = await httpGet(port, '/admin/notifications');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    const r = await httpPost(port, '/admin/notifications', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.adminNotifications).toBeDefined();
    expect(r.body.endpoints.adminNotifications).toContain('/admin/notifications');
  });

  test('multiple issues for same key', async () => {
    // Create key that is both zero credits AND expiring soon
    const k = await createZeroCreditKey(port, adminKey, 'multi-issue', {
      expiresAt: new Date(Date.now() + 6 * 3_600_000).toISOString(), // 6 hours
    });

    const r = await httpGet(port, '/admin/notifications', { 'X-Admin-Key': adminKey });

    const keyNotifications = r.body.notifications.filter((n: any) => n.keyName === 'multi-issue');
    // Should have at least zero_credits + key_expiring_soon
    expect(keyNotifications.length).toBeGreaterThanOrEqual(2);
    const categories = keyNotifications.map((n: any) => n.category);
    expect(categories).toContain('zero_credits');
    expect(categories).toContain('key_expiring_soon');
  });

  test('no notifications when no keys exist', async () => {
    const r = await httpGet(port, '/admin/notifications', { 'X-Admin-Key': adminKey });
    // No API keys created — only admin key exists but it's managed separately
    expect(r.body.total).toBe(0);
  });

  test('notification includes key details', async () => {
    await createZeroCreditKey(port, adminKey, 'detail-check');

    const r = await httpGet(port, '/admin/notifications', { 'X-Admin-Key': adminKey });

    const notif = r.body.notifications.find((n: any) => n.keyName === 'detail-check');
    expect(notif).toBeDefined();
    expect(notif.key).toMatch(/^pg_/);
    expect(notif.message).toBeTruthy();
    expect(notif.category).toBeTruthy();
    expect(notif.severity).toBeTruthy();
  });
});
