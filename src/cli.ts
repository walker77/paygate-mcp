#!/usr/bin/env node
/**
 * PayGate MCP — CLI entry point.
 *
 * Usage:
 *   npx paygate-mcp wrap --server "npx my-mcp-server" --port 3402
 *   npx paygate-mcp wrap --server "python server.py" --price 2 --rate-limit 30
 *   npx paygate-mcp keys create --name "my-client" --credits 500
 *   npx paygate-mcp status
 */

import { PayGateServer } from './server';
import { ToolPricing } from './types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const command = argv[2] || 'help';
  const flags: Record<string, string> = {};

  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    }
  }

  return { command, flags };
}

function printUsage(): void {
  console.log(`
  paygate-mcp — Monetize any MCP server with one command.

  USAGE:
    paygate-mcp wrap --server <command> [options]

  OPTIONS:
    --server <cmd>      MCP server command to wrap (required)
                        e.g. "npx @modelcontextprotocol/server-filesystem /"
    --port <n>          HTTP port (default: 3402)
    --price <n>         Default credits per tool call (default: 1)
    --rate-limit <n>    Max calls/min per key (default: 60, 0=unlimited)
    --name <s>          Server display name (default: "PayGate MCP Server")
    --shadow            Shadow mode — log but don't enforce payment
    --admin-key <s>     Set admin key (default: auto-generated)
    --tool-price <t:n>  Per-tool price override (e.g. "search:5,generate:10")
    --import-key <k:c>  Import an existing API key with credits (e.g. "pg_abc123:100")
    --state-file <path> Persist keys/credits to a JSON file (survives restarts)

  EXAMPLES:
    # Wrap a filesystem MCP server
    paygate-mcp wrap --server "npx @modelcontextprotocol/server-filesystem /tmp"

    # Custom pricing and rate limit
    paygate-mcp wrap --server "python my-server.py" --price 2 --rate-limit 30

    # Shadow mode (observe without enforcing)
    paygate-mcp wrap --server "node server.js" --shadow

    # Per-tool pricing
    paygate-mcp wrap --server "node server.js" --tool-price "search:5,generate:10"
  `);
}

function parseToolPricing(input: string): Record<string, ToolPricing> {
  const pricing: Record<string, ToolPricing> = {};
  const pairs = input.split(',');
  for (const pair of pairs) {
    const [tool, priceStr] = pair.split(':');
    if (tool && priceStr) {
      pricing[tool.trim()] = { creditsPerCall: parseInt(priceStr.trim(), 10) };
    }
  }
  return pricing;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);

  switch (command) {
    case 'wrap': {
      const serverCmd = flags['server'];
      if (!serverCmd) {
        console.error('Error: --server is required.\n');
        printUsage();
        process.exit(1);
      }

      // Parse server command into command + args
      const parts = serverCmd.split(/\s+/);
      const serverCommand = parts[0];
      const serverArgs = parts.slice(1);

      const port = parseInt(flags['port'] || '3402', 10);
      const price = parseInt(flags['price'] || '1', 10);
      const rateLimit = parseInt(flags['rate-limit'] || '60', 10);
      const name = flags['name'] || 'PayGate MCP Server';
      const shadowMode = flags['shadow'] === 'true' || flags['shadow'] === undefined && 'shadow' in flags;
      const adminKey = flags['admin-key'];
      const toolPricing = flags['tool-price'] ? parseToolPricing(flags['tool-price']) : {};
      const stateFile = flags['state-file'];

      const server = new PayGateServer({
        serverCommand,
        serverArgs,
        port,
        defaultCreditsPerCall: price,
        globalRateLimitPerMin: rateLimit,
        name,
        shadowMode: !!shadowMode,
        toolPricing,
      }, adminKey, stateFile);

      // Import keys if specified
      if (flags['import-key']) {
        const pairs = flags['import-key'].split(',');
        for (const pair of pairs) {
          const [key, creditsStr] = pair.split(':');
          if (key && creditsStr) {
            server.gate.store.importKey(key.trim(), 'imported', parseInt(creditsStr.trim(), 10));
          }
        }
      }

      // Handle graceful shutdown
      const shutdown = async () => {
        console.log('\nShutting down...');
        await server.stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      try {
        const result = await server.start();
        console.log(`
  ╔══════════════════════════════════════════════════╗
  ║         PayGate MCP — Server Running             ║
  ╠══════════════════════════════════════════════════╣
  ║                                                  ║
  ║  Endpoint:   http://localhost:${String(result.port).padEnd(5)}              ║
  ║  Admin Key:  ${result.adminKey.slice(0, 20)}...       ║
  ║  Wrapping:   ${serverCmd.slice(0, 35).padEnd(35)}║
  ║                                                  ║
  ║  Pricing:    ${String(price).padEnd(3)} credit(s) per tool call       ║
  ║  Rate Limit: ${String(rateLimit).padEnd(3)} calls/min per key          ║
  ║  Shadow:     ${String(!!shadowMode).padEnd(5)}                            ║
  ║  Persist:    ${(stateFile ? stateFile.slice(0, 33) : 'off (in-memory)').padEnd(35)}║
  ║                                                  ║
  ╠══════════════════════════════════════════════════╣
  ║  POST /mcp     — JSON-RPC (X-API-Key header)    ║
  ║  GET  /status  — Dashboard (X-Admin-Key header)  ║
  ║  POST /keys    — Create key (X-Admin-Key header) ║
  ║  POST /topup   — Add credits (X-Admin-Key header)║
  ╚══════════════════════════════════════════════════╝
`);
        console.log(`  Admin key (save this): ${result.adminKey}\n`);
      } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
      }
      break;
    }

    case 'help':
    case '--help':
    case '-h':
      printUsage();
      break;

    case 'version':
    case '--version':
    case '-v':
      console.log('paygate-mcp v0.1.4');
      break;

    default:
      console.error(`Unknown command: ${command}\n`);
      printUsage();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
