/**
 * RequestPipelineManager — Configurable middleware pipeline for request processing.
 *
 * Define ordered middleware stages that process requests and responses.
 * Supports pre-processing (before tool call), post-processing (after),
 * error handling, conditional execution, and pipeline composition.
 *
 * @example
 * ```ts
 * const pipeline = new RequestPipelineManager();
 *
 * pipeline.addMiddleware({
 *   name: 'logger',
 *   stage: 'pre',
 *   handler: (ctx) => { ctx.metadata.logged = true; return ctx; },
 * });
 *
 * pipeline.addMiddleware({
 *   name: 'validator',
 *   stage: 'pre',
 *   priority: 10,
 *   handler: (ctx) => {
 *     if (!ctx.key) throw new Error('Key required');
 *     return ctx;
 *   },
 * });
 *
 * const result = pipeline.execute({
 *   tool: 'search',
 *   key: 'key_abc',
 *   params: { query: 'test' },
 * });
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type PipelineStage = 'pre' | 'post' | 'error';

export interface PipelineContext {
  tool: string;
  key?: string;
  params: Record<string, unknown>;
  metadata: Record<string, unknown>;
  /** Set by post-stage: the tool response. */
  response?: unknown;
  /** Set by error-stage: the error. */
  error?: Error;
  /** If true, pipeline stops and returns current context. */
  aborted: boolean;
  abortReason?: string;
  /** Timing info. */
  startTime: number;
  endTime?: number;
}

export interface MiddlewareHandler {
  (ctx: PipelineContext): PipelineContext | Promise<PipelineContext>;
}

export interface PipelineMiddleware {
  id: string;
  name: string;
  stage: PipelineStage;
  handler: MiddlewareHandler;
  /** Higher priority runs first. Default 0. */
  priority: number;
  enabled: boolean;
  /** Only run for these tools (empty = all). */
  tools: string[];
  /** Only run for these keys (empty = all). */
  keys: string[];
  createdAt: number;
}

export interface MiddlewareRegistration {
  name: string;
  stage: PipelineStage;
  handler: MiddlewareHandler;
  priority?: number;
  tools?: string[];
  keys?: string[];
}

export interface PipelineResult {
  context: PipelineContext;
  executedMiddleware: string[];
  errors: { middleware: string; error: string }[];
  durationMs: number;
}

export interface PipelineConfig {
  /** Continue processing on middleware error. Default true. */
  continueOnError?: boolean;
  /** Max middleware per stage. Default 50. */
  maxMiddlewarePerStage?: number;
}

export interface PipelineStats {
  totalMiddleware: number;
  preMiddleware: number;
  postMiddleware: number;
  errorMiddleware: number;
  totalExecutions: number;
  totalErrors: number;
  totalAborts: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class RequestPipelineManager {
  private middleware = new Map<string, PipelineMiddleware>();
  private counter = 0;
  private continueOnError: boolean;
  private maxPerStage: number;

  // Stats
  private totalExecutions = 0;
  private totalErrors = 0;
  private totalAborts = 0;

  constructor(config: PipelineConfig = {}) {
    this.continueOnError = config.continueOnError ?? true;
    this.maxPerStage = config.maxMiddlewarePerStage ?? 50;
  }

  // ── Middleware Management ─────────────────────────────────────────

  /** Add middleware to the pipeline. Returns the middleware ID. */
  addMiddleware(reg: MiddlewareRegistration): string {
    const id = `mw_${++this.counter}`;

    // Check stage limit
    const stageCount = [...this.middleware.values()].filter(m => m.stage === reg.stage).length;
    if (stageCount >= this.maxPerStage) {
      throw new Error(`Maximum middleware for stage "${reg.stage}" reached (${this.maxPerStage})`);
    }

    const mw: PipelineMiddleware = {
      id,
      name: reg.name,
      stage: reg.stage,
      handler: reg.handler,
      priority: reg.priority ?? 0,
      enabled: true,
      tools: reg.tools ?? [],
      keys: reg.keys ?? [],
      createdAt: Date.now(),
    };

    this.middleware.set(id, mw);
    return id;
  }

  /** Remove middleware. */
  removeMiddleware(id: string): boolean {
    return this.middleware.delete(id);
  }

  /** Enable/disable middleware. */
  setEnabled(id: string, enabled: boolean): boolean {
    const mw = this.middleware.get(id);
    if (!mw) return false;
    mw.enabled = enabled;
    return true;
  }

  /** Get middleware by ID. */
  getMiddleware(id: string): PipelineMiddleware | null {
    return this.middleware.get(id) ?? null;
  }

  /** List all middleware for a stage. */
  getStageMiddleware(stage: PipelineStage): PipelineMiddleware[] {
    return [...this.middleware.values()]
      .filter(m => m.stage === stage)
      .sort((a, b) => b.priority - a.priority);
  }

  /** List all middleware. */
  listMiddleware(): PipelineMiddleware[] {
    return [...this.middleware.values()].sort((a, b) => b.priority - a.priority);
  }

  // ── Execution ─────────────────────────────────────────────────────

  /** Execute the pre-processing pipeline. */
  executePre(input: { tool: string; key?: string; params: Record<string, unknown> }): PipelineResult {
    const ctx: PipelineContext = {
      tool: input.tool,
      key: input.key,
      params: { ...input.params },
      metadata: {},
      aborted: false,
      startTime: Date.now(),
    };

    return this.runStage('pre', ctx);
  }

  /** Execute the post-processing pipeline. */
  executePost(ctx: PipelineContext, response: unknown): PipelineResult {
    ctx.response = response;
    return this.runStage('post', ctx);
  }

  /** Execute the error-handling pipeline. */
  executeError(ctx: PipelineContext, error: Error): PipelineResult {
    ctx.error = error;
    return this.runStage('error', ctx);
  }

  /** Execute full pre+post pipeline (simulated — no actual tool call). */
  execute(input: { tool: string; key?: string; params: Record<string, unknown> }): PipelineResult {
    this.totalExecutions++;
    return this.executePre(input);
  }

  // ── Stats ─────────────────────────────────────────────────────────

  getStats(): PipelineStats {
    const all = [...this.middleware.values()];
    return {
      totalMiddleware: all.length,
      preMiddleware: all.filter(m => m.stage === 'pre').length,
      postMiddleware: all.filter(m => m.stage === 'post').length,
      errorMiddleware: all.filter(m => m.stage === 'error').length,
      totalExecutions: this.totalExecutions,
      totalErrors: this.totalErrors,
      totalAborts: this.totalAborts,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.middleware.clear();
    this.counter = 0;
    this.totalExecutions = 0;
    this.totalErrors = 0;
    this.totalAborts = 0;
  }

  // ── Private ───────────────────────────────────────────────────────

  private runStage(stage: PipelineStage, ctx: PipelineContext): PipelineResult {
    const startTime = Date.now();
    const executedMiddleware: string[] = [];
    const errors: { middleware: string; error: string }[] = [];

    const middleware = this.getStageMiddleware(stage).filter(m => m.enabled);

    for (const mw of middleware) {
      // Check tool filter
      if (mw.tools.length > 0 && !mw.tools.includes(ctx.tool)) continue;
      // Check key filter
      if (mw.keys.length > 0 && ctx.key && !mw.keys.includes(ctx.key)) continue;

      try {
        const result = mw.handler(ctx);
        // Handle sync result (we don't await async in this simple version)
        if (result && !(result instanceof Promise)) {
          ctx = result;
        }
        executedMiddleware.push(mw.name);
      } catch (err: unknown) {
        this.totalErrors++;
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push({ middleware: mw.name, error: errorMsg });

        if (!this.continueOnError) {
          ctx.aborted = true;
          ctx.abortReason = `Middleware "${mw.name}" error: ${errorMsg}`;
          this.totalAborts++;
          break;
        }
      }

      if (ctx.aborted) {
        this.totalAborts++;
        break;
      }
    }

    ctx.endTime = Date.now();

    return {
      context: ctx,
      executedMiddleware,
      errors,
      durationMs: Date.now() - startTime,
    };
  }
}
