/**
 * Tests for v8.56.0 — Consumer Risk Score
 *
 * GET /admin/consumer-risk-score — Per-consumer risk scoring based on
 * denial rate, spend velocity, and credit depletion proximity. Risk
 * levels: low, medium, high, critical.
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

describe('Consumer Risk Score', () => {
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

    const r = await httpGet(port, '/admin/consumer-risk-score', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.consumers)).toBe(true);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalConsumers).toBe('number');
    expect(typeof r.body.generatedAt).toBe('string');
  });

  test('empty when no keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/consumer-risk-score', { 'X-Admin-Key': adminKey });

    expect(r.body.consumers.length).toBe(0);
    expect(r.body.summary.totalConsumers).toBe(0);
  });

  test('assigns low risk to idle consumers', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 1000, name: 'idle-user' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/consumer-risk-score', { 'X-Admin-Key': adminKey });

    expect(r.body.consumers[0].name).toBe('idle-user');
    expect(r.body.consumers[0].riskLevel).toBe('low');
    expect(typeof r.body.consumers[0].riskScore).toBe('number');
    expect(r.body.consumers[0].riskScore).toBeLessThanOrEqual(100);
  });

  test('higher risk for low credits remaining', async () => {
    server = makeServer({ defaultCreditsPerCall: 40 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'nearly-empty' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys', { credits: 1000, name: 'well-funded' }, { 'X-Admin-Key': adminKey });

    // Burn most of nearly-empty's credits
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });

    const r = await httpGet(port, '/admin/consumer-risk-score', { 'X-Admin-Key': adminKey });

    const nearlyEmpty = r.body.consumers.find((c: any) => c.name === 'nearly-empty');
    const wellFunded = r.body.consumers.find((c: any) => c.name === 'well-funded');

    expect(nearlyEmpty.riskScore).toBeGreaterThan(wellFunded.riskScore);
  });

  test('each entry includes risk factors', async () => {
    server = makeServer({ defaultCreditsPerCall: 10 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 200, name: 'test-user' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/consumer-risk-score', { 'X-Admin-Key': adminKey });

    const entry = r.body.consumers[0];
    expect(entry.name).toBe('test-user');
    expect(typeof entry.riskScore).toBe('number');
    expect(typeof entry.riskLevel).toBe('string');
    expect(typeof entry.creditsRemaining).toBe('number');
    expect(typeof entry.totalSpent).toBe('number');
    expect(typeof entry.utilizationPercent).toBe('number');
  });

  test('sorted by riskScore descending', async () => {
    server = makeServer({ defaultCreditsPerCall: 40 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'risky' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys', { credits: 1000, name: 'safe' }, { 'X-Admin-Key': adminKey });

    // Burn 80% of risky's credits
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k1 });

    const r = await httpGet(port, '/admin/consumer-risk-score', { 'X-Admin-Key': adminKey });

    expect(r.body.consumers[0].name).toBe('risky');
    expect(r.body.consumers[1].name).toBe('safe');
  });

  test('summary counts risk levels', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 1000, name: 'safe1' }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys', { credits: 1000, name: 'safe2' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/consumer-risk-score', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalConsumers).toBe(2);
    expect(typeof r.body.summary.riskDistribution).toBe('object');
    expect(typeof r.body.summary.riskDistribution.low).toBe('number');
  });

  test('excludes revoked and suspended keys', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'revoked' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'suspended' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/keys', { credits: 100, name: 'active' }, { 'X-Admin-Key': adminKey });

    await httpPost(port, '/keys/revoke', { key: k1 }, { 'X-Admin-Key': adminKey });
    await httpPost(port, '/keys/suspend', { key: k2 }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/consumer-risk-score', { 'X-Admin-Key': adminKey });

    expect(r.body.consumers.length).toBe(1);
    expect(r.body.consumers[0].name).toBe('active');
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/consumer-risk-score');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/consumer-risk-score', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.consumerRiskScore).toBeDefined();
    expect(r.body.endpoints.consumerRiskScore).toContain('/admin/consumer-risk-score');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/consumer-risk-score', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/consumer-risk-score', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
