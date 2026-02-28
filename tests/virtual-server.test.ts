/**
 * Tests for Virtual MCP Server Composition.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import * as http from 'http';
import { VirtualServerComposer, UpstreamServer, VirtualServerConfig } from '../src/virtual-server';

// ─── Mock MCP Server ─────────────────────────────────────────────────────────

function createMockMcpServer(tools: Array<{ name: string; description?: string }>): http.Server {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body);
      let response: any;

      if (request.method === 'tools/list') {
        response = {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            tools: tools.map(t => ({
              name: t.name,
              description: t.description ?? `Tool ${t.name}`,
              inputSchema: { type: 'object', properties: {} },
            })),
          },
        };
      } else if (request.method === 'tools/call') {
        response = {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            content: [{ type: 'text', text: `Result from ${request.params.name}` }],
          },
        };
      } else {
        response = {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: 'Method not found' },
        };
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    });
  });

  return server;
}

function listenOnRandomPort(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(addr.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('VirtualServerComposer', () => {
  let mockServer1: http.Server;
  let mockServer2: http.Server;
  let port1: number;
  let port2: number;

  beforeEach(async () => {
    mockServer1 = createMockMcpServer([
      { name: 'readFile', description: 'Read a file' },
      { name: 'writeFile', description: 'Write a file' },
    ]);
    mockServer2 = createMockMcpServer([
      { name: 'query', description: 'Run a database query' },
      { name: 'insert', description: 'Insert a record' },
    ]);

    port1 = await listenOnRandomPort(mockServer1);
    port2 = await listenOnRandomPort(mockServer2);
  });

  afterEach(async () => {
    await closeServer(mockServer1);
    await closeServer(mockServer2);
  });

  // ─── Constructor ─────────────────────────────────────────────────────
  describe('constructor', () => {
    it('initializes with upstreams', () => {
      const composer = new VirtualServerComposer({
        upstreams: [
          { id: 'fs', prefix: 'fs', remoteUrl: `http://127.0.0.1:${port1}/mcp` },
        ],
      });
      expect(composer.getUpstreams()).toHaveLength(1);
      composer.destroy();
    });
  });

  // ─── Tool Discovery ──────────────────────────────────────────────────
  describe('discoverTools', () => {
    it('discovers tools from single upstream', async () => {
      const composer = new VirtualServerComposer({
        upstreams: [
          { id: 'fs', prefix: 'fs', remoteUrl: `http://127.0.0.1:${port1}/mcp` },
        ],
      });

      const tools = await composer.discoverTools();
      expect(tools).toHaveLength(2);
      expect(tools.map(t => t.federatedName)).toContain('fs_readFile');
      expect(tools.map(t => t.federatedName)).toContain('fs_writeFile');
      composer.destroy();
    });

    it('discovers and merges tools from multiple upstreams', async () => {
      const composer = new VirtualServerComposer({
        upstreams: [
          { id: 'fs', prefix: 'fs', remoteUrl: `http://127.0.0.1:${port1}/mcp` },
          { id: 'db', prefix: 'db', remoteUrl: `http://127.0.0.1:${port2}/mcp` },
        ],
      });

      const tools = await composer.discoverTools();
      expect(tools).toHaveLength(4);
      const names = tools.map(t => t.federatedName);
      expect(names).toContain('fs_readFile');
      expect(names).toContain('fs_writeFile');
      expect(names).toContain('db_query');
      expect(names).toContain('db_insert');
      composer.destroy();
    });

    it('handles unreachable upstream with partial discovery', async () => {
      const composer = new VirtualServerComposer({
        upstreams: [
          { id: 'fs', prefix: 'fs', remoteUrl: `http://127.0.0.1:${port1}/mcp` },
          { id: 'bad', prefix: 'bad', remoteUrl: 'http://127.0.0.1:1/mcp' },
        ],
        partialDiscovery: true,
      });

      const tools = await composer.discoverTools();
      // Should get tools from the working upstream
      expect(tools.length).toBeGreaterThanOrEqual(2);

      // Health should show bad upstream as unhealthy
      const health = composer.getHealth();
      const badHealth = health.find(h => h.id === 'bad');
      expect(badHealth?.healthy).toBe(false);
      composer.destroy();
    });

    it('skips disabled upstreams', async () => {
      const composer = new VirtualServerComposer({
        upstreams: [
          { id: 'fs', prefix: 'fs', remoteUrl: `http://127.0.0.1:${port1}/mcp`, enabled: true },
          { id: 'db', prefix: 'db', remoteUrl: `http://127.0.0.1:${port2}/mcp`, enabled: false },
        ],
      });

      const tools = await composer.discoverTools();
      expect(tools).toHaveLength(2);
      expect(tools.every(t => t.upstreamId === 'fs')).toBe(true);
      composer.destroy();
    });
  });

  // ─── Tool Routing ────────────────────────────────────────────────────
  describe('routeToolCall', () => {
    it('routes calls to correct upstream', async () => {
      const composer = new VirtualServerComposer({
        upstreams: [
          { id: 'fs', prefix: 'fs', remoteUrl: `http://127.0.0.1:${port1}/mcp` },
          { id: 'db', prefix: 'db', remoteUrl: `http://127.0.0.1:${port2}/mcp` },
        ],
      });

      await composer.discoverTools();

      const response = await composer.routeToolCall('fs_readFile', { path: '/tmp/test' });
      expect(response.result).toBeDefined();
      expect(response.error).toBeUndefined();
      composer.destroy();
    });

    it('returns error for unknown tool', async () => {
      const composer = new VirtualServerComposer({
        upstreams: [
          { id: 'fs', prefix: 'fs', remoteUrl: `http://127.0.0.1:${port1}/mcp` },
        ],
      });

      await composer.discoverTools();
      const response = await composer.routeToolCall('nonexistent_tool', {});
      expect(response.error).toBeDefined();
      expect(response.error!.message).toContain('Unknown federated tool');
      composer.destroy();
    });
  });

  // ─── Upstream Management ─────────────────────────────────────────────
  describe('upstream management', () => {
    it('adds upstream at runtime', async () => {
      const composer = new VirtualServerComposer({ upstreams: [] });
      expect(composer.getUpstreams()).toHaveLength(0);

      composer.addUpstream({ id: 'fs', prefix: 'fs', remoteUrl: `http://127.0.0.1:${port1}/mcp` });
      expect(composer.getUpstreams()).toHaveLength(1);

      const tools = await composer.discoverTools();
      expect(tools).toHaveLength(2);
      composer.destroy();
    });

    it('removes upstream', async () => {
      const composer = new VirtualServerComposer({
        upstreams: [
          { id: 'fs', prefix: 'fs', remoteUrl: `http://127.0.0.1:${port1}/mcp` },
          { id: 'db', prefix: 'db', remoteUrl: `http://127.0.0.1:${port2}/mcp` },
        ],
      });

      await composer.discoverTools();
      expect(composer.removeUpstream('db')).toBe(true);
      expect(composer.getUpstreams()).toHaveLength(1);
      composer.destroy();
    });

    it('enables/disables upstream', () => {
      const composer = new VirtualServerComposer({
        upstreams: [
          { id: 'fs', prefix: 'fs', remoteUrl: `http://127.0.0.1:${port1}/mcp` },
        ],
      });

      expect(composer.setUpstreamEnabled('fs', false)).toBe(true);
      expect(composer.setUpstreamEnabled('nonexistent', false)).toBe(false);
      composer.destroy();
    });
  });

  // ─── Stats ───────────────────────────────────────────────────────────
  describe('stats', () => {
    it('tracks requests and tools', async () => {
      const composer = new VirtualServerComposer({
        upstreams: [
          { id: 'fs', prefix: 'fs', remoteUrl: `http://127.0.0.1:${port1}/mcp` },
        ],
      });

      await composer.discoverTools();
      await composer.routeToolCall('fs_readFile', {});

      const stats = composer.getStats();
      expect(stats.totalUpstreams).toBe(1);
      expect(stats.healthyUpstreams).toBe(1);
      expect(stats.totalTools).toBe(2);
      expect(stats.totalRequests).toBe(1);
      expect(stats.requestsByUpstream.fs).toBe(1);
      composer.destroy();
    });
  });

  // ─── Tool Definitions ────────────────────────────────────────────────
  describe('getToolDefinitions', () => {
    it('returns MCP-compatible tool list', async () => {
      const composer = new VirtualServerComposer({
        upstreams: [
          { id: 'fs', prefix: 'fs', remoteUrl: `http://127.0.0.1:${port1}/mcp` },
        ],
      });

      const defs = await composer.getToolDefinitions();
      expect(defs).toHaveLength(2);
      expect(defs[0].name).toContain('fs_');
      expect(defs[0].description).toContain('[fs]');
      expect(defs[0].inputSchema).toBeDefined();
      composer.destroy();
    });
  });

  // ─── Health ──────────────────────────────────────────────────────────
  describe('health', () => {
    it('reports health for all upstreams', async () => {
      const composer = new VirtualServerComposer({
        upstreams: [
          { id: 'fs', prefix: 'fs', remoteUrl: `http://127.0.0.1:${port1}/mcp` },
        ],
      });

      await composer.discoverTools();
      const health = composer.getHealth();
      expect(health).toHaveLength(1);
      expect(health[0].healthy).toBe(true);
      expect(health[0].toolCount).toBe(2);
      expect(health[0].latencyMs).toBeDefined();
      composer.destroy();
    });
  });
});
