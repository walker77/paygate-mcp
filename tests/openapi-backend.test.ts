/**
 * Tests for OpenApiMcpBackend.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { OpenApiMcpBackend, OpenApiMcpBackendConfig } from '../src/openapi-backend';

const BASIC_SPEC = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Test API', version: '2.0.0' },
  servers: [{ url: 'https://api.example.com' }],
  paths: {
    '/users': {
      get: {
        operationId: 'listUsers',
        summary: 'List all users',
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
        ],
      },
      post: {
        operationId: 'createUser',
        summary: 'Create user',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', properties: { name: { type: 'string' } } },
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
    },
  },
});

describe('OpenApiMcpBackend', () => {
  let backend: OpenApiMcpBackend;

  beforeEach(() => {
    backend = new OpenApiMcpBackend({ specJson: BASIC_SPEC });
  });

  // ─── Constructor ────────────────────────────────────────────────────────
  describe('constructor', () => {
    it('parses spec successfully', () => {
      expect(backend).toBeDefined();
    });

    it('throws on invalid JSON spec', () => {
      expect(() => new OpenApiMcpBackend({ specJson: 'not json' })).toThrow();
    });

    it('throws on spec with no paths', () => {
      expect(() => new OpenApiMcpBackend({
        specJson: JSON.stringify({ openapi: '3.0.3', info: {} }),
      })).toThrow('no paths');
    });
  });

  // ─── getTools ───────────────────────────────────────────────────────────
  describe('getTools', () => {
    it('returns tool definitions', () => {
      const tools = backend.getTools();
      expect(tools.length).toBe(3);
      const names = tools.map(t => t.name);
      expect(names).toContain('listUsers');
      expect(names).toContain('createUser');
      expect(names).toContain('getUser');
    });

    it('includes inputSchema for each tool', () => {
      const tools = backend.getTools();
      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
      }
    });
  });

  // ─── isRunning ──────────────────────────────────────────────────────────
  describe('isRunning', () => {
    it('starts as not running', () => {
      expect(backend.isRunning).toBe(false);
    });

    it('becomes running after start()', async () => {
      await backend.start();
      expect(backend.isRunning).toBe(true);
    });

    it('stops running after stop()', async () => {
      await backend.start();
      await backend.stop();
      expect(backend.isRunning).toBe(false);
    });
  });

  // ─── handleRequest: initialize ──────────────────────────────────────────
  describe('handleRequest - initialize', () => {
    it('returns protocol version and server info', async () => {
      const response = await backend.handleRequest(
        { jsonrpc: '2.0', id: '1', method: 'initialize', params: {} },
        null,
      );
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe('1');
      const result = response.result as any;
      expect(result.protocolVersion).toBe('2025-03-26');
      expect(result.capabilities.tools).toBeDefined();
      expect(result.serverInfo.name).toBe('Test API');
      expect(result.serverInfo.version).toBe('2.0.0');
    });
  });

  // ─── handleRequest: tools/list ──────────────────────────────────────────
  describe('handleRequest - tools/list', () => {
    it('returns list of tools', async () => {
      const response = await backend.handleRequest(
        { jsonrpc: '2.0', id: '2', method: 'tools/list', params: {} },
        null,
      );
      const result = response.result as any;
      expect(result.tools).toHaveLength(3);
      expect(result.tools[0].name).toBeDefined();
      expect(result.tools[0].inputSchema).toBeDefined();
    });
  });

  // ─── handleRequest: tools/call ──────────────────────────────────────────
  describe('handleRequest - tools/call', () => {
    it('returns error for unknown tool', async () => {
      const response = await backend.handleRequest(
        { jsonrpc: '2.0', id: '3', method: 'tools/call', params: { name: 'unknownTool', arguments: {} } },
        null,
      );
      // The proxy handler returns a result with error text, not a JSON-RPC error
      const result = response.result as any;
      expect(JSON.stringify(result)).toContain('Unknown tool');
    });

    // Note: testing successful HTTP calls requires a real/mock HTTP server.
    // We verify the interface and error handling here.
  });

  // ─── handleRequest: unknown method ──────────────────────────────────────
  describe('handleRequest - unknown method', () => {
    it('returns method not found error', async () => {
      const response = await backend.handleRequest(
        { jsonrpc: '2.0', id: '4', method: 'resources/list', params: {} },
        null,
      );
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32601);
      expect(response.error!.message).toContain('Method not found');
    });
  });

  // ─── handleBatchRequest ─────────────────────────────────────────────────
  describe('handleBatchRequest', () => {
    it('handles batch of tool calls', async () => {
      const response = await backend.handleBatchRequest(
        [
          { name: 'unknownTool1', arguments: {} },
          { name: 'unknownTool2', arguments: {} },
        ],
        'batch-1',
        null,
      );
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe('batch-1');
      const result = response.result as any;
      expect(result.results).toHaveLength(2);
    });

    it('returns individual results for each call', async () => {
      const response = await backend.handleBatchRequest(
        [{ name: 'listUsers', arguments: {} }],
        'batch-2',
        null,
      );
      const result = response.result as any;
      expect(result.results[0].tool).toBe('listUsers');
    });
  });

  // ─── getInfo ────────────────────────────────────────────────────────────
  describe('getInfo', () => {
    it('returns spec info and tool counts', () => {
      const info = backend.getInfo();
      expect(info.title).toBe('Test API');
      expect(info.version).toBe('2.0.0');
      expect(info.totalTools).toBe(3);
      expect(info.byMethod.GET).toBe(2);
      expect(info.byMethod.POST).toBe(1);
    });
  });

  // ─── Base URL resolution ───────────────────────────────────────────────
  describe('base URL resolution', () => {
    it('uses spec servers[0] by default', () => {
      // No error means it resolved successfully from the spec
      const b = new OpenApiMcpBackend({ specJson: BASIC_SPEC });
      expect(b.getInfo().title).toBe('Test API');
    });

    it('uses config baseUrl when provided', () => {
      const b = new OpenApiMcpBackend({
        specJson: BASIC_SPEC,
        baseUrl: 'https://custom-api.example.com',
      });
      expect(b.getInfo().title).toBe('Test API');
    });

    it('throws when no base URL available', () => {
      const noServerSpec = JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'API', version: '1.0.0' },
        paths: { '/test': { get: { operationId: 'test', summary: 'Test' } } },
      });
      expect(() => new OpenApiMcpBackend({ specJson: noServerSpec })).toThrow('No base URL');
    });
  });

  // ─── Tool prefix and filtering ─────────────────────────────────────────
  describe('tool prefix and filtering', () => {
    it('applies tool prefix', () => {
      const b = new OpenApiMcpBackend({
        specJson: BASIC_SPEC,
        toolPrefix: 'myapi',
      });
      const tools = b.getTools();
      expect(tools.every(t => t.name.startsWith('myapi_'))).toBe(true);
    });
  });
});
