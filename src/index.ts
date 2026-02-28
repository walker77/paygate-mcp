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
export { RequestDeduplicator } from './dedup';
export type { DedupConfig, DedupStats, DedupResult, DedupEntry } from './dedup';
export { PriorityQueue, PRIORITY_ORDER, TIER_VALUES } from './priority-queue';
export type { PriorityTier, PriorityQueueConfig, PriorityQueueStats, QueuedRequest } from './priority-queue';
export { CostAllocator } from './cost-tags';
export type { CostTagConfig, CostTagStats, ChargebackReport, ChargebackRow, CrossTabReport, CrossTabRow, CostTagEntry } from './cost-tags';
export { IpAccessController } from './ip-access';
export type { IpAccessConfig, IpCheckResult, AutoBlockEntry, IpAccessStats } from './ip-access';
export { RequestSigner } from './request-signing';
export type { SigningConfig, SigningSecret, SignatureVerifyResult, SigningStats } from './request-signing';
export { TenantManager } from './tenant-isolation';
export type { TenantConfig, TenantRecord, TenantUsageReport, TenantStats, TenantCreateParams } from './tenant-isolation';
export { RequestTracer } from './request-tracer';
export type { RequestTrace, TraceSpan, TraceSummary, TracerConfig, TracerStats } from './request-tracer';
export { BudgetPolicyEngine } from './budget-policy';
export type { BudgetPolicy, BudgetState, BudgetCheckResult, BudgetPolicyStats, BudgetPolicyCreateParams } from './budget-policy';
export { ToolDependencyGraph } from './tool-deps';
export type { ToolDep, DepCheckResult, ExecutionRecord, TopologicalOrder, DepGraphStats, DepGraphConfig } from './tool-deps';
export { QuotaManager } from './quota-manager';
export type { QuotaRule, QuotaUsage, QuotaCheckResult, QuotaStats, QuotaManagerConfig, QuotaPeriod, QuotaMetric, OverageAction } from './quota-manager';
export { WebhookReplayManager } from './webhook-replay';
export type { FailedDelivery, ReplayResult, ReplayStats, WebhookReplayConfig } from './webhook-replay';
export { ConfigProfileManager } from './config-profiles';
export type { ConfigProfile, ProfileDiff, ProfileStats, ConfigProfileManagerConfig } from './config-profiles';
export { ScheduledReportManager } from './scheduled-reports';
export type { ReportSchedule, ReportCreateParams, GeneratedReport, ReportData, ScheduledReportStats, ScheduledReportConfig, ReportType, ReportFrequency } from './scheduled-reports';
export { ApprovalWorkflowManager } from './approval-workflows';
export type { ApprovalRule, ApprovalRequest, ApprovalCheckResult, ApprovalDecision, ApprovalWorkflowStats, ApprovalWorkflowConfig, ApprovalCondition, ApprovalStatus } from './approval-workflows';
export { GatewayHookManager } from './gateway-hooks';
export type { GatewayHook, HookCreateParams, HookExecutionContext, HookExecutionResult, HookStageResult, GatewayHookStats, GatewayHookConfig, HookStage, HookType } from './gateway-hooks';
export { SpendCapManager } from './spend-caps';
export type { SpendCapCheckResult } from './spend-caps';
export { TaskManager } from './task-manager';
export type { TaskRecord, TaskStatus, TaskListQuery, TaskListResult } from './task-manager';
export { X402Handler } from './x402';
export type { PaymentRequirements, X402VerifyResult, X402Stats } from './x402';
export { OpenApiMcpBackend } from './openapi-backend';
export type { OpenApiMcpBackendConfig } from './openapi-backend';
export { parseOpenApiSpec, resolveBaseUrl, createApiProxyHandler, summarizeSpec } from './openapi-to-mcp';
export type { McpToolDef, OpenApiSpec, OpenApiToMcpConfig } from './openapi-to-mcp';
export { PiiMasker, BUILT_IN_PII_PATTERNS } from './pii-masking';
export type { PiiPattern, PiiMaskingConfig, TokenVault, MaskResult, UnmaskResult, PiiMaskingStats } from './pii-masking';
export { VirtualServerComposer } from './virtual-server';
export type { UpstreamServer, VirtualServerConfig, UpstreamToolInfo, UpstreamHealth, VirtualServerStats } from './virtual-server';
export { OtelEmitter } from './otel-emitter';
export type { OtelConfig, OtelSpan, OtelEmitterStats } from './otel-emitter';
export { BillableMetricEngine, computeExpression } from './billable-metrics';
export type { BillableMetric, MetricContext, MetricResult, BillableMetricStats } from './billable-metrics';
export { CreditGrantManager } from './credit-grants';
export type { CreditGrant, GrantCreateParams, DeductResult, RolloverResult, GrantSummary, CreditGrantStats } from './credit-grants';
export { A2AManager } from './a2a-protocol';
export type { AgentCard, AgentSkill, A2ATask, A2AMessage, A2ATaskStatus, A2AArtifact, MessagePart, TaskStatus as A2ATaskStatusInfo, A2AManagerConfig, A2AStats } from './a2a-protocol';
export { SequenceAnomalyDetector } from './sequence-anomaly';
export type { SequenceAnomalyConfig, AnomalyCheckResult, AnomalyEvent, TransitionModel, SequenceAnomalyStats } from './sequence-anomaly';
export { ProxyMcpServer } from './proxy-mcp-server';
export type { ProxyMcpTool, ProxyMcpServerConfig, ProxyMcpStats, ManagementResolver } from './proxy-mcp-server';
export { KeyHierarchyManager } from './key-hierarchy';
export type { KeyRelation, HierarchyInfo, KeyHierarchyConfig, KeyHierarchyStats } from './key-hierarchy';
export { SandboxManager } from './sandbox';
export type { SandboxPolicy, SandboxUsage, SandboxCheckResult, SandboxConfig, SandboxStats } from './sandbox';
export { RevenueShareTracker } from './revenue-share';
export type { RevenueShareRule, RevenueEntry, DeveloperPayout, SettlementRecord, RevenueShareConfig, RevenueShareStats } from './revenue-share';
export { ConnectionBillingManager } from './connection-billing';
export type { ConnectionSession, ConnectionBillingConfig, ConnectionBillResult, ConnectionBillingStats } from './connection-billing';

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
  SpendCapConfig,
  X402Config,
  BatchToolCall,
  BatchGateResult,
  WebhookFilterRule,
  KeyListQuery,
  KeyListResult,
} from './types';

export { DEFAULT_CONFIG } from './types';
