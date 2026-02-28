/**
 * Proxy-as-MCP-Server — Expose billing/management operations as MCP tools.
 *
 * Instead of only proxying tool calls to backend MCP servers, this module
 * exposes PayGate's own management capabilities as MCP tools that agents
 * can discover and invoke:
 *
 *   - paygate_get_balance: Check remaining credits
 *   - paygate_get_usage: Get usage analytics
 *   - paygate_list_tools: List available gated tools
 *   - paygate_get_pricing: Get pricing for a tool
 *   - paygate_get_rate_limit_status: Check rate limit headroom
 *   - paygate_get_quota_status: Check quota usage
 *   - paygate_estimate_cost: Estimate cost before calling
 *   - paygate_get_grants: List active credit grants
 *   - paygate_get_health: Get server health status
 *   - paygate_get_key_info: Get API key info
 *
 * This allows agents to make informed decisions about resource usage
 * without requiring separate admin API calls.
 *
 * Inspired by Zuplo's proxy-as-MCP-server pattern.
 *
 * Zero external dependencies.
 */

import { JsonRpcRequest, JsonRpcResponse, ToolInfo } from './types';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Function that resolves management data from PayGate internals. */
export type ManagementResolver = (toolName: string, args: Record<string, unknown>, apiKey: string) => Promise<unknown> | unknown;

export interface ProxyMcpTool {
  /** Tool name (always prefixed with paygate_). */
  name: string;
  /** Tool description. */
  description: string;
  /** JSON Schema for input arguments. */
  inputSchema: Record<string, unknown>;
  /** Whether this tool is enabled. Default: true. */
  enabled: boolean;
  /** The resolver function. */
  resolver: ManagementResolver;
}

export interface ProxyMcpServerConfig {
  /** Prefix for management tool names. Default: 'paygate'. */
  prefix?: string;
  /** Enable all management tools by default. Default: true. */
  enableAll?: boolean;
  /** Specific tools to enable (overrides enableAll if specified). */
  enabledTools?: string[];
  /** Specific tools to disable. */
  disabledTools?: string[];
}

export interface ProxyMcpStats {
  /** Total calls to management tools. */
  totalCalls: number;
  /** Calls per tool. */
  callsByTool: Record<string, number>;
  /** Total errors. */
  totalErrors: number;
}

// ─── Default Management Tools ────────────────────────────────────────────────

function createDefaultTools(prefix: string): Omit<ProxyMcpTool, 'resolver'>[] {
  return [
    {
      name: `${prefix}_get_balance`,
      description: `Check remaining credit balance for your API key. Returns current balance, total spent, and depletion estimate.`,
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      enabled: true,
    },
    {
      name: `${prefix}_get_usage`,
      description: `Get usage analytics for your API key. Returns call counts, credits spent, and per-tool breakdown.`,
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: ['hour', 'day', 'week', 'month'],
            description: 'Time period for usage data. Default: day.',
          },
        },
        required: [],
      },
      enabled: true,
    },
    {
      name: `${prefix}_list_tools`,
      description: `List all available gated tools with their names, descriptions, and pricing.`,
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      enabled: true,
    },
    {
      name: `${prefix}_get_pricing`,
      description: `Get detailed pricing information for a specific tool. Shows credits per call, rate limits, and any dynamic pricing rules.`,
      inputSchema: {
        type: 'object',
        properties: {
          tool: {
            type: 'string',
            description: 'Name of the tool to get pricing for.',
          },
        },
        required: ['tool'],
      },
      enabled: true,
    },
    {
      name: `${prefix}_get_rate_limit_status`,
      description: `Check current rate limit status for your API key. Returns remaining calls, reset time, and current usage percentage.`,
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      enabled: true,
    },
    {
      name: `${prefix}_get_quota_status`,
      description: `Check quota usage for your API key. Returns daily and monthly call/credit usage against limits.`,
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      enabled: true,
    },
    {
      name: `${prefix}_estimate_cost`,
      description: `Estimate the cost of calling a tool before actually calling it. Returns expected credits and whether you have sufficient balance.`,
      inputSchema: {
        type: 'object',
        properties: {
          tool: {
            type: 'string',
            description: 'Tool name to estimate cost for.',
          },
          inputSizeBytes: {
            type: 'number',
            description: 'Estimated input size in bytes (for dynamic pricing). Default: 0.',
          },
        },
        required: ['tool'],
      },
      enabled: true,
    },
    {
      name: `${prefix}_get_grants`,
      description: `List active credit grants for your API key. Shows grant names, balances, expiration dates, and consumption priority.`,
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      enabled: true,
    },
    {
      name: `${prefix}_get_health`,
      description: `Get server health status including uptime, backend connectivity, and system stats.`,
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      enabled: true,
    },
    {
      name: `${prefix}_get_key_info`,
      description: `Get information about your API key including name, creation date, tags, and active status. Sensitive fields are masked.`,
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
      enabled: true,
    },
  ];
}

// ─── Proxy MCP Server ────────────────────────────────────────────────────────

export class ProxyMcpServer {
  private tools: Map<string, ProxyMcpTool> = new Map();
  private prefix: string;
  private stats: ProxyMcpStats = {
    totalCalls: 0,
    callsByTool: {},
    totalErrors: 0,
  };

  constructor(config?: ProxyMcpServerConfig) {
    this.prefix = config?.prefix ?? 'paygate';
    const enableAll = config?.enableAll ?? true;
    const enabledSet = config?.enabledTools ? new Set(config.enabledTools) : null;
    const disabledSet = new Set(config?.disabledTools ?? []);

    // Register default tools
    for (const toolDef of createDefaultTools(this.prefix)) {
      const enabled = disabledSet.has(toolDef.name)
        ? false
        : enabledSet
          ? enabledSet.has(toolDef.name)
          : enableAll;

      this.tools.set(toolDef.name, {
        ...toolDef,
        enabled,
        resolver: async () => ({ message: `No resolver registered for ${toolDef.name}` }),
      });
    }
  }

  /**
   * Register a resolver for a management tool.
   * The resolver is called when an agent invokes the tool.
   */
  registerResolver(toolName: string, resolver: ManagementResolver): boolean {
    // Accept both prefixed and unprefixed names
    const fullName = toolName.startsWith(this.prefix + '_') ? toolName : `${this.prefix}_${toolName}`;
    const tool = this.tools.get(fullName);
    if (!tool) return false;
    tool.resolver = resolver;
    return true;
  }

  /**
   * Register a custom management tool.
   */
  registerTool(tool: ProxyMcpTool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Get MCP-compatible tool definitions for tools/list.
   */
  getToolDefinitions(): ToolInfo[] {
    const defs: ToolInfo[] = [];
    for (const tool of this.tools.values()) {
      if (!tool.enabled) continue;
      defs.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
    return defs;
  }

  /**
   * Check if a tool name is a management tool.
   */
  isManagementTool(toolName: string): boolean {
    return this.tools.has(toolName) && (this.tools.get(toolName)?.enabled ?? false);
  }

  /**
   * Get all registered tool names.
   */
  getToolNames(): string[] {
    return [...this.tools.keys()].filter(name => this.tools.get(name)?.enabled);
  }

  /**
   * Handle a tool call.
   *
   * @param toolName - The management tool being called
   * @param args - Tool arguments
   * @param apiKey - The calling API key (for resolvers to use)
   * @returns JSON-RPC response
   */
  async handleToolCall(toolName: string, args: Record<string, unknown>, apiKey: string): Promise<JsonRpcResponse> {
    const tool = this.tools.get(toolName);

    if (!tool || !tool.enabled) {
      return {
        jsonrpc: '2.0',
        error: { code: -32601, message: `Unknown management tool: ${toolName}` },
      };
    }

    this.stats.totalCalls++;
    this.stats.callsByTool[toolName] = (this.stats.callsByTool[toolName] ?? 0) + 1;

    try {
      const result = await tool.resolver(toolName, args, apiKey);
      return {
        jsonrpc: '2.0',
        result: {
          content: [{
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          }],
        },
      };
    } catch (err) {
      this.stats.totalErrors++;
      return {
        jsonrpc: '2.0',
        error: { code: -32603, message: `Management tool error: ${err instanceof Error ? err.message : String(err)}` },
      };
    }
  }

  /**
   * Enable/disable a tool.
   */
  setToolEnabled(toolName: string, enabled: boolean): boolean {
    const tool = this.tools.get(toolName);
    if (!tool) return false;
    tool.enabled = enabled;
    return true;
  }

  /**
   * Get stats.
   */
  getStats(): ProxyMcpStats {
    return {
      ...this.stats,
      callsByTool: { ...this.stats.callsByTool },
    };
  }

  /**
   * Destroy and release resources.
   */
  destroy(): void {
    this.tools.clear();
    this.stats = { totalCalls: 0, callsByTool: {}, totalErrors: 0 };
  }
}
