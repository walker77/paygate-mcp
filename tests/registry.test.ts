/**
 * Tool Registry & Pricing Discovery Tests.
 *
 * Tests:
 *   - ToolRegistry unit tests (metadata, pricing, tools/list injection)
 *   - E2E: GET /.well-known/mcp-payment returns payment metadata
 *   - E2E: GET /pricing returns full pricing breakdown
 *   - E2E: tools/list includes _pricing on each tool
 *   - E2E: /pricing reflects per-tool overrides
 */

import * as http from 'http';
import { ToolRegistry } from '../src/registry';
import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function httpRequest(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: options.port,
      method: options.method,
      path: options.path,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body,
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ─── Unit Tests: ToolRegistry ───────────────────────────────────────────────

describe('ToolRegistry', () => {
  it('should return server metadata', () => {
    const registry = new ToolRegistry({ ...DEFAULT_CONFIG, name: 'TestServer' }, false);
    const meta = registry.getServerMetadata();

    expect(meta.serverName).toBe('TestServer');
    expect(meta.billingModel).toBe('credits');
    expect(meta.specVersion).toBe('2007-draft');
    expect(meta.defaultCreditsPerCall).toBe(1);
    expect(meta.paymentErrorCode).toBe(-32402);
    expect(meta.pricingEndpoint).toBe('/pricing');
    expect(meta.authMethods).toContain('X-API-Key');
    expect(meta.oauthSupported).toBe(false);
  });

  it('should include OAuth in auth methods when enabled', () => {
    const registry = new ToolRegistry({ ...DEFAULT_CONFIG }, true);
    const meta = registry.getServerMetadata();
    expect(meta.authMethods).toContain('Bearer (OAuth 2.1)');
    expect(meta.oauthSupported).toBe(true);
  });

  it('should return default pricing for unknown tools', () => {
    const registry = new ToolRegistry({ ...DEFAULT_CONFIG, defaultCreditsPerCall: 5 }, false);
    const pricing = registry.getToolPricing('some_tool');

    expect(pricing.name).toBe('some_tool');
    expect(pricing.creditsPerCall).toBe(5);
    expect(pricing.creditsPerKbInput).toBe(0);
    expect(pricing.pricingModel).toBe('flat');
  });

  it('should return per-tool pricing overrides', () => {
    const config = {
      ...DEFAULT_CONFIG,
      toolPricing: {
        expensive_tool: { creditsPerCall: 10, rateLimitPerMin: 5, creditsPerKbInput: 2 },
      },
    };
    const registry = new ToolRegistry(config, false);
    const pricing = registry.getToolPricing('expensive_tool');

    expect(pricing.creditsPerCall).toBe(10);
    expect(pricing.creditsPerKbInput).toBe(2);
    expect(pricing.rateLimitPerMin).toBe(5);
    expect(pricing.pricingModel).toBe('dynamic');
  });

  it('should inject pricing into tools/list result', () => {
    const config = {
      ...DEFAULT_CONFIG,
      defaultCreditsPerCall: 3,
      toolPricing: {
        tool_b: { creditsPerCall: 7 },
      },
    };
    const registry = new ToolRegistry(config, false);

    const tools = [
      { name: 'tool_a', description: 'Tool A' },
      { name: 'tool_b', description: 'Tool B' },
    ];

    const enriched = registry.injectPricingIntoToolsList(tools);

    expect(enriched[0]._pricing.creditsPerCall).toBe(3);
    expect(enriched[0]._pricing.pricingModel).toBe('flat');
    expect(enriched[1]._pricing.creditsPerCall).toBe(7);
  });

  it('should update discovered tools after injection', () => {
    const registry = new ToolRegistry(DEFAULT_CONFIG, false);
    expect(registry.getServerMetadata().toolCount).toBe(0);

    registry.injectPricingIntoToolsList([
      { name: 'tool_1' },
      { name: 'tool_2' },
      { name: 'tool_3' },
    ]);

    expect(registry.getServerMetadata().toolCount).toBe(3);
  });

  it('should return full pricing with server + tools', () => {
    const registry = new ToolRegistry(DEFAULT_CONFIG, false);
    registry.setDiscoveredTools(['tool_a', 'tool_b']);

    const pricing = registry.getFullPricing();
    expect(pricing.server.billingModel).toBe('credits');
    expect(pricing.tools.length).toBe(2);
    expect(pricing.tools[0].name).toBe('tool_a');
    expect(pricing.tools[1].name).toBe('tool_b');
  });

  it('should build payment required data', () => {
    const registry = new ToolRegistry(DEFAULT_CONFIG, false);
    const data = registry.buildPaymentRequired('expensive_tool', 10, 3);

    expect(data.tool).toBe('expensive_tool');
    expect(data.creditsNeeded).toBe(10);
    expect(data.creditsAvailable).toBe(3);
    expect(data.topUpEndpoint).toBe('/topup');
    expect(data.pricingEndpoint).toBe('/pricing');
  });
});

// ─── E2E Tests: Registry API Endpoints ──────────────────────────────────────

describe('Registry/Discovery E2E', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: [],
      port: 0,
      defaultCreditsPerCall: 2,
      toolPricing: {
        search: { creditsPerCall: 5, rateLimitPerMin: 10, creditsPerKbInput: 1 },
      },
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('GET /.well-known/mcp-payment returns payment metadata', async () => {
    const res = await httpRequest({ port, method: 'GET', path: '/.well-known/mcp-payment' });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);

    expect(data.specVersion).toBe('2007-draft');
    expect(data.billingModel).toBe('credits');
    expect(data.defaultCreditsPerCall).toBe(2);
    expect(data.paymentErrorCode).toBe(-32402);
    expect(data.pricingEndpoint).toBe('/pricing');
    expect(data.authMethods).toContain('X-API-Key');
  });

  it('GET /.well-known/mcp-payment is publicly accessible (no auth)', async () => {
    const res = await httpRequest({ port, method: 'GET', path: '/.well-known/mcp-payment' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /pricing returns full pricing breakdown', async () => {
    const res = await httpRequest({ port, method: 'GET', path: '/pricing' });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);

    expect(data.server).toBeDefined();
    expect(data.server.billingModel).toBe('credits');
    expect(data.tools).toBeDefined();
    expect(Array.isArray(data.tools)).toBe(true);
  });

  it('GET /pricing is publicly accessible (no auth)', async () => {
    const res = await httpRequest({ port, method: 'GET', path: '/pricing' });
    expect(res.statusCode).toBe(200);
  });

  it('/pricing shows per-tool overrides when tools are discovered', async () => {
    // Manually register discovered tools on the registry
    server.registry.setDiscoveredTools(['search', 'basic_tool']);

    const res = await httpRequest({ port, method: 'GET', path: '/pricing' });
    const data = JSON.parse(res.body);

    // Should have our two tools
    expect(data.tools.length).toBe(2);

    const searchTool = data.tools.find((t: any) => t.name === 'search');
    expect(searchTool.creditsPerCall).toBe(5);
    expect(searchTool.creditsPerKbInput).toBe(1);
    expect(searchTool.rateLimitPerMin).toBe(10);
    expect(searchTool.pricingModel).toBe('dynamic');

    const basicTool = data.tools.find((t: any) => t.name === 'basic_tool');
    expect(basicTool.creditsPerCall).toBe(2); // default
    expect(basicTool.pricingModel).toBe('flat');
  });

  it('root endpoint lists pricing and payment metadata', async () => {
    const res = await httpRequest({ port, method: 'GET', path: '/' });
    const data = JSON.parse(res.body);
    expect(data.endpoints.pricing).toBeDefined();
    expect(data.endpoints.mcpPayment).toBeDefined();
  });

  it('tools/list pricing injection works via injectPricingIntoToolsList', () => {
    // The echo backend isn't a real MCP server, so we test injection
    // directly on the registry instance (same code path as handleMcp).
    const tools = [
      { name: 'search', description: 'Search the web' },
      { name: 'basic_tool', description: 'A basic tool' },
    ];

    const enriched = server.registry.injectPricingIntoToolsList(tools);

    // 'search' has per-tool override (5 credits)
    expect(enriched[0]._pricing).toBeDefined();
    expect(enriched[0]._pricing.creditsPerCall).toBe(5);
    expect(enriched[0]._pricing.pricingModel).toBe('dynamic');
    expect(enriched[0]._pricing.creditsPerKbInput).toBe(1);

    // 'basic_tool' uses default (2 credits)
    expect(enriched[1]._pricing).toBeDefined();
    expect(enriched[1]._pricing.creditsPerCall).toBe(2);
    expect(enriched[1]._pricing.pricingModel).toBe('flat');
  });
});
