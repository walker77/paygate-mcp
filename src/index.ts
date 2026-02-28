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

export { PayGateServer, generateRequestId, getRequestId, resolveClientIp } from './server';
export { Gate } from './gate';
export { McpProxy } from './proxy';
export { HttpMcpProxy } from './http-proxy';
export { MultiServerRouter } from './router';
export { KeyStore } from './store';
export { UsageMeter } from './meter';
export { RateLimiter } from './rate-limiter';
export { StripeWebhookHandler } from './stripe';
export { StripeCheckout } from './stripe-checkout';
export type { CreditPackage, StripeCheckoutConfig, CheckoutSessionResult } from './stripe-checkout';
export { BackupManager } from './backup';
export type { BackupSnapshot, RestoreResult, BackupStateProvider } from './backup';
export { WebhookEmitter } from './webhook';
export type { WebhookAdminEvent, WebhookEvent, DeadLetterEntry } from './webhook';
export { WebhookRouter } from './webhook-router';
export { QuotaTracker } from './quota';
export { OAuthProvider } from './oauth';
export type { OAuthClientRecord, OAuthTokenRecord, OAuthServerMetadata, OAuthConfig } from './oauth';
export { SessionManager, writeSseHeaders, writeSseEvent, writeSseKeepAlive } from './session';
export { AuditLogger, maskKeyForAudit } from './audit';
export type { AuditEvent, AuditEventType, AuditLogConfig, AuditQuery, AuditQueryResult } from './audit';
export { CreditLedger } from './credit-ledger';
export type { CreditEntry, SpendingVelocity } from './credit-ledger';
export { ToolRegistry } from './registry';
export { MetricsCollector } from './metrics';
export type { MetricLabels } from './metrics';
export type { ToolPricingInfo, ServerPaymentMetadata, PricingResponse } from './registry';
export type { McpSession, SessionManagerConfig } from './session';
export { getDashboardHtml } from './dashboard';
export { getPortalHtml } from './portal';
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
export { ScopedTokenManager, TokenRevocationList } from './tokens';
export type { TokenPayload, TokenValidation, TokenCreateOptions, RevokedTokenEntry } from './tokens';
export { AdminKeyManager, ROLE_HIERARCHY, VALID_ROLES } from './admin-keys';
export type { AdminRole, AdminKeyRecord } from './admin-keys';
export { PluginManager } from './plugin';
export type { PayGatePlugin, PluginGateContext, PluginToolContext, PluginGateOverride, PluginInfo } from './plugin';
export { KeyGroupManager } from './groups';
export type { KeyGroupRecord, KeyGroupInfo, ResolvedPolicy } from './groups';
export { Logger, parseLogLevel, parseLogFormat, VALID_LOG_LEVELS, VALID_LOG_FORMATS } from './logger';
export type { LogLevel, LogFormat, LoggerOptions } from './logger';
export { ResponseCache } from './response-cache';
export type { CacheEntry, CacheStats } from './response-cache';
export { CircuitBreaker } from './circuit-breaker';
export type { CircuitBreakerConfig, CircuitState, CircuitStatus } from './circuit-breaker';
export { generateComplianceReport, complianceReportToCsv } from './compliance';
export type { ComplianceFramework, ComplianceReport, ComplianceReportMeta, ComplianceSection, ComplianceEvent, ComplianceSummary } from './compliance';
export { ContentGuardrails, BUILT_IN_RULES } from './guardrails';
export type { GuardrailRule, GuardrailAction, GuardrailConfig, GuardrailViolation, GuardrailCheckResult, GuardrailStats } from './guardrails';
export { ConcurrencyLimiter } from './concurrency-limiter';
export type { ConcurrencyLimiterConfig, ConcurrencyAcquireResult, ConcurrencySnapshot } from './concurrency-limiter';
export { TrafficMirror } from './traffic-mirror';
export type { MirrorConfig, MirrorStats } from './traffic-mirror';
export { ToolAliasManager } from './tool-aliases';
export type { ToolAlias, AliasResolveResult, AliasStats } from './tool-aliases';
export { UsagePlanManager } from './usage-plans';
export type { UsagePlan, UsagePlanCreateParams, UsagePlanInfo, PlanStats } from './usage-plans';
export { ToolSchemaValidator } from './schema-validator';
export type { ToolSchema, SchemaNode, ValidationResult, ValidationError, SchemaStats } from './schema-validator';
export { CanaryRouter } from './canary-router';
export type { CanaryConfig, CanaryStats, CanaryBackend, CanaryDecision } from './canary-router';
export { TransformPipeline } from './transforms';
export type { TransformRule, TransformRuleCreateParams, TransformOperation, TransformDirection, TransformOp, TransformStats, TransformContext } from './transforms';
export { RetryPolicy } from './retry-policy';
export type { RetryConfig, RetryStats, RetryResult } from './retry-policy';
export { AdaptiveRateLimiter } from './adaptive-rate-limiter';
export type { AdaptiveRateConfig, AdaptiveRateStats, AdaptiveRateAdjustment, KeyBehavior } from './adaptive-rate-limiter';

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
  WebhookFilterRule,
  KeyListQuery,
  KeyListResult,
} from './types';

export { DEFAULT_CONFIG } from './types';
