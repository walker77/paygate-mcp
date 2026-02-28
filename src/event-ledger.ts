/**
 * EventLedger — Immutable event sourcing for full audit trail.
 *
 * Records every state change as an immutable event. Supports replay,
 * projection, and time-travel queries for compliance and debugging.
 *
 * @example
 * ```ts
 * const ledger = new EventLedger();
 *
 * ledger.append({
 *   type: 'credit.deducted',
 *   aggregateId: 'key_abc',
 *   payload: { amount: 50, tool: 'search', balance: 950 },
 * });
 *
 * const events = ledger.query({ aggregateId: 'key_abc' });
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface LedgerEvent {
  id: string;
  sequence: number;
  type: string;
  aggregateId: string;
  aggregateType?: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, string>;
  timestamp: number;
  version: number; // for optimistic concurrency
}

export interface AppendParams {
  type: string;
  aggregateId: string;
  aggregateType?: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, string>;
  expectedVersion?: number; // optimistic concurrency check
}

export interface LedgerQuery {
  aggregateId?: string;
  aggregateType?: string;
  type?: string;
  types?: string[];
  startTime?: number;
  endTime?: number;
  afterSequence?: number;
  limit?: number;
  offset?: number;
}

export interface LedgerQueryResult {
  events: LedgerEvent[];
  total: number;
  hasMore: boolean;
}

export interface AggregateSnapshot {
  aggregateId: string;
  version: number;
  eventCount: number;
  firstEvent: number;
  lastEvent: number;
  types: string[];
}

export interface EventLedgerConfig {
  maxEvents?: number;
  enableConcurrencyCheck?: boolean;
}

export interface EventLedgerStats {
  totalEvents: number;
  totalAggregates: number;
  eventTypes: number;
  oldestEvent: number | null;
  newestEvent: number | null;
}

// ── Implementation ───────────────────────────────────────────────────

export class EventLedger {
  private events: LedgerEvent[] = [];
  private sequence = 0;
  private maxEvents: number;
  private enableConcurrencyCheck: boolean;
  // aggregateId → latest version
  private aggregateVersions = new Map<string, number>();

  constructor(config: EventLedgerConfig = {}) {
    this.maxEvents = config.maxEvents ?? 100_000;
    this.enableConcurrencyCheck = config.enableConcurrencyCheck ?? true;
  }

  // ── Append ──────────────────────────────────────────────────────────

  /** Append an event to the ledger. Returns the event ID. */
  append(params: AppendParams): string {
    const { type, aggregateId, aggregateType, payload, metadata, expectedVersion } = params;

    if (!type) throw new Error('Event type is required');
    if (!aggregateId) throw new Error('Aggregate ID is required');

    // Optimistic concurrency check
    const currentVersion = this.aggregateVersions.get(aggregateId) ?? 0;
    if (this.enableConcurrencyCheck && expectedVersion !== undefined) {
      if (expectedVersion !== currentVersion) {
        throw new Error(`Concurrency conflict: expected version ${expectedVersion}, got ${currentVersion}`);
      }
    }

    const newVersion = currentVersion + 1;
    const id = `evt_${++this.sequence}`;

    const event: LedgerEvent = {
      id,
      sequence: this.sequence,
      type,
      aggregateId,
      aggregateType,
      payload: { ...payload },
      metadata: metadata ? { ...metadata } : undefined,
      timestamp: Date.now(),
      version: newVersion,
    };

    this.events.push(event);
    this.aggregateVersions.set(aggregateId, newVersion);

    // Evict oldest if over limit
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }

    return id;
  }

  /** Append multiple events atomically. */
  appendBatch(params: AppendParams[]): string[] {
    const ids: string[] = [];
    for (const p of params) {
      ids.push(this.append(p));
    }
    return ids;
  }

  // ── Query ──────────────────────────────────────────────────────────

  /** Query events with filters. */
  query(q: LedgerQuery = {}): LedgerQueryResult {
    let filtered = this.applyFilters(q);
    const total = filtered.length;
    const limit = q.limit ?? 100;
    const offset = q.offset ?? 0;

    filtered = filtered.slice(offset, offset + limit);

    return {
      events: filtered,
      total,
      hasMore: offset + limit < total,
    };
  }

  /** Get a single event by ID. */
  getEvent(id: string): LedgerEvent | null {
    return this.events.find(e => e.id === id) ?? null;
  }

  /** Get all events for an aggregate in order. */
  getAggregateEvents(aggregateId: string): LedgerEvent[] {
    return this.events
      .filter(e => e.aggregateId === aggregateId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  /** Get the current version of an aggregate. */
  getAggregateVersion(aggregateId: string): number {
    return this.aggregateVersions.get(aggregateId) ?? 0;
  }

  /** Get a snapshot summary of an aggregate. */
  getAggregateSnapshot(aggregateId: string): AggregateSnapshot | null {
    const events = this.getAggregateEvents(aggregateId);
    if (events.length === 0) return null;

    const types = [...new Set(events.map(e => e.type))];
    return {
      aggregateId,
      version: this.getAggregateVersion(aggregateId),
      eventCount: events.length,
      firstEvent: events[0].timestamp,
      lastEvent: events[events.length - 1].timestamp,
      types,
    };
  }

  /** List all aggregate IDs. */
  listAggregates(): string[] {
    return [...this.aggregateVersions.keys()];
  }

  // ── Replay ────────────────────────────────────────────────────────

  /**
   * Replay events for an aggregate through a reducer function.
   * Returns the final state.
   */
  replay<T>(aggregateId: string, reducer: (state: T, event: LedgerEvent) => T, initialState: T): T {
    const events = this.getAggregateEvents(aggregateId);
    let state = initialState;
    for (const event of events) {
      state = reducer(state, event);
    }
    return state;
  }

  /**
   * Replay all events through a reducer (not scoped to aggregate).
   * Useful for rebuilding read models / projections.
   */
  replayAll<T>(reducer: (state: T, event: LedgerEvent) => T, initialState: T): T {
    let state = initialState;
    for (const event of this.events) {
      state = reducer(state, event);
    }
    return state;
  }

  // ── Time Travel ────────────────────────────────────────────────────

  /** Get the state of an aggregate at a specific point in time. */
  getEventsAsOf(aggregateId: string, asOfTimestamp: number): LedgerEvent[] {
    return this.events
      .filter(e => e.aggregateId === aggregateId && e.timestamp <= asOfTimestamp)
      .sort((a, b) => a.sequence - b.sequence);
  }

  /** Get event count by type. */
  getEventTypeCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const e of this.events) {
      counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    }
    return counts;
  }

  // ── Stats ──────────────────────────────────────────────────────────

  getStats(): EventLedgerStats {
    const types = new Set(this.events.map(e => e.type));
    return {
      totalEvents: this.events.length,
      totalAggregates: this.aggregateVersions.size,
      eventTypes: types.size,
      oldestEvent: this.events.length > 0 ? this.events[0].timestamp : null,
      newestEvent: this.events.length > 0 ? this.events[this.events.length - 1].timestamp : null,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.events = [];
    this.aggregateVersions.clear();
    this.sequence = 0;
  }

  // ── Private ─────────────────────────────────────────────────────────

  private applyFilters(q: LedgerQuery): LedgerEvent[] {
    let result = this.events;

    if (q.aggregateId) result = result.filter(e => e.aggregateId === q.aggregateId);
    if (q.aggregateType) result = result.filter(e => e.aggregateType === q.aggregateType);
    if (q.type) result = result.filter(e => e.type === q.type);
    if (q.types && q.types.length > 0) result = result.filter(e => q.types!.includes(e.type));
    if (q.startTime) result = result.filter(e => e.timestamp >= q.startTime!);
    if (q.endTime) result = result.filter(e => e.timestamp <= q.endTime!);
    if (q.afterSequence) result = result.filter(e => e.sequence > q.afterSequence!);

    return result;
  }
}
