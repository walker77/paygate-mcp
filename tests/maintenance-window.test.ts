import { MaintenanceWindowManager } from '../src/maintenance-window';

describe('MaintenanceWindowManager', () => {
  let mgr: MaintenanceWindowManager;

  beforeEach(() => {
    mgr = new MaintenanceWindowManager();
  });

  // ── Scheduling ────────────────────────────────────────────────────

  it('schedules a future window', () => {
    const w = mgr.scheduleWindow({
      name: 'DB Migration',
      startsAt: Date.now() + 3_600_000,
      durationMs: 1_800_000,
    });
    expect(w.name).toBe('DB Migration');
    expect(w.status).toBe('scheduled');
    expect(w.blockTraffic).toBe(true);
  });

  it('rejects empty name', () => {
    expect(() => mgr.scheduleWindow({ name: '', startsAt: Date.now(), durationMs: 1000 })).toThrow('required');
  });

  it('rejects zero duration', () => {
    expect(() => mgr.scheduleWindow({ name: 'x', startsAt: Date.now(), durationMs: 0 })).toThrow('positive');
  });

  it('enforces max windows', () => {
    const small = new MaintenanceWindowManager({ maxWindows: 2 });
    small.scheduleWindow({ name: 'a', startsAt: Date.now() + 10000, durationMs: 1000 });
    small.scheduleWindow({ name: 'b', startsAt: Date.now() + 20000, durationMs: 1000 });
    expect(() => small.scheduleWindow({ name: 'c', startsAt: Date.now() + 30000, durationMs: 1000 })).toThrow('Maximum');
  });

  it('starts now creates active window', () => {
    const w = mgr.startNow({ name: 'Emergency', durationMs: 60_000 });
    expect(w.status).toBe('active');
  });

  it('auto-activates window when startsAt is in past', () => {
    const w = mgr.scheduleWindow({
      name: 'Already started',
      startsAt: Date.now() - 1000,
      durationMs: 60_000,
    });
    expect(w.status).toBe('active');
  });

  // ── Window Lifecycle ──────────────────────────────────────────────

  it('cancels a scheduled window', () => {
    const w = mgr.scheduleWindow({ name: 'x', startsAt: Date.now() + 60000, durationMs: 1000 });
    const cancelled = mgr.cancelWindow(w.id);
    expect(cancelled.status).toBe('cancelled');
  });

  it('completes a window early', () => {
    const w = mgr.startNow({ name: 'x', durationMs: 60_000 });
    const completed = mgr.completeWindow(w.id);
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).not.toBeNull();
  });

  it('throws when cancelling completed window', () => {
    const w = mgr.startNow({ name: 'x', durationMs: 60_000 });
    mgr.completeWindow(w.id);
    expect(() => mgr.cancelWindow(w.id)).toThrow('already completed');
  });

  it('throws for unknown window', () => {
    expect(() => mgr.cancelWindow('unknown')).toThrow('not found');
  });

  it('gets window by ID', () => {
    const w = mgr.scheduleWindow({ name: 'x', startsAt: Date.now() + 60000, durationMs: 1000 });
    expect(mgr.getWindow(w.id)).not.toBeNull();
    expect(mgr.getWindow(w.id)!.name).toBe('x');
  });

  it('lists windows with status filter', () => {
    mgr.startNow({ name: 'active', durationMs: 60_000 });
    mgr.scheduleWindow({ name: 'future', startsAt: Date.now() + 60000, durationMs: 1000 });
    expect(mgr.listWindows({ status: 'active' })).toHaveLength(1);
    expect(mgr.listWindows({ status: 'scheduled' })).toHaveLength(1);
  });

  // ── Status ────────────────────────────────────────────────────────

  it('reports operational when no active windows', () => {
    mgr.scheduleWindow({ name: 'future', startsAt: Date.now() + 60000, durationMs: 1000 });
    const status = mgr.getStatus();
    expect(status.operational).toBe(true);
    expect(status.activeWindows).toHaveLength(0);
    expect(status.nextWindow).not.toBeNull();
  });

  it('reports non-operational during blocking window', () => {
    mgr.startNow({ name: 'Maintenance', durationMs: 60_000, message: 'Down for maintenance' });
    const status = mgr.getStatus();
    expect(status.operational).toBe(false);
    expect(status.message).toBe('Down for maintenance');
    expect(status.activeWindows).toHaveLength(1);
  });

  it('reports operational during non-blocking window', () => {
    mgr.startNow({ name: 'bg task', durationMs: 60_000, blockTraffic: false });
    const status = mgr.getStatus();
    expect(status.operational).toBe(true);
    expect(status.activeWindows).toHaveLength(1);
  });

  it('isBlocked returns correct state', () => {
    expect(mgr.isBlocked()).toBe(false);
    mgr.startNow({ name: 'x', durationMs: 60_000 });
    expect(mgr.isBlocked()).toBe(true);
  });

  it('checks affected services', () => {
    mgr.startNow({ name: 'x', durationMs: 60_000, affectedServices: ['api', 'db'] });
    expect(mgr.isServiceAffected('api')).toBe(true);
    expect(mgr.isServiceAffected('cache')).toBe(false);
  });

  // ── Auto-Complete ─────────────────────────────────────────────────

  it('auto-completes expired windows', () => {
    const w = mgr.scheduleWindow({
      name: 'past',
      startsAt: Date.now() - 10_000,
      durationMs: 5_000, // ended 5 seconds ago
    });
    const fetched = mgr.getWindow(w.id)!;
    expect(fetched.status).toBe('completed');
  });

  // ── Stats ─────────────────────────────────────────────────────────

  it('tracks stats', () => {
    mgr.startNow({ name: 'active', durationMs: 60_000 });
    const w = mgr.scheduleWindow({ name: 'future', startsAt: Date.now() + 60000, durationMs: 1000 });
    mgr.cancelWindow(w.id);
    const stats = mgr.getStats();
    expect(stats.totalWindows).toBe(2);
    expect(stats.activeWindows).toBe(1);
    expect(stats.cancelledWindows).toBe(1);
  });

  // ── Destroy ───────────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    mgr.startNow({ name: 'x', durationMs: 60_000 });
    mgr.destroy();
    expect(mgr.getStats().totalWindows).toBe(0);
  });
});
