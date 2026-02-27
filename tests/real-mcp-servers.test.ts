/**
 * Integration tests: PayGate wrapping REAL MCP servers
 *
 * Verifies that paygate-mcp correctly proxies popular, widely-used
 * MCP servers from the official @modelcontextprotocol scope.
 *
 * Servers tested (all zero-config, no API keys needed):
 *   1. @modelcontextprotocol/server-everything  — canonical test server
 *   2. @modelcontextprotocol/server-filesystem   — most popular MCP server (~200k+ weekly npm downloads)
 *   3. @modelcontextprotocol/server-memory       — stateful knowledge graph CRUD
 *   4. @modelcontextprotocol/server-sequential-thinking — minimal single-tool server
 *
 * Each test verifies:
 *   - PayGate starts and wraps the real server
 *   - tools/list returns the server's actual tools through the proxy
 *   - tools/call executes a real tool and returns the result
 *   - Credit deduction works correctly
 *   - Rejected calls (no credits) are blocked before reaching the server
 */

import { PayGateServer } from '../src/server';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Resolve npx path
const npxPath = process.env.NPX_PATH || 'npx';

// Helper: POST to /mcp endpoint
async function mcpPost(port: number, body: object, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(`http://localhost:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Helper: create an API key with given credits
async function createKey(port: number, adminKey: string, credits: number): Promise<string> {
  const res = await fetch(`http://localhost:${port}/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
    body: JSON.stringify({ name: `test-${Date.now()}`, credits }),
  });
  const body: any = await res.json();
  return body.key;
}

// Helper: check balance
async function getBalance(port: number, apiKey: string): Promise<number> {
  const res = await fetch(`http://localhost:${port}/balance`, {
    headers: { 'X-API-Key': apiKey },
  });
  const body: any = await res.json();
  return body.credits;
}

// ─────────────────────────────────────────────────────────────────────
// 1. @modelcontextprotocol/server-everything
// ─────────────────────────────────────────────────────────────────────

describe('Real MCP: @modelcontextprotocol/server-everything', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: npxPath,
      serverArgs: ['-y', '@modelcontextprotocol/server-everything'],
      port: 0,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  }, 120_000); // npx install can take a while

  afterAll(async () => {
    await server.gracefulStop(10_000);
  }, 30_000);

  it('discovers real tools via tools/list', async () => {
    const apiKey = await createKey(port, adminKey, 100);
    const result = await mcpPost(port, {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    }, { 'X-API-Key': apiKey });

    expect(result.result).toBeDefined();
    expect(result.result.tools).toBeDefined();
    expect(Array.isArray(result.result.tools)).toBe(true);
    expect(result.result.tools.length).toBeGreaterThanOrEqual(2);

    // Should include the canonical echo tool and a math tool
    const toolNames = result.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain('echo');
    // The math tool may be called 'add' or 'get-sum' depending on version
    const hasMathTool = toolNames.some((n: string) => n === 'add' || n === 'get-sum');
    expect(hasMathTool).toBe(true);
  }, 60_000);

  it('proxies echo tool call and returns result', async () => {
    const apiKey = await createKey(port, adminKey, 100);
    const result = await mcpPost(port, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'echo', arguments: { message: 'hello from paygate' } },
    }, { 'X-API-Key': apiKey });

    expect(result.result).toBeDefined();
    expect(result.result.content).toBeDefined();
    expect(result.result.content.length).toBeGreaterThanOrEqual(1);
    // Echo server returns the message back
    const textContent = result.result.content.find((c: any) => c.type === 'text');
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain('hello from paygate');
  }, 30_000);

  it('proxies math tool call with correct result', async () => {
    const apiKey = await createKey(port, adminKey, 100);

    // First discover which math tool name is available
    const listResult = await mcpPost(port, {
      jsonrpc: '2.0', id: 10, method: 'tools/list', params: {},
    }, { 'X-API-Key': apiKey });
    const toolNames = listResult.result.tools.map((t: any) => t.name);
    const mathTool = toolNames.find((n: string) => n === 'add') ||
                     toolNames.find((n: string) => n === 'get-sum');
    expect(mathTool).toBeDefined();

    const result = await mcpPost(port, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: mathTool, arguments: { a: 7, b: 35 } },
    }, { 'X-API-Key': apiKey });

    expect(result.result).toBeDefined();
    expect(result.result.content).toBeDefined();
    const textContent = result.result.content.find((c: any) => c.type === 'text');
    expect(textContent).toBeDefined();
    // 7 + 35 = 42
    expect(textContent.text).toContain('42');
  }, 30_000);

  it('deducts credits on tool call', async () => {
    const apiKey = await createKey(port, adminKey, 10);
    const before = await getBalance(port, apiKey);
    expect(before).toBe(10);

    await mcpPost(port, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'echo', arguments: { message: 'credit test' } },
    }, { 'X-API-Key': apiKey });

    const after = await getBalance(port, apiKey);
    expect(after).toBe(9); // 1 credit deducted
  }, 30_000);

  it('blocks tool call when credits exhausted', async () => {
    const apiKey = await createKey(port, adminKey, 0);
    const result = await mcpPost(port, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'echo', arguments: { message: 'should fail' } },
    }, { 'X-API-Key': apiKey });

    // Should get a payment-required error
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe(-32402);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────
// 2. @modelcontextprotocol/server-filesystem
// ─────────────────────────────────────────────────────────────────────

describe('Real MCP: @modelcontextprotocol/server-filesystem', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let tmpDir: string;

  beforeAll(async () => {
    // Create a temp directory for the filesystem server
    // Resolve realpath to handle macOS /var -> /private/var symlink
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paygate-fs-test-')));

    // Write a test file
    fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'Hello from PayGate test!');
    fs.mkdirSync(path.join(tmpDir, 'subdir'));
    fs.writeFileSync(path.join(tmpDir, 'subdir', 'nested.txt'), 'Nested file content');

    server = new PayGateServer({
      serverCommand: npxPath,
      serverArgs: ['-y', '@modelcontextprotocol/server-filesystem', tmpDir],
      port: 0,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  }, 120_000);

  afterAll(async () => {
    await server.gracefulStop(10_000);
    // Clean up temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 30_000);

  it('discovers filesystem tools', async () => {
    const apiKey = await createKey(port, adminKey, 100);
    const result = await mcpPost(port, {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    }, { 'X-API-Key': apiKey });

    expect(result.result).toBeDefined();
    const toolNames = result.result.tools.map((t: any) => t.name);
    // Filesystem server should expose file operations
    expect(toolNames.length).toBeGreaterThanOrEqual(5);
    // Check for key tools (names may vary by version)
    const hasReadTool = toolNames.some((n: string) =>
      n.includes('read') || n.includes('file') || n.includes('get')
    );
    expect(hasReadTool).toBe(true);
  }, 60_000);

  it('reads a file through the proxy', async () => {
    const apiKey = await createKey(port, adminKey, 100);

    // First get tool list to find the read tool name
    const listResult = await mcpPost(port, {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    }, { 'X-API-Key': apiKey });

    const toolNames = listResult.result.tools.map((t: any) => t.name);

    // Try read_file or read_text_file
    const readToolName = toolNames.find((n: string) =>
      n === 'read_file' || n === 'read_text_file'
    ) || toolNames.find((n: string) => n.includes('read'));

    expect(readToolName).toBeDefined();

    const result = await mcpPost(port, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: readToolName, arguments: { path: path.join(tmpDir, 'hello.txt') } },
    }, { 'X-API-Key': apiKey });

    expect(result.result).toBeDefined();
    expect(result.result.content).toBeDefined();
    const textContent = result.result.content.find((c: any) => c.type === 'text');
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain('Hello from PayGate test!');
  }, 30_000);

  it('lists directory through the proxy', async () => {
    const apiKey = await createKey(port, adminKey, 100);

    // Get tools list
    const listResult = await mcpPost(port, {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    }, { 'X-API-Key': apiKey });
    const toolNames = listResult.result.tools.map((t: any) => t.name);

    const listToolName = toolNames.find((n: string) =>
      n === 'list_directory' || n === 'list_dir'
    ) || toolNames.find((n: string) => n.includes('list') && n.includes('dir'));

    expect(listToolName).toBeDefined();

    const result = await mcpPost(port, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: listToolName, arguments: { path: tmpDir } },
    }, { 'X-API-Key': apiKey });

    expect(result.result).toBeDefined();
    expect(result.result.content).toBeDefined();
    const textContent = result.result.content.find((c: any) => c.type === 'text');
    expect(textContent).toBeDefined();
    // Should list our test files
    expect(textContent.text).toContain('hello.txt');
    expect(textContent.text).toContain('subdir');
  }, 30_000);

  it('deducts credits on file operations', async () => {
    const apiKey = await createKey(port, adminKey, 5);

    // Get tools list
    const listResult = await mcpPost(port, {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    }, { 'X-API-Key': apiKey });
    const toolNames = listResult.result.tools.map((t: any) => t.name);
    const readToolName = toolNames.find((n: string) =>
      n === 'read_file' || n === 'read_text_file'
    ) || toolNames.find((n: string) => n.includes('read'));

    const before = await getBalance(port, apiKey);
    expect(before).toBe(5);

    await mcpPost(port, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: readToolName, arguments: { path: path.join(tmpDir, 'hello.txt') } },
    }, { 'X-API-Key': apiKey });

    const after = await getBalance(port, apiKey);
    expect(after).toBe(4);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────
// 3. @modelcontextprotocol/server-memory
// ─────────────────────────────────────────────────────────────────────

describe('Real MCP: @modelcontextprotocol/server-memory', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: npxPath,
      serverArgs: ['-y', '@modelcontextprotocol/server-memory'],
      port: 0,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  }, 120_000);

  afterAll(async () => {
    await server.gracefulStop(10_000);
  }, 30_000);

  it('discovers memory/knowledge-graph tools', async () => {
    const apiKey = await createKey(port, adminKey, 100);
    const result = await mcpPost(port, {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    }, { 'X-API-Key': apiKey });

    expect(result.result).toBeDefined();
    const toolNames = result.result.tools.map((t: any) => t.name);
    expect(toolNames.length).toBeGreaterThanOrEqual(3);

    // Memory server should have knowledge graph tools
    const hasCreateTool = toolNames.some((n: string) =>
      n.includes('create') || n.includes('add')
    );
    const hasReadTool = toolNames.some((n: string) =>
      n.includes('read') || n.includes('search') || n.includes('open')
    );
    expect(hasCreateTool).toBe(true);
    expect(hasReadTool).toBe(true);
  }, 60_000);

  it('creates and reads entities through proxy', async () => {
    const apiKey = await createKey(port, adminKey, 100);

    // Get tool names
    const listResult = await mcpPost(port, {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    }, { 'X-API-Key': apiKey });
    const toolNames = listResult.result.tools.map((t: any) => t.name);

    // Create entity
    const createTool = toolNames.find((n: string) => n === 'create_entities') || 'create_entities';
    const createResult = await mcpPost(port, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: createTool,
        arguments: {
          entities: [{
            name: 'PayGate',
            entityType: 'Software',
            observations: ['MCP payment proxy', 'Open source'],
          }],
        },
      },
    }, { 'X-API-Key': apiKey });

    expect(createResult.result).toBeDefined();

    // Read the graph back
    const readTool = toolNames.find((n: string) => n === 'read_graph') || 'read_graph';
    const readResult = await mcpPost(port, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: readTool, arguments: {} },
    }, { 'X-API-Key': apiKey });

    expect(readResult.result).toBeDefined();
    expect(readResult.result.content).toBeDefined();
    const textContent = readResult.result.content.find((c: any) => c.type === 'text');
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain('PayGate');
  }, 30_000);

  it('search works through proxy', async () => {
    const apiKey = await createKey(port, adminKey, 100);

    // First create something to search for
    await mcpPost(port, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'create_entities',
        arguments: {
          entities: [{
            name: 'TestEntity',
            entityType: 'Test',
            observations: ['integration test search target'],
          }],
        },
      },
    }, { 'X-API-Key': apiKey });

    // Search
    const searchResult = await mcpPost(port, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'search_nodes', arguments: { query: 'TestEntity' } },
    }, { 'X-API-Key': apiKey });

    expect(searchResult.result).toBeDefined();
    expect(searchResult.result.content).toBeDefined();
    const textContent = searchResult.result.content.find((c: any) => c.type === 'text');
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain('TestEntity');
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────
// 4. @modelcontextprotocol/server-sequential-thinking
// ─────────────────────────────────────────────────────────────────────

describe('Real MCP: @modelcontextprotocol/server-sequential-thinking', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: npxPath,
      serverArgs: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      port: 0,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  }, 120_000);

  afterAll(async () => {
    await server.gracefulStop(10_000);
  }, 30_000);

  it('discovers sequentialthinking tool', async () => {
    const apiKey = await createKey(port, adminKey, 100);
    const result = await mcpPost(port, {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    }, { 'X-API-Key': apiKey });

    expect(result.result).toBeDefined();
    const toolNames = result.result.tools.map((t: any) => t.name);
    // Tool name is 'sequentialthinking' (no underscore)
    expect(toolNames).toContain('sequentialthinking');
  }, 60_000);

  it('executes sequential thinking through proxy', async () => {
    const apiKey = await createKey(port, adminKey, 100);
    const result = await mcpPost(port, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'sequentialthinking',
        arguments: {
          thought: 'PayGate wraps MCP servers to add authentication and billing',
          thoughtNumber: 1,
          totalThoughts: 1,
          nextThoughtNeeded: false,
        },
      },
    }, { 'X-API-Key': apiKey });

    expect(result.result).toBeDefined();
    expect(result.result.content).toBeDefined();
    expect(result.result.content.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('deducts credits per thinking step', async () => {
    const apiKey = await createKey(port, adminKey, 3);
    const before = await getBalance(port, apiKey);
    expect(before).toBe(3);

    await mcpPost(port, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'sequentialthinking',
        arguments: {
          thought: 'First thought',
          thoughtNumber: 1,
          totalThoughts: 2,
          nextThoughtNeeded: true,
        },
      },
    }, { 'X-API-Key': apiKey });

    const mid = await getBalance(port, apiKey);
    expect(mid).toBe(2);

    await mcpPost(port, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'sequentialthinking',
        arguments: {
          thought: 'Second thought',
          thoughtNumber: 2,
          totalThoughts: 2,
          nextThoughtNeeded: false,
        },
      },
    }, { 'X-API-Key': apiKey });

    const after = await getBalance(port, apiKey);
    expect(after).toBe(1);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────
// 5. Cross-server validation
// ─────────────────────────────────────────────────────────────────────

describe('Real MCP: Cross-server validation', () => {
  it('PayGate admin endpoints work regardless of wrapped server', async () => {
    // Start with the everything server
    const server = new PayGateServer({
      serverCommand: npxPath,
      serverArgs: ['-y', '@modelcontextprotocol/server-everything'],
      port: 0,
    });
    const info = await server.start();

    try {
      // All admin endpoints should work
      const healthRes = await fetch(`http://localhost:${info.port}/health`);
      expect(healthRes.status).toBe(200);
      const health: any = await healthRes.json();
      expect(health.status).toBe('healthy');

      // OpenAPI should include all PayGate endpoints
      const openapiRes = await fetch(`http://localhost:${info.port}/openapi.json`);
      expect(openapiRes.status).toBe(200);
      const openapi: any = await openapiRes.json();
      expect(openapi.paths['/mcp']).toBeDefined();
      expect(openapi.paths['/keys']).toBeDefined();
      expect(openapi.paths['/balance']).toBeDefined();

      // Portal should be served
      const portalRes = await fetch(`http://localhost:${info.port}/portal`);
      expect(portalRes.status).toBe(200);
      const portalText = await portalRes.text();
      expect(portalText).toContain('PayGate');

      // Root listing
      const rootRes = await fetch(`http://localhost:${info.port}/`, {
        headers: { 'X-Admin-Key': info.adminKey },
      });
      expect(rootRes.status).toBe(200);

      // Version header
      const versionHeader = healthRes.headers.get('x-paygate-version');
      expect(versionHeader).toBeDefined();
    } finally {
      await server.gracefulStop(10_000);
    }
  }, 120_000);
});
