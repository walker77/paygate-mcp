/**
 * Plugin System — Extensible middleware hooks for custom billing, auth,
 * pricing, logging, and request handling logic.
 *
 * Plugins register named hook functions that run at key points in the
 * request lifecycle:
 *
 *   Gate hooks (synchronous — hot path):
 *     - beforeGate:     Short-circuit gate evaluation (deny/allow early)
 *     - afterGate:      Modify gate decision after evaluation
 *     - onDeny:         Notification when a tool call is denied
 *     - transformPrice: Override tool pricing dynamically
 *
 *   Tool hooks (async — wraps proxy forward):
 *     - beforeToolCall: Modify request before forwarding to MCP server
 *     - afterToolCall:  Modify response after receiving from MCP server
 *
 *   HTTP hooks (async):
 *     - onRequest:      Handle custom HTTP endpoints before normal routing
 *
 *   Lifecycle hooks (async):
 *     - onStart:        Called when the server starts
 *     - onStop:         Called when the server stops
 *
 * Plugins run in registration order. Gate hooks are sync to avoid adding
 * latency to the critical billing path. Tool/HTTP/lifecycle hooks may be async.
 */

import { GateDecision, JsonRpcRequest, JsonRpcResponse, ApiKeyRecord } from './types';
import { IncomingMessage, ServerResponse } from 'http';

// ─── Plugin Context Types ─────────────────────────────────────────────────

/** Context passed to gate-level hooks. */
export interface PluginGateContext {
  /** The API key (null if missing) */
  apiKey: string | null;
  /** Tool being called */
  toolName: string;
  /** Tool call arguments */
  toolArgs?: Record<string, unknown>;
  /** Client IP address */
  clientIp?: string;
  /** Resolved API key record (null if key is invalid) */
  keyRecord?: ApiKeyRecord;
}

/** Context passed to tool-level hooks. */
export interface PluginToolContext {
  /** The API key */
  apiKey: string | null;
  /** Tool being called */
  toolName: string;
  /** Tool call arguments */
  toolArgs?: Record<string, unknown>;
  /** The JSON-RPC request being forwarded */
  request: JsonRpcRequest;
}

/** Result from a beforeGate hook that short-circuits the gate. */
export interface PluginGateOverride {
  /** Whether to allow or deny the tool call */
  allowed: boolean;
  /** Reason for the decision */
  reason?: string;
  /** Credits to charge (only when allowed=true). Default: 0 */
  creditsCharged?: number;
}

/** Plugin info returned by list(). */
export interface PluginInfo {
  name: string;
  version?: string;
  hooks: string[];
}

// ─── Plugin Interface ─────────────────────────────────────────────────────

export interface PayGatePlugin {
  /** Unique plugin name (required). */
  name: string;
  /** Plugin version (for discovery). */
  version?: string;

  // ─── Lifecycle hooks ──────────────────────────────────────────────

  /** Called when the server starts. */
  onStart?: () => void | Promise<void>;
  /** Called when the server stops. */
  onStop?: () => void | Promise<void>;

  // ─── Gate hooks (synchronous) ─────────────────────────────────────

  /**
   * Called before gate evaluation.
   * Return a PluginGateOverride to short-circuit (allow or deny without
   * normal checks). Return null to continue with normal evaluation.
   */
  beforeGate?: (context: PluginGateContext) => PluginGateOverride | null;

  /**
   * Called after gate evaluation.
   * Receives the context and the gate's decision. Return the (possibly
   * modified) decision. Plugins run in order and each sees the previous
   * plugin's output.
   */
  afterGate?: (context: PluginGateContext, decision: GateDecision) => GateDecision;

  /**
   * Called when a tool call is denied (fire-and-forget).
   * Useful for logging, monitoring, or alerting.
   */
  onDeny?: (context: PluginGateContext, reason: string) => void;

  /**
   * Override tool pricing dynamically.
   * Return the new price in credits, or null to use the default price.
   * First plugin to return non-null wins.
   */
  transformPrice?: (toolName: string, basePrice: number, args?: Record<string, unknown>) => number | null;

  // ─── Tool hooks (async) ───────────────────────────────────────────

  /**
   * Called before a tool call is forwarded to the MCP server.
   * Can modify the request. Return the (possibly modified) request.
   */
  beforeToolCall?: (context: PluginToolContext) => Promise<JsonRpcRequest> | JsonRpcRequest;

  /**
   * Called after a tool call response is received from the MCP server.
   * Can modify the response. Return the (possibly modified) response.
   */
  afterToolCall?: (context: PluginToolContext, response: JsonRpcResponse) => Promise<JsonRpcResponse> | JsonRpcResponse;

  // ─── HTTP hooks (async) ───────────────────────────────────────────

  /**
   * Called for each HTTP request before normal routing.
   * Return true if the request was handled (response already sent).
   * Return false to continue with normal routing.
   * Use this to add custom endpoints to the server.
   */
  onRequest?: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;
}

// ─── Plugin Manager ───────────────────────────────────────────────────────

export class PluginManager {
  private plugins: PayGatePlugin[] = [];

  /** Register a plugin. Plugins run in registration order. */
  register(plugin: PayGatePlugin): void {
    if (!plugin.name) {
      throw new Error('Plugin must have a name');
    }
    if (this.plugins.some(p => p.name === plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered`);
    }
    this.plugins.push(plugin);
  }

  /** Unregister a plugin by name. Returns true if found and removed. */
  unregister(name: string): boolean {
    const idx = this.plugins.findIndex(p => p.name === name);
    if (idx === -1) return false;
    this.plugins.splice(idx, 1);
    return true;
  }

  /** List all registered plugins with their hooks. */
  list(): PluginInfo[] {
    return this.plugins.map(p => ({
      name: p.name,
      version: p.version,
      hooks: this.getPluginHooks(p),
    }));
  }

  /** Number of registered plugins. */
  get count(): number {
    return this.plugins.length;
  }

  // ─── Gate Hook Execution (synchronous) ────────────────────────────

  /**
   * Execute beforeGate hooks in order.
   * First non-null result short-circuits the gate.
   */
  executeBeforeGate(context: PluginGateContext): PluginGateOverride | null {
    for (const plugin of this.plugins) {
      if (plugin.beforeGate) {
        try {
          const result = plugin.beforeGate(context);
          if (result !== null && result !== undefined) return result;
        } catch {
          // Plugin errors don't break the gate
        }
      }
    }
    return null;
  }

  /**
   * Execute afterGate hooks in order.
   * Each plugin can modify the decision; changes cascade through.
   */
  executeAfterGate(context: PluginGateContext, decision: GateDecision): GateDecision {
    let current = decision;
    for (const plugin of this.plugins) {
      if (plugin.afterGate) {
        try {
          current = plugin.afterGate(context, current);
        } catch {
          // Plugin errors don't break the gate
        }
      }
    }
    return current;
  }

  /**
   * Execute onDeny hooks (fire-and-forget).
   */
  executeOnDeny(context: PluginGateContext, reason: string): void {
    for (const plugin of this.plugins) {
      if (plugin.onDeny) {
        try {
          plugin.onDeny(context, reason);
        } catch {
          // Plugin errors don't break the flow
        }
      }
    }
  }

  /**
   * Execute transformPrice hooks. First non-null result wins.
   */
  executeTransformPrice(toolName: string, basePrice: number, args?: Record<string, unknown>): number {
    for (const plugin of this.plugins) {
      if (plugin.transformPrice) {
        try {
          const result = plugin.transformPrice(toolName, basePrice, args);
          if (result !== null && result !== undefined && typeof result === 'number') {
            return result;
          }
        } catch {
          // Plugin errors → fall through to default
        }
      }
    }
    return basePrice;
  }

  // ─── Tool Hook Execution (async) ──────────────────────────────────

  /**
   * Execute beforeToolCall hooks in order.
   * Each can modify the request; changes cascade.
   */
  async executeBeforeToolCall(context: PluginToolContext): Promise<JsonRpcRequest> {
    let req = context.request;
    for (const plugin of this.plugins) {
      if (plugin.beforeToolCall) {
        try {
          req = await plugin.beforeToolCall({ ...context, request: req });
        } catch {
          // Plugin errors → skip this hook
        }
      }
    }
    return req;
  }

  /**
   * Execute afterToolCall hooks in order.
   * Each can modify the response; changes cascade.
   */
  async executeAfterToolCall(context: PluginToolContext, response: JsonRpcResponse): Promise<JsonRpcResponse> {
    let res = response;
    for (const plugin of this.plugins) {
      if (plugin.afterToolCall) {
        try {
          res = await plugin.afterToolCall(context, res);
        } catch {
          // Plugin errors → skip this hook
        }
      }
    }
    return res;
  }

  // ─── HTTP Hook Execution (async) ──────────────────────────────────

  /**
   * Execute onRequest hooks. First handler returning true wins.
   */
  async executeOnRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    for (const plugin of this.plugins) {
      if (plugin.onRequest) {
        try {
          const handled = await plugin.onRequest(req, res);
          if (handled) return true;
        } catch {
          // Plugin errors → continue to next plugin
        }
      }
    }
    return false;
  }

  // ─── Lifecycle Hook Execution (async) ─────────────────────────────

  /**
   * Execute onStart hooks for all plugins.
   */
  async executeStart(): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.onStart) {
        await plugin.onStart();
      }
    }
  }

  /**
   * Execute onStop hooks for all plugins (in reverse order for clean teardown).
   */
  async executeStop(): Promise<void> {
    for (let i = this.plugins.length - 1; i >= 0; i--) {
      const plugin = this.plugins[i];
      if (plugin.onStop) {
        try {
          await plugin.onStop();
        } catch {
          // Best-effort teardown
        }
      }
    }
  }

  // ─── Private ──────────────────────────────────────────────────────

  private getPluginHooks(plugin: PayGatePlugin): string[] {
    const hooks: string[] = [];
    if (plugin.onStart) hooks.push('onStart');
    if (plugin.onStop) hooks.push('onStop');
    if (plugin.beforeGate) hooks.push('beforeGate');
    if (plugin.afterGate) hooks.push('afterGate');
    if (plugin.onDeny) hooks.push('onDeny');
    if (plugin.transformPrice) hooks.push('transformPrice');
    if (plugin.beforeToolCall) hooks.push('beforeToolCall');
    if (plugin.afterToolCall) hooks.push('afterToolCall');
    if (plugin.onRequest) hooks.push('onRequest');
    return hooks;
  }
}
