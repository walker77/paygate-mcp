/**
 * Tests for v8.6.0 — Quota Analysis
 *
 * GET /admin/quotas — Quota utilization analysis with per-key and per-namespace
 * breakdown, denial trends, most constrained keys, and configuration display.
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

describe('Quota Analysis', () => {
  jest.setTimeout(15000);

  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    await server.stop();
  });

  test('returns complete quota analysis structure', async () => {
    server = makeServer({
      defaultCreditsPerCall: 5,
      globalQuota: { dailyCallLimit: 100, monthlyCallLimit: 1000, dailyCreditLimit: 500, monthlyCreditLimit: 5000 },
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/quotas', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    // Config
    expect(r.body.config).toBeDefined();
    expect(r.body.config.globalQuota).toBeDefined();
    // Summary
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalKeys).toBe('number');
    expect(typeof r.body.summary.keysWithQuotas).toBe('number');
    expect(typeof r.body.summary.totalQuotaDenials).toBe('number');
    expect(typeof r.body.summary.quotaDenialRate).toBe('number');
    // Arrays
    expect(Array.isArray(r.body.perKey)).toBe(true);
    expect(Array.isArray(r.body.perTool)).toBe(true);
    expect(Array.isArray(r.body.hourlyTrends)).toBe(true);
    expect(Array.isArray(r.body.mostConstrained)).toBe(true);
  });

  test('empty system has zero quota activity', async () => {
    server = makeServer({
      defaultCreditsPerCall: 5,
      globalQuota: { dailyCallLimit: 100, monthlyCallLimit: 1000, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/quotas', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalKeys).toBe(0);
    expect(r.body.summary.keysWithQuotas).toBe(0);
    expect(r.body.summary.totalQuotaDenials).toBe(0);
    expect(r.body.summary.quotaDenialRate).toBe(0);
    expect(r.body.perKey).toHaveLength(0);
    expect(r.body.perTool).toHaveLength(0);
    expect(r.body.mostConstrained).toHaveLength(0);
  });

  test('tracks calls without quota denials', async () => {
    server = makeServer({
      defaultCreditsPerCall: 5,
      globalQuota: { dailyCallLimit: 100, monthlyCallLimit: 1000, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'safe' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/quotas', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalQuotaDenials).toBe(0);
    expect(r.body.summary.quotaDenialRate).toBe(0);
  });

  test('detects quota-exceeded denials', async () => {
    server = makeServer({
      defaultCreditsPerCall: 5,
      globalQuota: { dailyCallLimit: 2, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'quota-hit' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    // 2 calls allowed by daily quota, 3rd should be denied
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/quotas', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalQuotaDenials).toBeGreaterThanOrEqual(1);
    expect(r.body.summary.quotaDenialRate).toBeGreaterThan(0);
  });

  test('per-key breakdown shows quota utilization', async () => {
    server = makeServer({
      defaultCreditsPerCall: 5,
      globalQuota: { dailyCallLimit: 100, monthlyCallLimit: 1000, dailyCreditLimit: 500, monthlyCreditLimit: 5000 },
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'per-key-q' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/quotas', { 'X-Admin-Key': adminKey });

    expect(r.body.perKey.length).toBeGreaterThanOrEqual(1);
    const entry = r.body.perKey.find((e: any) => e.name === 'per-key-q');
    expect(entry).toBeDefined();
    expect(typeof entry.dailyCalls).toBe('number');
    expect(typeof entry.monthlyCalls).toBe('number');
    expect(typeof entry.dailyCallLimit).toBe('number');
    expect(typeof entry.monthlyCallLimit).toBe('number');
    expect(entry.dailyCalls).toBe(1);
    expect(entry.monthlyCalls).toBe(1);
  });

  test('per-key shows per-key quota overrides', async () => {
    server = makeServer({
      defaultCreditsPerCall: 5,
      globalQuota: { dailyCallLimit: 100, monthlyCallLimit: 1000, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create key with per-key quota
    const k = (await httpPost(port, '/keys', {
      credits: 100, name: 'custom-quota',
      quota: { dailyCallLimit: 10, monthlyCallLimit: 50, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
    }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/quotas', { 'X-Admin-Key': adminKey });

    const entry = r.body.perKey.find((e: any) => e.name === 'custom-quota');
    expect(entry).toBeDefined();
    expect(entry.dailyCallLimit).toBe(10);
    expect(entry.monthlyCallLimit).toBe(50);
    expect(entry.source).toBe('per-key');
  });

  test('per-tool breakdown shows quota denials per tool', async () => {
    server = makeServer({
      defaultCreditsPerCall: 5,
      globalQuota: { dailyCallLimit: 1, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'tool-test' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/quotas', { 'X-Admin-Key': adminKey });

    expect(r.body.perTool.length).toBeGreaterThanOrEqual(1);
    const toolA = r.body.perTool.find((t: any) => t.tool === 'tool_a');
    expect(toolA).toBeDefined();
    expect(toolA.calls).toBeGreaterThanOrEqual(1);
    expect(typeof toolA.quotaDenied).toBe('number');
  });

  test('hourly trends have correct structure', async () => {
    server = makeServer({
      defaultCreditsPerCall: 5,
      globalQuota: { dailyCallLimit: 100, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'trend-q' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/quotas', { 'X-Admin-Key': adminKey });

    expect(r.body.hourlyTrends.length).toBeGreaterThanOrEqual(1);
    const bucket = r.body.hourlyTrends[0];
    expect(bucket.hour).toBeTruthy();
    expect(typeof bucket.calls).toBe('number');
    expect(typeof bucket.quotaDenied).toBe('number');
  });

  test('most constrained ranked by utilization', async () => {
    server = makeServer({
      defaultCreditsPerCall: 5,
      globalQuota: { dailyCallLimit: 10, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // light: 1 call out of 10 = 10% utilized
    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'light' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k1);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k1 });

    // heavy: custom quota of 3, make 2 calls = 66% utilized
    const k2 = (await httpPost(port, '/keys', {
      credits: 100, name: 'heavy',
      quota: { dailyCallLimit: 3, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
    }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k2);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k2 });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/quotas', { 'X-Admin-Key': adminKey });

    expect(r.body.mostConstrained.length).toBeGreaterThanOrEqual(1);
    // Most constrained (highest utilization) should be first
    if (r.body.mostConstrained.length >= 2) {
      expect(r.body.mostConstrained[0].dailyCallUtilization).toBeGreaterThanOrEqual(
        r.body.mostConstrained[1].dailyCallUtilization
      );
    }
  });

  test('config shows global quota settings', async () => {
    server = makeServer({
      defaultCreditsPerCall: 5,
      globalQuota: { dailyCallLimit: 50, monthlyCallLimit: 500, dailyCreditLimit: 200, monthlyCreditLimit: 2000 },
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/quotas', { 'X-Admin-Key': adminKey });

    expect(r.body.config.globalQuota.dailyCallLimit).toBe(50);
    expect(r.body.config.globalQuota.monthlyCallLimit).toBe(500);
    expect(r.body.config.globalQuota.dailyCreditLimit).toBe(200);
    expect(r.body.config.globalQuota.monthlyCreditLimit).toBe(2000);
  });

  test('handles no global quota (unlimited)', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/quotas', { 'X-Admin-Key': adminKey });

    expect(r.body.config.globalQuota).toBeNull();
    expect(r.body.summary.keysWithQuotas).toBe(0);
  });

  test('counts keys with per-key quotas even without global', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Create key WITH a per-key quota even though no global quota
    await httpPost(port, '/keys', {
      credits: 100, name: 'has-quota',
      quota: { dailyCallLimit: 10, monthlyCallLimit: 100, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
    }, { 'X-Admin-Key': adminKey });
    // Create key WITHOUT quota
    await httpPost(port, '/keys', { credits: 100, name: 'no-quota' }, { 'X-Admin-Key': adminKey });

    const r = await httpGet(port, '/admin/quotas', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalKeys).toBe(2);
    expect(r.body.summary.keysWithQuotas).toBe(1);
  });

  test('requires admin key', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/quotas');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpPost(port, '/admin/quotas', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.quotaAnalysis).toBeDefined();
    expect(r.body.endpoints.quotaAnalysis).toContain('/admin/quotas');
  });

  test('does not modify system state', async () => {
    server = makeServer({
      defaultCreditsPerCall: 5,
      globalQuota: { dailyCallLimit: 100, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    // Call quota analysis multiple times
    await httpGet(port, '/admin/quotas', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/quotas', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(95);
  });
});
