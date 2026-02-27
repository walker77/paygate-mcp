/**
 * Tests for v8.5.0 — Rate Limit Analysis
 *
 * GET /admin/rate-limits — Rate limit utilization analysis with per-key
 * and per-tool breakdown, denial trends, peak hours, and most throttled keys.
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

describe('Rate Limit Analysis', () => {
  jest.setTimeout(15000);

  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeEach(async () => {
    server = makeServer({ defaultCreditsPerCall: 5, globalRateLimitPerMin: 60 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
  });

  afterEach(async () => {
    await server.stop();
  });

  test('returns complete rate limit analysis structure', async () => {
    const r = await httpGet(port, '/admin/rate-limits', { 'X-Admin-Key': adminKey });

    expect(r.status).toBe(200);
    // Config
    expect(r.body.config).toBeDefined();
    expect(typeof r.body.config.globalLimitPerMin).toBe('number');
    expect(typeof r.body.config.windowMs).toBe('number');
    // Summary
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.totalCalls).toBe('number');
    expect(typeof r.body.summary.totalRateLimited).toBe('number');
    expect(typeof r.body.summary.rateLimitRate).toBe('number');
    // Arrays
    expect(Array.isArray(r.body.perKey)).toBe(true);
    expect(Array.isArray(r.body.perTool)).toBe(true);
    expect(Array.isArray(r.body.hourlyTrends)).toBe(true);
    expect(Array.isArray(r.body.mostThrottled)).toBe(true);
  });

  test('empty system has zero rate limit activity', async () => {
    const r = await httpGet(port, '/admin/rate-limits', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalCalls).toBe(0);
    expect(r.body.summary.totalRateLimited).toBe(0);
    expect(r.body.summary.rateLimitRate).toBe(0);
    expect(r.body.perKey).toHaveLength(0);
    expect(r.body.perTool).toHaveLength(0);
    expect(r.body.mostThrottled).toHaveLength(0);
  });

  test('tracks calls without rate limit hits', async () => {
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'safe' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/rate-limits', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalCalls).toBe(1);
    expect(r.body.summary.totalRateLimited).toBe(0);
    expect(r.body.summary.rateLimitRate).toBe(0);
  });

  test('detects rate-limited calls', async () => {
    // Use very low rate limit to trigger denials
    await server.stop();
    server = makeServer({ defaultCreditsPerCall: 5, globalRateLimitPerMin: 2 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'throttled' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    // 2 calls allowed, 3rd should be rate limited
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

    const r = await httpGet(port, '/admin/rate-limits', { 'X-Admin-Key': adminKey });

    expect(r.body.summary.totalCalls).toBe(3);
    expect(r.body.summary.totalRateLimited).toBeGreaterThanOrEqual(1);
    expect(r.body.summary.rateLimitRate).toBeGreaterThan(0);
  });

  test('per-key breakdown shows calls and denials', async () => {
    await server.stop();
    server = makeServer({ defaultCreditsPerCall: 5, globalRateLimitPerMin: 2 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k = (await httpPost(port, '/keys', { credits: 100, name: 'per-key-test' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
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

    const r = await httpGet(port, '/admin/rate-limits', { 'X-Admin-Key': adminKey });

    expect(r.body.perKey.length).toBeGreaterThanOrEqual(1);
    const entry = r.body.perKey[0];
    expect(entry.name).toBeDefined();
    expect(typeof entry.calls).toBe('number');
    expect(typeof entry.rateLimited).toBe('number');
  });

  test('per-tool breakdown shows rate limit denials', async () => {
    await server.stop();
    server = makeServer({ defaultCreditsPerCall: 5, globalRateLimitPerMin: 1 });
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

    const r = await httpGet(port, '/admin/rate-limits', { 'X-Admin-Key': adminKey });

    expect(r.body.perTool.length).toBeGreaterThanOrEqual(1);
    const toolA = r.body.perTool.find((t: any) => t.tool === 'tool_a');
    expect(toolA).toBeDefined();
    expect(toolA.calls).toBeGreaterThanOrEqual(1);
  });

  test('hourly trends have correct structure', async () => {
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'trend-test' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/rate-limits', { 'X-Admin-Key': adminKey });

    expect(r.body.hourlyTrends.length).toBeGreaterThanOrEqual(1);
    const bucket = r.body.hourlyTrends[0];
    expect(bucket.hour).toBeTruthy();
    expect(typeof bucket.calls).toBe('number');
    expect(typeof bucket.rateLimited).toBe('number');
  });

  test('most throttled ranked by denials', async () => {
    await server.stop();
    server = makeServer({ defaultCreditsPerCall: 5, globalRateLimitPerMin: 1 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const k1 = (await httpPost(port, '/keys', { credits: 100, name: 'light' }, { 'X-Admin-Key': adminKey })).body.key;
    const k2 = (await httpPost(port, '/keys', { credits: 100, name: 'heavy' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k1);
    // light: 2 calls (1 allowed, 1 denied)
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k1 });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k1 });
    // heavy: 3 calls (1 allowed, 2 denied)
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k2 });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k2 });
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k2 });

    const r = await httpGet(port, '/admin/rate-limits', { 'X-Admin-Key': adminKey });

    expect(r.body.mostThrottled.length).toBeGreaterThanOrEqual(1);
    // Most throttled should be first
    if (r.body.mostThrottled.length >= 2) {
      expect(r.body.mostThrottled[0].rateLimited).toBeGreaterThanOrEqual(r.body.mostThrottled[1].rateLimited);
    }
  });

  test('config shows global limit', async () => {
    const r = await httpGet(port, '/admin/rate-limits', { 'X-Admin-Key': adminKey });

    expect(r.body.config.globalLimitPerMin).toBe(60);
    expect(r.body.config.windowMs).toBe(60000);
  });

  test('reports current window utilization', async () => {
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'window-test' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    const r = await httpGet(port, '/admin/rate-limits', { 'X-Admin-Key': adminKey });

    // Should have current window info per key
    const keyEntry = r.body.perKey.find((k: any) => k.name === 'window-test');
    expect(keyEntry).toBeDefined();
    expect(typeof keyEntry.currentWindowUsed).toBe('number');
    expect(keyEntry.currentWindowUsed).toBeGreaterThanOrEqual(1);
  });

  test('requires admin key', async () => {
    const r = await httpGet(port, '/admin/rate-limits');
    expect(r.status).toBe(401);
  });

  test('rejects POST method', async () => {
    const r = await httpPost(port, '/admin/rate-limits', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes endpoint', async () => {
    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.rateLimitAnalysis).toBeDefined();
    expect(r.body.endpoints.rateLimitAnalysis).toContain('/admin/rate-limits');
  });

  test('does not modify system state', async () => {
    const k = (await httpPost(port, '/keys', { credits: 100, name: 'stable' }, { 'X-Admin-Key': adminKey })).body.key;
    await discoverTools(port, k);
    await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'tool_a', arguments: {} },
    }, { 'X-API-Key': k });

    // Call rate limit analysis multiple times
    await httpGet(port, '/admin/rate-limits', { 'X-Admin-Key': adminKey });
    await httpGet(port, '/admin/rate-limits', { 'X-Admin-Key': adminKey });

    const balance = await httpGet(port, '/balance', { 'X-API-Key': k });
    expect(balance.body.credits).toBe(95);
  });

  test('handles unlimited rate limit', async () => {
    await server.stop();
    server = makeServer({ defaultCreditsPerCall: 5, globalRateLimitPerMin: 0 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const r = await httpGet(port, '/admin/rate-limits', { 'X-Admin-Key': adminKey });

    expect(r.body.config.globalLimitPerMin).toBe(0);
    expect(r.body.summary.totalRateLimited).toBe(0);
  });
});
