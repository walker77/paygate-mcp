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
  /** Server start time (ms since epoch) */
  private readonly startedAt: number = Date.now();
  /** Whether the server is draining (shutting down gracefully) */
  private draining = false;
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
      // ─── Registry / Discovery endpoints ──────────────────────────────
      case '/.well-known/mcp-payment':
        return this.handlePaymentMetadata(req, res);
      case '/pricing':
        return this.handlePricing(req, res);
      case '/metrics':
        return this.handleMetrics(req, res);
      case '/analytics':
        return this.handleAnalytics(req, res);
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
    const status = this.draining ? 'draining' : 'healthy';
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
}
