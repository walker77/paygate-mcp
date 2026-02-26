/**
 * PayGate MCP — Public API.
 *
 * @example
 * ```ts
 * import { PayGateServer } from 'paygate-mcp';
 *
 * const server = new PayGateServer({
 *   serverCommand: 'npx',
 *   serverArgs: ['@modelcontextprotocol/server-filesystem', '/tmp'],
 *   port: 3402,
 * });
 *
 * const { port, adminKey } = await server.start();
 * ```
 */

export { PayGateServer } from './server';
export { Gate } from './gate';
export { McpProxy } from './proxy';
export { HttpMcpProxy } from './http-proxy';
export { MultiServerRouter } from './router';
export { KeyStore } from './store';
export { UsageMeter } from './meter';
export { RateLimiter } from './rate-limiter';
export { StripeWebhookHandler } from './stripe';
export { WebhookEmitter } from './webhook';
export type { WebhookAdminEvent, WebhookEvent, DeadLetterEntry } from './webhook';
export { QuotaTracker } from './quota';
export { OAuthProvider } from './oauth';
export type { OAuthClientRecord, OAuthTokenRecord, OAuthServerMetadata, OAuthConfig } from './oauth';
export { SessionManager, writeSseHeaders, writeSseEvent, writeSseKeepAlive } from './session';
export { AuditLogger, maskKeyForAudit } from './audit';
export type { AuditEvent, AuditEventType, AuditLogConfig, AuditQuery, AuditQueryResult } from './audit';
export { ToolRegistry } from './registry';
export { MetricsCollector } from './metrics';
export type { MetricLabels } from './metrics';
export type { ToolPricingInfo, ServerPaymentMetadata, PricingResponse } from './registry';
export type { McpSession, SessionManagerConfig } from './session';
export { getDashboardHtml } from './dashboard';
export { AnalyticsEngine } from './analytics';
export type { AnalyticsReport, TimeBucket, ToolBreakdown, TopConsumer, TrendComparison, BucketGranularity } from './analytics';
export { AlertEngine } from './alerts';
export type { Alert, AlertRule, AlertType, AlertEngineConfig } from './alerts';
export { TeamManager } from './teams';
export type { TeamRecord, TeamUsageSummary } from './teams';
export { RedisClient, parseRedisUrl, RedisSubscriber } from './redis-client';
export type { RedisClientOptions, MessageHandler } from './redis-client';
export { RedisSync } from './redis-sync';
export type { PubSubEvent } from './redis-sync';
export { PayGateClient, PayGateError } from './client';
export type { PayGateClientConfig, CreditsNeededInfo, BalanceInfo } from './client';
export { validateConfig, formatDiagnostics } from './config-validator';
export type { ConfigDiagnostic, ValidatableConfig } from './config-validator';

export type {
  PayGateConfig,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  ToolCallParams,
  ToolInfo,
  ToolPricing,
  ServerBackendConfig,
  ApiKeyRecord,
  UsageEvent,
  UsageSummary,
  GateDecision,
  QuotaConfig,
  BatchToolCall,
  BatchGateResult,
} from './types';

export { DEFAULT_CONFIG } from './types';
