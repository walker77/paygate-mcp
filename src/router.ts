/**
 * MultiServerRouter — Routes tool calls to the correct backend proxy
 * based on tool name prefixes.
 *
 * Architecture:
 *   HTTP Client → PayGateServer → Router → [prefix] → McpProxy / HttpMcpProxy
 *
 * Tool names are prefixed: "filesystem:read_file", "github:search_repos".
 * The router strips the prefix before forwarding to the backend.
 *
 * For tools/list, the router aggregates tools from all backends and adds prefixes.
 * For tools/call, the router extracts the prefix, finds the backend, and forwards.
 */

import { EventEmitter } from 'events';
import { JsonRpcRequest, JsonRpcResponse, ServerBackendConfig, ToolCallParams } from './types';
import { Gate } from './gate';
import { McpProxy } from './proxy';
import { HttpMcpProxy } from './http-proxy';

type ProxyBackend = McpProxy | HttpMcpProxy;

export class MultiServerRouter extends EventEmitter {
  private readonly gate: Gate;
  private readonly backends: Map<string, ProxyBackend> = new Map();
  private readonly configs: ServerBackendConfig[];
  private started = false;

  /** Separator between prefix and tool name */
  static readonly SEPARATOR = ':';

  constructor(gate: Gate, configs: ServerBackendConfig[]) {
    super();
    this.gate = gate;
    this.configs = configs;

    // Validate: no duplicate prefixes, each has a transport
    const seen = new Set<string>();
    for (const cfg of configs) {
      if (!cfg.prefix || cfg.prefix.includes(MultiServerRouter.SEPARATOR)) {
        throw new Error(`Invalid server prefix: "${cfg.prefix}" — must be non-empty and not contain "${MultiServerRouter.SEPARATOR}"`);
      }
      if (seen.has(cfg.prefix)) {
        throw new Error(`Duplicate server prefix: "${cfg.prefix}"`);
      }
      if (!cfg.serverCommand && !cfg.remoteUrl) {
        throw new Error(`Server "${cfg.prefix}" needs either serverCommand or remoteUrl`);
      }
      if (cfg.serverCommand && cfg.remoteUrl) {
        throw new Error(`Server "${cfg.prefix}" cannot have both serverCommand and remoteUrl`);
      }
      seen.add(cfg.prefix);
    }

    // Create proxy instances
    for (const cfg of configs) {
      let proxy: ProxyBackend;
      if (cfg.remoteUrl) {
        proxy = new HttpMcpProxy(gate, cfg.remoteUrl);
      } else {
        proxy = new McpProxy(gate, cfg.serverCommand!, cfg.serverArgs || []);
      }
      this.backends.set(cfg.prefix, proxy);
    }
  }

  /**
   * Start all backend proxies.
   */
  async start(): Promise<void> {
    if (this.started) return;
    const startPromises = Array.from(this.backends.values()).map(p => p.start());
    await Promise.all(startPromises);
    this.started = true;
  }

  /**
   * Handle an incoming JSON-RPC request, routing to the appropriate backend.
   */
  async handleRequest(request: JsonRpcRequest, apiKey: string | null): Promise<JsonRpcResponse> {
    if (!this.started) {
      return this.errorResponse(request.id, -32603, 'Router not started');
    }

    // tools/list — aggregate from all backends with prefixes
    if (request.method === 'tools/list') {
      return this.handleToolsList(request, apiKey);
    }

    // tools/call — route by prefix
    if (request.method === 'tools/call') {
      return this.handleToolsCall(request, apiKey);
    }

    // Free methods (initialize, ping, etc.) — forward to first backend
    if (this.gate.isFreeMethod(request.method)) {
      const firstBackend = this.backends.values().next().value;
      if (!firstBackend) {
        return this.errorResponse(request.id, -32603, 'No backends configured');
      }
      return firstBackend.handleRequest(request, apiKey);
    }

    // Unknown method — forward to first backend
    const firstBackend = this.backends.values().next().value;
    if (!firstBackend) {
      return this.errorResponse(request.id, -32603, 'No backends configured');
    }
    return firstBackend.handleRequest(request, apiKey);
  }

  /**
   * Aggregate tools/list from all backends, prefixing tool names.
   */
  private async handleToolsList(request: JsonRpcRequest, apiKey: string | null): Promise<JsonRpcResponse> {
    const allTools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> = [];

    for (const [prefix, backend] of this.backends) {
      // Use forwardUngated to bypass the proxy's own ACL filtering
      // (which would filter on un-prefixed names). We do ACL filtering
      // below on the prefixed names instead.
      const response = await backend.forwardUngated(request);

      if (response.result) {
        const result = response.result as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
        if (result.tools && Array.isArray(result.tools)) {
          for (const tool of result.tools) {
            allTools.push({
              ...tool,
              name: `${prefix}${MultiServerRouter.SEPARATOR}${tool.name}`,
              description: tool.description ? `[${prefix}] ${tool.description}` : `[${prefix}]`,
            });
          }
        }
      }
    }

    // Apply ACL filtering on the prefixed names
    let filteredTools = allTools;
    if (apiKey) {
      const filtered = this.gate.filterToolsForKey(apiKey, allTools);
      if (filtered) {
        filteredTools = filtered;
      }
    }

    return {
      jsonrpc: '2.0',
      id: request.id,
      result: { tools: filteredTools },
    };
  }

  /**
   * Route a tools/call request by extracting the prefix from the tool name.
   */
  private async handleToolsCall(request: JsonRpcRequest, apiKey: string | null): Promise<JsonRpcResponse> {
    const params = request.params as unknown as ToolCallParams;
    if (!params || !params.name) {
      return this.errorResponse(request.id, -32602, 'Invalid tool call: missing tool name');
    }

    const sep = MultiServerRouter.SEPARATOR;
    const sepIdx = params.name.indexOf(sep);

    if (sepIdx === -1) {
      return this.errorResponse(request.id, -32602,
        `Invalid tool name: "${params.name}" — must be prefixed (e.g., "server${sep}tool"). Available prefixes: ${Array.from(this.backends.keys()).join(', ')}`);
    }

    const prefix = params.name.slice(0, sepIdx);
    const realToolName = params.name.slice(sepIdx + 1);

    const backend = this.backends.get(prefix);
    if (!backend) {
      return this.errorResponse(request.id, -32602,
        `Unknown server prefix: "${prefix}". Available: ${Array.from(this.backends.keys()).join(', ')}`);
    }

    // Gate evaluates on the PREFIXED name (so pricing/ACL can target "prefix:tool")
    // But we forward the UNPREFIXED name to the backend
    const gatedRequest: JsonRpcRequest = {
      ...request,
      params: {
        ...(request.params || {}),
        name: realToolName,
        arguments: params.arguments,
      },
    };

    // First, run gate evaluation on the prefixed name for billing/ACL
    const decision = this.gate.evaluate(apiKey, { name: params.name, arguments: params.arguments });

    if (!decision.allowed) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32402,
          message: `Payment required: ${decision.reason}`,
          data: {
            creditsRequired: this.gate.getToolPrice(params.name),
            remainingCredits: decision.remainingCredits,
          },
        },
      };
    }

    // Forward to backend with un-prefixed tool name (skip gate in proxy — already gated here)
    const response = await this.forwardUngatedToBackend(backend, gatedRequest);

    // Refund on failure
    let refunded = false;
    if (response.error && this.gate.refundOnFailure && decision.creditsCharged > 0 && apiKey) {
      this.gate.refund(apiKey, params.name, decision.creditsCharged);
      refunded = true;
    }

    this.emit('tool-call', {
      tool: params.name,
      server: prefix,
      apiKey: apiKey?.slice(0, 10),
      creditsCharged: refunded ? 0 : decision.creditsCharged,
      remainingCredits: decision.remainingCredits,
      refunded,
    });

    return response;
  }

  /**
   * Forward a request to a backend without re-gating.
   * The request has already been gated by the router.
   */
  private async forwardUngatedToBackend(backend: ProxyBackend, request: JsonRpcRequest): Promise<JsonRpcResponse> {
    return backend.forwardUngated(request);
  }

  /**
   * Stop all backend proxies.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    const stopPromises = Array.from(this.backends.values()).map(p => p.stop());
    await Promise.all(stopPromises);
  }

  get isRunning(): boolean {
    return this.started;
  }

  /** Get all registered prefixes */
  get prefixes(): string[] {
    return Array.from(this.backends.keys());
  }

  /** Get backend count */
  get backendCount(): number {
    return this.backends.size;
  }

  private errorResponse(id: string | number | undefined, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}
