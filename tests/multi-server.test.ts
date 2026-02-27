/**
 * Multi-server mode tests: wrapping N MCP servers behind one PayGate
 * with tool prefix routing.
 */

import { PayGateServer } from '../src/server';
import { MultiServerRouter } from '../src/router';
import { Gate } from '../src/gate';
import * as http from 'http';
import * as path from 'path';

const MOCK_SERVER_A = path.join(__dirname, 'e2e', 'mock-mcp-server.js');
const MOCK_SERVER_B = path.join(__dirname, 'e2e', 'mock-mcp-server-b.js');

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

// ─── Unit Tests: MultiServerRouter ──────────────────────────────────────────

describe('MultiServerRouter — Unit Tests', () => {
  it('should reject duplicate prefixes', () => {
    const gate = new Gate({ name: 'test', serverCommand: '', serverArgs: [], port: 0, defaultCreditsPerCall: 1, toolPricing: {}, globalRateLimitPerMin: 60, freeMethods: ['initialize', 'tools/list', 'ping'], shadowMode: false, webhookUrl: null, webhookSecret: null, refundOnFailure: false });
    expect(() => new MultiServerRouter(gate, [
      { prefix: 'dup', serverCommand: 'node', serverArgs: [MOCK_SERVER_A] },
      { prefix: 'dup', serverCommand: 'node', serverArgs: [MOCK_SERVER_B] },
    ])).toThrow('Duplicate server prefix');
    gate.destroy();
  });

  it('should reject empty prefix', () => {
    const gate = new Gate({ name: 'test', serverCommand: '', serverArgs: [], port: 0, defaultCreditsPerCall: 1, toolPricing: {}, globalRateLimitPerMin: 60, freeMethods: ['initialize', 'tools/list', 'ping'], shadowMode: false, webhookUrl: null, webhookSecret: null, refundOnFailure: false });
    expect(() => new MultiServerRouter(gate, [
      { prefix: '', serverCommand: 'node', serverArgs: [MOCK_SERVER_A] },
    ])).toThrow('Invalid server prefix');
    gate.destroy();
  });

  it('should reject prefix containing separator', () => {
    const gate = new Gate({ name: 'test', serverCommand: '', serverArgs: [], port: 0, defaultCreditsPerCall: 1, toolPricing: {}, globalRateLimitPerMin: 60, freeMethods: ['initialize', 'tools/list', 'ping'], shadowMode: false, webhookUrl: null, webhookSecret: null, refundOnFailure: false });
    expect(() => new MultiServerRouter(gate, [
      { prefix: 'has:colon', serverCommand: 'node', serverArgs: [MOCK_SERVER_A] },
    ])).toThrow('Invalid server prefix');
    gate.destroy();
  });

  it('should reject server without transport', () => {
    const gate = new Gate({ name: 'test', serverCommand: '', serverArgs: [], port: 0, defaultCreditsPerCall: 1, toolPricing: {}, globalRateLimitPerMin: 60, freeMethods: ['initialize', 'tools/list', 'ping'], shadowMode: false, webhookUrl: null, webhookSecret: null, refundOnFailure: false });
    expect(() => new MultiServerRouter(gate, [
      { prefix: 'nope' },
    ])).toThrow('needs either serverCommand or remoteUrl');
    gate.destroy();
  });

  it('should reject server with both transports', () => {
    const gate = new Gate({ name: 'test', serverCommand: '', serverArgs: [], port: 0, defaultCreditsPerCall: 1, toolPricing: {}, globalRateLimitPerMin: 60, freeMethods: ['initialize', 'tools/list', 'ping'], shadowMode: false, webhookUrl: null, webhookSecret: null, refundOnFailure: false });
    expect(() => new MultiServerRouter(gate, [
      { prefix: 'both', serverCommand: 'node', serverArgs: [MOCK_SERVER_A], remoteUrl: 'http://localhost:9999' },
    ])).toThrow('cannot have both');
    gate.destroy();
  });

  it('should report correct prefixes and backend count', () => {
    const gate = new Gate({ name: 'test', serverCommand: '', serverArgs: [], port: 0, defaultCreditsPerCall: 1, toolPricing: {}, globalRateLimitPerMin: 60, freeMethods: ['initialize', 'tools/list', 'ping'], shadowMode: false, webhookUrl: null, webhookSecret: null, refundOnFailure: false });
    const router = new MultiServerRouter(gate, [
      { prefix: 'alpha', serverCommand: 'node', serverArgs: [MOCK_SERVER_A] },
      { prefix: 'beta', serverCommand: 'node', serverArgs: [MOCK_SERVER_B] },
    ]);
    expect(router.prefixes).toEqual(['alpha', 'beta']);
    expect(router.backendCount).toBe(2);
    gate.destroy();
  });
});

// ─── E2E Tests: Multi-Server Mode ──────────────────────────────────────────

describe('E2E: Multi-Server Mode', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    port = 3800 + Math.floor(Math.random() * 100);
    server = new PayGateServer({
      serverCommand: '', // not used in multi-server mode
      serverArgs: [],
      port,
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 100,
      name: 'Multi-Server Test',
      toolPricing: {
        'beta:write_file': { creditsPerCall: 3 },
      },
    }, undefined, undefined, undefined, undefined, [
      { prefix: 'alpha', serverCommand: 'node', serverArgs: [MOCK_SERVER_A] },
      { prefix: 'beta', serverCommand: 'node', serverArgs: [MOCK_SERVER_B] },
    ]);

    const result = await server.start();
    port = result.port;
    adminKey = result.adminKey;

    // Wait for MCP servers to be ready
    await new Promise(r => setTimeout(r, 500));
  }, 15000);

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  // ─── tools/list aggregation ──────────────────────────────────────────────

  it('should aggregate tools from all servers with prefixes', async () => {
    const res = await httpRequest(port, '/mcp', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    expect(res.status).toBe(200);
    expect(res.body.result.tools).toBeDefined();

    const toolNames = res.body.result.tools.map((t: any) => t.name);

    // Server A tools: search, generate, premium_analyze → alpha:search, alpha:generate, alpha:premium_analyze
    expect(toolNames).toContain('alpha:search');
    expect(toolNames).toContain('alpha:generate');
    expect(toolNames).toContain('alpha:premium_analyze');

    // Server B tools: read_file, write_file → beta:read_file, beta:write_file
    expect(toolNames).toContain('beta:read_file');
    expect(toolNames).toContain('beta:write_file');

    // Total: 3 + 2 = 5 tools
    expect(res.body.result.tools.length).toBe(5);
  });

  it('should add server prefix to tool descriptions', async () => {
    const res = await httpRequest(port, '/mcp', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    });
    const alphaSearch = res.body.result.tools.find((t: any) => t.name === 'alpha:search');
    expect(alphaSearch.description).toContain('[alpha]');

    const betaRead = res.body.result.tools.find((t: any) => t.name === 'beta:read_file');
    expect(betaRead.description).toContain('[beta]');
  });

  // ─── Routing by prefix ─────────────────────────────────────────────────

  it('should route tool call to correct backend by prefix', async () => {
    const keyRes = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'multi-test', credits: 100 },
    });
    const apiKey = keyRes.body.key;

    // Call alpha:search → routes to server A
    const alphaRes = await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'alpha:search', arguments: { query: 'hello' } } },
    });
    expect(alphaRes.body.error).toBeUndefined();
    expect(alphaRes.body.result.content[0].text).toContain('search');
    // Server A doesn't prefix with "[server-b]"
    expect(alphaRes.body.result.content[0].text).not.toContain('[server-b]');

    // Call beta:read_file → routes to server B
    const betaRes = await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'beta:read_file', arguments: { path: '/tmp/test.txt' } } },
    });
    expect(betaRes.body.error).toBeUndefined();
    expect(betaRes.body.result.content[0].text).toContain('[server-b]');
    expect(betaRes.body.result.content[0].text).toContain('read_file');
  });

  // ─── Per-tool pricing with prefixed names ───────────────────────────────

  it('should apply per-tool pricing using prefixed names', async () => {
    const keyRes = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'pricing-test', credits: 10 },
    });
    const apiKey = keyRes.body.key;

    // alpha:search costs 1 credit (default)
    await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'alpha:search', arguments: {} } },
    });

    // Check balance: should be 9
    const bal1 = await httpRequest(port, '/balance', {
      headers: { 'X-API-Key': apiKey },
    });
    expect(bal1.body.credits).toBe(9);

    // beta:write_file costs 3 credits (custom pricing)
    await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'beta:write_file', arguments: { path: '/tmp/out', content: 'data' } } },
    });

    // Check balance: should be 6 (9 - 3)
    const bal2 = await httpRequest(port, '/balance', {
      headers: { 'X-API-Key': apiKey },
    });
    expect(bal2.body.credits).toBe(6);
  });

  // ─── Error: unprefixed tool name ────────────────────────────────────────

  it('should reject unprefixed tool names', async () => {
    const keyRes = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'prefix-test', credits: 10 },
    });
    const apiKey = keyRes.body.key;

    const res = await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: { jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'search', arguments: {} } },
    });
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe(-32602);
    expect(res.body.error.message).toContain('must be prefixed');
    expect(res.body.error.message).toContain('alpha');
    expect(res.body.error.message).toContain('beta');
  });

  // ─── Error: unknown prefix ──────────────────────────────────────────────

  it('should reject unknown server prefix', async () => {
    const keyRes = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'unknown-prefix-test', credits: 10 },
    });
    const apiKey = keyRes.body.key;

    const res = await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: { jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'gamma:search', arguments: {} } },
    });
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe(-32602);
    expect(res.body.error.message).toContain('Unknown server prefix');
    expect(res.body.error.message).toContain('gamma');
  });

  // ─── Auth: no API key on tools/call ─────────────────────────────────────

  it('should deny tools/call without API key in multi-server mode', async () => {
    const res = await httpRequest(port, '/mcp', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'alpha:search', arguments: {} } },
    });
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe(-32402);
    expect(res.body.error.message).toContain('Payment required');
  });

  // ─── ACL filtering with prefixed names ──────────────────────────────────

  it('should filter tools/list by ACL using prefixed names', async () => {
    const keyRes = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'acl-test', credits: 100, allowedTools: ['alpha:search', 'beta:read_file'] },
    });
    const apiKey = keyRes.body.key;

    const listRes = await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: { jsonrpc: '2.0', id: 50, method: 'tools/list', params: {} },
    });

    const toolNames = listRes.body.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain('alpha:search');
    expect(toolNames).toContain('beta:read_file');
    expect(toolNames).not.toContain('alpha:generate');
    expect(toolNames).not.toContain('beta:write_file');
    expect(listRes.body.result.tools.length).toBe(2);
  });

  it('should deny tool calls blocked by ACL', async () => {
    const keyRes = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'acl-deny-test', credits: 100, allowedTools: ['alpha:search'] },
    });
    const apiKey = keyRes.body.key;

    // alpha:search should work
    const okRes = await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: { jsonrpc: '2.0', id: 51, method: 'tools/call', params: { name: 'alpha:search', arguments: {} } },
    });
    expect(okRes.body.error).toBeUndefined();

    // beta:read_file should be denied
    const deniedRes = await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: { jsonrpc: '2.0', id: 52, method: 'tools/call', params: { name: 'beta:read_file', arguments: {} } },
    });
    expect(deniedRes.body.error).toBeDefined();
    expect(deniedRes.body.error.code).toBe(-32402);
    expect(deniedRes.body.error.message).toContain('tool_not_allowed');
  });

  // ─── Credit exhaustion across servers ───────────────────────────────────

  it('should share credits across multiple servers', async () => {
    const keyRes = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'shared-credits', credits: 3 },
    });
    const apiKey = keyRes.body.key;

    // 1 credit on alpha
    const r1 = await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: { jsonrpc: '2.0', id: 60, method: 'tools/call', params: { name: 'alpha:search', arguments: {} } },
    });
    expect(r1.body.error).toBeUndefined();

    // 1 credit on beta
    const r2 = await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: { jsonrpc: '2.0', id: 61, method: 'tools/call', params: { name: 'beta:read_file', arguments: {} } },
    });
    expect(r2.body.error).toBeUndefined();

    // 1 credit left, try beta:write_file which costs 3 → denied
    const r3 = await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: { jsonrpc: '2.0', id: 62, method: 'tools/call', params: { name: 'beta:write_file', arguments: { path: '/tmp/x', content: 'y' } } },
    });
    expect(r3.body.error).toBeDefined();
    expect(r3.body.error.code).toBe(-32402);
    expect(r3.body.error.message).toContain('insufficient_credits');
  });

  // ─── Free methods still work ────────────────────────────────────────────

  it('should allow free methods (ping) without API key', async () => {
    const res = await httpRequest(port, '/mcp', {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 70, method: 'ping', params: {} },
    });
    expect(res.body.result).toBeDefined();
  });

  // ─── Usage tracking with prefixed names ─────────────────────────────────

  it('should track usage with prefixed tool names', async () => {
    const statusRes = await httpRequest(port, '/status', {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.usage.perTool).toBeDefined();

    // Should have entries for prefixed tool names
    const toolNames = Object.keys(statusRes.body.usage.perTool);
    const hasAlpha = toolNames.some(t => t.startsWith('alpha:'));
    const hasBeta = toolNames.some(t => t.startsWith('beta:'));
    expect(hasAlpha).toBe(true);
    expect(hasBeta).toBe(true);
  });

  // ─── Root endpoint shows multi-server info ─────────────────────────────

  it('should return server info from root endpoint', async () => {
    const res = await httpRequest(port, '/');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Multi-Server Test');
  });
});
