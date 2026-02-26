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
  freeMethods: ['initialize', 'initialized', 'ping', 'notifications/initialized', 'tools/list', 'resources/list', 'prompts/list'],
  shadowMode: false,
  webhookUrl: null,
  webhookSecret: null,
  webhookMaxRetries: 5,
  webhookFilters: [],
  refundOnFailure: false,
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
