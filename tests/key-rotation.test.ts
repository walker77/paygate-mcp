import { KeyRotationScheduler } from '../src/key-rotation';

describe('KeyRotationScheduler', () => {
  let scheduler: KeyRotationScheduler;

  beforeEach(() => {
    scheduler = new KeyRotationScheduler();
  });

  afterEach(() => {
    scheduler.destroy();
  });

  // ─── Policy Management ──────────────────────────────────────────

  test('upsert and retrieve a policy', () => {
    const ok = scheduler.upsertPolicy({
      id: 'monthly',
      name: 'Monthly Rotation',
      intervalSeconds: 2592000,
      gracePeriodSeconds: 86400,
      autoGenerate: true,
      copyCredits: true,
      copyAcl: true,
      active: true,
    });
    expect(ok).toBe(true);

    const p = scheduler.getPolicy('monthly');
    expect(p).toBeTruthy();
    expect(p!.name).toBe('Monthly Rotation');
    expect(p!.createdAt).toBeTruthy();
  });

  test('list all policies', () => {
    scheduler.upsertPolicy({ id: 'a', name: 'A', intervalSeconds: 60, gracePeriodSeconds: 10, autoGenerate: true, copyCredits: true, copyAcl: true, active: true });
    scheduler.upsertPolicy({ id: 'b', name: 'B', intervalSeconds: 120, gracePeriodSeconds: 20, autoGenerate: false, copyCredits: false, copyAcl: false, active: false });
    expect(scheduler.getPolicies().length).toBe(2);
  });

  test('remove a policy', () => {
    scheduler.upsertPolicy({ id: 'del', name: 'Del', intervalSeconds: 60, gracePeriodSeconds: 0, autoGenerate: true, copyCredits: true, copyAcl: true, active: true });
    expect(scheduler.removePolicy('del')).toBe(true);
    expect(scheduler.getPolicy('del')).toBeNull();
  });

  test('enforce max policies limit', () => {
    const s = new KeyRotationScheduler({ maxPolicies: 2 });
    s.upsertPolicy({ id: 'a', name: 'A', intervalSeconds: 60, gracePeriodSeconds: 0, autoGenerate: true, copyCredits: true, copyAcl: true, active: true });
    s.upsertPolicy({ id: 'b', name: 'B', intervalSeconds: 60, gracePeriodSeconds: 0, autoGenerate: true, copyCredits: true, copyAcl: true, active: true });
    const ok = s.upsertPolicy({ id: 'c', name: 'C', intervalSeconds: 60, gracePeriodSeconds: 0, autoGenerate: true, copyCredits: true, copyAcl: true, active: true });
    expect(ok).toBe(false);
    s.destroy();
  });

  test('update existing policy', () => {
    scheduler.upsertPolicy({ id: 'up', name: 'Old', intervalSeconds: 60, gracePeriodSeconds: 0, autoGenerate: true, copyCredits: true, copyAcl: true, active: true });
    scheduler.upsertPolicy({ id: 'up', name: 'New', intervalSeconds: 120, gracePeriodSeconds: 30, autoGenerate: false, copyCredits: false, copyAcl: false, active: true });
    const p = scheduler.getPolicy('up');
    expect(p!.name).toBe('New');
    expect(p!.intervalSeconds).toBe(120);
  });

  // ─── Key Scheduling ─────────────────────────────────────────────

  test('schedule key with policy', () => {
    scheduler.upsertPolicy({ id: 'p1', name: 'P1', intervalSeconds: 3600, gracePeriodSeconds: 60, autoGenerate: true, copyCredits: true, copyAcl: true, active: true });
    const ok = scheduler.scheduleKey('key_abc', 'p1');
    expect(ok).toBe(true);

    const schedule = scheduler.getSchedule('key_abc');
    expect(schedule).toBeTruthy();
    expect(schedule!.policyId).toBe('p1');
    expect(schedule!.graceActive).toBe(false);
  });

  test('reject scheduling with inactive policy', () => {
    scheduler.upsertPolicy({ id: 'inactive', name: 'Inactive', intervalSeconds: 3600, gracePeriodSeconds: 0, autoGenerate: true, copyCredits: true, copyAcl: true, active: false });
    const ok = scheduler.scheduleKey('key_abc', 'inactive');
    expect(ok).toBe(false);
  });

  test('reject scheduling with nonexistent policy', () => {
    expect(scheduler.scheduleKey('key_abc', 'nonexistent')).toBe(false);
  });

  test('unschedule key', () => {
    scheduler.upsertPolicy({ id: 'p', name: 'P', intervalSeconds: 60, gracePeriodSeconds: 0, autoGenerate: true, copyCredits: true, copyAcl: true, active: true });
    scheduler.scheduleKey('key_del', 'p');
    expect(scheduler.unscheduleKey('key_del')).toBe(true);
    expect(scheduler.getSchedule('key_del')).toBeNull();
  });

  test('list all schedules', () => {
    scheduler.upsertPolicy({ id: 'p', name: 'P', intervalSeconds: 60, gracePeriodSeconds: 0, autoGenerate: true, copyCredits: true, copyAcl: true, active: true });
    scheduler.scheduleKey('k1', 'p');
    scheduler.scheduleKey('k2', 'p');
    expect(scheduler.getSchedules().length).toBe(2);
  });

  // ─── Due Keys Detection ─────────────────────────────────────────

  test('detect keys due for rotation', () => {
    scheduler.upsertPolicy({ id: 'fast', name: 'Fast', intervalSeconds: 0, gracePeriodSeconds: 0, autoGenerate: true, copyCredits: true, copyAcl: true, active: true });
    scheduler.scheduleKey('key_due', 'fast');

    // Manually set nextRotationAt to the past
    const schedule = scheduler.getSchedule('key_due')!;
    (schedule as any).nextRotationAt = new Date(Date.now() - 1000).toISOString();

    const due = scheduler.getDueKeys();
    expect(due).toContain('key_due');
  });

  test('keys not yet due are excluded', () => {
    scheduler.upsertPolicy({ id: 'slow', name: 'Slow', intervalSeconds: 86400, gracePeriodSeconds: 0, autoGenerate: true, copyCredits: true, copyAcl: true, active: true });
    scheduler.scheduleKey('key_future', 'slow');

    const due = scheduler.getDueKeys();
    expect(due).not.toContain('key_future');
  });

  // ─── Key Rotation ───────────────────────────────────────────────

  test('rotate key without grace period', () => {
    scheduler.upsertPolicy({ id: 'no-grace', name: 'No Grace', intervalSeconds: 3600, gracePeriodSeconds: 0, autoGenerate: true, copyCredits: true, copyAcl: true, active: true });
    scheduler.scheduleKey('old_key', 'no-grace');

    const event = scheduler.rotate('old_key', 'new_key', 'manual');
    expect(event).toBeTruthy();
    expect(event!.oldKey).toBe('old_key');
    expect(event!.newKey).toBe('new_key');
    expect(event!.trigger).toBe('manual');
    expect(event!.graceActive).toBe(false);

    // Old schedule gone, new one exists
    expect(scheduler.getSchedule('old_key')).toBeNull();
    expect(scheduler.getSchedule('new_key')).toBeTruthy();
  });

  test('rotate key with grace period', () => {
    scheduler.upsertPolicy({ id: 'grace', name: 'Grace', intervalSeconds: 3600, gracePeriodSeconds: 300, autoGenerate: true, copyCredits: true, copyAcl: true, active: true });
    scheduler.scheduleKey('old_key', 'grace');

    const event = scheduler.rotate('old_key', 'new_key', 'auto');
    expect(event!.graceActive).toBe(true);

    const newSchedule = scheduler.getSchedule('new_key');
    expect(newSchedule!.graceActive).toBe(true);
    expect(newSchedule!.gracePreviousKey).toBe('old_key');
    expect(newSchedule!.graceExpiresAt).toBeTruthy();
  });

  test('rotate returns null for unscheduled key', () => {
    expect(scheduler.rotate('unknown', 'new', 'manual')).toBeNull();
  });

  // ─── Grace Period ───────────────────────────────────────────────

  test('grace key detection', () => {
    scheduler.upsertPolicy({ id: 'g', name: 'G', intervalSeconds: 3600, gracePeriodSeconds: 300, autoGenerate: true, copyCredits: true, copyAcl: true, active: true });
    scheduler.scheduleKey('old', 'g');
    scheduler.rotate('old', 'new', 'auto');

    expect(scheduler.getGraceKeys()).toContain('new');
  });

  test('isKeyValid for current and grace keys', () => {
    scheduler.upsertPolicy({ id: 'g2', name: 'G2', intervalSeconds: 3600, gracePeriodSeconds: 300, autoGenerate: true, copyCredits: true, copyAcl: true, active: true });
    scheduler.scheduleKey('old2', 'g2');
    scheduler.rotate('old2', 'new2', 'auto');

    expect(scheduler.isKeyValid('new2')).toBe(true);
    expect(scheduler.isKeyValid('old2')).toBe(true); // In grace period
    expect(scheduler.isKeyValid('unknown')).toBe(false);
  });

  test('expire grace periods', () => {
    scheduler.upsertPolicy({ id: 'exp', name: 'Exp', intervalSeconds: 3600, gracePeriodSeconds: 1, autoGenerate: true, copyCredits: true, copyAcl: true, active: true });
    scheduler.scheduleKey('exp_old', 'exp');
    scheduler.rotate('exp_old', 'exp_new', 'auto');

    // Manually set grace expiry to the past
    const schedule = scheduler.getSchedule('exp_new')!;
    (schedule as any).graceExpiresAt = new Date(Date.now() - 1000).toISOString();

    const expired = scheduler.expireGracePeriods();
    expect(expired).toContain('exp_old');

    // Grace no longer active
    expect(scheduler.getSchedule('exp_new')!.graceActive).toBe(false);
    expect(scheduler.isKeyValid('exp_old')).toBe(false);
  });

  // ─── History ────────────────────────────────────────────────────

  test('track rotation history', () => {
    scheduler.upsertPolicy({ id: 'h', name: 'H', intervalSeconds: 60, gracePeriodSeconds: 0, autoGenerate: true, copyCredits: true, copyAcl: true, active: true });
    scheduler.scheduleKey('k1', 'h');
    scheduler.rotate('k1', 'k2', 'manual');
    scheduler.rotate('k2', 'k3', 'auto');

    const history = scheduler.getHistory();
    expect(history.length).toBe(2);
    expect(history[0].oldKey).toBe('k1');
    expect(history[1].oldKey).toBe('k2');
  });

  test('filter history by key', () => {
    scheduler.upsertPolicy({ id: 'hf', name: 'HF', intervalSeconds: 60, gracePeriodSeconds: 0, autoGenerate: true, copyCredits: true, copyAcl: true, active: true });
    scheduler.scheduleKey('a', 'hf');
    scheduler.rotate('a', 'b', 'manual');
    scheduler.scheduleKey('c', 'hf');
    scheduler.rotate('c', 'd', 'manual');

    const history = scheduler.getHistory(100, 'a');
    expect(history.length).toBe(1);
    expect(history[0].oldKey).toBe('a');
  });

  // ─── Stats ──────────────────────────────────────────────────────

  test('stats track rotations', () => {
    scheduler.upsertPolicy({ id: 'st', name: 'ST', intervalSeconds: 60, gracePeriodSeconds: 0, autoGenerate: true, copyCredits: true, copyAcl: true, active: true });
    scheduler.scheduleKey('s1', 'st');
    scheduler.rotate('s1', 's2', 'manual');
    scheduler.rotate('s2', 's3', 'auto');

    const stats = scheduler.getStats();
    expect(stats.totalPolicies).toBe(1);
    expect(stats.activePolicies).toBe(1);
    expect(stats.scheduledKeys).toBe(1);
    expect(stats.totalRotations).toBe(2);
    expect(stats.autoRotations).toBe(1);
    expect(stats.manualRotations).toBe(1);
  });

  test('resetStats clears counters', () => {
    scheduler.upsertPolicy({ id: 'rs', name: 'RS', intervalSeconds: 60, gracePeriodSeconds: 0, autoGenerate: true, copyCredits: true, copyAcl: true, active: true });
    scheduler.scheduleKey('r1', 'rs');
    scheduler.rotate('r1', 'r2', 'manual');
    scheduler.resetStats();
    expect(scheduler.getStats().totalRotations).toBe(0);
  });

  test('destroy clears everything', () => {
    scheduler.upsertPolicy({ id: 'd', name: 'D', intervalSeconds: 60, gracePeriodSeconds: 0, autoGenerate: true, copyCredits: true, copyAcl: true, active: true });
    scheduler.scheduleKey('dk', 'd');
    scheduler.destroy();

    expect(scheduler.getPolicies().length).toBe(0);
    expect(scheduler.getSchedules().length).toBe(0);
    expect(scheduler.getHistory().length).toBe(0);
  });
});
