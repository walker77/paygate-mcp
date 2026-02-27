/**
 * PayGateServer — HTTP server that exposes the gated MCP proxy.
 *
 * Endpoints:
 *   POST /mcp     — JSON-RPC endpoint (MCP Streamable HTTP transport)
 *   GET  /status  — Dashboard / usage summary
 *   POST /keys    — Create API key (supports namespace param)
 *   GET  /keys    — List API keys (supports ?namespace= filter)
 *   POST /topup   — Add credits to a key
 *   GET  /namespaces — List all namespaces with stats
 *
 * API key is sent via X-API-Key header on /mcp endpoint.
 * Admin endpoints (/keys, /topup, /status) require X-Admin-Key header.
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { PayGateConfig, JsonRpcRequest, ServerBackendConfig, DEFAULT_CONFIG } from './types';
import { validateConfig, ValidatableConfig } from './config-validator';

/** Read version from package.json at runtime */
const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
})();
import { Gate } from './gate';
import { McpProxy } from './proxy';
import { HttpMcpProxy } from './http-proxy';
import { MultiServerRouter } from './router';
import { StripeWebhookHandler } from './stripe';
import { OAuthProvider } from './oauth';
import { SessionManager, writeSseHeaders, writeSseEvent, writeSseKeepAlive } from './session';
import { AuditLogger, maskKeyForAudit } from './audit';
import { CreditLedger } from './credit-ledger';
import { ToolRegistry } from './registry';
import { MetricsCollector } from './metrics';
import { getDashboardHtml } from './dashboard';
import { AnalyticsEngine } from './analytics';
import { AlertEngine, Alert } from './alerts';
import { TeamManager } from './teams';
import { RedisClient, parseRedisUrl } from './redis-client';
import { RedisSync } from './redis-sync';
import { ScopedTokenManager } from './tokens';
import { AdminKeyManager, AdminRole, ROLE_HIERARCHY } from './admin-keys';
import { PluginManager, PayGatePlugin, PluginToolContext } from './plugin';
import { KeyGroupManager } from './groups';
import { WebhookRouter } from './webhook-router';
import { ExpiryScanner } from './expiry-scanner';
import { KeyTemplateManager } from './key-templates';

/** Max request body size: 1MB */
const MAX_BODY_SIZE = 1_048_576;

/** Generate a unique request ID (16 hex chars = 8 bytes of randomness) */
export function generateRequestId(): string {
  return `req_${randomBytes(8).toString('hex')}`;
}

/** Extract request ID from an IncomingMessage (set by PayGateServer handleRequest) */
export function getRequestId(req: IncomingMessage): string | undefined {
  return (req as any)._requestId;
}

/**
 * Resolve the real client IP from a request, accounting for trusted proxies.
 *
 * When trustedProxies is empty/undefined: returns the first X-Forwarded-For value
 * or the socket remote address (current behavior).
 *
 * When trustedProxies is set: walks X-Forwarded-For from right to left, skipping
 * any IPs that match the trusted proxy list (exact match or CIDR), and returns
 * the first non-trusted IP. Falls back to socket remote address.
 */
export function resolveClientIp(req: IncomingMessage, trustedProxies?: string[]): string {
  const socketIp = req.socket.remoteAddress || '';
  const forwardedFor = req.headers['x-forwarded-for'] as string | undefined;

  if (!forwardedFor) return socketIp;

  const ips = forwardedFor.split(',').map(ip => ip.trim()).filter(ip => ip.length > 0);

  if (!trustedProxies || trustedProxies.length === 0) {
    // Default behavior: first IP in chain
    return ips[0] || socketIp;
  }

  // Walk from right to left, skip trusted proxies, return first non-trusted
  for (let i = ips.length - 1; i >= 0; i--) {
    if (!ipMatchesList(ips[i], trustedProxies)) {
      return ips[i];
    }
  }

  // All IPs were trusted proxies; fall back to socket IP
  return socketIp;
}

/** Check if an IP matches any entry in a list (exact or CIDR match). */
function ipMatchesList(ip: string, list: string[]): boolean {
  for (const entry of list) {
    if (entry.includes('/')) {
      if (matchCidrEntry(ip, entry)) return true;
    } else if (entry === ip) {
      return true;
    }
  }
  return false;
}

/** Match an IPv4 address against a CIDR range. */
function matchCidrEntry(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  if (isNaN(bits) || bits < 0 || bits > 32) return false;

  const ipNum = ipToNum(ip);
  const rangeNum = ipToNum(range);
  if (ipNum === null || rangeNum === null) return false;

  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
}

/** Convert an IPv4 address string to a 32-bit number. */
function ipToNum(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    num = (num << 8) | n;
  }
  return num >>> 0;
}

/** Union type for both proxy backends */
type ProxyBackend = McpProxy | HttpMcpProxy;

/** Common interface for request handling (single proxy or multi-server router) */
interface RequestHandler {
  handleRequest(request: JsonRpcRequest, apiKey: string | null, clientIp?: string, scopedTokenTools?: string[]): Promise<JsonRpcResponse>;
  handleBatchRequest(calls: import('./types').BatchToolCall[], batchId: string | number | undefined, apiKey: string | null, clientIp?: string, scopedTokenTools?: string[]): Promise<JsonRpcResponse>;
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly isRunning: boolean;
}

import { JsonRpcResponse } from './types';

export class PayGateServer {
  readonly gate: Gate;
  /** Single-server proxy (when not in multi-server mode) */
  readonly proxy: ProxyBackend | null;
  /** Multi-server router (when servers[] config is provided) */
  readonly router: MultiServerRouter | null;
  private server: Server | null = null;
  private readonly config: PayGateConfig;
  /** Admin key manager (multiple keys with role-based permissions) */
  readonly adminKeys: AdminKeyManager;
  /** The bootstrap admin key (from constructor or auto-generated) */
  private readonly bootstrapAdminKey: string;
  private stripeHandler: StripeWebhookHandler | null = null;
  /** OAuth 2.1 provider (null if OAuth is not enabled) */
  readonly oauth: OAuthProvider | null = null;
  /** Session manager for Streamable HTTP transport */
  readonly sessions: SessionManager;
  /** Structured audit log */
  readonly audit: AuditLogger;
  /** Tool registry for pricing discovery */
  readonly registry: ToolRegistry;
  /** Prometheus-compatible metrics collector */
  readonly metrics: MetricsCollector;
  /** Time-series analytics engine */
  readonly analytics: AnalyticsEngine;
  /** Alert engine for proactive monitoring */
  readonly alerts: AlertEngine;
  /** Team/organization manager */
  readonly teams: TeamManager;
  /** Redis sync adapter for distributed state (null if not using Redis) */
  readonly redisSync: RedisSync | null = null;
  /** Scoped token manager for short-lived delegated tokens */
  readonly tokens: ScopedTokenManager;
  /** Plugin manager for extensible middleware hooks */
  readonly plugins: PluginManager;
  readonly groups: KeyGroupManager;
  /** Background key expiry scanner */
  readonly expiryScanner: ExpiryScanner;
  /** Key template manager for reusable key presets */
  readonly templates: KeyTemplateManager;
  /** Per-key credit mutation history */
  readonly creditLedger: CreditLedger;
  /** Server start time (ms since epoch) */
  private readonly startedAt: number = Date.now();
  /** Whether the server is draining (shutting down gracefully) */
  private draining = false;
  /** Whether the server is in maintenance mode (rejects /mcp with 503) */
  private maintenanceMode = false;
  /** Custom message shown during maintenance mode */
  private maintenanceMessage = 'Server is under maintenance';
  /** Timestamp when maintenance mode was enabled */
  private maintenanceSince: string | null = null;
  /** Active admin SSE event stream connections */
  private adminEventStreams: Set<{ res: import('http').ServerResponse; types: Set<string> | null }> = new Set();
  /** Keepalive timer for admin event streams */
  private adminEventKeepAliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Scheduled actions queue */
  private scheduledActions: Array<{
    id: string;
    key: string;
    action: 'revoke' | 'suspend' | 'topup';
    executeAt: string;
    createdAt: string;
    params?: Record<string, unknown>;
  }> = [];
  /** Timer for checking scheduled actions */
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;
  /** Auto-incrementing schedule ID counter */
  private nextScheduleId = 1;
  /** Credit reservations (holds) */
  private creditReservations: Map<string, {
    id: string;
    key: string;
    credits: number;
    createdAt: string;
    expiresAt: string;
    memo?: string;
  }> = new Map();
  /** Auto-incrementing reservation ID counter */
  private nextReservationId = 1;
  /** Request log — ring buffer of tool call entries */
  private requestLog: Array<{
    id: number;
    timestamp: string;
    tool: string;
    key: string;
    status: 'allowed' | 'denied';
    credits: number;
    durationMs: number;
    denyReason?: string;
    requestId?: string;
  }> = [];
  /** Next request log entry ID */
  private nextRequestLogId = 1;
  /** Max request log entries (ring buffer) */
  private readonly maxRequestLogEntries = 5000;
  /** Number of in-flight /mcp requests */
  private inflight = 0;
  /** Config file path for hot reload (null if not using config file) */
  private configPath: string | null = null;

  /** The active request handler — either proxy or router */
  private get handler(): RequestHandler {
    return (this.router || this.proxy) as RequestHandler;
  }

  constructor(
    config: Partial<PayGateConfig> & { serverCommand: string },
    adminKey?: string,
    statePath?: string,
    remoteUrl?: string,
    stripeWebhookSecret?: string,
    servers?: ServerBackendConfig[],
    redisUrl?: string,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.bootstrapAdminKey = adminKey || `admin_${require('crypto').randomBytes(16).toString('hex')}`;

    // Admin key manager with file persistence (separate from API key state)
    const adminStatePath = statePath ? statePath.replace(/\.json$/, '-admin.json') : undefined;
    this.adminKeys = new AdminKeyManager(adminStatePath);
    this.adminKeys.bootstrap(this.bootstrapAdminKey);

    this.gate = new Gate(this.config, statePath);

    // Multi-server mode: use Router
    if (servers && servers.length > 0) {
      this.router = new MultiServerRouter(this.gate, servers);
      this.proxy = null;
    } else if (remoteUrl) {
      this.proxy = new HttpMcpProxy(this.gate, remoteUrl);
      this.router = null;
    } else {
      this.proxy = new McpProxy(this.gate, this.config.serverCommand, this.config.serverArgs);
      this.router = null;
    }

    if (stripeWebhookSecret) {
      this.stripeHandler = new StripeWebhookHandler(this.gate.store, stripeWebhookSecret);
    }

    // OAuth 2.1 support
    if (this.config.oauth) {
      const oauthStatePath = statePath ? statePath.replace(/\.json$/, '-oauth.json') : undefined;
      this.oauth = new OAuthProvider({
        issuer: this.config.oauth.issuer,
        accessTokenTtl: this.config.oauth.accessTokenTtl,
        refreshTokenTtl: this.config.oauth.refreshTokenTtl,
        scopes: this.config.oauth.scopes,
      }, oauthStatePath);
    }

    // Session manager for SSE streaming
    this.sessions = new SessionManager();

    // Audit logger
    this.audit = new AuditLogger();

    // Wire up admin event stream — broadcast every audit event to connected admin SSE clients
    this.audit.onEvent = (event) => {
      for (const client of this.adminEventStreams) {
        try {
          // Apply type filter if client specified one
          if (client.types && !client.types.has(event.type)) continue;
          client.res.write(`event: audit\ndata: ${JSON.stringify(event)}\n\n`);
        } catch {
          // Connection died — will be cleaned up by 'close' handler
        }
      }
    };

    // Tool registry for pricing discovery
    this.registry = new ToolRegistry(this.config, !!this.oauth);

    // Prometheus-compatible metrics
    this.metrics = new MetricsCollector();
    // Register dynamic gauges that read from live state
    this.metrics.registerGauge('paygate_active_keys_total', 'Number of active (non-revoked) API keys', () => {
      return this.gate.store.listKeys().filter(k => k.active).length;
    });
    this.metrics.registerGauge('paygate_active_sessions_total', 'Number of active MCP sessions', () => {
      return this.sessions.sessionCount;
    });
    this.metrics.registerGauge('paygate_total_credits_available', 'Total credits across all active keys', () => {
      return this.gate.store.listKeys().filter(k => k.active).reduce((sum, k) => sum + k.credits, 0);
    });
    this.metrics.registerGauge('paygate_admin_keys_total', 'Number of active admin keys', () => {
      return this.adminKeys.activeCount;
    });

    // Analytics engine
    this.analytics = new AnalyticsEngine();

    // Alert engine
    this.alerts = new AlertEngine({
      rules: this.config.alertRules || [],
    });
    // Register alert gauge
    this.metrics.registerGauge('paygate_pending_alerts_total', 'Number of pending alerts', () => {
      return this.alerts.pendingCount;
    });

    // Team manager
    this.teams = new TeamManager();
    this.metrics.registerGauge('paygate_active_teams_total', 'Number of active teams', () => {
      return this.teams.listTeams().length;
    });

    // Wire team budget/quota checks into the gate
    this.gate.teamChecker = (apiKey: string, credits: number) => {
      const budgetCheck = this.teams.checkBudget(apiKey, credits);
      if (!budgetCheck.allowed) return budgetCheck;
      return this.teams.checkQuota(apiKey, credits);
    };
    this.gate.teamRecorder = (apiKey: string, credits: number) => {
      this.teams.recordUsage(apiKey, credits);
    };

    // Wire auto-topup hook: audit log + webhook + Redis sync
    this.gate.onAutoTopup = (apiKey: string, amount: number, newBalance: number) => {
      const keyMasked = maskKeyForAudit(apiKey);
      this.creditLedger.record(apiKey, {
        type: 'auto_topup', amount, balanceBefore: newBalance - amount, balanceAfter: newBalance,
      });
      this.audit.log('key.auto_topped_up', 'system', `Auto-topup: added ${amount} credits`, {
        keyMasked, creditsAdded: amount, newBalance,
      });
      this.emitWebhookAdmin('key.auto_topped_up', 'system', {
        keyMasked, creditsAdded: amount, newBalance,
      });
      // Sync to Redis (if configured)
      if (this.redisSync) {
        this.redisSync.atomicTopup(apiKey, amount).catch(() => {});
      }
    };

    // Plugin manager for extensible middleware hooks
    this.plugins = new PluginManager();
    this.gate.pluginManager = this.plugins;
    const groupsStatePath = statePath ? statePath.replace(/\.json$/, '-groups.json') : undefined;
    this.groups = new KeyGroupManager(groupsStatePath);
    this.gate.groupManager = this.groups;
    this.metrics.registerGauge('paygate_plugins_total', 'Number of registered plugins', () => {
      return this.plugins.count;
    });
    this.metrics.registerGauge('paygate_groups_total', 'Number of active key groups', () => {
      return this.groups.count;
    });

    // Key expiry scanner — proactive background scanning for expiring keys
    const scannerConfig = this.config.expiryScanner;
    this.expiryScanner = new ExpiryScanner(scannerConfig ? {
      enabled: scannerConfig.enabled !== false,
      intervalSeconds: scannerConfig.intervalSeconds || 3600,
      thresholds: scannerConfig.thresholds || [604800, 86400, 3600],
    } : undefined);

    // Wire scanner callbacks: audit + webhook
    this.expiryScanner.onWarning = (warning) => {
      const keyMasked = maskKeyForAudit(warning.key);
      this.audit.log('key.expiry_warning', 'system',
        `Key "${warning.name}" expires in ${warning.remainingHuman} (threshold: ${warning.thresholdSeconds}s)`,
        { keyMasked, expiresAt: warning.expiresAt, remainingSeconds: warning.remainingSeconds, thresholdSeconds: warning.thresholdSeconds, alias: warning.alias || null },
      );
      this.emitWebhookAdmin('key.expiry_warning', 'system', {
        keyMasked, keyName: warning.name, alias: warning.alias || null,
        namespace: warning.namespace, expiresAt: warning.expiresAt,
        remainingSeconds: warning.remainingSeconds, remainingHuman: warning.remainingHuman,
        thresholdSeconds: warning.thresholdSeconds,
      });
    };

    // Key template manager for reusable key creation presets
    const templatesStatePath = statePath ? statePath.replace(/\.json$/, '-templates.json') : undefined;
    this.templates = new KeyTemplateManager(templatesStatePath);
    this.creditLedger = new CreditLedger();
    this.metrics.registerGauge('paygate_templates_total', 'Number of key templates', () => {
      return this.templates.count;
    });

    // Scoped token manager (uses bootstrap admin key as signing secret, padded to min length)
    const tokenSecret = this.bootstrapAdminKey.length >= 8
      ? this.bootstrapAdminKey
      : this.bootstrapAdminKey + require('crypto').randomBytes(8).toString('hex');
    this.tokens = new ScopedTokenManager(tokenSecret);

    // Redis distributed state (if configured)
    if (redisUrl) {
      const redisOpts = parseRedisUrl(redisUrl);
      const redisClient = new RedisClient(redisOpts);
      const sync = new RedisSync(redisClient, this.gate.store);
      // Store opts for pub/sub subscriber connection
      (sync as any)._subscriberOpts = redisOpts;
      (this as any).redisSync = sync;

      // Wire Redis hooks: fire-and-forget async operations on every gate event
      this.gate.onUsageEvent = (event) => {
        sync.recordUsage(event).catch(() => {});
      };
      this.gate.onCreditsDeducted = (apiKey, amount) => {
        sync.atomicDeduct(apiKey, amount).catch(() => {});
      };
      // Wire token revocation sync: incoming pub/sub → local revocation list
      sync.onTokenRevoked = (fingerprint, expiresAt, revokedAt, reason) => {
        this.tokens.revocationList.addEntry({ fingerprint, expiresAt, revokedAt, reason });
      };
      // Wire group manager for Redis sync
      sync.groupManager = this.groups;
    }
  }

  /**
   * Set the config file path for hot-reload support.
   * Called by CLI after parsing --config flag.
   */
  setConfigPath(path: string): void {
    this.configPath = path;
  }

  /**
   * Register a plugin for extensible middleware hooks.
   * Plugins run in registration order.
   *
   * @example
   * ```ts
   * server.use({
   *   name: 'custom-pricing',
   *   transformPrice: (tool, base) => tool.startsWith('premium_') ? base * 5 : null,
   * });
   * ```
   */
  use(plugin: PayGatePlugin): this {
    this.plugins.register(plugin);
    return this;
  }

  async start(): Promise<{ port: number; adminKey: string }> {
    // Initialize Redis sync before starting (loads state from Redis + starts pub/sub)
    if (this.redisSync) {
      const subOpts = (this.redisSync as any)._subscriberOpts;
      await this.redisSync.init(subOpts);
      console.log('[paygate] Redis distributed state enabled');
    }

    await this.handler.start();

    // Start the key expiry scanner (proactive background scanning)
    this.expiryScanner.start(() => this.gate.store.getAllRecords());

    // Start scheduled actions executor (checks every 10s)
    this.scheduleTimer = setInterval(() => this.executeScheduledActions(), 10_000);
    this.scheduleTimer.unref();

    // Plugin lifecycle: onStart
    if (this.plugins.count > 0) {
      await this.plugins.executeStart();
    }

    return new Promise((resolve, reject) => {
      this.server = createServer(async (req, res) => {
        try {
          await this.handleRequest(req, res);
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });

      this.server.listen(this.config.port, () => {
        const addr = this.server!.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : this.config.port;
        resolve({ port: actualPort, adminKey: this.bootstrapAdminKey });
      });

      this.server.on('error', reject);
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Request ID: propagate from incoming header or generate new one
    const requestId = (req.headers['x-request-id'] as string) || generateRequestId();
    res.setHeader('X-Request-Id', requestId);
    // Stash on request for downstream access
    (req as any)._requestId = requestId;

    // CORS headers
    const corsConfig = this.config.cors;
    const allowedOrigin = this.resolveCorsOrigin(req, corsConfig);
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-Admin-Key, Mcp-Session-Id, Authorization, X-Request-Id');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Credits-Remaining, X-Request-Id');
    if (corsConfig?.credentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    // Vary header for proper caching when origin is not '*'
    if (allowedOrigin !== '*') {
      res.setHeader('Vary', 'Origin');
    }

    // Custom response headers
    if (this.config.customHeaders) {
      for (const [key, value] of Object.entries(this.config.customHeaders)) {
        res.setHeader(key, value);
      }
    }

    if (req.method === 'OPTIONS') {
      const maxAge = corsConfig?.maxAge ?? 86400;
      res.setHeader('Access-Control-Max-Age', String(maxAge));
      res.writeHead(204);
      res.end();
      return;
    }

    // Plugin: onRequest — let plugins handle custom endpoints before routing
    if (this.plugins.count > 0) {
      const handled = await this.plugins.executeOnRequest(req, res);
      if (handled) return;
    }

    const url = req.url?.split('?')[0] || '/';

    switch (url) {
      case '/mcp':
        if (this.draining) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Server is shutting down' }));
          return;
        }
        if (this.maintenanceMode) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: this.maintenanceMessage }));
          return;
        }
        return this.handleMcp(req, res);
      case '/health':
        return this.handleHealth(req, res);
      case '/info':
        return this.handleInfo(req, res);
      case '/status':
        return this.handleStatus(req, res);
      case '/keys':
        if (req.method === 'POST') return this.handleCreateKey(req, res);
        if (req.method === 'GET') return this.handleListKeys(req, res);
        break;
      case '/keys/revoke':
        return this.handleRevokeKey(req, res);
      case '/keys/suspend':
        return this.handleSuspendKey(req, res);
      case '/keys/resume':
        return this.handleResumeKey(req, res);
      case '/keys/clone':
        return this.handleCloneKey(req, res);
      case '/keys/alias':
        return this.handleSetAlias(req, res);
      case '/keys/notes':
        if (req.method === 'GET') return this.handleGetNotes(req, res);
        if (req.method === 'POST') return this.handleAddNote(req, res);
        if (req.method === 'DELETE') return this.handleDeleteNote(req, res);
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      case '/keys/schedule':
        if (req.method === 'GET') return this.handleGetSchedules(req, res);
        if (req.method === 'POST') return this.handleCreateSchedule(req, res);
        if (req.method === 'DELETE') return this.handleCancelSchedule(req, res);
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      case '/keys/activity':
        if (req.method === 'GET') return this.handleKeyActivity(req, res);
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed. Use GET.' }));
        return;
      case '/keys/reserve':
        if (req.method === 'GET') return this.handleListReservations(req, res);
        if (req.method === 'POST') return this.handleCreateReservation(req, res);
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      case '/keys/reserve/commit':
        if (req.method === 'POST') return this.handleCommitReservation(req, res);
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
        return;
      case '/keys/reserve/release':
        if (req.method === 'POST') return this.handleReleaseReservation(req, res);
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
        return;
      case '/keys/rotate':
        return this.handleRotateKey(req, res);
      case '/keys/acl':
        return this.handleSetAcl(req, res);
      case '/keys/expiry':
        return this.handleSetExpiry(req, res);
      case '/keys/quota':
        return this.handleSetQuota(req, res);
      case '/keys/tags':
        return this.handleSetTags(req, res);
      case '/keys/ip':
        return this.handleSetIpAllowlist(req, res);
      case '/keys/search':
        return this.handleSearchKeysByTag(req, res);
      case '/keys/auto-topup':
        return this.handleSetAutoTopup(req, res);
      case '/keys/usage':
        return this.handleKeyUsage(req, res);
      case '/keys/expiring':
        return this.handleKeysExpiring(req, res);
      case '/keys/stats':
        return this.handleKeyStats(req, res);
      case '/keys/rate-limit-status':
        return this.handleRateLimitStatus(req, res);
      case '/keys/quota-status':
        return this.handleQuotaStatus(req, res);
      case '/keys/credit-history':
        return this.handleCreditHistory(req, res);
      case '/keys/spending-velocity':
        return this.handleSpendingVelocity(req, res);
      case '/keys/compare':
        return this.handleKeyComparison(req, res);
      case '/keys/health':
        return this.handleKeyHealth(req, res);
      case '/keys/dashboard':
        if (req.method === 'GET') return this.handleKeyDashboard(req, res);
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed. Use GET.' }));
        return;
      case '/keys/templates':
        if (req.method === 'GET') return this.handleListTemplates(req, res);
        if (req.method === 'POST') return this.handleCreateTemplate(req, res);
        break;
      case '/keys/templates/delete':
        return this.handleDeleteTemplate(req, res);
      case '/topup':
        return this.handleTopUp(req, res);
      case '/keys/transfer':
        return this.handleCreditTransfer(req, res);
      case '/keys/bulk':
        return this.handleBulkOperations(req, res);
      case '/keys/export':
        return this.handleKeyExport(req, res);
      case '/keys/import':
        return this.handleKeyImport(req, res);
      case '/balance':
        return this.handleBalance(req, res);
      case '/limits':
        return this.handleLimits(req, res);
      case '/usage':
        return this.handleUsage(req, res);
      case '/stripe/webhook':
        return this.handleStripeWebhook(req, res);
      case '/dashboard':
        return this.handleDashboard(req, res);
      case '/audit':
        return this.handleAudit(req, res);
      case '/audit/export':
        return this.handleAuditExport(req, res);
      case '/audit/stats':
        return this.handleAuditStats(req, res);
      case '/requests':
        if (req.method === 'GET') return this.handleRequestLog(req, res);
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed. Use GET.' }));
        return;
      case '/requests/export':
        if (req.method === 'GET') return this.handleRequestLogExport(req, res);
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed. Use GET.' }));
        return;
      case '/requests/dry-run':
        if (req.method === 'POST') return this.handleRequestDryRun(req, res);
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
        return;
      case '/requests/dry-run/batch':
        if (req.method === 'POST') return this.handleRequestDryRunBatch(req, res);
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
        return;
      // ─── Registry / Discovery endpoints ──────────────────────────────
      case '/.well-known/mcp-payment':
        return this.handlePaymentMetadata(req, res);
      case '/pricing':
        return this.handlePricing(req, res);
      case '/metrics':
        return this.handleMetrics(req, res);
      case '/analytics':
        return this.handleAnalytics(req, res);
      case '/tools/stats':
        if (req.method === 'GET') return this.handleToolStats(req, res);
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed. Use GET.' }));
        return;
      case '/tools/available':
        if (req.method === 'GET') return this.handleToolAvailability(req, res);
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed. Use GET.' }));
        return;
      case '/alerts':
        if (req.method === 'GET') return this.handleGetAlerts(req, res);
        if (req.method === 'POST') return this.handleConfigureAlerts(req, res);
        break;
      // ─── Webhook admin endpoints ─────────────────────────────────────
      case '/webhooks/dead-letter':
        if (req.method === 'GET') return this.handleGetDeadLetters(req, res);
        if (req.method === 'DELETE') return this.handleClearDeadLetters(req, res);
        break;
      case '/webhooks/replay':
        return this.handleWebhookReplay(req, res);
      case '/webhooks/stats':
        return this.handleWebhookStats(req, res);
      case '/webhooks/log':
        return this.handleWebhookLog(req, res);
      case '/webhooks/pause':
        return this.handleWebhookPause(req, res);
      case '/webhooks/resume':
        return this.handleWebhookResume(req, res);
      case '/webhooks/test':
        return this.handleWebhookTest(req, res);
      case '/webhooks/filters':
        if (req.method === 'GET') return this.handleListWebhookFilters(req, res);
        if (req.method === 'POST') return this.handleCreateWebhookFilter(req, res);
        break;
      case '/webhooks/filters/update':
        return this.handleUpdateWebhookFilter(req, res);
      case '/webhooks/filters/delete':
        return this.handleDeleteWebhookFilter(req, res);
      // ─── Team management endpoints ────────────────────────────────────
      case '/teams':
        if (req.method === 'GET') return this.handleListTeams(req, res);
        if (req.method === 'POST') return this.handleCreateTeam(req, res);
        break;
      case '/teams/update':
        return this.handleUpdateTeam(req, res);
      case '/teams/delete':
        return this.handleDeleteTeam(req, res);
      case '/teams/assign':
        return this.handleTeamAssignKey(req, res);
      case '/teams/remove':
        return this.handleTeamRemoveKey(req, res);
      case '/teams/usage':
        return this.handleTeamUsage(req, res);
      // ─── Multi-tenant namespace endpoints ──────────────────────────────
      case '/namespaces':
        return this.handleListNamespaces(req, res);
      // ─── Scoped token endpoints ────────────────────────────────────────
      case '/tokens':
        if (req.method === 'POST') return this.handleCreateToken(req, res);
        break;
      case '/tokens/revoke':
        return this.handleRevokeToken(req, res);
      case '/tokens/revoked':
        return this.handleListRevokedTokens(req, res);
      // ─── Admin key management endpoints ──────────────────────────────
      case '/admin/keys':
        if (req.method === 'POST') return this.handleCreateAdminKey(req, res);
        if (req.method === 'GET') return this.handleListAdminKeys(req, res);
        break;
      case '/admin/keys/revoke':
        return this.handleRevokeAdminKey(req, res);
      case '/admin/events':
        return this.handleAdminEventStream(req, res);
      case '/admin/notifications':
        if (req.method === 'GET') return this.handleAdminNotifications(req, res);
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed. Use GET.' }));
        return;
      case '/admin/dashboard':
        if (req.method === 'GET') return this.handleSystemDashboard(req, res);
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed. Use GET.' }));
        return;
      case '/admin/lifecycle':
        if (req.method === 'GET') return this.handleKeyLifecycleReport(req, res);
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed. Use GET.' }));
        return;
      // ─── Plugin endpoints ──────────────────────────────────────────────
      case '/plugins':
        return this.handleListPlugins(req, res);
      case '/groups':
        if (req.method === 'GET') return this.handleListGroups(req, res);
        if (req.method === 'POST') return this.handleCreateGroup(req, res);
        break;
      case '/groups/update':
        return this.handleUpdateGroup(req, res);
      case '/groups/delete':
        return this.handleDeleteGroup(req, res);
      case '/groups/assign':
        return this.handleAssignKeyToGroup(req, res);
      case '/groups/remove':
        return this.handleRemoveKeyFromGroup(req, res);
      // ─── Maintenance mode ──────────────────────────────────────────
      case '/maintenance':
        if (req.method === 'GET') return this.handleGetMaintenance(req, res);
        if (req.method === 'POST') return this.handleSetMaintenance(req, res);
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      // ─── Config endpoints ──────────────────────────────────────────
      case '/config/reload':
        return this.handleConfigReload(req, res);
      case '/config':
        return this.handleConfigExport(req, res);
      // ─── OAuth 2.1 endpoints ─────────────────────────────────────────
      case '/.well-known/oauth-authorization-server':
        return this.handleOAuthMetadata(req, res);
      case '/oauth/register':
        return this.handleOAuthRegister(req, res);
      case '/oauth/authorize':
        return this.handleOAuthAuthorize(req, res);
      case '/oauth/token':
        return this.handleOAuthToken(req, res);
      case '/oauth/revoke':
        return this.handleOAuthRevoke(req, res);
      case '/oauth/clients':
        return this.handleOAuthClients(req, res);
      default:
        // Root — simple info
        if (url === '/' || url === '') {
          return this.handleRoot(req, res);
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  // ─── /mcp — JSON-RPC endpoint (MCP Streamable HTTP transport) ──────────────

  private async handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.inflight++;
    res.on('close', () => { this.inflight--; });

    // Extract request ID (set by handleRequest)
    const requestId = (req as any)._requestId as string;

    // Resolve API key from X-API-Key or Bearer token
    const apiKey = this.resolveApiKey(req);

    // GET /mcp — Open SSE stream for server-to-client notifications
    if (req.method === 'GET') {
      return this.handleMcpSseStream(req, res, apiKey);
    }

    // DELETE /mcp — Terminate session
    if (req.method === 'DELETE') {
      return this.handleMcpDeleteSession(req, res);
    }

    // POST /mcp — JSON-RPC request/response (may return SSE or JSON)
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const body = await this.readBody(req);

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }));
      return;
    }

    // Session management: reuse or create
    let sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !this.sessions.getSession(sessionId)) {
      sessionId = this.sessions.createSession(apiKey);
      this.audit.log('session.created', maskKeyForAudit(apiKey || 'anonymous'), `Session created`, {
        requestId,
        sessionId: sessionId.slice(0, 16) + '...',
      });
    }

    // Extract client IP for IP allowlist checking (trusted proxy-aware)
    const clientIp = resolveClientIp(req, this.config.trustedProxies);

    // Extract scoped token tool restrictions (set by resolveApiKey)
    const scopedTokenTools: string[] | undefined = (req as any)._scopedTokenTools;

    // ─── Batch tool calls ────────────────────────────────────────────────
    if (request.method === 'tools/call_batch') {
      const params = request.params as Record<string, unknown> | undefined;
      const calls = params?.calls as Array<{ name: string; arguments?: Record<string, unknown> }> | undefined;
      if (!calls || !Array.isArray(calls)) {
        const errResp: JsonRpcResponse = {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32602, message: 'Invalid params: "calls" array is required' },
        };
        const rateLimitHeaders = this.buildRateLimitHeaders(apiKey, request);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId, ...rateLimitHeaders });
        res.end(JSON.stringify(errResp));
        return;
      }

      const batchResponse = await this.handler.handleBatchRequest(calls, request.id, apiKey, clientIp, scopedTokenTools);

      // Audit + metrics for batch
      if (batchResponse.error) {
        this.audit.log('gate.deny', maskKeyForAudit(apiKey || 'anonymous'), `Batch denied (${calls.length} calls)`, {
          requestId,
          callCount: calls.length,
          errorCode: batchResponse.error.code,
          reason: batchResponse.error.message,
        });
        for (const call of calls) {
          this.metrics.recordToolCall(call.name, false, 0, 'batch_denied');
        }
      } else {
        const resultData = batchResponse.result as { results?: Array<{ tool: string; error?: unknown; creditsCharged: number }>, totalCreditsCharged?: number };
        this.audit.log('gate.allow', maskKeyForAudit(apiKey || 'anonymous'), `Batch allowed (${calls.length} calls)`, {
          requestId,
          callCount: calls.length,
          totalCredits: resultData?.totalCreditsCharged ?? 0,
        });
        if (resultData?.results) {
          for (const r of resultData.results) {
            this.metrics.recordToolCall(r.tool, !r.error, r.creditsCharged);
          }
        }
      }

      const rateLimitHeaders = this.buildRateLimitHeaders(apiKey, request);
      const accept = req.headers['accept'] || '';
      const wantsSse = accept.includes('text/event-stream');

      if (wantsSse) {
        writeSseHeaders(res, { 'Mcp-Session-Id': sessionId, ...rateLimitHeaders });
        writeSseEvent(res, batchResponse, 'message');
        res.end();
      } else {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': sessionId,
          ...rateLimitHeaders,
        });
        res.end(JSON.stringify(batchResponse));
      }
      return;
    }

    // Plugin: beforeToolCall — let plugins modify the request before forwarding
    let pluginRequest = request;
    if (this.plugins.count > 0 && request.method === 'tools/call') {
      const toolName = (request.params as Record<string, unknown>)?.name as string || '';
      const toolArgs = (request.params as Record<string, unknown>)?.arguments as Record<string, unknown> | undefined;
      const pluginCtx: PluginToolContext = { apiKey, toolName, toolArgs, request };
      pluginRequest = await this.plugins.executeBeforeToolCall(pluginCtx);
    }

    const toolCallStartTime = Date.now();
    let response = await this.handler.handleRequest(pluginRequest, apiKey, clientIp, scopedTokenTools);

    // Plugin: afterToolCall — let plugins modify the response
    if (this.plugins.count > 0 && request.method === 'tools/call') {
      const toolName = (request.params as Record<string, unknown>)?.name as string || '';
      const toolArgs = (request.params as Record<string, unknown>)?.arguments as Record<string, unknown> | undefined;
      const pluginCtx: PluginToolContext = { apiKey, toolName, toolArgs, request };
      response = await this.plugins.executeAfterToolCall(pluginCtx, response);
    }

    // Inject pricing metadata into tools/list responses
    if (request.method === 'tools/list' && response.result) {
      const result = response.result as { tools?: Array<{ name: string; [k: string]: unknown }> };
      if (result.tools && Array.isArray(result.tools)) {
        result.tools = this.registry.injectPricingIntoToolsList(result.tools);
      }
    }

    // Audit + metrics for gate decisions
    if (request.method === 'tools/call') {
      const toolName = (request.params as Record<string, unknown>)?.name as string || 'unknown';
      if (response.error) {
        const reason = response.error.code === -32402 ? 'insufficient_credits'
          : response.error.code === -32001 ? 'rate_limited'
          : response.error.message || 'denied';
        this.audit.log('gate.deny', maskKeyForAudit(apiKey || 'anonymous'), `Denied: ${toolName}`, {
          requestId,
          tool: toolName,
          errorCode: response.error.code,
          reason: response.error.message,
        });
        this.metrics.recordToolCall(toolName, false, 0, reason);
        if (response.error.code === -32001) {
          this.metrics.recordRateLimitHit(toolName);
          // Track rate limit denial for alert spike detection
          if (apiKey) {
            this.alerts.recordRateLimitDenial(apiKey);
          }
        }
      } else {
        this.audit.log('gate.allow', maskKeyForAudit(apiKey || 'anonymous'), `Allowed: ${toolName}`, {
          requestId,
          tool: toolName,
        });
        // Estimate credits from config (actual deduction tracked in gate)
        const price = this.gate.getToolPrice(toolName,
          (request.params as Record<string, unknown>)?.arguments as Record<string, unknown> | undefined);
        this.metrics.recordToolCall(toolName, true, price);
      }
    }

    // Check alert rules after gate evaluation
    if (apiKey && request.method === 'tools/call' && this.alerts.configuredRules.length > 0) {
      const keyRecord = this.gate.store.getKey(apiKey);
      if (keyRecord) {
        const isRateLimited = response.error?.code === -32001;
        const fired = this.alerts.check(apiKey, keyRecord, { rateLimitDenied: isRateLimited });
        // Send alert events via webhook
        for (const alert of fired) {
          this.emitWebhookAdmin('alert.fired', 'system', {
            alertType: alert.type,
            keyPrefix: alert.keyPrefix,
            keyName: alert.keyName,
            message: alert.message,
            threshold: alert.threshold,
            currentValue: alert.currentValue,
            ...alert.metadata,
          });
        }
      }
    }

    // Record request log entry for tools/call
    if (request.method === 'tools/call') {
      const toolName = (request.params as Record<string, unknown>)?.name as string || 'unknown';
      const durationMs = Date.now() - toolCallStartTime;
      const isError = !!response.error;
      let denyReason: string | undefined;
      if (isError) {
        const msg = response.error!.message || '';
        if (msg.includes('rate_limited')) denyReason = 'rate_limited';
        else if (msg.includes('insufficient_credits')) denyReason = 'insufficient_credits';
        else if (msg.includes('invalid_api_key')) denyReason = 'invalid_api_key';
        else if (msg.includes('key_suspended')) denyReason = 'key_suspended';
        else if (msg.includes('api_key_expired')) denyReason = 'api_key_expired';
        else if (msg.includes('tool_not_allowed')) denyReason = 'tool_not_allowed';
        else if (msg.includes('quota_exceeded')) denyReason = 'quota_exceeded';
        else denyReason = msg || 'denied';
      }
      const creditsCharged = isError ? 0 : this.gate.getToolPrice(toolName,
        (request.params as Record<string, unknown>)?.arguments as Record<string, unknown> | undefined);

      const logEntry = {
        id: this.nextRequestLogId++,
        timestamp: new Date().toISOString(),
        tool: toolName,
        key: maskKeyForAudit(apiKey || 'anonymous'),
        status: (isError ? 'denied' : 'allowed') as 'allowed' | 'denied',
        credits: creditsCharged,
        durationMs,
        ...(denyReason ? { denyReason } : {}),
        requestId,
      };
      this.requestLog.push(logEntry);
      // Enforce ring buffer size
      if (this.requestLog.length > this.maxRequestLogEntries) {
        this.requestLog = this.requestLog.slice(-this.maxRequestLogEntries);
      }
    }

    // Build rate limit + credits headers for tools/call responses
    const rateLimitHeaders = this.buildRateLimitHeaders(apiKey, request);

    // Check if client accepts SSE
    const accept = req.headers['accept'] || '';
    const wantsSse = accept.includes('text/event-stream');

    if (wantsSse) {
      // Return response as SSE stream
      writeSseHeaders(res, { 'Mcp-Session-Id': sessionId, ...rateLimitHeaders });
      writeSseEvent(res, response, 'message');
      res.end();
    } else {
      // Standard JSON response
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': sessionId,
        ...rateLimitHeaders,
      });
      res.end(JSON.stringify(response));
    }
  }

  /**
   * GET /mcp — Open an SSE stream for server-to-client notifications.
   * The connection stays open until the client disconnects or session is deleted.
   */
  private handleMcpSseStream(req: IncomingMessage, res: ServerResponse, apiKey: string | null): void {
    const accept = req.headers['accept'] || '';
    if (!accept.includes('text/event-stream')) {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'GET /mcp requires Accept: text/event-stream' }));
      return;
    }

    // Session: reuse or create
    let sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !this.sessions.getSession(sessionId)) {
      sessionId = this.sessions.createSession(apiKey);
    }

    // Register this SSE connection
    const added = this.sessions.addSseConnection(sessionId, res);
    if (!added) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many SSE connections for this session' }));
      return;
    }

    // Start SSE stream
    writeSseHeaders(res, { 'Mcp-Session-Id': sessionId });

    // Send initial endpoint event (helps clients know the session is live)
    writeSseEvent(res, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: { sessionId },
    }, 'message');

    // Keep-alive interval (every 30s)
    const keepAlive = setInterval(() => {
      try {
        writeSseKeepAlive(res);
      } catch {
        clearInterval(keepAlive);
      }
    }, 30_000);

    // Cleanup on close
    req.on('close', () => {
      clearInterval(keepAlive);
    });
  }

  /**
   * DELETE /mcp — Terminate a session.
   */
  private handleMcpDeleteSession(req: IncomingMessage, res: ServerResponse): void {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing Mcp-Session-Id header' }));
      return;
    }

    const destroyed = this.sessions.destroySession(sessionId);
    if (!destroyed) {
      // Per MCP spec, 404 if session doesn't exist
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    this.audit.log('session.destroyed', 'client', `Session terminated`, {
      sessionId: sessionId.slice(0, 16) + '...',
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Session terminated' }));
  }

  /**
   * Resolve API key from X-API-Key header, scoped token, or OAuth Bearer token.
   * Priority: X-API-Key → pgt_ scoped token → OAuth Bearer token.
   * Also stores resolved token metadata for ACL narrowing.
   */
  private resolveApiKey(req: IncomingMessage): string | null {
    let apiKey = (req.headers['x-api-key'] as string) || null;

    // Check if X-API-Key is actually a scoped token
    if (apiKey && ScopedTokenManager.isToken(apiKey)) {
      const validation = this.tokens.validate(apiKey);
      if (validation.valid && validation.payload) {
        // Store token metadata on request for ACL narrowing
        (req as any)._scopedTokenTools = validation.payload.allowedTools;
        return validation.payload.apiKey;
      }
      return null; // Invalid/expired token
    }

    // Check Bearer token (OAuth or scoped token)
    if (!apiKey) {
      const authHeader = req.headers['authorization'] as string;
      if (authHeader?.startsWith('Bearer ')) {
        const bearerToken = authHeader.slice(7);
        // Try scoped token first
        if (ScopedTokenManager.isToken(bearerToken)) {
          const validation = this.tokens.validate(bearerToken);
          if (validation.valid && validation.payload) {
            (req as any)._scopedTokenTools = validation.payload.allowedTools;
            return validation.payload.apiKey;
          }
          return null;
        }
        // Fall back to OAuth
        if (this.oauth) {
          const tokenInfo = this.oauth.validateToken(bearerToken);
          if (tokenInfo) {
            apiKey = tokenInfo.apiKey;
          }
        }
      }
    }

    return apiKey;
  }

  /**
   * Build rate limit response headers for /mcp responses.
   * Returns X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Credits-Remaining.
   */
  private buildRateLimitHeaders(apiKey: string | null, request: JsonRpcRequest): Record<string, string> {
    const headers: Record<string, string> = {};

    if (!apiKey) return headers;

    const keyRecord = this.gate.store.getKey(apiKey);
    if (!keyRecord) return headers;

    // Credits remaining
    headers['X-Credits-Remaining'] = String(keyRecord.credits);

    // Rate limit info — use per-tool limit if this is a tools/call, else global
    const toolName = request.method === 'tools/call'
      ? ((request.params as Record<string, unknown>)?.name as string) || null
      : null;

    const toolPricing = toolName ? this.config.toolPricing[toolName] : undefined;
    const perToolLimit = toolPricing?.rateLimitPerMin || 0;
    const globalLimit = this.config.globalRateLimitPerMin;

    // Pick the most specific limit
    if (perToolLimit > 0 && toolName) {
      const compositeKey = `${apiKey}:tool:${toolName}`;
      const result = this.gate.rateLimiter.checkCustom(compositeKey, perToolLimit);
      headers['X-RateLimit-Limit'] = String(perToolLimit);
      headers['X-RateLimit-Remaining'] = String(Math.max(0, result.remaining));
      headers['X-RateLimit-Reset'] = String(Math.ceil(result.resetInMs / 1000));
    } else if (globalLimit > 0) {
      const result = this.gate.rateLimiter.check(apiKey);
      headers['X-RateLimit-Limit'] = String(globalLimit);
      headers['X-RateLimit-Remaining'] = String(Math.max(0, result.remaining));
      headers['X-RateLimit-Reset'] = String(Math.ceil(result.resetInMs / 1000));
    }

    return headers;
  }

  // ─── / — Root info ──────────────────────────────────────────────────────────

  private handleRoot(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: this.config.name,
      version: PKG_VERSION,
      endpoints: {
        mcp: 'POST /mcp — JSON-RPC (MCP transport). Send X-API-Key header.',
        info: 'GET /info — Server capabilities, features, pricing summary (public)',
        balance: 'GET /balance — Check own credits (requires X-API-Key)',
        dashboard: 'GET /dashboard — Admin web dashboard (browser UI)',
        status: 'GET /status — Usage data JSON (requires X-Admin-Key)',
        createKey: 'POST /keys — Create API key (requires X-Admin-Key)',
        listKeys: 'GET /keys — List API keys with pagination, filtering, sorting (requires X-Admin-Key)',
        revokeKey: 'POST /keys/revoke — Revoke a key permanently (requires X-Admin-Key)',
        suspendKey: 'POST /keys/suspend — Temporarily suspend a key (requires X-Admin-Key)',
        resumeKey: 'POST /keys/resume — Resume a suspended key (requires X-Admin-Key)',
        cloneKey: 'POST /keys/clone — Clone a key with same config (requires X-Admin-Key)',
        keyAlias: 'POST /keys/alias — Set or clear a human-readable alias for a key (requires X-Admin-Key)',
        rotateKey: 'POST /keys/rotate — Rotate a key (requires X-Admin-Key)',
        setAcl: 'POST /keys/acl — Set tool ACL (requires X-Admin-Key)',
        setExpiry: 'POST /keys/expiry — Set key expiry (requires X-Admin-Key)',
        topUp: 'POST /topup — Add credits (requires X-Admin-Key)',
        transfer: 'POST /keys/transfer — Transfer credits between keys (requires X-Admin-Key)',
        bulk: 'POST /keys/bulk — Bulk key operations: create, topup, revoke (requires X-Admin-Key)',
        keyExport: 'GET /keys/export — Export all API keys for backup/migration (requires X-Admin-Key)',
        keyImport: 'POST /keys/import — Import API keys from backup (requires X-Admin-Key)',
        usage: 'GET /usage — Export usage data (requires X-Admin-Key)',
        limits: 'POST /limits — Set spending limit (requires X-Admin-Key)',
        setQuota: 'POST /keys/quota — Set usage quota (requires X-Admin-Key)',
        setTags: 'POST /keys/tags — Set key tags/metadata (requires X-Admin-Key)',
        setIpAllowlist: 'POST /keys/ip — Set IP allowlist (requires X-Admin-Key)',
        searchKeys: 'POST /keys/search — Search keys by tags (requires X-Admin-Key)',
        autoTopup: 'POST /keys/auto-topup — Configure auto-topup for a key (requires X-Admin-Key)',
        keyUsage: 'GET /keys/usage?key=... — Per-key usage breakdown (requires X-Admin-Key)',
        keysExpiring: 'GET /keys/expiring?within=86400 — List keys expiring within N seconds (requires X-Admin-Key)',
        keyStats: 'GET /keys/stats — Aggregate key statistics (requires X-Admin-Key)',
        rateLimitStatus: 'GET /keys/rate-limit-status?key=... — Current rate limit window state (requires X-Admin-Key)',
        quotaStatus: 'GET /keys/quota-status?key=... — Current daily/monthly quota usage (requires X-Admin-Key)',
        creditHistory: 'GET /keys/credit-history?key=... — Per-key credit mutation history (requires X-Admin-Key)',
        spendingVelocity: 'GET /keys/spending-velocity?key=... — Spending rate and depletion forecast (requires X-Admin-Key)',
        keyComparison: 'GET /keys/compare?keys=pg_a,pg_b — Side-by-side key comparison (requires X-Admin-Key)',
        keyHealth: 'GET /keys/health?key=... — Composite health score (0-100) with component breakdown (requires X-Admin-Key)',
        keyTemplates: 'GET /keys/templates — List key templates + POST to create/update (requires X-Admin-Key)',
        deleteTemplate: 'POST /keys/templates/delete — Delete a key template (requires X-Admin-Key)',
        pricing: 'GET /pricing — Tool pricing breakdown (public)',
        mcpPayment: 'GET /.well-known/mcp-payment — Payment metadata (SEP-2007)',
        audit: 'GET /audit — Query audit log (requires X-Admin-Key)',
        auditExport: 'GET /audit/export — Export audit log (requires X-Admin-Key)',
        auditStats: 'GET /audit/stats — Audit log statistics (requires X-Admin-Key)',
        metrics: 'GET /metrics — Prometheus metrics (public)',
        analytics: 'GET /analytics — Usage analytics with time-series data (requires X-Admin-Key)',
        alerts: 'GET /alerts — Get pending alerts + POST /alerts — Configure alert rules (requires X-Admin-Key)',
        webhookDeadLetters: 'GET /webhooks/dead-letter — View failed webhook deliveries + DELETE to clear (requires X-Admin-Key)',
        webhookReplay: 'POST /webhooks/replay — Replay dead letter webhook events (requires X-Admin-Key)',
        webhookTest: 'POST /webhooks/test — Send test event to webhook URL and return result (requires X-Admin-Key)',
        webhookStats: 'GET /webhooks/stats — Webhook delivery statistics (requires X-Admin-Key)',
        webhookLog: 'GET /webhooks/log — Webhook delivery log with status, timing, and filters (requires X-Admin-Key)',
        webhookPause: 'POST /webhooks/pause — Pause webhook delivery (events buffered) (requires X-Admin-Key)',
        webhookResume: 'POST /webhooks/resume — Resume webhook delivery and flush buffered events (requires X-Admin-Key)',
        webhookFilters: 'GET|POST /webhooks/filters — List or create webhook filter rules (requires X-Admin-Key)',
        updateWebhookFilter: 'POST /webhooks/filters/update — Update a webhook filter rule (requires X-Admin-Key)',
        deleteWebhookFilter: 'POST /webhooks/filters/delete — Delete a webhook filter rule (requires X-Admin-Key)',
        teams: 'GET /teams — List teams + POST /teams — Create team (requires X-Admin-Key)',
        teamsUpdate: 'POST /teams/update — Update team (requires X-Admin-Key)',
        teamsDelete: 'POST /teams/delete — Delete team (requires X-Admin-Key)',
        teamsAssign: 'POST /teams/assign — Assign key to team (requires X-Admin-Key)',
        teamsRemove: 'POST /teams/remove — Remove key from team (requires X-Admin-Key)',
        teamsUsage: 'GET /teams/usage?teamId=... — Team usage summary (requires X-Admin-Key)',
        createToken: 'POST /tokens — Create scoped token (requires X-Admin-Key)',
        revokeToken: 'POST /tokens/revoke — Revoke a scoped token (requires X-Admin-Key)',
        listRevokedTokens: 'GET /tokens/revoked — List revoked tokens (requires X-Admin-Key)',
        adminKeys: 'GET /admin/keys — List admin keys (requires X-Admin-Key, super_admin)',
        createAdminKey: 'POST /admin/keys — Create admin key with role (requires X-Admin-Key, super_admin)',
        revokeAdminKey: 'POST /admin/keys/revoke — Revoke an admin key (requires X-Admin-Key, super_admin)',
        plugins: 'GET /plugins — List registered plugins (requires X-Admin-Key)',
        listGroups: 'GET /groups — List key groups (requires X-Admin-Key)',
        createGroup: 'POST /groups — Create a key group (requires X-Admin-Key)',
        updateGroup: 'POST /groups/update — Update group settings (requires X-Admin-Key)',
        deleteGroup: 'POST /groups/delete — Delete a key group (requires X-Admin-Key)',
        assignKeyToGroup: 'POST /groups/assign — Assign a key to a group (requires X-Admin-Key)',
        removeKeyFromGroup: 'POST /groups/remove — Remove a key from a group (requires X-Admin-Key)',
        configReload: 'POST /config/reload — Hot reload config from file (requires X-Admin-Key)',
        configExport: 'GET /config — Export running config with sensitive values masked (requires X-Admin-Key)',
        maintenance: 'GET /maintenance — Check status + POST to enable/disable maintenance mode (requires X-Admin-Key)',
        adminEvents: 'GET /admin/events — Real-time SSE stream of server events (requires X-Admin-Key, Accept: text/event-stream)',
        keyNotes: 'GET /keys/notes?key=... — List notes + POST to add + DELETE to remove (requires X-Admin-Key)',
        keySchedule: 'GET /keys/schedule?key=... — List schedules + POST to create + DELETE to cancel (requires X-Admin-Key)',
        keyActivity: 'GET /keys/activity?key=... — Unified activity timeline for a key (requires X-Admin-Key)',
        creditReservations: 'POST /keys/reserve to hold credits, POST /keys/reserve/commit to deduct, POST /keys/reserve/release to release, GET /keys/reserve to list (requires X-Admin-Key)',
        requestLog: 'GET /requests — Queryable log of tool call requests with timing, credits, status (requires X-Admin-Key)',
        requestLogExport: 'GET /requests/export — Export request log as JSON or CSV with filters (requires X-Admin-Key)',
        requestDryRun: 'POST /requests/dry-run — Simulate a tool call without executing (requires X-Admin-Key)',
        requestDryRunBatch: 'POST /requests/dry-run/batch — Simulate multiple tool calls without executing (requires X-Admin-Key)',
        toolStats: 'GET /tools/stats — Per-tool call counts, success rates, latency, credits, and top consumers (requires X-Admin-Key)',
        toolAvailability: 'GET /tools/available?key=... — Per-key tool availability with pricing, affordability, and rate limit status (requires X-Admin-Key)',
        keyDashboard: 'GET /keys/dashboard?key=... — Consolidated key overview with metadata, balance, health, velocity, rate limits, quotas, and recent activity (requires X-Admin-Key)',
        adminNotifications: 'GET /admin/notifications — Actionable notifications for expiring keys, low credits, high error rates, and rate limit pressure (requires X-Admin-Key)',
        systemDashboard: 'GET /admin/dashboard — System-wide overview with key stats, credit summary, usage breakdown, top consumers, and uptime (requires X-Admin-Key)',
        keyLifecycle: 'GET /admin/lifecycle — Key lifecycle report with creation/revocation/expiry trends, average lifetime, and at-risk keys (requires X-Admin-Key)',
        ...(this.oauth ? {
          oauthMetadata: 'GET /.well-known/oauth-authorization-server — OAuth 2.1 server metadata',
          oauthRegister: 'POST /oauth/register — Register OAuth client',
          oauthAuthorize: 'GET /oauth/authorize — Authorization endpoint',
          oauthToken: 'POST /oauth/token — Token endpoint',
          oauthRevoke: 'POST /oauth/revoke — Revoke token',
          oauthClients: 'GET /oauth/clients — List OAuth clients (requires X-Admin-Key)',
        } : {}),
      },
      shadowMode: this.config.shadowMode,
      oauth: !!this.oauth,
      redis: !!this.redisSync,
    }));
  }

  // ─── /status — Dashboard ────────────────────────────────────────────────────

  private handleStatus(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const namespace = params.get('namespace') || undefined;

    const status = this.gate.getStatus(namespace);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
  }

  // ─── /health — Public health check ─────────────────────────────────────────

  private handleHealth(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const uptimeMs = Date.now() - this.startedAt;
    const status = this.draining ? 'draining' : this.maintenanceMode ? 'maintenance' : 'healthy';
    const httpStatus = this.draining ? 503 : 200;

    const health: Record<string, unknown> = {
      status,
      uptime: Math.floor(uptimeMs / 1000),
      version: PKG_VERSION,
      inflight: this.inflight,
    };

    // Redis connectivity
    if (this.redisSync) {
      health.redis = {
        connected: this.redisSync.isConnected,
        pubsub: this.redisSync.isPubSubActive,
      };
    }

    // Webhook status
    if (this.gate.webhook) {
      const stats = this.gate.webhook.getRetryStats();
      health.webhooks = {
        pendingRetries: stats.pendingRetries,
        deadLetterCount: stats.deadLetterCount,
      };
    }

    res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
  }

  // ─── /info — Server capabilities and feature summary ────────────────────────

  private handleInfo(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const features: Record<string, boolean> = {
      shadowMode: this.config.shadowMode,
      webhooks: !!this.config.webhookUrl,
      webhookSignatures: !!this.config.webhookSecret,
      webhookFilters: !!(this.config.webhookFilters && this.config.webhookFilters.length > 0),
      refundOnFailure: this.config.refundOnFailure,
      oauth: !!this.config.oauth,
      redis: !!this.redisSync,
      teams: this.teams.listTeams().length > 0,
      plugins: this.plugins.count > 0,
      alerts: !!(this.config.alertRules && this.config.alertRules.length > 0),
      expiryScanner: !!(this.expiryScanner),
      templates: this.templates.list().length > 0,
      multiServer: !!this.router,
      quotas: !!this.config.globalQuota,
      corsRestricted: !!(this.config.cors && this.config.cors.origin !== '*'),
      customHeaders: !!(this.config.customHeaders && Object.keys(this.config.customHeaders).length > 0),
      trustedProxies: !!(this.config.trustedProxies && this.config.trustedProxies.length > 0),
    };

    const pricing: Record<string, unknown> = {
      defaultCreditsPerCall: this.config.defaultCreditsPerCall,
      toolPricing: Object.keys(this.config.toolPricing).length > 0
        ? Object.fromEntries(
            Object.entries(this.config.toolPricing).map(([tool, p]) => [tool, { creditsPerCall: p.creditsPerCall }])
          )
        : {},
    };

    const auth: string[] = ['api_key'];
    if (this.config.oauth) auth.push('oauth2');
    auth.push('scoped_token');

    const info = {
      name: this.config.name,
      version: PKG_VERSION,
      transport: this.router ? 'multi-server' : (this.proxy instanceof HttpMcpProxy ? 'http' : 'stdio'),
      port: this.config.port,
      auth,
      features,
      pricing,
      rateLimit: {
        globalPerMin: this.config.globalRateLimitPerMin,
      },
      endpoints: {
        mcp: '/mcp',
        health: '/health',
        info: '/info',
        status: '/status (admin)',
        keys: '/keys (admin)',
        metrics: '/metrics',
        pricing: '/pricing',
        audit: '/audit (admin)',
        analytics: '/analytics (admin)',
        config: '/config (admin)',
      },
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(info));
  }

  // ─── /config — Export running config ───────────────────────────────────────

  private handleConfigExport(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'viewer')) return;

    const requestId = (req as any)._requestId as string;

    // Build sanitized config — mask sensitive values
    const sanitized: Record<string, unknown> = {
      name: this.config.name,
      port: this.config.port,
      defaultCreditsPerCall: this.config.defaultCreditsPerCall,
      globalRateLimitPerMin: this.config.globalRateLimitPerMin,
      shadowMode: this.config.shadowMode,
      refundOnFailure: this.config.refundOnFailure,
      freeMethods: this.config.freeMethods,
      toolPricing: this.config.toolPricing,
      webhookUrl: this.config.webhookUrl ? this.maskUrl(this.config.webhookUrl) : null,
      webhookSecret: this.config.webhookSecret ? '***' : null,
      webhookMaxRetries: this.config.webhookMaxRetries ?? 5,
      webhookFilters: this.config.webhookFilters
        ? this.config.webhookFilters.map(f => ({
            id: f.id,
            name: f.name,
            events: f.events,
            url: this.maskUrl(f.url),
            secret: f.secret ? '***' : undefined,
            keyPrefixes: f.keyPrefixes,
            active: f.active,
          }))
        : [],
      globalQuota: this.config.globalQuota || null,
      oauth: this.config.oauth
        ? {
            issuer: this.config.oauth.issuer || '(auto-detected)',
            accessTokenTtl: this.config.oauth.accessTokenTtl ?? 3600,
            refreshTokenTtl: this.config.oauth.refreshTokenTtl ?? 2592000,
            scopes: this.config.oauth.scopes ?? ['tools:*', 'tools:read', 'tools:write'],
          }
        : null,
      alertRules: this.config.alertRules || [],
      expiryScanner: this.config.expiryScanner || null,
      cors: this.config.cors || { origin: '*' },
      customHeaders: this.config.customHeaders || {},
      serverCommand: this.config.serverCommand ? '***' : '',
      serverArgs: this.config.serverArgs?.length ? ['***'] : [],
      trustedProxies: this.config.trustedProxies || [],
    };

    this.audit.log('config.export', 'admin', 'Config exported', { requestId });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ config: sanitized }));
  }

  /** Mask a URL by hiding the path portion (keeps scheme + host) */
  private maskUrl(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}/***`;
    } catch {
      return '***';
    }
  }

  // ─── /keys — Create ─────────────────────────────────────────────────────────

  private async handleCreateKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { name?: string; credits?: number; allowedTools?: string[]; deniedTools?: string[]; expiresIn?: number; expiresAt?: string; quota?: { dailyCallLimit?: number; monthlyCallLimit?: number; dailyCreditLimit?: number; monthlyCreditLimit?: number }; tags?: Record<string, string>; ipAllowlist?: string[]; namespace?: string; template?: string };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    // Resolve template defaults (explicit params override template values)
    let tpl: import('./key-templates').KeyTemplate | null = null;
    if (params.template) {
      tpl = this.templates.get(params.template);
      if (!tpl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Template "${params.template}" not found` }));
        return;
      }
    }

    const name = String(params.name || 'unnamed').slice(0, 200);
    const credits = Math.max(0, Math.floor(Number(params.credits ?? tpl?.credits ?? 100)));

    if (credits <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Credits must be a positive integer' }));
      return;
    }

    // Calculate expiry: expiresIn (seconds) takes priority over expiresAt (ISO date), template TTL is fallback
    let expiresAt: string | null = null;
    if (params.expiresIn && Number(params.expiresIn) > 0) {
      expiresAt = new Date(Date.now() + Number(params.expiresIn) * 1000).toISOString();
    } else if (params.expiresAt) {
      expiresAt = String(params.expiresAt);
    } else if (tpl && tpl.expiryTtlSeconds > 0) {
      expiresAt = new Date(Date.now() + tpl.expiryTtlSeconds * 1000).toISOString();
    }

    // Parse quota: explicit params > template > undefined
    let quota = undefined;
    if (params.quota) {
      quota = {
        dailyCallLimit: Math.max(0, Math.floor(Number(params.quota.dailyCallLimit) || 0)),
        monthlyCallLimit: Math.max(0, Math.floor(Number(params.quota.monthlyCallLimit) || 0)),
        dailyCreditLimit: Math.max(0, Math.floor(Number(params.quota.dailyCreditLimit) || 0)),
        monthlyCreditLimit: Math.max(0, Math.floor(Number(params.quota.monthlyCreditLimit) || 0)),
      };
    } else if (tpl?.quota) {
      quota = { ...tpl.quota };
    }

    const record = this.gate.store.createKey(name, credits, {
      allowedTools: params.allowedTools || (tpl ? [...tpl.allowedTools] : undefined),
      deniedTools: params.deniedTools || (tpl ? [...tpl.deniedTools] : undefined),
      expiresAt,
      quota,
      tags: params.tags || (tpl ? { ...tpl.tags } : undefined),
      ipAllowlist: params.ipAllowlist || (tpl ? [...tpl.ipAllowlist] : undefined),
      namespace: params.namespace || tpl?.namespace,
    });

    // Apply template spending limit if not explicitly set
    if (tpl && tpl.spendingLimit > 0 && record.spendingLimit === 0) {
      record.spendingLimit = tpl.spendingLimit;
      this.gate.store.save();
    }

    // Apply template auto-topup if not explicitly configured
    if (tpl?.autoTopup && !record.autoTopup) {
      record.autoTopup = { ...tpl.autoTopup };
      this.gate.store.save();
    }

    // Sync new key to Redis (if configured)
    if (this.redisSync) {
      this.redisSync.saveKey(record).catch(() => {});
      this.redisSync.publishEvent({ type: 'key_created', key: record.key }).catch(() => {});
    }

    this.creditLedger.record(record.key, {
      type: 'initial', amount: credits, balanceBefore: 0, balanceAfter: credits,
    });

    this.audit.log('key.created', 'admin', `Key created: ${name}`, {
      keyMasked: maskKeyForAudit(record.key),
      name,
      credits,
      allowedTools: record.allowedTools,
      deniedTools: record.deniedTools,
      expiresAt: record.expiresAt,
    });
    this.emitWebhookAdmin('key.created', 'admin', {
      keyMasked: maskKeyForAudit(record.key), name, credits,
    });

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      key: record.key,
      name: record.name,
      credits: record.credits,
      allowedTools: record.allowedTools,
      deniedTools: record.deniedTools,
      expiresAt: record.expiresAt,
      tags: record.tags,
      ipAllowlist: record.ipAllowlist,
      namespace: record.namespace,
      message: 'Save this key — it cannot be retrieved later.',
    }));
  }

  // ─── /keys — List ───────────────────────────────────────────────────────────

  private handleListKeys(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');

    // Check if any pagination/filter/sort params are present → use enhanced listing
    const hasPagination = params.has('limit') || params.has('offset') ||
      params.has('sortBy') || params.has('order') ||
      params.has('group') || params.has('active') || params.has('suspended') ||
      params.has('expired') || params.has('namePrefix') ||
      params.has('minCredits') || params.has('maxCredits');

    if (hasPagination) {
      const query: import('./types').KeyListQuery = {
        namespace: params.get('namespace') || undefined,
        group: params.has('group') ? (params.get('group') || '') : undefined,
        active: params.get('active') || undefined,
        suspended: params.get('suspended') || undefined,
        expired: params.get('expired') || undefined,
        namePrefix: params.get('namePrefix') || undefined,
        minCredits: params.has('minCredits') ? Number(params.get('minCredits')) : undefined,
        maxCredits: params.has('maxCredits') ? Number(params.get('maxCredits')) : undefined,
        sortBy: (params.get('sortBy') as any) || undefined,
        order: (params.get('order') as any) || undefined,
        limit: params.has('limit') ? Number(params.get('limit')) : undefined,
        offset: params.has('offset') ? Number(params.get('offset')) : undefined,
      };
      const result = this.gate.store.listKeysFiltered(query);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // Legacy: plain list with optional namespace
    const namespace = params.get('namespace') || undefined;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.gate.store.listKeys(namespace), null, 2));
  }

  // ─── /topup — Add credits ───────────────────────────────────────────────────

  private async handleTopUp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { key?: string; credits?: number };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.key || !params.credits) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing key or credits' }));
      return;
    }

    const credits = Math.floor(Number(params.credits));
    if (!Number.isFinite(credits) || credits <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Credits must be a positive integer' }));
      return;
    }

    // Resolve alias to actual key
    const resolved = this.gate.store.resolveKey(params.key);
    const actualKey = resolved ? resolved.key : params.key;

    const balanceBefore = this.gate.store.getKey(actualKey)?.credits ?? 0;

    // Use Redis atomic topup when available, fall back to local store
    let success: boolean;
    if (this.redisSync) {
      success = await this.redisSync.atomicTopup(actualKey, credits);
    } else {
      success = this.gate.store.addCredits(actualKey, credits);
    }
    if (!success) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found or inactive' }));
      return;
    }

    const record = this.gate.store.getKey(actualKey);

    this.creditLedger.record(actualKey, {
      type: 'topup', amount: credits, balanceBefore, balanceAfter: record?.credits ?? balanceBefore + credits,
    });

    this.audit.log('key.topup', 'admin', `Added ${credits} credits`, {
      keyMasked: maskKeyForAudit(params.key),
      creditsAdded: credits,
      newBalance: record?.credits,
    });
    this.emitWebhookAdmin('key.topup', 'admin', {
      keyMasked: maskKeyForAudit(params.key), creditsAdded: credits, newBalance: record?.credits,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ credits: record?.credits, message: `Added ${credits} credits` }));
  }

  // ─── /keys/transfer — Transfer credits between keys ─────────────────────

  private async handleCreditTransfer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { from?: string; to?: string; credits?: number; memo?: string };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.from || !params.to) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "from" and "to" API keys' }));
      return;
    }

    if (params.from === params.to) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cannot transfer credits to the same key' }));
      return;
    }

    const credits = Math.floor(Number(params.credits));
    if (!Number.isFinite(credits) || credits <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Credits must be a positive integer' }));
      return;
    }

    // Validate source key exists and has enough credits
    const sourceRecord = this.gate.store.resolveKey(params.from);
    if (!sourceRecord) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Source key not found' }));
      return;
    }
    if (sourceRecord.credits < credits) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `Insufficient credits: source has ${sourceRecord.credits}, need ${credits}`,
      }));
      return;
    }

    // Validate destination key exists (getKey returns null for revoked/expired keys)
    const destRecord = this.gate.store.resolveKey(params.to);
    if (!destRecord) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Destination key not found' }));
      return;
    }

    const sourceBalanceBefore = sourceRecord.credits;
    const destBalanceBefore = destRecord.credits;

    // Perform transfer atomically (deduct from source, add to destination)
    if (this.redisSync) {
      // Redis atomic transfer: deduct first, then add
      const deducted = await this.redisSync.atomicDeduct(sourceRecord.key, credits);
      if (!deducted) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Redis deduction failed (insufficient credits or key not found)' }));
        return;
      }
      await this.redisSync.atomicTopup(destRecord.key, credits);
    } else {
      // Local store: deduct and add
      sourceRecord.credits -= credits;
      destRecord.credits += credits;
      this.gate.store.save();
    }

    const fromBalance = sourceRecord.credits;
    const toBalance = destRecord.credits;
    const memo = params.memo || '';

    this.creditLedger.record(sourceRecord.key, {
      type: 'transfer_out', amount: credits, balanceBefore: sourceBalanceBefore, balanceAfter: fromBalance, memo: memo || undefined,
    });
    this.creditLedger.record(destRecord.key, {
      type: 'transfer_in', amount: credits, balanceBefore: destBalanceBefore, balanceAfter: toBalance, memo: memo || undefined,
    });

    this.audit.log('key.credits_transferred', 'admin', `Transferred ${credits} credits`, {
      fromKeyMasked: maskKeyForAudit(sourceRecord.key),
      toKeyMasked: maskKeyForAudit(destRecord.key),
      credits,
      fromBalance,
      toBalance,
      memo,
    });
    this.emitWebhookAdmin('key.credits_transferred', 'admin', {
      fromKeyMasked: maskKeyForAudit(sourceRecord.key),
      toKeyMasked: maskKeyForAudit(destRecord.key),
      credits,
      fromBalance,
      toBalance,
      memo,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      transferred: credits,
      from: { keyMasked: maskKeyForAudit(sourceRecord.key), balance: fromBalance, credits: fromBalance },
      to: { keyMasked: maskKeyForAudit(destRecord.key), balance: toBalance, credits: toBalance },
      memo: memo || undefined,
      message: `Transferred ${credits} credits`,
    }));
  }

  // ─── /keys/bulk — Bulk key operations ──────────────────────────────────────

  private async handleBulkOperations(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { operations?: Array<{ action: string; [key: string]: unknown }> };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.operations || !Array.isArray(params.operations) || params.operations.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or empty "operations" array' }));
      return;
    }

    if (params.operations.length > 100) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Maximum 100 operations per request' }));
      return;
    }

    const results: Array<{ index: number; action: string; success: boolean; result?: Record<string, unknown>; error?: string }> = [];

    for (let i = 0; i < params.operations.length; i++) {
      const op = params.operations[i];
      try {
        switch (op.action) {
          case 'create': {
            const name = String(op.name || 'unnamed').slice(0, 200);
            const credits = Math.max(0, Math.floor(Number(op.credits) || 100));
            if (credits <= 0) {
              results.push({ index: i, action: 'create', success: false, error: 'Credits must be positive' });
              break;
            }
            const record = this.gate.store.createKey(name, credits, {
              allowedTools: op.allowedTools as string[] | undefined,
              deniedTools: op.deniedTools as string[] | undefined,
              tags: op.tags as Record<string, string> | undefined,
              namespace: op.namespace as string | undefined,
            });
            if (this.redisSync) {
              this.redisSync.saveKey(record).catch(() => {});
            }
            this.audit.log('key.created', 'admin', `Key created (bulk): ${name}`, {
              keyMasked: maskKeyForAudit(record.key), name, credits,
            });
            results.push({
              index: i, action: 'create', success: true,
              result: { key: record.key, name: record.name, credits: record.credits },
            });
            break;
          }
          case 'topup': {
            const key = op.key as string;
            const amount = Math.floor(Number(op.credits));
            if (!key) {
              results.push({ index: i, action: 'topup', success: false, error: 'Missing key' });
              break;
            }
            if (!Number.isFinite(amount) || amount <= 0) {
              results.push({ index: i, action: 'topup', success: false, error: 'Credits must be a positive integer' });
              break;
            }
            let success: boolean;
            if (this.redisSync) {
              success = await this.redisSync.atomicTopup(key, amount);
            } else {
              success = this.gate.store.addCredits(key, amount);
            }
            if (!success) {
              results.push({ index: i, action: 'topup', success: false, error: 'Key not found or inactive' });
              break;
            }
            const record = this.gate.store.getKey(key);
            this.audit.log('key.topup', 'admin', `Added ${amount} credits (bulk)`, {
              keyMasked: maskKeyForAudit(key), creditsAdded: amount, newBalance: record?.credits,
            });
            results.push({
              index: i, action: 'topup', success: true,
              result: { keyMasked: maskKeyForAudit(key), creditsAdded: amount, newBalance: record?.credits },
            });
            break;
          }
          case 'revoke': {
            const key = op.key as string;
            if (!key) {
              results.push({ index: i, action: 'revoke', success: false, error: 'Missing key' });
              break;
            }
            let success: boolean;
            if (this.redisSync) {
              success = await this.redisSync.revokeKey(key);
            } else {
              success = this.gate.store.revokeKey(key);
            }
            if (!success) {
              results.push({ index: i, action: 'revoke', success: false, error: 'Key not found' });
              break;
            }
            this.audit.log('key.revoked', 'admin', 'Key revoked (bulk)', {
              keyMasked: maskKeyForAudit(key),
            });
            this.emitWebhookAdmin('key.revoked', 'admin', { keyMasked: maskKeyForAudit(key) });
            results.push({
              index: i, action: 'revoke', success: true,
              result: { keyMasked: maskKeyForAudit(key) },
            });
            break;
          }
          default:
            results.push({ index: i, action: op.action || 'unknown', success: false, error: `Unknown action: ${op.action}` });
        }
      } catch (e: any) {
        results.push({ index: i, action: op.action || 'unknown', success: false, error: e.message || 'Internal error' });
      }
    }

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      total: results.length,
      succeeded,
      failed,
      results,
    }));
  }

  // ─── /keys/export — Export all API keys for backup ────────────────────────

  private handleKeyExport(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const namespace = params.get('namespace') || undefined;
    const activeOnly = params.get('activeOnly') === 'true';
    const format = params.get('format') || 'json';

    const keys = this.gate.store.exportKeys({ namespace, activeOnly });

    this.audit.log('keys.exported', 'admin', `Exported ${keys.length} keys`, {
      count: keys.length, namespace: namespace || 'all', activeOnly,
    });

    if (format === 'csv') {
      const headers = ['key', 'name', 'credits', 'totalSpent', 'totalCalls', 'createdAt', 'lastUsedAt', 'active', 'namespace', 'expiresAt', 'spendingLimit'];
      const rows = keys.map(k => headers.map(h => {
        const v = (k as unknown as Record<string, unknown>)[h];
        if (v === null || v === undefined) return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(','));
      const csv = [headers.join(','), ...rows].join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="paygate-keys-${new Date().toISOString().slice(0, 10)}.csv"`,
      });
      res.end(csv);
      return;
    }

    // JSON format
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="paygate-keys-${new Date().toISOString().slice(0, 10)}.json"`,
    });
    res.end(JSON.stringify({
      version: '1.0',
      exportedAt: new Date().toISOString(),
      count: keys.length,
      keys,
    }, null, 2));
  }

  // ─── /keys/import — Import API keys from backup ───────────────────────────

  private async handleKeyImport(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { keys?: unknown[]; mode?: string };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.keys || !Array.isArray(params.keys) || params.keys.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or empty "keys" array' }));
      return;
    }

    if (params.keys.length > 1000) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Maximum 1000 keys per import request' }));
      return;
    }

    const mode = (params.mode === 'overwrite' || params.mode === 'error') ? params.mode : 'skip';
    const results = this.gate.store.importKeys(params.keys as any[], mode);

    // Sync imported keys to Redis if available
    if (this.redisSync) {
      for (const r of results) {
        if (r.status === 'imported' || r.status === 'overwritten') {
          // Find the full key from the store to sync
          const allKeys = this.gate.store.exportKeys();
          const full = allKeys.find(k => k.key.slice(0, 10) + '...' === r.key);
          if (full) {
            this.redisSync.saveKey(full).catch(() => {});
          }
        }
      }
    }

    const imported = results.filter(r => r.status === 'imported').length;
    const overwritten = results.filter(r => r.status === 'overwritten').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const errors = results.filter(r => r.status === 'error').length;

    this.audit.log('keys.imported', 'admin', `Imported ${imported + overwritten} keys (${skipped} skipped, ${errors} errors)`, {
      imported, overwritten, skipped, errors, mode,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      total: results.length,
      imported,
      overwritten,
      skipped,
      errors,
      mode,
      results,
    }));
  }

  // ─── /keys/revoke — Revoke a key ──────────────────────────────────────────

  private async handleRevokeKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { key?: string };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.key) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing key' }));
      return;
    }

    // Resolve alias to actual key
    const resolved = this.gate.store.resolveKeyRaw(params.key);
    const actualKey = resolved ? resolved.key : params.key;

    // Use Redis-backed revoke when available (broadcasts to other instances)
    let success: boolean;
    if (this.redisSync) {
      success = await this.redisSync.revokeKey(actualKey);
    } else {
      success = this.gate.store.revokeKey(actualKey);
    }
    if (!success) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found' }));
      return;
    }

    this.audit.log('key.revoked', 'admin', `Key revoked`, {
      keyMasked: maskKeyForAudit(actualKey),
    });
    this.emitWebhookAdmin('key.revoked', 'admin', {
      keyMasked: maskKeyForAudit(actualKey),
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Key revoked', revoked: true }));
  }

  // ─── /keys/suspend — Temporarily suspend a key ─────────────────────────────

  private async handleSuspendKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { key?: string; reason?: string };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.key) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing key' }));
      return;
    }

    const record = this.gate.store.resolveKeyRaw(params.key);
    if (!record) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found' }));
      return;
    }

    if (!record.active) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cannot suspend a revoked key' }));
      return;
    }

    if (record.suspended) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key is already suspended' }));
      return;
    }

    const success = this.gate.store.suspendKey(record.key);
    if (!success) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to suspend key' }));
      return;
    }
    this.syncKeyMutation(record.key);

    this.audit.log('key.suspended', 'admin', `Key suspended${params.reason ? ': ' + params.reason : ''}`, {
      keyMasked: maskKeyForAudit(record.key),
      reason: params.reason || null,
    });
    this.emitWebhookAdmin('key.suspended', 'admin', {
      keyMasked: maskKeyForAudit(record.key),
      reason: params.reason || null,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Key suspended', suspended: true }));
  }

  // ─── /keys/resume — Resume a suspended key ────────────────────────────────

  private async handleResumeKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { key?: string };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.key) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing key' }));
      return;
    }

    const record = this.gate.store.resolveKeyRaw(params.key);
    if (!record) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found' }));
      return;
    }

    if (!record.active) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cannot resume a revoked key' }));
      return;
    }

    if (!record.suspended) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key is not suspended' }));
      return;
    }

    const success = this.gate.store.resumeKey(record.key);
    if (!success) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to resume key' }));
      return;
    }
    this.syncKeyMutation(record.key);

    this.audit.log('key.resumed', 'admin', 'Key resumed', {
      keyMasked: maskKeyForAudit(record.key),
    });
    this.emitWebhookAdmin('key.resumed', 'admin', {
      keyMasked: maskKeyForAudit(record.key),
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Key resumed', suspended: false }));
  }

  // ─── /keys/clone — Clone API key ─────────────────────────────────────────

  private async handleCloneKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { key?: string; name?: string; credits?: number; tags?: Record<string, string>; namespace?: string };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.key) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing key' }));
      return;
    }

    // Use getKeyRaw to allow cloning suspended/expired keys (but not revoked)
    const source = this.gate.store.resolveKeyRaw(params.key);
    if (!source) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Source key not found' }));
      return;
    }
    if (!source.active) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cannot clone a revoked key' }));
      return;
    }

    const cloned = this.gate.store.cloneKey(source.key, {
      name: params.name,
      credits: params.credits,
      tags: params.tags,
      namespace: params.namespace,
    });
    if (!cloned) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Clone failed' }));
      return;
    }

    // Sync new key to Redis
    this.syncKeyMutation(cloned.key);

    this.audit.log('key.cloned', 'admin', `Key cloned from ${maskKeyForAudit(source.key)}`, {
      sourceKeyMasked: maskKeyForAudit(source.key),
      newKeyMasked: maskKeyForAudit(cloned.key),
      name: cloned.name,
      credits: cloned.credits,
    });
    this.emitWebhookAdmin('key.cloned', 'admin', {
      sourceKeyMasked: maskKeyForAudit(source.key),
      newKeyMasked: maskKeyForAudit(cloned.key),
      name: cloned.name,
      credits: cloned.credits,
    });

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      message: 'Key cloned',
      key: cloned.key,
      name: cloned.name,
      credits: cloned.credits,
      clonedFrom: source.key.slice(0, 10) + '...',
      sourceName: source.name,
      allowedTools: cloned.allowedTools,
      deniedTools: cloned.deniedTools,
      expiresAt: cloned.expiresAt,
      quota: cloned.quota,
      tags: cloned.tags,
      ipAllowlist: cloned.ipAllowlist,
      namespace: cloned.namespace,
      group: cloned.group,
      spendingLimit: cloned.spendingLimit,
    }));
  }

  // ─── /keys/alias — Set or clear key alias ──────────────────────────────────

  private async handleSetAlias(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    const raw = await this.readBody(req);
    const params = JSON.parse(raw);
    if (!params.key) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "key" parameter' }));
      return;
    }

    // Resolve the key (support existing aliases for the source key)
    const record = this.gate.store.resolveKeyRaw(params.key);
    if (!record) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found' }));
      return;
    }

    const alias = params.alias !== undefined ? (params.alias === null || params.alias === '' ? null : String(params.alias)) : undefined;
    if (alias === undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "alias" parameter (string to set, null to clear)' }));
      return;
    }

    const result = this.gate.store.setAlias(record.key, alias);
    if (!result.success) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }

    const action = alias ? `set to "${alias}"` : 'cleared';
    this.audit.log('key.alias_set', 'admin', `Key alias ${action} for ${record.key.slice(0, 10)}...`, {
      key: record.key.slice(0, 10),
      alias: alias || null,
    });

    // Sync to Redis if configured
    if (typeof (this as any).syncKeyMutation === 'function') {
      (this as any).syncKeyMutation(record.key);
    }

    // Webhook event
    if (this.gate.webhook) {
      this.gate.webhook.emitAdmin('key.created', 'admin', {
        key: record.key.slice(0, 10),
        alias: alias || null,
        event: 'alias_set',
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      key: record.key.slice(0, 10) + '...',
      alias: record.alias || null,
      message: `Alias ${action}`,
    }));
  }

  // ─── /keys/rotate — Rotate API key ─────────────────────────────────────────

  private async handleRotateKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { key?: string };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.key) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing key' }));
      return;
    }

    const rotated = this.gate.store.rotateKey(params.key);
    if (!rotated) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found or inactive' }));
      return;
    }

    // Sync rotated key to Redis (save new key + revoke old)
    if (this.redisSync) {
      this.redisSync.saveKey(rotated).catch(() => {});
      this.redisSync.publishEvent({ type: 'key_created', key: rotated.key }).catch(() => {});
      this.redisSync.publishEvent({ type: 'key_revoked', key: params.key }).catch(() => {});
    }

    this.audit.log('key.rotated', 'admin', `Key rotated`, {
      oldKeyMasked: maskKeyForAudit(params.key),
      newKeyMasked: maskKeyForAudit(rotated.key),
    });
    this.emitWebhookAdmin('key.rotated', 'admin', {
      oldKeyMasked: maskKeyForAudit(params.key),
      newKeyMasked: maskKeyForAudit(rotated.key),
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      message: 'Key rotated',
      newKey: rotated.key,
      name: rotated.name,
      credits: rotated.credits,
    }));
  }

  // ─── /keys/acl — Set tool ACL ──────────────────────────────────────────────

  private async handleSetAcl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { key?: string; allowedTools?: string[]; deniedTools?: string[] };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.key) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing key' }));
      return;
    }

    const success = this.gate.store.setAcl(params.key, params.allowedTools, params.deniedTools);
    if (!success) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found or inactive' }));
      return;
    }
    this.syncKeyMutation(params.key);

    const record = this.gate.store.resolveKey(params.key);

    this.audit.log('key.acl_updated', 'admin', `ACL updated`, {
      keyMasked: maskKeyForAudit(params.key),
      allowedTools: record?.allowedTools || [],
      deniedTools: record?.deniedTools || [],
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      allowedTools: record?.allowedTools || [],
      deniedTools: record?.deniedTools || [],
      message: 'ACL updated',
    }));
  }

  // ─── /keys/expiry — Set key expiry ─────────────────────────────────────────

  private async handleSetExpiry(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { key?: string; expiresAt?: string | null; expiresIn?: number };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.key) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing key' }));
      return;
    }

    // Calculate expiry: expiresIn (seconds) takes priority over expiresAt (ISO date)
    let expiresAt: string | null = null;
    if (params.expiresIn && Number(params.expiresIn) > 0) {
      expiresAt = new Date(Date.now() + Number(params.expiresIn) * 1000).toISOString();
    } else if (params.expiresAt !== undefined) {
      expiresAt = params.expiresAt;
    }

    const success = this.gate.store.setExpiry(params.key, expiresAt);
    if (!success) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found' }));
      return;
    }
    this.syncKeyMutation(params.key);

    const record = this.gate.store.resolveKeyRaw(params.key);

    this.audit.log('key.expiry_updated', 'admin', expiresAt ? `Key expiry set to ${expiresAt}` : 'Key expiry removed', {
      keyMasked: maskKeyForAudit(params.key),
      expiresAt: record?.expiresAt || null,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      expiresAt: record?.expiresAt || null,
      message: expiresAt ? `Key expires at ${expiresAt}` : 'Expiry removed (key never expires)',
    }));
  }

  // ─── /keys/quota — Set usage quota ────────────────────────────────────────

  private async handleSetQuota(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { key?: string; dailyCallLimit?: number; monthlyCallLimit?: number; dailyCreditLimit?: number; monthlyCreditLimit?: number; remove?: boolean };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.key) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing key' }));
      return;
    }

    if (params.remove) {
      const success = this.gate.store.setQuota(params.key, null);
      if (!success) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Key not found' }));
        return;
      }
      this.syncKeyMutation(params.key);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Quota removed (using global defaults)' }));
      return;
    }

    const quota = {
      dailyCallLimit: Math.max(0, Math.floor(Number(params.dailyCallLimit) || 0)),
      monthlyCallLimit: Math.max(0, Math.floor(Number(params.monthlyCallLimit) || 0)),
      dailyCreditLimit: Math.max(0, Math.floor(Number(params.dailyCreditLimit) || 0)),
      monthlyCreditLimit: Math.max(0, Math.floor(Number(params.monthlyCreditLimit) || 0)),
    };

    const success = this.gate.store.setQuota(params.key, quota);
    if (!success) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found' }));
      return;
    }
    this.syncKeyMutation(params.key);

    this.audit.log('key.quota_updated', 'admin', `Quota set`, {
      keyMasked: maskKeyForAudit(params.key),
      quota,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ quota, message: 'Quota set' }));
  }

  // ─── /keys/tags — Set key tags ──────────────────────────────────────────────

  private async handleSetTags(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { key?: string; tags?: Record<string, string | null> };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.key) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing key' }));
      return;
    }

    if (!params.tags || typeof params.tags !== 'object') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid tags object' }));
      return;
    }

    const success = this.gate.store.setTags(params.key, params.tags);
    if (!success) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found' }));
      return;
    }

    this.syncKeyMutation(params.key);
    const record = this.gate.store.resolveKey(params.key);

    this.audit.log('key.tags_updated', 'admin', `Tags updated`, {
      keyMasked: maskKeyForAudit(params.key),
      tags: record?.tags || {},
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      tags: record?.tags || {},
      message: 'Tags updated',
    }));
  }

  // ─── /keys/ip — Set IP allowlist ───────────────────────────────────────────

  private async handleSetIpAllowlist(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { key?: string; ips?: string[] };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.key) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing key' }));
      return;
    }

    if (!Array.isArray(params.ips)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid ips array' }));
      return;
    }

    const success = this.gate.store.setIpAllowlist(params.key, params.ips);
    if (!success) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found' }));
      return;
    }

    this.syncKeyMutation(params.key);
    const record = this.gate.store.resolveKey(params.key);

    this.audit.log('key.ip_updated', 'admin', `IP allowlist updated`, {
      keyMasked: maskKeyForAudit(params.key),
      ipAllowlist: record?.ipAllowlist || [],
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ipAllowlist: record?.ipAllowlist || [],
      message: 'IP allowlist updated',
    }));
  }

  // ─── /keys/search — Search keys by tags ────────────────────────────────────

  private async handleSearchKeysByTag(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    const body = await this.readBody(req);
    let params: { tags?: Record<string, string>; namespace?: string };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.tags || typeof params.tags !== 'object') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid tags object' }));
      return;
    }

    const results = this.gate.store.listKeysByTag(params.tags, params.namespace);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: results, count: results.length }));
  }

  // ─── /keys/usage — Per-key usage breakdown ──────────────────────────────────

  private handleKeyUsage(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const key = params.get('key');
    const since = params.get('since') || undefined;

    if (!key) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing key query parameter' }));
      return;
    }

    // Verify key exists (use resolveKeyRaw to allow querying by alias and expired/suspended keys)
    const record = this.gate.store.resolveKeyRaw(key);
    if (!record) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found' }));
      return;
    }

    const usage = this.gate.meter.getKeyUsage(record.key, since);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      key: key.slice(0, 10) + '...',
      name: record.name,
      credits: record.credits,
      active: record.active,
      suspended: record.suspended || false,
      since: since || 'all',
      ...usage,
    }, null, 2));
  }

  // ─── /keys/expiring — List keys expiring within a time window ───────────────

  private handleKeysExpiring(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const withinStr = params.get('within');
    const within = withinStr ? parseInt(withinStr, 10) : 86400; // Default: 24 hours

    if (isNaN(within) || within <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid within parameter — must be a positive number of seconds' }));
      return;
    }

    const allKeys = this.gate.store.getAllRecords();
    const expiring = ExpiryScanner.queryExpiring(allKeys, within);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      within,
      count: expiring.length,
      scanner: this.expiryScanner.status,
      keys: expiring,
    }, null, 2));
  }

  // ─── /keys/stats — Aggregate key statistics ────────────────────────────────

  private handleKeyStats(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const namespace = params.get('namespace') || undefined;

    const allKeys = this.gate.store.getAllRecords();
    let total = 0;
    let active = 0;
    let suspended = 0;
    let expired = 0;
    let revoked = 0;
    let totalCreditsAllocated = 0;
    let totalCreditsSpent = 0;
    let totalCalls = 0;
    const byNamespace: Record<string, number> = {};
    const byGroup: Record<string, number> = {};

    for (const record of allKeys) {
      if (namespace && record.namespace !== namespace) continue;

      total++;
      totalCreditsAllocated += record.credits;
      totalCreditsSpent += record.totalSpent;
      totalCalls += record.totalCalls;

      const isExpired = record.expiresAt ? new Date(record.expiresAt).getTime() <= Date.now() : false;

      if (!record.active) {
        revoked++;
      } else if (record.suspended) {
        suspended++;
      } else if (isExpired) {
        expired++;
      } else {
        active++;
      }

      // Count by namespace
      const ns = record.namespace || 'default';
      byNamespace[ns] = (byNamespace[ns] || 0) + 1;

      // Count by group
      if (record.group) {
        byGroup[record.group] = (byGroup[record.group] || 0) + 1;
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      total,
      active,
      suspended,
      expired,
      revoked,
      totalCreditsAllocated,
      totalCreditsSpent,
      totalCreditsRemaining: totalCreditsAllocated - totalCreditsSpent,
      totalCalls,
      byNamespace,
      byGroup,
      ...(namespace ? { filteredByNamespace: namespace } : {}),
    }));
  }

  // ─── /keys/rate-limit-status — Current rate limit window state ────────────────

  private handleRateLimitStatus(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const key = params.get('key');

    if (!key) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required query parameter: key' }));
      return;
    }

    const keyRecord = this.gate.store.getKey(key);
    if (!keyRecord) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found' }));
      return;
    }

    // Global rate limit status
    const globalStatus = this.gate.rateLimiter.getStatus(key);

    // Per-tool rate limit status
    const perTool: Record<string, { limit: number; used: number; remaining: number; resetInMs: number }> = {};
    for (const [toolName, pricing] of Object.entries(this.config.toolPricing)) {
      if (pricing.rateLimitPerMin && pricing.rateLimitPerMin > 0) {
        const compositeKey = `${key}:tool:${toolName}`;
        perTool[toolName] = this.gate.rateLimiter.getStatus(compositeKey, pricing.rateLimitPerMin);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      key: key.slice(0, 10) + '...',
      name: keyRecord.name,
      global: {
        limit: globalStatus.limit,
        used: globalStatus.used,
        remaining: globalStatus.remaining,
        resetInMs: globalStatus.resetInMs,
        windowMs: 60000,
      },
      perTool: Object.keys(perTool).length > 0 ? perTool : undefined,
    }));
  }

  // ─── /keys/quota-status — Current daily/monthly quota usage ──────────────────

  private handleQuotaStatus(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const key = params.get('key');

    if (!key) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required query parameter: key' }));
      return;
    }

    const keyRecord = this.gate.store.getKey(key);
    if (!keyRecord) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found' }));
      return;
    }

    // Ensure counters are reset if day/month rolled over
    this.gate.quotaTracker.resetIfNeeded(keyRecord);

    // Resolve effective quota: per-key overrides global
    const effectiveQuota = keyRecord.quota || this.config.globalQuota;

    const daily = {
      callsUsed: keyRecord.quotaDailyCalls,
      callsLimit: effectiveQuota?.dailyCallLimit || 0,
      callsRemaining: effectiveQuota?.dailyCallLimit
        ? Math.max(0, effectiveQuota.dailyCallLimit - keyRecord.quotaDailyCalls)
        : null,
      creditsUsed: keyRecord.quotaDailyCredits,
      creditsLimit: effectiveQuota?.dailyCreditLimit || 0,
      creditsRemaining: effectiveQuota?.dailyCreditLimit
        ? Math.max(0, effectiveQuota.dailyCreditLimit - keyRecord.quotaDailyCredits)
        : null,
      resetDay: keyRecord.quotaLastResetDay,
    };

    const monthly = {
      callsUsed: keyRecord.quotaMonthlyCalls,
      callsLimit: effectiveQuota?.monthlyCallLimit || 0,
      callsRemaining: effectiveQuota?.monthlyCallLimit
        ? Math.max(0, effectiveQuota.monthlyCallLimit - keyRecord.quotaMonthlyCalls)
        : null,
      creditsUsed: keyRecord.quotaMonthlyCredits,
      creditsLimit: effectiveQuota?.monthlyCreditLimit || 0,
      creditsRemaining: effectiveQuota?.monthlyCreditLimit
        ? Math.max(0, effectiveQuota.monthlyCreditLimit - keyRecord.quotaMonthlyCredits)
        : null,
      resetMonth: keyRecord.quotaLastResetMonth,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      key: key.slice(0, 10) + '...',
      name: keyRecord.name,
      quotaSource: keyRecord.quota ? 'per-key' : (this.config.globalQuota ? 'global' : 'none'),
      daily,
      monthly,
    }));
  }

  // ─── /keys/credit-history — Per-key credit mutation history ──────────────────

  private handleCreditHistory(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const key = params.get('key');

    if (!key) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required query parameter: key' }));
      return;
    }

    // Resolve alias
    const resolved = this.gate.store.resolveKey(key);
    const actualKey = resolved ? resolved.key : key;
    const keyRecord = this.gate.store.getKey(actualKey);
    if (!keyRecord) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found' }));
      return;
    }

    const type = params.get('type') || undefined;
    const limit = Math.min(Math.max(1, Number(params.get('limit')) || 50), 200);
    const since = params.get('since') || undefined;

    const entries = this.creditLedger.getHistory(actualKey, { type, limit, since });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      key: actualKey.slice(0, 10) + '...',
      name: keyRecord.name,
      currentBalance: keyRecord.credits,
      totalEntries: this.creditLedger.count(actualKey),
      entries,
    }));
  }

  // ─── /keys/spending-velocity — Spending rate + depletion forecast ────────────

  private handleSpendingVelocity(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const key = params.get('key');

    if (!key) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required query parameter: key' }));
      return;
    }

    // Resolve alias
    const resolved = this.gate.store.resolveKey(key);
    const actualKey = resolved ? resolved.key : key;
    const keyRecord = this.gate.store.getKey(actualKey);
    if (!keyRecord) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found' }));
      return;
    }

    const windowParam = params.get('window');
    const windowHours = Math.min(Math.max(1, windowParam !== null ? (Number(windowParam) || 1) : 24), 720); // 1h to 30 days

    const velocity = this.creditLedger.getSpendingVelocity(actualKey, keyRecord.credits, windowHours);

    // Get top tools from usage meter (per-key usage)
    const keyUsage = this.gate.meter.getKeyUsage(actualKey);
    const topTools: Array<{ tool: string; calls: number; credits: number }> = [];
    if (keyUsage && keyUsage.perTool) {
      const toolEntries = Object.entries(keyUsage.perTool)
        .map(([tool, stats]) => ({ tool, calls: stats.calls, credits: stats.credits }))
        .sort((a, b) => b.credits - a.credits)
        .slice(0, 5);
      topTools.push(...toolEntries);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      key: actualKey.slice(0, 10) + '...',
      name: keyRecord.name,
      currentBalance: keyRecord.credits,
      velocity,
      topTools,
    }));
  }

  // ─── /keys/compare — Side-by-side key comparison ────────────────────────────

  private handleKeyComparison(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const keysParam = params.get('keys');

    if (!keysParam) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required query parameter: keys (comma-separated)' }));
      return;
    }

    const keyIds = keysParam.split(',').map(k => k.trim()).filter(Boolean);
    if (keyIds.length < 2) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'At least 2 keys required for comparison' }));
      return;
    }
    if (keyIds.length > 10) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Maximum 10 keys per comparison' }));
      return;
    }

    const comparisons: any[] = [];
    const notFound: string[] = [];

    for (const keyId of keyIds) {
      const resolved = this.gate.store.resolveKey(keyId);
      const actualKey = resolved ? resolved.key : keyId;
      const record = this.gate.store.getKey(actualKey);

      if (!record) {
        notFound.push(keyId);
        continue;
      }

      // Get usage stats
      const keyUsage = this.gate.meter.getKeyUsage(actualKey);

      // Get velocity (24h window)
      const velocity = this.creditLedger.getSpendingVelocity(actualKey, record.credits, 24);

      // Get rate limit status
      const rateStatus = this.gate.rateLimiter.getStatus(actualKey);

      // Determine key status
      let status = 'active';
      if (!record.active) status = 'revoked';
      else if (record.suspended) status = 'suspended';
      else if (record.expiresAt && new Date(record.expiresAt).getTime() < Date.now()) status = 'expired';

      comparisons.push({
        key: actualKey.slice(0, 10) + '...',
        name: record.name,
        status,
        credits: {
          current: record.credits,
          totalSpent: keyUsage.totalCreditsSpent,
        },
        usage: {
          totalCalls: keyUsage.totalCalls,
          totalAllowed: keyUsage.totalAllowed,
          totalDenied: keyUsage.totalDenied,
        },
        velocity: {
          creditsPerHour: velocity.creditsPerHour,
          creditsPerDay: velocity.creditsPerDay,
          estimatedHoursRemaining: velocity.estimatedHoursRemaining,
        },
        rateLimit: {
          used: rateStatus.used,
          limit: rateStatus.limit,
          remaining: rateStatus.remaining,
        },
        metadata: {
          namespace: record.namespace || null,
          group: record.group || null,
          createdAt: record.createdAt,
          tags: record.tags || {},
        },
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      compared: comparisons.length,
      notFound: notFound.length > 0 ? notFound : undefined,
      keys: comparisons,
    }));
  }

  // ─── /keys/health — Composite health score ──────────────────────────────────

  private handleKeyHealth(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const key = params.get('key');

    if (!key) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required query parameter: key' }));
      return;
    }

    // Use resolveKeyRaw to include expired/suspended/revoked keys in health check
    const record = this.gate.store.resolveKeyRaw(key);
    if (!record) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found' }));
      return;
    }

    const actualKey = record.key;

    // ── Component 1: Balance health (30% weight) ──
    // Based on spending velocity → how many hours of usage remaining
    const velocity = this.creditLedger.getSpendingVelocity(actualKey, record.credits, 24);
    let balanceScore = 100;
    let balanceRisk = 'healthy';
    if (velocity.creditsPerHour > 0) {
      const hoursLeft = velocity.estimatedHoursRemaining ?? Infinity;
      if (hoursLeft <= 1) { balanceScore = 0; balanceRisk = 'critical'; }
      else if (hoursLeft <= 6) { balanceScore = 20; balanceRisk = 'critical'; }
      else if (hoursLeft <= 24) { balanceScore = 40; balanceRisk = 'warning'; }
      else if (hoursLeft <= 72) { balanceScore = 60; balanceRisk = 'caution'; }
      else if (hoursLeft <= 168) { balanceScore = 80; balanceRisk = 'good'; }
    } else if (record.credits <= 0) {
      balanceScore = 0;
      balanceRisk = 'critical';
    }

    // ── Component 2: Quota utilization (25% weight) ──
    let quotaScore = 100;
    let quotaRisk = 'healthy';
    const quotaConfig = record.quota || this.config.globalQuota;
    if (quotaConfig) {
      // Reset counters if day/month rolled over before reading
      this.gate.quotaTracker.resetIfNeeded(record);
      let maxUtilization = 0;

      if (quotaConfig.dailyCallLimit && quotaConfig.dailyCallLimit > 0) {
        maxUtilization = Math.max(maxUtilization, record.quotaDailyCalls / quotaConfig.dailyCallLimit);
      }
      if (quotaConfig.monthlyCallLimit && quotaConfig.monthlyCallLimit > 0) {
        maxUtilization = Math.max(maxUtilization, record.quotaMonthlyCalls / quotaConfig.monthlyCallLimit);
      }
      if (quotaConfig.dailyCreditLimit && quotaConfig.dailyCreditLimit > 0) {
        maxUtilization = Math.max(maxUtilization, record.quotaDailyCredits / quotaConfig.dailyCreditLimit);
      }
      if (quotaConfig.monthlyCreditLimit && quotaConfig.monthlyCreditLimit > 0) {
        maxUtilization = Math.max(maxUtilization, record.quotaMonthlyCredits / quotaConfig.monthlyCreditLimit);
      }

      quotaScore = Math.max(0, Math.round((1 - maxUtilization) * 100));
      if (maxUtilization >= 1) quotaRisk = 'critical';
      else if (maxUtilization >= 0.9) quotaRisk = 'warning';
      else if (maxUtilization >= 0.75) quotaRisk = 'caution';
      else if (maxUtilization >= 0.5) quotaRisk = 'good';
    }

    // ── Component 3: Rate limit pressure (20% weight) ──
    const rateStatus = this.gate.rateLimiter.getStatus(actualKey);
    let rateLimitScore = 100;
    let rateLimitRisk = 'healthy';
    if (rateStatus.limit > 0) {
      const utilization = rateStatus.used / rateStatus.limit;
      rateLimitScore = Math.max(0, Math.round((1 - utilization) * 100));
      if (utilization >= 1) rateLimitRisk = 'critical';
      else if (utilization >= 0.9) rateLimitRisk = 'warning';
      else if (utilization >= 0.75) rateLimitRisk = 'caution';
      else if (utilization >= 0.5) rateLimitRisk = 'good';
    }

    // ── Component 4: Error rate (25% weight) ──
    const keyUsage = this.gate.meter.getKeyUsage(actualKey);
    let errorScore = 100;
    let errorRisk = 'healthy';
    if (keyUsage.totalCalls > 0) {
      const errorRate = keyUsage.totalDenied / keyUsage.totalCalls;
      errorScore = Math.max(0, Math.round((1 - errorRate) * 100));
      if (errorRate >= 0.5) errorRisk = 'critical';
      else if (errorRate >= 0.25) errorRisk = 'warning';
      else if (errorRate >= 0.1) errorRisk = 'caution';
      else if (errorRate > 0) errorRisk = 'good';
    }

    // ── Composite score (weighted) ──
    const overallScore = Math.round(
      balanceScore * 0.30 +
      quotaScore * 0.25 +
      rateLimitScore * 0.20 +
      errorScore * 0.25
    );

    let overallStatus = 'healthy';
    if (overallScore < 25) overallStatus = 'critical';
    else if (overallScore < 50) overallStatus = 'warning';
    else if (overallScore < 75) overallStatus = 'caution';
    else if (overallScore < 90) overallStatus = 'good';

    // Check key-level issues
    const issues: string[] = [];
    if (!record.active) issues.push('Key is revoked');
    if (record.suspended) issues.push('Key is suspended');
    if (record.expiresAt && new Date(record.expiresAt).getTime() < Date.now()) issues.push('Key has expired');
    if (record.expiresAt) {
      const hoursToExpiry = (new Date(record.expiresAt).getTime() - Date.now()) / 3_600_000;
      if (hoursToExpiry > 0 && hoursToExpiry <= 24) issues.push('Key expires within 24 hours');
      else if (hoursToExpiry > 0 && hoursToExpiry <= 168) issues.push('Key expires within 7 days');
    }
    if (record.credits <= 0) issues.push('Zero credits remaining');
    if (balanceRisk === 'critical') issues.push('Credits depleting rapidly');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      key: actualKey.slice(0, 10) + '...',
      name: record.name,
      score: overallScore,
      status: overallStatus,
      issues: issues.length > 0 ? issues : undefined,
      components: {
        balance: { score: balanceScore, risk: balanceRisk, weight: 0.30 },
        quota: { score: quotaScore, risk: quotaRisk, weight: 0.25 },
        rateLimit: { score: rateLimitScore, risk: rateLimitRisk, weight: 0.20 },
        errorRate: { score: errorScore, risk: errorRisk, weight: 0.25 },
      },
    }));
  }

  // ─── /keys/dashboard — Consolidated key overview ──────────────────────────────

  private handleKeyDashboard(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const keyParam = params.get('key');

    if (!keyParam) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required parameter: key' }));
      return;
    }

    const record = this.gate.store.resolveKeyRaw(keyParam);
    if (!record) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found' }));
      return;
    }

    const actualKey = record.key;
    const maskedKey = actualKey.slice(0, 7) + '...' + actualKey.slice(-4);

    // ── Metadata ──
    const isExpired = record.expiresAt ? new Date(record.expiresAt).getTime() < Date.now() : false;
    let status = 'active';
    if (!record.active) status = 'revoked';
    else if (record.suspended) status = 'suspended';
    else if (isExpired) status = 'expired';

    const metadata: Record<string, unknown> = {
      key: maskedKey,
      name: record.name || null,
      status,
      namespace: record.namespace || null,
      group: record.group || null,
      createdAt: record.createdAt || null,
      ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
      tags: record.tags && Object.keys(record.tags).length > 0 ? record.tags : undefined,
    };

    // ── Balance ──
    const balance = {
      credits: record.credits,
      totalSpent: record.totalSpent || 0,
      totalAllocated: record.credits + (record.totalSpent || 0),
      ...(record.spendingLimit ? { spendingLimit: record.spendingLimit } : {}),
    };

    // ── Health score (simplified from handleKeyHealth) ──
    const velocity = this.creditLedger.getSpendingVelocity(actualKey, record.credits, 24);
    let balanceScore = 100;
    if (velocity.creditsPerHour > 0) {
      const hoursLeft = velocity.estimatedHoursRemaining ?? Infinity;
      if (hoursLeft <= 1) balanceScore = 0;
      else if (hoursLeft <= 6) balanceScore = 20;
      else if (hoursLeft <= 24) balanceScore = 40;
      else if (hoursLeft <= 72) balanceScore = 60;
      else if (hoursLeft <= 168) balanceScore = 80;
    } else if (record.credits <= 0) {
      balanceScore = 0;
    }

    // Quota component
    let quotaScore = 100;
    const quotaConfig = record.quota || this.config.globalQuota;
    if (quotaConfig) {
      this.gate.quotaTracker.resetIfNeeded(record);
      let maxUtil = 0;
      if (quotaConfig.dailyCallLimit && quotaConfig.dailyCallLimit > 0)
        maxUtil = Math.max(maxUtil, record.quotaDailyCalls / quotaConfig.dailyCallLimit);
      if (quotaConfig.monthlyCallLimit && quotaConfig.monthlyCallLimit > 0)
        maxUtil = Math.max(maxUtil, record.quotaMonthlyCalls / quotaConfig.monthlyCallLimit);
      if (quotaConfig.dailyCreditLimit && quotaConfig.dailyCreditLimit > 0)
        maxUtil = Math.max(maxUtil, record.quotaDailyCredits / quotaConfig.dailyCreditLimit);
      if (quotaConfig.monthlyCreditLimit && quotaConfig.monthlyCreditLimit > 0)
        maxUtil = Math.max(maxUtil, record.quotaMonthlyCredits / quotaConfig.monthlyCreditLimit);
      quotaScore = Math.max(0, Math.round((1 - maxUtil) * 100));
    }

    // Rate limit component
    const rateStatus = this.gate.rateLimiter.getStatus(actualKey);
    let rateLimitScore = 100;
    if (rateStatus.limit > 0) {
      const utilization = rateStatus.used / rateStatus.limit;
      rateLimitScore = Math.max(0, Math.round((1 - utilization) * 100));
    }

    // Error rate component
    const keyUsage = this.gate.meter.getKeyUsage(actualKey);
    let errorScore = 100;
    if (keyUsage.totalCalls > 0) {
      const errorRate = keyUsage.totalDenied / keyUsage.totalCalls;
      errorScore = Math.max(0, Math.round((1 - errorRate) * 100));
    }

    const healthScore = Math.round(
      balanceScore * 0.30 + quotaScore * 0.25 + rateLimitScore * 0.20 + errorScore * 0.25
    );
    let healthStatus = 'healthy';
    if (healthScore < 25) healthStatus = 'critical';
    else if (healthScore < 50) healthStatus = 'warning';
    else if (healthScore < 75) healthStatus = 'caution';
    else if (healthScore < 90) healthStatus = 'good';

    // ── Velocity ──
    const velocitySummary = {
      creditsPerHour: velocity.creditsPerHour,
      creditsPerDay: velocity.creditsPerDay,
      callsPerHour: velocity.callsPerHour,
      callsPerDay: velocity.callsPerDay,
      estimatedDepletionDate: velocity.estimatedDepletionDate || null,
    };

    // ── Rate limits ──
    const rateLimits: Record<string, unknown> = {
      global: {
        limit: rateStatus.limit,
        used: rateStatus.used,
        remaining: rateStatus.remaining,
        resetInMs: rateStatus.resetInMs,
      },
    };

    // ── Quotas ──
    let quotas: Record<string, unknown> | undefined;
    if (quotaConfig) {
      this.gate.quotaTracker.resetIfNeeded(record);
      quotas = {
        source: record.quota ? 'per-key' : 'global',
        daily: {
          callsUsed: record.quotaDailyCalls,
          callsLimit: quotaConfig.dailyCallLimit || 0,
          creditsUsed: record.quotaDailyCredits,
          creditsLimit: quotaConfig.dailyCreditLimit || 0,
        },
        monthly: {
          callsUsed: record.quotaMonthlyCalls,
          callsLimit: quotaConfig.monthlyCallLimit || 0,
          creditsUsed: record.quotaMonthlyCredits,
          creditsLimit: quotaConfig.monthlyCreditLimit || 0,
        },
      };
    }

    // ── Usage summary ──
    const usage = {
      totalCalls: keyUsage.totalCalls || 0,
      totalAllowed: keyUsage.totalAllowed || 0,
      totalDenied: keyUsage.totalDenied || 0,
      totalCredits: keyUsage.totalCreditsSpent || 0,
    };

    // ── Recent activity (last 10 events) ──
    const maskedForAudit = maskKeyForAudit(actualKey);
    const auditResult = this.audit.query({ limit: 100 });
    const recentActivity = auditResult.events
      .filter(e => {
        for (const field of ['key', 'keyMasked', 'sourceKey', 'destKey'] as const) {
          const val = e.metadata?.[field];
          if (val && typeof val === 'string' && val === maskedForAudit) return true;
        }
        if (e.actor === maskedForAudit) return true;
        return false;
      })
      .slice(0, 10)
      .map(e => ({
        timestamp: e.timestamp,
        event: e.type,
        ...(e.metadata?.tool ? { tool: e.metadata.tool } : {}),
        ...(e.metadata?.credits ? { credits: e.metadata.credits } : {}),
      }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ...metadata,
      balance,
      health: { score: healthScore, status: healthStatus },
      velocity: velocitySummary,
      rateLimits,
      ...(quotas ? { quotas } : {}),
      usage,
      recentActivity: recentActivity.length > 0 ? recentActivity : [],
    }));
  }

  // ─── /keys/auto-topup — Configure auto-topup ────────────────────────────────

  private async handleSetAutoTopup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { key?: string; threshold?: number; amount?: number; maxDaily?: number; disable?: boolean };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.key) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing key' }));
      return;
    }

    const record = this.gate.store.resolveKey(params.key);
    if (!record) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found or inactive' }));
      return;
    }

    // Disable auto-topup
    if (params.disable) {
      record.autoTopup = undefined;
      this.gate.store.save();
      this.syncKeyMutation(params.key);

      this.audit.log('key.auto_topup_configured', 'admin', 'Auto-topup disabled', {
        keyMasked: maskKeyForAudit(params.key),
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ autoTopup: null, message: 'Auto-topup disabled' }));
      return;
    }

    // Validate params
    const threshold = Math.max(0, Math.floor(Number(params.threshold) || 0));
    const amount = Math.max(0, Math.floor(Number(params.amount) || 0));
    const maxDaily = Math.max(0, Math.floor(Number(params.maxDaily) || 0));

    if (threshold <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'threshold must be a positive integer' }));
      return;
    }
    if (amount <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'amount must be a positive integer' }));
      return;
    }

    record.autoTopup = { threshold, amount, maxDaily };
    this.gate.store.save();
    this.syncKeyMutation(params.key);

    this.audit.log('key.auto_topup_configured', 'admin', `Auto-topup configured: threshold=${threshold}, amount=${amount}, maxDaily=${maxDaily}`, {
      keyMasked: maskKeyForAudit(params.key),
      threshold, amount, maxDaily,
    });
    this.emitWebhookAdmin('key.auto_topup_configured', 'admin', {
      keyMasked: maskKeyForAudit(params.key), threshold, amount, maxDaily,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      autoTopup: record.autoTopup,
      message: `Auto-topup enabled: add ${amount} credits when balance drops below ${threshold}` +
        (maxDaily > 0 ? ` (max ${maxDaily}/day)` : ' (unlimited daily)'),
    }));
  }

  // ─── /balance — Client self-service ────────────────────────────────────────

  private handleBalance(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const apiKey = (req.headers['x-api-key'] as string) || null;
    if (!apiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing X-API-Key header' }));
      return;
    }

    const record = this.gate.store.getKey(apiKey);
    if (!record || !record.active) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or inactive API key' }));
      return;
    }

    // Return balance and basic usage info (no sensitive data)
    const remainingBudget = record.spendingLimit > 0
      ? Math.max(0, record.spendingLimit - record.totalSpent)
      : null;

    // Reset quotas if needed before reporting
    this.gate.quotaTracker.resetIfNeeded(record);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: record.name,
      credits: record.credits,
      totalSpent: record.totalSpent,
      totalCalls: record.totalCalls,
      spendingLimit: record.spendingLimit,
      remainingBudget,
      lastUsedAt: record.lastUsedAt,
      allowedTools: record.allowedTools,
      deniedTools: record.deniedTools,
      expiresAt: record.expiresAt,
      tags: record.tags,
      ipAllowlist: record.ipAllowlist,
      quota: record.quota || null,
      quotaUsage: {
        dailyCalls: record.quotaDailyCalls,
        monthlyCalls: record.quotaMonthlyCalls,
        dailyCredits: record.quotaDailyCredits,
        monthlyCredits: record.quotaMonthlyCredits,
      },
    }));
  }

  // ─── /limits — Set spending limit ────────────────────────────────────────

  private async handleLimits(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { key?: string; spendingLimit?: number };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.key) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing key' }));
      return;
    }

    const record = this.gate.store.resolveKey(params.key);
    if (!record) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found or inactive' }));
      return;
    }

    const limit = Math.max(0, Math.floor(Number(params.spendingLimit) || 0));
    record.spendingLimit = limit;
    this.gate.store.save();
    this.syncKeyMutation(params.key);

    this.audit.log('key.limit_updated', 'admin', limit > 0 ? `Spending limit set to ${limit}` : 'Spending limit removed', {
      keyMasked: maskKeyForAudit(params.key),
      spendingLimit: limit,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      spendingLimit: record.spendingLimit,
      message: limit > 0 ? `Spending limit set to ${limit}` : 'Spending limit removed (unlimited)',
    }));
  }

  // ─── /usage — Admin usage export ──────────────────────────────────────────

  private handleUsage(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    // Parse query params for filtering
    const urlParts = req.url?.split('?') || [];
    const queryStr = urlParts[1] || '';
    const params = new URLSearchParams(queryStr);
    const since = params.get('since') || undefined;
    const format = params.get('format') || 'json';
    const namespace = params.get('namespace') || undefined;

    const events = this.gate.meter.getEvents(since, namespace);

    if (format === 'csv') {
      // CSV export
      const header = 'timestamp,apiKey,keyName,tool,creditsCharged,allowed,denyReason';
      const rows = events.map(e =>
        `${e.timestamp},${e.apiKey.slice(0, 10)}...,${e.keyName},${e.tool},${e.creditsCharged},${e.allowed},${e.denyReason || ''}`
      );
      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="paygate-usage.csv"',
      });
      res.end([header, ...rows].join('\n'));
    } else {
      // JSON export (default)
      // Mask API keys in export
      const masked = events.map(e => ({
        ...e,
        apiKey: e.apiKey.slice(0, 10) + '...',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        count: masked.length,
        since: since || 'all',
        events: masked,
      }, null, 2));
    }
  }

  // ─── /stripe/webhook — Stripe integration ────────────────────────────────

  private async handleStripeWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    if (!this.stripeHandler) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Stripe integration not configured' }));
      return;
    }

    const rawBody = await this.readBody(req);
    const signature = req.headers['stripe-signature'] as string;

    if (!signature) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing Stripe-Signature header' }));
      return;
    }

    const result = this.stripeHandler.handleWebhook(rawBody, signature);

    if (result.success) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
  }

  // ─── /dashboard — Admin web dashboard ─────────────────────────────────────

  private handleDashboard(_req: IncomingMessage, res: ServerResponse): void {
    // Dashboard is public HTML — auth is done client-side via admin key prompt.
    // The dashboard JS calls /status, /usage, /keys which all require X-Admin-Key.
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(getDashboardHtml(this.config.name));
  }

  // ─── OAuth 2.1 Endpoints ────────────────────────────────────────────────────

  /** GET /.well-known/oauth-authorization-server — Server metadata (RFC 8414) */
  private handleOAuthMetadata(_req: IncomingMessage, res: ServerResponse): void {
    if (!this.oauth) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'OAuth not enabled' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.oauth.getMetadata()));
  }

  /** POST /oauth/register — Dynamic Client Registration (RFC 7591) */
  private async handleOAuthRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.oauth) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'OAuth not enabled' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const body = await this.readBody(req);
    let params: {
      client_name?: string;
      redirect_uris?: string[];
      grant_types?: string[];
      scope?: string;
      api_key?: string; // optional: link to existing API key
    };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_client_metadata' }));
      return;
    }

    if (!params.client_name || !params.redirect_uris?.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_client_metadata', error_description: 'client_name and redirect_uris are required' }));
      return;
    }

    try {
      const client = this.oauth.registerClient({
        clientName: params.client_name,
        redirectUris: params.redirect_uris,
        grantTypes: params.grant_types,
        scope: params.scope,
        apiKeyRef: params.api_key,
      });

      // RFC 7591 response format
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        grant_types: client.grantTypes,
        scope: client.scope,
        client_id_issued_at: Math.floor(new Date(client.createdAt).getTime() / 1000),
      }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_client_metadata', error_description: (err as Error).message }));
    }
  }

  /** GET/POST /oauth/authorize — Authorization endpoint */
  private async handleOAuthAuthorize(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.oauth) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'OAuth not enabled' }));
      return;
    }

    // Parse query params from URL (for GET) or body (for POST)
    let params: Record<string, string> = {};

    if (req.method === 'GET') {
      const urlParts = req.url?.split('?') || [];
      const query = new URLSearchParams(urlParts[1] || '');
      for (const [k, v] of query) params[k] = v;
    } else if (req.method === 'POST') {
      const body = await this.readBody(req);
      try {
        params = JSON.parse(body);
      } catch {
        // Try URL-encoded form data
        const query = new URLSearchParams(body);
        for (const [k, v] of query) params[k] = v;
      }
    } else {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const clientId = params.client_id;
    const redirectUri = params.redirect_uri;
    const codeChallenge = params.code_challenge;
    const codeChallengeMethod = params.code_challenge_method;
    const scope = params.scope;
    const state = params.state;
    const responseType = params.response_type;

    // Validate required params
    if (responseType !== 'code') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported_response_type' }));
      return;
    }

    if (!clientId || !redirectUri || !codeChallenge) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_request', error_description: 'client_id, redirect_uri, and code_challenge are required' }));
      return;
    }

    // For server-to-server MCP: auto-approve if the client has a linked API key.
    // In a browser-based flow, this would show a consent page.
    try {
      const code = this.oauth.createAuthCode({
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod,
        scope,
      });

      // Redirect with auth code
      const redirectUrl = new URL(redirectUri);
      redirectUrl.searchParams.set('code', code);
      if (state) redirectUrl.searchParams.set('state', state);

      res.writeHead(302, { Location: redirectUrl.toString() });
      res.end();
    } catch (err) {
      const errorMsg = (err as Error).message;
      // If there's a redirect URI and client is valid, redirect with error
      if (redirectUri) {
        try {
          const redirectUrl = new URL(redirectUri);
          redirectUrl.searchParams.set('error', 'server_error');
          redirectUrl.searchParams.set('error_description', errorMsg);
          if (state) redirectUrl.searchParams.set('state', state);
          res.writeHead(302, { Location: redirectUrl.toString() });
          res.end();
          return;
        } catch { /* fall through to JSON error */ }
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_request', error_description: errorMsg }));
    }
  }

  /** POST /oauth/token — Token endpoint */
  private async handleOAuthToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.oauth) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'OAuth not enabled' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const body = await this.readBody(req);
    let params: Record<string, string>;
    try {
      params = JSON.parse(body);
    } catch {
      // Try URL-encoded form data
      params = {};
      const query = new URLSearchParams(body);
      for (const [k, v] of query) params[k] = v;
    }

    const grantType = params.grant_type;

    try {
      if (grantType === 'authorization_code') {
        // Exchange auth code for tokens
        const result = this.oauth.exchangeCode({
          code: params.code,
          clientId: params.client_id,
          redirectUri: params.redirect_uri,
          codeVerifier: params.code_verifier,
        });

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Pragma': 'no-cache',
        });
        res.end(JSON.stringify({
          access_token: result.accessToken,
          token_type: result.tokenType,
          expires_in: result.expiresIn,
          refresh_token: result.refreshToken,
          scope: result.scope,
        }));
      } else if (grantType === 'refresh_token') {
        // Refresh access token
        const result = this.oauth.refreshAccessToken({
          refreshToken: params.refresh_token,
          clientId: params.client_id,
          scope: params.scope,
        });

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Pragma': 'no-cache',
        });
        res.end(JSON.stringify({
          access_token: result.accessToken,
          token_type: result.tokenType,
          expires_in: result.expiresIn,
          scope: result.scope,
        }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
      }
    } catch (err) {
      const errorMsg = (err as Error).message;
      const errorCode = errorMsg.startsWith('invalid_grant') ? 'invalid_grant' : 'invalid_request';
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: errorCode, error_description: errorMsg }));
    }
  }

  /** POST /oauth/revoke — Token revocation (RFC 7009) */
  private async handleOAuthRevoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.oauth) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'OAuth not enabled' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const body = await this.readBody(req);
    let params: { token?: string };
    try {
      params = JSON.parse(body);
    } catch {
      const query = new URLSearchParams(body);
      params = { token: query.get('token') || undefined };
    }

    if (!params.token) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_request', error_description: 'token is required' }));
      return;
    }

    // RFC 7009: always return 200, even if token doesn't exist
    this.oauth.revokeToken(params.token);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ revoked: true }));
  }

  /** GET /oauth/clients — List registered OAuth clients (admin only) */
  private handleOAuthClients(req: IncomingMessage, res: ServerResponse): void {
    if (!this.oauth) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'OAuth not enabled' }));
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.oauth.listClients(), null, 2));
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  // ─── /.well-known/mcp-payment — Payment metadata (SEP-2007) ────────────────

  private handlePaymentMetadata(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.registry.getServerMetadata(), null, 2));
  }

  // ─── /pricing — Full pricing breakdown ────────────────────────────────────

  private handlePricing(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.registry.getFullPricing(), null, 2));
  }

  // ─── /metrics — Prometheus metrics ──────────────────────────────────────────

  private handleMetrics(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(this.metrics.serialize());
  }

  // ─── /analytics — Usage analytics ──────────────────────────────────────────

  private handleAnalytics(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');

    const from = params.get('from') || undefined;
    const to = params.get('to') || undefined;
    const granularity = (params.get('granularity') || 'hourly') as 'hourly' | 'daily';
    const topN = params.get('top') ? parseInt(params.get('top')!, 10) : 10;
    const namespace = params.get('namespace') || undefined;

    const events = this.gate.meter.getEvents(undefined, namespace);
    const report = this.analytics.report(events, { from, to, granularity, topN });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(report, null, 2));
  }

  // ─── /alerts — Alert management ────────────────────────────────────────────

  private handleGetAlerts(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    const alerts = this.alerts.consumeAlerts();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      alerts,
      count: alerts.length,
      rules: this.alerts.configuredRules,
    }));
  }

  private async handleConfigureAlerts(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { rules?: Array<{ type: string; threshold: number; cooldownSeconds?: number }> };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.rules || !Array.isArray(params.rules)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid rules array' }));
      return;
    }

    // Validate rule types
    const validTypes = ['spending_threshold', 'credits_low', 'quota_warning', 'key_expiry_soon', 'rate_limit_spike'];
    for (const rule of params.rules) {
      if (!validTypes.includes(rule.type)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid alert type: ${rule.type}. Valid: ${validTypes.join(', ')}` }));
        return;
      }
      if (typeof rule.threshold !== 'number' || rule.threshold < 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid threshold for ${rule.type}: must be a non-negative number` }));
        return;
      }
    }

    // Replace the alert engine with new rules
    (this as any).alerts = new AlertEngine({ rules: params.rules as any });

    this.audit.log('admin.alerts_configured', 'admin', `Alert rules updated (${params.rules.length} rules)`, {
      ruleCount: params.rules.length,
      rules: params.rules,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      rules: params.rules,
      message: `${params.rules.length} alert rule(s) configured`,
    }));
  }

  // ─── /webhooks/dead-letter — View/clear dead letter queue ────────────────

  private handleGetDeadLetters(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    if (!this.gate.webhook) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deadLetters: [], count: 0, message: 'No webhook configured' }));
      return;
    }

    const deadLetters = this.gate.webhook.getDeadLetters();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      deadLetters,
      count: deadLetters.length,
    }));
  }

  private handleClearDeadLetters(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res, 'admin')) return;

    if (!this.gate.webhook) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ cleared: 0, message: 'No webhook configured' }));
      return;
    }

    const cleared = this.gate.webhook.clearDeadLetters();

    this.audit.log('webhook.dead_letter_cleared', 'admin', `Cleared ${cleared} dead letter entries`, {
      cleared,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      cleared,
      message: `Cleared ${cleared} dead letter entries`,
    }));
  }

  // ─── /webhooks/replay — Replay dead letter events ───────────────────────

  private async handleWebhookReplay(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    if (!this.gate.webhook) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ replayed: 0, message: 'No webhook configured' }));
      return;
    }

    const body = await this.readBody(req);
    let params: { indices?: number[] } = {};
    if (body.trim()) {
      try {
        params = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
    }

    const indices = Array.isArray(params.indices) ? params.indices.filter(i => typeof i === 'number') : undefined;
    const deadLetterCount = this.gate.webhook.getDeadLetters().length;

    if (deadLetterCount === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ replayed: 0, remaining: 0, message: 'Dead letter queue is empty' }));
      return;
    }

    const replayed = this.gate.webhook.replayDeadLetters(indices && indices.length > 0 ? indices : undefined);
    const remaining = this.gate.webhook.getDeadLetters().length;

    this.audit.log('webhook.replayed', 'admin', `Replayed ${replayed} dead letter entries`, {
      replayed, remaining, indices: indices || 'all',
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      replayed,
      remaining,
      message: `Replayed ${replayed} dead letter entries`,
    }));
  }

  // ─── /maintenance — Maintenance mode (503 on /mcp while admin stays up) ──

  private handleGetMaintenance(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      enabled: this.maintenanceMode,
      message: this.maintenanceMode ? this.maintenanceMessage : undefined,
      since: this.maintenanceSince,
    }));
  }

  private handleSetMaintenance(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk; });
    req.on('end', () => {
      let params: { enabled?: boolean; message?: string };
      try {
        params = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }

      if (typeof params.enabled !== 'boolean') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required field: enabled (boolean)' }));
        return;
      }

      const wasEnabled = this.maintenanceMode;
      this.maintenanceMode = params.enabled;

      if (params.enabled) {
        this.maintenanceMessage = params.message || 'Server is under maintenance';
        this.maintenanceSince = new Date().toISOString();
        if (!wasEnabled) {
          this.audit.log('maintenance.enabled', 'admin', `Maintenance mode enabled: ${this.maintenanceMessage}`, {
            message: this.maintenanceMessage,
          });
        }
      } else {
        if (wasEnabled) {
          this.audit.log('maintenance.disabled', 'admin', 'Maintenance mode disabled', {
            since: this.maintenanceSince,
          });
        }
        this.maintenanceMessage = 'Server is under maintenance';
        this.maintenanceSince = null;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        enabled: this.maintenanceMode,
        message: this.maintenanceMode ? this.maintenanceMessage : undefined,
        since: this.maintenanceSince,
      }));
    });
  }

  // ─── /admin/events — Real-time SSE stream of server events ────────────────

  private handleAdminEventStream(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    const accept = req.headers['accept'] || '';
    if (!accept.includes('text/event-stream')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Requires Accept: text/event-stream header' }));
      return;
    }

    // Parse optional type filter from query string
    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const typesParam = params.get('types');
    const typeFilter = typesParam ? new Set(typesParam.split(',').filter(Boolean)) : null;

    // Start SSE stream
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send connected event
    res.write(`event: connected\ndata: ${JSON.stringify({ message: 'Admin event stream connected', filters: typesParam || 'all' })}\n\n`);

    // Register this connection
    const client = { res, types: typeFilter };
    this.adminEventStreams.add(client);

    // Start keepalive if this is the first connection
    if (!this.adminEventKeepAliveTimer && this.adminEventStreams.size === 1) {
      this.adminEventKeepAliveTimer = setInterval(() => {
        for (const c of this.adminEventStreams) {
          try { c.res.write(':keepalive\n\n'); } catch { /* handled by close */ }
        }
      }, 15_000);
      this.adminEventKeepAliveTimer.unref();
    }

    // Cleanup on disconnect
    req.on('close', () => {
      this.adminEventStreams.delete(client);
      // Stop keepalive if no more connections
      if (this.adminEventStreams.size === 0 && this.adminEventKeepAliveTimer) {
        clearInterval(this.adminEventKeepAliveTimer);
        this.adminEventKeepAliveTimer = null;
      }
    });
  }

  // ─── /admin/notifications — Actionable notifications ──────────────────────

  private handleAdminNotifications(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const severityFilter = params.get('severity'); // critical, warning, info, or null for all

    interface Notification {
      severity: 'critical' | 'warning' | 'info';
      category: string;
      message: string;
      key?: string;
      keyName?: string;
      details?: Record<string, unknown>;
    }
    const notifications: Notification[] = [];

    // Scan all keys for issues
    const allRecords = this.gate.store.getAllRecords();

    for (const record of allRecords) {
      const maskedKey = record.key.slice(0, 7) + '...' + record.key.slice(-4);
      const keyName = record.name || undefined;

      // Skip revoked keys
      if (!record.active) continue;

      // ── Expiry checks ──
      if (record.expiresAt) {
        const msToExpiry = new Date(record.expiresAt).getTime() - Date.now();
        const hoursToExpiry = msToExpiry / 3_600_000;
        if (msToExpiry <= 0) {
          notifications.push({
            severity: 'critical', category: 'key_expired',
            message: `Key has expired`,
            key: maskedKey, keyName,
            details: { expiresAt: record.expiresAt },
          });
        } else if (hoursToExpiry <= 24) {
          notifications.push({
            severity: 'critical', category: 'key_expiring_soon',
            message: `Key expires within ${Math.ceil(hoursToExpiry)} hours`,
            key: maskedKey, keyName,
            details: { expiresAt: record.expiresAt, hoursRemaining: Math.round(hoursToExpiry * 10) / 10 },
          });
        } else if (hoursToExpiry <= 168) {
          notifications.push({
            severity: 'warning', category: 'key_expiring_soon',
            message: `Key expires within ${Math.ceil(hoursToExpiry / 24)} days`,
            key: maskedKey, keyName,
            details: { expiresAt: record.expiresAt, daysRemaining: Math.round(hoursToExpiry / 24 * 10) / 10 },
          });
        }
      }

      // ── Credit checks ──
      if (record.credits <= 0) {
        notifications.push({
          severity: 'critical', category: 'zero_credits',
          message: `Key has zero credits remaining`,
          key: maskedKey, keyName,
        });
      } else {
        // Check spending velocity for depletion
        const velocity = this.creditLedger.getSpendingVelocity(record.key, record.credits, 24);
        if (velocity.creditsPerHour > 0) {
          const hoursLeft = velocity.estimatedHoursRemaining ?? Infinity;
          if (hoursLeft <= 6) {
            notifications.push({
              severity: 'critical', category: 'credits_depleting',
              message: `Credits will deplete in ~${Math.ceil(hoursLeft)} hours at current rate`,
              key: maskedKey, keyName,
              details: { credits: record.credits, creditsPerHour: velocity.creditsPerHour, estimatedHoursRemaining: Math.round(hoursLeft * 10) / 10 },
            });
          } else if (hoursLeft <= 24) {
            notifications.push({
              severity: 'warning', category: 'credits_depleting',
              message: `Credits will deplete in ~${Math.ceil(hoursLeft)} hours at current rate`,
              key: maskedKey, keyName,
              details: { credits: record.credits, creditsPerHour: velocity.creditsPerHour, estimatedHoursRemaining: Math.round(hoursLeft * 10) / 10 },
            });
          }
        }
      }

      // ── Suspended key ──
      if (record.suspended) {
        notifications.push({
          severity: 'info', category: 'key_suspended',
          message: `Key is suspended`,
          key: maskedKey, keyName,
        });
      }

      // ── Error rate check ──
      const keyUsage = this.gate.meter.getKeyUsage(record.key);
      if (keyUsage.totalCalls >= 10) {
        const errorRate = keyUsage.totalDenied / keyUsage.totalCalls;
        if (errorRate >= 0.5) {
          notifications.push({
            severity: 'critical', category: 'high_error_rate',
            message: `${Math.round(errorRate * 100)}% error rate (${keyUsage.totalDenied}/${keyUsage.totalCalls} denied)`,
            key: maskedKey, keyName,
            details: { errorRate: Math.round(errorRate * 1000) / 1000, totalCalls: keyUsage.totalCalls, totalDenied: keyUsage.totalDenied },
          });
        } else if (errorRate >= 0.25) {
          notifications.push({
            severity: 'warning', category: 'high_error_rate',
            message: `${Math.round(errorRate * 100)}% error rate (${keyUsage.totalDenied}/${keyUsage.totalCalls} denied)`,
            key: maskedKey, keyName,
            details: { errorRate: Math.round(errorRate * 1000) / 1000, totalCalls: keyUsage.totalCalls, totalDenied: keyUsage.totalDenied },
          });
        }
      }

      // ── Rate limit pressure ──
      const rateStatus = this.gate.rateLimiter.getStatus(record.key);
      if (rateStatus.limit > 0) {
        const utilization = rateStatus.used / rateStatus.limit;
        if (utilization >= 0.9) {
          notifications.push({
            severity: 'warning', category: 'rate_limit_pressure',
            message: `${Math.round(utilization * 100)}% rate limit utilization (${rateStatus.used}/${rateStatus.limit})`,
            key: maskedKey, keyName,
            details: { used: rateStatus.used, limit: rateStatus.limit, remaining: rateStatus.remaining },
          });
        }
      }
    }

    // Apply severity filter
    let filtered = notifications;
    if (severityFilter) {
      filtered = notifications.filter(n => n.severity === severityFilter);
    }

    // Sort: critical first, then warning, then info
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    filtered.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      total: filtered.length,
      critical: filtered.filter(n => n.severity === 'critical').length,
      warning: filtered.filter(n => n.severity === 'warning').length,
      info: filtered.filter(n => n.severity === 'info').length,
      notifications: filtered,
    }));
  }

  // ─── /admin/dashboard — System-wide overview ──────────────────────────────

  private handleSystemDashboard(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    const allRecords = this.gate.store.getAllRecords();
    const now = Date.now();

    // ── Key statistics ──
    let activeCount = 0;
    let suspendedCount = 0;
    let revokedCount = 0;
    let expiredCount = 0;
    let totalAllocated = 0;
    let totalSpent = 0;
    let totalRemaining = 0;

    for (const record of allRecords) {
      totalAllocated += record.credits + (record.totalSpent || 0);
      totalSpent += record.totalSpent || 0;
      totalRemaining += record.credits;

      if (!record.active) {
        revokedCount++;
      } else if (record.expiresAt && new Date(record.expiresAt).getTime() <= now) {
        expiredCount++;
      } else if (record.suspended) {
        suspendedCount++;
      } else {
        activeCount++;
      }
    }

    // ── Usage summary ──
    const usageSummary = this.gate.meter.getSummary();

    // ── Top consumers (by credits spent) ──
    const perKeyEntries = Object.entries(usageSummary.perKey)
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.credits - a.credits)
      .slice(0, 10);

    // ── Top tools (by call count) ──
    const perToolEntries = Object.entries(usageSummary.perTool)
      .map(([tool, stats]) => ({ tool, ...stats }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 10);

    // ── Deny reason breakdown ──
    const denyReasons = Object.entries(usageSummary.denyReasons)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);

    // ── Uptime ──
    const uptimeMs = now - this.startedAt;
    const uptimeSeconds = Math.floor(uptimeMs / 1000);
    const uptimeHours = Math.round(uptimeMs / 3_600_000 * 10) / 10;

    // ── Notification summary (counts only) ──
    const notifRecords = allRecords.filter(r => r.active);
    let criticalCount = 0;
    let warningCount = 0;
    let infoCount = 0;
    for (const record of notifRecords) {
      if (record.expiresAt) {
        const msToExpiry = new Date(record.expiresAt).getTime() - now;
        if (msToExpiry <= 0) criticalCount++;
        else if (msToExpiry <= 24 * 3_600_000) criticalCount++;
        else if (msToExpiry <= 168 * 3_600_000) warningCount++;
      }
      if (record.credits <= 0) criticalCount++;
      if (record.suspended) infoCount++;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      keys: {
        total: allRecords.length,
        active: activeCount,
        suspended: suspendedCount,
        revoked: revokedCount,
        expired: expiredCount,
      },
      credits: {
        totalAllocated,
        totalSpent,
        totalRemaining,
      },
      usage: {
        totalCalls: usageSummary.totalCalls,
        totalAllowed: usageSummary.totalCalls - usageSummary.totalDenied,
        totalDenied: usageSummary.totalDenied,
        totalCreditsSpent: usageSummary.totalCreditsSpent,
        denyReasons,
      },
      topConsumers: perKeyEntries,
      topTools: perToolEntries,
      notifications: {
        critical: criticalCount,
        warning: warningCount,
        info: infoCount,
      },
      uptime: {
        startedAt: new Date(this.startedAt).toISOString(),
        uptimeSeconds,
        uptimeHours,
      },
    }));
  }

  // ─── /admin/lifecycle — Key lifecycle report ──────────────────────────────

  private handleKeyLifecycleReport(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const since = params.get('since') || undefined;
    const until = params.get('until') || undefined;

    // Query audit log for key lifecycle events
    const createdEvents = this.audit.query({
      types: ['key.created'], since, until, limit: 10_000,
    }).events;
    const revokedEvents = this.audit.query({
      types: ['key.revoked'], since, until, limit: 10_000,
    }).events;
    const suspendedEvents = this.audit.query({
      types: ['key.suspended'], since, until, limit: 10_000,
    }).events;
    const resumedEvents = this.audit.query({
      types: ['key.resumed'], since, until, limit: 10_000,
    }).events;
    const rotatedEvents = this.audit.query({
      types: ['key.rotated'], since, until, limit: 10_000,
    }).events;
    const clonedEvents = this.audit.query({
      types: ['key.cloned'], since, until, limit: 10_000,
    }).events;

    // Build daily buckets for trends
    const dayBuckets = new Map<string, { created: number; revoked: number; suspended: number; resumed: number }>();
    const addToBucket = (events: typeof createdEvents, field: string) => {
      for (const e of events) {
        const day = e.timestamp.slice(0, 10); // YYYY-MM-DD
        if (!dayBuckets.has(day)) dayBuckets.set(day, { created: 0, revoked: 0, suspended: 0, resumed: 0 });
        (dayBuckets.get(day) as any)[field]++;
      }
    };
    addToBucket(createdEvents, 'created');
    addToBucket(revokedEvents, 'revoked');
    addToBucket(suspendedEvents, 'suspended');
    addToBucket(resumedEvents, 'resumed');

    const trends = Array.from(dayBuckets.entries())
      .map(([date, counts]) => ({ date, ...counts }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Average key lifetime (for revoked keys that have creation metadata)
    const now = Date.now();
    const allRecords = this.gate.store.getAllRecords();
    const lifetimes: number[] = [];
    for (const record of allRecords) {
      if (!record.active && record.createdAt) {
        // Revoked key — estimate lifetime from created to now (or expiry)
        const created = new Date(record.createdAt).getTime();
        const end = record.expiresAt ? Math.min(new Date(record.expiresAt).getTime(), now) : now;
        if (created > 0 && end > created) {
          lifetimes.push(end - created);
        }
      }
    }
    const avgLifetimeHours = lifetimes.length > 0
      ? Math.round(lifetimes.reduce((a, b) => a + b, 0) / lifetimes.length / 3_600_000 * 10) / 10
      : null;

    // At-risk keys: active keys expiring within 7 days or with zero credits
    const atRiskKeys: Array<{ key: string; name?: string; risk: string; details: Record<string, unknown> }> = [];
    for (const record of allRecords) {
      if (!record.active) continue;
      if (record.suspended) continue;
      const maskedKey = record.key.slice(0, 7) + '...' + record.key.slice(-4);
      const keyName = record.name || undefined;

      if (record.credits <= 0) {
        atRiskKeys.push({ key: maskedKey, name: keyName, risk: 'zero_credits', details: { credits: 0 } });
      }
      if (record.expiresAt) {
        const msToExpiry = new Date(record.expiresAt).getTime() - now;
        if (msToExpiry <= 0) {
          atRiskKeys.push({ key: maskedKey, name: keyName, risk: 'expired', details: { expiresAt: record.expiresAt } });
        } else if (msToExpiry <= 7 * 24 * 3_600_000) {
          const daysLeft = Math.round(msToExpiry / 86_400_000 * 10) / 10;
          atRiskKeys.push({ key: maskedKey, name: keyName, risk: 'expiring_soon', details: { expiresAt: record.expiresAt, daysRemaining: daysLeft } });
        }
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      events: {
        created: createdEvents.length,
        revoked: revokedEvents.length,
        suspended: suspendedEvents.length,
        resumed: resumedEvents.length,
        rotated: rotatedEvents.length,
        cloned: clonedEvents.length,
      },
      trends,
      averageLifetimeHours: avgLifetimeHours,
      atRisk: atRiskKeys,
    }));
  }

  // ─── /keys/notes — Timestamped notes on API keys ─────────────────────────

  private handleGetNotes(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const keyParam = params.get('key');

    if (!keyParam) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required query parameter: key' }));
      return;
    }

    const record = this.gate.store.resolveKeyRaw(keyParam);
    if (!record) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found' }));
      return;
    }

    const notes = record.notes || [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ key: maskKeyForAudit(record.key), notes, count: notes.length }));
  }

  private handleAddNote(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk; });
    req.on('end', () => {
      let params: { key?: string; text?: string };
      try {
        params = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }

      if (!params.key || typeof params.key !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required field: key' }));
        return;
      }
      if (!params.text || typeof params.text !== 'string' || !params.text.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required field: text (non-empty string)' }));
        return;
      }
      if (params.text.length > 1000) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Note text must be 1000 characters or less' }));
        return;
      }

      const record = this.gate.store.resolveKeyRaw(params.key);
      if (!record) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Key not found' }));
        return;
      }

      if (!record.notes) record.notes = [];

      // Cap at 50 notes per key
      if (record.notes.length >= 50) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Maximum 50 notes per key reached. Delete old notes first.' }));
        return;
      }

      const note = {
        timestamp: new Date().toISOString(),
        author: 'admin',
        text: params.text.trim(),
      };
      record.notes.push(note);
      this.gate.store.save();

      this.audit.log('key.note_added', 'admin', `Note added to key`, {
        key: maskKeyForAudit(record.key),
        text: note.text.slice(0, 100),
      });

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ note, count: record.notes.length }));
    });
  }

  private handleDeleteNote(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const keyParam = params.get('key');
    const indexParam = params.get('index');

    if (!keyParam) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required query parameter: key' }));
      return;
    }
    if (indexParam === null || indexParam === undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required query parameter: index' }));
      return;
    }

    const record = this.gate.store.resolveKeyRaw(keyParam);
    if (!record) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found' }));
      return;
    }

    const notes = record.notes || [];
    const index = parseInt(indexParam, 10);
    if (isNaN(index) || index < 0 || index >= notes.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Invalid index: ${indexParam}. Must be 0-${notes.length - 1}` }));
      return;
    }

    const deleted = notes.splice(index, 1)[0];
    record.notes = notes;
    this.gate.store.save();

    this.audit.log('key.note_deleted', 'admin', `Note deleted from key`, {
      key: maskKeyForAudit(record.key),
      text: deleted.text.slice(0, 100),
      index,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted, remaining: notes.length }));
  }

  // ─── /keys/schedule — Scheduled actions on API keys ──────────────────────

  private handleGetSchedules(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const keyParam = params.get('key');

    let schedules = this.scheduledActions;
    if (keyParam) {
      // Resolve alias
      const record = this.gate.store.resolveKeyRaw(keyParam);
      if (!record) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Key not found' }));
        return;
      }
      schedules = schedules.filter(s => s.key === record.key);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      schedules: schedules.map(s => ({
        ...s,
        key: maskKeyForAudit(s.key),
      })),
      count: schedules.length,
    }));
  }

  private handleCreateSchedule(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk; });
    req.on('end', () => {
      let params: { key?: string; action?: string; executeAt?: string; params?: Record<string, unknown> };
      try {
        params = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }

      if (!params.key || typeof params.key !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required field: key' }));
        return;
      }

      const validActions = ['revoke', 'suspend', 'topup'];
      if (!params.action || !validActions.includes(params.action)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Missing or invalid action. Must be one of: ${validActions.join(', ')}` }));
        return;
      }

      if (!params.executeAt || typeof params.executeAt !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required field: executeAt (ISO 8601 timestamp)' }));
        return;
      }

      const executeTime = new Date(params.executeAt).getTime();
      if (isNaN(executeTime)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid executeAt: must be a valid ISO 8601 timestamp' }));
        return;
      }

      if (executeTime <= Date.now()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'executeAt must be in the future' }));
        return;
      }

      // Topup requires credits param
      if (params.action === 'topup') {
        const credits = (params.params as any)?.credits;
        if (!credits || typeof credits !== 'number' || credits <= 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'topup action requires params.credits (positive number)' }));
          return;
        }
      }

      const record = this.gate.store.resolveKeyRaw(params.key);
      if (!record) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Key not found' }));
        return;
      }

      // Max 20 schedules per key
      const keySchedules = this.scheduledActions.filter(s => s.key === record.key);
      if (keySchedules.length >= 20) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Maximum 20 scheduled actions per key' }));
        return;
      }

      const schedule = {
        id: `sched_${this.nextScheduleId++}`,
        key: record.key,
        action: params.action as 'revoke' | 'suspend' | 'topup',
        executeAt: new Date(params.executeAt).toISOString(),
        createdAt: new Date().toISOString(),
        params: params.params,
      };
      this.scheduledActions.push(schedule);

      this.audit.log('schedule.created', 'admin', `Scheduled ${params.action} on key`, {
        scheduleId: schedule.id,
        key: maskKeyForAudit(record.key),
        action: params.action,
        executeAt: schedule.executeAt,
      });

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...schedule,
        key: maskKeyForAudit(schedule.key),
      }));
    });
  }

  private handleCancelSchedule(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const scheduleId = params.get('id');

    if (!scheduleId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required query parameter: id' }));
      return;
    }

    const idx = this.scheduledActions.findIndex(s => s.id === scheduleId);
    if (idx === -1) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Schedule not found' }));
      return;
    }

    const cancelled = this.scheduledActions.splice(idx, 1)[0];

    this.audit.log('schedule.cancelled', 'admin', `Cancelled scheduled ${cancelled.action}`, {
      scheduleId: cancelled.id,
      key: maskKeyForAudit(cancelled.key),
      action: cancelled.action,
      executeAt: cancelled.executeAt,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      cancelled: { ...cancelled, key: maskKeyForAudit(cancelled.key) },
    }));
  }

  /** Execute any scheduled actions that are due. Called by the schedule timer. */
  private executeScheduledActions(): void {
    const now = Date.now();
    const due = this.scheduledActions.filter(s => new Date(s.executeAt).getTime() <= now);

    for (const schedule of due) {
      // Remove from queue
      const idx = this.scheduledActions.indexOf(schedule);
      if (idx !== -1) this.scheduledActions.splice(idx, 1);

      const record = this.gate.store.resolveKeyRaw(schedule.key);
      if (!record) continue; // Key was deleted

      try {
        switch (schedule.action) {
          case 'revoke':
            if (record.active) {
              record.active = false;
              this.gate.store.save();
            }
            break;
          case 'suspend':
            if (!record.suspended) {
              record.suspended = true;
              this.gate.store.save();
            }
            break;
          case 'topup': {
            const credits = (schedule.params as any)?.credits || 0;
            if (credits > 0) {
              record.credits += credits;
              this.gate.store.save();
            }
            break;
          }
        }

        this.audit.log('schedule.executed', 'system', `Executed scheduled ${schedule.action}`, {
          scheduleId: schedule.id,
          key: maskKeyForAudit(schedule.key),
          action: schedule.action,
        });
      } catch {
        // Log error but don't crash
      }
    }
  }

  // ─── /keys/activity — Unified activity timeline for a key ────────────────

  private handleKeyActivity(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const keyParam = params.get('key');

    if (!keyParam) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required query parameter: key' }));
      return;
    }

    const record = this.gate.store.resolveKeyRaw(keyParam);
    if (!record) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found' }));
      return;
    }

    const since = params.get('since') || undefined;
    const limit = Math.min(200, Math.max(1, parseInt(params.get('limit') || '50', 10) || 50));
    const maskedKey = maskKeyForAudit(record.key);

    // 1. Collect audit events for this key
    // Audit events store masked keys in metadata.key or metadata.keyMasked
    const auditResult = this.audit.query({
      since,
      limit: 1000, // Grab up to 1000 to merge
    });
    const keyAuditEvents = auditResult.events.filter(e => {
      // Check metadata.key or metadata.keyMasked (both patterns are used)
      for (const field of ['key', 'keyMasked', 'sourceKey', 'destKey'] as const) {
        const val = e.metadata?.[field];
        if (val && typeof val === 'string' && val === maskedKey) return true;
      }
      // Check actor field (gate events use masked key as actor)
      if (e.actor === maskedKey) return true;
      return false;
    });

    // 2. Collect usage events for this key
    const usageEvents = this.gate.meter.getEvents(since).filter(e => e.apiKey === record.key);

    // 3. Merge into unified timeline
    const timeline: Array<{
      timestamp: string;
      source: 'audit' | 'usage';
      type: string;
      message: string;
      metadata: Record<string, unknown>;
    }> = [];

    for (const e of keyAuditEvents) {
      timeline.push({
        timestamp: e.timestamp,
        source: 'audit',
        type: e.type,
        message: e.message,
        metadata: e.metadata,
      });
    }

    for (const e of usageEvents) {
      timeline.push({
        timestamp: e.timestamp,
        source: 'usage',
        type: e.allowed ? 'tool.call' : 'tool.denied',
        message: e.allowed
          ? `Called ${e.tool} (${e.creditsCharged} credits)`
          : `Denied ${e.tool}: ${e.denyReason || 'unknown'}`,
        metadata: {
          tool: e.tool,
          creditsCharged: e.creditsCharged,
          allowed: e.allowed,
          denyReason: e.denyReason,
          durationMs: e.durationMs,
        },
      });
    }

    // Sort by timestamp descending (newest first)
    timeline.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    // Apply limit
    const page = timeline.slice(0, limit);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      key: maskedKey,
      name: record.name,
      total: timeline.length,
      limit,
      events: page,
    }));
  }

  // ─── /keys/reserve — Credit reservations (hold, commit, release) ─────────

  private handleListReservations(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const keyParam = params.get('key');

    // Clean up expired reservations first
    this.cleanupExpiredReservations();

    let reservations = [...this.creditReservations.values()];
    if (keyParam) {
      const record = this.gate.store.resolveKeyRaw(keyParam);
      if (!record) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Key not found' }));
        return;
      }
      reservations = reservations.filter(r => r.key === record.key);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      reservations: reservations.map(r => ({
        ...r,
        key: maskKeyForAudit(r.key),
      })),
      count: reservations.length,
      totalHeld: reservations.reduce((sum, r) => sum + r.credits, 0),
    }));
  }

  private handleCreateReservation(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk; });
    req.on('end', () => {
      let params: { key?: string; credits?: number; ttlSeconds?: number; memo?: string };
      try {
        params = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }

      if (!params.key || typeof params.key !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required field: key' }));
        return;
      }

      if (!params.credits || typeof params.credits !== 'number' || params.credits <= 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or invalid credits (must be positive number)' }));
        return;
      }

      const record = this.gate.store.resolveKeyRaw(params.key);
      if (!record) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Key not found' }));
        return;
      }

      if (!record.active) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Key is revoked' }));
        return;
      }

      if (record.suspended) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Key is suspended' }));
        return;
      }

      // Cleanup expired before checking availability
      this.cleanupExpiredReservations();

      // Calculate available credits (total - held)
      const heldCredits = this.getHeldCredits(record.key);
      const available = record.credits - heldCredits;

      if (params.credits > available) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Insufficient available credits',
          available,
          held: heldCredits,
          total: record.credits,
          requested: params.credits,
        }));
        return;
      }

      // Max 50 active reservations per key
      const keyReservations = [...this.creditReservations.values()].filter(r => r.key === record.key);
      if (keyReservations.length >= 50) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Maximum 50 active reservations per key' }));
        return;
      }

      const ttl = Math.min(3600, Math.max(10, params.ttlSeconds || 300)); // 10s – 1h, default 5m
      const reservation = {
        id: `rsv_${this.nextReservationId++}`,
        key: record.key,
        credits: params.credits,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        memo: params.memo?.slice(0, 200),
      };

      this.creditReservations.set(reservation.id, reservation);

      this.audit.log('credits.reserved', 'admin', `Reserved ${params.credits} credits`, {
        reservationId: reservation.id,
        key: maskKeyForAudit(record.key),
        credits: params.credits,
        ttlSeconds: ttl,
      });

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...reservation,
        key: maskKeyForAudit(reservation.key),
        available: available - params.credits,
      }));
    });
  }

  private handleCommitReservation(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk; });
    req.on('end', () => {
      let params: { reservationId?: string };
      try {
        params = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }

      if (!params.reservationId || typeof params.reservationId !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required field: reservationId' }));
        return;
      }

      const reservation = this.creditReservations.get(params.reservationId);
      if (!reservation) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Reservation not found (may have expired)' }));
        return;
      }

      // Check if expired
      if (new Date(reservation.expiresAt).getTime() <= Date.now()) {
        this.creditReservations.delete(params.reservationId);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Reservation has expired' }));
        return;
      }

      const record = this.gate.store.resolveKeyRaw(reservation.key);
      if (!record) {
        this.creditReservations.delete(params.reservationId);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Key not found' }));
        return;
      }

      // Deduct credits
      record.credits = Math.max(0, record.credits - reservation.credits);
      this.gate.store.save();

      // Remove reservation
      this.creditReservations.delete(params.reservationId);

      this.audit.log('credits.committed', 'admin', `Committed reservation: ${reservation.credits} credits deducted`, {
        reservationId: reservation.id,
        key: maskKeyForAudit(record.key),
        credits: reservation.credits,
        remainingCredits: record.credits,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        committed: {
          ...reservation,
          key: maskKeyForAudit(reservation.key),
        },
        remainingCredits: record.credits,
      }));
    });
  }

  private handleReleaseReservation(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk; });
    req.on('end', () => {
      let params: { reservationId?: string };
      try {
        params = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }

      if (!params.reservationId || typeof params.reservationId !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required field: reservationId' }));
        return;
      }

      const reservation = this.creditReservations.get(params.reservationId);
      if (!reservation) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Reservation not found (may have expired)' }));
        return;
      }

      // Remove reservation (release the hold)
      this.creditReservations.delete(params.reservationId);

      this.audit.log('credits.released', 'admin', `Released reservation: ${reservation.credits} credits freed`, {
        reservationId: reservation.id,
        key: maskKeyForAudit(reservation.key),
        credits: reservation.credits,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        released: {
          ...reservation,
          key: maskKeyForAudit(reservation.key),
        },
      }));
    });
  }

  /** Get total held credits for a key across all active reservations. */
  private getHeldCredits(key: string): number {
    let held = 0;
    for (const r of this.creditReservations.values()) {
      if (r.key === key) held += r.credits;
    }
    return held;
  }

  /** Remove expired reservations. */
  private cleanupExpiredReservations(): void {
    const now = Date.now();
    for (const [id, r] of this.creditReservations) {
      if (new Date(r.expiresAt).getTime() <= now) {
        this.creditReservations.delete(id);
      }
    }
  }

  // ─── /config/reload — Hot reload configuration from file ─────────────────

  private async handleConfigReload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    // Parse optional body (may provide configPath override)
    let body: Record<string, unknown> = {};
    try {
      const raw = await this.readBody(req);
      if (raw.trim()) {
        body = JSON.parse(raw);
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const filePath = (body.configPath as string) || this.configPath;
    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'No config file path available. Start with --config or provide configPath in request body.',
      }));
      return;
    }

    // Read and parse config file
    let fileConfig: Record<string, unknown>;
    try {
      const raw = readFileSync(filePath, 'utf-8');
      fileConfig = JSON.parse(raw);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `Failed to read config file: ${(err as Error).message}`,
      }));
      return;
    }

    // Validate the loaded config
    const diags = validateConfig(fileConfig as ValidatableConfig);
    const errors = diags.filter(d => d.level === 'error');
    if (errors.length > 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Config validation failed',
        diagnostics: errors.map(d => ({ field: d.field, message: d.message })),
      }));
      return;
    }

    // Build a config patch from the file (only hot-reloadable fields)
    const patch: Partial<PayGateConfig> = {};
    if (fileConfig.defaultCreditsPerCall !== undefined) {
      patch.defaultCreditsPerCall = Number(fileConfig.defaultCreditsPerCall);
    }
    if (fileConfig.toolPricing !== undefined) {
      patch.toolPricing = fileConfig.toolPricing as PayGateConfig['toolPricing'];
    }
    if (fileConfig.globalRateLimitPerMin !== undefined) {
      patch.globalRateLimitPerMin = Number(fileConfig.globalRateLimitPerMin);
    }
    if (fileConfig.shadowMode !== undefined) {
      patch.shadowMode = !!fileConfig.shadowMode;
    }
    if (fileConfig.refundOnFailure !== undefined) {
      patch.refundOnFailure = !!fileConfig.refundOnFailure;
    }
    if (fileConfig.freeMethods !== undefined) {
      patch.freeMethods = fileConfig.freeMethods as string[];
    }
    if (fileConfig.webhookUrl !== undefined) {
      patch.webhookUrl = (fileConfig.webhookUrl as string) || null;
    }
    if (fileConfig.webhookSecret !== undefined) {
      patch.webhookSecret = (fileConfig.webhookSecret as string) || null;
    }
    if (fileConfig.webhookMaxRetries !== undefined) {
      patch.webhookMaxRetries = Number(fileConfig.webhookMaxRetries);
    }
    if (fileConfig.globalQuota !== undefined) {
      const q = fileConfig.globalQuota as Record<string, number>;
      patch.globalQuota = {
        dailyCallLimit: Math.max(0, Math.floor(Number(q.dailyCallLimit) || 0)),
        monthlyCallLimit: Math.max(0, Math.floor(Number(q.monthlyCallLimit) || 0)),
        dailyCreditLimit: Math.max(0, Math.floor(Number(q.dailyCreditLimit) || 0)),
        monthlyCreditLimit: Math.max(0, Math.floor(Number(q.monthlyCreditLimit) || 0)),
      };
    }
    if (fileConfig.alertRules !== undefined) {
      patch.alertRules = fileConfig.alertRules as PayGateConfig['alertRules'];
    }

    // Apply the patch to the gate (mutates shared config object)
    const changed = this.gate.updateConfig(patch);

    // Update alert engine if rules changed
    if (changed.includes('alertRules') && patch.alertRules) {
      this.alerts.setRules(patch.alertRules);
    }

    // Update stored config path only if not already set (body override is one-time)
    if (!this.configPath && filePath) {
      this.configPath = filePath;
    }

    // Fields that were skipped (not hot-reloadable)
    const skipped: string[] = [];
    if (fileConfig.serverCommand !== undefined) skipped.push('serverCommand');
    if (fileConfig.serverArgs !== undefined) skipped.push('serverArgs');
    if (fileConfig.port !== undefined) skipped.push('port');
    if (fileConfig.oauth !== undefined) skipped.push('oauth');

    // Audit
    this.audit.log('config.reloaded', 'admin', `Config reloaded from ${filePath}: ${changed.length} field(s) changed`, {
      filePath,
      changed,
      skipped,
    });

    const warnings = diags.filter(d => d.level === 'warning');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      reloaded: true,
      changed,
      skipped,
      message: changed.length > 0
        ? `Config reloaded: ${changed.join(', ')} updated`
        : 'Config reloaded: no changes detected',
      ...(warnings.length > 0 ? { warnings: warnings.map(w => ({ field: w.field, message: w.message })) } : {}),
    }));
  }

  // ─── /webhooks/stats — Webhook delivery statistics ──────────────────────

  private handleWebhookStats(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    if (!this.gate.webhook) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        configured: false,
        message: 'No webhook configured',
      }));
      return;
    }

    const stats = this.gate.webhook.getRetryStats();
    const routerStats = this.gate.webhookRouter ? this.gate.webhookRouter.getAggregateStats() : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      configured: true,
      maxRetries: this.gate.webhook.maxRetries,
      ...stats,
      ...(routerStats ? { filters: routerStats } : {}),
    }));
  }

  // ─── /webhooks/log — Webhook delivery log ───────────────────────────────

  private handleWebhookLog(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    if (!this.gate.webhook) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        configured: false,
        message: 'No webhook configured',
        entries: [],
      }));
      return;
    }

    // Parse query params
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const limitParam = url.searchParams.get('limit');
    const sinceParam = url.searchParams.get('since');
    const successParam = url.searchParams.get('success');

    const options: { limit?: number; since?: string; success?: boolean } = {};
    if (limitParam) {
      const n = parseInt(limitParam, 10);
      if (!isNaN(n) && n > 0) options.limit = n;
    }
    if (sinceParam) options.since = sinceParam;
    if (successParam === 'true') options.success = true;
    else if (successParam === 'false') options.success = false;

    const entries = this.gate.webhook.getDeliveryLog(options);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      configured: true,
      total: entries.length,
      entries,
    }));
  }

  // ─── /webhooks/pause — Pause webhook delivery ─────────────────────────────

  private handleWebhookPause(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    if (!this.gate.webhook) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No webhook configured' }));
      return;
    }

    const paused = this.gate.webhook.pause();
    if (!paused) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ paused: true, message: 'Already paused' }));
      return;
    }

    this.audit.log('webhook.pause', 'admin', 'Webhook delivery paused');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      paused: true,
      message: 'Webhook delivery paused. Events will be buffered until resumed.',
    }));
  }

  // ─── /webhooks/resume — Resume webhook delivery ───────────────────────────

  private handleWebhookResume(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    if (!this.gate.webhook) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No webhook configured' }));
      return;
    }

    const result = this.gate.webhook.resume();
    if (!result.resumed) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ paused: false, message: 'Not paused' }));
      return;
    }

    this.audit.log('webhook.resume', 'admin', `Webhook delivery resumed, ${result.flushedEvents} buffered events flushed`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      paused: false,
      message: 'Webhook delivery resumed.',
      flushedEvents: result.flushedEvents,
    }));
  }

  // ─── /webhooks/test — Send test event ────────────────────────────────────

  private async handleWebhookTest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    if (!this.gate.webhook) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No webhook configured. Set --webhook-url or webhookUrl in config.' }));
      return;
    }

    // Parse optional custom message from body
    let customMessage = 'Test event from paygate-mcp';
    try {
      const raw = await this.readBody(req);
      if (raw) {
        const body = JSON.parse(raw);
        if (body && typeof body === 'object' && body.message) {
          customMessage = String(body.message);
        }
      }
    } catch {
      // Empty body or parse error is fine — use default message
    }

    // Build test payload (matching normal webhook structure)
    const testEvent = {
      type: 'alert.fired' as const,
      timestamp: new Date().toISOString(),
      actor: 'admin',
      metadata: {
        test: true,
        message: customMessage,
      },
    };

    const payload = JSON.stringify({
      sentAt: new Date().toISOString(),
      adminEvents: [testEvent],
    });

    // Send synchronously and capture the result
    const webhookUrl = (this.gate.webhook as any).url as string;
    const isHttps = webhookUrl.startsWith('https://');
    const secret = (this.gate.webhook as any).secret as string | null;

    let parsed: URL;
    try {
      parsed = new URL(webhookUrl);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid webhook URL configured' }));
      return;
    }

    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'User-Agent': 'paygate-mcp-webhook/1.0',
      'X-PayGate-Test': '1',
    };

    // Sign if secret configured
    if (secret) {
      const { createHmac } = await import('crypto');
      const timestamp = Math.floor(Date.now() / 1000);
      const signaturePayload = `${timestamp}.${payload}`;
      const signature = createHmac('sha256', secret).update(signaturePayload).digest('hex');
      headers['X-PayGate-Signature'] = `t=${timestamp},v1=${signature}`;
    }

    const { request: httpReq } = isHttps ? await import('https') : await import('http');

    const result = await new Promise<{ success: boolean; statusCode?: number; error?: string; responseTime: number }>((resolve) => {
      const startTime = Date.now();
      const timeout = 10_000;

      const reqObj = httpReq({
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers,
        timeout,
      }, (response) => {
        response.resume();
        const elapsed = Date.now() - startTime;
        if (response.statusCode && response.statusCode >= 400) {
          resolve({ success: false, statusCode: response.statusCode, error: `HTTP ${response.statusCode}`, responseTime: elapsed });
        } else {
          resolve({ success: true, statusCode: response.statusCode || 200, responseTime: elapsed });
        }
      });

      reqObj.on('error', (err: Error) => {
        resolve({ success: false, error: err.message, responseTime: Date.now() - startTime });
      });

      reqObj.on('timeout', () => {
        reqObj.destroy();
        resolve({ success: false, error: 'Timeout (10s)', responseTime: Date.now() - startTime });
      });

      reqObj.write(payload);
      reqObj.end();
    });

    // Record audit event
    this.audit.log('webhook.test', 'admin', `Webhook test: ${result.success ? 'success' : 'failed'} (${result.statusCode || 'no response'})`, {
      url: webhookUrl.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@'),
      success: result.success,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      url: webhookUrl.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@'), // mask credentials in URL
      ...result,
    }));
  }

  // ─── /webhooks/filters — Webhook filter CRUD ─────────────────────────────

  private handleListWebhookFilters(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    if (!this.gate.webhookRouter) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: 0, filters: [], message: 'No webhook router configured' }));
      return;
    }

    const filters = this.gate.webhookRouter.listRules();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: filters.length, filters }));
  }

  private async handleCreateWebhookFilter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.checkAdmin(req, res, 'admin')) return;

    if (!this.gate.webhookRouter) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No webhook configured. Set webhookUrl or webhookFilters to enable webhook routing.' }));
      return;
    }

    const body = await this.readBody(req);
    let params: Record<string, unknown>;
    try { params = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    try {
      const rule = this.gate.webhookRouter.addRule({
        id: '',  // auto-generated
        name: String(params.name || ''),
        events: Array.isArray(params.events) ? params.events.map(String) : [],
        url: String(params.url || ''),
        secret: params.secret ? String(params.secret) : undefined,
        keyPrefixes: Array.isArray(params.keyPrefixes) ? params.keyPrefixes.map(String) : undefined,
        active: params.active !== false,
      });

      this.audit.log('webhook_filter.created', 'admin', `Webhook filter created: ${rule.name}`, { filterId: rule.id, name: rule.name });

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rule));
    } catch (err: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  private async handleUpdateWebhookFilter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    if (!this.gate.webhookRouter) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No webhook router configured' }));
      return;
    }

    const body = await this.readBody(req);
    let params: Record<string, unknown>;
    try { params = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const filterId = String(params.id || '');
    if (!filterId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing id field' }));
      return;
    }

    try {
      const rule = this.gate.webhookRouter.updateRule(filterId, {
        name: params.name !== undefined ? String(params.name) : undefined,
        events: Array.isArray(params.events) ? params.events.map(String) : undefined,
        url: params.url !== undefined ? String(params.url) : undefined,
        secret: params.secret !== undefined ? String(params.secret) : undefined,
        keyPrefixes: Array.isArray(params.keyPrefixes) ? params.keyPrefixes.map(String) : undefined,
        active: params.active !== undefined ? Boolean(params.active) : undefined,
      });

      this.audit.log('webhook_filter.updated', 'admin', `Webhook filter updated: ${rule.name}`, { filterId: rule.id });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rule));
    } catch (err: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  private async handleDeleteWebhookFilter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    if (!this.gate.webhookRouter) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No webhook router configured' }));
      return;
    }

    const body = await this.readBody(req);
    let params: { id?: string };
    try { params = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const filterId = String(params.id || '');
    if (!filterId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing id field' }));
      return;
    }

    const deleted = this.gate.webhookRouter.deleteRule(filterId);
    if (!deleted) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Filter not found' }));
      return;
    }

    this.audit.log('webhook_filter.deleted', 'admin', `Webhook filter deleted: ${filterId}`, { filterId });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: `Filter ${filterId} deleted` }));
  }

  // ─── /audit — Query audit log ─────────────────────────────────────────────

  private handleAudit(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');

    const types = params.get('types')?.split(',').filter(Boolean) as import('./audit').AuditEventType[] | undefined;
    const actor = params.get('actor') || undefined;
    const since = params.get('since') || undefined;
    const until = params.get('until') || undefined;
    const limit = params.get('limit') ? parseInt(params.get('limit')!, 10) : undefined;
    const offset = params.get('offset') ? parseInt(params.get('offset')!, 10) : undefined;

    const result = this.audit.query({ types, actor, since, until, limit, offset });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result, null, 2));
  }

  // ─── /audit/export — Export audit log ────────────────────────────────────

  private handleAuditExport(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const format = params.get('format') || 'json';

    if (format === 'csv') {
      const csv = this.audit.exportCsv({
        types: params.get('types')?.split(',').filter(Boolean) as import('./audit').AuditEventType[] | undefined,
        since: params.get('since') || undefined,
        until: params.get('until') || undefined,
      });
      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="paygate-audit.csv"',
      });
      res.end(csv);
    } else {
      const events = this.audit.exportAll();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: events.length, events }, null, 2));
    }
  }

  // ─── /audit/stats — Audit log statistics ────────────────────────────────

  private handleAuditStats(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.audit.stats(), null, 2));
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private checkAdmin(req: IncomingMessage, res: ServerResponse, minRole?: AdminRole): boolean {
    const adminKey = req.headers['x-admin-key'] as string;
    const record = adminKey ? this.adminKeys.validate(adminKey) : null;

    if (!record) {
      this.audit.log('admin.auth_failed', 'unknown', `Admin auth failed on ${req.url}`, {
        url: req.url,
        method: req.method,
      });
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid admin key' }));
      return false;
    }

    // Role-based permission check (if a minimum role is specified)
    if (minRole && ROLE_HIERARCHY[record.role] < ROLE_HIERARCHY[minRole]) {
      this.audit.log('admin.auth_failed', adminKey.slice(0, 7) + '...' + adminKey.slice(-4),
        `Insufficient role for ${req.url} (need ${minRole}, have ${record.role})`, {
        url: req.url,
        method: req.method,
        requiredRole: minRole,
        currentRole: record.role,
      });
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Insufficient permissions', requiredRole: minRole, currentRole: record.role }));
      return false;
    }

    return true;
  }

  // ─── /teams — Team management ────────────────────────────────────────────

  private handleListTeams(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use GET.' }));
      return;
    }

    const teams = this.teams.listTeams().map(t => ({
      ...t,
      memberKeys: t.memberKeys.map(k => k.slice(0, 7) + '...' + k.slice(-4)),
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ teams, count: teams.length }));
  }

  private async handleCreateTeam(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.checkAdmin(req, res, 'admin')) return;
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
      return;
    }

    const body = await this.readBody(req);
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.name || typeof params.name !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required field: name' }));
      return;
    }

    const team = this.teams.createTeam({
      name: params.name as string,
      description: params.description as string | undefined,
      budget: params.budget as number | undefined,
      quota: params.quota as any,
      tags: params.tags as Record<string, string> | undefined,
    });

    this.audit.log('team.created', 'admin', `Team created: ${team.name}`, {
      teamId: team.id,
      teamName: team.name,
      budget: team.budget,
    });

    this.gate.store.save();

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Team created', team }));
  }

  private async handleUpdateTeam(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.checkAdmin(req, res, 'admin')) return;
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
      return;
    }

    const body = await this.readBody(req);
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.teamId || typeof params.teamId !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required field: teamId' }));
      return;
    }

    const success = this.teams.updateTeam(params.teamId as string, {
      name: params.name as string | undefined,
      description: params.description as string | undefined,
      budget: params.budget as number | undefined,
      quota: params.quota as any,
      tags: params.tags as Record<string, string | null> | undefined,
    });

    if (!success) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Team not found or inactive' }));
      return;
    }

    this.audit.log('team.updated', 'admin', `Team updated: ${params.teamId}`, { teamId: params.teamId });
    this.gate.store.save();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Team updated', team: this.teams.getTeam(params.teamId as string) }));
  }

  private async handleDeleteTeam(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.checkAdmin(req, res, 'admin')) return;
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
      return;
    }

    const body = await this.readBody(req);
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.teamId || typeof params.teamId !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required field: teamId' }));
      return;
    }

    const success = this.teams.deleteTeam(params.teamId as string);
    if (!success) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Team not found or already deleted' }));
      return;
    }

    this.audit.log('team.deleted', 'admin', `Team deleted: ${params.teamId}`, { teamId: params.teamId });
    this.gate.store.save();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Team deleted' }));
  }

  private async handleTeamAssignKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.checkAdmin(req, res, 'admin')) return;
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
      return;
    }

    const body = await this.readBody(req);
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.teamId || typeof params.teamId !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required field: teamId' }));
      return;
    }
    if (!params.key || typeof params.key !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required field: key' }));
      return;
    }

    // Verify the key exists
    const keyRecord = this.gate.store.resolveKey(params.key as string);
    if (!keyRecord) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API key not found' }));
      return;
    }

    const result = this.teams.assignKey(params.teamId as string, params.key as string);
    if (!result.success) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }

    this.audit.log('team.key_assigned', 'admin', `Key assigned to team ${params.teamId}`, {
      teamId: params.teamId,
      keyMasked: maskKeyForAudit(params.key as string),
    });
    this.gate.store.save();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Key assigned to team' }));
  }

  private async handleTeamRemoveKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.checkAdmin(req, res, 'admin')) return;
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
      return;
    }

    const body = await this.readBody(req);
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.teamId || typeof params.teamId !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required field: teamId' }));
      return;
    }
    if (!params.key || typeof params.key !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required field: key' }));
      return;
    }

    const success = this.teams.removeKey(params.teamId as string, params.key as string);
    if (!success) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found in team' }));
      return;
    }

    this.audit.log('team.key_removed', 'admin', `Key removed from team ${params.teamId}`, {
      teamId: params.teamId,
      keyMasked: maskKeyForAudit(params.key as string),
    });
    this.gate.store.save();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Key removed from team' }));
  }

  private handleTeamUsage(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use GET.' }));
      return;
    }

    const url = new URL(req.url || '/', `http://localhost`);
    const teamId = url.searchParams.get('teamId');

    if (!teamId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required query param: teamId' }));
      return;
    }

    const summary = this.teams.getUsageSummary(teamId, (key) => this.gate.store.getKey(key));
    if (!summary) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Team not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(summary));
  }

  // ─── /namespaces — List all namespaces ──────────────────────────────────────

  private handleListNamespaces(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use GET.' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    const namespaces = this.gate.store.listNamespaces();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ namespaces, count: namespaces.length }, null, 2));
  }

  // ─── /tokens — Create scoped token ──────────────────────────────────────────

  private async handleCreateToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { key?: string; ttl?: number; allowedTools?: string[]; label?: string };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.key) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required param: key (API key to delegate from)' }));
      return;
    }

    // Verify the parent key exists and is active
    const keyRecord = this.gate.store.resolveKey(params.key);
    if (!keyRecord || !keyRecord.active) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API key not found or inactive' }));
      return;
    }

    const ttl = Math.max(1, Math.min(86400, Math.floor(Number(params.ttl) || 3600)));

    const token = this.tokens.create({
      apiKey: params.key,
      ttlSeconds: ttl,
      allowedTools: params.allowedTools,
      label: params.label,
    });

    this.audit.log('token.created', 'admin', `Scoped token created for key: ${keyRecord.name}`, {
      keyMasked: maskKeyForAudit(params.key),
      ttl,
      allowedTools: params.allowedTools,
      label: params.label,
    });

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      token,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      ttl,
      parentKey: keyRecord.name,
      allowedTools: params.allowedTools || [],
      label: params.label || null,
      message: 'Use this token as X-API-Key or Bearer token. It will expire automatically.',
    }));
  }

  // ─── /tokens/revoke — Revoke a scoped token ────────────────────────────────

  private async handleRevokeToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { token?: string; reason?: string };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.token) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required param: token' }));
      return;
    }

    // Validate that it's a real, validly-signed token (even if expired)
    if (!ScopedTokenManager.isToken(params.token)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not a scoped token (must start with pgt_)' }));
      return;
    }

    const entry = this.tokens.revokeToken(params.token, params.reason);
    if (!entry) {
      // Already revoked or invalid signature
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Token already revoked or invalid signature' }));
      return;
    }

    this.audit.log('token.revoked', 'admin', `Scoped token revoked`, {
      fingerprint: entry.fingerprint.slice(0, 12) + '...',
      expiresAt: entry.expiresAt,
      reason: entry.reason,
    });

    // Sync to Redis so other instances reject this token too
    if (this.redisSync) {
      this.redisSync.publishEvent({
        type: 'token_revoked',
        key: entry.fingerprint,
        data: { expiresAt: entry.expiresAt, revokedAt: entry.revokedAt, reason: entry.reason },
      }).catch(() => {});
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      message: 'Token revoked',
      fingerprint: entry.fingerprint,
      expiresAt: entry.expiresAt,
      revokedAt: entry.revokedAt,
    }));
  }

  // ─── /tokens/revoked — List revoked tokens ─────────────────────────────────

  private handleListRevokedTokens(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    const entries = this.tokens.revocationList.list();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      count: entries.length,
      entries: entries.map(e => ({
        fingerprint: e.fingerprint,
        expiresAt: e.expiresAt,
        revokedAt: e.revokedAt,
        reason: e.reason || null,
      })),
    }));
  }

  // ─── /admin/keys — Admin key management ────────────────────────────────────

  // ─── GET /plugins — List registered plugins ─────────────────────────────

  private handleListPlugins(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use GET.' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    const plugins = this.plugins.list();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: plugins.length, plugins }));
  }

  // ─── Key Group Endpoints ─────────────────────────────────────────────────

  private handleListGroups(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;
    const groups = this.groups.listGroups();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: groups.length, groups }));
  }

  private async handleCreateGroup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: Record<string, unknown>;
    try { params = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    try {
      const group = this.groups.createGroup({
        name: String(params.name || ''),
        description: params.description as string | undefined,
        allowedTools: params.allowedTools as string[] | undefined,
        deniedTools: params.deniedTools as string[] | undefined,
        rateLimitPerMin: params.rateLimitPerMin as number | undefined,
        toolPricing: params.toolPricing as Record<string, { creditsPerCall: number; creditsPerKbInput?: number }> | undefined,
        quota: params.quota ? {
          dailyCallLimit: Math.max(0, Math.floor(Number((params.quota as any).dailyCallLimit) || 0)),
          monthlyCallLimit: Math.max(0, Math.floor(Number((params.quota as any).monthlyCallLimit) || 0)),
          dailyCreditLimit: Math.max(0, Math.floor(Number((params.quota as any).dailyCreditLimit) || 0)),
          monthlyCreditLimit: Math.max(0, Math.floor(Number((params.quota as any).monthlyCreditLimit) || 0)),
        } : undefined,
        ipAllowlist: params.ipAllowlist as string[] | undefined,
        defaultCredits: params.defaultCredits as number | undefined,
        maxSpendingLimit: params.maxSpendingLimit as number | undefined,
        tags: params.tags as Record<string, string> | undefined,
      });

      this.audit.log('group.created', 'admin', `Group created: ${group.name}`, { groupId: group.id, name: group.name });
      this.groups.saveToFile();
      if (this.redisSync) this.redisSync.saveGroup(group).catch(() => {});

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(group));
    } catch (err: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  private async handleUpdateGroup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: Record<string, unknown>;
    try { params = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const groupId = String(params.id || '');
    if (!groupId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing id field' }));
      return;
    }

    try {
      const group = this.groups.updateGroup(groupId, {
        name: params.name as string | undefined,
        description: params.description as string | undefined,
        allowedTools: params.allowedTools as string[] | undefined,
        deniedTools: params.deniedTools as string[] | undefined,
        rateLimitPerMin: params.rateLimitPerMin as number | undefined,
        toolPricing: params.toolPricing as Record<string, { creditsPerCall: number }> | undefined,
        quota: params.quota === null ? null : params.quota ? {
          dailyCallLimit: Math.max(0, Math.floor(Number((params.quota as any).dailyCallLimit) || 0)),
          monthlyCallLimit: Math.max(0, Math.floor(Number((params.quota as any).monthlyCallLimit) || 0)),
          dailyCreditLimit: Math.max(0, Math.floor(Number((params.quota as any).dailyCreditLimit) || 0)),
          monthlyCreditLimit: Math.max(0, Math.floor(Number((params.quota as any).monthlyCreditLimit) || 0)),
        } : undefined,
        ipAllowlist: params.ipAllowlist as string[] | undefined,
        defaultCredits: params.defaultCredits as number | undefined,
        maxSpendingLimit: params.maxSpendingLimit as number | undefined,
        tags: params.tags as Record<string, string> | undefined,
      });

      this.audit.log('group.updated', 'admin', `Group updated: ${group.name}`, { groupId: group.id });
      this.groups.saveToFile();
      if (this.redisSync) this.redisSync.saveGroup(group).catch(() => {});

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(group));
    } catch (err: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  private async handleDeleteGroup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { id?: string };
    try { params = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const groupId = String(params.id || '');
    if (!groupId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing id field' }));
      return;
    }

    const deleted = this.groups.deleteGroup(groupId);
    if (!deleted) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Group not found' }));
      return;
    }

    this.audit.log('group.deleted', 'admin', `Group deleted: ${groupId}`, { groupId });
    this.groups.saveToFile();
    if (this.redisSync) {
      this.redisSync.deleteGroup(groupId).catch(() => {});
      this.redisSync.saveGroupAssignments().catch(() => {});
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: `Group ${groupId} deleted` }));
  }

  private async handleAssignKeyToGroup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { key?: string; groupId?: string };
    try { params = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const apiKey = String(params.key || '');
    const groupId = String(params.groupId || '');
    if (!apiKey || !groupId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing key or groupId field' }));
      return;
    }

    // Verify key exists
    const keyRecord = this.gate.store.getKey(apiKey);
    if (!keyRecord) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API key not found' }));
      return;
    }

    try {
      this.groups.assignKey(apiKey, groupId);
      // Update key record's group field
      keyRecord.group = groupId;

      this.audit.log('group.key_assigned', 'admin', `Key assigned to group ${groupId}`, {
        keyMasked: maskKeyForAudit(apiKey), groupId,
      });
      this.groups.saveToFile();
      if (this.redisSync) {
        this.redisSync.saveGroupAssignments().catch(() => {});
        this.syncKeyMutation(apiKey);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: `Key assigned to group ${groupId}` }));
    } catch (err: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  private async handleRemoveKeyFromGroup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { key?: string };
    try { params = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const apiKey = String(params.key || '');
    if (!apiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing key field' }));
      return;
    }

    const removed = this.groups.removeKey(apiKey);
    if (!removed) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not in any group' }));
      return;
    }

    // Clear group field on key record
    const keyRecord = this.gate.store.getKey(apiKey);
    if (keyRecord) {
      delete keyRecord.group;
    }

    this.audit.log('group.key_removed', 'admin', `Key removed from group`, { keyMasked: maskKeyForAudit(apiKey) });
    this.groups.saveToFile();
    if (this.redisSync) {
      this.redisSync.saveGroupAssignments().catch(() => {});
      this.syncKeyMutation(apiKey);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Key removed from group' }));
  }

  // ─── Admin Key Management ────────────────────────────────────────────────

  private handleListAdminKeys(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use GET.' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'super_admin')) return;

    const keys = this.adminKeys.list().map(k => ({
      key: k.key.slice(0, 7) + '...' + k.key.slice(-4),
      name: k.name,
      role: k.role,
      createdAt: k.createdAt,
      createdBy: k.createdBy,
      active: k.active,
      lastUsedAt: k.lastUsedAt,
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: keys.length, keys }));
  }

  private async handleCreateAdminKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'super_admin')) return;

    const body = await this.readBody(req);
    let params: { name?: string; role?: string };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    if (!params.name || typeof params.name !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required field: name' }));
      return;
    }

    const role = (params.role || 'admin') as AdminRole;
    if (!['super_admin', 'admin', 'viewer'].includes(role)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid role. Must be super_admin, admin, or viewer.' }));
      return;
    }

    // Mask the requesting admin key for audit
    const callerKey = req.headers['x-admin-key'] as string;
    const callerMasked = callerKey.slice(0, 7) + '...' + callerKey.slice(-4);

    const record = this.adminKeys.create(params.name, role, callerMasked);

    this.audit.log('admin_key.created', callerMasked, `Created admin key "${params.name}" with role ${role}`, {
      newKeyMasked: record.key.slice(0, 7) + '...' + record.key.slice(-4),
      role,
    });
    this.emitWebhookAdmin('admin_key.created', callerMasked, {
      newKeyMasked: record.key.slice(0, 7) + '...' + record.key.slice(-4),
      name: params.name,
      role,
    });

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      key: record.key,
      name: record.name,
      role: record.role,
      createdAt: record.createdAt,
    }));
  }

  private async handleRevokeAdminKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'super_admin')) return;

    const body = await this.readBody(req);
    let params: { key?: string };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    if (!params.key || typeof params.key !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required field: key' }));
      return;
    }

    const callerKey = req.headers['x-admin-key'] as string;

    // Prevent revoking your own key
    if (params.key === callerKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cannot revoke your own admin key' }));
      return;
    }

    const result = this.adminKeys.revoke(params.key);
    if (!result.success) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }

    const callerMasked = callerKey.slice(0, 7) + '...' + callerKey.slice(-4);
    const targetMasked = params.key.slice(0, 7) + '...' + params.key.slice(-4);

    this.audit.log('admin_key.revoked', callerMasked, `Revoked admin key ${targetMasked}`, {
      revokedKeyMasked: targetMasked,
    });
    this.emitWebhookAdmin('admin_key.revoked', callerMasked, {
      revokedKeyMasked: targetMasked,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ revoked: true }));
  }

  // ─── /keys/templates — CRUD ────────────────────────────────────────────────

  private handleListTemplates(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    const templates = this.templates.list();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ total: templates.length, templates }));
  }

  private async handleCreateTemplate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const name = params.name;
    if (!name || typeof name !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required field: name' }));
      return;
    }

    const existing = this.templates.get(name as string);
    const result = this.templates.set(name as string, params as any);

    if (!result.success) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }

    const eventType = existing ? 'template.updated' : 'template.created';
    this.audit.log(eventType, 'admin', `${existing ? 'Updated' : 'Created'} template: ${name}`, {
      templateName: name,
    });

    res.writeHead(existing ? 200 : 201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ template: result.template }));
  }

  private async handleDeleteTemplate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
      return;
    }
    if (!this.checkAdmin(req, res, 'admin')) return;

    const body = await this.readBody(req);
    let params: { name?: string };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.name || typeof params.name !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required field: name' }));
      return;
    }

    const deleted = this.templates.delete(params.name);
    if (!deleted) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Template "${params.name}" not found` }));
      return;
    }

    this.audit.log('template.deleted', 'admin', `Deleted template: ${params.name}`, {
      templateName: params.name,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true, name: params.name }));
  }

  /**
   * Route admin webhook events through the WebhookRouter (for filter rules) or direct emitter.
   */
  private emitWebhookAdmin(type: import('./webhook').WebhookAdminEvent['type'], actor: string, metadata: Record<string, unknown> = {}): void {
    if (this.gate.webhookRouter) {
      this.gate.webhookRouter.emitAdmin(type, actor, metadata);
    } else if (this.gate.webhook) {
      this.gate.webhook.emitAdmin(type, actor, metadata);
    }
  }

  private syncKeyMutation(apiKey: string): void {
    if (!this.redisSync) return;
    const record = this.gate.store.getKey(apiKey);
    if (record) {
      // Save the full record to Redis and broadcast key_updated to other instances.
      // saveKey() internally calls publishEvent({ type: 'key_updated' }).
      this.redisSync.saveKey(record).catch(() => {});
    }
  }

  /** Resolve the CORS origin based on config and incoming request Origin header */
  private resolveCorsOrigin(req: IncomingMessage, corsConfig?: PayGateConfig['cors']): string {
    // No CORS config or wildcard: allow all
    if (!corsConfig || corsConfig.origin === '*') return '*';

    const requestOrigin = req.headers['origin'] as string | undefined;

    // String origin: exact match
    if (typeof corsConfig.origin === 'string') {
      return requestOrigin === corsConfig.origin ? corsConfig.origin : '';
    }

    // Array of origins: check if request origin is in the list
    if (Array.isArray(corsConfig.origin)) {
      if (corsConfig.origin.includes('*')) return '*';
      if (requestOrigin && corsConfig.origin.includes(requestOrigin)) {
        return requestOrigin;
      }
      return '';
    }

    return '*';
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_SIZE) {
          req.destroy();
          reject(new Error('Request body too large'));
          return;
        }
        body += chunk.toString();
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    // Stop scheduled actions timer
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    // Close admin event stream connections
    if (this.adminEventKeepAliveTimer) {
      clearInterval(this.adminEventKeepAliveTimer);
      this.adminEventKeepAliveTimer = null;
    }
    for (const client of this.adminEventStreams) {
      try { client.res.end(); } catch { /* ignore */ }
    }
    this.adminEventStreams.clear();

    // Plugin lifecycle: onStop (reverse order)
    if (this.plugins.count > 0) {
      await this.plugins.executeStop();
    }
    await this.handler.stop();
    this.gate.destroy();
    this.oauth?.destroy();
    this.sessions.destroy();
    this.audit.destroy();
    this.tokens.destroy();
    this.expiryScanner.destroy();
    if (this.redisSync) {
      await this.redisSync.destroy();
    }
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }

  /**
   * Graceful shutdown: stop accepting new /mcp requests, wait for in-flight
   * requests to drain (with a timeout), then tear down all resources.
   *
   * @param timeoutMs  Max time (ms) to wait for in-flight requests before
   *                   force-stopping. Defaults to 30 000 ms (30 s).
   * @returns          Resolves when fully stopped.
   */
  async gracefulStop(timeoutMs = 30_000): Promise<void> {
    if (this.draining) return; // already draining
    this.draining = true;
    console.log(`[paygate] Draining — waiting for ${this.inflight} in-flight request(s)…`);

    // Stop accepting new TCP connections immediately
    if (this.server) {
      this.server.close(() => {}); // close listener (existing connections stay alive)
    }

    // Wait for in-flight requests to finish, with a hard timeout
    const drainStart = Date.now();
    await new Promise<void>((resolve) => {
      const check = () => {
        if (this.inflight <= 0) {
          resolve();
          return;
        }
        if (Date.now() - drainStart >= timeoutMs) {
          console.warn(`[paygate] Drain timeout (${timeoutMs}ms) — ${this.inflight} request(s) still in-flight, force-stopping`);
          resolve();
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });

    console.log('[paygate] Drained — tearing down resources');
    // Plugin lifecycle: onStop (reverse order)
    if (this.plugins.count > 0) {
      await this.plugins.executeStop();
    }
    // Tear down resources (but skip server.close, already closed above)
    await this.handler.stop();
    this.gate.destroy();
    this.oauth?.destroy();
    this.sessions.destroy();
    this.audit.destroy();
    this.tokens.destroy();
    this.expiryScanner.destroy();
    if (this.redisSync) {
      await this.redisSync.destroy();
    }
  }

  // ─── /requests — Request Log (queryable tool call log) ──────────────────────

  private handleRequestLog(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');

    // Filters
    const keyFilter = params.get('key');
    const toolFilter = params.get('tool');
    const statusFilter = params.get('status'); // 'allowed' | 'denied'
    const sinceFilter = params.get('since');
    const limit = Math.min(1000, Math.max(1, parseInt(params.get('limit') || '100', 10) || 100));
    const offset = Math.max(0, parseInt(params.get('offset') || '0', 10) || 0);

    let filtered = this.requestLog;

    // Filter by key (partial match on masked key)
    if (keyFilter) {
      const kf = keyFilter.toLowerCase();
      filtered = filtered.filter(e => e.key.toLowerCase().includes(kf));
    }

    // Filter by tool name (exact match)
    if (toolFilter) {
      filtered = filtered.filter(e => e.tool === toolFilter);
    }

    // Filter by status
    if (statusFilter === 'allowed' || statusFilter === 'denied') {
      filtered = filtered.filter(e => e.status === statusFilter);
    }

    // Filter by since timestamp
    if (sinceFilter) {
      const sinceTime = new Date(sinceFilter).getTime();
      if (!isNaN(sinceTime)) {
        filtered = filtered.filter(e => new Date(e.timestamp).getTime() >= sinceTime);
      }
    }

    const total = filtered.length;

    // Return newest first
    const reversed = [...filtered].reverse();
    const page = reversed.slice(offset, offset + limit);

    // Compute summary stats
    const totalAllowed = filtered.filter(e => e.status === 'allowed').length;
    const totalDenied = filtered.filter(e => e.status === 'denied').length;
    const totalCredits = filtered.reduce((sum, e) => sum + e.credits, 0);
    const avgDurationMs = filtered.length > 0
      ? Math.round(filtered.reduce((sum, e) => sum + e.durationMs, 0) / filtered.length)
      : 0;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      total,
      offset,
      limit,
      summary: {
        totalAllowed,
        totalDenied,
        totalCredits,
        avgDurationMs,
      },
      requests: page,
    }));
  }

  // ─── /tools/stats — Per-tool analytics from request log ────────────────────

  private handleToolStats(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const sinceFilter = params.get('since');
    const toolFilter = params.get('tool');

    let entries = this.requestLog;

    // Filter by since
    if (sinceFilter) {
      const sinceTime = new Date(sinceFilter).getTime();
      if (!isNaN(sinceTime)) {
        entries = entries.filter(e => new Date(e.timestamp).getTime() >= sinceTime);
      }
    }

    // If specific tool requested, return detailed stats for just that tool
    if (toolFilter) {
      const toolEntries = entries.filter(e => e.tool === toolFilter);
      const allowed = toolEntries.filter(e => e.status === 'allowed');
      const denied = toolEntries.filter(e => e.status === 'denied');
      const totalCredits = toolEntries.reduce((sum, e) => sum + e.credits, 0);
      const avgDurationMs = toolEntries.length > 0
        ? Math.round(toolEntries.reduce((sum, e) => sum + e.durationMs, 0) / toolEntries.length)
        : 0;
      const p95 = this.percentile(toolEntries.map(e => e.durationMs), 95);

      // Deny reason breakdown
      const denyReasons: Record<string, number> = {};
      for (const e of denied) {
        const reason = e.denyReason || 'unknown';
        denyReasons[reason] = (denyReasons[reason] || 0) + 1;
      }

      // Top consumers by call count
      const consumerCalls: Record<string, number> = {};
      const consumerCredits: Record<string, number> = {};
      for (const e of toolEntries) {
        consumerCalls[e.key] = (consumerCalls[e.key] || 0) + 1;
        consumerCredits[e.key] = (consumerCredits[e.key] || 0) + e.credits;
      }
      const topConsumers = Object.entries(consumerCalls)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([key, calls]) => ({ key, calls, credits: consumerCredits[key] || 0 }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        tool: toolFilter,
        totalCalls: toolEntries.length,
        allowed: allowed.length,
        denied: denied.length,
        successRate: toolEntries.length > 0
          ? Math.round((allowed.length / toolEntries.length) * 10000) / 100
          : 0,
        totalCredits,
        avgDurationMs,
        p95DurationMs: p95,
        denyReasons,
        topConsumers,
      }));
      return;
    }

    // Aggregate stats per tool
    const toolMap: Record<string, {
      calls: number;
      allowed: number;
      denied: number;
      credits: number;
      totalDurationMs: number;
    }> = {};

    for (const e of entries) {
      if (!toolMap[e.tool]) {
        toolMap[e.tool] = { calls: 0, allowed: 0, denied: 0, credits: 0, totalDurationMs: 0 };
      }
      const t = toolMap[e.tool];
      t.calls++;
      if (e.status === 'allowed') t.allowed++;
      else t.denied++;
      t.credits += e.credits;
      t.totalDurationMs += e.durationMs;
    }

    const tools = Object.entries(toolMap)
      .map(([tool, stats]) => ({
        tool,
        totalCalls: stats.calls,
        allowed: stats.allowed,
        denied: stats.denied,
        successRate: stats.calls > 0
          ? Math.round((stats.allowed / stats.calls) * 10000) / 100
          : 0,
        totalCredits: stats.credits,
        avgDurationMs: stats.calls > 0 ? Math.round(stats.totalDurationMs / stats.calls) : 0,
      }))
      .sort((a, b) => b.totalCalls - a.totalCalls);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      totalTools: tools.length,
      totalCalls: entries.length,
      tools,
    }));
  }

  // ─── /requests/dry-run — Simulate a tool call without executing ─────────────

  private async handleRequestDryRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.checkAdmin(req, res)) return;

    try {
      const raw = await this.readBody(req);
      try {
        const params = JSON.parse(raw);
        const apiKey = params.key;
        const toolName = params.tool;

        if (!apiKey || typeof apiKey !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required field: key' }));
          return;
        }

        if (!toolName || typeof toolName !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required field: tool' }));
          return;
        }

        // Step 1: Key lookup (resolveKeyRaw handles alias resolution)
        const keyRecord = this.gate.store.resolveKeyRaw(apiKey);
        if (!keyRecord) {
          const isExpired = this.gate.store.isExpired(apiKey);
          const reason = isExpired ? 'api_key_expired' : 'invalid_api_key';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            allowed: false,
            reason,
            tool: toolName,
            creditsRequired: 0,
            creditsAvailable: 0,
          }));
          return;
        }

        // Step 2: Suspended?
        if (keyRecord.suspended) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            allowed: false,
            reason: 'key_suspended',
            tool: toolName,
            creditsRequired: 0,
            creditsAvailable: keyRecord.credits,
          }));
          return;
        }

        // Step 3: Tool ACL
        const effectiveAllowed = keyRecord.allowedTools || [];
        const effectiveDenied = keyRecord.deniedTools || [];
        if (effectiveDenied.includes(toolName)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            allowed: false,
            reason: `tool_not_allowed: ${toolName} is in deniedTools`,
            tool: toolName,
            creditsRequired: 0,
            creditsAvailable: keyRecord.credits,
          }));
          return;
        }
        if (effectiveAllowed.length > 0 && !effectiveAllowed.includes(toolName)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            allowed: false,
            reason: `tool_not_allowed: ${toolName} not in allowedTools`,
            tool: toolName,
            creditsRequired: 0,
            creditsAvailable: keyRecord.credits,
          }));
          return;
        }

        // Step 4: Rate limit check (read-only)
        const rateStatus = this.gate.rateLimiter.getStatus(keyRecord.key);
        if (rateStatus.limit > 0 && rateStatus.remaining <= 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            allowed: false,
            reason: 'rate_limited',
            tool: toolName,
            creditsRequired: 0,
            creditsAvailable: keyRecord.credits,
            rateLimit: rateStatus,
          }));
          return;
        }

        // Step 5: Credits check
        const creditsRequired = this.gate.getToolPrice(toolName, params.arguments);
        if (keyRecord.credits < creditsRequired) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            allowed: false,
            reason: `insufficient_credits: need ${creditsRequired}, have ${keyRecord.credits}`,
            tool: toolName,
            creditsRequired,
            creditsAvailable: keyRecord.credits,
          }));
          return;
        }

        // Step 6: Spending limit
        if (keyRecord.spendingLimit > 0) {
          const wouldSpend = keyRecord.totalSpent + creditsRequired;
          if (wouldSpend > keyRecord.spendingLimit) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              allowed: false,
              reason: `spending_limit_exceeded: limit ${keyRecord.spendingLimit}, spent ${keyRecord.totalSpent}, need ${creditsRequired}`,
              tool: toolName,
              creditsRequired,
              creditsAvailable: keyRecord.credits,
            }));
            return;
          }
        }

        // All checks passed — would be allowed
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          allowed: true,
          tool: toolName,
          creditsRequired,
          creditsAvailable: keyRecord.credits,
          creditsAfter: keyRecord.credits - creditsRequired,
          ...(rateStatus.limit > 0 ? { rateLimit: rateStatus } : {}),
        }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read request body' }));
    }
  }

  // ─── /requests/dry-run/batch — Simulate multiple tool calls without executing ──

  private async handleRequestDryRunBatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.checkAdmin(req, res)) return;

    try {
      const raw = await this.readBody(req);
      try {
        const params = JSON.parse(raw);
        const apiKey = params.key;
        const tools = params.tools;

        if (!apiKey || typeof apiKey !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required field: key' }));
          return;
        }

        if (!Array.isArray(tools) || tools.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required field: tools (non-empty array of {name} objects)' }));
          return;
        }

        if (tools.length > 100) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Maximum 100 tools per batch dry run' }));
          return;
        }

        // Validate tool entries
        for (let i = 0; i < tools.length; i++) {
          if (!tools[i]?.name || typeof tools[i].name !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `tools[${i}] missing required "name" field` }));
            return;
          }
        }

        // Step 1: Key lookup (resolveKeyRaw handles aliases)
        const keyRecord = this.gate.store.resolveKeyRaw(apiKey);
        if (!keyRecord) {
          const isExpired = this.gate.store.isExpired(apiKey);
          const reason = isExpired ? 'api_key_expired' : 'invalid_api_key';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            allAllowed: false,
            reason,
            totalCreditsRequired: 0,
            results: tools.map((t: any) => ({ tool: t.name, allowed: false, reason, creditsRequired: 0 })),
          }));
          return;
        }

        // Step 2: Suspended?
        if (keyRecord.suspended) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            allAllowed: false,
            reason: 'key_suspended',
            totalCreditsRequired: 0,
            creditsAvailable: keyRecord.credits,
            results: tools.map((t: any) => ({ tool: t.name, allowed: false, reason: 'key_suspended', creditsRequired: 0 })),
          }));
          return;
        }

        // Step 3: Rate limit check (read-only)
        const rateStatus = this.gate.rateLimiter.getStatus(keyRecord.key);
        if (rateStatus.limit > 0 && rateStatus.remaining <= 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            allAllowed: false,
            reason: 'rate_limited',
            totalCreditsRequired: 0,
            creditsAvailable: keyRecord.credits,
            rateLimit: rateStatus,
            results: tools.map((t: any) => ({ tool: t.name, allowed: false, reason: 'rate_limited', creditsRequired: 0 })),
          }));
          return;
        }

        // Step 4: Per-tool checks
        const results: Array<{ tool: string; allowed: boolean; reason?: string; creditsRequired: number }> = [];
        let totalCreditsRequired = 0;
        let allAllowed = true;
        let firstDenyReason: string | undefined;

        for (const toolEntry of tools) {
          const toolName = toolEntry.name;
          const toolArgs = toolEntry.arguments;

          // ACL check
          const effectiveAllowed = keyRecord.allowedTools || [];
          const effectiveDenied = keyRecord.deniedTools || [];
          if (effectiveDenied.includes(toolName)) {
            results.push({ tool: toolName, allowed: false, reason: `tool_not_allowed: ${toolName} is in deniedTools`, creditsRequired: 0 });
            allAllowed = false;
            if (!firstDenyReason) firstDenyReason = `tool_not_allowed: ${toolName}`;
            continue;
          }
          if (effectiveAllowed.length > 0 && !effectiveAllowed.includes(toolName)) {
            results.push({ tool: toolName, allowed: false, reason: `tool_not_allowed: ${toolName} not in allowedTools`, creditsRequired: 0 });
            allAllowed = false;
            if (!firstDenyReason) firstDenyReason = `tool_not_allowed: ${toolName}`;
            continue;
          }

          const creditsRequired = this.gate.getToolPrice(toolName, toolArgs);
          totalCreditsRequired += creditsRequired;
          results.push({ tool: toolName, allowed: true, creditsRequired });
        }

        // Step 5: Aggregate credits check
        if (allAllowed && keyRecord.credits < totalCreditsRequired) {
          allAllowed = false;
          firstDenyReason = `insufficient_credits: need ${totalCreditsRequired}, have ${keyRecord.credits}`;
        }

        // Step 6: Spending limit
        if (allAllowed && keyRecord.spendingLimit > 0) {
          const wouldSpend = keyRecord.totalSpent + totalCreditsRequired;
          if (wouldSpend > keyRecord.spendingLimit) {
            allAllowed = false;
            firstDenyReason = `spending_limit_exceeded: limit ${keyRecord.spendingLimit}, spent ${keyRecord.totalSpent}, need ${totalCreditsRequired}`;
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          allAllowed,
          ...(firstDenyReason ? { reason: firstDenyReason } : {}),
          totalCreditsRequired,
          creditsAvailable: keyRecord.credits,
          ...(allAllowed ? { creditsAfter: keyRecord.credits - totalCreditsRequired } : {}),
          ...(rateStatus.limit > 0 ? { rateLimit: rateStatus } : {}),
          results,
        }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read request body' }));
    }
  }

  // ─── /requests/export — Export request log as JSON or CSV ───────────────────

  private handleRequestLogExport(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');

    const format = params.get('format') || 'json';
    const keyFilter = params.get('key');
    const toolFilter = params.get('tool');
    const statusFilter = params.get('status');
    const sinceFilter = params.get('since');
    const untilFilter = params.get('until');

    let filtered = this.requestLog;

    // Filter by key (partial match on masked key)
    if (keyFilter) {
      const kf = keyFilter.toLowerCase();
      filtered = filtered.filter(e => e.key.toLowerCase().includes(kf));
    }

    // Filter by tool name (exact match)
    if (toolFilter) {
      filtered = filtered.filter(e => e.tool === toolFilter);
    }

    // Filter by status
    if (statusFilter === 'allowed' || statusFilter === 'denied') {
      filtered = filtered.filter(e => e.status === statusFilter);
    }

    // Filter by since timestamp
    if (sinceFilter) {
      const sinceTime = new Date(sinceFilter).getTime();
      if (!isNaN(sinceTime)) {
        filtered = filtered.filter(e => new Date(e.timestamp).getTime() >= sinceTime);
      }
    }

    // Filter by until timestamp
    if (untilFilter) {
      const untilTime = new Date(untilFilter).getTime();
      if (!isNaN(untilTime)) {
        filtered = filtered.filter(e => new Date(e.timestamp).getTime() <= untilTime);
      }
    }

    // Return newest first
    const sorted = [...filtered].reverse();

    if (format === 'csv') {
      const header = 'id,timestamp,tool,key,status,credits,durationMs,denyReason,requestId';
      const rows = sorted.map(e => {
        const escapeCsv = (v: string | undefined) => {
          if (v === undefined || v === null) return '';
          const s = String(v);
          if (s.includes(',') || s.includes('"') || s.includes('\n')) {
            return '"' + s.replace(/"/g, '""') + '"';
          }
          return s;
        };
        return [
          e.id,
          e.timestamp,
          escapeCsv(e.tool),
          escapeCsv(e.key),
          e.status,
          e.credits,
          e.durationMs,
          escapeCsv(e.denyReason),
          escapeCsv(e.requestId),
        ].join(',');
      });
      const csv = [header, ...rows].join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="paygate-requests.csv"',
      });
      res.end(csv);
    } else {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="paygate-requests.json"',
      });
      res.end(JSON.stringify({ count: sorted.length, requests: sorted }, null, 2));
    }
  }

  // ─── /tools/available — Per-key tool availability with pricing ──────────────

  private handleToolAvailability(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    const urlParts = req.url?.split('?') || [];
    const params = new URLSearchParams(urlParts[1] || '');
    const keyParam = params.get('key');

    if (!keyParam) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required parameter: key' }));
      return;
    }

    // Resolve alias
    const keyRecord = this.gate.store.resolveKeyRaw(keyParam);
    if (!keyRecord) {
      const isExpired = this.gate.store.isExpired(keyParam);
      const reason = isExpired ? 'api_key_expired' : 'invalid_api_key';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: reason, tools: [] }));
      return;
    }

    // Get all discovered tools with pricing
    const allToolPricing = this.registry.getFullPricing().tools;

    // Build per-tool availability
    const effectiveAllowed = keyRecord.allowedTools || [];
    const effectiveDenied = keyRecord.deniedTools || [];

    const tools = allToolPricing.map(toolInfo => {
      const toolName = toolInfo.name;

      // ACL check
      let accessible = true;
      let denyReason: string | undefined;
      if (effectiveDenied.includes(toolName)) {
        accessible = false;
        denyReason = 'denied_by_acl';
      } else if (effectiveAllowed.length > 0 && !effectiveAllowed.includes(toolName)) {
        accessible = false;
        denyReason = 'not_in_allowed_list';
      }

      // Affordability
      const creditsRequired = toolInfo.creditsPerCall;
      const canAfford = keyRecord.credits >= creditsRequired;

      // Per-tool rate limit status
      const perToolRateLimit = toolInfo.rateLimitPerMin > 0
        ? this.gate.rateLimiter.getStatus(`${keyRecord.key}:tool:${toolName}`, toolInfo.rateLimitPerMin)
        : null;

      return {
        tool: toolName,
        accessible,
        ...(denyReason ? { denyReason } : {}),
        creditsPerCall: creditsRequired,
        canAfford,
        ...(perToolRateLimit ? { rateLimit: perToolRateLimit } : {}),
      };
    });

    // Global rate limit
    const globalRateLimit = this.gate.rateLimiter.getStatus(keyRecord.key);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      key: keyRecord.key.slice(0, 7) + '...' + keyRecord.key.slice(-4),
      creditsAvailable: keyRecord.credits,
      totalTools: tools.length,
      accessibleTools: tools.filter(t => t.accessible).length,
      ...(globalRateLimit.limit > 0 ? { globalRateLimit } : {}),
      tools,
    }));
  }

  /** Calculate percentile from an array of numbers. */
  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }
}
