/**
 * Usage Export Engine — Data Export for Reporting & Compliance.
 *
 * Export usage data as CSV or JSON with filtering, date ranges,
 * and aggregation support. Designed for compliance reporting,
 * billing reconciliation, and analytics integration.
 *
 * Use cases:
 *   - Monthly billing statements for customers
 *   - Compliance audit exports
 *   - Analytics pipeline ingestion
 *   - Revenue reconciliation with Stripe
 *
 * Zero external dependencies.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UsageRecord {
  /** Timestamp (epoch ms). */
  timestamp: number;
  /** API key used. */
  key: string;
  /** Tool called. */
  tool: string;
  /** Credits consumed. */
  credits: number;
  /** Whether the call was allowed. */
  allowed: boolean;
  /** Response time in ms (optional). */
  responseTimeMs?: number;
  /** Additional metadata. */
  metadata?: Record<string, string>;
}

export interface ExportFilter {
  /** Start timestamp (epoch ms, inclusive). */
  startTime?: number;
  /** End timestamp (epoch ms, exclusive). */
  endTime?: number;
  /** Filter by key(s). */
  keys?: string[];
  /** Filter by tool(s). */
  tools?: string[];
  /** Filter by allowed status. */
  allowed?: boolean;
  /** Maximum records. Default: no limit. */
  limit?: number;
}

export interface ExportResult {
  /** Total records matching filter. */
  totalRecords: number;
  /** Records included (may be limited). */
  includedRecords: number;
  /** Date range of included records. */
  dateRange: { start: string; end: string } | null;
  /** Data in requested format. */
  data: string;
  /** Format used. */
  format: 'csv' | 'json';
  /** When this export was generated (ISO). */
  generatedAt: string;
}

export interface AggregatedExport {
  /** Granularity used. */
  granularity: 'hourly' | 'daily' | 'weekly' | 'monthly';
  /** Aggregated buckets. */
  buckets: AggregatedBucket[];
  /** Total records aggregated. */
  totalRecords: number;
  /** When generated (ISO). */
  generatedAt: string;
}

export interface AggregatedBucket {
  /** Bucket start (ISO). */
  periodStart: string;
  /** Bucket end (ISO). */
  periodEnd: string;
  /** Total calls. */
  totalCalls: number;
  /** Allowed calls. */
  allowedCalls: number;
  /** Denied calls. */
  deniedCalls: number;
  /** Total credits consumed. */
  totalCredits: number;
  /** Unique keys. */
  uniqueKeys: number;
  /** Unique tools. */
  uniqueTools: number;
  /** Average response time (ms). */
  avgResponseTimeMs: number | null;
}

export interface UsageExportConfig {
  /** Maximum records to store. Default: 1000000. */
  maxRecords?: number;
}

export interface UsageExportStats {
  /** Total records stored. */
  totalRecords: number;
  /** Total exports performed. */
  totalExports: number;
  /** Unique keys in data. */
  uniqueKeys: number;
  /** Unique tools in data. */
  uniqueTools: number;
}

// ─── Usage Export Engine ─────────────────────────────────────────────────────

export class UsageExportEngine {
  private records: UsageRecord[] = [];
  private maxRecords: number;

  // Stats
  private totalExports = 0;

  constructor(config: UsageExportConfig = {}) {
    this.maxRecords = config.maxRecords ?? 1_000_000;
  }

  /** Record a usage event. */
  record(event: UsageRecord): void {
    this.records.push(event);
    if (this.records.length > this.maxRecords) {
      // Trim oldest 10%
      this.records.splice(0, Math.floor(this.maxRecords * 0.1));
    }
  }

  /** Bulk import records. */
  importRecords(events: UsageRecord[]): number {
    let imported = 0;
    for (const event of events) {
      if (this.records.length < this.maxRecords) {
        this.records.push(event);
        imported++;
      }
    }
    return imported;
  }

  /**
   * Export records as CSV or JSON.
   */
  export(filter: ExportFilter = {}, format: 'csv' | 'json' = 'json'): ExportResult {
    this.totalExports++;
    const filtered = this.applyFilter(filter);
    const limited = filter.limit ? filtered.slice(0, filter.limit) : filtered;

    let dateRange: { start: string; end: string } | null = null;
    if (limited.length > 0) {
      dateRange = {
        start: new Date(limited[0].timestamp).toISOString(),
        end: new Date(limited[limited.length - 1].timestamp).toISOString(),
      };
    }

    let data: string;
    if (format === 'csv') {
      data = this.toCsv(limited);
    } else {
      data = JSON.stringify(limited, null, 2);
    }

    return {
      totalRecords: filtered.length,
      includedRecords: limited.length,
      dateRange,
      data,
      format,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Export aggregated data by time granularity.
   */
  exportAggregated(
    filter: ExportFilter = {},
    granularity: 'hourly' | 'daily' | 'weekly' | 'monthly' = 'daily',
  ): AggregatedExport {
    this.totalExports++;
    const filtered = this.applyFilter(filter);

    if (filtered.length === 0) {
      return {
        granularity,
        buckets: [],
        totalRecords: 0,
        generatedAt: new Date().toISOString(),
      };
    }

    // Group records into time buckets
    const bucketMap = new Map<string, UsageRecord[]>();

    for (const record of filtered) {
      const bucketKey = this.getBucketKey(record.timestamp, granularity);
      const existing = bucketMap.get(bucketKey) ?? [];
      existing.push(record);
      bucketMap.set(bucketKey, existing);
    }

    // Convert to aggregated buckets
    const buckets: AggregatedBucket[] = [];
    const sortedKeys = [...bucketMap.keys()].sort();

    for (const key of sortedKeys) {
      const records = bucketMap.get(key)!;
      const keys = new Set(records.map(r => r.key));
      const tools = new Set(records.map(r => r.tool));
      const responseTimes = records.filter(r => r.responseTimeMs !== undefined).map(r => r.responseTimeMs!);

      const { start, end } = this.getBucketRange(key, granularity);

      buckets.push({
        periodStart: start,
        periodEnd: end,
        totalCalls: records.length,
        allowedCalls: records.filter(r => r.allowed).length,
        deniedCalls: records.filter(r => !r.allowed).length,
        totalCredits: records.reduce((sum, r) => sum + r.credits, 0),
        uniqueKeys: keys.size,
        uniqueTools: tools.size,
        avgResponseTimeMs: responseTimes.length > 0
          ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
          : null,
      });
    }

    return {
      granularity,
      buckets,
      totalRecords: filtered.length,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Get record count matching a filter. */
  count(filter: ExportFilter = {}): number {
    return this.applyFilter(filter).length;
  }

  /** Clear all records. */
  clear(): void {
    this.records = [];
  }

  /** Get stats. */
  getStats(): UsageExportStats {
    const keys = new Set(this.records.map(r => r.key));
    const tools = new Set(this.records.map(r => r.tool));

    return {
      totalRecords: this.records.length,
      totalExports: this.totalExports,
      uniqueKeys: keys.size,
      uniqueTools: tools.size,
    };
  }

  /** Reset stats. */
  resetStats(): void {
    this.totalExports = 0;
  }

  /** Destroy and release resources. */
  destroy(): void {
    this.records = [];
    this.resetStats();
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private applyFilter(filter: ExportFilter): UsageRecord[] {
    let result = this.records;

    if (filter.startTime !== undefined) {
      result = result.filter(r => r.timestamp >= filter.startTime!);
    }
    if (filter.endTime !== undefined) {
      result = result.filter(r => r.timestamp < filter.endTime!);
    }
    if (filter.keys && filter.keys.length > 0) {
      const keySet = new Set(filter.keys);
      result = result.filter(r => keySet.has(r.key));
    }
    if (filter.tools && filter.tools.length > 0) {
      const toolSet = new Set(filter.tools);
      result = result.filter(r => toolSet.has(r.tool));
    }
    if (filter.allowed !== undefined) {
      result = result.filter(r => r.allowed === filter.allowed);
    }

    return result;
  }

  private toCsv(records: UsageRecord[]): string {
    if (records.length === 0) return 'timestamp,key,tool,credits,allowed,responseTimeMs\n';

    const lines: string[] = ['timestamp,key,tool,credits,allowed,responseTimeMs'];
    for (const r of records) {
      lines.push([
        new Date(r.timestamp).toISOString(),
        this.escapeCsv(r.key),
        this.escapeCsv(r.tool),
        r.credits.toString(),
        r.allowed.toString(),
        r.responseTimeMs?.toString() ?? '',
      ].join(','));
    }
    return lines.join('\n') + '\n';
  }

  private escapeCsv(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  private getBucketKey(timestamp: number, granularity: string): string {
    const d = new Date(timestamp);
    switch (granularity) {
      case 'hourly':
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(d.getUTCHours()).padStart(2, '0')}`;
      case 'daily':
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      case 'weekly': {
        const startOfWeek = new Date(d);
        startOfWeek.setUTCDate(d.getUTCDate() - d.getUTCDay());
        return `${startOfWeek.getUTCFullYear()}-W${String(Math.ceil((startOfWeek.getUTCDate()) / 7)).padStart(2, '0')}-${String(startOfWeek.getUTCMonth() + 1).padStart(2, '0')}-${String(startOfWeek.getUTCDate()).padStart(2, '0')}`;
      }
      case 'monthly':
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      default:
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    }
  }

  private getBucketRange(key: string, granularity: string): { start: string; end: string } {
    switch (granularity) {
      case 'hourly': {
        const d = new Date(key + ':00:00.000Z');
        const end = new Date(d.getTime() + 3600_000);
        return { start: d.toISOString(), end: end.toISOString() };
      }
      case 'daily': {
        const d = new Date(key + 'T00:00:00.000Z');
        const end = new Date(d.getTime() + 86400_000);
        return { start: d.toISOString(), end: end.toISOString() };
      }
      case 'monthly': {
        const [year, month] = key.split('-').map(Number);
        const start = new Date(Date.UTC(year, month - 1, 1));
        const end = new Date(Date.UTC(year, month, 1));
        return { start: start.toISOString(), end: end.toISOString() };
      }
      default: {
        // Best-effort
        return { start: key, end: key };
      }
    }
  }
}
