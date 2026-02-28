/**
 * SessionManager — Track multi-request agent sessions with session-scoped billing.
 *
 * Create sessions for agent interactions, track per-session tool calls and credits,
 * manage session lifecycle, and generate session reports.
 *
 * @example
 * ```ts
 * const mgr = new SessionManager();
 *
 * const session = mgr.createSession({ key: 'key_abc', metadata: { agent: 'gpt-4' } });
 * mgr.recordCall(session.id, 'search', 5);
 * mgr.recordCall(session.id, 'summarize', 3);
 * mgr.endSession(session.id);
 *
 * const report = mgr.getSessionReport(session.id);
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type SessionStatus = 'active' | 'ended' | 'expired';

export interface Session {
  id: string;
  key: string;
  status: SessionStatus;
  metadata: Record<string, unknown>;
  calls: SessionCall[];
  totalCredits: number;
  totalCalls: number;
  startedAt: number;
  endedAt: number | null;
  expiresAt: number | null;
}

export interface SessionCreateParams {
  key: string;
  metadata?: Record<string, unknown>;
  /** Session TTL in milliseconds. Default: no expiration. */
  ttlMs?: number;
}

export interface SessionCall {
  tool: string;
  credits: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface SessionReport {
  sessionId: string;
  key: string;
  status: SessionStatus;
  durationMs: number;
  totalCalls: number;
  totalCredits: number;
  toolBreakdown: { tool: string; calls: number; credits: number }[];
  startedAt: number;
  endedAt: number | null;
}

export interface SessionManagerConfig {
  /** Max active sessions. Default 10000. */
  maxActiveSessions?: number;
  /** Max ended sessions to retain. Default 50000. */
  maxHistory?: number;
  /** Default session TTL in ms. Default: null (no expiration). */
  defaultTtlMs?: number | null;
}

export interface SessionManagerStats {
  activeSessions: number;
  endedSessions: number;
  expiredSessions: number;
  totalSessions: number;
  totalCalls: number;
  totalCredits: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class SessionManager {
  private sessions = new Map<string, Session>();
  private keySessions = new Map<string, Set<string>>(); // key → session IDs
  private nextId = 1;

  private maxActiveSessions: number;
  private maxHistory: number;
  private defaultTtlMs: number | null;

  constructor(config: SessionManagerConfig = {}) {
    this.maxActiveSessions = config.maxActiveSessions ?? 10_000;
    this.maxHistory = config.maxHistory ?? 50_000;
    this.defaultTtlMs = config.defaultTtlMs ?? null;
  }

  // ── Session Lifecycle ──────────────────────────────────────────

  /** Create a new session. */
  createSession(params: SessionCreateParams): Session {
    if (!params.key) throw new Error('Key is required');

    const activeCount = [...this.sessions.values()].filter(s => s.status === 'active').length;
    if (activeCount >= this.maxActiveSessions) {
      throw new Error(`Maximum ${this.maxActiveSessions} active sessions reached`);
    }

    const ttl = params.ttlMs ?? this.defaultTtlMs;
    const now = Date.now();

    const session: Session = {
      id: `sess_${this.nextId++}`,
      key: params.key,
      status: 'active',
      metadata: params.metadata ?? {},
      calls: [],
      totalCredits: 0,
      totalCalls: 0,
      startedAt: now,
      endedAt: null,
      expiresAt: ttl ? now + ttl : null,
    };

    this.sessions.set(session.id, session);

    if (!this.keySessions.has(params.key)) {
      this.keySessions.set(params.key, new Set());
    }
    this.keySessions.get(params.key)!.add(session.id);

    return session;
  }

  /** End a session. */
  endSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' not found`);
    if (session.status !== 'active') throw new Error(`Session '${sessionId}' is not active`);

    session.status = 'ended';
    session.endedAt = Date.now();
    return session;
  }

  /** Get a session by ID. */
  getSession(sessionId: string): Session | null {
    const session = this.sessions.get(sessionId) ?? null;
    if (session && session.status === 'active' && session.expiresAt && Date.now() > session.expiresAt) {
      session.status = 'expired';
      session.endedAt = session.expiresAt;
    }
    return session;
  }

  /** Get active sessions for a key. */
  getActiveSessions(key: string): Session[] {
    const ids = this.keySessions.get(key);
    if (!ids) return [];

    return [...ids]
      .map(id => this.getSession(id))
      .filter((s): s is Session => s !== null && s.status === 'active');
  }

  /** List all sessions. */
  listSessions(options?: { key?: string; status?: SessionStatus; limit?: number }): Session[] {
    let sessions = [...this.sessions.values()];

    // Check expiry for active sessions
    for (const s of sessions) {
      if (s.status === 'active' && s.expiresAt && Date.now() > s.expiresAt) {
        s.status = 'expired';
        s.endedAt = s.expiresAt;
      }
    }

    if (options?.key) {
      sessions = sessions.filter(s => s.key === options.key);
    }
    if (options?.status) {
      sessions = sessions.filter(s => s.status === options.status);
    }

    const limit = options?.limit ?? 100;
    return sessions.slice(-limit);
  }

  // ── Call Recording ─────────────────────────────────────────────

  /** Record a tool call in a session. */
  recordCall(sessionId: string, tool: string, credits: number, metadata?: Record<string, unknown>): SessionCall {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' not found`);
    if (session.status !== 'active') throw new Error(`Session '${sessionId}' is not active`);

    const call: SessionCall = {
      tool,
      credits,
      timestamp: Date.now(),
      metadata,
    };

    session.calls.push(call);
    session.totalCredits += credits;
    session.totalCalls++;

    return call;
  }

  // ── Reports ────────────────────────────────────────────────────

  /** Get a detailed session report. */
  getSessionReport(sessionId: string): SessionReport | null {
    const session = this.getSession(sessionId);
    if (!session) return null;

    const end = session.endedAt ?? Date.now();
    const durationMs = end - session.startedAt;

    // Tool breakdown
    const toolMap = new Map<string, { calls: number; credits: number }>();
    for (const call of session.calls) {
      const existing = toolMap.get(call.tool) ?? { calls: 0, credits: 0 };
      existing.calls++;
      existing.credits += call.credits;
      toolMap.set(call.tool, existing);
    }

    const toolBreakdown = [...toolMap.entries()]
      .map(([tool, data]) => ({ tool, ...data }))
      .sort((a, b) => b.credits - a.credits);

    return {
      sessionId: session.id,
      key: session.key,
      status: session.status,
      durationMs,
      totalCalls: session.totalCalls,
      totalCredits: session.totalCredits,
      toolBreakdown,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
    };
  }

  /** Get aggregate report for a key across all sessions. */
  getKeyReport(key: string): { key: string; totalSessions: number; totalCalls: number; totalCredits: number; activeSessions: number } {
    const ids = this.keySessions.get(key);
    if (!ids) return { key, totalSessions: 0, totalCalls: 0, totalCredits: 0, activeSessions: 0 };

    let totalCalls = 0;
    let totalCredits = 0;
    let activeSessions = 0;

    for (const id of ids) {
      const s = this.getSession(id);
      if (!s) continue;
      totalCalls += s.totalCalls;
      totalCredits += s.totalCredits;
      if (s.status === 'active') activeSessions++;
    }

    return { key, totalSessions: ids.size, totalCalls, totalCredits, activeSessions };
  }

  // ── Cleanup ────────────────────────────────────────────────────

  /** Remove ended/expired sessions older than given age in ms. */
  cleanup(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;

    for (const [id, session] of this.sessions) {
      if (session.status !== 'active' && session.endedAt && session.endedAt < cutoff) {
        this.sessions.delete(id);
        const keySet = this.keySessions.get(session.key);
        if (keySet) {
          keySet.delete(id);
          if (keySet.size === 0) this.keySessions.delete(session.key);
        }
        removed++;
      }
    }

    return removed;
  }

  // ── Stats ───────────────────────────────────────────────────────

  getStats(): SessionManagerStats {
    let active = 0, ended = 0, expired = 0;
    let totalCalls = 0, totalCredits = 0;

    for (const s of this.sessions.values()) {
      // Check expiry
      if (s.status === 'active' && s.expiresAt && Date.now() > s.expiresAt) {
        s.status = 'expired';
        s.endedAt = s.expiresAt;
      }

      if (s.status === 'active') active++;
      else if (s.status === 'ended') ended++;
      else if (s.status === 'expired') expired++;

      totalCalls += s.totalCalls;
      totalCredits += s.totalCredits;
    }

    return {
      activeSessions: active,
      endedSessions: ended,
      expiredSessions: expired,
      totalSessions: this.sessions.size,
      totalCalls,
      totalCredits,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.sessions.clear();
    this.keySessions.clear();
  }
}
