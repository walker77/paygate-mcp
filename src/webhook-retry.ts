/**
 * WebhookRetryManager — Configurable retry with exponential backoff for webhooks.
 *
 * Queue failed webhook deliveries, apply exponential backoff,
 * track delivery attempts, and manage dead letter entries.
 *
 * @example
 * ```ts
 * const mgr = new WebhookRetryManager();
 *
 * mgr.enqueue({ url: 'https://example.com/hook', payload: { event: 'key.created' } });
 * const next = mgr.dequeue();
 * if (next) {
 *   try { await deliver(next); mgr.markDelivered(next.id); }
 *   catch { mgr.markFailed(next.id, 'Timeout'); }
 * }
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type RetryEntryStatus = 'pending' | 'delivered' | 'failed' | 'dead';

export interface RetryEntry {
  id: string;
  url: string;
  payload: unknown;
  status: RetryEntryStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  deliveredAt: number | null;
}

export interface EnqueueParams {
  url: string;
  payload: unknown;
  maxAttempts?: number;
}

export interface WebhookRetryConfig {
  /** Default max attempts. Default 5. */
  defaultMaxAttempts?: number;
  /** Base delay in ms for exponential backoff. Default 1000. */
  baseDelayMs?: number;
  /** Max delay in ms. Default 300000 (5 min). */
  maxDelayMs?: number;
  /** Backoff multiplier. Default 2. */
  backoffMultiplier?: number;
  /** Max queue size. Default 10000. */
  maxQueueSize?: number;
}

export interface WebhookRetryStats {
  pending: number;
  delivered: number;
  failed: number;
  dead: number;
  totalEnqueued: number;
  totalDelivered: number;
  totalDead: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class WebhookRetryManager {
  private entries = new Map<string, RetryEntry>();
  private nextId = 1;

  private defaultMaxAttempts: number;
  private baseDelayMs: number;
  private maxDelayMs: number;
  private backoffMultiplier: number;
  private maxQueueSize: number;

  // Stats
  private totalEnqueued = 0;
  private totalDelivered = 0;
  private totalDead = 0;

  constructor(config: WebhookRetryConfig = {}) {
    this.defaultMaxAttempts = config.defaultMaxAttempts ?? 5;
    this.baseDelayMs = config.baseDelayMs ?? 1000;
    this.maxDelayMs = config.maxDelayMs ?? 300_000;
    this.backoffMultiplier = config.backoffMultiplier ?? 2;
    this.maxQueueSize = config.maxQueueSize ?? 10_000;
  }

  // ── Queue Operations ──────────────────────────────────────────

  /** Enqueue a webhook for delivery/retry. */
  enqueue(params: EnqueueParams): RetryEntry {
    if (!params.url) throw new Error('URL is required');
    if (this.entries.size >= this.maxQueueSize) {
      throw new Error(`Maximum queue size ${this.maxQueueSize} reached`);
    }

    const entry: RetryEntry = {
      id: `wr_${this.nextId++}`,
      url: params.url,
      payload: params.payload,
      status: 'pending',
      attempts: 0,
      maxAttempts: params.maxAttempts ?? this.defaultMaxAttempts,
      nextAttemptAt: Date.now(),
      lastError: null,
      createdAt: Date.now(),
      deliveredAt: null,
    };

    this.entries.set(entry.id, entry);
    this.totalEnqueued++;
    return entry;
  }

  /** Get the next entry ready for delivery. */
  dequeue(): RetryEntry | null {
    const now = Date.now();
    let oldest: RetryEntry | null = null;

    for (const entry of this.entries.values()) {
      if (entry.status === 'pending' && entry.nextAttemptAt <= now) {
        if (!oldest || entry.nextAttemptAt < oldest.nextAttemptAt) {
          oldest = entry;
        }
      }
    }

    return oldest;
  }

  /** Get all entries ready for delivery. */
  dequeueAll(): RetryEntry[] {
    const now = Date.now();
    return [...this.entries.values()]
      .filter(e => e.status === 'pending' && e.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
  }

  // ── Delivery Tracking ─────────────────────────────────────────

  /** Mark an entry as successfully delivered. */
  markDelivered(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Entry '${id}' not found`);
    entry.status = 'delivered';
    entry.deliveredAt = Date.now();
    entry.attempts++;
    this.totalDelivered++;
  }

  /** Mark an entry as failed (will retry or go to dead letter). */
  markFailed(id: string, error: string): void {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Entry '${id}' not found`);

    entry.attempts++;
    entry.lastError = error;

    if (entry.attempts >= entry.maxAttempts) {
      entry.status = 'dead';
      this.totalDead++;
    } else {
      // Calculate next attempt with exponential backoff
      const delay = Math.min(
        this.baseDelayMs * Math.pow(this.backoffMultiplier, entry.attempts - 1),
        this.maxDelayMs,
      );
      entry.nextAttemptAt = Date.now() + delay;
    }
  }

  // ── Entry Management ──────────────────────────────────────────

  /** Get entry by ID. */
  getEntry(id: string): RetryEntry | null {
    return this.entries.get(id) ?? null;
  }

  /** List entries by status. */
  listEntries(status?: RetryEntryStatus): RetryEntry[] {
    const all = [...this.entries.values()];
    return status ? all.filter(e => e.status === status) : all;
  }

  /** Remove an entry. */
  removeEntry(id: string): boolean {
    return this.entries.delete(id);
  }

  /** Remove all dead letter entries. */
  purgeDead(): number {
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (entry.status === 'dead') {
        this.entries.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Retry a dead letter entry (reset for new attempts). */
  retryDead(id: string, additionalAttempts?: number): RetryEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Entry '${id}' not found`);
    if (entry.status !== 'dead') throw new Error(`Entry '${id}' is not dead`);

    entry.status = 'pending';
    entry.maxAttempts = entry.attempts + (additionalAttempts ?? this.defaultMaxAttempts);
    entry.nextAttemptAt = Date.now();
    return entry;
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): WebhookRetryStats {
    let pending = 0, delivered = 0, failed = 0, dead = 0;
    for (const e of this.entries.values()) {
      switch (e.status) {
        case 'pending': pending++; break;
        case 'delivered': delivered++; break;
        case 'failed': failed++; break;
        case 'dead': dead++; break;
      }
    }

    return {
      pending, delivered, failed, dead,
      totalEnqueued: this.totalEnqueued,
      totalDelivered: this.totalDelivered,
      totalDead: this.totalDead,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.entries.clear();
    this.totalEnqueued = 0;
    this.totalDelivered = 0;
    this.totalDead = 0;
  }
}
