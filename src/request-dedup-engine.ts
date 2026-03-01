/**
 * RequestDeduplicator — Deduplicate identical requests with configurable TTL.
 *
 * Prevent duplicate processing of requests by tracking seen request
 * fingerprints with automatic expiration.
 *
 * @example
 * ```ts
 * const dedup = new RequestDeduplicator({ ttlMs: 60000 });
 *
 * const fp = dedup.fingerprint({ method: 'tools/call', tool: 'search', query: 'hello' });
 * if (!dedup.isDuplicate(fp)) {
 *   dedup.record(fp, 'key_1');
 *   await processRequest();
 * }
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface DedupRecord {
  fingerprint: string;
  key: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  expiresAt: number;
}

export interface DedupCheckResult {
  isDuplicate: boolean;
  fingerprint: string;
  previousCount: number;
  firstSeenAt: number | null;
}

export interface RequestDeduplicatorConfig {
  /** TTL in ms for dedup records. Default 60000 (1 minute). */
  ttlMs?: number;
  /** Max tracked fingerprints. Default 50000. */
  maxEntries?: number;
  /** Hash algorithm for fingerprinting. Default 'simple'. */
  hashAlgorithm?: 'simple' | 'detailed';
}

export interface RequestDeduplicatorStats {
  trackedFingerprints: number;
  totalChecks: number;
  totalDuplicates: number;
  totalExpired: number;
  deduplicationRate: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class RequestDeduplicator {
  private records = new Map<string, DedupRecord>();
  private ttlMs: number;
  private maxEntries: number;
  private hashAlgorithm: 'simple' | 'detailed';

  // Stats
  private totalChecks = 0;
  private totalDuplicates = 0;
  private totalExpired = 0;

  constructor(config: RequestDeduplicatorConfig = {}) {
    this.ttlMs = config.ttlMs ?? 60_000;
    this.maxEntries = config.maxEntries ?? 50_000;
    this.hashAlgorithm = config.hashAlgorithm ?? 'simple';
  }

  // ── Fingerprinting ─────────────────────────────────────────────

  /** Generate a fingerprint for a request payload. */
  fingerprint(payload: Record<string, unknown>): string {
    if (this.hashAlgorithm === 'detailed') {
      return this.detailedHash(payload);
    }
    return this.simpleHash(payload);
  }

  // ── Deduplication ──────────────────────────────────────────────

  /** Check if a fingerprint is a duplicate. */
  isDuplicate(fingerprint: string): boolean {
    this.totalChecks++;
    this.pruneExpired();

    const record = this.records.get(fingerprint);
    if (record && record.expiresAt > Date.now()) {
      this.totalDuplicates++;
      return true;
    }
    return false;
  }

  /** Check and return detailed result. */
  check(fingerprint: string): DedupCheckResult {
    this.totalChecks++;
    this.pruneExpired();

    const record = this.records.get(fingerprint);
    if (record && record.expiresAt > Date.now()) {
      this.totalDuplicates++;
      return {
        isDuplicate: true,
        fingerprint,
        previousCount: record.count,
        firstSeenAt: record.firstSeenAt,
      };
    }

    return {
      isDuplicate: false,
      fingerprint,
      previousCount: 0,
      firstSeenAt: null,
    };
  }

  /** Record a fingerprint. */
  record(fingerprint: string, key: string): DedupRecord {
    const existing = this.records.get(fingerprint);
    if (existing && existing.expiresAt > Date.now()) {
      existing.lastSeenAt = Date.now();
      existing.count++;
      existing.expiresAt = Date.now() + this.ttlMs;
      return existing;
    }

    // Evict if at capacity
    if (this.records.size >= this.maxEntries) {
      this.pruneExpired();
      if (this.records.size >= this.maxEntries) {
        // Evict oldest
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        for (const [k, r] of this.records) {
          if (r.firstSeenAt < oldestTime) { oldestTime = r.firstSeenAt; oldestKey = k; }
        }
        if (oldestKey) this.records.delete(oldestKey);
      }
    }

    const now = Date.now();
    const rec: DedupRecord = {
      fingerprint,
      key,
      firstSeenAt: now,
      lastSeenAt: now,
      count: 1,
      expiresAt: now + this.ttlMs,
    };

    this.records.set(fingerprint, rec);
    return rec;
  }

  // ── Query ──────────────────────────────────────────────────────

  /** Get a dedup record. */
  getRecord(fingerprint: string): DedupRecord | null {
    const record = this.records.get(fingerprint);
    if (!record || record.expiresAt <= Date.now()) return null;
    return record;
  }

  /** Get all active records for a key. */
  getKeyRecords(key: string): DedupRecord[] {
    const now = Date.now();
    return [...this.records.values()].filter(r => r.key === key && r.expiresAt > now);
  }

  /** Clear all records for a key. */
  clearKey(key: string): number {
    let count = 0;
    for (const [fp, record] of this.records) {
      if (record.key === key) {
        this.records.delete(fp);
        count++;
      }
    }
    return count;
  }

  /** Force expire a specific fingerprint. */
  expire(fingerprint: string): boolean {
    return this.records.delete(fingerprint);
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): RequestDeduplicatorStats {
    this.pruneExpired();
    return {
      trackedFingerprints: this.records.size,
      totalChecks: this.totalChecks,
      totalDuplicates: this.totalDuplicates,
      totalExpired: this.totalExpired,
      deduplicationRate: this.totalChecks > 0
        ? Math.round((this.totalDuplicates / this.totalChecks) * 10000) / 100
        : 0,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.records.clear();
    this.totalChecks = 0;
    this.totalDuplicates = 0;
    this.totalExpired = 0;
  }

  // ── Private ────────────────────────────────────────────────────

  private simpleHash(obj: Record<string, unknown>): string {
    const sorted = Object.keys(obj).sort().map(k => `${k}:${JSON.stringify(obj[k])}`).join('|');
    let hash = 0;
    for (let i = 0; i < sorted.length; i++) {
      const char = sorted.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0; // Convert to 32-bit integer
    }
    return `fp_${Math.abs(hash).toString(36)}`;
  }

  private detailedHash(obj: Record<string, unknown>): string {
    const json = JSON.stringify(obj, Object.keys(obj).sort());
    let hash = 5381;
    for (let i = 0; i < json.length; i++) {
      hash = ((hash << 5) + hash) + json.charCodeAt(i);
      hash |= 0;
    }
    return `fpd_${Math.abs(hash).toString(36)}`;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [fp, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(fp);
        this.totalExpired++;
      }
    }
  }
}
