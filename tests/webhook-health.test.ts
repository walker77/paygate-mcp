/**
 * Tests for v8.27.0 — Webhook Health
 *
 * GET /admin/webhook-health — Webhook delivery health overview:
 * success rate, pending retries, dead letter count, pause status,
 * recent failures, and delivery stats. Built on webhook emitter data.
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

describe('Webhook Health', () => {
  jest.setTimeout(15000);

  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('returns complete structure without webhook', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/webhook-health', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.status).toBeDefined();
    expect(typeof r.body.configured).toBe('boolean');
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('shows not configured when no webhook URL', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/webhook-health', { 'X-Admin-Key': adminKey });

    expect(r.body.configured).toBe(false);
    expect(r.body.status).toBe('not_configured');
  });

  test('shows healthy when webhook configured', async () => {
    server = makeServer({
      defaultCreditsPerCall: 5,
      webhookUrl: 'http://127.0.0.1:19999/hook',
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/webhook-health', { 'X-Admin-Key': adminKey });

    expect(r.body.configured).toBe(true);
    expect(typeof r.body.status).toBe('string');
    expect(r.body.delivery).toBeDefined();
    expect(typeof r.body.delivery.totalDelivered).toBe('number');
    expect(typeof r.body.delivery.totalFailed).toBe('number');
    expect(typeof r.body.delivery.totalRetries).toBe('number');
  });

  test('includes dead letter count', async () => {
    server = makeServer({
      defaultCreditsPerCall: 5,
      webhookUrl: 'http://127.0.0.1:19999/hook',
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/webhook-health', { 'X-Admin-Key': adminKey });

    expect(typeof r.body.delivery.deadLetterCount).toBe('number');
    expect(typeof r.body.delivery.pendingRetries).toBe('number');
  });

  test('includes pause status', async () => {
    server = makeServer({
      defaultCreditsPerCall: 5,
      webhookUrl: 'http://127.0.0.1:19999/hook',
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/webhook-health', { 'X-Admin-Key': adminKey });

    expect(typeof r.body.delivery.paused).toBe('boolean');
    expect(r.body.delivery.paused).toBe(false);
  });

  test('reflects paused state after webhook pause', async () => {
    server = makeServer({
      defaultCreditsPerCall: 5,
      webhookUrl: 'http://127.0.0.1:19999/hook',
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Pause webhooks
    await httpPost(port, '/webhooks/pause', {}, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/webhook-health', { 'X-Admin-Key': adminKey });

    expect(r.body.delivery.paused).toBe(true);
    expect(r.body.status).toBe('paused');
  });

  test('includes success rate', async () => {
    server = makeServer({
      defaultCreditsPerCall: 5,
      webhookUrl: 'http://127.0.0.1:19999/hook',
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/webhook-health', { 'X-Admin-Key': adminKey });

    expect(typeof r.body.delivery.successRate).toBe('number');
  });

  test('includes buffered events count', async () => {
    server = makeServer({
      defaultCreditsPerCall: 5,
      webhookUrl: 'http://127.0.0.1:19999/hook',
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/webhook-health', { 'X-Admin-Key': adminKey });

    expect(typeof r.body.delivery.bufferedEvents).toBe('number');
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/webhook-health');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/webhook-health', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.webhookHealth).toBeDefined();
    expect(r.body.endpoints.webhookHealth).toContain('/admin/webhook-health');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/webhook-health', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/webhook-health', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
