/**
 * Tests for v8.12.0 — Anomaly Detection
 *
 * GET /admin/anomalies — Identifies unusual patterns: usage spikes,
 * high denial rates, dormant-then-active keys, and abnormal tool error rates.
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

describe('Anomaly Detection', () => {
  jest.setTimeout(15000);

  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    await server.stop();
  });

  test('returns complete anomaly detection structure', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/anomalies', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalAnomalies).toBe('number');
    expect(Array.isArray(r.body.anomalies)).toBe(true);
    expect(typeof r.body.analyzedAt).toBe('string');
  });

  test('no activity produces no anomalies', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/anomalies', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalAnomalies).toBe(0);
    expect(r.body.anomalies).toHaveLength(0);
  });

  test('flags keys with high denial rates', async () => {
    server = makeServer({ defaultCreditsPerCall: 100 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create key with very few credits — most calls will be denied
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'denied-key' }, { 'X-Admin-Key': adminKey })).body.key;

    // First call succeeds (100 credits)
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    // Remaining calls denied (insufficient credits)
    for (let i = 2; i <= 6; i++) {
      await httpPost(port, '/mcp', { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    }

    const r = await httpGet(port, '/admin/anomalies', { 'X-Admin-Key': adminKey });

    const highDenial = r.body.anomalies.find((a: any) => a.type === 'high_denial_rate');
    expect(highDenial).toBeDefined();
    expect(highDenial.severity).toBeDefined();
  });

  test('normal usage produces no anomalies', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 10000, name: 'normal-user' }, { 'X-Admin-Key': adminKey })).body.key;

    // A few normal calls
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/anomalies', { 'X-Admin-Key': adminKey });

    // Should have no high denial rate anomalies for this key
    const keyAnomalies = r.body.anomalies.filter((a: any) => a.keyName === 'normal-user' && a.type === 'high_denial_rate');
    expect(keyAnomalies).toHaveLength(0);
  });

  test('flags rapid credit depletion', async () => {
    server = makeServer({ defaultCreditsPerCall: 50 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 200, name: 'depleting' }, { 'X-Admin-Key': adminKey })).body.key;

    // Rapidly spend most credits
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/anomalies', { 'X-Admin-Key': adminKey });

    const depletion = r.body.anomalies.find((a: any) => a.type === 'rapid_credit_depletion');
    expect(depletion).toBeDefined();
  });

  test('flags keys with low remaining credits', async () => {
    server = makeServer({ defaultCreditsPerCall: 90 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'nearly-empty' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/anomalies', { 'X-Admin-Key': adminKey });

    const lowCredits = r.body.anomalies.find((a: any) => a.type === 'low_credits');
    expect(lowCredits).toBeDefined();
    expect(lowCredits.keyName).toBe('nearly-empty');
  });

  test('does not flag keys with plenty of credits', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    await httpPost(port, '/keys', { credits: 10000, name: 'wealthy' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/anomalies', { 'X-Admin-Key': adminKey });

    const lowCredits = r.body.anomalies.filter((a: any) => a.type === 'low_credits' && a.keyName === 'wealthy');
    expect(lowCredits).toHaveLength(0);
  });

  test('anomaly includes description', async () => {
    server = makeServer({ defaultCreditsPerCall: 90 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'desc-test' }, { 'X-Admin-Key': adminKey })).body.key;
    await httpPost(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_a', arguments: {} } }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/anomalies', { 'X-Admin-Key': adminKey });

    if (r.body.anomalies.length > 0) {
      expect(typeof r.body.anomalies[0].type).toBe('string');
      expect(typeof r.body.anomalies[0].description).toBe('string');
      expect(typeof r.body.anomalies[0].severity).toBe('string');
    }
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/anomalies');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/anomalies', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.anomalyDetection).toBeDefined();
    expect(r.body.endpoints.anomalyDetection).toContain('/admin/anomalies');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;

    await httpGet(port, '/admin/anomalies', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/anomalies', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(100);
  });
});
