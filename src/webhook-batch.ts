/**
 * WebhookBatchProcessor — Batch multiple webhook events into single deliveries.
 *
 * Accumulate webhook events and flush them in batches for efficient
 * delivery, reducing HTTP overhead for high-throughput scenarios.
 *
 * @example
 * ```ts
 * const batch = new WebhookBatchProcessor({
 *   maxBatchSize: 50,
 *   flushIntervalMs: 5000,
 *   onFlush: async (url, events) => {
 *     await fetch(url, { method: 'POST', body: JSON.stringify(events) });
 *   },
 * });
 *
 * batch.add('https://hook.example.com', { event: 'key.created', keyId: 'k_1' });
 * batch.add('https://hook.example.com', { event: 'key.created', keyId: 'k_2' });
 * // Events are automatically batched and flushed
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface BatchEvent {
  id: string;
  url: string;
  payload: unknown;
  addedAt: number;
}

export interface BatchFlushResult {
  url: string;
  events: BatchEvent[];
  flushedAt: number;
  success: boolean;
  error?: string;
}

export type FlushHandler = (url: string, events: BatchEvent[]) => Promise<void> | void;

export interface WebhookBatchConfig {
  /** Max events per batch. Default 100. */
  maxBatchSize?: number;
  /** Flush interval in ms. Default 5000 (5s). */
  flushIntervalMs?: number;
  /** Max queued events across all URLs. Default 10000. */
  maxQueueSize?: number;
  /** Flush handler callback. */
  onFlush?: FlushHandler;
}

export interface WebhookBatchStats {
  queuedEvents: number;
  totalAdded: number;
  totalFlushed: number;
  totalFlushes: number;
  totalErrors: number;
  activeUrls: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class WebhookBatchProcessor {
  private queues = new Map<string, BatchEvent[]>();
  private flushHandler: FlushHandler | null;
  private flushHistory: BatchFlushResult[] = [];
  private nextId = 1;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  private maxBatchSize: number;
  private flushIntervalMs: number;
  private maxQueueSize: number;

  // Stats
  private totalAdded = 0;
  private totalFlushed = 0;
  private totalFlushes = 0;
  private totalErrors = 0;

  constructor(config: WebhookBatchConfig = {}) {
    this.maxBatchSize = config.maxBatchSize ?? 100;
    this.flushIntervalMs = config.flushIntervalMs ?? 5000;
    this.maxQueueSize = config.maxQueueSize ?? 10_000;
    this.flushHandler = config.onFlush ?? null;
  }

  /** Set the flush handler. */
  setFlushHandler(handler: FlushHandler): void {
    this.flushHandler = handler;
  }

  /** Start automatic periodic flushing. */
  startAutoFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flushAll();
    }, this.flushIntervalMs);
  }

  /** Stop automatic flushing. */
  stopAutoFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // ── Event Management ───────────────────────────────────────────

  /** Add an event to the batch queue. */
  add(url: string, payload: unknown): BatchEvent {
    if (!url) throw new Error('URL is required');

    const totalQueued = this.getTotalQueued();
    if (totalQueued >= this.maxQueueSize) {
      throw new Error(`Maximum queue size ${this.maxQueueSize} reached`);
    }

    const event: BatchEvent = {
      id: `be_${this.nextId++}`,
      url,
      payload,
      addedAt: Date.now(),
    };

    let queue = this.queues.get(url);
    if (!queue) {
      queue = [];
      this.queues.set(url, queue);
    }
    queue.push(event);
    this.totalAdded++;

    // Auto-flush if batch size reached
    if (queue.length >= this.maxBatchSize) {
      this.flush(url);
    }

    return event;
  }

  /** Flush events for a specific URL. */
  flush(url: string): BatchFlushResult | null {
    const queue = this.queues.get(url);
    if (!queue || queue.length === 0) return null;

    const events = queue.splice(0, this.maxBatchSize);
    if (queue.length === 0) this.queues.delete(url);

    const result: BatchFlushResult = {
      url,
      events,
      flushedAt: Date.now(),
      success: true,
    };

    if (this.flushHandler) {
      try {
        this.flushHandler(url, events);
      } catch (e) {
        result.success = false;
        result.error = String(e);
        this.totalErrors++;
      }
    }

    this.totalFlushed += events.length;
    this.totalFlushes++;
    this.flushHistory.push(result);

    // Keep last 100 flush results
    if (this.flushHistory.length > 100) {
      this.flushHistory.splice(0, this.flushHistory.length - 100);
    }

    return result;
  }

  /** Flush all queued events across all URLs. */
  flushAll(): BatchFlushResult[] {
    const results: BatchFlushResult[] = [];
    const urls = [...this.queues.keys()];
    for (const url of urls) {
      let result = this.flush(url);
      while (result) {
        results.push(result);
        result = this.flush(url);
      }
    }
    return results;
  }

  // ── Query ──────────────────────────────────────────────────────

  /** Get queued event count for a URL. */
  getQueueSize(url: string): number {
    return this.queues.get(url)?.length ?? 0;
  }

  /** Get all queued URLs. */
  getQueuedUrls(): string[] {
    return [...this.queues.keys()];
  }

  /** Get recent flush history. */
  getFlushHistory(limit = 10): BatchFlushResult[] {
    return this.flushHistory.slice(-limit);
  }

  /** Discard all queued events for a URL. */
  discardQueue(url: string): number {
    const queue = this.queues.get(url);
    if (!queue) return 0;
    const count = queue.length;
    this.queues.delete(url);
    return count;
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): WebhookBatchStats {
    return {
      queuedEvents: this.getTotalQueued(),
      totalAdded: this.totalAdded,
      totalFlushed: this.totalFlushed,
      totalFlushes: this.totalFlushes,
      totalErrors: this.totalErrors,
      activeUrls: this.queues.size,
    };
  }

  /** Clear all data and stop auto-flush. */
  destroy(): void {
    this.stopAutoFlush();
    this.queues.clear();
    this.flushHistory = [];
    this.totalAdded = 0;
    this.totalFlushed = 0;
    this.totalFlushes = 0;
    this.totalErrors = 0;
  }

  // ── Private ───────────────────────────────────────────────────

  private getTotalQueued(): number {
    let total = 0;
    for (const q of this.queues.values()) total += q.length;
    return total;
  }
}
