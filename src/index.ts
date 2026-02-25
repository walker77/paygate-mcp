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
export { KeyStore } from './store';
export { UsageMeter } from './meter';
export { RateLimiter } from './rate-limiter';

export type {
  PayGateConfig,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  ToolCallParams,
  ToolInfo,
  ToolPricing,
  ApiKeyRecord,
  UsageEvent,
  UsageSummary,
  GateDecision,
} from './types';

export { DEFAULT_CONFIG } from './types';
