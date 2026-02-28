/**
 * Gateway Hooks — Pre/post request lifecycle hooks for custom logic.
 *
 * Register named hooks that execute at different stages of the
 * request lifecycle: before gate evaluation (pre-gate), after gate
 * but before backend call (pre-backend), and after backend response
 * (post-backend). Hooks can modify requests, add metadata, or
 * short-circuit processing.
 *
 * @example
 * ```ts
 * const hooks = new GatewayHookManager();
 * hooks.configure({ enabled: true });
 *
 * hooks.registerHook({
 *   name: 'log-all-calls',
 *   stage: 'pre_gate',
 *   type: 'log',
 *   config: { message: 'Tool call received' },
 * });
 * ```
 */

import * as crypto from 'crypto';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type HookStage = 'pre_gate' | 'pre_backend' | 'post_backend';
export type HookType = 'log' | 'header_inject' | 'metadata_tag' | 'reject';
export type HookAction = 'continue' | 'reject' | 'skip';

export interface GatewayHook {
  id: string;
  name: string;
  stage: HookStage;
  type: HookType;
  priority: number;
  enabled: boolean;
  config: HookConfig;
  toolFilter?: string;
  keyFilter?: string;
  createdAt: string;
  updatedAt: string;
  executionCount: number;
}

export interface HookConfig {
  /** For log type: the message template */
  message?: string;
  /** For header_inject type: headers to add */
  headers?: Record<string, string>;
  /** For metadata_tag type: tags to add */
  tags?: Record<string, string>;
  /** For reject type: error message */
  rejectMessage?: string;
  /** For reject type: JSON-RPC error code */
  rejectCode?: number;
}

export interface HookCreateParams {
  name: string;
  stage: HookStage;
  type: HookType;
  priority?: number;
  enabled?: boolean;
  config: HookConfig;
  toolFilter?: string;
  keyFilter?: string;
}

export interface HookExecutionContext {
  apiKey: string;
  tool: string;
  requestId?: string;
  creditCost?: number;
  timestamp: string;
}

export interface HookExecutionResult {
  hookId: string;
  hookName: string;
  action: HookAction;
  metadata?: Record<string, string>;
  headers?: Record<string, string>;
  rejectMessage?: string;
  rejectCode?: number;
  durationMs: number;
}

export interface HookStageResult {
  stage: HookStage;
  hookResults: HookExecutionResult[];
  action: HookAction;
  totalDurationMs: number;
}

export interface GatewayHookStats {
  totalHooks: number;
  enabledHooks: number;
  totalExecutions: number;
  byStage: Record<HookStage, number>;
  byType: Record<HookType, number>;
}

export interface GatewayHookConfig {
  enabled: boolean;
  maxHooks: number;
  maxExecutionMs: number;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeId(): string {
  return 'ghk_' + crypto.randomBytes(8).toString('hex');
}

function matchesFilter(filter: string | undefined, value: string): boolean {
  if (!filter) return true;
  if (filter === '*') return true;
  if (filter.includes('*')) {
    const regex = new RegExp('^' + filter.replace(/\*/g, '.*') + '$');
    return regex.test(value);
  }
  return filter === value;
}

/* ------------------------------------------------------------------ */
/*  Manager                                                            */
/* ------------------------------------------------------------------ */

export class GatewayHookManager {
  private hooks = new Map<string, GatewayHook>();
  private config: GatewayHookConfig = {
    enabled: false,
    maxHooks: 200,
    maxExecutionMs: 5000,
  };

  /* ── Hook CRUD ─────────────────────────────────────────────────── */

  registerHook(params: HookCreateParams): GatewayHook {
    if (!this.config.enabled) throw new Error('Gateway hooks are disabled');
    if (this.hooks.size >= this.config.maxHooks) {
      throw new Error(`Maximum hooks reached (${this.config.maxHooks})`);
    }
    if (!params.name || !params.stage || !params.type) {
      throw new Error('name, stage, and type are required');
    }

    const VALID_STAGES: HookStage[] = ['pre_gate', 'pre_backend', 'post_backend'];
    const VALID_TYPES: HookType[] = ['log', 'header_inject', 'metadata_tag', 'reject'];
    if (!VALID_STAGES.includes(params.stage)) throw new Error(`Invalid stage: ${params.stage}`);
    if (!VALID_TYPES.includes(params.type)) throw new Error(`Invalid type: ${params.type}`);

    // Check duplicate name
    for (const h of this.hooks.values()) {
      if (h.name === params.name) throw new Error(`Hook name '${params.name}' already exists`);
    }

    const now = new Date().toISOString();
    const hook: GatewayHook = {
      id: makeId(),
      name: params.name,
      stage: params.stage,
      type: params.type,
      priority: params.priority ?? 100,
      enabled: params.enabled !== false,
      config: params.config,
      toolFilter: params.toolFilter,
      keyFilter: params.keyFilter,
      createdAt: now,
      updatedAt: now,
      executionCount: 0,
    };

    this.hooks.set(hook.id, hook);
    return hook;
  }

  getHook(id: string): GatewayHook | undefined {
    return this.hooks.get(id);
  }

  listHooks(filter?: { stage?: HookStage; type?: HookType; enabled?: boolean }): GatewayHook[] {
    let result = Array.from(this.hooks.values());
    if (filter?.stage) result = result.filter(h => h.stage === filter.stage);
    if (filter?.type) result = result.filter(h => h.type === filter.type);
    if (filter?.enabled !== undefined) result = result.filter(h => h.enabled === filter.enabled);
    return result.sort((a, b) => a.priority - b.priority);
  }

  updateHook(id: string, updates: Partial<Pick<GatewayHook, 'name' | 'priority' | 'enabled' | 'config' | 'toolFilter' | 'keyFilter'>>): GatewayHook {
    const hook = this.hooks.get(id);
    if (!hook) throw new Error(`Hook not found: ${id}`);

    if (updates.name !== undefined) {
      for (const h of this.hooks.values()) {
        if (h.id !== id && h.name === updates.name) {
          throw new Error(`Hook name '${updates.name}' already exists`);
        }
      }
      hook.name = updates.name;
    }
    if (updates.priority !== undefined) hook.priority = updates.priority;
    if (updates.enabled !== undefined) hook.enabled = updates.enabled;
    if (updates.config !== undefined) hook.config = updates.config;
    if (updates.toolFilter !== undefined) hook.toolFilter = updates.toolFilter;
    if (updates.keyFilter !== undefined) hook.keyFilter = updates.keyFilter;

    hook.updatedAt = new Date().toISOString();
    return hook;
  }

  deleteHook(id: string): boolean {
    return this.hooks.delete(id);
  }

  /* ── Execution ─────────────────────────────────────────────────── */

  executeStage(stage: HookStage, ctx: HookExecutionContext): HookStageResult {
    if (!this.config.enabled) {
      return { stage, hookResults: [], action: 'continue', totalDurationMs: 0 };
    }

    const stageHooks = Array.from(this.hooks.values())
      .filter(h => h.stage === stage && h.enabled)
      .filter(h => matchesFilter(h.toolFilter, ctx.tool))
      .filter(h => matchesFilter(h.keyFilter, ctx.apiKey))
      .sort((a, b) => a.priority - b.priority);

    const results: HookExecutionResult[] = [];
    let finalAction: HookAction = 'continue';
    const stageStart = Date.now();

    for (const hook of stageHooks) {
      const hookStart = Date.now();
      const result = this.executeHook(hook, ctx);
      result.durationMs = Date.now() - hookStart;
      results.push(result);
      hook.executionCount++;

      if (result.action === 'reject') {
        finalAction = 'reject';
        break; // Stop processing on reject
      }
    }

    return {
      stage,
      hookResults: results,
      action: finalAction,
      totalDurationMs: Date.now() - stageStart,
    };
  }

  private executeHook(hook: GatewayHook, ctx: HookExecutionContext): HookExecutionResult {
    const result: HookExecutionResult = {
      hookId: hook.id,
      hookName: hook.name,
      action: 'continue',
      durationMs: 0,
    };

    switch (hook.type) {
      case 'log':
        // Log hook just records metadata
        result.metadata = {
          message: hook.config.message ?? 'hook executed',
          tool: ctx.tool,
          apiKey: ctx.apiKey.substring(0, 8) + '...',
        };
        break;

      case 'header_inject':
        if (hook.config.headers) {
          result.headers = { ...hook.config.headers };
        }
        break;

      case 'metadata_tag':
        if (hook.config.tags) {
          result.metadata = { ...hook.config.tags };
        }
        break;

      case 'reject':
        result.action = 'reject';
        result.rejectMessage = hook.config.rejectMessage ?? 'Request rejected by gateway hook';
        result.rejectCode = hook.config.rejectCode ?? -32600;
        break;
    }

    return result;
  }

  /* ── Config & Stats ────────────────────────────────────────────── */

  configure(updates: Partial<GatewayHookConfig>): GatewayHookConfig {
    if (updates.enabled !== undefined) this.config.enabled = updates.enabled;
    if (updates.maxHooks !== undefined && updates.maxHooks > 0) this.config.maxHooks = updates.maxHooks;
    if (updates.maxExecutionMs !== undefined && updates.maxExecutionMs > 0) this.config.maxExecutionMs = updates.maxExecutionMs;
    return { ...this.config };
  }

  stats(): GatewayHookStats {
    const hooks = Array.from(this.hooks.values());
    const byStage: Record<HookStage, number> = { pre_gate: 0, pre_backend: 0, post_backend: 0 };
    const byType: Record<HookType, number> = { log: 0, header_inject: 0, metadata_tag: 0, reject: 0 };
    let totalExecutions = 0;
    let enabled = 0;

    for (const h of hooks) {
      byStage[h.stage]++;
      byType[h.type]++;
      totalExecutions += h.executionCount;
      if (h.enabled) enabled++;
    }

    return {
      totalHooks: hooks.length,
      enabledHooks: enabled,
      totalExecutions,
      byStage,
      byType,
    };
  }

  clear(): void {
    this.hooks.clear();
  }
}
