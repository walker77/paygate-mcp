import { EventLedger } from '../src/event-ledger';

describe('EventLedger', () => {
  let ledger: EventLedger;

  beforeEach(() => {
    ledger = new EventLedger();
  });

  // ── Append ──────────────────────────────────────────────────────

  it('appends an event and returns an ID', () => {
    const id = ledger.append({
      type: 'credit.deducted',
      aggregateId: 'key_abc',
      payload: { amount: 50 },
    });
    expect(id).toMatch(/^evt_/);
  });

  it('rejects events without type', () => {
    expect(() => ledger.append({
      type: '',
      aggregateId: 'key_abc',
      payload: {},
    })).toThrow('Event type is required');
  });

  it('rejects events without aggregateId', () => {
    expect(() => ledger.append({
      type: 'test',
      aggregateId: '',
      payload: {},
    })).toThrow('Aggregate ID is required');
  });

  it('increments sequence and version', () => {
    ledger.append({ type: 'a', aggregateId: 'x', payload: {} });
    ledger.append({ type: 'b', aggregateId: 'x', payload: {} });
    const events = ledger.getAggregateEvents('x');
    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(1);
    expect(events[1].sequence).toBe(2);
    expect(events[0].version).toBe(1);
    expect(events[1].version).toBe(2);
  });

  it('appends batch atomically', () => {
    const ids = ledger.appendBatch([
      { type: 'a', aggregateId: 'x', payload: {} },
      { type: 'b', aggregateId: 'x', payload: {} },
      { type: 'c', aggregateId: 'y', payload: {} },
    ]);
    expect(ids).toHaveLength(3);
    expect(ledger.getStats().totalEvents).toBe(3);
  });

  // ── Concurrency ─────────────────────────────────────────────────

  it('enforces optimistic concurrency check', () => {
    ledger.append({ type: 'a', aggregateId: 'x', payload: {} });
    // Version is now 1
    expect(() => ledger.append({
      type: 'b',
      aggregateId: 'x',
      payload: {},
      expectedVersion: 0, // stale
    })).toThrow('Concurrency conflict');
  });

  it('allows append with correct expected version', () => {
    ledger.append({ type: 'a', aggregateId: 'x', payload: {} });
    const id = ledger.append({
      type: 'b',
      aggregateId: 'x',
      payload: {},
      expectedVersion: 1,
    });
    expect(id).toMatch(/^evt_/);
  });

  it('skips concurrency check when disabled', () => {
    const l = new EventLedger({ enableConcurrencyCheck: false });
    l.append({ type: 'a', aggregateId: 'x', payload: {} });
    // Should not throw even with wrong version
    const id = l.append({
      type: 'b',
      aggregateId: 'x',
      payload: {},
      expectedVersion: 99,
    });
    expect(id).toMatch(/^evt_/);
    l.destroy();
  });

  // ── Query ───────────────────────────────────────────────────────

  it('queries by aggregateId', () => {
    ledger.append({ type: 'a', aggregateId: 'x', payload: {} });
    ledger.append({ type: 'a', aggregateId: 'y', payload: {} });
    const result = ledger.query({ aggregateId: 'x' });
    expect(result.events).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('queries by type', () => {
    ledger.append({ type: 'credit.added', aggregateId: 'x', payload: {} });
    ledger.append({ type: 'credit.deducted', aggregateId: 'x', payload: {} });
    const result = ledger.query({ type: 'credit.added' });
    expect(result.events).toHaveLength(1);
  });

  it('queries by multiple types', () => {
    ledger.append({ type: 'a', aggregateId: 'x', payload: {} });
    ledger.append({ type: 'b', aggregateId: 'x', payload: {} });
    ledger.append({ type: 'c', aggregateId: 'x', payload: {} });
    const result = ledger.query({ types: ['a', 'c'] });
    expect(result.events).toHaveLength(2);
  });

  it('queries with pagination', () => {
    for (let i = 0; i < 10; i++) {
      ledger.append({ type: 'test', aggregateId: 'x', payload: { i } });
    }
    const page1 = ledger.query({ limit: 3, offset: 0 });
    expect(page1.events).toHaveLength(3);
    expect(page1.hasMore).toBe(true);
    expect(page1.total).toBe(10);

    const page4 = ledger.query({ limit: 3, offset: 9 });
    expect(page4.events).toHaveLength(1);
    expect(page4.hasMore).toBe(false);
  });

  it('queries after a sequence number', () => {
    ledger.append({ type: 'a', aggregateId: 'x', payload: {} });
    ledger.append({ type: 'b', aggregateId: 'x', payload: {} });
    ledger.append({ type: 'c', aggregateId: 'x', payload: {} });
    const result = ledger.query({ afterSequence: 1 });
    expect(result.events).toHaveLength(2);
    expect(result.events[0].type).toBe('b');
  });

  // ── Get Event ──────────────────────────────────────────────────

  it('gets a single event by ID', () => {
    const id = ledger.append({ type: 'test', aggregateId: 'x', payload: { val: 42 } });
    const event = ledger.getEvent(id);
    expect(event).not.toBeNull();
    expect(event!.payload.val).toBe(42);
  });

  it('returns null for unknown event ID', () => {
    expect(ledger.getEvent('evt_999')).toBeNull();
  });

  // ── Aggregate ──────────────────────────────────────────────────

  it('gets aggregate snapshot', () => {
    ledger.append({ type: 'a', aggregateId: 'x', payload: {} });
    ledger.append({ type: 'b', aggregateId: 'x', payload: {} });
    const snap = ledger.getAggregateSnapshot('x');
    expect(snap).not.toBeNull();
    expect(snap!.version).toBe(2);
    expect(snap!.eventCount).toBe(2);
    expect(snap!.types).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('returns null snapshot for unknown aggregate', () => {
    expect(ledger.getAggregateSnapshot('unknown')).toBeNull();
  });

  it('lists all aggregates', () => {
    ledger.append({ type: 'a', aggregateId: 'x', payload: {} });
    ledger.append({ type: 'a', aggregateId: 'y', payload: {} });
    expect(ledger.listAggregates()).toEqual(expect.arrayContaining(['x', 'y']));
  });

  it('tracks aggregate version', () => {
    expect(ledger.getAggregateVersion('x')).toBe(0);
    ledger.append({ type: 'a', aggregateId: 'x', payload: {} });
    expect(ledger.getAggregateVersion('x')).toBe(1);
  });

  // ── Replay ────────────────────────────────────────────────────

  it('replays events through a reducer', () => {
    ledger.append({ type: 'add', aggregateId: 'counter', payload: { n: 10 } });
    ledger.append({ type: 'add', aggregateId: 'counter', payload: { n: 20 } });
    ledger.append({ type: 'sub', aggregateId: 'counter', payload: { n: 5 } });

    const result = ledger.replay('counter', (state: number, event) => {
      if (event.type === 'add') return state + (event.payload.n as number);
      if (event.type === 'sub') return state - (event.payload.n as number);
      return state;
    }, 0);

    expect(result).toBe(25);
  });

  it('replays all events across aggregates', () => {
    ledger.append({ type: 'add', aggregateId: 'a', payload: { n: 10 } });
    ledger.append({ type: 'add', aggregateId: 'b', payload: { n: 20 } });

    const total = ledger.replayAll((state: number, event) => {
      return state + (event.payload.n as number);
    }, 0);

    expect(total).toBe(30);
  });

  // ── Time Travel ────────────────────────────────────────────────

  it('gets events as of a timestamp', () => {
    const before = Date.now();
    ledger.append({ type: 'a', aggregateId: 'x', payload: {} });
    // The event was created at Date.now() which is >= before
    const events = ledger.getEventsAsOf('x', Date.now());
    expect(events).toHaveLength(1);
    // Events before the first event
    const empty = ledger.getEventsAsOf('x', before - 1000);
    expect(empty).toHaveLength(0);
  });

  // ── Event Type Counts ──────────────────────────────────────────

  it('counts events by type', () => {
    ledger.append({ type: 'a', aggregateId: 'x', payload: {} });
    ledger.append({ type: 'a', aggregateId: 'y', payload: {} });
    ledger.append({ type: 'b', aggregateId: 'x', payload: {} });
    const counts = ledger.getEventTypeCounts();
    expect(counts.get('a')).toBe(2);
    expect(counts.get('b')).toBe(1);
  });

  // ── Max Events Eviction ───────────────────────────────────────

  it('evicts oldest events when over limit', () => {
    const l = new EventLedger({ maxEvents: 5 });
    for (let i = 0; i < 8; i++) {
      l.append({ type: 'test', aggregateId: 'x', payload: { i } });
    }
    expect(l.getStats().totalEvents).toBe(5);
    // Oldest should be evicted
    const events = l.query({});
    expect(events.events[0].payload.i).toBe(3);
    l.destroy();
  });

  // ── Stats ─────────────────────────────────────────────────────

  it('tracks stats', () => {
    ledger.append({ type: 'a', aggregateId: 'x', payload: {} });
    ledger.append({ type: 'b', aggregateId: 'y', payload: {} });
    const stats = ledger.getStats();
    expect(stats.totalEvents).toBe(2);
    expect(stats.totalAggregates).toBe(2);
    expect(stats.eventTypes).toBe(2);
    expect(stats.oldestEvent).toEqual(expect.any(Number));
    expect(stats.newestEvent).toEqual(expect.any(Number));
  });

  // ── Destroy ────────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    ledger.append({ type: 'a', aggregateId: 'x', payload: {} });
    ledger.destroy();
    expect(ledger.getStats().totalEvents).toBe(0);
    expect(ledger.getStats().totalAggregates).toBe(0);
  });
});
