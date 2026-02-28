/**
 * Tests for OpenAPI-to-MCP transformation.
 */

import { describe, it, expect } from '@jest/globals';
import { parseOpenApiSpec, resolveBaseUrl, createApiProxyHandler, summarizeSpec, McpToolDef, OpenApiSpec } from '../src/openapi-to-mcp';

// ─── Test Fixtures ────────────────────────────────────────────────────────────

const BASIC_SPEC = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Test API', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com' }],
  paths: {
    '/users': {
      get: {
        operationId: 'listUsers',
        summary: 'List all users',
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer' }, description: 'Max results' },
        ],
      },
      post: {
        operationId: 'createUser',
        summary: 'Create a new user',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  email: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        summary: 'Get user by ID',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
      },
      delete: {
        operationId: 'deleteUser',
        summary: 'Delete a user',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
      },
    },
  },
});

const TAGGED_SPEC = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Tagged API', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com' }],
  paths: {
    '/users': {
      get: { operationId: 'listUsers', summary: 'List users', tags: ['users'] },
    },
    '/posts': {
      get: { operationId: 'listPosts', summary: 'List posts', tags: ['posts'] },
    },
    '/admin/stats': {
      get: { operationId: 'getStats', summary: 'Admin stats', tags: ['admin'] },
    },
  },
});

const DEPRECATED_SPEC = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'API', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com' }],
  paths: {
    '/v1/legacy': {
      get: { operationId: 'legacyEndpoint', summary: 'Legacy', deprecated: true },
    },
    '/v2/current': {
      get: { operationId: 'currentEndpoint', summary: 'Current' },
    },
  },
});

const NO_OPERATION_ID_SPEC = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'API', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com' }],
  paths: {
    '/api/v1/items': {
      get: { summary: 'Get items' },
      post: { summary: 'Create item' },
    },
  },
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('parseOpenApiSpec', () => {
  it('parses basic spec into MCP tool definitions', () => {
    const tools = parseOpenApiSpec(BASIC_SPEC);
    expect(tools).toHaveLength(4);
    const names = tools.map(t => t.name);
    expect(names).toContain('listUsers');
    expect(names).toContain('createUser');
    expect(names).toContain('getUser');
    expect(names).toContain('deleteUser');
  });

  it('generates input schemas from parameters', () => {
    const tools = parseOpenApiSpec(BASIC_SPEC);
    const listUsers = tools.find(t => t.name === 'listUsers')!;
    expect(listUsers.inputSchema.type).toBe('object');
    expect(listUsers.inputSchema.properties).toHaveProperty('limit');
    // limit is not required
    expect(listUsers.inputSchema.required).not.toContain('limit');
  });

  it('includes path params as required', () => {
    const tools = parseOpenApiSpec(BASIC_SPEC);
    const getUser = tools.find(t => t.name === 'getUser')!;
    expect(getUser.inputSchema.required).toContain('id');
    expect(getUser.inputSchema.properties).toHaveProperty('id');
  });

  it('includes request body as body parameter', () => {
    const tools = parseOpenApiSpec(BASIC_SPEC);
    const createUser = tools.find(t => t.name === 'createUser')!;
    expect(createUser.inputSchema.properties).toHaveProperty('body');
    expect(createUser.inputSchema.required).toContain('body');
  });

  it('preserves HTTP method and path', () => {
    const tools = parseOpenApiSpec(BASIC_SPEC);
    const getUser = tools.find(t => t.name === 'getUser')!;
    expect(getUser._httpMethod).toBe('GET');
    expect(getUser._httpPath).toBe('/users/{id}');
  });

  it('uses summary as description', () => {
    const tools = parseOpenApiSpec(BASIC_SPEC);
    const listUsers = tools.find(t => t.name === 'listUsers')!;
    expect(listUsers.description).toBe('List all users');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseOpenApiSpec('not json')).toThrow('invalid JSON');
  });

  it('throws when no paths defined', () => {
    expect(() => parseOpenApiSpec(JSON.stringify({ openapi: '3.0.0', info: {} }))).toThrow('no paths');
  });

  // ─── Config options ───────────────────────────────────────────────────

  it('applies toolPrefix', () => {
    const tools = parseOpenApiSpec(BASIC_SPEC, { toolPrefix: 'api' });
    expect(tools[0].name.startsWith('api_')).toBe(true);
  });

  it('filters by tags', () => {
    const tools = parseOpenApiSpec(TAGGED_SPEC, { filterTags: ['users'] });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('listUsers');
  });

  it('filters out deprecated by default', () => {
    const tools = parseOpenApiSpec(DEPRECATED_SPEC);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('currentEndpoint');
  });

  it('includes deprecated when configured', () => {
    const tools = parseOpenApiSpec(DEPRECATED_SPEC, { includeDeprecated: true });
    expect(tools).toHaveLength(2);
    const legacy = tools.find(t => t.name === 'legacyEndpoint')!;
    expect(legacy._deprecated).toBe(true);
  });

  it('generates names from method + path when no operationId', () => {
    const tools = parseOpenApiSpec(NO_OPERATION_ID_SPEC);
    expect(tools).toHaveLength(2);
    // Should slugify the path
    const names = tools.map(t => t.name);
    expect(names.some(n => n.includes('get'))).toBe(true);
    expect(names.some(n => n.includes('post'))).toBe(true);
  });

  it('deduplicates tool names', () => {
    const dupeSpec = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'API', version: '1.0.0' },
      paths: {
        '/a': { get: { operationId: 'doThing', summary: 'First' } },
        '/b': { get: { operationId: 'doThing', summary: 'Second' } },
      },
    });
    const tools = parseOpenApiSpec(dupeSpec);
    const names = tools.map(t => t.name);
    expect(new Set(names).size).toBe(names.length); // All unique
  });
});

describe('resolveBaseUrl', () => {
  it('uses config baseUrl when provided', () => {
    const spec: OpenApiSpec = { servers: [{ url: 'https://fallback.com' }] };
    const url = resolveBaseUrl(spec, { baseUrl: 'https://override.com/' });
    expect(url).toBe('https://override.com');
  });

  it('uses spec servers[0] as fallback', () => {
    const spec: OpenApiSpec = { servers: [{ url: 'https://api.example.com/' }] };
    const url = resolveBaseUrl(spec);
    expect(url).toBe('https://api.example.com');
  });

  it('throws when no base URL available', () => {
    expect(() => resolveBaseUrl({})).toThrow('No base URL');
  });

  it('strips trailing slash', () => {
    const spec: OpenApiSpec = { servers: [{ url: 'https://api.example.com/' }] };
    const url = resolveBaseUrl(spec);
    expect(url).not.toMatch(/\/$/);
  });
});

describe('summarizeSpec', () => {
  it('returns tool counts by method and tag', () => {
    const tools = parseOpenApiSpec(BASIC_SPEC);
    const summary = summarizeSpec(tools);
    expect(summary.totalTools).toBe(4);
    expect(summary.byMethod.GET).toBe(2);
    expect(summary.byMethod.POST).toBe(1);
    expect(summary.byMethod.DELETE).toBe(1);
  });

  it('handles tools with tags', () => {
    const tools = parseOpenApiSpec(TAGGED_SPEC);
    const summary = summarizeSpec(tools);
    expect(summary.byTag.users).toBe(1);
    expect(summary.byTag.posts).toBe(1);
    expect(summary.byTag.admin).toBe(1);
  });

  it('returns empty counts for empty tools array', () => {
    const summary = summarizeSpec([]);
    expect(summary.totalTools).toBe(0);
  });
});

describe('createApiProxyHandler', () => {
  it('returns error for unknown tool', async () => {
    const tools = parseOpenApiSpec(BASIC_SPEC);
    const handler = createApiProxyHandler(tools, 'https://api.example.com');
    const result = await handler('nonExistentTool', {});
    expect(result.content[0].text).toContain('Unknown tool');
  });

  // Note: We can't easily test successful HTTP calls without a mock server,
  // but we verify the handler function signature and error handling.
  it('creates a callable function', () => {
    const tools = parseOpenApiSpec(BASIC_SPEC);
    const handler = createApiProxyHandler(tools, 'https://api.example.com');
    expect(typeof handler).toBe('function');
  });
});
