/**
 * ResponseCache — Caches tool call responses to reduce backend load and save credits.
 *
 * Cache key = SHA-256(toolName + sorted JSON args).
 * Cache hits skip credit deduction and backend invocation.
 * Per-tool TTL overrides global TTL.
 * LRU eviction when max entries exceeded.
 */

import { createHash } from 'crypto';

export interface CacheEntry {
  /** The cached response object. */
  response: unknown;
  /** Unix timestamp (ms) when entry was created. */
  createdAt: number;
  /** TTL in seconds for this entry. */
  ttlSeconds: number;
  /** Tool name that produced this response. */
  toolName: string;
  /** Number of times this entry was served. */
  hitCount: number;
  /** Last access time (ms). */
  lastAccessedAt: number;
}

export interface CacheStats {
  /** Total cache entries. */
  entries: number;
  /** Total cache hits since start. */
  hits: number;
  /** Total cache misses since start. */
  misses: number;
  /** Hit rate percentage (0-100). */
  hitRate: number;
  /** Per-tool breakdown. */
  tools: Record<string, { entries: number; hits: number }>;
  /** Maximum entries allowed. */
  maxEntries: number;
  /** Number of evictions performed. */
  evictions: number;
}

export class ResponseCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private totalHits = 0;
  private totalMisses = 0;
  private totalEvictions = 0;

  constructor(maxEntries = 10_000) {
    this.maxEntries = Math.max(1, Math.min(maxEntries, 100_000));
  }

  /**
   * Generate a deterministic cache key from tool name and arguments.
   */
  static cacheKey(toolName: string, args: Record<string, unknown> | undefined): string {
    const sorted = args ? JSON.stringify(args, Object.keys(args).sort()) : '{}';
    return createHash('sha256').update(`${toolName}:${sorted}`).digest('hex');
  }

  /**
   * Look up a cached response. Returns undefined on miss or expiry.
   */
  get(toolName: string, args: Record<string, unknown> | undefined): unknown | undefined {
    const key = ResponseCache.cacheKey(toolName, args);
    const entry = this.cache.get(key);
    if (!entry) {
      this.totalMisses++;
      return undefined;
    }
    // Check expiry
    const now = Date.now();
    if (now - entry.createdAt > entry.ttlSeconds * 1000) {
      this.cache.delete(key);
      this.totalMisses++;
      return undefined;
    }
    // Cache hit
    entry.hitCount++;
    entry.lastAccessedAt = now;
    this.totalHits++;
    return entry.response;
  }

  /**
   * Store a response in the cache.
   */
  set(toolName: string, args: Record<string, unknown> | undefined, response: unknown, ttlSeconds: number): void {
    if (ttlSeconds <= 0) return;
    const key = ResponseCache.cacheKey(toolName, args);
    const now = Date.now();

    // Evict if at capacity and this is a new entry
    if (!this.cache.has(key) && this.cache.size >= this.maxEntries) {
      this.evictOldest();
    }

    this.cache.set(key, {
      response,
      createdAt: now,
      ttlSeconds,
      toolName,
      hitCount: 0,
      lastAccessedAt: now,
    });
  }

  /**
   * Clear all cache entries or entries for a specific tool.
   */
  clear(toolName?: string): number {
    if (!toolName) {
      const count = this.cache.size;
      this.cache.clear();
      return count;
    }
    let count = 0;
    for (const [key, entry] of this.cache) {
      if (entry.toolName === toolName) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Get cache statistics.
   */
  stats(): CacheStats {
    const tools: Record<string, { entries: number; hits: number }> = {};
    const now = Date.now();

    // Purge expired entries while collecting stats
    for (const [key, entry] of this.cache) {
      if (now - entry.createdAt > entry.ttlSeconds * 1000) {
        this.cache.delete(key);
        continue;
      }
      if (!tools[entry.toolName]) {
        tools[entry.toolName] = { entries: 0, hits: 0 };
      }
      tools[entry.toolName].entries++;
      tools[entry.toolName].hits += entry.hitCount;
    }

    const total = this.totalHits + this.totalMisses;
    return {
      entries: this.cache.size,
      hits: this.totalHits,
      misses: this.totalMisses,
      hitRate: total > 0 ? Math.round((this.totalHits / total) * 10000) / 100 : 0,
      tools,
      maxEntries: this.maxEntries,
      evictions: this.totalEvictions,
    };
  }

  /**
   * Evict the oldest (by lastAccessedAt) entry — simple LRU.
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.cache) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.totalEvictions++;
    }
  }
}
