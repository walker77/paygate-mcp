/**
 * RequestDeduplicator — Idempotency layer for MCP tool calls.
 *
 * Prevents duplicate billing when agents retry the same request due to
 * timeouts, network flakiness, or client-side retry logic. Clients send
 * an `X-Idempotency-Key` header or the proxy auto-generates one via
 * SHA-256 of apiKey + tool + sorted args.
 *
 * Features:
 *   - X-Idempotency-Key header support with auto-generation fallback
 *   - In-flight request coalescing (concurrent duplicates share the first result)
 *   - Configurable TTL window for completed request dedup
 *   - Per-key dedup tracking with LRU eviction
 *   - Stats: deduplicated requests, coalesced in-flight, credits saved
 *
 * Zero external dependencies.
 */

import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DedupConfig {
  /** Enable deduplication. Default true. */
  enabled: boolean;
  /** TTL in ms for completed request cache. Default 60_000 (60s). */
  ttlMs: number;
  /** Max cached entries. Default 10_000. */
  maxEntries: number;
  /** Auto-generate idempotency key from apiKey+tool+args when header missing. Default true. */
  autoGenerate: boolean;
}

export interface DedupEntry {
  key: string;
  result: unknown;
  completedAt: number;
  toolName: string;
  apiKey: string;
}

export interface InFlightEntry {
  promise: Promise<unknown>;
  toolName: string;
  apiKey: string;
  startedAt: number;
}

export interface DedupStats {
  enabled: boolean;
  config: DedupConfig;
  cachedEntries: number;
  inFlightEntries: number;
  totalDeduped: number;
  totalCoalesced: number;
  creditsSaved: number;
  hitRate: number;
  totalChecks: number;
}

export interface DedupResult<T> {
  result: T;
  deduplicated: boolean;
  idempotencyKey: string;
}

// ─── Default config ─────────────────────────────────────────────────────────

const DEFAULT_DEDUP_CONFIG: DedupConfig = {
  enabled: true,
  ttlMs: 60_000,
  maxEntries: 10_000,
  autoGenerate: true,
};

// ─── RequestDeduplicator Class ──────────────────────────────────────────────

export class RequestDeduplicator {
  private config: DedupConfig;

  // Completed request cache (key → result)
  private cache = new Map<string, DedupEntry>();
  // In-flight requests (key → promise)
  private inFlight = new Map<string, InFlightEntry>();

  // Stats
  private totalDeduped = 0;
  private totalCoalesced = 0;
  private creditsSaved = 0;
  private totalChecks = 0;

  // Insertion order for LRU eviction
  private insertionOrder: string[] = [];

  constructor(config?: Partial<DedupConfig>) {
    this.config = { ...DEFAULT_DEDUP_CONFIG, ...config };
  }

  /**
   * Generate an idempotency key from request parameters.
   */
  generateKey(apiKey: string, toolName: string, args: unknown): string {
    const argsStr = typeof args === 'object' && args !== null
      ? JSON.stringify(this.sortKeys(args as Record<string, unknown>))
      : String(args ?? '');
    return crypto.createHash('sha256')
      .update(`${apiKey}:${toolName}:${argsStr}`)
      .digest('hex')
      .slice(0, 32);
  }

  /**
   * Execute a function with deduplication.
   * If an identical request is in-flight, coalesces onto it.
   * If a completed result is cached, returns it immediately.
   */
  async execute<T>(
    idempotencyKey: string,
    apiKey: string,
    toolName: string,
    creditCost: number,
    fn: () => Promise<T>,
  ): Promise<DedupResult<T>> {
    this.totalChecks++;

    if (!this.config.enabled) {
      const result = await fn();
      return { result, deduplicated: false, idempotencyKey };
    }

    // Check completed cache
    const cached = this.cache.get(idempotencyKey);
    if (cached && (Date.now() - cached.completedAt) < this.config.ttlMs) {
      this.totalDeduped++;
      this.creditsSaved += creditCost;
      return { result: cached.result as T, deduplicated: true, idempotencyKey };
    }

    // Check in-flight
    const flight = this.inFlight.get(idempotencyKey);
    if (flight) {
      this.totalCoalesced++;
      this.creditsSaved += creditCost;
      const result = await flight.promise;
      return { result: result as T, deduplicated: true, idempotencyKey };
    }

    // Execute and track as in-flight
    let resolve: (value: unknown) => void;
    let reject: (error: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
    // Prevent unhandled rejection if nobody coalesces onto this promise
    promise.catch(() => {});

    this.inFlight.set(idempotencyKey, {
      promise,
      toolName,
      apiKey,
      startedAt: Date.now(),
    });

    try {
      const result = await fn();

      // Cache the completed result
      this.cacheResult(idempotencyKey, result, toolName, apiKey);

      // Resolve in-flight promise for coalesced callers
      resolve!(result);

      return { result, deduplicated: false, idempotencyKey };
    } catch (err) {
      // Don't cache errors — let retries go through
      reject!(err);
      throw err;
    } finally {
      this.inFlight.delete(idempotencyKey);
    }
  }

  /**
   * Update dedup configuration at runtime.
   */
  configure(updates: Partial<DedupConfig>): DedupConfig {
    if (updates.enabled !== undefined) this.config.enabled = updates.enabled;
    if (updates.ttlMs !== undefined) this.config.ttlMs = Math.max(1000, updates.ttlMs);
    if (updates.maxEntries !== undefined) this.config.maxEntries = Math.max(100, Math.min(100_000, updates.maxEntries));
    if (updates.autoGenerate !== undefined) this.config.autoGenerate = updates.autoGenerate;
    return { ...this.config };
  }

  /**
   * Clear the dedup cache.
   */
  clear(): void {
    this.cache.clear();
    this.insertionOrder = [];
  }

  /**
   * Get statistics.
   */
  stats(): DedupStats {
    this.pruneExpired();
    return {
      enabled: this.config.enabled,
      config: { ...this.config },
      cachedEntries: this.cache.size,
      inFlightEntries: this.inFlight.size,
      totalDeduped: this.totalDeduped,
      totalCoalesced: this.totalCoalesced,
      creditsSaved: this.creditsSaved,
      hitRate: this.totalChecks > 0 ? Math.round(((this.totalDeduped + this.totalCoalesced) / this.totalChecks) * 100) : 0,
      totalChecks: this.totalChecks,
    };
  }

  /** Is dedup enabled? */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Current config. */
  get currentConfig(): DedupConfig {
    return { ...this.config };
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private cacheResult(key: string, result: unknown, toolName: string, apiKey: string): void {
    // Evict oldest entries if at capacity
    while (this.cache.size >= this.config.maxEntries && this.insertionOrder.length > 0) {
      const oldest = this.insertionOrder.shift()!;
      this.cache.delete(oldest);
    }

    this.cache.set(key, {
      key,
      result,
      completedAt: Date.now(),
      toolName,
      apiKey,
    });
    this.insertionOrder.push(key);
  }

  private pruneExpired(): void {
    const cutoff = Date.now() - this.config.ttlMs;
    const toRemove: string[] = [];
    for (const [key, entry] of this.cache) {
      if (entry.completedAt < cutoff) toRemove.push(key);
    }
    for (const key of toRemove) {
      this.cache.delete(key);
    }
    this.insertionOrder = this.insertionOrder.filter(k => this.cache.has(k));
  }

  private sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const val = obj[key];
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        sorted[key] = this.sortKeys(val as Record<string, unknown>);
      } else {
        sorted[key] = val;
      }
    }
    return sorted;
  }
}
