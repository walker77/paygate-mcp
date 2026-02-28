import { CreditReservationManager } from '../src/credit-reservation';

describe('CreditReservationManager', () => {
  let mgr: CreditReservationManager;

  beforeEach(() => {
    mgr = new CreditReservationManager({ autoExpireIntervalMs: 0 }); // disable auto-expire timer
  });

  afterEach(() => {
    mgr.destroy();
  });

  // ─── Balance ──────────────────────────────────────────────────────

  test('set and get balance', () => {
    mgr.setBalance('k1', 1000);
    expect(mgr.getBalance('k1')).toBe(1000);
    expect(mgr.getBalance('unknown')).toBe(0);
  });

  test('available balance subtracts held', () => {
    mgr.setBalance('k1', 1000);
    mgr.reserve({ key: 'k1', amount: 300 });
    expect(mgr.getAvailableBalance('k1')).toBe(700);
    expect(mgr.getHeldBalance('k1')).toBe(300);
  });

  // ─── Reserve ──────────────────────────────────────────────────────

  test('reserve credits successfully', () => {
    mgr.setBalance('k1', 1000);
    const result = mgr.reserve({ key: 'k1', amount: 200, tool: 'search' });
    expect(result.success).toBe(true);
    expect(result.id).toMatch(/^res_/);
    expect(mgr.getAvailableBalance('k1')).toBe(800);
  });

  test('reserve fails with insufficient balance', () => {
    mgr.setBalance('k1', 100);
    const result = mgr.reserve({ key: 'k1', amount: 500 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('insufficient');
  });

  test('reserve fails with non-positive amount', () => {
    mgr.setBalance('k1', 1000);
    expect(mgr.reserve({ key: 'k1', amount: 0 }).success).toBe(false);
    expect(mgr.reserve({ key: 'k1', amount: -10 }).success).toBe(false);
  });

  test('reserve respects max amount', () => {
    const m = new CreditReservationManager({ maxReservationAmount: 500, autoExpireIntervalMs: 0 });
    m.setBalance('k1', 10000);
    const result = m.reserve({ key: 'k1', amount: 1000 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('max reservation');
    m.destroy();
  });

  test('reserve respects max per key', () => {
    const m = new CreditReservationManager({ maxReservationsPerKey: 2, autoExpireIntervalMs: 0 });
    m.setBalance('k1', 10000);
    m.reserve({ key: 'k1', amount: 10 });
    m.reserve({ key: 'k1', amount: 10 });
    const result = m.reserve({ key: 'k1', amount: 10 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('max reservations');
    m.destroy();
  });

  test('multiple reservations reduce available balance', () => {
    mgr.setBalance('k1', 1000);
    mgr.reserve({ key: 'k1', amount: 200 });
    mgr.reserve({ key: 'k1', amount: 300 });
    expect(mgr.getAvailableBalance('k1')).toBe(500);
    expect(mgr.getHeldBalance('k1')).toBe(500);
  });

  // ─── Settle ───────────────────────────────────────────────────────

  test('settle deducts actual amount from balance', () => {
    mgr.setBalance('k1', 1000);
    const res = mgr.reserve({ key: 'k1', amount: 200 });
    expect(mgr.settle(res.id, 150)).toBe(true);
    expect(mgr.getBalance('k1')).toBe(850); // 1000 - 150
    expect(mgr.getHeldBalance('k1')).toBe(0); // reservation cleared
  });

  test('settle with no amount uses reserved amount', () => {
    mgr.setBalance('k1', 1000);
    const res = mgr.reserve({ key: 'k1', amount: 200 });
    expect(mgr.settle(res.id)).toBe(true);
    expect(mgr.getBalance('k1')).toBe(800);
  });

  test('settle updates reservation status', () => {
    mgr.setBalance('k1', 1000);
    const res = mgr.reserve({ key: 'k1', amount: 200 });
    mgr.settle(res.id, 100);
    const reservation = mgr.getReservation(res.id)!;
    expect(reservation.status).toBe('settled');
    expect(reservation.settledAmount).toBe(100);
    expect(reservation.settledAt).toBeTruthy();
  });

  test('cannot settle non-held reservation', () => {
    mgr.setBalance('k1', 1000);
    const res = mgr.reserve({ key: 'k1', amount: 200 });
    mgr.settle(res.id);
    expect(mgr.settle(res.id)).toBe(false); // already settled
  });

  test('settle nonexistent reservation returns false', () => {
    expect(mgr.settle('nonexistent')).toBe(false);
  });

  // ─── Release ──────────────────────────────────────────────────────

  test('release returns credits to available pool', () => {
    mgr.setBalance('k1', 1000);
    const res = mgr.reserve({ key: 'k1', amount: 300 });
    expect(mgr.getAvailableBalance('k1')).toBe(700);
    expect(mgr.release(res.id)).toBe(true);
    expect(mgr.getAvailableBalance('k1')).toBe(1000); // fully restored
    expect(mgr.getBalance('k1')).toBe(1000); // balance unchanged
  });

  test('release updates reservation status', () => {
    mgr.setBalance('k1', 1000);
    const res = mgr.reserve({ key: 'k1', amount: 200 });
    mgr.release(res.id);
    const reservation = mgr.getReservation(res.id)!;
    expect(reservation.status).toBe('released');
    expect(reservation.releasedAt).toBeTruthy();
  });

  test('cannot release non-held reservation', () => {
    mgr.setBalance('k1', 1000);
    const res = mgr.reserve({ key: 'k1', amount: 200 });
    mgr.release(res.id);
    expect(mgr.release(res.id)).toBe(false);
  });

  // ─── Expiration ───────────────────────────────────────────────────

  test('expire reservations past TTL', () => {
    mgr.setBalance('k1', 1000);
    const res = mgr.reserve({ key: 'k1', amount: 200, ttlSeconds: 1 });

    // Manually set expiry to the past
    const reservation = mgr.getReservation(res.id)!;
    (reservation as any).expiresAt = Date.now() - 1000;

    const expired = mgr.expireReservations();
    expect(expired).toBe(1);
    expect(mgr.getReservation(res.id)!.status).toBe('expired');
    expect(mgr.getAvailableBalance('k1')).toBe(1000); // credits freed
  });

  // ─── Query ────────────────────────────────────────────────────────

  test('get active reservations for key', () => {
    mgr.setBalance('k1', 10000);
    mgr.reserve({ key: 'k1', amount: 100, tool: 'search' });
    mgr.reserve({ key: 'k1', amount: 200, tool: 'generate' });
    const res3 = mgr.reserve({ key: 'k1', amount: 300 });
    mgr.settle(res3.id);

    const active = mgr.getActiveReservations('k1');
    expect(active.length).toBe(2);
  });

  test('get key reservations all statuses', () => {
    mgr.setBalance('k1', 10000);
    mgr.reserve({ key: 'k1', amount: 100 });
    const res2 = mgr.reserve({ key: 'k1', amount: 200 });
    mgr.settle(res2.id);

    const all = mgr.getKeyReservations('k1');
    expect(all.length).toBe(2);
  });

  test('get key reservations with limit', () => {
    mgr.setBalance('k1', 10000);
    for (let i = 0; i < 5; i++) mgr.reserve({ key: 'k1', amount: 10 });
    expect(mgr.getKeyReservations('k1', 2).length).toBe(2);
  });

  test('getReservation returns null for unknown ID', () => {
    expect(mgr.getReservation('nonexistent')).toBeNull();
  });

  // ─── Stats ────────────────────────────────────────────────────────

  test('stats track reservations', () => {
    mgr.setBalance('k1', 10000);
    mgr.setBalance('k2', 5000);
    const r1 = mgr.reserve({ key: 'k1', amount: 100 });
    const r2 = mgr.reserve({ key: 'k1', amount: 200 });
    const r3 = mgr.reserve({ key: 'k2', amount: 150 });
    mgr.settle(r1.id, 80);
    mgr.release(r2.id);

    const stats = mgr.getStats();
    expect(stats.totalReservations).toBe(3);
    expect(stats.activeReservations).toBe(1); // r3 still held
    expect(stats.totalSettled).toBe(1);
    expect(stats.totalReleased).toBe(1);
    expect(stats.totalCreditsSettled).toBe(80);
    expect(stats.totalCreditsReleased).toBe(200);
    expect(stats.trackedKeys).toBe(2);
  });

  test('destroy clears everything', () => {
    mgr.setBalance('k1', 1000);
    mgr.reserve({ key: 'k1', amount: 100 });
    mgr.destroy();
    expect(mgr.getBalance('k1')).toBe(0);
    expect(mgr.getStats().totalReservations).toBe(0);
  });
});
