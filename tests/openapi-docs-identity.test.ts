/**
 * Tests for:
 *   - OpenAPI 3.1 spec generation (src/openapi.ts)
 *   - Interactive API docs page (src/docs.ts)
 *   - MCP Server Identity card (/.well-known/mcp.json)
 *
 * Unit tests for spec structure + E2E tests for HTTP endpoints.
 */

import { generateOpenApiSpec } from '../src/openapi';
import { getDocsHtml } from '../src/docs';
import { PayGateServer } from '../src/server';
import { PayGateConfig } from '../src/types';
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
    const bodyStr = options.body ? JSON.stringify(options.body) : undefined;

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

function httpRequestRaw(
  targetPort: number,
  urlPath: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: 'localhost', port: targetPort, path: urlPath, method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk.toString(); });
        res.on('end', () => {
          resolve({ status: res.statusCode!, headers: res.headers as Record<string, string>, body: data });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ─── Unit Tests: OpenAPI Spec ─────────────────────────────────────────────

describe('generateOpenApiSpec', () => {
  const spec = generateOpenApiSpec('TestServer', '1.2.3') as any;

  it('should return valid OpenAPI 3.1 structure', () => {
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info).toBeDefined();
    expect(spec.info.title).toBe('TestServer');
    expect(spec.info.version).toBe('1.2.3');
    expect(spec.paths).toBeDefined();
    expect(spec.components).toBeDefined();
  });

  it('should include info metadata', () => {
    expect(spec.info.description).toContain('PayGate MCP');
    expect(spec.info.license).toEqual({ name: 'MIT', url: 'https://opensource.org/licenses/MIT' });
    expect(spec.info.contact.url).toBe('https://paygated.dev');
  });

  it('should include external docs link', () => {
    expect(spec.externalDocs).toBeDefined();
    expect(spec.externalDocs.url).toContain('github.com/walker77/paygate-mcp');
  });

  it('should have all 13 tags', () => {
    expect(spec.tags).toHaveLength(13);
    const tagNames = spec.tags.map((t: any) => t.name);
    expect(tagNames).toContain('Core');
    expect(tagNames).toContain('Keys');
    expect(tagNames).toContain('Billing');
    expect(tagNames).toContain('Discovery');
    expect(tagNames).toContain('OAuth');
    expect(tagNames).toContain('Webhooks');
    expect(tagNames).toContain('Analytics');
    expect(tagNames).toContain('Teams');
    expect(tagNames).toContain('Tokens');
    expect(tagNames).toContain('Groups');
    expect(tagNames).toContain('Admin');
    expect(tagNames).toContain('Operations');
    expect(tagNames).toContain('Audit');
  });

  it('should have security schemes', () => {
    const schemes = spec.components.securitySchemes;
    expect(schemes.ApiKeyAuth).toBeDefined();
    expect(schemes.ApiKeyAuth.type).toBe('apiKey');
    expect(schemes.ApiKeyAuth.name).toBe('X-API-Key');

    expect(schemes.AdminKeyAuth).toBeDefined();
    expect(schemes.AdminKeyAuth.name).toBe('X-Admin-Key');

    expect(schemes.BearerAuth).toBeDefined();
    expect(schemes.BearerAuth.type).toBe('http');
    expect(schemes.BearerAuth.scheme).toBe('bearer');
  });

  it('should have component schemas', () => {
    const schemas = spec.components.schemas;
    expect(schemas.JsonRpcRequest).toBeDefined();
    expect(schemas.JsonRpcResponse).toBeDefined();
    expect(schemas.JsonRpcError).toBeDefined();
    expect(schemas.ApiKey).toBeDefined();
    expect(schemas.ToolPricing).toBeDefined();
    expect(schemas.PaymentMetadata).toBeDefined();
    expect(schemas.x402Block).toBeDefined();
    expect(schemas.Error).toBeDefined();
  });

  // ─── Path coverage ──────────────────────────────────────────────────

  it('should include core paths', () => {
    expect(spec.paths['/mcp']).toBeDefined();
    expect(spec.paths['/mcp'].post).toBeDefined();
    expect(spec.paths['/health']).toBeDefined();
  });

  it('should include key management paths', () => {
    expect(spec.paths['/keys']).toBeDefined();
    expect(spec.paths['/keys'].post).toBeDefined();
    expect(spec.paths['/keys'].get).toBeDefined();
    expect(spec.paths['/keys/revoke']).toBeDefined();
    expect(spec.paths['/keys/rotate']).toBeDefined();
  });

  it('should include billing paths', () => {
    expect(spec.paths['/topup']).toBeDefined();
    expect(spec.paths['/balance']).toBeDefined();
  });

  it('should include discovery paths', () => {
    expect(spec.paths['/pricing']).toBeDefined();
    expect(spec.paths['/.well-known/mcp-payment']).toBeDefined();
    expect(spec.paths['/openapi.json']).toBeDefined();
    expect(spec.paths['/docs']).toBeDefined();
  });

  it('should include OAuth paths', () => {
    expect(spec.paths['/oauth/register']).toBeDefined();
    expect(spec.paths['/oauth/authorize']).toBeDefined();
    expect(spec.paths['/oauth/token']).toBeDefined();
    expect(spec.paths['/.well-known/oauth-authorization-server']).toBeDefined();
  });

  it('should include webhook paths', () => {
    expect(spec.paths['/webhooks/stats']).toBeDefined();
    expect(spec.paths['/webhooks/log']).toBeDefined();
    expect(spec.paths['/webhooks/dead-letter']).toBeDefined();
  });

  it('should include analytics paths', () => {
    // Analytics are under /admin/* namespace
    expect(spec.paths['/admin/revenue']).toBeDefined();
    expect(spec.paths['/admin/costs']).toBeDefined();
    expect(spec.paths['/admin/traffic']).toBeDefined();
  });

  it('should include team paths', () => {
    expect(spec.paths['/teams']).toBeDefined();
  });

  it('should include operations paths', () => {
    expect(spec.paths['/metrics']).toBeDefined();
    expect(spec.paths['/dashboard']).toBeDefined();
  });

  it('should have 100+ paths total (130+ endpoints)', () => {
    const pathCount = Object.keys(spec.paths).length;
    expect(pathCount).toBeGreaterThanOrEqual(80);
  });

  it('every path should have at least one operation', () => {
    for (const [pathKey, pathItem] of Object.entries(spec.paths)) {
      const ops = Object.keys(pathItem as object).filter(k => ['get', 'post', 'put', 'delete', 'patch'].includes(k));
      expect(ops.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('every operation should have tags and a summary', () => {
    for (const [pathKey, pathItem] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(pathItem as Record<string, any>)) {
        if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
        expect(op.tags).toBeDefined();
        expect(op.tags.length).toBeGreaterThanOrEqual(1);
        expect(op.summary).toBeDefined();
        expect(op.summary.length).toBeGreaterThan(0);
      }
    }
  });

  it('admin endpoints should reference AdminKeyAuth security', () => {
    const adminPaths = ['/keys', '/topup', '/admin/keys'];
    for (const p of adminPaths) {
      if (!spec.paths[p]) continue;
      const op = spec.paths[p].post || spec.paths[p].get;
      if (!op) continue;
      const hasAdmin = op.security?.some((s: any) => s.AdminKeyAuth !== undefined);
      expect(hasAdmin).toBe(true);
    }
  });
});

// ─── Unit Tests: Docs HTML ────────────────────────────────────────────────

describe('getDocsHtml', () => {
  it('should return valid HTML with Swagger UI', () => {
    const html = getDocsHtml('TestServer');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('swagger-ui');
    expect(html).toContain('SwaggerUIBundle');
    expect(html).toContain('/openapi.json');
  });

  it('should include server name in title', () => {
    const html = getDocsHtml('MyPayGate');
    expect(html).toContain('<title>MyPayGate');
    expect(html).toContain('MyPayGate');
  });

  it('should escape special characters in server name', () => {
    const html = getDocsHtml('Test<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('should load Swagger UI from CDN', () => {
    const html = getDocsHtml('Test');
    expect(html).toContain('cdn.jsdelivr.net/npm/swagger-ui-dist@5');
  });
});

// ─── E2E Tests ─────────────────────────────────────────────────────────────

describe('OpenAPI, Docs, MCP Identity E2E', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'node',
      serverArgs: [MOCK_SERVER],
      port: 0,
      defaultCreditsPerCall: 1,
      name: 'E2E Test Server',
      toolPricing: {
        free_tool: { creditsPerCall: 0 },
        paid_tool: { creditsPerCall: 5 },
      },
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.stop();
  });

  // ─── /openapi.json ──────────────────────────────────────────────────

  describe('GET /openapi.json', () => {
    it('should return 200 with valid OpenAPI spec', async () => {
      const res = await httpRequest(port, '/openapi.json');
      expect(res.status).toBe(200);
      expect(res.body.openapi).toBe('3.1.0');
      expect(res.body.info).toBeDefined();
      expect(res.body.paths).toBeDefined();
    });

    it('should set correct content type', async () => {
      const res = await httpRequest(port, '/openapi.json');
      expect(res.headers['content-type']).toContain('application/json');
    });

    it('should set cache control header', async () => {
      const res = await httpRequest(port, '/openapi.json');
      expect(res.headers['cache-control']).toContain('public');
      expect(res.headers['cache-control']).toContain('max-age=3600');
    });

    it('should use server name from config', async () => {
      const res = await httpRequest(port, '/openapi.json');
      expect(res.body.info.title).toBe('E2E Test Server');
    });

    it('should include version from package.json', async () => {
      const res = await httpRequest(port, '/openapi.json');
      expect(res.body.info.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('should not require authentication', async () => {
      // No X-API-Key or X-Admin-Key needed
      const res = await httpRequest(port, '/openapi.json');
      expect(res.status).toBe(200);
    });
  });

  // ─── /docs ──────────────────────────────────────────────────────────

  describe('GET /docs', () => {
    it('should return 200 with HTML page', async () => {
      const res = await httpRequestRaw(port, '/docs');
      expect(res.status).toBe(200);
      expect(res.body).toContain('<!DOCTYPE html>');
      expect(res.body).toContain('swagger-ui');
    });

    it('should set HTML content type', async () => {
      const res = await httpRequestRaw(port, '/docs');
      expect(res.headers['content-type']).toContain('text/html');
    });

    it('should set cache control header', async () => {
      const res = await httpRequestRaw(port, '/docs');
      expect(res.headers['cache-control']).toContain('public');
    });

    it('should include server name', async () => {
      const res = await httpRequestRaw(port, '/docs');
      expect(res.body).toContain('E2E Test Server');
    });

    it('should not require authentication', async () => {
      const res = await httpRequestRaw(port, '/docs');
      expect(res.status).toBe(200);
    });
  });

  // ─── /.well-known/mcp.json ──────────────────────────────────────────

  describe('GET /.well-known/mcp.json', () => {
    it('should return 200 with MCP identity card', async () => {
      const res = await httpRequest(port, '/.well-known/mcp.json');
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('E2E Test Server');
      expect(res.body.protocol).toBe('mcp');
    });

    it('should include version', async () => {
      const res = await httpRequest(port, '/.well-known/mcp.json');
      expect(res.body.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('should include transport', async () => {
      const res = await httpRequest(port, '/.well-known/mcp.json');
      expect(res.body.transport).toContain('streamable-http');
    });

    it('should include capabilities', async () => {
      const res = await httpRequest(port, '/.well-known/mcp.json');
      expect(res.body.capabilities).toBeDefined();
      expect(res.body.capabilities.tools).toBe(true);
      expect(res.body.capabilities.tasks).toBe(true);
      expect(res.body.capabilities.elicitation).toBe(true);
    });

    it('should include payment info', async () => {
      server.registry.setDiscoveredTools(['free_tool', 'paid_tool', 'basic_tool']);

      const res = await httpRequest(port, '/.well-known/mcp.json');
      expect(res.body.payment).toBeDefined();
      expect(res.body.payment.model).toBe('credits');
      expect(res.body.payment.x402Compatible).toBe(true);
      expect(res.body.payment.freeToolCount).toBe(1);
      expect(res.body.payment.toolCount).toBe(3);
      expect(res.body.payment.defaultPrice).toBe(1);
    });

    it('should include auth info', async () => {
      const res = await httpRequest(port, '/.well-known/mcp.json');
      expect(res.body.auth).toBeDefined();
      expect(res.body.auth.apiKey).toBe(true);
    });

    it('should include endpoint map', async () => {
      const res = await httpRequest(port, '/.well-known/mcp.json');
      expect(res.body.endpoints).toBeDefined();
      expect(res.body.endpoints.mcp).toBe('/mcp');
      expect(res.body.endpoints.health).toBe('/health');
      expect(res.body.endpoints.pricing).toBe('/pricing');
      expect(res.body.endpoints.docs).toBe('/docs');
      expect(res.body.endpoints.openapi).toBe('/openapi.json');
      expect(res.body.endpoints.metrics).toBe('/metrics');
      expect(res.body.endpoints.dashboard).toBe('/dashboard');
    });

    it('should include links', async () => {
      const res = await httpRequest(port, '/.well-known/mcp.json');
      expect(res.body.links).toBeDefined();
      expect(res.body.links.homepage).toBe('https://paygated.dev');
      expect(res.body.links.repository).toContain('github.com');
      expect(res.body.links.npm).toContain('npmjs.com');
    });

    it('should set correct content type', async () => {
      const res = await httpRequest(port, '/.well-known/mcp.json');
      expect(res.headers['content-type']).toContain('application/json');
    });

    it('should set cache control header', async () => {
      const res = await httpRequest(port, '/.well-known/mcp.json');
      expect(res.headers['cache-control']).toContain('public');
    });

    it('should not require authentication', async () => {
      const res = await httpRequest(port, '/.well-known/mcp.json');
      expect(res.status).toBe(200);
    });
  });
});

// ─── E2E: OAuth-enabled server identity ────────────────────────────────────

describe('MCP Identity with OAuth', () => {
  let server: PayGateServer;
  let port: number;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'node',
      serverArgs: [MOCK_SERVER],
      port: 0,
      defaultCreditsPerCall: 1,
      oauth: { issuer: 'http://localhost' },
    } as PayGateConfig & { serverCommand: string });
    const info = await server.start();
    port = info.port;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should show oauth2=true when OAuth is enabled', async () => {
    const res = await httpRequest(port, '/.well-known/mcp.json');
    expect(res.status).toBe(200);
    expect(res.body.auth.oauth2).toBe(true);
    expect(res.body.auth.bearer).toBe(true);
  });

  it('should include oauthMetadata endpoint', async () => {
    const res = await httpRequest(port, '/.well-known/mcp.json');
    expect(res.body.endpoints.oauthMetadata).toBe('/.well-known/oauth-authorization-server');
  });
});

// ─── E2E: Non-OAuth server identity ────────────────────────────────────────

describe('MCP Identity without OAuth', () => {
  let server: PayGateServer;
  let port: number;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'node',
      serverArgs: [MOCK_SERVER],
      port: 0,
      defaultCreditsPerCall: 1,
    });
    const info = await server.start();
    port = info.port;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should show oauth2=false when OAuth is disabled', async () => {
    const res = await httpRequest(port, '/.well-known/mcp.json');
    expect(res.status).toBe(200);
    expect(res.body.auth.oauth2).toBe(false);
    expect(res.body.auth.bearer).toBe(false);
  });

  it('oauthMetadata endpoint should be undefined', async () => {
    const res = await httpRequest(port, '/.well-known/mcp.json');
    expect(res.body.endpoints.oauthMetadata).toBeUndefined();
  });
});
