/**
 * Tests for HttpMcpProxy — Streamable HTTP transport.
 *
 * Uses a mock remote MCP server (local HTTP) to verify:
 * - JSON-RPC forwarding via HTTP POST
 * - SSE response parsing
 * - Session management (Mcp-Session-Id)
 * - Free method passthrough
 * - Tool call gating (auth + billing)
 * - Error handling for unreachable servers
 * - Graceful shutdown with DELETE
 */

import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { HttpMcpProxy } from '../src/http-proxy';
import { Gate } from '../src/gate';
import { PayGateConfig, DEFAULT_CONFIG } from '../src/types';

// ─── Mock Remote MCP Server ──────────────────────────────────────────────────

let mockServer: Server;
let mockPort: number;
let lastRequestBody: any = null;
let lastRequestHeaders: Record<string, string | string[] | undefined> = {};
let mockResponseOverride: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
let deleteReceived = false;

function startMockServer(): Promise<void> {
  return new Promise((resolve) => {
    mockServer = createServer((req, res) => {
      lastRequestHeaders = req.headers;

      if (req.method === 'DELETE') {
        deleteReceived = true;
        res.writeHead(200);
        res.end();
        return;
      }

      if (mockResponseOverride) {
        mockResponseOverride(req, res);
        return;
      }

      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        lastRequestBody = JSON.parse(body);

        // Default: echo back a success response
        const response = {
          jsonrpc: '2.0',
          id: lastRequestBody.id,
          result: { content: [{ type: 'text', text: 'mock response' }] },
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      });
    });

    mockServer.listen(0, () => {
      mockPort = (mockServer.address() as any).port;
      resolve();
    });
  });
}

function stopMockServer(): Promise<void> {
  return new Promise((resolve) => {
    mockServer.closeAllConnections?.();
    mockServer.close(() => resolve());
  });
}

// ─── Test Setup ──────────────────────────────────────────────────────────────

function createGate(): Gate {
  const config: PayGateConfig = { ...DEFAULT_CONFIG, defaultCreditsPerCall: 1 };
  return new Gate(config);
}

describe('HttpMcpProxy', () => {
  beforeAll(async () => {
    await startMockServer();
  });

  afterAll(async () => {
    await stopMockServer();
  });

  beforeEach(() => {
    lastRequestBody = null;
    lastRequestHeaders = {};
    mockResponseOverride = null;
    deleteReceived = false;
  });

  // ─── Basic Forwarding ───────────────────────────────────────────────────────

  describe('Basic Forwarding', () => {
    test('should forward free methods without auth', async () => {
      const gate = createGate();
      const proxy = new HttpMcpProxy(gate, `http://localhost:${mockPort}/mcp`);
      await proxy.start();

      const response = await proxy.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }, null);

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.result).toBeDefined();
      await proxy.stop();
    });

    test('should forward initialize without auth', async () => {
      const gate = createGate();
      const proxy = new HttpMcpProxy(gate, `http://localhost:${mockPort}/mcp`);
      await proxy.start();

      const response = await proxy.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26' },
      }, null);

      expect(response.result).toBeDefined();
      await proxy.stop();
    });

    test('should gate tools/call and require auth', async () => {
      const gate = createGate();
      const proxy = new HttpMcpProxy(gate, `http://localhost:${mockPort}/mcp`);
      await proxy.start();

      const response = await proxy.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '/tmp/test.txt' } },
      }, null);

      // Should be denied — no API key
      expect(response.error).toBeDefined();
      expect(response.error!.message).toContain('Payment required');
      await proxy.stop();
    });

    test('should forward tools/call with valid API key', async () => {
      const gate = createGate();
      const record = gate.store.createKey('test', 100);
      const proxy = new HttpMcpProxy(gate, `http://localhost:${mockPort}/mcp`);
      await proxy.start();

      const response = await proxy.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '/tmp/test.txt' } },
      }, record.key);

      expect(response.result).toBeDefined();
      expect(gate.store.getKey(record.key)!.credits).toBe(99); // 1 credit deducted
      await proxy.stop();
    });

    test('should handle notifications (no id)', async () => {
      const gate = createGate();
      const proxy = new HttpMcpProxy(gate, `http://localhost:${mockPort}/mcp`);
      await proxy.start();

      const response = await proxy.handleRequest({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }, null);

      expect(response.result).toBeDefined();
      await proxy.stop();
    });
  });

  // ─── HTTP Headers ───────────────────────────────────────────────────────────

  describe('HTTP Headers', () => {
    test('should send Accept header with json and event-stream', async () => {
      const gate = createGate();
      const proxy = new HttpMcpProxy(gate, `http://localhost:${mockPort}/mcp`);
      await proxy.start();

      await proxy.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      }, null);

      expect(lastRequestHeaders['accept']).toBe('application/json, text/event-stream');
      await proxy.stop();
    });

    test('should send Content-Type application/json', async () => {
      const gate = createGate();
      const proxy = new HttpMcpProxy(gate, `http://localhost:${mockPort}/mcp`);
      await proxy.start();

      await proxy.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      }, null);

      expect(lastRequestHeaders['content-type']).toBe('application/json');
      await proxy.stop();
    });
  });

  // ─── Session Management ─────────────────────────────────────────────────────

  describe('Session Management', () => {
    test('should capture Mcp-Session-Id from response', async () => {
      mockResponseOverride = (_req, res) => {
        let body = '';
        _req.on('data', (chunk) => { body += chunk.toString(); });
        _req.on('end', () => {
          const parsed = JSON.parse(body);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Mcp-Session-Id': 'session-abc-123',
          });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { ok: true } }));
        });
      };

      const gate = createGate();
      const proxy = new HttpMcpProxy(gate, `http://localhost:${mockPort}/mcp`);
      await proxy.start();

      // First request — captures session ID
      await proxy.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      }, null);

      // Second request — should include session ID in headers
      mockResponseOverride = (_req, res) => {
        lastRequestHeaders = _req.headers;
        let body = '';
        _req.on('data', (chunk) => { body += chunk.toString(); });
        _req.on('end', () => {
          const parsed = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: {} }));
        });
      };

      await proxy.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }, null);

      expect(lastRequestHeaders['mcp-session-id']).toBe('session-abc-123');
      await proxy.stop();
    });

    test('should send DELETE on stop when session exists', async () => {
      mockResponseOverride = (_req, res) => {
        let body = '';
        _req.on('data', (chunk) => { body += chunk.toString(); });
        _req.on('end', () => {
          const parsed = JSON.parse(body);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Mcp-Session-Id': 'session-to-delete',
          });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: {} }));
        });
      };

      const gate = createGate();
      const proxy = new HttpMcpProxy(gate, `http://localhost:${mockPort}/mcp`);
      await proxy.start();

      await proxy.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      }, null);

      mockResponseOverride = null; // Reset so DELETE goes to default handler
      await proxy.stop();

      // Give DELETE a moment to arrive
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(deleteReceived).toBe(true);
    });
  });

  // ─── SSE Response Parsing ───────────────────────────────────────────────────

  describe('SSE Response Parsing', () => {
    test('should parse SSE event-stream responses', async () => {
      mockResponseOverride = (_req, res) => {
        let body = '';
        _req.on('data', (chunk) => { body += chunk.toString(); });
        _req.on('end', () => {
          const parsed = JSON.parse(body);
          const sseBody = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { tools: ['read_file'] } })}\n\n`;
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(sseBody);
        });
      };

      const gate = createGate();
      const proxy = new HttpMcpProxy(gate, `http://localhost:${mockPort}/mcp`);
      await proxy.start();

      const response = await proxy.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }, null);

      expect(response.result).toEqual({ tools: ['read_file'] });
      await proxy.stop();
    });

    test('should extract correct response from multi-event SSE stream', async () => {
      mockResponseOverride = (_req, res) => {
        let body = '';
        _req.on('data', (chunk) => { body += chunk.toString(); });
        _req.on('end', () => {
          const parsed = JSON.parse(body);
          // Send a notification first, then the actual response
          const sseBody = [
            `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 50 } })}`,
            '',
            `data: ${JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { content: [{ type: 'text', text: 'done' }] } })}`,
            '',
          ].join('\n');
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(sseBody);
        });
      };

      const gate = createGate();
      const record = gate.store.createKey('test', 100);
      const proxy = new HttpMcpProxy(gate, `http://localhost:${mockPort}/mcp`);
      await proxy.start();

      const response = await proxy.handleRequest({
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: { name: 'my_tool', arguments: {} },
      }, record.key);

      expect(response.id).toBe(42);
      expect(response.result).toEqual({ content: [{ type: 'text', text: 'done' }] });
      await proxy.stop();
    });
  });

  // ─── Error Handling ─────────────────────────────────────────────────────────

  describe('Error Handling', () => {
    test('should handle remote server returning HTTP error', async () => {
      mockResponseOverride = (_req, res) => {
        let body = '';
        _req.on('data', (chunk) => { body += chunk.toString(); });
        _req.on('end', () => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        });
      };

      const gate = createGate();
      const proxy = new HttpMcpProxy(gate, `http://localhost:${mockPort}/mcp`);
      await proxy.start();

      const response = await proxy.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }, null);

      expect(response.error).toBeDefined();
      expect(response.error!.message).toContain('Remote server error');
      await proxy.stop();
    });

    test('should handle unreachable remote server', async () => {
      const gate = createGate();
      // Port 1 is almost certainly not serving
      const proxy = new HttpMcpProxy(gate, 'http://localhost:1/mcp');
      await proxy.start();

      const response = await proxy.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }, null);

      expect(response.error).toBeDefined();
      expect(response.error!.message).toContain('Remote server error');
      await proxy.stop();
    });

    test('should return error when proxy not started', async () => {
      const gate = createGate();
      const proxy = new HttpMcpProxy(gate, `http://localhost:${mockPort}/mcp`);
      // Don't start

      const response = await proxy.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }, null);

      expect(response.error).toBeDefined();
      expect(response.error!.message).toContain('not started');
    });

    test('should handle invalid tool call (missing name)', async () => {
      const gate = createGate();
      const record = gate.store.createKey('test', 100);
      const proxy = new HttpMcpProxy(gate, `http://localhost:${mockPort}/mcp`);
      await proxy.start();

      const response = await proxy.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { arguments: {} },
      }, record.key);

      expect(response.error).toBeDefined();
      expect(response.error!.message).toContain('missing tool name');
      await proxy.stop();
    });
  });

  // ─── isRunning ──────────────────────────────────────────────────────────────

  describe('Lifecycle', () => {
    test('isRunning reflects proxy state', async () => {
      const gate = createGate();
      const proxy = new HttpMcpProxy(gate, `http://localhost:${mockPort}/mcp`);

      expect(proxy.isRunning).toBe(false);
      await proxy.start();
      expect(proxy.isRunning).toBe(true);
      await proxy.stop();
      expect(proxy.isRunning).toBe(false);
    });
  });
});
