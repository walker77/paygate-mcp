/**
 * AuditLogger — Structured audit trail with retention policies.
 *
 * Logs every significant event: key management, gate decisions, billing,
 * session lifecycle, and admin operations. Ring buffer with configurable
 * max size and age-based retention. Zero external dependencies.
 */

// ─── Audit Event Types ────────────────────────────────────────────────────────

export type AuditEventType =
  // Key management
  | 'key.created'
  | 'key.revoked'
  | 'key.suspended'
  | 'key.resumed'
  | 'key.cloned'
  | 'key.rotated'
  | 'key.topup'
  | 'key.acl_updated'
  | 'key.expiry_updated'
  | 'key.quota_updated'
  | 'key.tags_updated'
  | 'key.ip_updated'
  | 'key.limit_updated'
  // Gate decisions
  | 'gate.allow'
  | 'gate.deny'
  // Session lifecycle
  | 'session.created'
  | 'session.destroyed'
  // OAuth
  | 'oauth.client_registered'
  | 'oauth.token_issued'
  | 'oauth.token_revoked'
  // Teams
  | 'team.created'
  | 'team.updated'
  | 'team.deleted'
  | 'team.key_assigned'
  | 'team.key_removed'
  // Admin
  | 'admin.auth_failed'
  | 'admin.alerts_configured'
  // Webhook
  | 'webhook.dead_letter_cleared'
  | 'webhook.replayed'
  | 'webhook.test'
  | 'webhook.pause'
  | 'webhook.resume'
  // Key aliases
  | 'key.alias_set'
  // Key expiry warnings
  | 'key.expiry_warning'
  // Scoped tokens
  | 'token.created'
  | 'token.revoked'
  // Billing
  | 'billing.refund'
  // Auto-topup
  | 'key.auto_topup_configured'
  | 'key.auto_topped_up'
  // Admin key management
  | 'admin_key.created'
  | 'admin_key.revoked'
  // Key groups
  | 'group.created'
  | 'group.updated'
  | 'group.deleted'
  | 'group.key_assigned'
  | 'group.key_removed'
  // Credit transfer
  | 'key.credits_transferred'
  // Key import/export
  | 'keys.exported'
  | 'keys.imported'
  // Webhook filters
  | 'webhook_filter.created'
  | 'webhook_filter.updated'
  | 'webhook_filter.deleted'
  // Config reload
  | 'config.reloaded';

export interface AuditEvent {
  /** Monotonically increasing ID */
  id: number;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Event type (dot-separated category.action) */
  type: AuditEventType;
  /** Actor: API key (masked), admin, system, or null */
  actor: string;
  /** Human-readable description */
  message: string;
  /** Structured metadata (varies by event type) */
  metadata: Record<string, unknown>;
}

export interface AuditLogConfig {
  /** Maximum number of events to retain. Default: 10000. */
  maxEvents: number;
  /** Maximum age of events in hours. 0 = no age limit. Default: 720 (30 days). */
  maxAgeHours: number;
  /** How often to run retention cleanup in ms. Default: 60000 (1 min). */
  cleanupIntervalMs: number;
}

export interface AuditQuery {
  /** Filter by event type(s). */
  types?: AuditEventType[];
  /** Filter by actor (partial match). */
  actor?: string;
  /** Return events since this ISO date. */
  since?: string;
  /** Return events until this ISO date. */
  until?: string;
  /** Max events to return. Default: 100. */
  limit?: number;
  /** Offset for pagination. Default: 0. */
  offset?: number;
}

export interface AuditQueryResult {
  total: number;
  offset: number;
  limit: number;
  events: AuditEvent[];
}

const DEFAULT_AUDIT_CONFIG: AuditLogConfig = {
  maxEvents: 10_000,
  maxAgeHours: 720, // 30 days
  cleanupIntervalMs: 60_000, // 1 minute
};

// ─── AuditLogger Class ───────────────────────────────────────────────────────

export class AuditLogger {
  private events: AuditEvent[] = [];
  private nextId = 1;
  private readonly config: AuditLogConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<AuditLogConfig>) {
    this.config = { ...DEFAULT_AUDIT_CONFIG, ...config };

    // Start retention cleanup timer
    if (this.config.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => this.enforceRetention(), this.config.cleanupIntervalMs);
      this.cleanupTimer.unref(); // Don't prevent process exit
    }
  }

  /**
   * Log an audit event.
   */
  log(type: AuditEventType, actor: string, message: string, metadata: Record<string, unknown> = {}): AuditEvent {
    const event: AuditEvent = {
      id: this.nextId++,
      timestamp: new Date().toISOString(),
      type,
      actor,
      message,
      metadata,
    };

    this.events.push(event);

    // Enforce max size immediately (ring buffer behavior)
    if (this.events.length > this.config.maxEvents) {
      this.events = this.events.slice(-this.config.maxEvents);
    }

    return event;
  }

  /**
   * Query events with optional filters.
   */
  query(q: AuditQuery = {}): AuditQueryResult {
    let filtered = this.events;

    // Filter by type(s)
    if (q.types && q.types.length > 0) {
      const typeSet = new Set(q.types);
      filtered = filtered.filter(e => typeSet.has(e.type));
    }

    // Filter by actor (partial match, case-insensitive)
    if (q.actor) {
      const actorLower = q.actor.toLowerCase();
      filtered = filtered.filter(e => e.actor.toLowerCase().includes(actorLower));
    }

    // Filter by time range
    if (q.since) {
      const sinceDate = new Date(q.since).getTime();
      filtered = filtered.filter(e => new Date(e.timestamp).getTime() >= sinceDate);
    }
    if (q.until) {
      const untilDate = new Date(q.until).getTime();
      filtered = filtered.filter(e => new Date(e.timestamp).getTime() <= untilDate);
    }

    const total = filtered.length;
    const offset = Math.max(0, q.offset || 0);
    const limit = Math.min(1000, Math.max(1, q.limit || 100));

    // Return newest first (reverse chronological) — copy to avoid mutating
    const reversed = [...filtered].reverse();
    const page = reversed.slice(offset, offset + limit);

    return { total, offset, limit, events: page };
  }

  /**
   * Get summary statistics of the audit log.
   */
  stats(): {
    totalEvents: number;
    oldestEvent: string | null;
    newestEvent: string | null;
    eventsByType: Record<string, number>;
    eventsLastHour: number;
    eventsLast24h: number;
  } {
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    const oneDayAgo = now - 86_400_000;

    const eventsByType: Record<string, number> = {};
    let eventsLastHour = 0;
    let eventsLast24h = 0;

    for (const e of this.events) {
      eventsByType[e.type] = (eventsByType[e.type] || 0) + 1;
      const ts = new Date(e.timestamp).getTime();
      if (ts >= oneHourAgo) eventsLastHour++;
      if (ts >= oneDayAgo) eventsLast24h++;
    }

    return {
      totalEvents: this.events.length,
      oldestEvent: this.events.length > 0 ? this.events[0].timestamp : null,
      newestEvent: this.events.length > 0 ? this.events[this.events.length - 1].timestamp : null,
      eventsByType,
      eventsLastHour,
      eventsLast24h,
    };
  }

  /**
   * Export all events (for backup/external systems).
   */
  exportAll(): AuditEvent[] {
    return [...this.events];
  }

  /**
   * Export events as CSV string.
   */
  exportCsv(q: AuditQuery = {}): string {
    const result = this.query({ ...q, limit: q.limit || 10_000 });
    const header = 'id,timestamp,type,actor,message';
    const rows = result.events.map(e =>
      `${e.id},${e.timestamp},${e.type},"${e.actor.replace(/"/g, '""')}","${e.message.replace(/"/g, '""')}"`
    );
    return [header, ...rows].join('\n');
  }

  /**
   * Get event count.
   */
  get size(): number {
    return this.events.length;
  }

  /**
   * Enforce retention policy: remove events older than maxAgeHours.
   */
  enforceRetention(): number {
    if (this.config.maxAgeHours <= 0) return 0;

    const cutoff = Date.now() - (this.config.maxAgeHours * 3_600_000);
    const before = this.events.length;
    this.events = this.events.filter(e => new Date(e.timestamp).getTime() >= cutoff);
    return before - this.events.length;
  }

  /**
   * Clear all events.
   */
  clear(): void {
    this.events = [];
    this.nextId = 1;
  }

  /**
   * Stop cleanup timer.
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

// ─── Helper: Mask API key for audit ──────────────────────────────────────────

export function maskKeyForAudit(key: string): string {
  if (!key || key.length < 10) return '***';
  return key.slice(0, 7) + '...' + key.slice(-4);
}
