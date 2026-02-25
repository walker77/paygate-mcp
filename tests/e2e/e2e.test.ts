/**
 * End-to-end test: starts a real PayGateServer wrapping the mock MCP server,
 * exercises the full flow with HTTP requests.
 */

import { PayGateServer } from '../../src/server';
import * as http from 'http';
import * as path from 'path';

const MOCK_SERVER = path.join(__dirname, 'mock-mcp-server.js');

function httpRequest(port: number, reqPath: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
} = {}): Promise<{ status: number; headers: Record<string, string>; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port,
      path: reqPath,
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...options.headers },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode!,
            headers: res.headers as Record<string, string>,
            body: JSON.parse(data),
          });
        } catch {
          resolve({ status: res.statusCode!, headers: res.headers as Record<string, string>, body: data });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

describe('E2E: PayGate wrapping mock MCP server', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    port = 3500 + Math.floor(Math.random() * 400);
    server = new PayGateServer({
      serverCommand: 'node',
      serverArgs: [MOCK_SERVER],
      port,
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 20,
      name: 'E2E Test Server',
      toolPricing: {
        'premium_analyze': { creditsPerCall: 5 },
      },
    });

    const result = await server.start();
    port = result.port;
    adminKey = result.adminKey;

    // Wait for MCP server to be ready
    await new Promise(r => setTimeout(r, 500));
  }, 15000);

  afterAll(async () => {
    await server.stop();
  }, 10000);

  // ─── Full lifecycle test ──────────────────────────────────────────────────

  it('should complete full lifecycle: create key → call tools → exhaust credits → top up → resume', async () => {
    // Step 1: Create an API key with 5 credits
    const createRes = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'e2e-client', credits: 5 },
    });
    expect(createRes.status).toBe(201);
    const apiKey = createRes.body.key;
    expect(apiKey).toMatch(/^pg_/);
    expect(createRes.body.credits).toBe(5);

    // Step 2: Free method — tools/list (no auth needed)
    const listRes = await httpRequest(port, '/mcp', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    expect(listRes.status).toBe(200);
    expect(listRes.body.result.tools).toBeDefined();
    expect(listRes.body.result.tools.length).toBe(3);

    // Step 3: Paid tool call — search (1 credit)
    const searchRes = await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search', arguments: { query: 'hello' } } },
    });
    expect(searchRes.status).toBe(200);
    expect(searchRes.body.result).toBeDefined();
    expect(searchRes.body.error).toBeUndefined();

    // Step 4: Check status — should show 4 credits remaining
    const statusRes = await httpRequest(port, '/status', {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.usage.totalCreditsSpent).toBe(1);

    // Step 5: Premium tool call — 5 credits (but we only have 4)
    const premiumRes = await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'premium_analyze', arguments: { data: 'test' } } },
    });
    expect(premiumRes.status).toBe(200);
    expect(premiumRes.body.error).toBeDefined();
    expect(premiumRes.body.error.code).toBe(-32402);
    expect(premiumRes.body.error.message).toContain('insufficient_credits');

    // Step 6: Use remaining credits with regular calls
    for (let i = 0; i < 4; i++) {
      const r = await httpRequest(port, '/mcp', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey },
        body: { jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: { name: 'search', arguments: { query: `q${i}` } } },
      });
      expect(r.body.error).toBeUndefined();
    }

    // Step 7: Now at 0 credits — should be denied
    const deniedRes = await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'search', arguments: { query: 'denied' } } },
    });
    expect(deniedRes.body.error).toBeDefined();
    expect(deniedRes.body.error.message).toContain('insufficient_credits');

    // Step 8: Top up — add 10 credits
    const topupRes = await httpRequest(port, '/topup', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { key: apiKey, credits: 10 },
    });
    expect(topupRes.status).toBe(200);
    expect(topupRes.body.credits).toBe(10);

    // Step 9: Should work again after top-up
    const resumeRes = await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: { jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'search', arguments: { query: 'resumed' } } },
    });
    expect(resumeRes.body.error).toBeUndefined();
    expect(resumeRes.body.result).toBeDefined();
  }, 30000);

  // ─── No auth on free methods ──────────────────────────────────────────────

  it('should allow initialize and ping without API key', async () => {
    const initRes = await httpRequest(port, '/mcp', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 100, method: 'initialize', params: {} },
    });
    expect(initRes.body.result.serverInfo).toBeDefined();

    const pingRes = await httpRequest(port, '/mcp', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 101, method: 'ping', params: {} },
    });
    expect(pingRes.body.result).toBeDefined();
  });

  // ─── Missing API key on paid method ───────────────────────────────────────

  it('should deny tools/call without API key', async () => {
    const res = await httpRequest(port, '/mcp', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 200, method: 'tools/call', params: { name: 'search', arguments: {} } },
    });
    expect(res.body.error).toBeDefined();
    expect(res.body.error.message).toContain('Payment required');
  });

  // ─── Invalid API key ──────────────────────────────────────────────────────

  it('should deny tools/call with invalid API key', async () => {
    const res = await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': 'pg_totally_fake_key' },
      body: { jsonrpc: '2.0', id: 201, method: 'tools/call', params: { name: 'search', arguments: {} } },
    });
    expect(res.body.error).toBeDefined();
    expect(res.body.error.message).toContain('Payment required');
  });

  // ─── Admin endpoint auth ──────────────────────────────────────────────────

  it('should deny admin endpoints without admin key', async () => {
    const statusRes = await httpRequest(port, '/status');
    expect(statusRes.status).toBe(401);

    const keysRes = await httpRequest(port, '/keys');
    expect(keysRes.status).toBe(401);

    const topupRes = await httpRequest(port, '/topup', {
      method: 'POST',
      body: { key: 'x', credits: 100 },
    });
    expect(topupRes.status).toBe(401);
  });

  // ─── Multiple keys isolation ──────────────────────────────────────────────

  it('should isolate credits between different API keys', async () => {
    // Create two keys
    const k1Res = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'client-a', credits: 2 },
    });
    const k2Res = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'client-b', credits: 100 },
    });

    const key1 = k1Res.body.key;
    const key2 = k2Res.body.key;

    // Exhaust key1
    await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': key1 },
      body: { jsonrpc: '2.0', id: 300, method: 'tools/call', params: { name: 'search', arguments: {} } },
    });
    await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': key1 },
      body: { jsonrpc: '2.0', id: 301, method: 'tools/call', params: { name: 'search', arguments: {} } },
    });

    // key1 should be denied
    const deniedRes = await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': key1 },
      body: { jsonrpc: '2.0', id: 302, method: 'tools/call', params: { name: 'search', arguments: {} } },
    });
    expect(deniedRes.body.error).toBeDefined();

    // key2 should still work
    const okRes = await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': key2 },
      body: { jsonrpc: '2.0', id: 303, method: 'tools/call', params: { name: 'search', arguments: {} } },
    });
    expect(okRes.body.error).toBeUndefined();
  });
});
