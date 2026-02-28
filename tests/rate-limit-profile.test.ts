import { RateLimitProfileManager } from '../src/rate-limit-profile';

describe('RateLimitProfileManager', () => {
  let mgr: RateLimitProfileManager;

  beforeEach(() => {
    mgr = new RateLimitProfileManager();
  });

  // ── Profile Management ────────────────────────────────────────────

  it('creates a profile', () => {
    const p = mgr.createProfile({
      name: 'free',
      limits: { requestsPerMinute: 10, requestsPerHour: 100 },
    });
    expect(p.name).toBe('free');
    expect(p.limits.requestsPerMinute).toBe(10);
    expect(p.burstMultiplier).toBe(1);
    expect(p.enabled).toBe(true);
  });

  it('rejects empty profile name', () => {
    expect(() => mgr.createProfile({ name: '', limits: {} })).toThrow('required');
  });

  it('rejects duplicate profile names', () => {
    mgr.createProfile({ name: 'free', limits: {} });
    expect(() => mgr.createProfile({ name: 'free', limits: {} })).toThrow('already exists');
  });

  it('enforces max profiles', () => {
    const small = new RateLimitProfileManager({ maxProfiles: 2 });
    small.createProfile({ name: 'a', limits: {} });
    small.createProfile({ name: 'b', limits: {} });
    expect(() => small.createProfile({ name: 'c', limits: {} })).toThrow('Maximum');
  });

  it('gets profile by name', () => {
    mgr.createProfile({ name: 'pro', limits: { requestsPerMinute: 100 } });
    const p = mgr.getProfileByName('pro');
    expect(p).not.toBeNull();
    expect(p!.name).toBe('pro');
  });

  it('lists profiles', () => {
    mgr.createProfile({ name: 'a', limits: {} });
    mgr.createProfile({ name: 'b', limits: {} });
    expect(mgr.listProfiles()).toHaveLength(2);
  });

  it('removes a profile and its assignments', () => {
    mgr.createProfile({ name: 'free', limits: {} });
    mgr.assignProfile('key1', 'free');
    expect(mgr.removeProfile('free')).toBe(true);
    expect(mgr.getProfileByName('free')).toBeNull();
    expect(mgr.getKeyProfile('key1')).toBeNull();
  });

  it('updates profile limits', () => {
    mgr.createProfile({ name: 'free', limits: { requestsPerMinute: 10 } });
    mgr.updateLimits('free', { requestsPerMinute: 20 });
    expect(mgr.getProfileByName('free')!.limits.requestsPerMinute).toBe(20);
  });

  it('enables/disables a profile', () => {
    mgr.createProfile({ name: 'free', limits: {} });
    mgr.setProfileEnabled('free', false);
    expect(mgr.getProfileByName('free')!.enabled).toBe(false);
  });

  // ── Assignment ────────────────────────────────────────────────────

  it('assigns a profile to a key', () => {
    mgr.createProfile({ name: 'free', limits: {} });
    mgr.assignProfile('key1', 'free');
    expect(mgr.getKeyProfile('key1')).toBe('free');
  });

  it('rejects assignment to unknown profile', () => {
    expect(() => mgr.assignProfile('key1', 'nonexistent')).toThrow('not found');
  });

  it('unassigns a profile', () => {
    mgr.createProfile({ name: 'free', limits: {} });
    mgr.assignProfile('key1', 'free');
    expect(mgr.unassignProfile('key1')).toBe(true);
    expect(mgr.getKeyProfile('key1')).toBeNull();
  });

  it('uses default profile for unassigned keys', () => {
    const withDefault = new RateLimitProfileManager({ defaultProfile: 'free' });
    withDefault.createProfile({ name: 'free', limits: {} });
    expect(withDefault.getKeyProfile('any_key')).toBe('free');
  });

  it('lists assignments', () => {
    mgr.createProfile({ name: 'free', limits: {} });
    mgr.assignProfile('k1', 'free');
    mgr.assignProfile('k2', 'free');
    expect(mgr.listAssignments()).toHaveLength(2);
  });

  // ── Rate Limiting ─────────────────────────────────────────────────

  it('allows requests within limits', () => {
    mgr.createProfile({ name: 'free', limits: { requestsPerMinute: 10 } });
    mgr.assignProfile('k1', 'free');
    const check = mgr.checkLimit('k1');
    expect(check.allowed).toBe(true);
    expect(check.profile).toBe('free');
    expect(check.currentMinute).toBe(1);
  });

  it('denies requests exceeding minute limit', () => {
    mgr.createProfile({ name: 'strict', limits: { requestsPerMinute: 2 } });
    mgr.assignProfile('k1', 'strict');
    mgr.checkLimit('k1');
    mgr.checkLimit('k1');
    const third = mgr.checkLimit('k1');
    expect(third.allowed).toBe(false);
    expect(third.reason).toContain('Minute');
    expect(third.retryAfterMs).not.toBeNull();
  });

  it('denies requests exceeding hour limit', () => {
    mgr.createProfile({ name: 'hourly', limits: { requestsPerHour: 3 } });
    mgr.assignProfile('k1', 'hourly');
    mgr.checkLimit('k1');
    mgr.checkLimit('k1');
    mgr.checkLimit('k1');
    const fourth = mgr.checkLimit('k1');
    expect(fourth.allowed).toBe(false);
    expect(fourth.reason).toContain('Hour');
  });

  it('denies requests exceeding day limit', () => {
    mgr.createProfile({ name: 'daily', limits: { requestsPerDay: 2 } });
    mgr.assignProfile('k1', 'daily');
    mgr.checkLimit('k1');
    mgr.checkLimit('k1');
    const third = mgr.checkLimit('k1');
    expect(third.allowed).toBe(false);
    expect(third.reason).toContain('Day');
  });

  it('applies burst multiplier', () => {
    mgr.createProfile({ name: 'burst', limits: { requestsPerMinute: 2 }, burstMultiplier: 2 });
    mgr.assignProfile('k1', 'burst');
    // Effective limit = 2 * 2 = 4
    mgr.checkLimit('k1');
    mgr.checkLimit('k1');
    mgr.checkLimit('k1');
    const fourth = mgr.checkLimit('k1');
    expect(fourth.allowed).toBe(true);
    const fifth = mgr.checkLimit('k1');
    expect(fifth.allowed).toBe(false);
  });

  it('allows when no profile assigned', () => {
    const check = mgr.checkLimit('unassigned');
    expect(check.allowed).toBe(true);
    expect(check.profile).toBe('none');
  });

  it('allows when profile is disabled', () => {
    mgr.createProfile({ name: 'strict', limits: { requestsPerMinute: 1 } });
    mgr.assignProfile('k1', 'strict');
    mgr.setProfileEnabled('strict', false);
    mgr.checkLimit('k1');
    const second = mgr.checkLimit('k1');
    expect(second.allowed).toBe(true);
    expect(second.reason).toContain('disabled');
  });

  it('resets counters for a key', () => {
    mgr.createProfile({ name: 'strict', limits: { requestsPerMinute: 2 } });
    mgr.assignProfile('k1', 'strict');
    mgr.checkLimit('k1');
    mgr.checkLimit('k1');
    mgr.resetCounters('k1');
    const check = mgr.checkLimit('k1');
    expect(check.allowed).toBe(true);
    expect(check.currentMinute).toBe(1);
  });

  // ── Stats ─────────────────────────────────────────────────────────

  it('tracks stats', () => {
    mgr.createProfile({ name: 'free', limits: { requestsPerMinute: 1 } });
    mgr.assignProfile('k1', 'free');
    mgr.checkLimit('k1');
    mgr.checkLimit('k1');

    const stats = mgr.getStats();
    expect(stats.totalProfiles).toBe(1);
    expect(stats.enabledProfiles).toBe(1);
    expect(stats.totalAssignments).toBe(1);
    expect(stats.totalChecks).toBe(2);
    expect(stats.totalAllowed).toBe(1);
    expect(stats.totalDenied).toBe(1);
  });

  // ── Destroy ───────────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    mgr.createProfile({ name: 'free', limits: {} });
    mgr.assignProfile('k1', 'free');
    mgr.checkLimit('k1');
    mgr.destroy();
    const stats = mgr.getStats();
    expect(stats.totalProfiles).toBe(0);
    expect(stats.totalAssignments).toBe(0);
    expect(stats.totalChecks).toBe(0);
  });
});
