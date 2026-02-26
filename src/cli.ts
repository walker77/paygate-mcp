#!/usr/bin/env node
/**
 * PayGate MCP — CLI entry point.
 *
 * Usage:
 *   npx paygate-mcp wrap --server "npx my-mcp-server" --port 3402
 *   npx paygate-mcp wrap --server "python server.py" --price 2 --rate-limit 30
 *   npx paygate-mcp wrap --config paygate.json
 */

import { PayGateServer } from './server';
import { PayGateConfig, ToolPricing, ServerBackendConfig } from './types';
import { readFileSync } from 'fs';
import { join } from 'path';

const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
})();

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
    paygate-mcp wrap --server <command> [options]     # stdio transport
    paygate-mcp wrap --remote-url <url> [options]     # Streamable HTTP transport
    paygate-mcp wrap --config <path> [options]        # load from config file

  OPTIONS:
    --server <cmd>         MCP server command to wrap via stdio (required unless --remote-url or --config)
                           e.g. "npx @modelcontextprotocol/server-filesystem /"
    --remote-url <url>     Remote MCP server URL (Streamable HTTP transport)
                           e.g. "https://my-mcp-server.example.com/mcp"
    --config <path>        Load all settings from a JSON file
    --port <n>             HTTP port (default: 3402)
    --price <n>            Default credits per tool call (default: 1)
    --rate-limit <n>       Max calls/min per key (default: 60, 0=unlimited)
    --name <s>             Server display name (default: "PayGate MCP Server")
    --shadow               Shadow mode — log but don't enforce payment
    --admin-key <s>        Set admin key (default: auto-generated)
    --tool-price <t:n>     Per-tool price override (e.g. "search:5,generate:10")
    --import-key <k:c>     Import an existing API key with credits (e.g. "pg_abc123:100")
    --state-file <path>    Persist keys/credits to a JSON file (survives restarts)
    --stripe-secret <s>    Stripe webhook signing secret (enables /stripe/webhook endpoint)
    --webhook-url <url>    POST usage events to this URL (batched)
    --webhook-secret <s>   HMAC-SHA256 secret for webhook signatures
    --refund-on-failure    Refund credits when downstream tool call fails
    --redis-url <url>      Redis URL for distributed state (e.g. "redis://localhost:6379")

  EXAMPLES:
    # Wrap a local MCP server (stdio transport)
    paygate-mcp wrap --server "npx @modelcontextprotocol/server-filesystem /tmp"

    # Gate a remote MCP server (Streamable HTTP transport)
    paygate-mcp wrap --remote-url "https://my-server.example.com/mcp" --price 5

    # Multi-server mode: wrap N servers behind one PayGate
    paygate-mcp wrap --config multi-server.json
    # Config file: { "servers": [
    #   { "prefix": "fs", "serverCommand": "npx", "serverArgs": ["@mcp/server-filesystem", "/tmp"] },
    #   { "prefix": "gh", "remoteUrl": "https://github-mcp.example.com/mcp" }
    # ]}
    # Tools become: "fs:read_file", "gh:search_repos", etc.

    # Custom pricing and rate limit
    paygate-mcp wrap --server "python my-server.py" --price 2 --rate-limit 30

    # Shadow mode (observe without enforcing)
    paygate-mcp wrap --server "node server.js" --shadow

    # Load config from file
    paygate-mcp wrap --config paygate.json
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

interface ConfigFile {
  serverCommand?: string;
  serverArgs?: string[];
  remoteUrl?: string;
  port?: number;
  defaultCreditsPerCall?: number;
  toolPricing?: Record<string, { creditsPerCall: number; rateLimitPerMin?: number; creditsPerKbInput?: number }>;
  globalRateLimitPerMin?: number;
  /** Global usage quota defaults (daily/monthly limits). */
  globalQuota?: { dailyCallLimit?: number; monthlyCallLimit?: number; dailyCreditLimit?: number; monthlyCreditLimit?: number };
  shadowMode?: boolean;
  adminKey?: string;
  stateFile?: string;
  stripeWebhookSecret?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  refundOnFailure?: boolean;
  importKeys?: Record<string, number>;
  /** Multi-server mode: wrap multiple MCP servers with tool prefix routing */
  servers?: Array<{
    prefix: string;
    serverCommand?: string;
    serverArgs?: string[];
    remoteUrl?: string;
  }>;
  /** OAuth 2.1 configuration */
  oauth?: {
    issuer?: string;
    accessTokenTtl?: number;
    refreshTokenTtl?: number;
    scopes?: string[];
  };
  /** Redis URL for distributed state */
  redisUrl?: string;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);

  switch (command) {
    case 'wrap': {
      // Load config file if specified
      let fileConfig: ConfigFile = {};
      if (flags['config']) {
        try {
          const raw = readFileSync(flags['config'], 'utf-8');
          fileConfig = JSON.parse(raw);
        } catch (err) {
          console.error(`Error loading config file: ${(err as Error).message}`);
          process.exit(1);
        }
      }

      // Multi-server mode check
      const multiServers: ServerBackendConfig[] | undefined = fileConfig.servers;
      const isMultiServer = multiServers && multiServers.length > 0;

      const serverCmd = flags['server'] || (fileConfig.serverCommand ? [fileConfig.serverCommand, ...(fileConfig.serverArgs || [])].join(' ') : '');
      const remoteUrl = flags['remote-url'] || fileConfig.remoteUrl;

      if (!serverCmd && !remoteUrl && !isMultiServer) {
        console.error('Error: --server, --remote-url, or --config (with servers[]) is required.\n');
        printUsage();
        process.exit(1);
      }

      if (isMultiServer && (serverCmd || remoteUrl)) {
        console.error('Error: use "servers" array OR --server/--remote-url, not both.\n');
        process.exit(1);
      }

      if (serverCmd && remoteUrl) {
        console.error('Error: use --server OR --remote-url, not both.\n');
        process.exit(1);
      }

      // Parse server command into command + args (stdio mode)
      let serverCommand = fileConfig.serverCommand || '';
      let serverArgs: string[] = fileConfig.serverArgs || [];
      if (flags['server']) {
        const parts = flags['server'].split(/\s+/);
        serverCommand = parts[0];
        serverArgs = parts.slice(1);
      }

      const port = parseInt(flags['port'] || String(fileConfig.port || 3402), 10);
      const price = parseInt(flags['price'] || String(fileConfig.defaultCreditsPerCall || 1), 10);
      const rateLimit = parseInt(flags['rate-limit'] || String(fileConfig.globalRateLimitPerMin || 60), 10);
      const name = flags['name'] || fileConfig.serverCommand && 'PayGate MCP Server' || 'PayGate MCP Server';
      const shadowMode = flags['shadow'] === 'true' || ('shadow' in flags && flags['shadow'] === undefined) || fileConfig.shadowMode || false;
      const adminKey = flags['admin-key'] || fileConfig.adminKey;
      const toolPricing = flags['tool-price'] ? parseToolPricing(flags['tool-price']) : (fileConfig.toolPricing || {});
      const stateFile = flags['state-file'] || fileConfig.stateFile;
      const stripeSecret = flags['stripe-secret'] || fileConfig.stripeWebhookSecret;
      const webhookUrl = flags['webhook-url'] || fileConfig.webhookUrl || null;
      const webhookSecret = flags['webhook-secret'] || fileConfig.webhookSecret || null;
      const refundOnFailure = flags['refund-on-failure'] === 'true' || 'refund-on-failure' in flags || fileConfig.refundOnFailure || false;
      const redisUrl = flags['redis-url'] || fileConfig.redisUrl || undefined;

      // Parse global quota from config file
      const globalQuota = fileConfig.globalQuota ? {
        dailyCallLimit: Math.max(0, Math.floor(Number(fileConfig.globalQuota.dailyCallLimit) || 0)),
        monthlyCallLimit: Math.max(0, Math.floor(Number(fileConfig.globalQuota.monthlyCallLimit) || 0)),
        dailyCreditLimit: Math.max(0, Math.floor(Number(fileConfig.globalQuota.dailyCreditLimit) || 0)),
        monthlyCreditLimit: Math.max(0, Math.floor(Number(fileConfig.globalQuota.monthlyCreditLimit) || 0)),
      } : undefined;

      const server = new PayGateServer({
        serverCommand,
        serverArgs,
        port,
        defaultCreditsPerCall: price,
        globalRateLimitPerMin: rateLimit,
        name,
        shadowMode: !!shadowMode,
        toolPricing,
        webhookUrl,
        webhookSecret,
        refundOnFailure: !!refundOnFailure,
        globalQuota,
        oauth: fileConfig.oauth,
      }, adminKey, stateFile, remoteUrl, stripeSecret, multiServers, redisUrl);

      // Import keys from CLI flags
      if (flags['import-key']) {
        const pairs = flags['import-key'].split(',');
        for (const pair of pairs) {
          const [key, creditsStr] = pair.split(':');
          if (key && creditsStr) {
            server.gate.store.importKey(key.trim(), 'imported', parseInt(creditsStr.trim(), 10));
          }
        }
      }

      // Import keys from config file
      if (fileConfig.importKeys) {
        for (const [key, credits] of Object.entries(fileConfig.importKeys)) {
          server.gate.store.importKey(key, 'imported', credits);
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

        // Build backend display string
        let backendDisplay: string;
        if (isMultiServer) {
          const prefixes = multiServers!.map(s => s.prefix).join(', ');
          backendDisplay = `multi (${multiServers!.length}) → ${prefixes}`.slice(0, 35);
        } else if (remoteUrl) {
          backendDisplay = ('HTTP → ' + remoteUrl.slice(0, 28));
        } else {
          backendDisplay = ('stdio → ' + (serverCmd || serverCommand).slice(0, 27));
        }

        console.log(`
  ╔══════════════════════════════════════════════════╗
  ║         PayGate MCP — Server Running             ║
  ╠══════════════════════════════════════════════════╣
  ║                                                  ║
  ║  Endpoint:   http://localhost:${String(result.port).padEnd(5)}              ║
  ║  Admin Key:  ${result.adminKey.slice(0, 20)}...       ║
  ║  Backend:    ${backendDisplay.padEnd(35)}║
  ║                                                  ║
  ║  Pricing:    ${String(price).padEnd(3)} credit(s) per tool call       ║
  ║  Rate Limit: ${String(rateLimit).padEnd(3)} calls/min per key          ║
  ║  Shadow:     ${String(!!shadowMode).padEnd(5)}                            ║
  ║  Persist:    ${(stateFile ? stateFile.slice(0, 33) : 'off (in-memory)').padEnd(35)}║
  ║  Stripe:     ${(stripeSecret ? 'enabled (/stripe/webhook)' : 'off').padEnd(35)}║
  ║  Refund:     ${String(!!refundOnFailure).padEnd(35)}║
  ║  Webhook:    ${(webhookUrl ? webhookUrl.slice(0, 33) : 'off').padEnd(35)}║
  ║  Signed:     ${(webhookSecret ? 'HMAC-SHA256' : 'off').padEnd(35)}║
  ║  Redis:      ${(redisUrl ? redisUrl.slice(0, 33) : 'off (in-memory)').padEnd(35)}║
  ║                                                  ║
  ╠══════════════════════════════════════════════════╣
  ║  POST /mcp       — JSON-RPC (X-API-Key header)  ║
  ║  GET  /dashboard — Admin web UI (open in browser)║
  ║  GET  /balance   — Client balance (X-API-Key)    ║
  ║  POST /keys      — Create key (X-Admin-Key)      ║
  ║  POST /topup     — Add credits (X-Admin-Key)     ║
  ║  POST /limits    — Set spending limit (Admin)     ║
  ╚══════════════════════════════════════════════════╝
`);

        // Show multi-server details
        if (isMultiServer) {
          console.log('  Multi-server backends:');
          for (const s of multiServers!) {
            const transport = s.remoteUrl ? `HTTP → ${s.remoteUrl}` : `stdio → ${s.serverCommand} ${(s.serverArgs || []).join(' ')}`;
            console.log(`    ${s.prefix}: ${transport}`);
          }
          console.log('');
        }

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
      console.log(`paygate-mcp v${PKG_VERSION}`);
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
