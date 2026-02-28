/**
 * KeyLifecycleManager — API key state machine.
 *
 * Manages API keys through a full lifecycle with state transitions,
 * expiration, suspension, and revocation.
 *
 * State flow: created → active → suspended/expired/revoked
 * Suspended keys can be reactivated.
 * Expired and revoked keys are terminal states.
 *
 * @example
 * ```ts
 * const mgr = new KeyLifecycleManager();
 *
 * mgr.createKey({ id: 'key_abc', name: 'Production Key', expiresAt: '2026-12-31T00:00:00Z' });
 * mgr.activate('key_abc');
 * mgr.suspend('key_abc', 'Suspicious activity');
 * mgr.reactivate('key_abc');
 * mgr.revoke('key_abc', 'No longer needed');
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type KeyState = 'created' | 'active' | 'suspended' | 'expired' | 'revoked';

export interface KeyRecord {
  id: string;
  name: string;
  state: KeyState;
  createdAt: string;
  activatedAt?: string;
  suspendedAt?: string;
  revokedAt?: string;
  expiresAt?: string;
  suspendReason?: string;
  revokeReason?: string;
  metadata?: Record<string, string>;
  tags: string[];
}

export interface KeyCreateParams {
  id: string;
  name: string;
  expiresAt?: string;
  metadata?: Record<string, string>;
  tags?: string[];
  autoActivate?: boolean;
}

export interface KeyEvent {
  keyId: string;
  event: string;
  from: KeyState;
  to: KeyState;
  reason?: string;
  timestamp: string;
}

export interface KeyLifecycleConfig {
  maxKeys?: number;
  maxHistoryPerKey?: number;
}

export interface KeyLifecycleStats {
  totalKeys: number;
  byState: Record<KeyState, number>;
  totalEvents: number;
  totalExpired: number;
  totalRevoked: number;
}

// ── Valid Transitions ────────────────────────────────────────────────

const VALID_TRANSITIONS: Record<KeyState, KeyState[]> = {
  created: ['active', 'revoked'],
  active: ['suspended', 'expired', 'revoked'],
  suspended: ['active', 'revoked'],
  expired: [], // terminal
  revoked: [], // terminal
};

// ── Implementation ───────────────────────────────────────────────────

export class KeyLifecycleManager {
  private keys = new Map<string, KeyRecord>();
  private events = new Map<string, KeyEvent[]>();
  private maxKeys: number;
  private maxHistoryPerKey: number;

  // Stats
  private totalExpired = 0;
  private totalRevoked = 0;

  constructor(config: KeyLifecycleConfig = {}) {
    this.maxKeys = config.maxKeys ?? 10_000;
    this.maxHistoryPerKey = config.maxHistoryPerKey ?? 100;
  }

  // ── Key CRUD ────────────────────────────────────────────────────────

  /** Create a new key. */
  createKey(params: KeyCreateParams): boolean {
    if (this.keys.has(params.id)) return false;
    if (this.keys.size >= this.maxKeys) return false;

    const now = new Date().toISOString();
    const record: KeyRecord = {
      id: params.id,
      name: params.name,
      state: 'created',
      createdAt: now,
      expiresAt: params.expiresAt,
      metadata: params.metadata,
      tags: params.tags ?? [],
    };
    this.keys.set(params.id, record);
    this.events.set(params.id, []);

    if (params.autoActivate) {
      this.activate(params.id);
    }

    return true;
  }

  /** Get a key by ID. */
  getKey(id: string): KeyRecord | null {
    const key = this.keys.get(id);
    if (!key) return null;
    // Check expiration
    this.checkExpiration(key);
    return { ...key };
  }

  /** List all keys, optionally filtered by state or tags. */
  listKeys(filter?: { state?: KeyState; tag?: string }): KeyRecord[] {
    const keys = [...this.keys.values()];
    // Check expirations
    for (const k of keys) this.checkExpiration(k);

    let result = keys.map(k => ({ ...k }));
    if (filter?.state) result = result.filter(k => k.state === filter.state);
    if (filter?.tag) result = result.filter(k => k.tags.includes(filter.tag!));
    return result;
  }

  /** Delete a key entirely (only if revoked or created). */
  deleteKey(id: string): boolean {
    const key = this.keys.get(id);
    if (!key) return false;
    if (key.state !== 'revoked' && key.state !== 'created') return false;
    this.keys.delete(id);
    this.events.delete(id);
    return true;
  }

  // ── State Transitions ──────────────────────────────────────────────

  /** Activate a key (created → active, or suspended → active). */
  activate(id: string): boolean {
    return this.transition(id, 'active', 'activate');
  }

  /** Suspend a key with reason. */
  suspend(id: string, reason?: string): boolean {
    return this.transition(id, 'suspended', 'suspend', reason);
  }

  /** Reactivate a suspended key. */
  reactivate(id: string): boolean {
    const key = this.keys.get(id);
    if (!key || key.state !== 'suspended') return false;
    return this.transition(id, 'active', 'reactivate');
  }

  /** Revoke a key permanently. */
  revoke(id: string, reason?: string): boolean {
    const result = this.transition(id, 'revoked', 'revoke', reason);
    if (result) this.totalRevoked++;
    return result;
  }

  // ── Query ──────────────────────────────────────────────────────────

  /** Check if a key is currently valid for use. */
  isValid(id: string): boolean {
    const key = this.keys.get(id);
    if (!key) return false;
    this.checkExpiration(key);
    return key.state === 'active';
  }

  /** Get keys expiring within the given number of seconds. */
  getExpiringKeys(withinSeconds: number): KeyRecord[] {
    const cutoff = Date.now() + withinSeconds * 1000;
    const result: KeyRecord[] = [];
    for (const key of this.keys.values()) {
      this.checkExpiration(key);
      if (key.expiresAt && key.state === 'active') {
        const expiresAt = new Date(key.expiresAt).getTime();
        if (expiresAt <= cutoff) {
          result.push({ ...key });
        }
      }
    }
    return result;
  }

  /** Expire all keys that are past their expiration date. Returns count. */
  expireKeys(): number {
    let count = 0;
    for (const key of this.keys.values()) {
      if (this.checkExpiration(key)) count++;
    }
    return count;
  }

  /** Get keys by tag. */
  getKeysByTag(tag: string): KeyRecord[] {
    return this.listKeys({ tag });
  }

  // ── Events ─────────────────────────────────────────────────────────

  /** Get event history for a key. */
  getEvents(id: string, limit?: number): KeyEvent[] {
    const events = this.events.get(id);
    if (!events) return [];
    const sorted = [...events].reverse();
    return limit ? sorted.slice(0, limit) : sorted;
  }

  /** Get all events across all keys (most recent first). */
  getAllEvents(limit?: number): KeyEvent[] {
    const all: KeyEvent[] = [];
    for (const events of this.events.values()) {
      all.push(...events);
    }
    all.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return limit ? all.slice(0, limit) : all;
  }

  // ── Stats ──────────────────────────────────────────────────────────

  getStats(): KeyLifecycleStats {
    // Check expirations
    for (const key of this.keys.values()) this.checkExpiration(key);

    const byState: Record<KeyState, number> = { created: 0, active: 0, suspended: 0, expired: 0, revoked: 0 };
    for (const key of this.keys.values()) {
      byState[key.state]++;
    }

    let totalEvents = 0;
    for (const events of this.events.values()) {
      totalEvents += events.length;
    }

    return {
      totalKeys: this.keys.size,
      byState,
      totalEvents,
      totalExpired: this.totalExpired,
      totalRevoked: this.totalRevoked,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.keys.clear();
    this.events.clear();
    this.totalExpired = 0;
    this.totalRevoked = 0;
  }

  // ── Private ─────────────────────────────────────────────────────────

  private transition(id: string, to: KeyState, event: string, reason?: string): boolean {
    const key = this.keys.get(id);
    if (!key) return false;

    // Check expiration first
    this.checkExpiration(key);

    const valid = VALID_TRANSITIONS[key.state];
    if (!valid || !valid.includes(to)) return false;

    const from = key.state;
    const now = new Date().toISOString();

    key.state = to;
    if (to === 'active') key.activatedAt = now;
    if (to === 'suspended') {
      key.suspendedAt = now;
      key.suspendReason = reason;
    }
    if (to === 'revoked') {
      key.revokedAt = now;
      key.revokeReason = reason;
    }

    // Record event
    const events = this.events.get(id) ?? [];
    events.push({ keyId: id, event, from, to, reason, timestamp: now });
    if (events.length > this.maxHistoryPerKey) {
      events.splice(0, events.length - this.maxHistoryPerKey);
    }
    this.events.set(id, events);

    return true;
  }

  private checkExpiration(key: KeyRecord): boolean {
    if (!key.expiresAt) return false;
    if (key.state === 'expired' || key.state === 'revoked') return false;
    if (key.state !== 'active') return false;

    const now = Date.now();
    const expiresAt = new Date(key.expiresAt).getTime();
    if (now >= expiresAt) {
      const from = key.state;
      key.state = 'expired';
      this.totalExpired++;

      const events = this.events.get(key.id) ?? [];
      events.push({
        keyId: key.id,
        event: 'expire',
        from,
        to: 'expired',
        reason: 'expiration date reached',
        timestamp: new Date().toISOString(),
      });
      this.events.set(key.id, events);
      return true;
    }
    return false;
  }
}
