/**
 * Connection-Time Billing — Duration-Based Charges for Long-Lived Connections.
 *
 * Bills API keys based on how long their SSE/stdio connections stay open.
 * Supports per-minute crediting, configurable billing intervals,
 * idle timeout enforcement, and grace periods.
 *
 * Use cases:
 *   - SSE streaming connections that hold server resources
 *   - Long-running agent sessions
 *   - Reserved capacity billing
 *
 * Zero external dependencies.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ConnectionSession {
  /** Unique session ID. */
  sessionId: string;
  /** API key for this connection. */
  apiKey: string;
  /** When the connection started (epoch ms). */
  startedAt: number;
  /** When the connection ended (epoch ms). Null if still active. */
  endedAt: number | null;
  /** Last activity time (epoch ms). */
  lastActivityAt: number;
  /** Total credits billed so far. */
  creditsBilled: number;
  /** Number of billing intervals processed. */
  intervalsBilled: number;
  /** Whether this session is paused (not billing). */
  paused: boolean;
  /** Transport type. */
  transport: 'sse' | 'stdio' | 'http';
  /** Optional metadata. */
  metadata?: Record<string, string>;
}

export interface ConnectionBillingConfig {
  /** Whether connection billing is enabled. Default: false. */
  enabled?: boolean;
  /** Credits charged per billing interval. Default: 1. */
  creditsPerInterval?: number;
  /** Billing interval in seconds. Default: 60 (1 minute). */
  intervalSeconds?: number;
  /** Grace period before billing starts (seconds). Default: 0. */
  gracePeriodSeconds?: number;
  /** Idle timeout in seconds (disconnect after inactivity). 0 = no timeout. Default: 0. */
  idleTimeoutSeconds?: number;
  /** Maximum session duration in seconds. 0 = unlimited. Default: 0. */
  maxDurationSeconds?: number;
  /** Which transports to bill. Default: ['sse']. */
  billedTransports?: Array<'sse' | 'stdio' | 'http'>;
}

export interface ConnectionBillResult {
  /** Credits charged in this billing cycle. */
  creditsCharged: number;
  /** Whether the session should be terminated (idle/max duration/insufficient credits). */
  shouldTerminate: boolean;
  /** Reason for termination, if applicable. */
  terminateReason?: string;
  /** Session duration so far (seconds). */
  durationSeconds: number;
}

export interface ConnectionBillingStats {
  /** Currently active sessions. */
  activeSessions: number;
  /** Total sessions ever created. */
  totalSessions: number;
  /** Total credits billed for connections. */
  totalCreditsBilled: number;
  /** Total connection-seconds across all sessions. */
  totalConnectionSeconds: number;
  /** Sessions terminated due to idle timeout. */
  idleTerminations: number;
  /** Sessions terminated due to max duration. */
  durationTerminations: number;
  /** Sessions terminated due to insufficient credits. */
  creditTerminations: number;
}

// ─── Connection Billing Manager ─────────────────────────────────────────────

export class ConnectionBillingManager {
  private sessions = new Map<string, ConnectionSession>();
  private enabled: boolean;
  private creditsPerInterval: number;
  private intervalSeconds: number;
  private gracePeriodSeconds: number;
  private idleTimeoutSeconds: number;
  private maxDurationSeconds: number;
  private billedTransports: Set<string>;

  // Stats
  private totalSessions = 0;
  private totalCreditsBilled = 0;
  private totalConnectionSeconds = 0;
  private idleTerminations = 0;
  private durationTerminations = 0;
  private creditTerminations = 0;

  constructor(config: ConnectionBillingConfig = {}) {
    this.enabled = config.enabled ?? false;
    this.creditsPerInterval = config.creditsPerInterval ?? 1;
    this.intervalSeconds = config.intervalSeconds ?? 60;
    this.gracePeriodSeconds = config.gracePeriodSeconds ?? 0;
    this.idleTimeoutSeconds = config.idleTimeoutSeconds ?? 0;
    this.maxDurationSeconds = config.maxDurationSeconds ?? 0;
    this.billedTransports = new Set(config.billedTransports ?? ['sse']);
  }

  /** Whether connection billing is enabled. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Set enabled state. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Start tracking a new connection.
   * Returns the session ID.
   */
  startSession(apiKey: string, transport: 'sse' | 'stdio' | 'http', metadata?: Record<string, string>): string {
    const sessionId = `conn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const session: ConnectionSession = {
      sessionId,
      apiKey,
      startedAt: now,
      endedAt: null,
      lastActivityAt: now,
      creditsBilled: 0,
      intervalsBilled: 0,
      paused: false,
      transport,
      metadata,
    };

    this.sessions.set(sessionId, session);
    this.totalSessions++;
    return sessionId;
  }

  /** End a connection session. */
  endSession(sessionId: string): ConnectionSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    session.endedAt = Date.now();
    const durationMs = session.endedAt - session.startedAt;
    this.totalConnectionSeconds += Math.floor(durationMs / 1000);

    // Move to completed (remove from active tracking)
    this.sessions.delete(sessionId);
    return session;
  }

  /** Record activity on a session (resets idle timer). */
  recordActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = Date.now();
    }
  }

  /** Pause billing for a session. */
  pauseSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.paused = true;
    return true;
  }

  /** Resume billing for a session. */
  resumeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.paused = false;
    return true;
  }

  /** Get a session by ID. */
  getSession(sessionId: string): ConnectionSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /** Get all active sessions. */
  getActiveSessions(): ConnectionSession[] {
    return [...this.sessions.values()];
  }

  /** Get active sessions for a specific API key. */
  getSessionsByKey(apiKey: string): ConnectionSession[] {
    return [...this.sessions.values()].filter(s => s.apiKey === apiKey);
  }

  /**
   * Process billing for a single session.
   * Call this periodically (e.g., every intervalSeconds).
   *
   * @param sessionId - Session to bill
   * @param checkCredits - Callback to check if key has sufficient credits. Returns available credits.
   * @returns Billing result with credits charged and termination status.
   */
  bill(sessionId: string, checkCredits?: (apiKey: string) => number): ConnectionBillResult {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { creditsCharged: 0, shouldTerminate: false, durationSeconds: 0 };
    }

    const now = Date.now();
    const durationMs = now - session.startedAt;
    const durationSeconds = Math.floor(durationMs / 1000);

    // Check if transport is billed
    if (!this.billedTransports.has(session.transport)) {
      return { creditsCharged: 0, shouldTerminate: false, durationSeconds };
    }

    // Check idle timeout
    if (this.idleTimeoutSeconds > 0) {
      const idleSeconds = Math.floor((now - session.lastActivityAt) / 1000);
      if (idleSeconds >= this.idleTimeoutSeconds) {
        this.idleTerminations++;
        return { creditsCharged: 0, shouldTerminate: true, terminateReason: 'idle_timeout', durationSeconds };
      }
    }

    // Check max duration
    if (this.maxDurationSeconds > 0 && durationSeconds >= this.maxDurationSeconds) {
      this.durationTerminations++;
      return { creditsCharged: 0, shouldTerminate: true, terminateReason: 'max_duration', durationSeconds };
    }

    // Skip billing if paused or disabled
    if (session.paused || !this.enabled) {
      return { creditsCharged: 0, shouldTerminate: false, durationSeconds };
    }

    // Check grace period
    if (durationSeconds < this.gracePeriodSeconds) {
      return { creditsCharged: 0, shouldTerminate: false, durationSeconds };
    }

    // Calculate how many intervals should have been billed
    const billableSeconds = durationSeconds - this.gracePeriodSeconds;
    const expectedIntervals = Math.floor(billableSeconds / this.intervalSeconds);
    const intervalsToBill = expectedIntervals - session.intervalsBilled;

    if (intervalsToBill <= 0) {
      return { creditsCharged: 0, shouldTerminate: false, durationSeconds };
    }

    const creditsToCharge = intervalsToBill * this.creditsPerInterval;

    // Check credit availability
    if (checkCredits) {
      const available = checkCredits(session.apiKey);
      if (available < creditsToCharge) {
        this.creditTerminations++;
        return { creditsCharged: 0, shouldTerminate: true, terminateReason: 'insufficient_credits', durationSeconds };
      }
    }

    // Bill
    session.creditsBilled += creditsToCharge;
    session.intervalsBilled = expectedIntervals;
    this.totalCreditsBilled += creditsToCharge;

    return { creditsCharged: creditsToCharge, shouldTerminate: false, durationSeconds };
  }

  /**
   * Process billing for all active sessions.
   * Returns an array of results with session IDs.
   */
  billAll(checkCredits?: (apiKey: string) => number): Array<{ sessionId: string; apiKey: string; result: ConnectionBillResult }> {
    const results: Array<{ sessionId: string; apiKey: string; result: ConnectionBillResult }> = [];

    for (const session of this.sessions.values()) {
      const result = this.bill(session.sessionId, checkCredits);
      results.push({ sessionId: session.sessionId, apiKey: session.apiKey, result });
    }

    return results;
  }

  /** Get current connection cost estimate for a key. */
  estimateCost(apiKey: string, durationMinutes: number): number {
    const intervals = Math.floor((durationMinutes * 60) / this.intervalSeconds);
    const graceIntervals = Math.floor(this.gracePeriodSeconds / this.intervalSeconds);
    const billableIntervals = Math.max(0, intervals - graceIntervals);
    return billableIntervals * this.creditsPerInterval;
  }

  /** Get stats. */
  getStats(): ConnectionBillingStats {
    return {
      activeSessions: this.sessions.size,
      totalSessions: this.totalSessions,
      totalCreditsBilled: this.totalCreditsBilled,
      totalConnectionSeconds: this.totalConnectionSeconds,
      idleTerminations: this.idleTerminations,
      durationTerminations: this.durationTerminations,
      creditTerminations: this.creditTerminations,
    };
  }

  /** Reset stats. */
  resetStats(): void {
    this.totalCreditsBilled = 0;
    this.totalConnectionSeconds = 0;
    this.idleTerminations = 0;
    this.durationTerminations = 0;
    this.creditTerminations = 0;
  }

  /** Destroy and release all resources. */
  destroy(): void {
    this.sessions.clear();
    this.totalSessions = 0;
    this.totalCreditsBilled = 0;
    this.totalConnectionSeconds = 0;
  }
}
