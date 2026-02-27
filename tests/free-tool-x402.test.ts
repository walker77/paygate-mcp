/**
 * Tests for:
 *   - isFree flag in pricing discovery
 *   - x402-compatible data in -32402 errors
 *   - freeToolCount in server metadata
 *   - x402Compatible flag in server metadata
 *   - MCP Tasks billing awareness (tasks/list, tasks/get, tasks/cancel as free methods)
 *   - billTaskCreation config option
 */

import { ToolRegistry } from '../src/registry';
import { DEFAULT_CONFIG, PayGateConfig } from '../src/types';
import { PayGateServer } from '../src/server';
import * as http from 'http';
import * as path from 'path';

const MOCK_SERVER = path.join(__dirname, 'e2e', 'mock-mcp-server.js');

function httpRequest(
  targetPort: number,
  urlPath: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; headers: Record<string, string>; body: any }> {
  return new Promise((resolve, reject) => {
    const method = options.method || (options.body ? 'POST' : 'GET');
    const bodyStr = options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined;

    const req = http.request(
      { hostname: 'localhost', port: targetPort, path: urlPath, method, headers: { 'Content-Type': 'application/json', ...options.headers } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, headers: res.headers as Record<string, string>, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, headers: res.headers as Record<string, string>, body: data });
          }
        });
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Unit Tests: isFree flag ──────────────────────────────────────────────

describe('ToolRegistry isFree flag', () => {
  it('should mark zero-credit tools as free', () => {
    const config = {
      ...DEFAULT_CONFIG,
      defaultCreditsPerCall: 5,
      toolPricing: {
        free_tool: { creditsPerCall: 0 },
        paid_tool: { creditsPerCall: 10 },
      },
    };
    const registry = new ToolRegistry(config, false);

    const freeP = registry.getToolPricing('free_tool');
    expect(freeP.isFree).toBe(true);
    expect(freeP.creditsPerCall).toBe(0);

    const paidP = registry.getToolPricing('paid_tool');
    expect(paidP.isFree).toBe(false);
    expect(paidP.creditsPerCall).toBe(10);
  });

  it('should mark tools using default pricing as not free (default > 0)', () => {
    const config = { ...DEFAULT_CONFIG, defaultCreditsPerCall: 1 };
    const registry = new ToolRegistry(config, false);

    const pricing = registry.getToolPricing('some_tool');
    expect(pricing.isFree).toBe(false);
    expect(pricing.creditsPerCall).toBe(1);
  });

  it('should mark tools as not free if they have dynamic pricing', () => {
    const config = {
      ...DEFAULT_CONFIG,
      toolPricing: {
        dynamic_tool: { creditsPerCall: 0, creditsPerKbInput: 2 },
      },
    };
    const registry = new ToolRegistry(config, false);

    const pricing = registry.getToolPricing('dynamic_tool');
    // Base is 0 but has per-KB pricing, so not truly free
    expect(pricing.isFree).toBe(false);
    expect(pricing.creditsPerKbInput).toBe(2);
  });

  it('should include isFree in tools/list injection', () => {
    const config = {
      ...DEFAULT_CONFIG,
      toolPricing: {
        free_tool: { creditsPerCall: 0 },
      },
    };
    const registry = new ToolRegistry(config, false);

    const tools = [
      { name: 'free_tool', description: 'A free tool' },
      { name: 'paid_tool', description: 'A paid tool' },
    ];

    const enriched = registry.injectPricingIntoToolsList(tools);
    expect(enriched[0]._pricing.isFree).toBe(true);
    expect(enriched[1]._pricing.isFree).toBe(false);
  });
});

// ─── Unit Tests: freeToolCount + x402Compatible ────────────────────────────

describe('ToolRegistry server metadata', () => {
  it('should include freeToolCount in server metadata', () => {
    const config = {
      ...DEFAULT_CONFIG,
      toolPricing: {
        free_1: { creditsPerCall: 0 },
        free_2: { creditsPerCall: 0 },
        paid_1: { creditsPerCall: 5 },
      },
    };
    const registry = new ToolRegistry(config, false);
    registry.setDiscoveredTools(['free_1', 'free_2', 'paid_1', 'unknown_tool']);

    const meta = registry.getServerMetadata();
    expect(meta.freeToolCount).toBe(2);
    expect(meta.toolCount).toBe(4);
  });

  it('should include x402Compatible flag', () => {
    const registry = new ToolRegistry(DEFAULT_CONFIG, false);
    const meta = registry.getServerMetadata();
    expect(meta.x402Compatible).toBe(true);
  });

  it('freeToolCount should be 0 when no free tools', () => {
    const registry = new ToolRegistry(DEFAULT_CONFIG, false);
    registry.setDiscoveredTools(['tool_a', 'tool_b']);
    const meta = registry.getServerMetadata();
    expect(meta.freeToolCount).toBe(0);
  });
});

// ─── Unit Tests: x402 in buildPaymentRequired ─────────────────────────────

describe('ToolRegistry x402 payment recovery data', () => {
  it('should include x402 block in payment required data', () => {
    const registry = new ToolRegistry(DEFAULT_CONFIG, false);
    const data = registry.buildPaymentRequired('expensive_tool', 10, 3);

    expect(data.x402).toBeDefined();
    const x402 = data.x402 as Record<string, unknown>;
    expect(x402.version).toBe('1');
    expect(x402.scheme).toBe('credits');
    expect(x402.creditsRequired).toBe(10);
    expect(x402.creditsAvailable).toBe(3);
    expect(x402.topUpUrl).toBe('/topup');
    expect(x402.pricingUrl).toBe('/pricing');
    expect(x402.accepts).toContain('X-API-Key');
    expect(x402.accepts).toContain('Bearer');
  });
});

// ─── Unit Tests: MCP Tasks free methods ────────────────────────────────────

describe('MCP Tasks billing awareness', () => {
  it('default freeMethods should include tasks/list, tasks/get, tasks/cancel', () => {
    expect(DEFAULT_CONFIG.freeMethods).toContain('tasks/list');
    expect(DEFAULT_CONFIG.freeMethods).toContain('tasks/get');
    expect(DEFAULT_CONFIG.freeMethods).toContain('tasks/cancel');
  });

  it('default freeMethods should include elicitation/create', () => {
    expect(DEFAULT_CONFIG.freeMethods).toContain('elicitation/create');
  });

  it('default freeMethods should still include classic methods', () => {
    expect(DEFAULT_CONFIG.freeMethods).toContain('initialize');
    expect(DEFAULT_CONFIG.freeMethods).toContain('tools/list');
    expect(DEFAULT_CONFIG.freeMethods).toContain('ping');
  });
});

// ─── E2E Tests ─────────────────────────────────────────────────────────────

describe('Free tool & x402 E2E', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'node',
      serverArgs: [MOCK_SERVER],
      port: 0,
      defaultCreditsPerCall: 2,
      toolPricing: {
        free_search: { creditsPerCall: 0 },
        paid_search: { creditsPerCall: 10 },
      },
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('/.well-known/mcp-payment should include freeToolCount and x402Compatible', async () => {
    server.registry.setDiscoveredTools(['free_search', 'paid_search', 'basic_tool']);

    const res = await httpRequest(port, '/.well-known/mcp-payment');
    expect(res.status).toBe(200);
    expect(res.body.freeToolCount).toBe(1);
    expect(res.body.x402Compatible).toBe(true);
    expect(res.body.toolCount).toBe(3);
  });

  it('/pricing tools should include isFree flag', async () => {
    server.registry.setDiscoveredTools(['free_search', 'paid_search']);

    const res = await httpRequest(port, '/pricing');
    expect(res.status).toBe(200);

    const freeTool = res.body.tools.find((t: any) => t.name === 'free_search');
    expect(freeTool.isFree).toBe(true);
    expect(freeTool.creditsPerCall).toBe(0);

    const paidTool = res.body.tools.find((t: any) => t.name === 'paid_search');
    expect(paidTool.isFree).toBe(false);
    expect(paidTool.creditsPerCall).toBe(10);
  });

  it('-32402 error should include x402 recovery data', async () => {
    // Create a key with 1 credit (will be insufficient for paid tool at 2 credits)
    const keyRes = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'Low Credit Key', credits: 1 },
    });
    expect(keyRes.status).toBe(201);
    const apiKey = keyRes.body.key;
    expect(apiKey).toBeDefined();

    // Try to call a paid tool — should get -32402
    const callRes = await httpRequest(port, '/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'paid_tool', arguments: {} },
      },
    });

    expect(callRes.status).toBe(200);
    expect(callRes.body.error).toBeDefined();
    expect(callRes.body.error.code).toBe(-32402);
    expect(callRes.body.error.data).toBeDefined();
    expect(callRes.body.error.data.x402).toBeDefined();
    expect(callRes.body.error.data.x402.version).toBe('1');
    expect(callRes.body.error.data.x402.scheme).toBe('credits');
    expect(callRes.body.error.data.x402.topUpUrl).toBe('/topup');
    expect(callRes.body.error.data.x402.pricingUrl).toBe('/pricing');
  });
});

// ─── billTaskCreation Tests ─────────────────────────────────────────────────

describe('billTaskCreation config', () => {
  it('tasks/send should be free by default (billTaskCreation = false)', async () => {
    const server = new PayGateServer({
      serverCommand: 'node',
      serverArgs: [MOCK_SERVER],
      port: 0,
      defaultCreditsPerCall: 1,
    });
    const info = await server.start();

    // Check via /mcp — tasks/send should pass without auth
    const res = await httpRequest(info.port, '/mcp', {
      method: 'POST',
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: { taskId: 'test-task', message: {} },
      },
    });

    // Should NOT get auth error — the method is free
    // (may get other errors since mock server doesn't support tasks, but not -32402)
    if (res.body.error) {
      expect(res.body.error.code).not.toBe(-32402);
    }

    await server.stop();
  });
});
