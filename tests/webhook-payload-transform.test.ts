import { WebhookPayloadTransform } from '../src/webhook-payload-transform';

describe('WebhookPayloadTransform', () => {
  let transforms: WebhookPayloadTransform;

  beforeEach(() => {
    transforms = new WebhookPayloadTransform();
  });

  afterEach(() => {
    transforms.destroy();
  });

  // ── Rule Management ────────────────────────────────────────────────

  describe('rule management', () => {
    it('adds a rule', () => {
      const rule = transforms.addRule({ name: 'strip-debug', type: 'remove_fields', fields: ['debug'] });
      expect(rule.id).toMatch(/^tr_/);
      expect(rule.enabled).toBe(true);
    });

    it('rejects empty name', () => {
      expect(() => transforms.addRule({ name: '', type: 'remove_fields' })).toThrow();
    });

    it('rejects duplicate names', () => {
      transforms.addRule({ name: 'r1', type: 'remove_fields' });
      expect(() => transforms.addRule({ name: 'r1', type: 'remove_fields' })).toThrow(/already exists/);
    });

    it('gets rule by ID', () => {
      const rule = transforms.addRule({ name: 'test', type: 'remove_fields' });
      expect(transforms.getRule(rule.id)).not.toBeNull();
      expect(transforms.getRule('tr_999')).toBeNull();
    });

    it('removes a rule', () => {
      const rule = transforms.addRule({ name: 'test', type: 'remove_fields' });
      expect(transforms.removeRule(rule.id)).toBe(true);
      expect(transforms.removeRule(rule.id)).toBe(false);
    });

    it('enables/disables a rule', () => {
      const rule = transforms.addRule({ name: 'test', type: 'remove_fields' });
      transforms.setEnabled(rule.id, false);
      expect(transforms.getRule(rule.id)!.enabled).toBe(false);
    });

    it('returns false for unknown rule setEnabled', () => {
      expect(transforms.setEnabled('tr_999', true)).toBe(false);
    });

    it('lists all rules', () => {
      transforms.addRule({ name: 'r1', type: 'remove_fields' });
      transforms.addRule({ name: 'r2', type: 'add_fields' });
      expect(transforms.listRules()).toHaveLength(2);
    });

    it('finds rule by name', () => {
      transforms.addRule({ name: 'my-rule', type: 'remove_fields' });
      expect(transforms.findByName('my-rule')).not.toBeNull();
      expect(transforms.findByName('unknown')).toBeNull();
    });
  });

  // ── Transform Operations ───────────────────────────────────────────

  describe('transform operations', () => {
    it('removes fields', () => {
      transforms.addRule({ name: 'strip', type: 'remove_fields', fields: ['secret', 'debug'] });
      const result = transforms.apply({ id: 1, secret: 'xxx', debug: true, name: 'test' }, ['strip']);
      expect(result.transformed).toEqual({ id: 1, name: 'test' });
      expect(result.rulesApplied).toEqual(['strip']);
    });

    it('renames fields', () => {
      transforms.addRule({ name: 'rename', type: 'rename_fields', renames: { old_name: 'new_name' } });
      const result = transforms.apply({ old_name: 'value', other: 1 }, ['rename']);
      expect(result.transformed).toEqual({ new_name: 'value', other: 1 });
    });

    it('adds fields', () => {
      transforms.addRule({ name: 'enrich', type: 'add_fields', additions: { source: 'paygate', version: 2 } });
      const result = transforms.apply({ id: 1 }, ['enrich']);
      expect(result.transformed).toEqual({ id: 1, source: 'paygate', version: 2 });
    });

    it('masks fields', () => {
      transforms.addRule({ name: 'mask', type: 'mask_fields', maskFields: ['email', 'phone'] });
      const result = transforms.apply({ email: 'test@co.com', phone: '555-1234', name: 'Bob' }, ['mask']);
      expect(result.transformed.email).toBe('***');
      expect(result.transformed.phone).toBe('***');
      expect(result.transformed.name).toBe('Bob');
    });

    it('filters fields (keep only listed)', () => {
      transforms.addRule({ name: 'filter', type: 'filter_fields', keepFields: ['id', 'name'] });
      const result = transforms.apply({ id: 1, name: 'test', secret: 'x', debug: true }, ['filter']);
      expect(result.transformed).toEqual({ id: 1, name: 'test' });
    });

    it('skips disabled rules', () => {
      const rule = transforms.addRule({ name: 'strip', type: 'remove_fields', fields: ['secret'] });
      transforms.setEnabled(rule.id, false);
      const result = transforms.apply({ secret: 'x', name: 'test' }, ['strip']);
      expect(result.transformed).toEqual({ secret: 'x', name: 'test' });
      expect(result.rulesApplied).toEqual([]);
    });

    it('applies multiple rules in order', () => {
      transforms.addRule({ name: 'strip', type: 'remove_fields', fields: ['debug'] });
      transforms.addRule({ name: 'enrich', type: 'add_fields', additions: { processed: true } });
      const result = transforms.apply({ debug: true, id: 1 }, ['strip', 'enrich']);
      expect(result.transformed).toEqual({ id: 1, processed: true });
      expect(result.rulesApplied).toHaveLength(2);
    });

    it('preserves original in result', () => {
      transforms.addRule({ name: 'strip', type: 'remove_fields', fields: ['secret'] });
      const result = transforms.apply({ secret: 'x', name: 'test' }, ['strip']);
      expect(result.original.secret).toBe('x');
      expect(result.transformed.secret).toBeUndefined();
    });

    it('applies all enabled rules', () => {
      transforms.addRule({ name: 'r1', type: 'add_fields', additions: { a: 1 } });
      transforms.addRule({ name: 'r2', type: 'add_fields', additions: { b: 2 } });
      const result = transforms.applyAll({ id: 1 });
      expect(result.transformed).toEqual({ id: 1, a: 1, b: 2 });
    });
  });

  // ── Custom Mask Value ──────────────────────────────────────────────

  describe('custom mask value', () => {
    it('uses custom mask value', () => {
      const custom = new WebhookPayloadTransform({ maskValue: '[REDACTED]' });
      custom.addRule({ name: 'mask', type: 'mask_fields', maskFields: ['secret'] });
      const result = custom.apply({ secret: 'xyz' }, ['mask']);
      expect(result.transformed.secret).toBe('[REDACTED]');
      custom.destroy();
    });
  });

  // ── Stats & Destroy ────────────────────────────────────────────────

  describe('stats and destroy', () => {
    it('tracks comprehensive stats', () => {
      transforms.addRule({ name: 'r1', type: 'remove_fields', fields: ['x'] });
      const r2 = transforms.addRule({ name: 'r2', type: 'add_fields', additions: { y: 1 } });
      transforms.setEnabled(r2.id, false);
      transforms.apply({ x: 1 }, ['r1']);

      const stats = transforms.getStats();
      expect(stats.totalRules).toBe(2);
      expect(stats.enabledRules).toBe(1);
      expect(stats.disabledRules).toBe(1);
      expect(stats.totalApplied).toBe(1);
    });

    it('destroy resets everything', () => {
      transforms.addRule({ name: 'r1', type: 'remove_fields' });
      transforms.destroy();
      expect(transforms.getStats().totalRules).toBe(0);
    });
  });
});
