import { ToolRateLimiter } from '../src/tool-rate-limiter';

describe('ToolRateLimiter', () => {
  let limiter: ToolRateLimiter;

  beforeEach(() => {
    limiter = new ToolRateLimiter({ defaultMaxCalls: 60, defaultWindowSeconds: 60 });
  });

  afterEach(() => {
    limiter.destroy();
  });

  // ─── Rule Management ────────────────────────────────────────────

  test('upsert and retrieve a rule', () => {
    const ok = limiter.upsertRule({ tool: 'generate_text', maxCalls: 10, windowSeconds: 60, active: true, description: 'Expensive AI tool' });
    expect(ok).toBe(true);
    const rule = limiter.getRule('generate_text');
    expect(rule).toBeTruthy();
    expect(rule!.maxCalls).toBe(10);
  });

  test('list all rules', () => {
    limiter.upsertRule({ tool: 'a', maxCalls: 10, windowSeconds: 60, active: true });
    limiter.upsertRule({ tool: 'b', maxCalls: 100, windowSeconds: 60, active: true });
    expect(limiter.getRules().length).toBe(2);
  });

  test('remove a rule', () => {
    limiter.upsertRule({ tool: 'del', maxCalls: 10, windowSeconds: 60, active: true });
    expect(limiter.removeRule('del')).toBe(true);
    expect(limiter.getRule('del')).toBeNull();
  });

  test('reject invalid rule', () => {
    expect(limiter.upsertRule({ tool: 'bad', maxCalls: -1, windowSeconds: 60, active: true })).toBe(false);
    expect(limiter.upsertRule({ tool: 'bad', maxCalls: 10, windowSeconds: 0, active: true })).toBe(false);
  });

  test('enforce max rules', () => {
    const small = new ToolRateLimiter({ maxRules: 2 });
    small.upsertRule({ tool: 'a', maxCalls: 10, windowSeconds: 60, active: true });
    small.upsertRule({ tool: 'b', maxCalls: 10, windowSeconds: 60, active: true });
    expect(small.upsertRule({ tool: 'c', maxCalls: 10, windowSeconds: 60, active: true })).toBe(false);
    small.destroy();
  });

  // ─── Rate Checking ──────────────────────────────────────────────

  test('allow calls within limit', () => {
    limiter.upsertRule({ tool: 'search', maxCalls: 5, windowSeconds: 60, active: true });
    for (let i = 0; i < 5; i++) {
      const result = limiter.check('key_1', 'search');
      expect(result.allowed).toBe(true);
      expect(result.ruleApplied).toBe('search');
    }
  });

  test('deny calls exceeding limit', () => {
    limiter.upsertRule({ tool: 'search', maxCalls: 3, windowSeconds: 60, active: true });
    limiter.check('key_1', 'search');
    limiter.check('key_1', 'search');
    limiter.check('key_1', 'search');
    const result = limiter.check('key_1', 'search');
    expect(result.allowed).toBe(false);
    expect(result.used).toBe(3);
    expect(result.limit).toBe(3);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('different keys have separate windows', () => {
    limiter.upsertRule({ tool: 'tool', maxCalls: 2, windowSeconds: 60, active: true });
    limiter.check('key_a', 'tool');
    limiter.check('key_a', 'tool');
    expect(limiter.check('key_a', 'tool').allowed).toBe(false);
    expect(limiter.check('key_b', 'tool').allowed).toBe(true);
  });

  test('different tools have separate windows', () => {
    limiter.upsertRule({ tool: 'expensive', maxCalls: 2, windowSeconds: 60, active: true });
    limiter.upsertRule({ tool: 'cheap', maxCalls: 100, windowSeconds: 60, active: true });

    limiter.check('key_1', 'expensive');
    limiter.check('key_1', 'expensive');
    expect(limiter.check('key_1', 'expensive').allowed).toBe(false);
    expect(limiter.check('key_1', 'cheap').allowed).toBe(true);
  });

  test('use wildcard rule when no exact match', () => {
    limiter.upsertRule({ tool: '*', maxCalls: 20, windowSeconds: 60, active: true });
    const result = limiter.check('key_1', 'any_tool');
    expect(result.allowed).toBe(true);
    expect(result.ruleApplied).toBe('*');
    expect(result.limit).toBe(20);
  });

  test('use default when no rules match', () => {
    const result = limiter.check('key_1', 'unknown_tool');
    expect(result.allowed).toBe(true);
    expect(result.ruleApplied).toBe('*');
    expect(result.limit).toBe(60); // defaultMaxCalls
  });

  test('inactive rule is skipped', () => {
    limiter.upsertRule({ tool: 'disabled', maxCalls: 1, windowSeconds: 60, active: false });
    limiter.upsertRule({ tool: '*', maxCalls: 50, windowSeconds: 60, active: true });

    const result = limiter.check('key_1', 'disabled');
    expect(result.allowed).toBe(true);
    expect(result.ruleApplied).toBe('*');
  });

  // ─── Peek ───────────────────────────────────────────────────────

  test('peek does not consume capacity', () => {
    limiter.upsertRule({ tool: 'peek_tool', maxCalls: 2, windowSeconds: 60, active: true });
    limiter.check('key_1', 'peek_tool');

    const peek = limiter.peek('key_1', 'peek_tool');
    expect(peek.allowed).toBe(true);
    expect(peek.used).toBe(1);

    // Peek shouldn't have consumed a slot
    const check = limiter.check('key_1', 'peek_tool');
    expect(check.allowed).toBe(true);
    expect(check.used).toBe(2);
  });

  // ─── Window Reset ───────────────────────────────────────────────

  test('resetWindow clears specific key+tool', () => {
    limiter.upsertRule({ tool: 'reset_tool', maxCalls: 2, windowSeconds: 60, active: true });
    limiter.check('key_r', 'reset_tool');
    limiter.check('key_r', 'reset_tool');
    expect(limiter.check('key_r', 'reset_tool').allowed).toBe(false);

    limiter.resetWindow('key_r', 'reset_tool');
    expect(limiter.check('key_r', 'reset_tool').allowed).toBe(true);
  });

  test('resetKey clears all windows for a key', () => {
    limiter.upsertRule({ tool: 'a', maxCalls: 1, windowSeconds: 60, active: true });
    limiter.upsertRule({ tool: 'b', maxCalls: 1, windowSeconds: 60, active: true });
    limiter.check('key_rk', 'a');
    limiter.check('key_rk', 'b');

    const count = limiter.resetKey('key_rk');
    expect(count).toBe(2);
    expect(limiter.check('key_rk', 'a').allowed).toBe(true);
    expect(limiter.check('key_rk', 'b').allowed).toBe(true);
  });

  // ─── Stats ──────────────────────────────────────────────────────

  test('stats track checks and denials', () => {
    limiter.upsertRule({ tool: 'stat_tool', maxCalls: 2, windowSeconds: 60, active: true });
    limiter.check('k', 'stat_tool');
    limiter.check('k', 'stat_tool');
    limiter.check('k', 'stat_tool'); // denied

    const stats = limiter.getStats();
    expect(stats.totalChecks).toBe(3);
    expect(stats.totalDenials).toBe(1);
    expect(stats.denialsByTool['stat_tool']).toBe(1);
    expect(stats.totalRules).toBe(1);
    expect(stats.activeRules).toBe(1);
  });

  test('resetStats clears counters', () => {
    limiter.check('k', 'tool');
    limiter.resetStats();
    expect(limiter.getStats().totalChecks).toBe(0);
  });

  test('destroy clears everything', () => {
    limiter.upsertRule({ tool: 't', maxCalls: 1, windowSeconds: 60, active: true });
    limiter.check('k', 't');
    limiter.destroy();
    expect(limiter.getRules().length).toBe(0);
    expect(limiter.getStats().totalChecks).toBe(0);
    expect(limiter.getStats().activeTracking).toBe(0);
  });
});
