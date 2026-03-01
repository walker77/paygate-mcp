/**
 * RequestBufferQueue — Buffer and replay requests during maintenance or outages.
 *
 * Queue incoming requests when a backend is unavailable, then replay
 * them in order once the backend recovers. Supports TTL-based expiry
 * and priority ordering.
 *
 * @example
 * ```ts
 * const buffer = new RequestBufferQueue();
 *
 * buffer.startBuffering('maintenance');
 * buffer.enqueue({ method: 'tools/call', params: { name: 'search' } });
 *
 * // Later, when backend is ready:
 * const requests = buffer.drain();
 * buffer.stopBuffering();
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface BufferedRequest {
  id: string;
  payload: unknown;
  key?: string;
  priority: number;
  enqueuedAt: number;
  expiresAt: number | null;
}

export interface BufferEnqueueParams {
  payload: unknown;
  key?: string;
  priority?: number;
  ttlMs?: number;
}

export type BufferStatus = 'idle' | 'buffering' | 'draining';

export interface RequestBufferConfig {
  /** Max buffered requests. Default 10000. */
  maxSize?: number;
  /** Default TTL for buffered requests in ms. Default 300000 (5 min). */
  defaultTtlMs?: number;
  /** Whether to sort by priority on drain. Default true. */
  priorityDrain?: boolean;
}

export interface RequestBufferStats {
  status: BufferStatus;
  bufferedCount: number;
  totalEnqueued: number;
  totalDrained: number;
  totalExpired: number;
  totalDropped: number;
  bufferingReason: string | null;
  bufferingSince: number | null;
}

// ── Implementation ───────────────────────────────────────────────────

export class RequestBufferQueue {
  private queue: BufferedRequest[] = [];
  private status: BufferStatus = 'idle';
  private bufferingReason: string | null = null;
  private bufferingSince: number | null = null;
  private nextId = 1;

  private maxSize: number;
  private defaultTtlMs: number;
  private priorityDrain: boolean;

  // Stats
  private totalEnqueued = 0;
  private totalDrained = 0;
  private totalExpired = 0;
  private totalDropped = 0;

  constructor(config: RequestBufferConfig = {}) {
    this.maxSize = config.maxSize ?? 10_000;
    this.defaultTtlMs = config.defaultTtlMs ?? 300_000;
    this.priorityDrain = config.priorityDrain ?? true;
  }

  // ── Buffer Control ─────────────────────────────────────────────

  /** Start buffering requests. */
  startBuffering(reason?: string): void {
    if (this.status === 'buffering') return;
    this.status = 'buffering';
    this.bufferingReason = reason ?? 'manual';
    this.bufferingSince = Date.now();
  }

  /** Stop buffering (new requests will be rejected). */
  stopBuffering(): void {
    this.status = 'idle';
    this.bufferingReason = null;
    this.bufferingSince = null;
  }

  /** Check if currently buffering. */
  isBuffering(): boolean {
    return this.status === 'buffering';
  }

  // ── Queue Operations ───────────────────────────────────────────

  /** Enqueue a request for buffering. */
  enqueue(params: BufferEnqueueParams): BufferedRequest | null {
    if (this.status !== 'buffering') return null;

    // Remove expired entries first
    this.pruneExpired();

    if (this.queue.length >= this.maxSize) {
      this.totalDropped++;
      return null;
    }

    const now = Date.now();
    const ttl = params.ttlMs ?? this.defaultTtlMs;

    const request: BufferedRequest = {
      id: `br_${this.nextId++}`,
      payload: params.payload,
      key: params.key,
      priority: params.priority ?? 0,
      enqueuedAt: now,
      expiresAt: ttl > 0 ? now + ttl : null,
    };

    this.queue.push(request);
    this.totalEnqueued++;
    return request;
  }

  /** Drain all buffered requests (oldest first, respecting priority). */
  drain(): BufferedRequest[] {
    this.pruneExpired();
    this.status = 'draining';

    let requests = [...this.queue];
    if (this.priorityDrain) {
      // Higher priority first, then FIFO within same priority
      requests.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
    }

    this.totalDrained += requests.length;
    this.queue = [];
    this.status = 'idle';
    this.bufferingReason = null;
    this.bufferingSince = null;
    return requests;
  }

  /** Drain up to N requests. */
  drainBatch(count: number): BufferedRequest[] {
    this.pruneExpired();

    let requests = [...this.queue];
    if (this.priorityDrain) {
      requests.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
    }

    const batch = requests.slice(0, count);
    const batchIds = new Set(batch.map(r => r.id));
    this.queue = this.queue.filter(r => !batchIds.has(r.id));
    this.totalDrained += batch.length;
    return batch;
  }

  /** Peek at buffered requests without draining. */
  peek(limit = 10): BufferedRequest[] {
    this.pruneExpired();
    return this.queue.slice(0, limit);
  }

  /** Get buffered count. */
  size(): number {
    return this.queue.length;
  }

  /** Remove a specific buffered request. */
  remove(id: string): boolean {
    const idx = this.queue.findIndex(r => r.id === id);
    if (idx === -1) return false;
    this.queue.splice(idx, 1);
    return true;
  }

  /** Discard all buffered requests. */
  discardAll(): number {
    const count = this.queue.length;
    this.queue = [];
    this.totalDropped += count;
    return count;
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): RequestBufferStats {
    return {
      status: this.status,
      bufferedCount: this.queue.length,
      totalEnqueued: this.totalEnqueued,
      totalDrained: this.totalDrained,
      totalExpired: this.totalExpired,
      totalDropped: this.totalDropped,
      bufferingReason: this.bufferingReason,
      bufferingSince: this.bufferingSince,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.queue = [];
    this.status = 'idle';
    this.bufferingReason = null;
    this.bufferingSince = null;
    this.totalEnqueued = 0;
    this.totalDrained = 0;
    this.totalExpired = 0;
    this.totalDropped = 0;
  }

  // ── Private ───────────────────────────────────────────────────

  private pruneExpired(): void {
    const now = Date.now();
    const before = this.queue.length;
    this.queue = this.queue.filter(r => !r.expiresAt || r.expiresAt > now);
    this.totalExpired += before - this.queue.length;
  }
}
