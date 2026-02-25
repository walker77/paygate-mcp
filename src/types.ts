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
  /** Refund credits when downstream tool call fails. Default: false. */
  refundOnFailure: boolean;
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
