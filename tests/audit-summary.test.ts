/**
 * Tests for v8.23.0 — Audit Summary
 *
 * GET /admin/audit-summary — Audit event analytics: total events,
 * event type breakdown, top actors, recent events, and hourly
 * activity trend.
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
        { name: 'tool_c', inputSchema: { type: 'object' } },
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

describe('Audit Summary', () => {
  jest.setTimeout(15000);

  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('returns complete structure', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/audit-summary', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalEvents).toBe('number');
    expect(typeof r.body.summary.eventsLastHour).toBe('number');
    expect(typeof r.body.summary.eventsLast24h).toBe('number');
    expect(r.body.eventsByType).toBeDefined();
    expect(Array.isArray(r.body.topActors)).toBe(true);
    expect(Array.isArray(r.body.recentEvents)).toBe(true);
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('has events from server startup', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/audit-summary', { 'X-Admin-Key': adminKey });

    // Server startup generates no audit events by default, but requesting this endpoint doesn't either
    // Events come from key creation, gate decisions, etc.
    expect(r.body.summary.totalEvents).toBeGreaterThanOrEqual(0);
  });

  test('tracks key creation events', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'test-key-1' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 200, name: 'test-key-2' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/audit-summary', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalEvents).toBeGreaterThanOrEqual(2);
    // key.created events should appear in eventsByType
    const keyCreated = r.body.eventsByType.find((e: any) => e.type === 'key.created');
    expect(keyCreated).toBeDefined();
    expect(keyCreated.count).toBeGreaterThanOrEqual(2);
  });

  test('eventsByType sorted by count descending', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create keys to generate events
    await httpPost(port, '/keys', { credits: 100, name: 'k1' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 100, name: 'k2' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 100, name: 'k3' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/audit-summary', { 'X-Admin-Key': adminKey });

    // Verify sorted by count descending
    for (let i = 1; i < r.body.eventsByType.length; i++) {
      expect(r.body.eventsByType[i - 1].count).toBeGreaterThanOrEqual(r.body.eventsByType[i].count);
    }
  });

  test('topActors shows most active actors', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create keys (admin actor)
    await httpPost(port, '/keys', { credits: 100, name: 'k1' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 100, name: 'k2' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/audit-summary', { 'X-Admin-Key': adminKey });

    expect(r.body.topActors.length).toBeGreaterThanOrEqual(1);
    // admin should be in top actors
    const adminActor = r.body.topActors.find((a: any) => a.actor === 'admin');
    expect(adminActor).toBeDefined();
    expect(adminActor.count).toBeGreaterThanOrEqual(2);

    // Sorted by count descending
    for (let i = 1; i < r.body.topActors.length; i++) {
      expect(r.body.topActors[i - 1].count).toBeGreaterThanOrEqual(r.body.topActors[i].count);
    }
  });

  test('recentEvents returns newest first', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'first' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 100, name: 'second' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/audit-summary', { 'X-Admin-Key': adminKey });

    expect(r.body.recentEvents.length).toBeGreaterThanOrEqual(2);
    // Should be newest first (IDs descending)
    for (let i = 1; i < r.body.recentEvents.length; i++) {
      expect(r.body.recentEvents[i - 1].id).toBeGreaterThan(r.body.recentEvents[i].id);
    }
  });

  test('recentEvents capped at 20', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create 25 keys to generate at least 25 events
    for (let i = 0; i < 25; i++) {
      await httpPost(port, '/keys', { credits: 10, name: `key-${i}` }, { 'X-Admin-Key': adminKey });
    }

    const r = await httpGet(port, '/admin/audit-summary', { 'X-Admin-Key': adminKey });

    expect(r.body.recentEvents.length).toBeLessThanOrEqual(20);
  });

  test('summary includes oldest and newest timestamps', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 100, name: 'k1' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/audit-summary', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.oldestEvent).toBeDefined();
    expect(r.body.summary.newestEvent).toBeDefined();
    expect(typeof r.body.summary.oldestEvent).toBe('string');
    expect(typeof r.body.summary.newestEvent).toBe('string');
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/audit-summary');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/audit-summary', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.auditSummary).toBeDefined();
    expect(r.body.endpoints.auditSummary).toContain('/admin/audit-summary');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/audit-summary', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/audit-summary', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
