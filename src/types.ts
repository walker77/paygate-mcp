/**
 * PayGate MCP — Core types.
 */

// ─── JSON-RPC 2.0 ──────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ─── MCP-specific ───────────────────────────────────────────────────────────────

export interface ToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

// ─── PayGate Config ─────────────────────────────────────────────────────────────

export interface ToolPricing {
  /** Price in credits per call. Default: 1 */
  creditsPerCall: number;
  /** Override rate limit for this tool (calls/min). 0 = use global. */
  rateLimitPerMin?: number;
  /** Dynamic pricing: extra credits per KB of input arguments. 0 = disabled. */
  creditsPerKbInput?: number;
  /** Outcome-based pricing: extra credits per KB of response output. 0 = disabled. Post-call surcharge. */
  creditsPerKbOutput?: number;
  /** Response cache TTL in seconds for this tool. 0 = no caching. */
  cacheTtlSeconds?: number;
  /** Per-tool timeout in milliseconds. 0 = use global. */
  timeoutMs?: number;
}

// ─── Usage Quotas ──────────────────────────────────────────────────────────

export interface QuotaConfig {
  /** Max calls per day (UTC). 0 = unlimited. */
  dailyCallLimit: number;
  /** Max calls per month (UTC). 0 = unlimited. */
  monthlyCallLimit: number;
  /** Max credits per day (UTC). 0 = unlimited. */
  dailyCreditLimit: number;
  /** Max credits per month (UTC). 0 = unlimited. */
  monthlyCreditLimit: number;
}

export interface PayGateConfig {
  /** Display name for this gated server */
  name: string;
  /** Command to spawn the wrapped MCP server (stdio transport) */
  serverCommand: string;
  /** Args for the server command */
  serverArgs: string[];
  /** Port to listen on for HTTP transport */
  port: number;
  /** Global default price per tool call (credits) */
  defaultCreditsPerCall: number;
  /** Per-tool pricing overrides */
  toolPricing: Record<string, ToolPricing>;
  /** Global rate limit per API key (calls/min). 0 = unlimited. */
  globalRateLimitPerMin: number;
  /** Methods that pass through without auth */
  freeMethods: string[];
  /** Whether to log all calls (shadow mode) without enforcing payment */
  shadowMode: boolean;
  /** Webhook URL to POST usage events to. Null = disabled. */
  webhookUrl: string | null;
  /** Secret for HMAC-SHA256 webhook signatures. Null = unsigned. */
  webhookSecret: string | null;
  /** Maximum retries for failed webhook deliveries. Default: 5. */
  webhookMaxRetries?: number;
  /** Re-check SSRF at delivery time (DNS rebinding defense). Default: true. Set false for localhost webhooks in dev/test. */
  webhookSsrfAtDelivery?: boolean;
  /** Webhook filter rules for routing events to different destinations. */
  webhookFilters?: WebhookFilterRule[];
  /** Refund credits when downstream tool call fails. Default: false. */
  refundOnFailure: boolean;
  /** Global usage quota defaults (daily/monthly limits). Null = unlimited. */
  globalQuota?: QuotaConfig;
  /** OAuth 2.1 configuration. Null = disabled. */
  oauth?: {
    /** Issuer URL (base URL of the server). Auto-detected if not set. */
    issuer?: string;
    /** Access token lifetime in seconds. Default: 3600 (1 hour). */
    accessTokenTtl?: number;
    /** Refresh token lifetime in seconds. Default: 2592000 (30 days). */
    refreshTokenTtl?: number;
    /** Supported scopes. Default: ['tools:*', 'tools:read', 'tools:write']. */
    scopes?: string[];
  };
  /** Alert rules for proactive monitoring. Empty = no alerts. */
  alertRules?: Array<{
    type: 'spending_threshold' | 'credits_low' | 'quota_warning' | 'key_expiry_soon' | 'rate_limit_spike';
    threshold: number;
    cooldownSeconds?: number;
  }>;
  /** Key expiry scanner config. Proactively scans for expiring keys on a timer. */
  expiryScanner?: {
    /** Whether the scanner is enabled. Default: true. */
    enabled: boolean;
    /** Scan interval in seconds. Default: 3600 (1 hour). Min: 60. */
    intervalSeconds?: number;
    /** Seconds before expiry to notify. Default: [604800, 86400, 3600] (7d, 24h, 1h). */
    thresholds?: number[];
  };
  /** Trusted proxy IPs/CIDRs for accurate X-Forwarded-For extraction. */
  trustedProxies?: string[];
  /** Custom response headers applied to all HTTP responses. */
  customHeaders?: Record<string, string>;
  /** Minimum log level: 'debug' | 'info' | 'warn' | 'error' | 'silent'. Default: 'info'. */
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  /** Log output format: 'text' (human-readable) | 'json' (structured). Default: 'text'. */
  logFormat?: 'text' | 'json';
  /** CORS configuration. Default: allow all origins (*). */
  cors?: {
    /** Allowed origin(s). Use '*' for all, or specify exact origins. Default: '*'. */
    origin: string | string[];
    /** Whether to include Access-Control-Allow-Credentials header. Default: false. */
    credentials?: boolean;
    /** Max age for preflight cache in seconds. Default: 86400 (24 hours). */
    maxAge?: number;
  };
  /** Max time (ms) to complete a request. 0 = no timeout. Default: 30000 (30s). */
  requestTimeoutMs?: number;
  /** Max time (ms) to receive request headers. Default: 10000 (10s). */
  headersTimeoutMs?: number;
  /** Keep-alive timeout (ms) for idle connections. Default: 65000 (65s). */
  keepAliveTimeoutMs?: number;
  /** Max HTTP requests per socket (pipelining limit). 0 = unlimited. Default: 0. */
  maxRequestsPerSocket?: number;
  /** Max concurrent TCP connections. Prevents file descriptor exhaustion. Default: 10000. */
  maxConnections?: number;
  /** Admin endpoint rate limit per IP (requests/min). 0 = unlimited. Default: 120. */
  adminRateLimit?: number;
  /** Session creation rate limit per IP (sessions/min). 0 = unlimited. Default: 60. */
  sessionRateLimit?: number;
  /** Public endpoint rate limit per IP (requests/min). 0 = unlimited. Default: 300. */
  publicRateLimit?: number;
  /** Bill task creation (tasks/send) as tool calls. Default: false. When true, tasks/send is not free. */
  billTaskCreation?: boolean;
  /** Global response cache TTL in seconds. 0 = disabled. Default: 0. Per-tool override via toolPricing. */
  cacheTtlSeconds?: number;
  /** Maximum cache entries across all tools. Default: 10000. */
  maxCacheEntries?: number;
  /** Circuit breaker: consecutive failures before opening circuit. 0 = disabled. Default: 0. */
  circuitBreakerThreshold?: number;
  /** Circuit breaker: cooldown period in seconds before attempting recovery. Default: 30. */
  circuitBreakerCooldownSeconds?: number;
  /** Global per-tool call timeout in milliseconds. 0 = no timeout. Default: 0. Per-tool override via toolPricing. */
  toolTimeoutMs?: number;
  /** Content guardrails configuration. Undefined = disabled. */
  guardrails?: {
    /** Whether guardrails are enabled. Default: false. */
    enabled: boolean;
    /** Whether to include match context in violations. Default: false. */
    includeContext?: boolean;
    /** Max violations to retain. Default: 10000. */
    maxViolations?: number;
  };
  /** Header name for country code from reverse proxy (e.g., 'CF-IPCountry', 'X-Country'). Default: 'X-Country'. */
  geoCountryHeader?: string;
}

// ─── Webhook Filters ──────────────────────────────────────────────────────

export interface WebhookFilterRule {
  /** Unique filter ID (auto-generated if not provided). */
  id: string;
  /** Human-readable name for this filter. */
  name: string;
  /** Event types to match (e.g., ['key.created', 'key.revoked']). Use ['*'] for all events. */
  events: string[];
  /** Destination webhook URL for matched events. */
  url: string;
  /** Optional signing secret for this destination (overrides global secret). */
  secret?: string;
  /** API key prefixes to match (e.g., ['pk_prod_']). Undefined/empty = all keys. */
  keyPrefixes?: string[];
  /** Whether this filter is active. Default: true. */
  active: boolean;
}

// ─── Multi-Server ──────────────────────────────────────────────────────────

export interface ServerBackendConfig {
  /** Unique prefix for this server's tools (e.g., "filesystem", "github").
   *  Tools are exposed as "prefix:tool_name". */
  prefix: string;
  /** Command to spawn the wrapped MCP server (stdio transport) */
  serverCommand?: string;
  /** Args for the server command */
  serverArgs?: string[];
  /** Remote MCP server URL (Streamable HTTP transport) */
  remoteUrl?: string;
}

export const DEFAULT_CONFIG: PayGateConfig = {
  name: 'PayGate MCP Server',
  serverCommand: '',
  serverArgs: [],
  port: 3402,
  defaultCreditsPerCall: 1,
  toolPricing: {},
  globalRateLimitPerMin: 60,
  freeMethods: [
    'initialize', 'initialized', 'ping', 'notifications/initialized',
    'tools/list', 'resources/list', 'prompts/list',
    // MCP 2025-11-25: Tasks (long-running operations) — management methods are free
    'tasks/list', 'tasks/get', 'tasks/cancel',
    // MCP 2025-11-25: Elicitation (agent asks user for input) — free
    'elicitation/create',
  ],
  shadowMode: false,
  webhookUrl: null,
  webhookSecret: null,
  webhookMaxRetries: 5,
  webhookFilters: [],
  refundOnFailure: false,
  adminRateLimit: 120,
};

// ─── API Key + Credits ──────────────────────────────────────────────────────────

export interface ApiKeyRecord {
  key: string;
  name: string;
  credits: number;
  totalSpent: number;
  totalCalls: number;
  createdAt: string;
  lastUsedAt: string | null;
  active: boolean;
  /** Max total credits this key can ever spend. 0 = unlimited. */
  spendingLimit: number;
  /** Whitelist: only these tools are accessible. Empty array = all tools allowed. */
  allowedTools: string[];
  /** Blacklist: these tools are always denied. Applied after allowedTools filter. */
  deniedTools: string[];
  /** ISO date string when this key expires. Null = never expires. */
  expiresAt: string | null;
  /** Per-key quota overrides. Null = use global defaults / unlimited. */
  quota?: QuotaConfig;
  /** Arbitrary key-value metadata tags for external system integration. */
  tags: Record<string, string>;
  /** IP allowlist: restrict which IPs can use this key. Empty = all IPs allowed. */
  ipAllowlist: string[];
  /** Tenant namespace for multi-tenant isolation. Default = 'default'. */
  namespace: string;
  /** Key group ID. Keys in a group inherit group policies. Undefined = no group. */
  group?: string;
  /** Whether the key is temporarily suspended. Suspended keys are denied but can be resumed (unlike revocation which is permanent). */
  suspended?: boolean;
  /** Allowed country codes (ISO 3166-1 alpha-2). Empty = all countries allowed. */
  allowedCountries?: string[];
  /** Denied country codes (ISO 3166-1 alpha-2). Empty = no countries denied. */
  deniedCountries?: string[];
  /** Human-readable alias for admin convenience. Must be unique across all keys. */
  alias?: string;
  /** Auto-topup configuration. Undefined = disabled. */
  autoTopup?: {
    /** Trigger auto-topup when credits drop below this threshold. */
    threshold: number;
    /** Number of credits to add on each auto-topup. */
    amount: number;
    /** Max auto-topups per day (UTC). 0 = unlimited. */
    maxDaily: number;
  };
  /** Number of auto-topups triggered today (UTC). Reset daily. */
  autoTopupTodayCount: number;
  /** Last auto-topup daily reset date (ISO date YYYY-MM-DD). */
  autoTopupLastResetDay: string;
  /** Quota tracking: calls today (UTC). Reset daily. */
  quotaDailyCalls: number;
  /** Quota tracking: calls this month (UTC). Reset monthly. */
  quotaMonthlyCalls: number;
  /** Quota tracking: credits today (UTC). Reset daily. */
  quotaDailyCredits: number;
  /** Quota tracking: credits this month (UTC). Reset monthly. */
  quotaMonthlyCredits: number;
  /** Last quota reset date (ISO date string, date only). */
  quotaLastResetDay: string;
  /** Last monthly quota reset (ISO month string YYYY-MM). */
  quotaLastResetMonth: string;
  /** Timestamped notes/comments attached to this key. */
  notes?: Array<{ timestamp: string; author: string; text: string }>;
  /** Per-key webhook URL. Events for this key are also sent here. Undefined = disabled. */
  webhookUrl?: string;
  /** HMAC-SHA256 secret for per-key webhook signatures. Undefined = unsigned. */
  webhookSecret?: string;
}

// ─── Metering ───────────────────────────────────────────────────────────────────

export interface UsageEvent {
  timestamp: string;
  apiKey: string;
  keyName: string;
  tool: string;
  creditsCharged: number;
  allowed: boolean;
  denyReason?: string;
  durationMs?: number;
  /** Tenant namespace (from the API key). */
  namespace?: string;
}

export interface UsageSummary {
  totalCalls: number;
  totalCreditsSpent: number;
  totalDenied: number;
  perTool: Record<string, { calls: number; credits: number; denied: number }>;
  perKey: Record<string, { calls: number; credits: number; denied: number }>;
  denyReasons: Record<string, number>;
}

// ─── Gate Decision ──────────────────────────────────────────────────────────────

export interface GateDecision {
  allowed: boolean;
  reason?: string;
  creditsCharged: number;
  remainingCredits: number;
}

// ─── Key Listing ────────────────────────────────────────────────────────────────

export interface KeyListQuery {
  /** Filter by namespace. */
  namespace?: string;
  /** Filter by group ID. */
  group?: string;
  /** Filter by active status: 'true', 'false', or undefined (all). */
  active?: string;
  /** Filter by suspended status: 'true', 'false', or undefined (all). */
  suspended?: string;
  /** Filter by expired status: 'true', 'false', or undefined (all). */
  expired?: string;
  /** Filter keys with name starting with this prefix (case-insensitive). */
  namePrefix?: string;
  /** Minimum credits (inclusive). */
  minCredits?: number;
  /** Maximum credits (inclusive). */
  maxCredits?: number;
  /** Sort by field. Default: 'createdAt'. */
  sortBy?: 'createdAt' | 'name' | 'credits' | 'lastUsedAt' | 'totalSpent' | 'totalCalls';
  /** Sort order. Default: 'desc'. */
  order?: 'asc' | 'desc';
  /** Number of results to return. Default: 50. Max: 500. */
  limit?: number;
  /** Number of results to skip. Default: 0. */
  offset?: number;
}

export interface KeyListResult {
  /** Array of (masked) key records matching the query. */
  keys: Array<Omit<ApiKeyRecord, 'key'> & { keyPrefix: string; expired: boolean }>;
  /** Total number of keys matching the filters (before pagination). */
  total: number;
  /** Current offset. */
  offset: number;
  /** Current limit. */
  limit: number;
  /** Whether there are more results after this page. */
  hasMore: boolean;
}

// ─── Batch Tool Calls ───────────────────────────────────────────────────────────

export interface BatchToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface BatchGateResult {
  /** Whether all calls were pre-approved */
  allAllowed: boolean;
  /** Total credits that will be / were charged for the batch */
  totalCredits: number;
  /** Per-call gate decisions (in same order as input) */
  decisions: GateDecision[];
  /** Remaining credits after all deductions */
  remainingCredits: number;
  /** If denied, the first failure reason */
  reason?: string;
  /** Index of the first denied call (-1 if all allowed) */
  failedIndex: number;
}
