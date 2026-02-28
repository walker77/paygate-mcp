/**
 * AuditTrailManager — Compliance-ready audit trail with tamper detection.
 *
 * Records every significant action with actor, target, and metadata.
 * Uses hash chains for tamper detection — each entry's hash includes
 * the previous entry's hash, creating a verifiable chain of custody.
 *
 * @example
 * ```ts
 * const audit = new AuditTrailManager();
 *
 * audit.record({
 *   action: 'key.created',
 *   actor: 'admin_1',
 *   target: 'key_abc',
 *   details: { credits: 1000 },
 * });
 *
 * const entries = audit.query({ actor: 'admin_1' });
 * const valid = audit.verifyChain(); // true if no tampering
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface AuditEntry {
  id: string;
  sequence: number;
  action: string;
  actor: string;
  actorType?: string;
  target: string;
  targetType?: string;
  details: Record<string, unknown>;
  timestamp: number;
  /** IP address or origin. */
  source?: string;
  /** Hash of this entry (includes previous hash for chain). */
  hash: string;
  /** Hash of the previous entry. */
  previousHash: string;
}

export interface AuditRecordParams {
  action: string;
  actor: string;
  actorType?: string;
  target: string;
  targetType?: string;
  details?: Record<string, unknown>;
  source?: string;
}

export interface AuditQuery {
  action?: string;
  actions?: string[];
  actor?: string;
  actorType?: string;
  target?: string;
  targetType?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
}

export interface AuditQueryResult {
  entries: AuditEntry[];
  total: number;
  hasMore: boolean;
}

export interface ChainVerification {
  valid: boolean;
  totalEntries: number;
  firstBrokenAt?: number;
  brokenEntry?: string;
}

export interface AuditTrailConfig {
  maxEntries?: number;
}

export interface AuditTrailStats {
  totalEntries: number;
  totalActors: number;
  totalActions: number;
  chainValid: boolean;
  oldestEntry: number | null;
  newestEntry: number | null;
}

// ── Implementation ───────────────────────────────────────────────────

export class AuditTrailManager {
  private entries: AuditEntry[] = [];
  private sequence = 0;
  private maxEntries: number;
  private lastHash = '0'; // Genesis hash

  constructor(config: AuditTrailConfig = {}) {
    this.maxEntries = config.maxEntries ?? 100_000;
  }

  // ── Recording ─────────────────────────────────────────────────────

  /** Record an audit entry. Returns the entry ID. */
  record(params: AuditRecordParams): string {
    if (!params.action) throw new Error('Action is required');
    if (!params.actor) throw new Error('Actor is required');
    if (!params.target) throw new Error('Target is required');

    const id = `audit_${++this.sequence}`;
    const timestamp = Date.now();
    const previousHash = this.lastHash;

    // Compute hash of this entry (simplified — production would use crypto)
    const hashInput = `${id}|${params.action}|${params.actor}|${params.target}|${timestamp}|${previousHash}`;
    const hash = this.simpleHash(hashInput);

    const entry: AuditEntry = {
      id,
      sequence: this.sequence,
      action: params.action,
      actor: params.actor,
      actorType: params.actorType,
      target: params.target,
      targetType: params.targetType,
      details: { ...(params.details ?? {}) },
      timestamp,
      source: params.source,
      hash,
      previousHash,
    };

    this.entries.push(entry);
    this.lastHash = hash;

    // Evict oldest if over limit
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }

    return id;
  }

  /** Record multiple entries. */
  recordBatch(params: AuditRecordParams[]): string[] {
    return params.map(p => this.record(p));
  }

  // ── Query ─────────────────────────────────────────────────────────

  /** Query audit entries with filters. */
  query(q: AuditQuery = {}): AuditQueryResult {
    let filtered = this.entries;

    if (q.action) filtered = filtered.filter(e => e.action === q.action);
    if (q.actions && q.actions.length > 0) filtered = filtered.filter(e => q.actions!.includes(e.action));
    if (q.actor) filtered = filtered.filter(e => e.actor === q.actor);
    if (q.actorType) filtered = filtered.filter(e => e.actorType === q.actorType);
    if (q.target) filtered = filtered.filter(e => e.target === q.target);
    if (q.targetType) filtered = filtered.filter(e => e.targetType === q.targetType);
    if (q.startTime) filtered = filtered.filter(e => e.timestamp >= q.startTime!);
    if (q.endTime) filtered = filtered.filter(e => e.timestamp <= q.endTime!);

    const total = filtered.length;
    const limit = q.limit ?? 100;
    const offset = q.offset ?? 0;
    filtered = filtered.slice(offset, offset + limit);

    return {
      entries: filtered,
      total,
      hasMore: offset + limit < total,
    };
  }

  /** Get a single entry by ID. */
  getEntry(id: string): AuditEntry | null {
    return this.entries.find(e => e.id === id) ?? null;
  }

  /** Get all entries for a specific target. */
  getTargetHistory(target: string): AuditEntry[] {
    return this.entries.filter(e => e.target === target);
  }

  /** Get all entries by a specific actor. */
  getActorHistory(actor: string): AuditEntry[] {
    return this.entries.filter(e => e.actor === actor);
  }

  // ── Chain Verification ────────────────────────────────────────────

  /** Verify the integrity of the audit chain. */
  verifyChain(): ChainVerification {
    if (this.entries.length === 0) {
      return { valid: true, totalEntries: 0 };
    }

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];

      // Verify hash
      const hashInput = `${entry.id}|${entry.action}|${entry.actor}|${entry.target}|${entry.timestamp}|${entry.previousHash}`;
      const expectedHash = this.simpleHash(hashInput);

      if (entry.hash !== expectedHash) {
        return {
          valid: false,
          totalEntries: this.entries.length,
          firstBrokenAt: i,
          brokenEntry: entry.id,
        };
      }

      // Verify chain link (except first entry in current window — may have been evicted)
      if (i > 0 && entry.previousHash !== this.entries[i - 1].hash) {
        return {
          valid: false,
          totalEntries: this.entries.length,
          firstBrokenAt: i,
          brokenEntry: entry.id,
        };
      }
    }

    return { valid: true, totalEntries: this.entries.length };
  }

  // ── Analytics ─────────────────────────────────────────────────────

  /** Get action frequency counts. */
  getActionCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const e of this.entries) {
      counts.set(e.action, (counts.get(e.action) ?? 0) + 1);
    }
    return counts;
  }

  /** Get unique actors. */
  getActors(): string[] {
    return [...new Set(this.entries.map(e => e.actor))];
  }

  /** Get unique targets. */
  getTargets(): string[] {
    return [...new Set(this.entries.map(e => e.target))];
  }

  // ── Stats ─────────────────────────────────────────────────────────

  getStats(): AuditTrailStats {
    const actors = new Set(this.entries.map(e => e.actor));
    const actions = new Set(this.entries.map(e => e.action));

    return {
      totalEntries: this.entries.length,
      totalActors: actors.size,
      totalActions: actions.size,
      chainValid: this.verifyChain().valid,
      oldestEntry: this.entries.length > 0 ? this.entries[0].timestamp : null,
      newestEntry: this.entries.length > 0 ? this.entries[this.entries.length - 1].timestamp : null,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.entries = [];
    this.sequence = 0;
    this.lastHash = '0';
  }

  // ── Private ───────────────────────────────────────────────────────

  /** Simple hash function for chain integrity. Production should use crypto. */
  private simpleHash(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `h_${Math.abs(hash).toString(36)}`;
  }
}
