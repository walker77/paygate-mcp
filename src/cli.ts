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
import { validateConfig, formatDiagnostics, ValidatableConfig } from './config-validator';
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
    paygate-mcp validate --config <path>              # validate config without starting
    paygate-mcp version                               # print version

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
    --webhook-retries <n>  Max retries for failed webhook deliveries (default: 5)
    --refund-on-failure    Refund credits when downstream tool call fails
    --redis-url <url>      Redis URL for distributed state (e.g. "redis://localhost:6379")
    --header <k:v>         Custom response header (repeatable, e.g. "X-Frame-Options:DENY")
    --trusted-proxies <s>  Trusted proxy IPs/CIDRs, comma-separated (e.g. "10.0.0.0/8,172.16.0.0/12")
    --dry-run              Start, discover tools, print pricing table, then exit
    --log-level <s>        Log level: debug, info, warn, error, silent (default: info)
    --log-format <s>       Log format: text (human-readable) or json (structured) (default: text)
    --request-timeout <n>  Max request time in ms (default: 30000, 0=no timeout)
    --headers-timeout <n>  Max header receive time in ms (default: 10000)
    --keepalive-timeout <n> Idle connection timeout in ms (default: 65000)
    --max-requests-per-socket <n>  Max HTTP requests per socket (default: 0=unlimited)

  ENVIRONMENT VARIABLES (override defaults, overridden by CLI flags):
    PAYGATE_SERVER         MCP server command (same as --server)
    PAYGATE_REMOTE_URL     Remote MCP server URL (same as --remote-url)
    PAYGATE_CONFIG         Config file path (same as --config)
    PAYGATE_PORT           HTTP port (same as --port)
    PAYGATE_PRICE          Credits per call (same as --price)
    PAYGATE_RATE_LIMIT     Max calls/min (same as --rate-limit)
    PAYGATE_NAME           Server display name (same as --name)
    PAYGATE_SHADOW         Set to "true" for shadow mode (same as --shadow)
    PAYGATE_ADMIN_KEY      Admin key (same as --admin-key)
    PAYGATE_TOOL_PRICE     Per-tool pricing (same as --tool-price)
    PAYGATE_STATE_FILE     State file path (same as --state-file)
    PAYGATE_STRIPE_SECRET  Stripe webhook secret (same as --stripe-secret)
    PAYGATE_WEBHOOK_URL    Webhook URL (same as --webhook-url)
    PAYGATE_WEBHOOK_SECRET Webhook HMAC secret (same as --webhook-secret)
    PAYGATE_WEBHOOK_RETRIES Max retries (same as --webhook-retries)
    PAYGATE_REFUND_ON_FAILURE Set to "true" (same as --refund-on-failure)
    PAYGATE_REDIS_URL      Redis URL (same as --redis-url)
    PAYGATE_DRY_RUN        Set to "true" for dry run (same as --dry-run)
    PAYGATE_CORS_ORIGIN    CORS allowed origin(s), comma-separated (same as --cors-origin)
    PAYGATE_CUSTOM_HEADERS Custom response headers, comma-separated k:v (same as --header)
    PAYGATE_TRUSTED_PROXIES Trusted proxy IPs/CIDRs, comma-separated (same as --trusted-proxies)
    PAYGATE_LOG_LEVEL      Log level (same as --log-level)
    PAYGATE_LOG_FORMAT     Log format (same as --log-format)
    PAYGATE_REQUEST_TIMEOUT  Max request time in ms (same as --request-timeout)
    PAYGATE_HEADERS_TIMEOUT  Max header receive time in ms (same as --headers-timeout)
    PAYGATE_KEEPALIVE_TIMEOUT Idle connection timeout in ms (same as --keepalive-timeout)
    PAYGATE_MAX_REQUESTS_PER_SOCKET Max requests per socket (same as --max-requests-per-socket)

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

    # Validate a config file before starting
    paygate-mcp validate --config paygate.json

    # Dry run — discover tools and print pricing, then exit
    paygate-mcp wrap --server "node server.js" --dry-run

    # Docker / K8s: configure entirely via environment variables
    PAYGATE_SERVER="node server.js" PAYGATE_PORT=8080 PAYGATE_ADMIN_KEY=secret paygate-mcp wrap
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
  webhookMaxRetries?: number;
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
  /** CORS configuration */
  cors?: {
    origin: string | string[];
    credentials?: boolean;
    maxAge?: number;
  };
  /** Custom response headers applied to all HTTP responses */
  customHeaders?: Record<string, string>;
  /** Trusted proxy IPs/CIDRs for accurate X-Forwarded-For extraction */
  trustedProxies?: string[];
  /** Log level: debug, info, warn, error, silent */
  logLevel?: string;
  /** Log format: text or json */
  logFormat?: string;
  /** Max time (ms) to complete a request. Default: 30000 */
  requestTimeoutMs?: number;
  /** Max time (ms) to receive request headers. Default: 10000 */
  headersTimeoutMs?: number;
  /** Keep-alive timeout (ms) for idle connections. Default: 65000 */
  keepAliveTimeoutMs?: number;
  /** Max HTTP requests per socket. 0 = unlimited. Default: 0 */
  maxRequestsPerSocket?: number;
}

// ─── Env Var Helpers ─────────────────────────────────────────────────────────

/**
 * Read a PAYGATE_* environment variable. Returns undefined if not set.
 * Priority: CLI flags > env vars > config file > defaults.
 */
function env(name: string): string | undefined {
  return process.env[name] || undefined;
}

/**
 * Map of PAYGATE_* env vars to their config equivalents.
 * Listed here for documentation / --help output.
 */
export const ENV_VAR_MAP: Record<string, string> = {
  PAYGATE_SERVER: '--server (MCP server command)',
  PAYGATE_REMOTE_URL: '--remote-url (remote MCP server URL)',
  PAYGATE_CONFIG: '--config (config file path)',
  PAYGATE_PORT: '--port (HTTP port)',
  PAYGATE_PRICE: '--price (default credits per call)',
  PAYGATE_RATE_LIMIT: '--rate-limit (max calls/min)',
  PAYGATE_NAME: '--name (server display name)',
  PAYGATE_SHADOW: '--shadow (shadow mode, set to "true")',
  PAYGATE_ADMIN_KEY: '--admin-key (admin key)',
  PAYGATE_TOOL_PRICE: '--tool-price (per-tool pricing)',
  PAYGATE_STATE_FILE: '--state-file (persistence path)',
  PAYGATE_STRIPE_SECRET: '--stripe-secret (Stripe webhook secret)',
  PAYGATE_WEBHOOK_URL: '--webhook-url (webhook endpoint)',
  PAYGATE_WEBHOOK_SECRET: '--webhook-secret (HMAC signing secret)',
  PAYGATE_WEBHOOK_RETRIES: '--webhook-retries (max retry attempts)',
  PAYGATE_REFUND_ON_FAILURE: '--refund-on-failure (set to "true")',
  PAYGATE_REDIS_URL: '--redis-url (Redis URL)',
  PAYGATE_DRY_RUN: '--dry-run (set to "true")',
  PAYGATE_CORS_ORIGIN: '--cors-origin (CORS allowed origin(s), comma-separated)',
  PAYGATE_CUSTOM_HEADERS: '--header (custom response headers, comma-separated k:v)',
  PAYGATE_TRUSTED_PROXIES: '--trusted-proxies (trusted proxy IPs/CIDRs, comma-separated)',
  PAYGATE_LOG_LEVEL: '--log-level (log level: debug/info/warn/error/silent)',
  PAYGATE_LOG_FORMAT: '--log-format (log format: text/json)',
  PAYGATE_REQUEST_TIMEOUT: '--request-timeout (max request time in ms, default: 30000)',
  PAYGATE_HEADERS_TIMEOUT: '--headers-timeout (max header receive time in ms, default: 10000)',
  PAYGATE_KEEPALIVE_TIMEOUT: '--keepalive-timeout (idle connection timeout in ms, default: 65000)',
  PAYGATE_MAX_REQUESTS_PER_SOCKET: '--max-requests-per-socket (pipelining limit, 0=unlimited, default: 0)',
};

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);

  switch (command) {
    case 'wrap': {
      // Load config file if specified (CLI --config or PAYGATE_CONFIG env var)
      let fileConfig: ConfigFile = {};
      const configPath = flags['config'] || env('PAYGATE_CONFIG');
      if (configPath) {
        try {
          const raw = readFileSync(configPath, 'utf-8');
          fileConfig = JSON.parse(raw);
        } catch (err) {
          console.error(`Error loading config file: ${(err as Error).message}`);
          process.exit(1);
        }
      }

      // ─── Config validation ─────────────────────────────────────────────────
      // Build a merged config object for validation (config file + env vars + CLI flags)
      // Priority: CLI flags > env vars > config file
      const serverFlag = flags['server'] || env('PAYGATE_SERVER');
      const remoteUrlFlag = flags['remote-url'] || env('PAYGATE_REMOTE_URL');
      const portFlag = flags['port'] || env('PAYGATE_PORT');
      const priceFlag = flags['price'] || env('PAYGATE_PRICE');
      const rateLimitFlag = flags['rate-limit'] || env('PAYGATE_RATE_LIMIT');
      const webhookUrlFlag = flags['webhook-url'] || env('PAYGATE_WEBHOOK_URL');
      const webhookSecretFlag = flags['webhook-secret'] || env('PAYGATE_WEBHOOK_SECRET');
      const webhookRetriesFlag = flags['webhook-retries'] || env('PAYGATE_WEBHOOK_RETRIES');
      const redisUrlFlag = flags['redis-url'] || env('PAYGATE_REDIS_URL');
      const shadowFlag = ('shadow' in flags) || env('PAYGATE_SHADOW') === 'true';

      const mergedForValidation: ValidatableConfig = {
        ...fileConfig,
        ...(serverFlag ? { serverCommand: serverFlag.split(/\s+/)[0] } : {}),
        ...(remoteUrlFlag ? { remoteUrl: remoteUrlFlag } : {}),
        ...(portFlag ? { port: parseInt(portFlag, 10) } : {}),
        ...(priceFlag ? { defaultCreditsPerCall: parseInt(priceFlag, 10) } : {}),
        ...(rateLimitFlag ? { globalRateLimitPerMin: parseInt(rateLimitFlag, 10) } : {}),
        ...(webhookUrlFlag ? { webhookUrl: webhookUrlFlag } : {}),
        ...(webhookSecretFlag ? { webhookSecret: webhookSecretFlag } : {}),
        ...(webhookRetriesFlag ? { webhookMaxRetries: parseInt(webhookRetriesFlag, 10) } : {}),
        ...(redisUrlFlag ? { redisUrl: redisUrlFlag } : {}),
        ...(shadowFlag ? { shadowMode: true } : {}),
      };
      const configDiags = validateConfig(mergedForValidation);
      const configErrors = configDiags.filter(d => d.level === 'error');
      if (configErrors.length > 0) {
        console.error(formatDiagnostics(configDiags));
        process.exit(1);
      }
      // Print warnings (if any) but continue
      const configWarnings = configDiags.filter(d => d.level === 'warning');
      if (configWarnings.length > 0) {
        console.warn(formatDiagnostics(configWarnings.map(w => ({ ...w }))));
      }

      // Multi-server mode check
      const multiServers: ServerBackendConfig[] | undefined = fileConfig.servers;
      const isMultiServer = multiServers && multiServers.length > 0;

      // Resolve with priority: CLI flags > env vars > config file > defaults
      const serverCmd = serverFlag || (fileConfig.serverCommand ? [fileConfig.serverCommand, ...(fileConfig.serverArgs || [])].join(' ') : '');
      const remoteUrl = remoteUrlFlag || fileConfig.remoteUrl;

      if (!serverCmd && !remoteUrl && !isMultiServer) {
        console.error('Error: --server, --remote-url, PAYGATE_SERVER, PAYGATE_REMOTE_URL, or --config (with servers[]) is required.\n');
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
      if (serverFlag) {
        const parts = serverFlag.split(/\s+/);
        serverCommand = parts[0];
        serverArgs = parts.slice(1);
      }

      const nameFlag = flags['name'] || env('PAYGATE_NAME');
      const adminKeyFlag = flags['admin-key'] || env('PAYGATE_ADMIN_KEY');
      const toolPriceFlag = flags['tool-price'] || env('PAYGATE_TOOL_PRICE');
      const stateFileFlag = flags['state-file'] || env('PAYGATE_STATE_FILE');
      const stripeSecretFlag = flags['stripe-secret'] || env('PAYGATE_STRIPE_SECRET');
      const refundFlag = flags['refund-on-failure'] === 'true' || 'refund-on-failure' in flags || env('PAYGATE_REFUND_ON_FAILURE') === 'true';
      const corsOriginFlag = flags['cors-origin'] || env('PAYGATE_CORS_ORIGIN');
      const headerFlag = flags['header'] || env('PAYGATE_CUSTOM_HEADERS');
      const trustedProxiesFlag = flags['trusted-proxies'] || env('PAYGATE_TRUSTED_PROXIES');
      const logLevelFlag = flags['log-level'] || env('PAYGATE_LOG_LEVEL');
      const logFormatFlag = flags['log-format'] || env('PAYGATE_LOG_FORMAT');
      const requestTimeoutFlag = flags['request-timeout'] || env('PAYGATE_REQUEST_TIMEOUT');
      const headersTimeoutFlag = flags['headers-timeout'] || env('PAYGATE_HEADERS_TIMEOUT');
      const keepaliveTimeoutFlag = flags['keepalive-timeout'] || env('PAYGATE_KEEPALIVE_TIMEOUT');
      const maxReqPerSocketFlag = flags['max-requests-per-socket'] || env('PAYGATE_MAX_REQUESTS_PER_SOCKET');

      const port = parseInt(portFlag || String(fileConfig.port || 3402), 10);
      const price = parseInt(priceFlag || String(fileConfig.defaultCreditsPerCall || 1), 10);
      const rateLimit = parseInt(rateLimitFlag || String(fileConfig.globalRateLimitPerMin || 60), 10);
      const name = nameFlag || fileConfig.serverCommand && 'PayGate MCP Server' || 'PayGate MCP Server';
      const shadowMode = shadowFlag || fileConfig.shadowMode || false;
      const adminKey = adminKeyFlag || fileConfig.adminKey;
      const toolPricing = toolPriceFlag ? parseToolPricing(toolPriceFlag) : (fileConfig.toolPricing || {});
      const stateFile = stateFileFlag || fileConfig.stateFile;
      const stripeSecret = stripeSecretFlag || fileConfig.stripeWebhookSecret;
      const webhookUrl = webhookUrlFlag || fileConfig.webhookUrl || null;
      const webhookSecret = webhookSecretFlag || fileConfig.webhookSecret || null;
      const webhookMaxRetries = Math.max(0, Math.floor(Number(webhookRetriesFlag || fileConfig.webhookMaxRetries) || 5));
      const refundOnFailure = refundFlag || fileConfig.refundOnFailure || false;
      const redisUrl = redisUrlFlag || fileConfig.redisUrl || undefined;

      // Parse global quota from config file
      const globalQuota = fileConfig.globalQuota ? {
        dailyCallLimit: Math.max(0, Math.floor(Number(fileConfig.globalQuota.dailyCallLimit) || 0)),
        monthlyCallLimit: Math.max(0, Math.floor(Number(fileConfig.globalQuota.monthlyCallLimit) || 0)),
        dailyCreditLimit: Math.max(0, Math.floor(Number(fileConfig.globalQuota.dailyCreditLimit) || 0)),
        monthlyCreditLimit: Math.max(0, Math.floor(Number(fileConfig.globalQuota.monthlyCreditLimit) || 0)),
      } : undefined;

      // Parse CORS origin from CLI/env or config file
      const corsConfig: { origin: string | string[]; credentials?: boolean; maxAge?: number } | undefined =
        corsOriginFlag
          ? { origin: corsOriginFlag.includes(',') ? corsOriginFlag.split(',').map((s: string) => s.trim()) : corsOriginFlag }
          : fileConfig.cors;

      // Parse custom headers from CLI/env or config file
      const customHeaders: Record<string, string> | undefined = headerFlag
        ? Object.fromEntries(
            headerFlag.split(',').map((h: string) => {
              const idx = h.indexOf(':');
              return idx > 0 ? [h.slice(0, idx).trim(), h.slice(idx + 1).trim()] : [h.trim(), ''];
            }).filter(([k]: string[]) => k.length > 0)
          )
        : fileConfig.customHeaders;

      // Parse trusted proxies from CLI/env or config file
      const trustedProxies: string[] | undefined = trustedProxiesFlag
        ? trustedProxiesFlag.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0)
        : fileConfig.trustedProxies;

      // Log level/format: CLI > env > config > defaults
      const logLevel = (logLevelFlag || fileConfig.logLevel || 'info') as any;
      const logFormat = (logFormatFlag || fileConfig.logFormat || 'text') as any;

      // Server timeout configuration: CLI > env > config > defaults (set in server.ts)
      const requestTimeoutMs = parseInt(requestTimeoutFlag || String(fileConfig.requestTimeoutMs || 0), 10) || undefined;
      const headersTimeoutMs = parseInt(headersTimeoutFlag || String(fileConfig.headersTimeoutMs || 0), 10) || undefined;
      const keepAliveTimeoutMs = parseInt(keepaliveTimeoutFlag || String(fileConfig.keepAliveTimeoutMs || 0), 10) || undefined;
      const maxRequestsPerSocket = parseInt(maxReqPerSocketFlag || String(fileConfig.maxRequestsPerSocket || 0), 10) || undefined;

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
        webhookMaxRetries,
        refundOnFailure: !!refundOnFailure,
        globalQuota,
        oauth: fileConfig.oauth,
        cors: corsConfig,
        customHeaders,
        trustedProxies,
        logLevel,
        logFormat,
        requestTimeoutMs,
        headersTimeoutMs,
        keepAliveTimeoutMs,
        maxRequestsPerSocket,
      }, adminKey, stateFile, remoteUrl, stripeSecret, multiServers, redisUrl);

      // Wire config file path for hot-reload support
      if (configPath) {
        server.setConfigPath(configPath);
      }

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

      // Handle graceful shutdown (drain in-flight requests, then teardown)
      let shuttingDown = false;
      const shutdown = async (reason?: string) => {
        if (shuttingDown) return; // prevent double-signal
        shuttingDown = true;
        console.log(`\nGraceful shutdown initiated${reason ? ` (${reason})` : ''}…`);
        await server.gracefulStop(30_000);
        process.exit(reason ? 1 : 0);
      };
      process.on('SIGINT', () => shutdown());
      process.on('SIGTERM', () => shutdown());

      // Global error handlers — prevent silent crashes in production
      process.on('unhandledRejection', (reason: unknown) => {
        console.error('[paygate] Unhandled promise rejection:', reason);
        shutdown('unhandled rejection');
      });
      process.on('uncaughtException', (error: Error) => {
        console.error('[paygate] Uncaught exception:', error);
        shutdown('uncaught exception');
      });

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

        // ─── Dry run mode ─────────────────────────────────────────────────
        const isDryRun = flags['dry-run'] === 'true' || 'dry-run' in flags || env('PAYGATE_DRY_RUN') === 'true';
        if (isDryRun) {
          console.log('  ── DRY RUN ──────────────────────────────────────');
          console.log('  Discovering tools from backend…\n');

          // Give the backend a moment to fully initialize
          await new Promise(r => setTimeout(r, 1000));

          // Discover tools by sending a tools/list request through the handler
          try {
            const handler = (server as any).handler;
            const toolsResponse = await handler.handleRequest(
              { jsonrpc: '2.0', id: 'dry-run-1', method: 'tools/list', params: {} },
              null // no API key needed for tools/list
            );

            const tools: Array<{ name: string; description?: string }> =
              (toolsResponse?.result as any)?.tools || [];

            if (tools.length === 0) {
              console.log('  No tools discovered.\n');
            } else {
              console.log(`  Discovered ${tools.length} tool(s):\n`);
              console.log('  ' + '─'.repeat(60));
              console.log('  ' + 'Tool'.padEnd(30) + 'Credits/Call'.padEnd(15) + 'Rate Limit');
              console.log('  ' + '─'.repeat(60));

              for (const tool of tools) {
                const tp = toolPricing[tool.name] as any;
                const credits = tp?.creditsPerCall ?? price;
                const rl = tp?.rateLimitPerMin ?? rateLimit;
                const rlDisplay = rl === 0 ? 'unlimited' : `${rl}/min`;
                console.log('  ' + tool.name.padEnd(30) + String(credits).padEnd(15) + rlDisplay);
              }
              console.log('  ' + '─'.repeat(60));
              console.log(`\n  Default price: ${price} credit(s) per call`);
              console.log(`  Global rate limit: ${rateLimit === 0 ? 'unlimited' : rateLimit + '/min'}`);
            }
          } catch (err) {
            console.log(`  Could not discover tools: ${(err as Error).message}`);
          }

          console.log('\n  Dry run complete — shutting down.\n');
          await server.stop();
          process.exit(0);
        }
      } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
      }
      break;
    }

    case 'validate': {
      const configPath = flags['config'];
      if (!configPath) {
        console.error('Error: --config <path> is required for validate command.\n');
        printUsage();
        process.exit(1);
      }

      let rawConfig: ValidatableConfig;
      try {
        const raw = readFileSync(configPath, 'utf-8');
        rawConfig = JSON.parse(raw);
      } catch (err) {
        console.error(`Error loading config file: ${(err as Error).message}`);
        process.exit(1);
      }

      const diags = validateConfig(rawConfig);
      console.log(formatDiagnostics(diags));

      const errors = diags.filter(d => d.level === 'error');
      process.exit(errors.length > 0 ? 1 : 0);
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

// Only run main() when executed directly (not when imported by tests)
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
