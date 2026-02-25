#!/usr/bin/env node
/**
 * Minimal MCP server that speaks JSON-RPC over stdio.
 * Used for E2E testing of PayGate.
 */

const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line.trim());
  } catch {
    return; // Ignore unparseable lines
  }

  let response;

  switch (request.method) {
    case 'initialize':
      response = {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-mcp-server', version: '0.1.0' },
        },
      };
      break;

    case 'tools/list':
      response = {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools: [
            { name: 'search', description: 'Search things', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
            { name: 'generate', description: 'Generate things', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } } },
            { name: 'premium_analyze', description: 'Premium analysis', inputSchema: { type: 'object', properties: { data: { type: 'string' } } } },
          ],
        },
      };
      break;

    case 'tools/call':
      const toolName = request.params?.name || 'unknown';
      response = {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [{ type: 'text', text: `Tool "${toolName}" executed successfully with args: ${JSON.stringify(request.params?.arguments || {})}` }],
        },
      };
      break;

    case 'ping':
      response = { jsonrpc: '2.0', id: request.id, result: {} };
      break;

    default:
      response = {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: `Method not found: ${request.method}` },
      };
  }

  process.stdout.write(JSON.stringify(response) + '\n');
});
