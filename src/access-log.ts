/**
 * AccessLogEngine — Structured request/access logging with search.
 *
 * Records every API request with key, tool, status, response time,
 * IP, and user agent. Supports search, filter, and pagination.
 *
 * @example
 * ```ts
 * const log = new AccessLogEngine();
 *
 * log.record({
 *   key: 'key_abc',
 *   tool: 'search',
 *   method: 'tools/call',
 *   status: 'allowed',
 *   responseTimeMs: 45,
 *   ip: '10.0.0.1',
 *   credits: 5,
 * });
 *
 * const results = log.search({ key: 'key_abc', status: 'denied' });
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type AccessStatus = 'allowed' | 'denied' | 'error' | 'rate_limited';

export interface AccessEntry {
  id: string;
  timestamp: number;
  key: string;
  tool: string;
  method: string;
  status: AccessStatus;
  responseTimeMs: number;
  ip?: string;
  userAgent?: string;
  credits?: number;
  error?: string;
  requestId?: string;
  metadata?: Record<string, string>;
}

export interface AccessRecordParams {
  key: string;
  tool: string;
  method?: string;
  status: AccessStatus;
  responseTimeMs: number;
  ip?: string;
  userAgent?: string;
  credits?: number;
  error?: string;
  requestId?: string;
  metadata?: Record<string, string>;
}

export interface AccessQuery {
  key?: string;
  keys?: string[];
  tool?: string;
  tools?: string[];
  status?: AccessStatus;
  ip?: string;
  startTime?: number;
  endTime?: number;
  minResponseTimeMs?: number;
  maxResponseTimeMs?: number;
  search?: string; // free text search across tool, error, requestId
  limit?: number;
  offset?: number;
}

export interface AccessQueryResult {
  entries: AccessEntry[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface AccessSummary {
  totalRequests: number;
  totalAllowed: number;
  totalDenied: number;
  totalErrors: number;
  totalRateLimited: number;
  avgResponseTimeMs: number;
  p95ResponseTimeMs: number;
  p99ResponseTimeMs: number;
  uniqueKeys: number;
  uniqueTools: number;
  uniqueIps: number;
  topKeys: Array<{ key: string; count: number }>;
  topTools: Array<{ tool: string; count: number }>;
}

export interface AccessLogConfig {
  maxEntries?: number;
  retentionMs?: number;
}

export interface AccessLogStats {
  totalEntries: number;
  totalRecorded: number;
  totalEvicted: number;
  oldestEntry: number | null;
  newestEntry: number | null;
}

// ── Implementation ───────────────────────────────────────────────────

export class AccessLogEngine {
  private entries: AccessEntry[] = [];
  private maxEntries: number;
  private retentionMs: number;
  private idCounter = 0;

  // Stats
  private totalRecorded = 0;
  private totalEvicted = 0;

  constructor(config: AccessLogConfig = {}) {
    this.maxEntries = config.maxEntries ?? 50_000;
    this.retentionMs = config.retentionMs ?? 7 * 24 * 3600_000; // 7 days
  }

  // ── Recording ──────────────────────────────────────────────────────

  /** Record an access log entry. */
  record(params: AccessRecordParams): string {
    const id = `log_${++this.idCounter}`;
    const entry: AccessEntry = {
      id,
      timestamp: Date.now(),
      key: params.key,
      tool: params.tool,
      method: params.method ?? 'tools/call',
      status: params.status,
      responseTimeMs: params.responseTimeMs,
      ip: params.ip,
      userAgent: params.userAgent,
      credits: params.credits,
      error: params.error,
      requestId: params.requestId,
      metadata: params.metadata,
    };

    this.entries.push(entry);
    this.totalRecorded++;

    // Evict if over limit
    this.evict();

    return id;
  }

  /** Bulk import entries. */
  importEntries(entries: AccessRecordParams[]): number {
    let count = 0;
    for (const e of entries) {
      this.record(e);
      count++;
    }
    return count;
  }

  // ── Search & Query ─────────────────────────────────────────────────

  /** Search access logs with filters. */
  search(query: AccessQuery = {}): AccessQueryResult {
    let filtered = this.applyFilters(this.entries, query);
    const total = filtered.length;
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    // Sort newest first
    filtered.sort((a, b) => b.timestamp - a.timestamp);

    // Paginate
    const paginated = filtered.slice(offset, offset + limit);

    return {
      entries: paginated,
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    };
  }

  /** Get a single entry by ID. */
  getEntry(id: string): AccessEntry | null {
    return this.entries.find(e => e.id === id) ?? null;
  }

  /** Count entries matching a query. */
  count(query: AccessQuery = {}): number {
    return this.applyFilters(this.entries, query).length;
  }

  // ── Summary / Analytics ────────────────────────────────────────────

  /** Generate a summary of access logs within a time range. */
  summarize(startTime?: number, endTime?: number): AccessSummary {
    let entries = this.entries;
    if (startTime) entries = entries.filter(e => e.timestamp >= startTime);
    if (endTime) entries = entries.filter(e => e.timestamp <= endTime);

    if (entries.length === 0) {
      return {
        totalRequests: 0,
        totalAllowed: 0,
        totalDenied: 0,
        totalErrors: 0,
        totalRateLimited: 0,
        avgResponseTimeMs: 0,
        p95ResponseTimeMs: 0,
        p99ResponseTimeMs: 0,
        uniqueKeys: 0,
        uniqueTools: 0,
        uniqueIps: 0,
        topKeys: [],
        topTools: [],
      };
    }

    const keyCounts = new Map<string, number>();
    const toolCounts = new Map<string, number>();
    const ips = new Set<string>();
    let allowed = 0, denied = 0, errors = 0, rateLimited = 0;
    const responseTimes: number[] = [];

    for (const e of entries) {
      keyCounts.set(e.key, (keyCounts.get(e.key) ?? 0) + 1);
      toolCounts.set(e.tool, (toolCounts.get(e.tool) ?? 0) + 1);
      if (e.ip) ips.add(e.ip);
      responseTimes.push(e.responseTimeMs);

      switch (e.status) {
        case 'allowed': allowed++; break;
        case 'denied': denied++; break;
        case 'error': errors++; break;
        case 'rate_limited': rateLimited++; break;
      }
    }

    responseTimes.sort((a, b) => a - b);
    const avg = responseTimes.reduce((s, v) => s + v, 0) / responseTimes.length;
    const p95 = responseTimes[Math.floor(responseTimes.length * 0.95)] ?? 0;
    const p99 = responseTimes[Math.floor(responseTimes.length * 0.99)] ?? 0;

    const topKeys = [...keyCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([key, count]) => ({ key, count }));

    const topTools = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tool, count]) => ({ tool, count }));

    return {
      totalRequests: entries.length,
      totalAllowed: allowed,
      totalDenied: denied,
      totalErrors: errors,
      totalRateLimited: rateLimited,
      avgResponseTimeMs: Math.round(avg * 100) / 100,
      p95ResponseTimeMs: p95,
      p99ResponseTimeMs: p99,
      uniqueKeys: keyCounts.size,
      uniqueTools: toolCounts.size,
      uniqueIps: ips.size,
      topKeys,
      topTools,
    };
  }

  // ── Maintenance ────────────────────────────────────────────────────

  /** Purge entries older than retention period. Returns count purged. */
  purge(): number {
    const cutoff = Date.now() - this.retentionMs;
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.timestamp >= cutoff);
    const purged = before - this.entries.length;
    this.totalEvicted += purged;
    return purged;
  }

  /** Clear all entries. */
  clear(): void {
    this.entries = [];
  }

  // ── Stats ──────────────────────────────────────────────────────────

  getStats(): AccessLogStats {
    return {
      totalEntries: this.entries.length,
      totalRecorded: this.totalRecorded,
      totalEvicted: this.totalEvicted,
      oldestEntry: this.entries.length > 0 ? this.entries[0].timestamp : null,
      newestEntry: this.entries.length > 0 ? this.entries[this.entries.length - 1].timestamp : null,
    };
  }

  /** Clear all data and stats. */
  destroy(): void {
    this.entries = [];
    this.totalRecorded = 0;
    this.totalEvicted = 0;
    this.idCounter = 0;
  }

  // ── Private ─────────────────────────────────────────────────────────

  private applyFilters(entries: AccessEntry[], query: AccessQuery): AccessEntry[] {
    let result = entries;

    if (query.key) result = result.filter(e => e.key === query.key);
    if (query.keys && query.keys.length > 0) result = result.filter(e => query.keys!.includes(e.key));
    if (query.tool) result = result.filter(e => e.tool === query.tool);
    if (query.tools && query.tools.length > 0) result = result.filter(e => query.tools!.includes(e.tool));
    if (query.status) result = result.filter(e => e.status === query.status);
    if (query.ip) result = result.filter(e => e.ip === query.ip);
    if (query.startTime) result = result.filter(e => e.timestamp >= query.startTime!);
    if (query.endTime) result = result.filter(e => e.timestamp <= query.endTime!);
    if (query.minResponseTimeMs !== undefined) result = result.filter(e => e.responseTimeMs >= query.minResponseTimeMs!);
    if (query.maxResponseTimeMs !== undefined) result = result.filter(e => e.responseTimeMs <= query.maxResponseTimeMs!);

    if (query.search) {
      const s = query.search.toLowerCase();
      result = result.filter(e =>
        e.tool.toLowerCase().includes(s) ||
        (e.error && e.error.toLowerCase().includes(s)) ||
        (e.requestId && e.requestId.toLowerCase().includes(s)) ||
        e.key.toLowerCase().includes(s)
      );
    }

    return result;
  }

  private evict(): void {
    // Remove oldest entries if over limit
    if (this.entries.length > this.maxEntries) {
      const excess = this.entries.length - this.maxEntries;
      this.entries.splice(0, excess);
      this.totalEvicted += excess;
    }

    // Retention-based eviction
    const cutoff = Date.now() - this.retentionMs;
    const beforeLen = this.entries.length;
    this.entries = this.entries.filter(e => e.timestamp >= cutoff);
    const evicted = beforeLen - this.entries.length;
    if (evicted > 0) this.totalEvicted += evicted;
  }
}
