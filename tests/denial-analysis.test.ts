/**
 * Tests for v8.7.0 — Denial Analysis
 *
 * GET /admin/denials — Comprehensive denial breakdown by reason type,
 * per-key and per-tool denial stats, hourly trends, and most denied keys.
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

async function discoverTools(port: number, apiKey: string): Promise<void> {
  await httpPost(port, '/mcp', {
    jsonrpc: '2.0', id: 999, method: 'tools/list', params: {},
  }, { 'X-API-Key': apiKey });
}

/* ── tests ───────────────────────────────────────────────── */

describe('Denial Analysis', () => {
  jest.setTimeout(15000);

  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('returns complete denial analysis structure', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/denials', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    // Summary
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalCalls).toBe('number');
    expect(typeof r.body.summary.totalDenials).toBe('number');
    expect(typeof r.body.summary.denialRate).toBe('number');
    // Breakdown by reason
    expect(r.body.byReason).toBeDefined();
    expect(typeof r.body.byReason).toBe('object');
    // Arrays
    expect(Array.isArray(r.body.perKey)).toBe(true);
    expect(Array.isArray(r.body.perTool)).toBe(true);
    expect(Array.isArray(r.body.hourlyTrends)).toBe(true);
    expect(Array.isArray(r.body.mostDenied)).toBe(true);
  });

  test('empty system has zero denials', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/denials', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalCalls).toBe(0);
    expect(r.body.summary.totalDenials).toBe(0);
    expect(r.body.summary.denialRate).toBe(0);
    expect(Object.keys(r.body.byReason)).toHaveLength(0);
    expect(r.body.perKey).toHaveLength(0);
    expect(r.body.perTool).toHaveLength(0);
    expect(r.body.mostDenied).toHaveLength(0);
  });

  test('tracks successful calls without denials', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'good-key' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/denials', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalCalls).toBeGreaterThanOrEqual(1);
    expect(r.body.summary.totalDenials).toBe(0);
    expect(r.body.summary.denialRate).toBe(0);
  });

  test('detects insufficient_credits denials', async () => {
    server = makeServer({ defaultCreditsPerCall: 50 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Key with only 10 credits, calls cost 50
    const k = (await httpPost(port, '/keys', { credits: 10, name: 'broke' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/denials', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalDenials).toBeGreaterThanOrEqual(1);
    expect(r.body.byReason.insufficient_credits).toBeGreaterThanOrEqual(1);
  });

  test('detects rate_limited denials', async () => {
    server = makeServer({ defaultCreditsPerCall: 5, globalRateLimitPerMin: 1 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'fast' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/denials', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalDenials).toBeGreaterThanOrEqual(1);
    expect(r.body.byReason.rate_limited).toBeGreaterThanOrEqual(1);
  });

  test('detects quota_exceeded denials', async () => {
    server = makeServer({
      defaultCreditsPerCall: 5,
      globalQuota: { dailyCallLimit: 1, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'quotad' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/denials', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalDenials).toBeGreaterThanOrEqual(1);
    expect(r.body.byReason.quota_exceeded).toBeGreaterThanOrEqual(1);
  });

  test('detects key_suspended denials', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'susp' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    // Suspend the key
    await httpPost(port, '/keys/suspend', { key: k }, { 'X-Admin-Key': adminKey });
    // Try to call — should be denied
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/denials', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalDenials).toBeGreaterThanOrEqual(1);
    expect(r.body.byReason.key_suspended).toBeGreaterThanOrEqual(1);
  });

  test('per-key breakdown shows denial counts', async () => {
    server = makeServer({ defaultCreditsPerCall: 50 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 10, name: 'denial-key' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/denials', { 'X-Admin-Key': adminKey });

    expect(r.body.perKey.length).toBeGreaterThanOrEqual(1);
    const entry = r.body.perKey.find((e: any) => e.name === 'denial-key');
    expect(entry).toBeDefined();
    expect(typeof entry.calls).toBe('number');
    expect(typeof entry.denials).toBe('number');
    expect(typeof entry.denialRate).toBe('number');
    expect(entry.denials).toBeGreaterThanOrEqual(1);
  });

  test('per-tool breakdown shows denial counts', async () => {
    server = makeServer({ defaultCreditsPerCall: 5, globalRateLimitPerMin: 1 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'tool-deny' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/denials', { 'X-Admin-Key': adminKey });

    expect(r.body.perTool.length).toBeGreaterThanOrEqual(1);
    const toolA = r.body.perTool.find((t: any) => t.tool === 'tool_a');
    expect(toolA).toBeDefined();
    expect(toolA.denials).toBeGreaterThanOrEqual(1);
  });

  test('hourly trends have correct structure', async () => {
    server = makeServer({ defaultCreditsPerCall: 50 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 10, name: 'trend-deny' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/denials', { 'X-Admin-Key': adminKey });

    expect(r.body.hourlyTrends.length).toBeGreaterThanOrEqual(1);
    const bucket = r.body.hourlyTrends[0];
    expect(bucket.hour).toBeTruthy();
    expect(typeof bucket.calls).toBe('number');
    expect(typeof bucket.denials).toBe('number');
  });

  test('most denied ranked by denial count', async () => {
    server = makeServer({ defaultCreditsPerCall: 50 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // light: 1 denial
    const k1 = (await httpPost(port, '/keys', { credits: 10, name: 'light-deny' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k1);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k1 });

    // heavy: 2 denials
    const k2 = (await httpPost(port, '/keys', { credits: 10, name: 'heavy-deny' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k2);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k2 });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/denials', { 'X-Admin-Key': adminKey });

    expect(r.body.mostDenied.length).toBeGreaterThanOrEqual(1);
    if (r.body.mostDenied.length >= 2) {
      expect(r.body.mostDenied[0].denials).toBeGreaterThanOrEqual(r.body.mostDenied[1].denials);
    }
  });

  test('categorizes multiple denial types correctly', async () => {
    server = makeServer({ defaultCreditsPerCall: 5, globalRateLimitPerMin: 1 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create key with low credits for insufficient_credits
    const k1 = (await httpPost(port, '/keys', { credits: 2, name: 'low-cred' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k1);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k1 });

    // Create key for rate limiting
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'rate-hit' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k2);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k2 });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/denials', { 'X-Admin-Key': adminKey });

    // Should have at least 2 different denial types
    const reasons = Object.keys(r.body.byReason);
    expect(reasons.length).toBeGreaterThanOrEqual(2);
    expect(r.body.byReason.insufficient_credits).toBeGreaterThanOrEqual(1);
    expect(r.body.byReason.rate_limited).toBeGreaterThanOrEqual(1);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/denials');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/denials', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.denialAnalysis).toBeDefined();
    expect(r.body.endpoints.denialAnalysis).toContain('/admin/denials');
  });

  test('does not modify system state', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    await httpGet(port, '/admin/denials', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/denials', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(95);
  });
});
