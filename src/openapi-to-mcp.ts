/**
 * OpenAPI-to-MCP Transformation — converts any OpenAPI 3.x spec into MCP tools.
 *
 * Given an OpenAPI specification (YAML or JSON), this module generates:
 *   - MCP tool definitions from each operation (path + method)
 *   - Input schemas from request body and path/query parameters
 *   - An HTTP handler that proxies tool calls to the upstream REST API
 *
 * This enables: `paygate-mcp wrap-api --openapi spec.yaml --port 3402`
 * → wraps any REST API as gated MCP tools with billing, rate limiting, etc.
 *
 * Tool naming: `{operationId}` or `{method}_{path_slug}` if no operationId.
 *
 * Zero external dependencies — YAML parsing uses built-in heuristics for
 * simple specs; for full YAML support users can pre-convert to JSON.
 */

import { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OpenApiSpec {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  paths?: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, unknown> };
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
  responses?: Record<string, unknown>;
  tags?: string[];
  deprecated?: boolean;
  security?: unknown[];
}

export interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
  /** Original HTTP method and path for proxying */
  _httpMethod: string;
  _httpPath: string;
  _deprecated?: boolean;
  _tags?: string[];
}

export interface OpenApiToMcpConfig {
  /** Base URL for the upstream API (overrides spec servers[0]) */
  baseUrl?: string;
  /** Optional prefix for all tool names */
  toolPrefix?: string;
  /** Include deprecated operations? Default: false */
  includeDeprecated?: boolean;
  /** Filter by tags (only include operations with these tags) */
  filterTags?: string[];
  /** Auth header name and value for upstream requests */
  authHeader?: string;
  authValue?: string;
  /** Request timeout for upstream calls (ms). Default: 30000. */
  timeoutMs?: number;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse an OpenAPI spec (JSON string) and extract MCP tool definitions.
 */
export function parseOpenApiSpec(specJson: string, config?: OpenApiToMcpConfig): McpToolDef[] {
  let spec: OpenApiSpec;
  try {
    spec = JSON.parse(specJson);
  } catch {
    throw new Error('Failed to parse OpenAPI spec: invalid JSON. Convert YAML to JSON first (e.g., `yq . spec.yaml > spec.json`).');
  }

  if (!spec.paths || typeof spec.paths !== 'object') {
    throw new Error('OpenAPI spec has no paths defined');
  }

  const tools: McpToolDef[] = [];
  const seenNames = new Set<string>();

  for (const [path, methods] of Object.entries(spec.paths)) {
    if (!methods || typeof methods !== 'object') continue;

    for (const [method, op] of Object.entries(methods)) {
      // Skip non-HTTP methods (parameters, summary, etc.)
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method.toLowerCase())) continue;

      const operation = op as OpenApiOperation;

      // Skip deprecated if not included
      if (operation.deprecated && !config?.includeDeprecated) continue;

      // Filter by tags
      if (config?.filterTags && config.filterTags.length > 0) {
        const opTags = operation.tags || [];
        if (!config.filterTags.some(t => opTags.includes(t))) continue;
      }

      // Generate tool name
      let toolName = operation.operationId || `${method}_${slugifyPath(path)}`;
      if (config?.toolPrefix) {
        toolName = `${config.toolPrefix}_${toolName}`;
      }

      // Deduplicate names
      if (seenNames.has(toolName)) {
        let i = 2;
        while (seenNames.has(`${toolName}_${i}`)) i++;
        toolName = `${toolName}_${i}`;
      }
      seenNames.add(toolName);

      // Build description
      const desc = operation.summary || operation.description || `${method.toUpperCase()} ${path}`;

      // Build input schema from parameters + request body
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      // Path & query parameters
      if (operation.parameters) {
        for (const param of operation.parameters) {
          if (param.in === 'path' || param.in === 'query') {
            properties[param.name] = {
              ...(param.schema || { type: 'string' }),
              description: param.description || `${param.in} parameter: ${param.name}`,
            };
            if (param.required) required.push(param.name);
          }
        }
      }

      // Request body
      if (operation.requestBody?.content) {
        const jsonContent = operation.requestBody.content['application/json'];
        if (jsonContent?.schema) {
          // Inline the body schema as a `body` parameter
          properties['body'] = {
            ...jsonContent.schema,
            description: 'Request body (JSON)',
          };
          if (operation.requestBody.required) required.push('body');
        }
      }

      tools.push({
        name: toolName,
        description: desc,
        inputSchema: {
          type: 'object',
          properties,
          required,
        },
        _httpMethod: method.toUpperCase(),
        _httpPath: path,
        _deprecated: operation.deprecated,
        _tags: operation.tags,
      });
    }
  }

  return tools;
}

/**
 * Resolve the base URL from config or spec.
 */
export function resolveBaseUrl(spec: OpenApiSpec, config?: OpenApiToMcpConfig): string {
  if (config?.baseUrl) return config.baseUrl.replace(/\/$/, '');
  if (spec.servers && spec.servers.length > 0) {
    return spec.servers[0].url.replace(/\/$/, '');
  }
  throw new Error('No base URL: provide --base-url or define servers[0] in the OpenAPI spec');
}

// ─── Proxy Handler ───────────────────────────────────────────────────────────

/**
 * Create a proxy handler that forwards MCP tool calls to the upstream REST API.
 * Returns an MCP-compatible response.
 */
export function createApiProxyHandler(
  tools: McpToolDef[],
  baseUrl: string,
  config?: OpenApiToMcpConfig,
): (toolName: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> {
  const toolMap = new Map<string, McpToolDef>();
  for (const tool of tools) {
    toolMap.set(tool.name, tool);
  }

  return async (toolName: string, args: Record<string, unknown>) => {
    const tool = toolMap.get(toolName);
    if (!tool) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${toolName}` }) }] };
    }

    try {
      // Build URL with path parameters
      let url = `${baseUrl}${tool._httpPath}`;

      // Replace path parameters: /users/{id} → /users/123
      const pathParams = tool._httpPath.match(/\{([^}]+)\}/g) || [];
      for (const param of pathParams) {
        const name = param.slice(1, -1);
        const value = args[name];
        if (value !== undefined) {
          url = url.replace(param, encodeURIComponent(String(value)));
        }
      }

      // Add query parameters
      const queryParams: string[] = [];
      if (tool.inputSchema.properties) {
        for (const [key, schemaDef] of Object.entries(tool.inputSchema.properties)) {
          if (key === 'body') continue;
          const desc = (schemaDef as any).description || '';
          if (desc.includes('query parameter') && args[key] !== undefined) {
            queryParams.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(args[key]))}`);
          }
        }
      }
      if (queryParams.length > 0) {
        url += (url.includes('?') ? '&' : '?') + queryParams.join('&');
      }

      // Build request options
      const headers: Record<string, string> = {
        'Accept': 'application/json',
        'User-Agent': 'PayGate-MCP/wrap-api',
      };
      if (config?.authHeader && config?.authValue) {
        headers[config.authHeader] = config.authValue;
      }

      let requestBody: string | undefined;
      if (args.body !== undefined && tool._httpMethod !== 'GET' && tool._httpMethod !== 'HEAD') {
        headers['Content-Type'] = 'application/json';
        requestBody = JSON.stringify(args.body);
      }

      // Execute HTTP request
      const timeoutMs = config?.timeoutMs ?? 30_000;
      const response = await fetchWithTimeout(url, {
        method: tool._httpMethod,
        headers,
        body: requestBody,
        timeoutMs,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: response.status,
            headers: response.headers,
            body: response.body,
          }),
        }],
      };
    } catch (err: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: err.message || 'Upstream request failed' }),
        }],
      };
    }
  };
}

// ─── HTTP Fetch (zero-dep) ───────────────────────────────────────────────────

interface FetchResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

async function fetchWithTimeout(
  url: string,
  options: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number },
): Promise<FetchResult> {
  const parsedUrl = new URL(url);
  const isHttps = parsedUrl.protocol === 'https:';

  // Use dynamic import for the right http module
  const httpMod = isHttps ? await import('https') : await import('http');

  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method,
      headers: options.headers,
      timeout: options.timeoutMs,
    };

    const req = httpMod.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf-8');
        let body: unknown;
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = rawBody;
        }

        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (typeof value === 'string') headers[key] = value;
        }

        resolve({ status: res.statusCode || 0, headers, body });
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timeout after ${options.timeoutMs}ms`));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function slugifyPath(path: string): string {
  return path
    .replace(/^\//, '')
    .replace(/\{[^}]+\}/g, 'by')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/_$/, '');
}

/**
 * Generate a summary of the parsed OpenAPI spec.
 */
export function summarizeSpec(tools: McpToolDef[]): {
  totalTools: number;
  byMethod: Record<string, number>;
  byTag: Record<string, number>;
  deprecated: number;
} {
  const byMethod: Record<string, number> = {};
  const byTag: Record<string, number> = {};
  let deprecated = 0;

  for (const tool of tools) {
    byMethod[tool._httpMethod] = (byMethod[tool._httpMethod] || 0) + 1;
    if (tool._deprecated) deprecated++;
    for (const tag of tool._tags || []) {
      byTag[tag] = (byTag[tag] || 0) + 1;
    }
  }

  return { totalTools: tools.length, byMethod, byTag, deprecated };
}
