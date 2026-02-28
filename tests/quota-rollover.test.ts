import { QuotaRolloverManager } from '../src/quota-rollover';

describe('QuotaRolloverManager', () => {
  let mgr: QuotaRolloverManager;

  beforeEach(() => {
    mgr = new QuotaRolloverManager({ autoAdvance: false });
  });

  // ── Quota Creation ────────────────────────────────────────────

  it('creates a quota', () => {
    const quota = mgr.createQuota({
      key: 'key_a',
      limit: 1000,
      period: 'monthly',
    });
    expect(quota.key).toBe('key_a');
    expect(quota.limit).toBe(1000);
    expect(quota.rolloverPercent).toBe(0);
    expect(quota.used).toBe(0);
  });

  it('rejects duplicate quota', () => {
    mgr.createQuota({ key: 'key_a', limit: 100, period: 'daily' });
    expect(() => mgr.createQuota({ key: 'key_a', limit: 100, period: 'daily' }))
      .toThrow('already exists');
  });

  it('rejects non-positive limit', () => {
    expect(() => mgr.createQuota({ key: 'key_a', limit: 0, period: 'daily' }))
      .toThrow('positive');
  });

  it('clamps rollover percent to 0-100', () => {
    const q = mgr.createQuota({
      key: 'key_a',
      limit: 100,
      period: 'daily',
      rolloverPercent: 150,
    });
    expect(q.rolloverPercent).toBe(100);
  });

  // ── Consumption ───────────────────────────────────────────────

  it('consumes credits against quota', () => {
    mgr.createQuota({ key: 'key_a', limit: 1000, period: 'monthly' });
    const result = mgr.consume('key_a', 200);
    expect(result.success).toBe(true);
    expect(result.consumed).toBe(200);
    expect(result.remaining).toBe(800);
  });

  it('denies consumption exceeding quota', () => {
    mgr.createQuota({ key: 'key_a', limit: 100, period: 'monthly' });
    const result = mgr.consume('key_a', 200);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient');
  });

  it('returns error for unknown key', () => {
    const result = mgr.consume('unknown', 10);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('tracks total consumption across calls', () => {
    mgr.createQuota({ key: 'key_a', limit: 1000, period: 'monthly' });
    mgr.consume('key_a', 100);
    mgr.consume('key_a', 200);
    const status = mgr.getStatus('key_a');
    expect(status!.used).toBe(300);
    expect(status!.remaining).toBe(700);
  });

  // ── Period Advancement ────────────────────────────────────────

  it('advances period and resets usage', () => {
    mgr.createQuota({ key: 'key_a', limit: 1000, period: 'monthly' });
    mgr.consume('key_a', 500);
    const event = mgr.advancePeriod('key_a');
    expect(event).not.toBeNull();
    expect(event!.unused).toBe(500);
    expect(event!.rolledOver).toBe(0); // rolloverPercent is 0
    const status = mgr.getStatus('key_a');
    expect(status!.used).toBe(0);
    expect(status!.periodsCompleted).toBe(1);
  });

  it('rolls over unused credits', () => {
    mgr.createQuota({
      key: 'key_a',
      limit: 1000,
      period: 'monthly',
      rolloverPercent: 50,
    });
    mgr.consume('key_a', 200); // 800 unused
    const event = mgr.advancePeriod('key_a');
    expect(event!.unused).toBe(800);
    expect(event!.rolledOver).toBe(400); // 50% of 800
    const status = mgr.getStatus('key_a');
    expect(status!.rollover).toBe(400);
    expect(status!.remaining).toBe(1400); // 1000 + 400
  });

  it('caps rollover at maxRollover', () => {
    mgr.createQuota({
      key: 'key_a',
      limit: 1000,
      period: 'monthly',
      rolloverPercent: 100,
      maxRollover: 200,
    });
    // 1000 unused, 100% rollover = 1000, but capped at 200
    const event = mgr.advancePeriod('key_a');
    expect(event!.rolledOver).toBe(200);
    expect(event!.cappedAt).toBe(200);
  });

  it('rolled-over credits can be consumed', () => {
    mgr.createQuota({
      key: 'key_a',
      limit: 100,
      period: 'daily',
      rolloverPercent: 100,
    });
    // Don't use any in first period → 100 rolls over
    mgr.advancePeriod('key_a');
    // Now have 200 available (100 limit + 100 rollover)
    const result = mgr.consume('key_a', 150);
    expect(result.success).toBe(true);
    expect(result.remaining).toBe(50);
  });

  it('rollover from rollover period works correctly', () => {
    mgr.createQuota({
      key: 'key_a',
      limit: 100,
      period: 'daily',
      rolloverPercent: 100,
    });
    // Period 1: 0 used → 100 rolls over
    mgr.advancePeriod('key_a');
    // Period 2: 0 used on 200 available → 200 rolls over
    mgr.advancePeriod('key_a');
    const status = mgr.getStatus('key_a');
    expect(status!.remaining).toBe(300); // 100 + 200 rollover
  });

  // ── Status ────────────────────────────────────────────────────

  it('returns status with usage percent', () => {
    mgr.createQuota({ key: 'key_a', limit: 1000, period: 'monthly' });
    mgr.consume('key_a', 250);
    const status = mgr.getStatus('key_a');
    expect(status!.usagePercent).toBe(25);
  });

  it('returns null status for unknown key', () => {
    expect(mgr.getStatus('unknown')).toBeNull();
  });

  // ── Quota Updates ─────────────────────────────────────────────

  it('updates quota limit', () => {
    mgr.createQuota({ key: 'key_a', limit: 100, period: 'daily' });
    mgr.updateLimit('key_a', 500);
    const status = mgr.getStatus('key_a');
    expect(status!.limit).toBe(500);
  });

  it('updates rollover settings', () => {
    mgr.createQuota({ key: 'key_a', limit: 100, period: 'daily', rolloverPercent: 0 });
    mgr.updateRollover('key_a', 75, 50);
    mgr.advancePeriod('key_a'); // 100 unused, 75% = 75, capped at 50
    const status = mgr.getStatus('key_a');
    expect(status!.rollover).toBe(50);
  });

  // ── Auto Advance ──────────────────────────────────────────────

  it('auto-advances expired periods on consume', () => {
    const autoMgr = new QuotaRolloverManager({ autoAdvance: true });
    const quota = autoMgr.createQuota({
      key: 'key_a',
      limit: 100,
      period: 'daily',
      rolloverPercent: 50,
    });
    // Manually expire the period
    (quota as any).periodEnd = Date.now() - 1000;
    const result = autoMgr.consume('key_a', 10);
    expect(result.success).toBe(true);
    // Period should have advanced
    const status = autoMgr.getStatus('key_a');
    expect(status!.periodsCompleted).toBeGreaterThanOrEqual(1);
    autoMgr.destroy();
  });

  // ── Rollover History ──────────────────────────────────────────

  it('tracks rollover history', () => {
    mgr.createQuota({ key: 'key_a', limit: 100, period: 'daily', rolloverPercent: 50 });
    mgr.advancePeriod('key_a');
    mgr.advancePeriod('key_a');
    const history = mgr.getRolloverHistory('key_a');
    expect(history).toHaveLength(2);
  });

  // ── Quota Management ──────────────────────────────────────────

  it('lists all quota keys', () => {
    mgr.createQuota({ key: 'key_a', limit: 100, period: 'daily' });
    mgr.createQuota({ key: 'key_b', limit: 100, period: 'daily' });
    expect(mgr.listQuotas()).toEqual(expect.arrayContaining(['key_a', 'key_b']));
  });

  it('removes a quota', () => {
    mgr.createQuota({ key: 'key_a', limit: 100, period: 'daily' });
    expect(mgr.removeQuota('key_a')).toBe(true);
    expect(mgr.getStatus('key_a')).toBeNull();
  });

  // ── Stats ─────────────────────────────────────────────────────

  it('tracks stats', () => {
    mgr.createQuota({ key: 'key_a', limit: 100, period: 'daily', rolloverPercent: 100 });
    mgr.consume('key_a', 50);
    mgr.advancePeriod('key_a');
    const stats = mgr.getStats();
    expect(stats.totalQuotas).toBe(1);
    expect(stats.totalConsumed).toBe(50);
    expect(stats.totalRollovers).toBe(1);
    expect(stats.totalRolloverCredits).toBe(50);
  });

  it('tracks denied attempts', () => {
    mgr.createQuota({ key: 'key_a', limit: 10, period: 'daily' });
    mgr.consume('key_a', 100);
    expect(mgr.getStats().totalDenied).toBe(1);
  });

  // ── Destroy ───────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    mgr.createQuota({ key: 'key_a', limit: 100, period: 'daily' });
    mgr.destroy();
    expect(mgr.getStats().totalQuotas).toBe(0);
  });
});
