import { FeatureFlagManager } from '../src/feature-flags';

describe('FeatureFlagManager', () => {
  let mgr: FeatureFlagManager;

  beforeEach(() => {
    mgr = new FeatureFlagManager();
  });

  // ── Flag Creation ─────────────────────────────────────────────

  it('creates a flag', () => {
    const flag = mgr.createFlag({ name: 'feature_x' });
    expect(flag.name).toBe('feature_x');
    expect(flag.enabled).toBe(true);
    expect(flag.rolloutPercent).toBe(100);
  });

  it('rejects duplicate flag names', () => {
    mgr.createFlag({ name: 'feature_x' });
    expect(() => mgr.createFlag({ name: 'feature_x' })).toThrow('already exists');
  });

  it('clamps rollout percent', () => {
    const flag = mgr.createFlag({ name: 'f', rolloutPercent: 150 });
    expect(flag.rolloutPercent).toBe(100);
  });

  it('lists all flags', () => {
    mgr.createFlag({ name: 'a' });
    mgr.createFlag({ name: 'b' });
    expect(mgr.listFlags()).toHaveLength(2);
  });

  it('removes a flag', () => {
    mgr.createFlag({ name: 'a' });
    expect(mgr.removeFlag('a')).toBe(true);
    expect(mgr.getFlag('a')).toBeNull();
  });

  // ── Global Enable/Disable ─────────────────────────────────────

  it('disables flag globally', () => {
    mgr.createFlag({ name: 'feature_x' });
    mgr.setEnabled('feature_x', false);
    expect(mgr.isEnabled('feature_x', 'any_key')).toBe(false);
  });

  it('enables flag globally', () => {
    mgr.createFlag({ name: 'feature_x', enabled: false });
    mgr.setEnabled('feature_x', true);
    expect(mgr.isEnabled('feature_x', 'any_key')).toBe(true);
  });

  // ── Allowlist / Blocklist ─────────────────────────────────────

  it('allowlist overrides rollout', () => {
    mgr.createFlag({ name: 'feature_x', rolloutPercent: 0, enabledKeys: ['key_beta'] });
    expect(mgr.isEnabled('feature_x', 'key_beta')).toBe(true);
    expect(mgr.isEnabled('feature_x', 'key_other')).toBe(false);
  });

  it('blocklist overrides everything', () => {
    mgr.createFlag({ name: 'feature_x', rolloutPercent: 100, disabledKeys: ['key_banned'] });
    expect(mgr.isEnabled('feature_x', 'key_banned')).toBe(false);
  });

  it('blocklist takes precedence over allowlist', () => {
    mgr.createFlag({ name: 'feature_x', enabledKeys: ['key_a'], disabledKeys: ['key_a'] });
    // disabledKeys is checked first
    expect(mgr.isEnabled('feature_x', 'key_a')).toBe(false);
  });

  it('adds and removes from lists', () => {
    mgr.createFlag({ name: 'f' });
    mgr.addToAllowlist('f', 'key_a');
    expect(mgr.getFlag('f')!.enabledKeys.has('key_a')).toBe(true);

    mgr.addToBlocklist('f', 'key_a');
    expect(mgr.getFlag('f')!.enabledKeys.has('key_a')).toBe(false);
    expect(mgr.getFlag('f')!.disabledKeys.has('key_a')).toBe(true);

    mgr.removeFromLists('f', 'key_a');
    expect(mgr.getFlag('f')!.disabledKeys.has('key_a')).toBe(false);
  });

  // ── Rollout ───────────────────────────────────────────────────

  it('100% rollout enables for all keys', () => {
    mgr.createFlag({ name: 'feature_x', rolloutPercent: 100 });
    // Test with many keys — all should be enabled
    for (let i = 0; i < 20; i++) {
      expect(mgr.isEnabled('feature_x', `key_${i}`)).toBe(true);
    }
  });

  it('0% rollout disables for all keys', () => {
    mgr.createFlag({ name: 'feature_x', rolloutPercent: 0 });
    for (let i = 0; i < 20; i++) {
      expect(mgr.isEnabled('feature_x', `key_${i}`)).toBe(false);
    }
  });

  it('partial rollout is deterministic', () => {
    mgr.createFlag({ name: 'feature_x', rolloutPercent: 50 });
    const result1 = mgr.isEnabled('feature_x', 'key_test');
    const result2 = mgr.isEnabled('feature_x', 'key_test');
    expect(result1).toBe(result2); // Same key → same result
  });

  it('updates rollout percent', () => {
    mgr.createFlag({ name: 'f', rolloutPercent: 0 });
    mgr.setRolloutPercent('f', 100);
    expect(mgr.isEnabled('f', 'any_key')).toBe(true);
  });

  // ── Schedule ──────────────────────────────────────────────────

  it('respects schedule - not yet active', () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    mgr.createFlag({ name: 'f', activeFrom: future });
    expect(mgr.isEnabled('f', 'key_a')).toBe(false);
  });

  it('respects schedule - expired', () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    mgr.createFlag({ name: 'f', activeUntil: past });
    expect(mgr.isEnabled('f', 'key_a')).toBe(false);
  });

  it('respects schedule - currently active', () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const future = new Date(Date.now() + 86400000).toISOString();
    mgr.createFlag({ name: 'f', activeFrom: past, activeUntil: future });
    expect(mgr.isEnabled('f', 'key_a')).toBe(true);
  });

  it('updates schedule', () => {
    mgr.createFlag({ name: 'f' });
    const future = new Date(Date.now() + 86400000).toISOString();
    mgr.setSchedule('f', future);
    expect(mgr.isEnabled('f', 'key_a')).toBe(false);
  });

  // ── Evaluation Details ────────────────────────────────────────

  it('returns evaluation reason', () => {
    mgr.createFlag({ name: 'f', rolloutPercent: 100 });
    const eval1 = mgr.evaluate('f', 'key_a');
    expect(eval1.enabled).toBe(true);
    expect(eval1.reason).toBe('rollout_included');
  });

  it('returns flag_not_found for missing flags', () => {
    const eval1 = mgr.evaluate('missing', 'key_a');
    expect(eval1.enabled).toBe(false);
    expect(eval1.reason).toBe('flag_not_found');
  });

  it('evaluates all flags for a key', () => {
    mgr.createFlag({ name: 'a', rolloutPercent: 100 });
    mgr.createFlag({ name: 'b', rolloutPercent: 0 });
    const all = mgr.evaluateAll('key_test');
    expect(all.get('a')).toBe(true);
    expect(all.get('b')).toBe(false);
  });

  // ── getEnabledKeys ────────────────────────────────────────────

  it('gets enabled keys from sample', () => {
    mgr.createFlag({ name: 'f', rolloutPercent: 100 });
    const keys = ['key_1', 'key_2', 'key_3'];
    const enabled = mgr.getEnabledKeys('f', keys);
    expect(enabled).toEqual(keys);
  });

  // ── Stats ─────────────────────────────────────────────────────

  it('tracks stats', () => {
    mgr.createFlag({ name: 'a' });
    mgr.createFlag({ name: 'b', enabled: false });
    mgr.isEnabled('a', 'key_1');
    mgr.isEnabled('b', 'key_1');

    const stats = mgr.getStats();
    expect(stats.totalFlags).toBe(2);
    expect(stats.enabledFlags).toBe(1);
    expect(stats.disabledFlags).toBe(1);
    expect(stats.totalEvaluations).toBe(2);
    expect(stats.totalEnabled).toBe(1);
    expect(stats.totalDisabled).toBe(1);
  });

  // ── Destroy ───────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    mgr.createFlag({ name: 'a' });
    mgr.destroy();
    expect(mgr.getStats().totalFlags).toBe(0);
  });
});
