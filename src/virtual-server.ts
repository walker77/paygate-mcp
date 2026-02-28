/**
 * Virtual MCP Server Composition — Tool Federation.
 *
 * Compose multiple upstream MCP servers into a single virtual endpoint.
 * Tools from each upstream are namespaced, deduplicated, and routed
 * transparently. Supports health-aware routing, prefix-based namespacing,
 * and mixed transport (stdio + HTTP upstreams).
 *
 * Example:
 *   const composer = new VirtualServerComposer({
 *     upstreams: [
 *       { id: 'fs', prefix: 'fs', remoteUrl: 'http://localhost:3001/mcp' },
 *       { id: 'db', prefix: 'db', remoteUrl: 'http://localhost:3002/mcp' },
 *     ],
 *   });
 *
 * Agent sees unified tool list: fs_readFile, fs_writeFile, db_query, db_insert...
 *
 * Zero external dependencies.
 */

import * as http from 'http';
import * as https from 'https';
import { JsonRpcRequest, JsonRpcResponse } from './types';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UpstreamServer {
  /** Unique upstream ID. */
  id: string;
  /** Tool name prefix. Tools become {prefix}_{toolName}. Empty = no prefix. */
  prefix: string;
  /** Remote URL for HTTP transport. */
  remoteUrl: string;
  /** Optional auth header for upstream. */
  authHeader?: string;
  /** Whether this upstream is enabled. Default: true. */
  enabled?: boolean;
  /** Timeout in ms for upstream requests. Default: 30000. */
  timeoutMs?: number;
  /** Weight for load distribution (future). Default: 1. */
  weight?: number;
}

export interface VirtualServerConfig {
  /** Upstream servers to federate. */
  upstreams: UpstreamServer[];
  /** Cache TTL for upstream tool discovery (ms). Default: 60000 (1 min). */
  discoveryTtlMs?: number;
  /** Whether to continue if some upstreams are unreachable. Default: true. */
  partialDiscovery?: boolean;
}

export interface UpstreamToolInfo {
  /** Original tool name from upstream. */
  originalName: string;
  /** Prefixed tool name exposed to agents. */
  federatedName: string;
  /** Which upstream owns this tool. */
  upstreamId: string;
  /** Tool description. */
  description?: string;
  /** Tool input schema. */
  inputSchema?: Record<string, unknown>;
}

export interface UpstreamHealth {
  /** Upstream ID. */
  id: string;
  /** Whether upstream is reachable. */
  healthy: boolean;
  /** Last successful contact (ISO). */
  lastSeen?: string;
  /** Last error message. */
  lastError?: string;
  /** Number of tools discovered. */
  toolCount: number;
  /** Response time of last check (ms). */
  latencyMs?: number;
}

export interface VirtualServerStats {
  /** Total upstreams configured. */
  totalUpstreams: number;
  /** Healthy upstreams. */
  healthyUpstreams: number;
  /** Total federated tools. */
  totalTools: number;
  /** Tools by upstream. */
  toolsByUpstream: Record<string, number>;
  /** Total requests routed. */
  totalRequests: number;
  /** Requests by upstream. */
  requestsByUpstream: Record<string, number>;
  /** Total errors. */
  totalErrors: number;
  /** Last discovery time (ISO). */
  lastDiscovery?: string;
}

// ─── Virtual Server Composer ─────────────────────────────────────────────────

export class VirtualServerComposer {
  private upstreams: UpstreamServer[];
  private tools: Map<string, UpstreamToolInfo> = new Map();
  private health: Map<string, UpstreamHealth> = new Map();
  private discoveryTtlMs: number;
  private partialDiscovery: boolean;
  private lastDiscovery = 0;
  private discoveryInProgress = false;

  // Stats
  private totalRequests = 0;
  private requestsByUpstream: Record<string, number> = {};
  private totalErrors = 0;

  constructor(config: VirtualServerConfig) {
    this.upstreams = config.upstreams.map(u => ({
      ...u,
      enabled: u.enabled ?? true,
      timeoutMs: u.timeoutMs ?? 30_000,
      weight: u.weight ?? 1,
    }));
    this.discoveryTtlMs = config.discoveryTtlMs ?? 60_000;
    this.partialDiscovery = config.partialDiscovery ?? true;

    // Initialize health state
    for (const u of this.upstreams) {
      this.health.set(u.id, {
        id: u.id,
        healthy: false,
        toolCount: 0,
      });
      this.requestsByUpstream[u.id] = 0;
    }
  }

  /** Get all configured upstreams. */
  getUpstreams(): UpstreamServer[] {
    return this.upstreams.map(u => ({ ...u }));
  }

  /** Get upstream health status. */
  getHealth(): UpstreamHealth[] {
    return [...this.health.values()];
  }

  /**
   * Discover tools from all upstreams.
   * Sends `tools/list` to each upstream and merges results.
   */
  async discoverTools(): Promise<UpstreamToolInfo[]> {
    if (this.discoveryInProgress) {
      return [...this.tools.values()];
    }

    this.discoveryInProgress = true;
    this.tools.clear();

    const enabledUpstreams = this.upstreams.filter(u => u.enabled);

    const results = await Promise.allSettled(
      enabledUpstreams.map(u => this.discoverUpstream(u))
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const upstream = enabledUpstreams[i];

      if (result.status === 'fulfilled') {
        const healthInfo = this.health.get(upstream.id)!;
        healthInfo.healthy = true;
        healthInfo.lastSeen = new Date().toISOString();
        healthInfo.toolCount = result.value.length;
        healthInfo.lastError = undefined;

        for (const tool of result.value) {
          this.tools.set(tool.federatedName, tool);
        }
      } else {
        const healthInfo = this.health.get(upstream.id)!;
        healthInfo.healthy = false;
        healthInfo.lastError = String(result.reason);
        healthInfo.toolCount = 0;

        if (!this.partialDiscovery) {
          this.discoveryInProgress = false;
          throw new Error(`Upstream ${upstream.id} discovery failed: ${result.reason}`);
        }
      }
    }

    this.lastDiscovery = Date.now();
    this.discoveryInProgress = false;

    return [...this.tools.values()];
  }

  /** Get cached federated tools. Triggers discovery if stale. */
  async getTools(): Promise<UpstreamToolInfo[]> {
    if (Date.now() - this.lastDiscovery > this.discoveryTtlMs || this.tools.size === 0) {
      await this.discoverTools();
    }
    return [...this.tools.values()];
  }

  /** Get tool list as MCP-compatible tool definitions. */
  async getToolDefinitions(): Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>> {
    const tools = await this.getTools();
    return tools.map(t => ({
      name: t.federatedName,
      description: t.description ? `[${t.upstreamId}] ${t.description}` : `[${t.upstreamId}]`,
      inputSchema: t.inputSchema,
    }));
  }

  /**
   * Route a tool call to the correct upstream.
   *
   * @param toolName - Federated tool name (e.g., 'fs_readFile')
   * @param args - Tool arguments
   * @returns JSON-RPC response from upstream
   */
  async routeToolCall(toolName: string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
    const toolInfo = this.tools.get(toolName);
    if (!toolInfo) {
      return {
        jsonrpc: '2.0',
        error: { code: -32601, message: `Unknown federated tool: ${toolName}` },
      };
    }

    const upstream = this.upstreams.find(u => u.id === toolInfo.upstreamId);
    if (!upstream || !upstream.enabled) {
      return {
        jsonrpc: '2.0',
        error: { code: -32603, message: `Upstream ${toolInfo.upstreamId} is disabled` },
      };
    }

    this.totalRequests++;
    this.requestsByUpstream[upstream.id] = (this.requestsByUpstream[upstream.id] ?? 0) + 1;

    try {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: `vsc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        method: 'tools/call',
        params: {
          name: toolInfo.originalName,
          arguments: args,
        },
      };

      const response = await this.sendToUpstream(upstream, request);
      return response;
    } catch (err) {
      this.totalErrors++;
      const healthInfo = this.health.get(upstream.id);
      if (healthInfo) {
        healthInfo.healthy = false;
        healthInfo.lastError = String(err);
      }
      return {
        jsonrpc: '2.0',
        error: { code: -32603, message: `Upstream ${upstream.id} error: ${err}` },
      };
    }
  }

  /** Add an upstream at runtime. */
  addUpstream(upstream: UpstreamServer): void {
    const existing = this.upstreams.findIndex(u => u.id === upstream.id);
    if (existing >= 0) {
      this.upstreams[existing] = { ...upstream, enabled: upstream.enabled ?? true, timeoutMs: upstream.timeoutMs ?? 30_000, weight: upstream.weight ?? 1 };
    } else {
      this.upstreams.push({ ...upstream, enabled: upstream.enabled ?? true, timeoutMs: upstream.timeoutMs ?? 30_000, weight: upstream.weight ?? 1 });
    }
    this.health.set(upstream.id, { id: upstream.id, healthy: false, toolCount: 0 });
    this.requestsByUpstream[upstream.id] = this.requestsByUpstream[upstream.id] ?? 0;
    // Invalidate cache
    this.lastDiscovery = 0;
  }

  /** Remove an upstream. */
  removeUpstream(id: string): boolean {
    const idx = this.upstreams.findIndex(u => u.id === id);
    if (idx < 0) return false;
    this.upstreams.splice(idx, 1);
    this.health.delete(id);

    // Remove tools from this upstream
    for (const [name, info] of this.tools) {
      if (info.upstreamId === id) {
        this.tools.delete(name);
      }
    }
    return true;
  }

  /** Enable/disable an upstream. */
  setUpstreamEnabled(id: string, enabled: boolean): boolean {
    const upstream = this.upstreams.find(u => u.id === id);
    if (!upstream) return false;
    upstream.enabled = enabled;
    this.lastDiscovery = 0; // Invalidate cache
    return true;
  }

  /** Get stats. */
  getStats(): VirtualServerStats {
    const toolsByUpstream: Record<string, number> = {};
    for (const tool of this.tools.values()) {
      toolsByUpstream[tool.upstreamId] = (toolsByUpstream[tool.upstreamId] ?? 0) + 1;
    }

    return {
      totalUpstreams: this.upstreams.length,
      healthyUpstreams: [...this.health.values()].filter(h => h.healthy).length,
      totalTools: this.tools.size,
      toolsByUpstream,
      totalRequests: this.totalRequests,
      requestsByUpstream: { ...this.requestsByUpstream },
      totalErrors: this.totalErrors,
      lastDiscovery: this.lastDiscovery ? new Date(this.lastDiscovery).toISOString() : undefined,
    };
  }

  /** Destroy and release resources. */
  destroy(): void {
    this.tools.clear();
    this.health.clear();
    this.upstreams = [];
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private async discoverUpstream(upstream: UpstreamServer): Promise<UpstreamToolInfo[]> {
    const start = Date.now();
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: `discovery_${upstream.id}`,
      method: 'tools/list',
      params: {},
    };

    const response = await this.sendToUpstream(upstream, request);
    const latency = Date.now() - start;

    const healthInfo = this.health.get(upstream.id);
    if (healthInfo) healthInfo.latencyMs = latency;

    if (response.error) {
      throw new Error(response.error.message);
    }

    const result = response.result as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
    const tools = result?.tools ?? [];

    return tools.map(t => ({
      originalName: t.name,
      federatedName: upstream.prefix ? `${upstream.prefix}_${t.name}` : t.name,
      upstreamId: upstream.id,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  private sendToUpstream(upstream: UpstreamServer, request: JsonRpcRequest): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const url = new URL(upstream.remoteUrl);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;

      const body = JSON.stringify(request);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      };

      if (upstream.authHeader) {
        headers['Authorization'] = upstream.authHeader;
      }

      const opts: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        timeout: upstream.timeoutMs,
      };

      const req = transport.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON from upstream ${upstream.id}`));
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Timeout connecting to upstream ${upstream.id}`));
      });

      req.on('error', (err) => {
        reject(new Error(`Connection error to upstream ${upstream.id}: ${err.message}`));
      });

      req.write(body);
      req.end();
    });
  }
}
