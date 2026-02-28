import { PolicyEngine } from '../src/policy-engine';

describe('PolicyEngine', () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine();
  });

  // ── Policy Management ─────────────────────────────────────────────

  it('adds a policy', () => {
    const p = engine.addPolicy({
      name: 'block_search',
      effect: 'deny',
      conditions: { tool: ['search'] },
    });
    expect(p.name).toBe('block_search');
    expect(p.effect).toBe('deny');
    expect(p.priority).toBe(0);
    expect(p.enabled).toBe(true);
  });

  it('rejects duplicate policy names', () => {
    engine.addPolicy({ name: 'a', effect: 'allow', conditions: {} });
    expect(() => engine.addPolicy({ name: 'a', effect: 'deny', conditions: {} })).toThrow('already exists');
  });

  it('rejects empty policy name', () => {
    expect(() => engine.addPolicy({ name: '', effect: 'allow', conditions: {} })).toThrow('required');
  });

  it('enforces max policies', () => {
    const small = new PolicyEngine({ maxPolicies: 2 });
    small.addPolicy({ name: 'a', effect: 'allow', conditions: {} });
    small.addPolicy({ name: 'b', effect: 'allow', conditions: {} });
    expect(() => small.addPolicy({ name: 'c', effect: 'allow', conditions: {} })).toThrow('Maximum');
  });

  it('lists policies sorted by priority', () => {
    engine.addPolicy({ name: 'low', effect: 'allow', conditions: {}, priority: 1 });
    engine.addPolicy({ name: 'high', effect: 'deny', conditions: {}, priority: 10 });
    const list = engine.listPolicies();
    expect(list[0].name).toBe('high');
    expect(list[1].name).toBe('low');
  });

  it('removes a policy', () => {
    engine.addPolicy({ name: 'x', effect: 'allow', conditions: {} });
    expect(engine.removePolicy('x')).toBe(true);
    expect(engine.getPolicyByName('x')).toBeNull();
  });

  it('enables/disables a policy', () => {
    engine.addPolicy({ name: 'x', effect: 'allow', conditions: {} });
    engine.setPolicyEnabled('x', false);
    const p = engine.getPolicyByName('x');
    expect(p!.enabled).toBe(false);
  });

  // ── Evaluation ────────────────────────────────────────────────────

  it('defaults to allow when no policies match', () => {
    const result = engine.evaluate({ tool: 'search' });
    expect(result.effect).toBe('allow');
    expect(result.matchedPolicy).toBeNull();
  });

  it('defaults to deny when configured', () => {
    const denyEngine = new PolicyEngine({ defaultEffect: 'deny' });
    const result = denyEngine.evaluate({ tool: 'search' });
    expect(result.effect).toBe('deny');
  });

  it('matches tool condition', () => {
    engine.addPolicy({ name: 'block_search', effect: 'deny', conditions: { tool: ['search'] } });
    expect(engine.evaluate({ tool: 'search' }).effect).toBe('deny');
    expect(engine.evaluate({ tool: 'other' }).effect).toBe('allow');
  });

  it('matches key condition', () => {
    engine.addPolicy({ name: 'vip_allow', effect: 'allow', conditions: { key: ['key_vip'] }, priority: 10 });
    engine.addPolicy({ name: 'block_all', effect: 'deny', conditions: {}, priority: 1 });
    expect(engine.evaluate({ key: 'key_vip' }).effect).toBe('allow');
    expect(engine.evaluate({ key: 'key_free' }).effect).toBe('deny');
  });

  it('matches IP condition', () => {
    engine.addPolicy({ name: 'block_ip', effect: 'deny', conditions: { ip: ['10.0.0.1'] } });
    expect(engine.evaluate({ ip: '10.0.0.1' }).effect).toBe('deny');
    expect(engine.evaluate({ ip: '10.0.0.2' }).effect).toBe('allow');
  });

  it('highest priority wins', () => {
    engine.addPolicy({ name: 'allow_vip', effect: 'allow', conditions: { key: ['k1'] }, priority: 20 });
    engine.addPolicy({ name: 'block_tool', effect: 'deny', conditions: { tool: ['search'] }, priority: 10 });
    const result = engine.evaluate({ tool: 'search', key: 'k1' });
    expect(result.effect).toBe('allow');
    expect(result.matchedPolicy).toBe('allow_vip');
  });

  it('disabled policies are skipped', () => {
    engine.addPolicy({ name: 'block', effect: 'deny', conditions: { tool: ['search'] }, enabled: false });
    expect(engine.evaluate({ tool: 'search' }).effect).toBe('allow');
  });

  it('isAllowed returns boolean', () => {
    engine.addPolicy({ name: 'block', effect: 'deny', conditions: { tool: ['x'] } });
    expect(engine.isAllowed({ tool: 'x' })).toBe(false);
    expect(engine.isAllowed({ tool: 'y' })).toBe(true);
  });

  it('matches time range conditions', () => {
    engine.addPolicy({
      name: 'after_policy',
      effect: 'deny',
      conditions: { after: '2030-01-01T00:00:00Z' },
    });
    // Current time is before 2030
    expect(engine.evaluate({ timestamp: Date.now() }).effect).toBe('allow');
    // Simulate future timestamp
    expect(engine.evaluate({ timestamp: new Date('2031-01-01').getTime() }).effect).toBe('deny');
  });

  it('reports all matched policies', () => {
    engine.addPolicy({ name: 'a', effect: 'deny', conditions: {}, priority: 10 });
    engine.addPolicy({ name: 'b', effect: 'allow', conditions: {}, priority: 5 });
    const result = engine.evaluate({ tool: 'x' });
    expect(result.matchedPolicies).toContain('a');
    expect(result.matchedPolicies).toContain('b');
  });

  // ── History ───────────────────────────────────────────────────────

  it('records evaluation history', () => {
    engine.evaluate({ tool: 'a' });
    engine.evaluate({ tool: 'b' });
    expect(engine.getEvaluationHistory()).toHaveLength(2);
  });

  // ── Stats ─────────────────────────────────────────────────────────

  it('tracks stats', () => {
    engine.addPolicy({ name: 'block', effect: 'deny', conditions: { tool: ['x'] } });
    engine.evaluate({ tool: 'x' });
    engine.evaluate({ tool: 'y' });
    const stats = engine.getStats();
    expect(stats.totalPolicies).toBe(1);
    expect(stats.denyPolicies).toBe(1);
    expect(stats.totalEvaluations).toBe(2);
    expect(stats.totalDenied).toBe(1);
    expect(stats.totalAllowed).toBe(1);
  });

  // ── Destroy ───────────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    engine.addPolicy({ name: 'x', effect: 'allow', conditions: {} });
    engine.evaluate({});
    engine.destroy();
    expect(engine.getStats().totalPolicies).toBe(0);
    expect(engine.getStats().totalEvaluations).toBe(0);
  });
});
