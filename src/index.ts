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
export { getDashboardHtml } from './dashboard';
export { PayGateClient, PayGateError } from './client';
export type { PayGateClientConfig, CreditsNeededInfo, BalanceInfo } from './client';

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
} from './types';

export { DEFAULT_CONFIG } from './types';
