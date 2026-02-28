import { SessionManager } from '../src/session-manager';

describe('SessionManager', () => {
  let mgr: SessionManager;

  beforeEach(() => {
    mgr = new SessionManager();
  });

  // ── Session Lifecycle ─────────────────────────────────────────────

  it('creates a session', () => {
    const s = mgr.createSession({ key: 'key_abc' });
    expect(s.key).toBe('key_abc');
    expect(s.status).toBe('active');
    expect(s.totalCalls).toBe(0);
    expect(s.totalCredits).toBe(0);
  });

  it('rejects session without key', () => {
    expect(() => mgr.createSession({ key: '' })).toThrow('required');
  });

  it('enforces max active sessions', () => {
    const small = new SessionManager({ maxActiveSessions: 2 });
    small.createSession({ key: 'a' });
    small.createSession({ key: 'b' });
    expect(() => small.createSession({ key: 'c' })).toThrow('Maximum');
  });

  it('ends a session', () => {
    const s = mgr.createSession({ key: 'k' });
    const ended = mgr.endSession(s.id);
    expect(ended.status).toBe('ended');
    expect(ended.endedAt).not.toBeNull();
  });

  it('throws when ending non-active session', () => {
    const s = mgr.createSession({ key: 'k' });
    mgr.endSession(s.id);
    expect(() => mgr.endSession(s.id)).toThrow('not active');
  });

  it('throws when ending unknown session', () => {
    expect(() => mgr.endSession('unknown')).toThrow('not found');
  });

  it('gets session by id', () => {
    const s = mgr.createSession({ key: 'k' });
    expect(mgr.getSession(s.id)).not.toBeNull();
    expect(mgr.getSession(s.id)!.key).toBe('k');
  });

  it('returns null for unknown session', () => {
    expect(mgr.getSession('unknown')).toBeNull();
  });

  it('handles session expiry via TTL', () => {
    const s = mgr.createSession({ key: 'k', ttlMs: 1 }); // 1ms TTL
    // Wait a tiny bit for TTL to expire
    const start = Date.now();
    while (Date.now() - start < 5) { /* busy wait */ }
    const fetched = mgr.getSession(s.id);
    expect(fetched!.status).toBe('expired');
  });

  it('gets active sessions for a key', () => {
    mgr.createSession({ key: 'k1' });
    mgr.createSession({ key: 'k1' });
    mgr.createSession({ key: 'k2' });
    expect(mgr.getActiveSessions('k1')).toHaveLength(2);
    expect(mgr.getActiveSessions('k2')).toHaveLength(1);
  });

  it('lists sessions with filters', () => {
    const s1 = mgr.createSession({ key: 'k1' });
    mgr.createSession({ key: 'k2' });
    mgr.endSession(s1.id);
    expect(mgr.listSessions({ status: 'active' })).toHaveLength(1);
    expect(mgr.listSessions({ key: 'k1' })).toHaveLength(1);
  });

  // ── Call Recording ────────────────────────────────────────────────

  it('records tool calls', () => {
    const s = mgr.createSession({ key: 'k' });
    mgr.recordCall(s.id, 'search', 5);
    mgr.recordCall(s.id, 'summarize', 3);
    const session = mgr.getSession(s.id)!;
    expect(session.totalCalls).toBe(2);
    expect(session.totalCredits).toBe(8);
    expect(session.calls).toHaveLength(2);
  });

  it('rejects call recording on non-active session', () => {
    const s = mgr.createSession({ key: 'k' });
    mgr.endSession(s.id);
    expect(() => mgr.recordCall(s.id, 'x', 1)).toThrow('not active');
  });

  it('rejects call recording on unknown session', () => {
    expect(() => mgr.recordCall('unknown', 'x', 1)).toThrow('not found');
  });

  // ── Reports ───────────────────────────────────────────────────────

  it('generates session report', () => {
    const s = mgr.createSession({ key: 'k' });
    mgr.recordCall(s.id, 'search', 5);
    mgr.recordCall(s.id, 'search', 5);
    mgr.recordCall(s.id, 'summarize', 3);
    mgr.endSession(s.id);

    const report = mgr.getSessionReport(s.id)!;
    expect(report.totalCalls).toBe(3);
    expect(report.totalCredits).toBe(13);
    expect(report.toolBreakdown).toHaveLength(2);
    expect(report.toolBreakdown[0].tool).toBe('search'); // highest credits first
    expect(report.toolBreakdown[0].calls).toBe(2);
  });

  it('returns null report for unknown session', () => {
    expect(mgr.getSessionReport('unknown')).toBeNull();
  });

  it('generates key report', () => {
    const s1 = mgr.createSession({ key: 'k1' });
    const s2 = mgr.createSession({ key: 'k1' });
    mgr.recordCall(s1.id, 'a', 10);
    mgr.recordCall(s2.id, 'b', 5);

    const report = mgr.getKeyReport('k1');
    expect(report.totalSessions).toBe(2);
    expect(report.totalCalls).toBe(2);
    expect(report.totalCredits).toBe(15);
    expect(report.activeSessions).toBe(2);
  });

  it('returns empty key report for unknown key', () => {
    const report = mgr.getKeyReport('unknown');
    expect(report.totalSessions).toBe(0);
  });

  // ── Cleanup ───────────────────────────────────────────────────────

  it('cleans up old ended sessions', () => {
    const s = mgr.createSession({ key: 'k' });
    mgr.endSession(s.id);
    // Set endedAt to the past
    const session = mgr.getSession(s.id)!;
    (session as any).endedAt = Date.now() - 100_000;
    const removed = mgr.cleanup(50_000);
    expect(removed).toBe(1);
    expect(mgr.getSession(s.id)).toBeNull();
  });

  // ── Stats ─────────────────────────────────────────────────────────

  it('tracks stats', () => {
    const s1 = mgr.createSession({ key: 'k' });
    mgr.createSession({ key: 'k' });
    mgr.recordCall(s1.id, 'x', 5);
    mgr.endSession(s1.id);

    const stats = mgr.getStats();
    expect(stats.totalSessions).toBe(2);
    expect(stats.activeSessions).toBe(1);
    expect(stats.endedSessions).toBe(1);
    expect(stats.totalCalls).toBe(1);
    expect(stats.totalCredits).toBe(5);
  });

  // ── Destroy ───────────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    mgr.createSession({ key: 'k' });
    mgr.destroy();
    expect(mgr.getStats().totalSessions).toBe(0);
  });
});
