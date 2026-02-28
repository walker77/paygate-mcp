/**
 * Dynamic Tool Discovery — Reduces context window bloat by exposing
 * meta-tools instead of the full tool list.
 *
 * When enabled, `tools/list` returns 3 meta-tools:
 *   - paygate_list_tools   — List all available tools with pricing
 *   - paygate_search_tools — Search tools by keyword
 *   - paygate_call_tool    — Proxy a call to any backend tool
 *
 * This lets agents discover tools on-demand instead of loading N tool
 * schemas into context upfront. Inspired by Speakeasy's `--mode dynamic`.
 */

import { JsonRpcRequest, JsonRpcResponse, ToolPricing } from './types';

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface DynamicDiscoveryConfig {
  /** Default credits per tool call (for pricing display) */
  defaultCreditsPerCall: number;
  /** Per-tool pricing overrides */
  toolPricing: Record<string, ToolPricing>;
  /** Global rate limit per key */
  globalRateLimitPerMin: number;
}

/**
 * The 3 meta-tools exposed in dynamic discovery mode.
 */
export function getMetaTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return [
    {
      name: 'paygate_list_tools',
      description: 'List all available tools on this server with their descriptions, pricing, and rate limits. Use this to discover what tools are available before calling them.',
      inputSchema: {
        type: 'object',
        properties: {
          cursor: {
            type: 'string',
            description: 'Pagination cursor for large tool lists. Omit for first page.',
          },
          pageSize: {
            type: 'number',
            description: 'Number of tools per page. Default: 50. Max: 200.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'paygate_search_tools',
      description: 'Search for tools by keyword. Searches tool names and descriptions. Returns matching tools with their schemas.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query to match against tool names and descriptions.',
          },
          includeSchema: {
            type: 'boolean',
            description: 'Whether to include full input schemas in results. Default: false.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'paygate_call_tool',
      description: 'Call any available tool by name. Use paygate_list_tools or paygate_search_tools first to discover available tools and their required arguments.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The name of the tool to call.',
          },
          arguments: {
            type: 'object',
            description: 'Arguments to pass to the tool. Schema depends on the specific tool — use paygate_search_tools to discover the schema.',
            additionalProperties: true,
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  ];
}

/**
 * Check if a tool name is a meta-tool.
 */
export function isMetaTool(name: string): boolean {
  return name === 'paygate_list_tools' ||
         name === 'paygate_search_tools' ||
         name === 'paygate_call_tool';
}

/**
 * Handle a meta-tool call. Returns the result content or null if not a meta-tool.
 */
export function handleMetaToolCall(
  toolName: string,
  args: Record<string, unknown>,
  allTools: ToolInfo[],
  config: DynamicDiscoveryConfig,
): { content: Array<{ type: string; text: string }> } | null {
  switch (toolName) {
    case 'paygate_list_tools':
      return handleListTools(args, allTools, config);
    case 'paygate_search_tools':
      return handleSearchTools(args, allTools, config);
    default:
      return null;
  }
}

// ─── Internal Handlers ──────────────────────────────────────────────────────

function handleListTools(
  args: Record<string, unknown>,
  allTools: ToolInfo[],
  config: DynamicDiscoveryConfig,
): { content: Array<{ type: string; text: string }> } {
  const pageSize = Math.min(Math.max(1, Number(args.pageSize) || 50), 200);
  const cursorStr = String(args.cursor || '0');
  const offset = Math.max(0, parseInt(cursorStr, 10) || 0);

  const page = allTools.slice(offset, offset + pageSize);
  const hasMore = offset + pageSize < allTools.length;

  const toolEntries = page.map(tool => {
    const pricing = config.toolPricing[tool.name];
    const credits = pricing?.creditsPerCall ?? config.defaultCreditsPerCall;
    const rateLimit = pricing?.rateLimitPerMin ?? config.globalRateLimitPerMin;
    return {
      name: tool.name,
      description: tool.description || '(no description)',
      creditsPerCall: credits,
      rateLimitPerMin: rateLimit === 0 ? 'unlimited' : rateLimit,
    };
  });

  const result = {
    tools: toolEntries,
    total: allTools.length,
    offset,
    pageSize,
    ...(hasMore ? { nextCursor: String(offset + pageSize) } : {}),
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

function handleSearchTools(
  args: Record<string, unknown>,
  allTools: ToolInfo[],
  config: DynamicDiscoveryConfig,
): { content: Array<{ type: string; text: string }> } {
  const query = String(args.query || '').toLowerCase().trim();
  const includeSchema = args.includeSchema === true;

  if (!query) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'query is required', matches: [] }) }],
    };
  }

  const terms = query.split(/\s+/).filter(Boolean);

  // Score each tool by how many terms match name or description
  const scored = allTools
    .map(tool => {
      const nameLC = tool.name.toLowerCase();
      const descLC = (tool.description || '').toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (nameLC.includes(term)) score += 3; // name match scores higher
        if (descLC.includes(term)) score += 1;
      }
      return { tool, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20); // cap at 20 results

  const pricing = config.toolPricing;
  const matches = scored.map(({ tool }) => {
    const tp = pricing[tool.name];
    const result: Record<string, unknown> = {
      name: tool.name,
      description: tool.description || '(no description)',
      creditsPerCall: tp?.creditsPerCall ?? config.defaultCreditsPerCall,
      rateLimitPerMin: (tp?.rateLimitPerMin ?? config.globalRateLimitPerMin) || 'unlimited',
    };
    if (includeSchema && tool.inputSchema) {
      result.inputSchema = tool.inputSchema;
    }
    return result;
  });

  return {
    content: [{ type: 'text', text: JSON.stringify({ query, matches, total: matches.length }) }],
  };
}
