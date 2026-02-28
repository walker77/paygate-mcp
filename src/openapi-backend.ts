/**
 * OpenApiMcpBackend — virtual MCP server that proxies OpenAPI operations.
 *
 * Implements the same interface as McpProxy/HttpMcpProxy so PayGateServer
 * can treat it as any other MCP backend. Tool calls are forwarded to the
 * upstream REST API via HTTP.
 *
 * Usage:
 *   const backend = new OpenApiMcpBackend(specJson, { baseUrl: 'https://api.example.com' });
 *   const tools = backend.getTools();
 *   const result = await backend.callTool('listUsers', { limit: 10 });
 */

import { parseOpenApiSpec, resolveBaseUrl, createApiProxyHandler, McpToolDef, OpenApiToMcpConfig, OpenApiSpec, summarizeSpec } from './openapi-to-mcp';
import { JsonRpcRequest, JsonRpcResponse, BatchToolCall } from './types';
import { Gate } from './gate';

export interface OpenApiMcpBackendConfig extends OpenApiToMcpConfig {
  /** The OpenAPI spec as a JSON string. */
  specJson: string;
}

export class OpenApiMcpBackend {
  private tools: McpToolDef[];
  private proxyHandler: ReturnType<typeof createApiProxyHandler>;
  private specInfo: { title: string; version: string };
  private summary: ReturnType<typeof summarizeSpec>;
  private _isRunning = false;
  private gate: Gate | null = null;

  constructor(config: OpenApiMcpBackendConfig) {
    const spec: OpenApiSpec = JSON.parse(config.specJson);
    this.tools = parseOpenApiSpec(config.specJson, config);
    const baseUrl = resolveBaseUrl(spec, config);
    this.proxyHandler = createApiProxyHandler(this.tools, baseUrl, config);
    this.specInfo = {
      title: spec.info?.title || 'OpenAPI Server',
      version: spec.info?.version || '1.0.0',
    };
    this.summary = summarizeSpec(this.tools);
  }

  /**
   * Attach a Gate for credit/rate-limit gating of tool calls.
   */
  setGate(gate: Gate): void {
    this.gate = gate;
  }

  /**
   * Get MCP tool definitions (for tools/list response).
   */
  getTools(): Array<{ name: string; description: string; inputSchema: unknown }> {
    return this.tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Start the backend (register tools with gate).
   */
  async start(): Promise<void> {
    this._isRunning = true;
  }

  /**
   * Handle an MCP JSON-RPC request (RequestHandler interface).
   */
  async handleRequest(
    request: JsonRpcRequest,
    apiKey: string | null,
    _clientIp?: string,
    _scopedTokenTools?: string[],
    _countryCode?: string,
  ): Promise<JsonRpcResponse> {
    switch (request.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: {
              name: this.specInfo.title,
              version: this.specInfo.version,
            },
          },
        };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            tools: this.getTools(),
          },
        };

      case 'tools/call': {
        const params = request.params as Record<string, unknown> || {};
        const toolName = String(params.name || '');
        const args = (params.arguments || {}) as Record<string, unknown>;

        // Gate check: credits, rate limits, ACL
        if (this.gate) {
          const decision = this.gate.evaluate(apiKey, { name: toolName, arguments: args }, _clientIp, _scopedTokenTools, _countryCode);
          if (!decision.allowed) {
            return {
              jsonrpc: '2.0',
              id: request.id,
              error: {
                code: decision.reason?.includes('rate') ? -32001 : -32402,
                message: `${decision.reason}`,
                data: { creditsRequired: this.gate.getToolPrice(toolName, args, apiKey || undefined), remainingCredits: decision.remainingCredits },
              },
            };
          }
        }

        try {
          const result = await this.proxyHandler(toolName, args);
          return {
            jsonrpc: '2.0',
            id: request.id,
            result,
          };
        } catch (err: any) {
          return {
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32603, message: err.message || 'Internal error' },
          };
        }
      }

      default:
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32601,
            message: `Method not found: ${request.method}`,
          },
        };
    }
  }

  /**
   * Handle batch tool calls (RequestHandler interface).
   */
  async handleBatchRequest(
    calls: BatchToolCall[],
    batchId: string | number | undefined,
    apiKey: string | null,
    clientIp?: string,
    scopedTokenTools?: string[],
    countryCode?: string,
  ): Promise<JsonRpcResponse> {
    const results: Array<{ tool: string; result?: unknown; error?: unknown; creditsCharged: number }> = [];
    let totalCreditsCharged = 0;

    for (const call of calls) {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: `batch_${call.name}`,
        method: 'tools/call',
        params: { name: call.name, arguments: call.arguments },
      };
      const response = await this.handleRequest(request, apiKey, clientIp, scopedTokenTools, countryCode);
      const credits = this.gate ? this.gate.getToolPrice(call.name, call.arguments, apiKey || undefined) : 0;

      if (response.error) {
        results.push({ tool: call.name, error: response.error, creditsCharged: 0 });
      } else {
        results.push({ tool: call.name, result: response.result, creditsCharged: credits });
        totalCreditsCharged += credits;
      }
    }

    return {
      jsonrpc: '2.0',
      id: batchId,
      result: { results, totalCreditsCharged },
    };
  }

  /**
   * Stop the backend (no-op for OpenAPI backend — stateless).
   */
  async stop(): Promise<void> {
    this._isRunning = false;
  }

  /**
   * Get summary info about the spec.
   */
  getInfo(): {
    title: string;
    version: string;
    totalTools: number;
    byMethod: Record<string, number>;
    byTag: Record<string, number>;
  } {
    return {
      title: this.specInfo.title,
      version: this.specInfo.version,
      ...this.summary,
    };
  }
}
