import { WebhookFilterExpression } from '../src/webhook-filter-expr';

describe('WebhookFilterExpression', () => {
  let filter: WebhookFilterExpression;

  beforeEach(() => {
    filter = new WebhookFilterExpression();
  });

  afterEach(() => {
    filter.destroy();
  });

  // ── Rule Management ─────────────────────────────────────────────

  describe('rule management', () => {
    it('adds a filter rule', () => {
      const rule = filter.addRule({
        name: 'test-rule',
        url: 'https://example.com/hook',
        conditions: [{ field: 'event', op: 'eq', value: 'key.created' }],
      });
      expect(rule.id).toMatch(/^fr_/);
      expect(rule.enabled).toBe(true);
      expect(rule.matchCount).toBe(0);
    });

    it('validates required fields', () => {
      expect(() => filter.addRule({ name: '', url: 'http://x', conditions: [{ field: 'a', op: 'eq', value: 1 }] })).toThrow('name');
      expect(() => filter.addRule({ name: 'x', url: '', conditions: [{ field: 'a', op: 'eq', value: 1 }] })).toThrow('URL');
      expect(() => filter.addRule({ name: 'x', url: 'http://x', conditions: [] })).toThrow('condition');
    });

    it('enforces max rules', () => {
      const small = new WebhookFilterExpression({ maxRules: 2 });
      small.addRule({ name: 'r1', url: 'http://1', conditions: [{ field: 'a', op: 'eq', value: 1 }] });
      small.addRule({ name: 'r2', url: 'http://2', conditions: [{ field: 'a', op: 'eq', value: 1 }] });
      expect(() => small.addRule({ name: 'r3', url: 'http://3', conditions: [{ field: 'a', op: 'eq', value: 1 }] })).toThrow('Maximum');
      small.destroy();
    });

    it('removes a rule', () => {
      const rule = filter.addRule({ name: 'r', url: 'http://x', conditions: [{ field: 'a', op: 'eq', value: 1 }] });
      expect(filter.removeRule(rule.id)).toBe(true);
      expect(filter.getRule(rule.id)).toBeNull();
    });

    it('enables and disables rules', () => {
      const rule = filter.addRule({ name: 'r', url: 'http://x', conditions: [{ field: 'a', op: 'eq', value: 1 }] });
      filter.disableRule(rule.id);
      expect(filter.getRule(rule.id)!.enabled).toBe(false);
      filter.enableRule(rule.id);
      expect(filter.getRule(rule.id)!.enabled).toBe(true);
    });

    it('lists rules, optionally by URL', () => {
      filter.addRule({ name: 'r1', url: 'http://a', conditions: [{ field: 'x', op: 'eq', value: 1 }] });
      filter.addRule({ name: 'r2', url: 'http://b', conditions: [{ field: 'x', op: 'eq', value: 1 }] });
      filter.addRule({ name: 'r3', url: 'http://a', conditions: [{ field: 'y', op: 'eq', value: 2 }] });

      expect(filter.listRules()).toHaveLength(3);
      expect(filter.listRules('http://a')).toHaveLength(2);
    });
  });

  // ── Filter Operators ────────────────────────────────────────────

  describe('filter operators', () => {
    it('eq operator', () => {
      filter.addRule({ name: 'r', url: 'http://x', conditions: [{ field: 'event', op: 'eq', value: 'key.created' }] });
      expect(filter.evaluate({ event: 'key.created' }).matchedUrls).toContain('http://x');
      expect(filter.evaluate({ event: 'key.deleted' }).matchedUrls).toHaveLength(0);
    });

    it('neq operator', () => {
      filter.addRule({ name: 'r', url: 'http://x', conditions: [{ field: 'status', op: 'neq', value: 'active' }] });
      expect(filter.evaluate({ status: 'inactive' }).matchedUrls).toContain('http://x');
      expect(filter.evaluate({ status: 'active' }).matchedUrls).toHaveLength(0);
    });

    it('gt/gte/lt/lte operators', () => {
      filter.addRule({ name: 'gt', url: 'http://gt', conditions: [{ field: 'amount', op: 'gt', value: 100 }] });
      filter.addRule({ name: 'lte', url: 'http://lte', conditions: [{ field: 'amount', op: 'lte', value: 100 }] });

      const r1 = filter.evaluate({ amount: 150 });
      expect(r1.matchedUrls).toContain('http://gt');
      expect(r1.matchedUrls).not.toContain('http://lte');

      const r2 = filter.evaluate({ amount: 100 });
      expect(r2.matchedUrls).not.toContain('http://gt');
      expect(r2.matchedUrls).toContain('http://lte');
    });

    it('contains operator', () => {
      filter.addRule({ name: 'r', url: 'http://x', conditions: [{ field: 'name', op: 'contains', value: 'test' }] });
      expect(filter.evaluate({ name: 'my-test-key' }).matchedUrls).toContain('http://x');
      expect(filter.evaluate({ name: 'production' }).matchedUrls).toHaveLength(0);
    });

    it('starts_with and ends_with operators', () => {
      filter.addRule({ name: 'sw', url: 'http://sw', conditions: [{ field: 'key', op: 'starts_with', value: 'pk_' }] });
      filter.addRule({ name: 'ew', url: 'http://ew', conditions: [{ field: 'key', op: 'ends_with', value: '_live' }] });

      const r = filter.evaluate({ key: 'pk_abc_live' });
      expect(r.matchedUrls).toContain('http://sw');
      expect(r.matchedUrls).toContain('http://ew');
    });

    it('regex operator', () => {
      filter.addRule({ name: 'r', url: 'http://x', conditions: [{ field: 'email', op: 'regex', value: '^admin@' }] });
      expect(filter.evaluate({ email: 'admin@example.com' }).matchedUrls).toContain('http://x');
      expect(filter.evaluate({ email: 'user@example.com' }).matchedUrls).toHaveLength(0);
    });

    it('in and not_in operators', () => {
      filter.addRule({ name: 'in', url: 'http://in', conditions: [{ field: 'tier', op: 'in', value: ['pro', 'enterprise'] }] });
      filter.addRule({ name: 'not_in', url: 'http://not_in', conditions: [{ field: 'tier', op: 'not_in', value: ['free', 'trial'] }] });

      expect(filter.evaluate({ tier: 'pro' }).matchedUrls).toContain('http://in');
      expect(filter.evaluate({ tier: 'free' }).matchedUrls).not.toContain('http://in');
      expect(filter.evaluate({ tier: 'pro' }).matchedUrls).toContain('http://not_in');
    });

    it('exists operator', () => {
      filter.addRule({ name: 'r', url: 'http://x', conditions: [{ field: 'metadata', op: 'exists', value: null }] });
      expect(filter.evaluate({ metadata: { key: 'val' } }).matchedUrls).toContain('http://x');
      expect(filter.evaluate({ other: 'val' }).matchedUrls).toHaveLength(0);
    });
  });

  // ── Match Modes ─────────────────────────────────────────────────

  describe('match modes', () => {
    it('all mode requires all conditions', () => {
      filter.addRule({
        name: 'strict',
        url: 'http://strict',
        conditions: [
          { field: 'event', op: 'eq', value: 'usage' },
          { field: 'credits', op: 'gt', value: 50 },
        ],
        matchMode: 'all',
      });

      expect(filter.evaluate({ event: 'usage', credits: 100 }).matchedUrls).toContain('http://strict');
      expect(filter.evaluate({ event: 'usage', credits: 10 }).matchedUrls).toHaveLength(0);
    });

    it('any mode requires at least one condition', () => {
      filter.addRule({
        name: 'loose',
        url: 'http://loose',
        conditions: [
          { field: 'event', op: 'eq', value: 'usage' },
          { field: 'credits', op: 'gt', value: 50 },
        ],
        matchMode: 'any',
      });

      expect(filter.evaluate({ event: 'usage', credits: 10 }).matchedUrls).toContain('http://loose');
      expect(filter.evaluate({ event: 'other', credits: 100 }).matchedUrls).toContain('http://loose');
      expect(filter.evaluate({ event: 'other', credits: 10 }).matchedUrls).toHaveLength(0);
    });
  });

  // ── Nested Fields ───────────────────────────────────────────────

  describe('nested fields', () => {
    it('accesses nested object fields', () => {
      filter.addRule({
        name: 'nested',
        url: 'http://nested',
        conditions: [{ field: 'metadata.tier', op: 'eq', value: 'pro' }],
      });
      expect(filter.evaluate({ metadata: { tier: 'pro' } }).matchedUrls).toContain('http://nested');
      expect(filter.evaluate({ metadata: { tier: 'free' } }).matchedUrls).toHaveLength(0);
    });

    it('handles missing nested path gracefully', () => {
      filter.addRule({
        name: 'deep',
        url: 'http://deep',
        conditions: [{ field: 'a.b.c', op: 'eq', value: 'val' }],
      });
      expect(filter.evaluate({ a: {} }).matchedUrls).toHaveLength(0);
      expect(filter.evaluate({}).matchedUrls).toHaveLength(0);
    });
  });

  // ── Test Rule ───────────────────────────────────────────────────

  describe('testRule', () => {
    it('tests a specific rule without side effects', () => {
      const rule = filter.addRule({
        name: 'r',
        url: 'http://x',
        conditions: [{ field: 'x', op: 'eq', value: 1 }],
      });

      expect(filter.testRule(rule.id, { x: 1 })).toBe(true);
      expect(filter.testRule(rule.id, { x: 2 })).toBe(false);
      expect(rule.matchCount).toBe(0); // No side effects
    });

    it('returns false for unknown rule', () => {
      expect(filter.testRule('fr_999', { x: 1 })).toBe(false);
    });
  });

  // ── Disabled Rules ──────────────────────────────────────────────

  describe('disabled rules', () => {
    it('skips disabled rules during evaluation', () => {
      const rule = filter.addRule({ name: 'r', url: 'http://x', conditions: [{ field: 'x', op: 'eq', value: 1 }] });
      filter.disableRule(rule.id);

      const result = filter.evaluate({ x: 1 });
      expect(result.matchedUrls).toHaveLength(0);
      expect(result.evaluatedRules).toBe(0);
    });
  });

  // ── Stats & Destroy ─────────────────────────────────────────────

  describe('stats and destroy', () => {
    it('tracks comprehensive stats', () => {
      filter.addRule({ name: 'r1', url: 'http://1', conditions: [{ field: 'x', op: 'eq', value: 1 }] });
      const r2 = filter.addRule({ name: 'r2', url: 'http://2', conditions: [{ field: 'x', op: 'eq', value: 2 }] });
      filter.disableRule(r2.id);

      filter.evaluate({ x: 1 });
      filter.evaluate({ x: 1 });

      const stats = filter.getStats();
      expect(stats.totalRules).toBe(2);
      expect(stats.enabledRules).toBe(1);
      expect(stats.totalEvaluations).toBe(2);
      expect(stats.totalMatches).toBe(2);
      expect(stats.topRules).toHaveLength(1);
    });

    it('destroy resets everything', () => {
      filter.addRule({ name: 'r', url: 'http://x', conditions: [{ field: 'x', op: 'eq', value: 1 }] });
      filter.evaluate({ x: 1 });
      filter.destroy();

      const stats = filter.getStats();
      expect(stats.totalRules).toBe(0);
      expect(stats.totalEvaluations).toBe(0);
    });
  });
});
