import { RequestValidator } from '../src/request-validator';

describe('RequestValidator', () => {
  let validator: RequestValidator;

  beforeEach(() => {
    validator = new RequestValidator();
  });

  // ── Basic Validation ──────────────────────────────────────────────

  it('validates a well-formed JSON-RPC request', () => {
    const result = validator.validate({
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 1,
      params: {},
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects non-object request', () => {
    const result = validator.validate('invalid');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('non-null object');
  });

  it('rejects null request', () => {
    const result = validator.validate(null);
    expect(result.valid).toBe(false);
  });

  it('rejects missing jsonrpc field', () => {
    const result = validator.validate({ method: 'test' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('jsonrpc'))).toBe(true);
  });

  it('rejects missing method field', () => {
    const result = validator.validate({ jsonrpc: '2.0' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('method'))).toBe(true);
  });

  it('skips jsonrpc check when disabled', () => {
    const v = new RequestValidator({ requireJsonRpc: false });
    const result = v.validate({ foo: 'bar' });
    expect(result.valid).toBe(true);
  });

  // ── Payload Size ──────────────────────────────────────────────────

  it('enforces max payload size', () => {
    const v = new RequestValidator({ maxPayloadBytes: 10 });
    const result = v.validate({ jsonrpc: '2.0', method: 'test', data: 'large_payload_string' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Payload size'))).toBe(true);
  });

  it('accepts payload within size limit', () => {
    const v = new RequestValidator({ maxPayloadBytes: 10_000 });
    const result = v.validate({ jsonrpc: '2.0', method: 'test' });
    expect(result.valid).toBe(true);
  });

  // ── Allowed Methods ───────────────────────────────────────────────

  it('enforces allowed methods', () => {
    const v = new RequestValidator({ allowedMethods: ['tools/call', 'tools/list'] });
    expect(v.validate({ jsonrpc: '2.0', method: 'tools/call' }).valid).toBe(true);
    expect(v.validate({ jsonrpc: '2.0', method: 'admin/delete' }).valid).toBe(false);
  });

  it('allows all methods when not configured', () => {
    const result = validator.validate({ jsonrpc: '2.0', method: 'anything' });
    expect(result.valid).toBe(true);
  });

  it('updates allowed methods dynamically', () => {
    validator.setAllowedMethods(['test']);
    expect(validator.validate({ jsonrpc: '2.0', method: 'other' }).valid).toBe(false);
    validator.setAllowedMethods(null);
    expect(validator.validate({ jsonrpc: '2.0', method: 'other' }).valid).toBe(true);
  });

  // ── Custom Rules ──────────────────────────────────────────────────

  it('adds and applies custom rules', () => {
    validator.addRule({
      name: 'require_id',
      check: (req) => req.id === undefined ? 'Request must have an id' : null,
    });
    expect(validator.validate({ jsonrpc: '2.0', method: 'test' }).valid).toBe(false);
    expect(validator.validate({ jsonrpc: '2.0', method: 'test', id: 1 }).valid).toBe(true);
  });

  it('applies method-scoped rules', () => {
    validator.addRule({
      name: 'require_params',
      method: 'tools/call',
      check: (req) => !req.params ? 'params required for tools/call' : null,
    });
    // Should fail for tools/call without params
    expect(validator.validate({ jsonrpc: '2.0', method: 'tools/call' }).valid).toBe(false);
    // Should pass for other methods
    expect(validator.validate({ jsonrpc: '2.0', method: 'tools/list' }).valid).toBe(true);
  });

  it('rejects duplicate rule names', () => {
    validator.addRule({ name: 'a', check: () => null });
    expect(() => validator.addRule({ name: 'a', check: () => null })).toThrow('already exists');
  });

  it('removes a rule', () => {
    validator.addRule({ name: 'fail', check: () => 'always fails' });
    expect(validator.validate({ jsonrpc: '2.0', method: 'test' }).valid).toBe(false);
    validator.removeRule('fail');
    expect(validator.validate({ jsonrpc: '2.0', method: 'test' }).valid).toBe(true);
  });

  it('enables/disables rules', () => {
    validator.addRule({ name: 'fail', check: () => 'fails' });
    validator.setRuleEnabled('fail', false);
    expect(validator.validate({ jsonrpc: '2.0', method: 'test' }).valid).toBe(true);
    validator.setRuleEnabled('fail', true);
    expect(validator.validate({ jsonrpc: '2.0', method: 'test' }).valid).toBe(false);
  });

  it('lists rules', () => {
    validator.addRule({ name: 'a', check: () => null });
    validator.addRule({ name: 'b', check: () => null });
    expect(validator.listRules()).toHaveLength(2);
  });

  // ── isValid shorthand ─────────────────────────────────────────────

  it('isValid returns boolean', () => {
    expect(validator.isValid({ jsonrpc: '2.0', method: 'test' })).toBe(true);
    expect(validator.isValid(null)).toBe(false);
  });

  // ── Stats ─────────────────────────────────────────────────────────

  it('tracks stats', () => {
    validator.validate({ jsonrpc: '2.0', method: 'test' });
    validator.validate(null);
    const stats = validator.getStats();
    expect(stats.totalValidations).toBe(2);
    expect(stats.totalValid).toBe(1);
    expect(stats.totalInvalid).toBe(1);
  });

  // ── Destroy ───────────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    validator.addRule({ name: 'a', check: () => null });
    validator.validate({ jsonrpc: '2.0', method: 'test' });
    validator.destroy();
    expect(validator.getStats().totalRules).toBe(0);
    expect(validator.getStats().totalValidations).toBe(0);
  });
});
