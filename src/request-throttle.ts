/**
 * RequestThrottleQueue — Smooth request throughput with configurable concurrency.
 *
 * Control concurrent request execution per key with queue depth
 * limits and fair scheduling.
 *
 * @example
 * ```ts
 * const throttle = new RequestThrottleQueue({ maxConcurrent: 5, maxQueueDepth: 100 });
 *
 * const ticket = throttle.tryAcquire('key1');
 * if (ticket) {
 *   try { await processRequest(); }
 *   finally { throttle.release(ticket.id); }
 * }
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface ThrottleTicket {
  id: string;
  key: string;
  acquiredAt: number;
}

export interface ThrottleQueueEntry {
  id: string;
  key: string;
  enqueuedAt: number;
}

export type ThrottleResult =
  | { status: 'acquired'; ticket: ThrottleTicket }
  | { status: 'queued'; position: number; queueDepth: number }
  | { status: 'rejected'; reason: string };

export interface KeyThrottleStatus {
  key: string;
  active: number;
  queued: number;
  maxConcurrent: number;
  maxQueueDepth: number;
}

export interface RequestThrottleConfig {
  /** Max concurrent requests per key. Default 10. */
  maxConcurrent?: number;
  /** Max queue depth per key. Default 100. */
  maxQueueDepth?: number;
  /** Max tracked keys. Default 10000. */
  maxKeys?: number;
}

export interface RequestThrottleStats {
  trackedKeys: number;
  totalActive: number;
  totalQueued: number;
  totalAcquired: number;
  totalReleased: number;
  totalRejected: number;
}

// ── Implementation ───────────────────────────────────────────────────

interface KeySlot {
  active: Map<string, ThrottleTicket>;
  queue: ThrottleQueueEntry[];
}

export class RequestThrottleQueue {
  private slots = new Map<string, KeySlot>();
  private nextId = 1;
  private maxConcurrent: number;
  private maxQueueDepth: number;
  private maxKeys: number;

  // Stats
  private totalAcquired = 0;
  private totalReleased = 0;
  private totalRejected = 0;

  constructor(config: RequestThrottleConfig = {}) {
    this.maxConcurrent = config.maxConcurrent ?? 10;
    this.maxQueueDepth = config.maxQueueDepth ?? 100;
    this.maxKeys = config.maxKeys ?? 10_000;
  }

  // ── Core Operations ─────────────────────────────────────────────

  /** Try to acquire a concurrency slot. */
  tryAcquire(key: string): ThrottleResult {
    const slot = this.getOrCreate(key);

    if (slot.active.size < this.maxConcurrent) {
      const ticket: ThrottleTicket = {
        id: `tt_${this.nextId++}`,
        key,
        acquiredAt: Date.now(),
      };
      slot.active.set(ticket.id, ticket);
      this.totalAcquired++;
      return { status: 'acquired', ticket };
    }

    // Queue if possible
    if (slot.queue.length < this.maxQueueDepth) {
      const entry: ThrottleQueueEntry = {
        id: `tq_${this.nextId++}`,
        key,
        enqueuedAt: Date.now(),
      };
      slot.queue.push(entry);
      return { status: 'queued', position: slot.queue.length, queueDepth: slot.queue.length };
    }

    this.totalRejected++;
    return { status: 'rejected', reason: 'Queue full' };
  }

  /** Release a concurrency slot and promote next queued request. */
  release(ticketId: string): ThrottleTicket | null {
    for (const [key, slot] of this.slots) {
      if (slot.active.has(ticketId)) {
        slot.active.delete(ticketId);
        this.totalReleased++;

        // Promote from queue
        if (slot.queue.length > 0) {
          const next = slot.queue.shift()!;
          const ticket: ThrottleTicket = {
            id: next.id,
            key,
            acquiredAt: Date.now(),
          };
          slot.active.set(ticket.id, ticket);
          this.totalAcquired++;
          return ticket;
        }

        // Clean up empty slots
        if (slot.active.size === 0 && slot.queue.length === 0) {
          this.slots.delete(key);
        }

        return null;
      }
    }
    return null;
  }

  // ── Query ───────────────────────────────────────────────────────

  /** Get throttle status for a key. */
  getKeyStatus(key: string): KeyThrottleStatus {
    const slot = this.slots.get(key);
    return {
      key,
      active: slot?.active.size ?? 0,
      queued: slot?.queue.length ?? 0,
      maxConcurrent: this.maxConcurrent,
      maxQueueDepth: this.maxQueueDepth,
    };
  }

  /** Get all keys with active or queued requests. */
  getActiveKeys(): KeyThrottleStatus[] {
    return [...this.slots.entries()].map(([key, slot]) => ({
      key,
      active: slot.active.size,
      queued: slot.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueueDepth: this.maxQueueDepth,
    }));
  }

  /** Cancel a queued request. */
  cancelQueued(entryId: string): boolean {
    for (const slot of this.slots.values()) {
      const idx = slot.queue.findIndex(e => e.id === entryId);
      if (idx !== -1) {
        slot.queue.splice(idx, 1);
        return true;
      }
    }
    return false;
  }

  /** Clear all queue entries for a key. */
  clearQueue(key: string): number {
    const slot = this.slots.get(key);
    if (!slot) return 0;
    const count = slot.queue.length;
    slot.queue = [];
    return count;
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): RequestThrottleStats {
    let totalActive = 0;
    let totalQueued = 0;

    for (const slot of this.slots.values()) {
      totalActive += slot.active.size;
      totalQueued += slot.queue.length;
    }

    return {
      trackedKeys: this.slots.size,
      totalActive,
      totalQueued,
      totalAcquired: this.totalAcquired,
      totalReleased: this.totalReleased,
      totalRejected: this.totalRejected,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.slots.clear();
    this.totalAcquired = 0;
    this.totalReleased = 0;
    this.totalRejected = 0;
  }

  // ── Private ───────────────────────────────────────────────────

  private getOrCreate(key: string): KeySlot {
    let slot = this.slots.get(key);
    if (!slot) {
      if (this.slots.size >= this.maxKeys) {
        // Evict key with no active or queued requests
        for (const [k, s] of this.slots) {
          if (s.active.size === 0 && s.queue.length === 0) {
            this.slots.delete(k);
            break;
          }
        }
      }
      slot = { active: new Map(), queue: [] };
      this.slots.set(key, slot);
    }
    return slot;
  }
}
