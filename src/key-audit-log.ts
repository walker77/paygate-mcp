/**
 * APIKeyAuditLog — Immutable audit log for API key lifecycle events.
 *
 * Record every significant action on API keys: creation, rotation,
 * revocation, permission changes, and access events.
 *
 * @example
 * ```ts
 * const audit = new APIKeyAuditLog();
 *
 * audit.record({ key: 'k1', action: 'created', actor: 'admin@co.com' });
 * audit.record({ key: 'k1', action: 'rotated', actor: 'admin@co.com', details: { reason: 'scheduled' } });
 *
 * const events = audit.getKeyHistory('k1');
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type AuditAction =
  | 'created'
  | 'rotated'
  | 'revoked'
  | 'suspended'
  | 'reactivated'
  | 'permissions_changed'
  | 'quota_updated'
  | 'group_added'
  | 'group_removed'
  | 'accessed'
  | 'custom';

export interface AuditEntry {
  id: string;
  key: string;
  action: AuditAction;
  actor: string;
  details: Record<string, unknown>;
  timestamp: number;
  ip?: string;
}

export interface AuditRecordParams {
  key: string;
  action: AuditAction;
  actor: string;
  details?: Record<string, unknown>;
  ip?: string;
}

export interface AuditQuery {
  key?: string;
  action?: AuditAction;
  actor?: string;
  since?: number;
  until?: number;
  limit?: number;
}

export interface APIKeyAuditLogConfig {
  /** Max entries to retain. Default 50000. */
  maxEntries?: number;
  /** Max entries per key index. Default 1000. */
  maxPerKey?: number;
}

export interface APIKeyAuditLogStats {
  totalEntries: number;
  uniqueKeys: number;
  uniqueActors: number;
  actionBreakdown: { action: AuditAction; count: number }[];
}

// ── Implementation ───────────────────────────────────────────────────

export class APIKeyAuditLog {
  private entries: AuditEntry[] = [];
  private keyIndex = new Map<string, string[]>(); // key -> entry IDs
  private nextId = 1;
  private maxEntries: number;
  private maxPerKey: number;

  constructor(config: APIKeyAuditLogConfig = {}) {
    this.maxEntries = config.maxEntries ?? 50_000;
    this.maxPerKey = config.maxPerKey ?? 1000;
  }

  // ── Recording ──────────────────────────────────────────────────

  /** Record an audit event. */
  record(params: AuditRecordParams): AuditEntry {
    if (!params.key) throw new Error('Key is required');
    if (!params.action) throw new Error('Action is required');
    if (!params.actor) throw new Error('Actor is required');

    const entry: AuditEntry = {
      id: `aud_${this.nextId++}`,
      key: params.key,
      action: params.action,
      actor: params.actor,
      details: params.details ?? {},
      timestamp: Date.now(),
      ip: params.ip,
    };

    this.entries.push(entry);

    // Update key index
    let keyEntries = this.keyIndex.get(params.key);
    if (!keyEntries) {
      keyEntries = [];
      this.keyIndex.set(params.key, keyEntries);
    }
    keyEntries.push(entry.id);

    // Trim per-key index
    if (keyEntries.length > this.maxPerKey) {
      keyEntries.splice(0, keyEntries.length - this.maxPerKey);
    }

    // Trim global entries
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }

    return entry;
  }

  // ── Query ──────────────────────────────────────────────────────

  /** Query audit entries. */
  query(params: AuditQuery = {}): AuditEntry[] {
    let results = [...this.entries];

    if (params.key) results = results.filter(e => e.key === params.key);
    if (params.action) results = results.filter(e => e.action === params.action);
    if (params.actor) results = results.filter(e => e.actor === params.actor);
    if (params.since) results = results.filter(e => e.timestamp >= params.since!);
    if (params.until) results = results.filter(e => e.timestamp <= params.until!);

    return results.slice(-(params.limit ?? 100));
  }

  /** Get complete history for a key. */
  getKeyHistory(key: string, limit?: number): AuditEntry[] {
    const ids = this.keyIndex.get(key);
    if (!ids) return [];

    const targetIds = new Set(ids.slice(-(limit ?? 100)));
    return this.entries.filter(e => targetIds.has(e.id));
  }

  /** Get entry by ID. */
  getEntry(id: string): AuditEntry | null {
    return this.entries.find(e => e.id === id) ?? null;
  }

  /** Get latest event for a key. */
  getLatestForKey(key: string): AuditEntry | null {
    const ids = this.keyIndex.get(key);
    if (!ids || ids.length === 0) return null;
    const lastId = ids[ids.length - 1];
    return this.entries.find(e => e.id === lastId) ?? null;
  }

  /** Get all unique actors. */
  getActors(): string[] {
    const actors = new Set<string>();
    for (const e of this.entries) actors.add(e.actor);
    return [...actors];
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): APIKeyAuditLogStats {
    const actors = new Set<string>();
    const actionCounts = new Map<AuditAction, number>();

    for (const e of this.entries) {
      actors.add(e.actor);
      actionCounts.set(e.action, (actionCounts.get(e.action) ?? 0) + 1);
    }

    const actionBreakdown = [...actionCounts.entries()]
      .map(([action, count]) => ({ action, count }))
      .sort((a, b) => b.count - a.count);

    return {
      totalEntries: this.entries.length,
      uniqueKeys: this.keyIndex.size,
      uniqueActors: actors.size,
      actionBreakdown,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.entries = [];
    this.keyIndex.clear();
  }
}
