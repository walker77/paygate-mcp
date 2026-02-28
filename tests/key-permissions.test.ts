import { KeyPermissionsEngine } from '../src/key-permissions';

describe('KeyPermissionsEngine', () => {
  let engine: KeyPermissionsEngine;

  beforeEach(() => {
    engine = new KeyPermissionsEngine({ defaultEffect: 'allow' });
  });

  afterEach(() => {
    engine.destroy();
  });

  // ─── Rule Management ────────────────────────────────────────────

  test('upsert and retrieve a rule', () => {
    const ok = engine.upsertRule({
      id: 'rule-1',
      name: 'Business Hours',
      effect: 'allow',
      priority: 10,
      conditions: [{ type: 'time_range', params: { startHour: 9, endHour: 17 } }],
      active: true,
    });
    expect(ok).toBe(true);
    const rule = engine.getRule('rule-1');
    expect(rule).toBeTruthy();
    expect(rule!.name).toBe('Business Hours');
  });

  test('list all rules', () => {
    engine.upsertRule({ id: 'a', name: 'A', effect: 'allow', priority: 0, conditions: [], active: true });
    engine.upsertRule({ id: 'b', name: 'B', effect: 'deny', priority: 0, conditions: [], active: true });
    expect(engine.getRules().length).toBe(2);
  });

  test('remove a rule', () => {
    engine.upsertRule({ id: 'del', name: 'Del', effect: 'allow', priority: 0, conditions: [], active: true });
    expect(engine.removeRule('del')).toBe(true);
    expect(engine.getRule('del')).toBeNull();
  });

  test('removing rule also removes from assignments', () => {
    engine.upsertRule({ id: 'r1', name: 'R1', effect: 'allow', priority: 0, conditions: [], active: true });
    engine.assignRules('key_1', ['r1']);
    engine.removeRule('r1');
    expect(engine.getAssignment('key_1').length).toBe(0);
  });

  test('enforce max rules', () => {
    const small = new KeyPermissionsEngine({ maxRules: 2 });
    small.upsertRule({ id: 'a', name: 'A', effect: 'allow', priority: 0, conditions: [], active: true });
    small.upsertRule({ id: 'b', name: 'B', effect: 'allow', priority: 0, conditions: [], active: true });
    expect(small.upsertRule({ id: 'c', name: 'C', effect: 'allow', priority: 0, conditions: [], active: true })).toBe(false);
    small.destroy();
  });

  // ─── Assignments ────────────────────────────────────────────────

  test('assign rules to key', () => {
    engine.upsertRule({ id: 'r1', name: 'R1', effect: 'allow', priority: 0, conditions: [], active: true });
    engine.upsertRule({ id: 'r2', name: 'R2', effect: 'allow', priority: 0, conditions: [], active: true });
    expect(engine.assignRules('key_1', ['r1', 'r2'])).toBe(true);
    expect(engine.getAssignment('key_1')).toEqual(['r1', 'r2']);
  });

  test('reject assignment with unknown rule', () => {
    expect(engine.assignRules('key_1', ['nonexistent'])).toBe(false);
  });

  test('remove assignment', () => {
    engine.upsertRule({ id: 'r1', name: 'R1', effect: 'allow', priority: 0, conditions: [], active: true });
    engine.assignRules('key_1', ['r1']);
    expect(engine.removeAssignment('key_1')).toBe(true);
    expect(engine.getAssignment('key_1')).toEqual([]);
  });

  // ─── Basic Checks ──────────────────────────────────────────────

  test('no rules assigned uses default effect (allow)', () => {
    const result = engine.check({ key: 'key_1', tool: 'search' });
    expect(result.allowed).toBe(true);
  });

  test('no rules assigned uses default effect (deny)', () => {
    const strict = new KeyPermissionsEngine({ defaultEffect: 'deny' });
    strict.upsertRule({ id: 'r1', name: 'R1', effect: 'allow', priority: 0, conditions: [], active: true });
    const result = strict.check({ key: 'key_no_assign', tool: 'search' });
    expect(result.allowed).toBe(false);
    strict.destroy();
  });

  test('allow rule with no conditions always matches', () => {
    engine.upsertRule({ id: 'allow-all', name: 'Allow All', effect: 'allow', priority: 0, conditions: [], active: true });
    engine.assignRules('key_1', ['allow-all']);
    const result = engine.check({ key: 'key_1', tool: 'anything' });
    expect(result.allowed).toBe(true);
    expect(result.matchedRuleId).toBe('allow-all');
  });

  test('deny rule with no conditions always denies', () => {
    engine.upsertRule({ id: 'deny-all', name: 'Deny All', effect: 'deny', priority: 0, conditions: [], active: true });
    engine.assignRules('key_1', ['deny-all']);
    const result = engine.check({ key: 'key_1', tool: 'anything' });
    expect(result.allowed).toBe(false);
    expect(result.matchedRuleId).toBe('deny-all');
  });

  test('higher priority rules evaluated first', () => {
    engine.upsertRule({ id: 'deny', name: 'Deny', effect: 'deny', priority: 5, conditions: [], active: true });
    engine.upsertRule({ id: 'allow', name: 'Allow', effect: 'allow', priority: 10, conditions: [], active: true });
    engine.assignRules('key_1', ['deny', 'allow']);
    const result = engine.check({ key: 'key_1', tool: 'tool' });
    // Allow has higher priority, evaluated first, matches → allowed
    expect(result.allowed).toBe(true);
    expect(result.matchedRuleId).toBe('allow');
  });

  // ─── Condition: Environment ─────────────────────────────────────
  // Note: condition tests use defaultEffect:'deny' so unmatched allow-rules fall to deny

  test('environment condition allows matching env', () => {
    const eng = new KeyPermissionsEngine({ defaultEffect: 'deny' });
    eng.upsertRule({
      id: 'prod-only',
      name: 'Production Only',
      effect: 'allow',
      priority: 10,
      conditions: [{ type: 'environment', params: { allowed: ['production', 'staging'] } }],
      active: true,
    });
    eng.assignRules('key_1', ['prod-only']);

    expect(eng.check({ key: 'key_1', tool: 'tool', environment: 'production' }).allowed).toBe(true);
    expect(eng.check({ key: 'key_1', tool: 'tool', environment: 'development' }).allowed).toBe(false);
    eng.destroy();
  });

  // ─── Condition: Max Payload ─────────────────────────────────────

  test('max payload condition enforces size limit', () => {
    const eng = new KeyPermissionsEngine({ defaultEffect: 'deny' });
    eng.upsertRule({
      id: 'size-limit',
      name: 'Size Limit',
      effect: 'allow',
      priority: 10,
      conditions: [{ type: 'max_payload_bytes', params: { maxBytes: 10000 } }],
      active: true,
    });
    eng.assignRules('key_1', ['size-limit']);

    expect(eng.check({ key: 'key_1', tool: 'tool', payloadBytes: 5000 }).allowed).toBe(true);
    expect(eng.check({ key: 'key_1', tool: 'tool', payloadBytes: 20000 }).allowed).toBe(false);
    eng.destroy();
  });

  // ─── Condition: Tool Pattern ────────────────────────────────────

  test('tool pattern condition matches', () => {
    const eng = new KeyPermissionsEngine({ defaultEffect: 'deny' });
    eng.upsertRule({
      id: 'tool-filter',
      name: 'Tool Filter',
      effect: 'allow',
      priority: 10,
      conditions: [{ type: 'tool_pattern', params: { patterns: ['search_*', 'list_items'] } }],
      active: true,
    });
    eng.assignRules('key_1', ['tool-filter']);

    expect(eng.check({ key: 'key_1', tool: 'search_users' }).allowed).toBe(true);
    expect(eng.check({ key: 'key_1', tool: 'list_items' }).allowed).toBe(true);
    expect(eng.check({ key: 'key_1', tool: 'delete_users' }).allowed).toBe(false);
    eng.destroy();
  });

  // ─── Condition: IP CIDR ─────────────────────────────────────────

  test('IP CIDR condition allows matching IP', () => {
    const eng = new KeyPermissionsEngine({ defaultEffect: 'deny' });
    eng.upsertRule({
      id: 'ip-filter',
      name: 'IP Filter',
      effect: 'allow',
      priority: 10,
      conditions: [{ type: 'ip_cidr', params: { ranges: ['10.0.0.0/8', '192.168.1.0/24'] } }],
      active: true,
    });
    eng.assignRules('key_1', ['ip-filter']);

    expect(eng.check({ key: 'key_1', tool: 'tool', ip: '10.1.2.3' }).allowed).toBe(true);
    expect(eng.check({ key: 'key_1', tool: 'tool', ip: '192.168.1.100' }).allowed).toBe(true);
    expect(eng.check({ key: 'key_1', tool: 'tool', ip: '8.8.8.8' }).allowed).toBe(false);
    eng.destroy();
  });

  test('IP condition fails when no IP provided', () => {
    const eng = new KeyPermissionsEngine({ defaultEffect: 'deny' });
    eng.upsertRule({
      id: 'ip-req',
      name: 'IP Required',
      effect: 'allow',
      priority: 10,
      conditions: [{ type: 'ip_cidr', params: { ranges: ['10.0.0.0/8'] } }],
      active: true,
    });
    eng.assignRules('key_1', ['ip-req']);

    expect(eng.check({ key: 'key_1', tool: 'tool' }).allowed).toBe(false);
    eng.destroy();
  });

  // ─── Condition: Custom ──────────────────────────────────────────

  test('custom condition checks extra context', () => {
    const eng = new KeyPermissionsEngine({ defaultEffect: 'deny' });
    eng.upsertRule({
      id: 'custom',
      name: 'Custom Check',
      effect: 'allow',
      priority: 10,
      conditions: [{ type: 'custom', params: { key: 'tier', value: 'premium' } }],
      active: true,
    });
    eng.assignRules('key_1', ['custom']);

    expect(eng.check({ key: 'key_1', tool: 'tool', extra: { tier: 'premium' } }).allowed).toBe(true);
    expect(eng.check({ key: 'key_1', tool: 'tool', extra: { tier: 'free' } }).allowed).toBe(false);
    eng.destroy();
  });

  // ─── Multiple Conditions (AND logic) ────────────────────────────

  test('all conditions must pass for rule to match', () => {
    const eng = new KeyPermissionsEngine({ defaultEffect: 'deny' });
    eng.upsertRule({
      id: 'strict',
      name: 'Strict',
      effect: 'allow',
      priority: 10,
      conditions: [
        { type: 'environment', params: { allowed: ['production'] } },
        { type: 'max_payload_bytes', params: { maxBytes: 5000 } },
      ],
      active: true,
    });
    eng.assignRules('key_1', ['strict']);

    // Both pass
    expect(eng.check({ key: 'key_1', tool: 'tool', environment: 'production', payloadBytes: 1000 }).allowed).toBe(true);
    // One fails
    expect(eng.check({ key: 'key_1', tool: 'tool', environment: 'staging', payloadBytes: 1000 }).allowed).toBe(false);
    expect(eng.check({ key: 'key_1', tool: 'tool', environment: 'production', payloadBytes: 10000 }).allowed).toBe(false);
    eng.destroy();
  });

  // ─── Inactive Rules ─────────────────────────────────────────────

  test('inactive rules are skipped', () => {
    engine.upsertRule({ id: 'inactive', name: 'Inactive', effect: 'deny', priority: 100, conditions: [], active: false });
    engine.assignRules('key_1', ['inactive']);
    const result = engine.check({ key: 'key_1', tool: 'tool' });
    // No active rules → default effect (allow)
    expect(result.allowed).toBe(true);
  });

  // ─── Stats ──────────────────────────────────────────────────────

  test('stats track checks and denials', () => {
    engine.upsertRule({ id: 'deny', name: 'Deny', effect: 'deny', priority: 0, conditions: [], active: true });
    engine.assignRules('key_1', ['deny']);
    engine.check({ key: 'key_1', tool: 'tool' });
    engine.check({ key: 'key_1', tool: 'tool' });

    const stats = engine.getStats();
    expect(stats.totalChecks).toBe(2);
    expect(stats.totalDenials).toBe(2);
    expect(stats.totalRules).toBe(1);
    expect(stats.assignedKeys).toBe(1);
  });

  test('destroy clears everything', () => {
    engine.upsertRule({ id: 'r', name: 'R', effect: 'allow', priority: 0, conditions: [], active: true });
    engine.assignRules('k', ['r']);
    engine.destroy();
    expect(engine.getRules().length).toBe(0);
    expect(engine.getStats().assignedKeys).toBe(0);
  });
});
