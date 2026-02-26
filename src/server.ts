/**
 * PayGateServer — HTTP server that exposes the gated MCP proxy.
 *
 * Endpoints:
 *   POST /mcp     — JSON-RPC endpoint (MCP Streamable HTTP transport)
 *   GET  /status  — Dashboard / usage summary
 *   POST /keys    — Create API key
 *   GET  /keys    — List API keys
 *   POST /topup   — Add credits to a key
 *
 * API key is sent via X-API-Key header on /mcp endpoint.
 * Admin endpoints (/keys, /topup, /status) require X-Admin-Key header.
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PayGateConfig, JsonRpcRequest, ServerBackendConfig, DEFAULT_CONFIG } from './types';

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

/** Max request body size: 1MB */
const MAX_BODY_SIZE = 1_048_576;

/** Union type for both proxy backends */
type ProxyBackend = McpProxy | HttpMcpProxy;

/** Common interface for request handling (single proxy or multi-server router) */
interface RequestHandler {
  handleRequest(request: JsonRpcRequest, apiKey: string | null): Promise<JsonRpcResponse>;
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
  private readonly adminKey: string;
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
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.adminKey = adminKey || `admin_${require('crypto').randomBytes(16).toString('hex')}`;
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
  }

  async start(): Promise<{ port: number; adminKey: string }> {
    await this.handler.start();

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
        resolve({ port: actualPort, adminKey: this.adminKey });
      });

      this.server.on('error', reject);
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-Admin-Key, Mcp-Session-Id, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Credits-Remaining');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url?.split('?')[0] || '/';

    switch (url) {
      case '/mcp':
        return this.handleMcp(req, res);
      case '/status':
        return this.handleStatus(req, res);
      case '/keys':
        if (req.method === 'POST') return this.handleCreateKey(req, res);
        if (req.method === 'GET') return this.handleListKeys(req, res);
        break;
      case '/keys/revoke':
        return this.handleRevokeKey(req, res);
      case '/keys/rotate':
        return this.handleRotateKey(req, res);
      case '/keys/acl':
        return this.handleSetAcl(req, res);
      case '/keys/expiry':
        return this.handleSetExpiry(req, res);
      case '/keys/quota':
        return this.handleSetQuota(req, res);
      case '/topup':
        return this.handleTopUp(req, res);
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
        sessionId: sessionId.slice(0, 16) + '...',
      });
    }

    const response = await this.handler.handleRequest(request, apiKey);

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
          tool: toolName,
          errorCode: response.error.code,
          reason: response.error.message,
        });
        this.metrics.recordToolCall(toolName, false, 0, reason);
        if (response.error.code === -32001) {
          this.metrics.recordRateLimitHit(toolName);
        }
      } else {
        this.audit.log('gate.allow', maskKeyForAudit(apiKey || 'anonymous'), `Allowed: ${toolName}`, {
          tool: toolName,
        });
        // Estimate credits from config (actual deduction tracked in gate)
        const price = this.gate.getToolPrice(toolName,
          (request.params as Record<string, unknown>)?.arguments as Record<string, unknown> | undefined);
        this.metrics.recordToolCall(toolName, true, price);
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
   * Resolve API key from X-API-Key header or OAuth Bearer token.
   */
  private resolveApiKey(req: IncomingMessage): string | null {
    let apiKey = (req.headers['x-api-key'] as string) || null;
    if (!apiKey && this.oauth) {
      const authHeader = req.headers['authorization'] as string;
      if (authHeader?.startsWith('Bearer ')) {
        const bearerToken = authHeader.slice(7);
        const tokenInfo = this.oauth.validateToken(bearerToken);
        if (tokenInfo) {
          apiKey = tokenInfo.apiKey;
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
        balance: 'GET /balance — Check own credits (requires X-API-Key)',
        dashboard: 'GET /dashboard — Admin web dashboard (browser UI)',
        status: 'GET /status — Usage data JSON (requires X-Admin-Key)',
        createKey: 'POST /keys — Create API key (requires X-Admin-Key)',
        listKeys: 'GET /keys — List API keys (requires X-Admin-Key)',
        revokeKey: 'POST /keys/revoke — Revoke a key (requires X-Admin-Key)',
        rotateKey: 'POST /keys/rotate — Rotate a key (requires X-Admin-Key)',
        setAcl: 'POST /keys/acl — Set tool ACL (requires X-Admin-Key)',
        setExpiry: 'POST /keys/expiry — Set key expiry (requires X-Admin-Key)',
        topUp: 'POST /topup — Add credits (requires X-Admin-Key)',
        usage: 'GET /usage — Export usage data (requires X-Admin-Key)',
        limits: 'POST /limits — Set spending limit (requires X-Admin-Key)',
        setQuota: 'POST /keys/quota — Set usage quota (requires X-Admin-Key)',
        pricing: 'GET /pricing — Tool pricing breakdown (public)',
        mcpPayment: 'GET /.well-known/mcp-payment — Payment metadata (SEP-2007)',
        audit: 'GET /audit — Query audit log (requires X-Admin-Key)',
        auditExport: 'GET /audit/export — Export audit log (requires X-Admin-Key)',
        auditStats: 'GET /audit/stats — Audit log statistics (requires X-Admin-Key)',
        metrics: 'GET /metrics — Prometheus metrics (public)',
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
    }));
  }

  // ─── /status — Dashboard ────────────────────────────────────────────────────

  private handleStatus(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.gate.getStatus(), null, 2));
  }

  // ─── /keys — Create ─────────────────────────────────────────────────────────

  private async handleCreateKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.checkAdmin(req, res)) return;

    const body = await this.readBody(req);
    let params: { name?: string; credits?: number; allowedTools?: string[]; deniedTools?: string[]; expiresIn?: number; expiresAt?: string; quota?: { dailyCallLimit?: number; monthlyCallLimit?: number; dailyCreditLimit?: number; monthlyCreditLimit?: number } };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const name = String(params.name || 'unnamed').slice(0, 200);
    const credits = Math.max(0, Math.floor(Number(params.credits) || 100));

    if (credits <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Credits must be a positive integer' }));
      return;
    }

    // Calculate expiry: expiresIn (seconds) takes priority over expiresAt (ISO date)
    let expiresAt: string | null = null;
    if (params.expiresIn && Number(params.expiresIn) > 0) {
      expiresAt = new Date(Date.now() + Number(params.expiresIn) * 1000).toISOString();
    } else if (params.expiresAt) {
      expiresAt = String(params.expiresAt);
    }

    // Parse quota if provided
    let quota = undefined;
    if (params.quota) {
      quota = {
        dailyCallLimit: Math.max(0, Math.floor(Number(params.quota.dailyCallLimit) || 0)),
        monthlyCallLimit: Math.max(0, Math.floor(Number(params.quota.monthlyCallLimit) || 0)),
        dailyCreditLimit: Math.max(0, Math.floor(Number(params.quota.dailyCreditLimit) || 0)),
        monthlyCreditLimit: Math.max(0, Math.floor(Number(params.quota.monthlyCreditLimit) || 0)),
      };
    }

    const record = this.gate.store.createKey(name, credits, {
      allowedTools: params.allowedTools,
      deniedTools: params.deniedTools,
      expiresAt,
      quota,
    });

    this.audit.log('key.created', 'admin', `Key created: ${name}`, {
      keyMasked: maskKeyForAudit(record.key),
      name,
      credits,
      allowedTools: record.allowedTools,
      deniedTools: record.deniedTools,
      expiresAt: record.expiresAt,
    });

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      key: record.key,
      name: record.name,
      credits: record.credits,
      allowedTools: record.allowedTools,
      deniedTools: record.deniedTools,
      expiresAt: record.expiresAt,
      message: 'Save this key — it cannot be retrieved later.',
    }));
  }

  // ─── /keys — List ───────────────────────────────────────────────────────────

  private handleListKeys(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.gate.store.listKeys(), null, 2));
  }

  // ─── /topup — Add credits ───────────────────────────────────────────────────

  private async handleTopUp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

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

    const success = this.gate.store.addCredits(params.key, credits);
    if (!success) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found or inactive' }));
      return;
    }

    const record = this.gate.store.getKey(params.key);

    this.audit.log('key.topup', 'admin', `Added ${credits} credits`, {
      keyMasked: maskKeyForAudit(params.key),
      creditsAdded: credits,
      newBalance: record?.credits,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ credits: record?.credits, message: `Added ${credits} credits` }));
  }

  // ─── /keys/revoke — Revoke a key ──────────────────────────────────────────

  private async handleRevokeKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

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

    const success = this.gate.store.revokeKey(params.key);
    if (!success) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found' }));
      return;
    }

    this.audit.log('key.revoked', 'admin', `Key revoked`, {
      keyMasked: maskKeyForAudit(params.key),
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Key revoked' }));
  }

  // ─── /keys/rotate — Rotate API key ─────────────────────────────────────────

  private async handleRotateKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

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

    this.audit.log('key.rotated', 'admin', `Key rotated`, {
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
    if (!this.checkAdmin(req, res)) return;

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

    const record = this.gate.store.getKey(params.key);

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
    if (!this.checkAdmin(req, res)) return;

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

    const record = this.gate.store.getKeyRaw(params.key);

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
    if (!this.checkAdmin(req, res)) return;

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

    this.audit.log('key.quota_updated', 'admin', `Quota set`, {
      keyMasked: maskKeyForAudit(params.key),
      quota,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ quota, message: 'Quota set' }));
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
    if (!this.checkAdmin(req, res)) return;

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

    const record = this.gate.store.getKey(params.key);
    if (!record) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found or inactive' }));
      return;
    }

    const limit = Math.max(0, Math.floor(Number(params.spendingLimit) || 0));
    record.spendingLimit = limit;
    this.gate.store.save();

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

    const events = this.gate.meter.getEvents(since);

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

  private checkAdmin(req: IncomingMessage, res: ServerResponse): boolean {
    const adminKey = req.headers['x-admin-key'] as string;
    if (adminKey !== this.adminKey) {
      this.audit.log('admin.auth_failed', 'unknown', `Admin auth failed on ${req.url}`, {
        url: req.url,
        method: req.method,
      });
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid admin key' }));
      return false;
    }
    return true;
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
    await this.handler.stop();
    this.gate.destroy();
    this.oauth?.destroy();
    this.sessions.destroy();
    this.audit.destroy();
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }
}
