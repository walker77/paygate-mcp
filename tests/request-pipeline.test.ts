import { RequestPipelineManager } from '../src/request-pipeline';

describe('RequestPipelineManager', () => {
  let pipeline: RequestPipelineManager;

  beforeEach(() => {
    pipeline = new RequestPipelineManager();
  });

  // ── Middleware Management ──────────────────────────────────────

  it('adds middleware and returns ID', () => {
    const id = pipeline.addMiddleware({
      name: 'logger',
      stage: 'pre',
      handler: (ctx) => ctx,
    });
    expect(id).toMatch(/^mw_/);
  });

  it('lists middleware sorted by priority', () => {
    pipeline.addMiddleware({ name: 'low', stage: 'pre', handler: (c) => c, priority: 1 });
    pipeline.addMiddleware({ name: 'high', stage: 'pre', handler: (c) => c, priority: 10 });
    pipeline.addMiddleware({ name: 'mid', stage: 'pre', handler: (c) => c, priority: 5 });
    const mws = pipeline.getStageMiddleware('pre');
    expect(mws[0].name).toBe('high');
    expect(mws[1].name).toBe('mid');
    expect(mws[2].name).toBe('low');
  });

  it('removes middleware', () => {
    const id = pipeline.addMiddleware({ name: 'test', stage: 'pre', handler: (c) => c });
    expect(pipeline.removeMiddleware(id)).toBe(true);
    expect(pipeline.getMiddleware(id)).toBeNull();
  });

  it('enables and disables middleware', () => {
    const id = pipeline.addMiddleware({ name: 'test', stage: 'pre', handler: (c) => c });
    pipeline.setEnabled(id, false);
    expect(pipeline.getMiddleware(id)!.enabled).toBe(false);
  });

  it('enforces max middleware per stage', () => {
    const p = new RequestPipelineManager({ maxMiddlewarePerStage: 2 });
    p.addMiddleware({ name: 'a', stage: 'pre', handler: (c) => c });
    p.addMiddleware({ name: 'b', stage: 'pre', handler: (c) => c });
    expect(() => p.addMiddleware({ name: 'c', stage: 'pre', handler: (c) => c }))
      .toThrow('Maximum');
    p.destroy();
  });

  // ── Pre-Processing ────────────────────────────────────────────

  it('executes pre-stage middleware in priority order', () => {
    const order: string[] = [];
    pipeline.addMiddleware({
      name: 'first',
      stage: 'pre',
      priority: 10,
      handler: (ctx) => { order.push('first'); return ctx; },
    });
    pipeline.addMiddleware({
      name: 'second',
      stage: 'pre',
      priority: 1,
      handler: (ctx) => { order.push('second'); return ctx; },
    });

    pipeline.executePre({ tool: 'search', params: {} });
    expect(order).toEqual(['first', 'second']);
  });

  it('middleware can modify context', () => {
    pipeline.addMiddleware({
      name: 'tagger',
      stage: 'pre',
      handler: (ctx) => { ctx.metadata.tagged = true; return ctx; },
    });

    const result = pipeline.executePre({ tool: 'search', params: {} });
    expect(result.context.metadata.tagged).toBe(true);
  });

  it('skips disabled middleware', () => {
    const id = pipeline.addMiddleware({
      name: 'disabled',
      stage: 'pre',
      handler: (ctx) => { ctx.metadata.ran = true; return ctx; },
    });
    pipeline.setEnabled(id, false);

    const result = pipeline.executePre({ tool: 'search', params: {} });
    expect(result.context.metadata.ran).toBeUndefined();
    expect(result.executedMiddleware).toHaveLength(0);
  });

  // ── Tool/Key Filtering ────────────────────────────────────────

  it('filters by tool', () => {
    pipeline.addMiddleware({
      name: 'search-only',
      stage: 'pre',
      tools: ['search'],
      handler: (ctx) => { ctx.metadata.filtered = true; return ctx; },
    });

    const r1 = pipeline.executePre({ tool: 'search', params: {} });
    expect(r1.context.metadata.filtered).toBe(true);

    const r2 = pipeline.executePre({ tool: 'other', params: {} });
    expect(r2.context.metadata.filtered).toBeUndefined();
  });

  it('filters by key', () => {
    pipeline.addMiddleware({
      name: 'key-specific',
      stage: 'pre',
      keys: ['key_vip'],
      handler: (ctx) => { ctx.metadata.vip = true; return ctx; },
    });

    const r1 = pipeline.executePre({ tool: 'search', key: 'key_vip', params: {} });
    expect(r1.context.metadata.vip).toBe(true);

    const r2 = pipeline.executePre({ tool: 'search', key: 'key_other', params: {} });
    expect(r2.context.metadata.vip).toBeUndefined();
  });

  // ── Error Handling ────────────────────────────────────────────

  it('continues on error by default', () => {
    pipeline.addMiddleware({
      name: 'faulty',
      stage: 'pre',
      priority: 10,
      handler: () => { throw new Error('boom'); },
    });
    pipeline.addMiddleware({
      name: 'survivor',
      stage: 'pre',
      priority: 1,
      handler: (ctx) => { ctx.metadata.survived = true; return ctx; },
    });

    const result = pipeline.executePre({ tool: 'search', params: {} });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].middleware).toBe('faulty');
    expect(result.context.metadata.survived).toBe(true);
  });

  it('stops on error when configured', () => {
    const p = new RequestPipelineManager({ continueOnError: false });
    p.addMiddleware({
      name: 'faulty',
      stage: 'pre',
      priority: 10,
      handler: () => { throw new Error('stop'); },
    });
    p.addMiddleware({
      name: 'never-runs',
      stage: 'pre',
      priority: 1,
      handler: (ctx) => { ctx.metadata.ran = true; return ctx; },
    });

    const result = p.executePre({ tool: 'search', params: {} });
    expect(result.context.aborted).toBe(true);
    expect(result.context.metadata.ran).toBeUndefined();
    p.destroy();
  });

  // ── Abort ─────────────────────────────────────────────────────

  it('middleware can abort pipeline', () => {
    pipeline.addMiddleware({
      name: 'gatekeeper',
      stage: 'pre',
      priority: 10,
      handler: (ctx) => { ctx.aborted = true; ctx.abortReason = 'denied'; return ctx; },
    });
    pipeline.addMiddleware({
      name: 'should-not-run',
      stage: 'pre',
      priority: 1,
      handler: (ctx) => { ctx.metadata.ran = true; return ctx; },
    });

    const result = pipeline.executePre({ tool: 'search', params: {} });
    expect(result.context.aborted).toBe(true);
    expect(result.context.abortReason).toBe('denied');
    expect(result.context.metadata.ran).toBeUndefined();
  });

  // ── Post-Processing ───────────────────────────────────────────

  it('executes post-stage with response', () => {
    pipeline.addMiddleware({
      name: 'enricher',
      stage: 'post',
      handler: (ctx) => { ctx.metadata.enriched = true; return ctx; },
    });

    const preResult = pipeline.executePre({ tool: 'search', params: {} });
    const postResult = pipeline.executePost(preResult.context, { data: 'result' });
    expect(postResult.context.response).toEqual({ data: 'result' });
    expect(postResult.context.metadata.enriched).toBe(true);
  });

  // ── Error Stage ───────────────────────────────────────────────

  it('executes error-stage with error', () => {
    pipeline.addMiddleware({
      name: 'error-handler',
      stage: 'error',
      handler: (ctx) => { ctx.metadata.handled = true; return ctx; },
    });

    const preResult = pipeline.executePre({ tool: 'search', params: {} });
    const errResult = pipeline.executeError(preResult.context, new Error('test'));
    expect(errResult.context.error!.message).toBe('test');
    expect(errResult.context.metadata.handled).toBe(true);
  });

  // ── Execute (Full) ────────────────────────────────────────────

  it('execute runs pre-processing and tracks executions', () => {
    pipeline.addMiddleware({
      name: 'counter',
      stage: 'pre',
      handler: (ctx) => { ctx.metadata.counted = true; return ctx; },
    });

    pipeline.execute({ tool: 'search', params: {} });
    expect(pipeline.getStats().totalExecutions).toBe(1);
  });

  // ── Duration ──────────────────────────────────────────────────

  it('measures duration', () => {
    pipeline.addMiddleware({
      name: 'simple',
      stage: 'pre',
      handler: (ctx) => ctx,
    });

    const result = pipeline.executePre({ tool: 'search', params: {} });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.context.startTime).toEqual(expect.any(Number));
    expect(result.context.endTime).toEqual(expect.any(Number));
  });

  // ── Stats ─────────────────────────────────────────────────────

  it('tracks stats', () => {
    pipeline.addMiddleware({ name: 'pre1', stage: 'pre', handler: (c) => c });
    pipeline.addMiddleware({ name: 'post1', stage: 'post', handler: (c) => c });
    pipeline.addMiddleware({ name: 'err1', stage: 'error', handler: (c) => c });
    pipeline.execute({ tool: 'search', params: {} });

    const stats = pipeline.getStats();
    expect(stats.totalMiddleware).toBe(3);
    expect(stats.preMiddleware).toBe(1);
    expect(stats.postMiddleware).toBe(1);
    expect(stats.errorMiddleware).toBe(1);
    expect(stats.totalExecutions).toBe(1);
  });

  // ── Destroy ───────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    pipeline.addMiddleware({ name: 'test', stage: 'pre', handler: (c) => c });
    pipeline.destroy();
    expect(pipeline.getStats().totalMiddleware).toBe(0);
  });
});
