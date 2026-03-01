/**
 * WebhookDeliveryLog — Persistent delivery log with status tracking.
 *
 * Track every webhook delivery attempt with response codes,
 * timing, retry history, and filtering capabilities.
 *
 * @example
 * ```ts
 * const log = new WebhookDeliveryLog();
 *
 * const entry = log.record({
 *   url: 'https://example.com/hook',
 *   event: 'key.created',
 *   payload: { key: 'k1' },
 *   statusCode: 200,
 *   durationMs: 150,
 * });
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type DeliveryStatus = 'success' | 'failed' | 'pending' | 'retrying';

export interface DeliveryEntry {
  id: string;
  url: string;
  event: string;
  payload: unknown;
  statusCode: number | null;
  status: DeliveryStatus;
  durationMs: number;
  attempts: number;
  lastAttemptAt: number;
  createdAt: number;
  error: string | null;
}

export interface DeliveryRecordParams {
  url: string;
  event: string;
  payload: unknown;
  statusCode?: number;
  durationMs?: number;
  error?: string;
}

export interface DeliveryRetryParams {
  statusCode?: number;
  durationMs?: number;
  error?: string;
}

export interface DeliveryQuery {
  url?: string;
  event?: string;
  status?: DeliveryStatus;
  since?: number;
  limit?: number;
}

export interface DeliveryLogConfig {
  /** Max entries to keep. Default 10000. */
  maxEntries?: number;
}

export interface DeliveryLogStats {
  totalEntries: number;
  totalSuccess: number;
  totalFailed: number;
  totalPending: number;
  totalRetrying: number;
  avgDurationMs: number;
  urlBreakdown: { url: string; count: number; successRate: number }[];
}

// ── Implementation ───────────────────────────────────────────────────

export class WebhookDeliveryLog {
  private entries: DeliveryEntry[] = [];
  private entryMap = new Map<string, DeliveryEntry>();
  private nextId = 1;
  private maxEntries: number;

  constructor(config: DeliveryLogConfig = {}) {
    this.maxEntries = config.maxEntries ?? 10_000;
  }

  // ── Recording ───────────────────────────────────────────────────

  /** Record a delivery attempt. */
  record(params: DeliveryRecordParams): DeliveryEntry {
    const now = Date.now();

    const status: DeliveryStatus = params.error
      ? 'failed'
      : params.statusCode !== undefined
        ? (params.statusCode >= 200 && params.statusCode < 300 ? 'success' : 'failed')
        : 'pending';

    const entry: DeliveryEntry = {
      id: `dlv_${this.nextId++}`,
      url: params.url,
      event: params.event,
      payload: params.payload,
      statusCode: params.statusCode ?? null,
      status,
      durationMs: params.durationMs ?? 0,
      attempts: 1,
      lastAttemptAt: now,
      createdAt: now,
      error: params.error ?? null,
    };

    this.addEntry(entry);
    return entry;
  }

  /** Record a retry attempt for an existing entry. */
  recordRetry(id: string, params: DeliveryRetryParams): DeliveryEntry | null {
    const entry = this.entryMap.get(id);
    if (!entry) return null;

    entry.attempts++;
    entry.lastAttemptAt = Date.now();
    entry.durationMs = params.durationMs ?? entry.durationMs;
    entry.error = params.error ?? null;

    if (params.error) {
      entry.status = 'failed';
    } else if (params.statusCode !== undefined) {
      entry.statusCode = params.statusCode;
      entry.status = params.statusCode >= 200 && params.statusCode < 300 ? 'success' : 'failed';
    } else {
      entry.status = 'retrying';
    }

    return entry;
  }

  /** Mark an entry as pending retry. */
  markRetrying(id: string): boolean {
    const entry = this.entryMap.get(id);
    if (!entry) return false;
    entry.status = 'retrying';
    return true;
  }

  // ── Query ───────────────────────────────────────────────────────

  /** Query delivery entries. */
  query(options: DeliveryQuery = {}): DeliveryEntry[] {
    let results = [...this.entries];

    if (options.url) results = results.filter(e => e.url === options.url);
    if (options.event) results = results.filter(e => e.event === options.event);
    if (options.status) results = results.filter(e => e.status === options.status);
    if (options.since) results = results.filter(e => e.createdAt >= options.since!);

    return results.slice(-(options.limit ?? 50));
  }

  /** Get a specific entry by ID. */
  getEntry(id: string): DeliveryEntry | null {
    return this.entryMap.get(id) ?? null;
  }

  /** Get failed entries that haven't been retried. */
  getFailedEntries(limit = 50): DeliveryEntry[] {
    return this.entries
      .filter(e => e.status === 'failed')
      .slice(-limit);
  }

  /** Get success rate for a URL. */
  getSuccessRate(url: string): number {
    const urlEntries = this.entries.filter(e => e.url === url);
    if (urlEntries.length === 0) return 0;
    const successes = urlEntries.filter(e => e.status === 'success').length;
    return Math.round((successes / urlEntries.length) * 10000) / 100;
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): DeliveryLogStats {
    let totalDuration = 0;
    let durationCount = 0;
    const urlStats = new Map<string, { count: number; successes: number }>();

    for (const e of this.entries) {
      if (e.durationMs > 0) {
        totalDuration += e.durationMs;
        durationCount++;
      }

      const stat = urlStats.get(e.url) ?? { count: 0, successes: 0 };
      stat.count++;
      if (e.status === 'success') stat.successes++;
      urlStats.set(e.url, stat);
    }

    const urlBreakdown = [...urlStats.entries()]
      .map(([url, stat]) => ({
        url,
        count: stat.count,
        successRate: Math.round((stat.successes / stat.count) * 10000) / 100,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      totalEntries: this.entries.length,
      totalSuccess: this.entries.filter(e => e.status === 'success').length,
      totalFailed: this.entries.filter(e => e.status === 'failed').length,
      totalPending: this.entries.filter(e => e.status === 'pending').length,
      totalRetrying: this.entries.filter(e => e.status === 'retrying').length,
      avgDurationMs: durationCount > 0 ? Math.round(totalDuration / durationCount) : 0,
      urlBreakdown,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.entries = [];
    this.entryMap.clear();
  }

  // ── Private ───────────────────────────────────────────────────

  private addEntry(entry: DeliveryEntry): void {
    this.entries.push(entry);
    this.entryMap.set(entry.id, entry);

    if (this.entries.length > this.maxEntries) {
      const removed = this.entries.splice(0, this.entries.length - this.maxEntries);
      for (const r of removed) this.entryMap.delete(r.id);
    }
  }
}
