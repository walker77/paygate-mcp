#!/usr/bin/env node
/**
 * Second mock MCP server for multi-server testing.
 * Has different tools than mock-mcp-server.js to verify routing.
 */

const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line.trim());
  } catch {
    return;
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
          serverInfo: { name: 'mock-mcp-server-b', version: '0.1.0' },
        },
      };
      break;

    case 'tools/list':
      response = {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools: [
            { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
            { name: 'write_file', description: 'Write a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
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
          content: [{ type: 'text', text: `[server-b] Tool "${toolName}" executed with args: ${JSON.stringify(request.params?.arguments || {})}` }],
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
