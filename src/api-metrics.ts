/**
 * APIMetricsAggregator — Time-bucketed API metrics with percentile calculations.
 *
 * Record API call metrics, aggregate into time buckets,
 * and compute percentile latencies for monitoring.
 *
 * @example
 * ```ts
 * const agg = new APIMetricsAggregator();
 *
 * agg.record({ method: 'tools/call', tool: 'search', latencyMs: 45, statusCode: 200 });
 * agg.record({ method: 'tools/call', tool: 'search', latencyMs: 120, statusCode: 200 });
 *
 * const summary = agg.getSummary('1m');
 * // { totalRequests, avgLatencyMs, p50, p95, p99, errorRate, ... }
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type MetricGranularity = '1m' | '5m' | '1h' | '1d';

export interface MetricRecord {
  method?: string;
  tool?: string;
  key?: string;
  latencyMs: number;
  statusCode: number;
  credits?: number;
  timestamp?: number;
}

export interface MetricBucket {
  start: number;
  end: number;
  count: number;
  errors: number;
  latencies: number[];
  totalCredits: number;
}

export interface MetricSummary {
  granularity: MetricGranularity;
  bucketCount: number;
  totalRequests: number;
  totalErrors: number;
  errorRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  totalCredits: number;
  requestsPerSecond: number;
}

export interface ToolMetricSummary {
  tool: string;
  count: number;
  errors: number;
  avgLatencyMs: number;
  totalCredits: number;
}

export interface APIMetricsConfig {
  /** Max raw records to keep. Default 100000. */
  maxRecords?: number;
  /** Max age for records in ms. Default 86400000 (24h). */
  maxAgeMs?: number;
}

export interface APIMetricsStats {
  totalRecords: number;
  totalRequests: number;
  totalErrors: number;
  oldestRecord: number | null;
  newestRecord: number | null;
}

// ── Implementation ───────────────────────────────────────────────────

interface StoredRecord {
  method: string;
  tool: string;
  key: string;
  latencyMs: number;
  statusCode: number;
  credits: number;
  timestamp: number;
}

const GRANULARITY_MS: Record<MetricGranularity, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
};

export class APIMetricsAggregator {
  private records: StoredRecord[] = [];
  private maxRecords: number;
  private maxAgeMs: number;

  constructor(config: APIMetricsConfig = {}) {
    this.maxRecords = config.maxRecords ?? 100_000;
    this.maxAgeMs = config.maxAgeMs ?? 86_400_000;
  }

  // ── Recording ─────────────────────────────────────────────────

  /** Record a metric data point. */
  record(metric: MetricRecord): void {
    const stored: StoredRecord = {
      method: metric.method ?? '',
      tool: metric.tool ?? '',
      key: metric.key ?? '',
      latencyMs: metric.latencyMs,
      statusCode: metric.statusCode,
      credits: metric.credits ?? 0,
      timestamp: metric.timestamp ?? Date.now(),
    };

    this.records.push(stored);

    // Evict oldest if over limit
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
  }

  // ── Aggregation ───────────────────────────────────────────────

  /** Get aggregated summary for a granularity. */
  getSummary(granularity: MetricGranularity = '1m', options?: { tool?: string; key?: string }): MetricSummary {
    let filtered = this.getRelevantRecords();
    if (options?.tool) filtered = filtered.filter(r => r.tool === options.tool);
    if (options?.key) filtered = filtered.filter(r => r.key === options.key);

    if (filtered.length === 0) {
      return {
        granularity,
        bucketCount: 0,
        totalRequests: 0,
        totalErrors: 0,
        errorRate: 0,
        avgLatencyMs: 0,
        p50LatencyMs: 0,
        p95LatencyMs: 0,
        p99LatencyMs: 0,
        minLatencyMs: 0,
        maxLatencyMs: 0,
        totalCredits: 0,
        requestsPerSecond: 0,
      };
    }

    const latencies = filtered.map(r => r.latencyMs).sort((a, b) => a - b);
    const errors = filtered.filter(r => r.statusCode >= 400).length;
    const totalCredits = filtered.reduce((s, r) => s + r.credits, 0);

    const oldest = filtered[0].timestamp;
    const newest = filtered[filtered.length - 1].timestamp;
    const durationSec = Math.max(1, (newest - oldest) / 1000);

    const bucketMs = GRANULARITY_MS[granularity];
    const bucketCount = Math.ceil((newest - oldest + 1) / bucketMs);

    return {
      granularity,
      bucketCount,
      totalRequests: filtered.length,
      totalErrors: errors,
      errorRate: Math.round((errors / filtered.length) * 10000) / 100,
      avgLatencyMs: Math.round(latencies.reduce((s, l) => s + l, 0) / latencies.length * 100) / 100,
      p50LatencyMs: this.percentile(latencies, 50),
      p95LatencyMs: this.percentile(latencies, 95),
      p99LatencyMs: this.percentile(latencies, 99),
      minLatencyMs: latencies[0],
      maxLatencyMs: latencies[latencies.length - 1],
      totalCredits,
      requestsPerSecond: Math.round((filtered.length / durationSec) * 100) / 100,
    };
  }

  /** Get per-tool breakdown. */
  getToolBreakdown(): ToolMetricSummary[] {
    const records = this.getRelevantRecords();
    const toolMap = new Map<string, { count: number; errors: number; latencySum: number; credits: number }>();

    for (const r of records) {
      if (!r.tool) continue;
      const existing = toolMap.get(r.tool) ?? { count: 0, errors: 0, latencySum: 0, credits: 0 };
      existing.count++;
      if (r.statusCode >= 400) existing.errors++;
      existing.latencySum += r.latencyMs;
      existing.credits += r.credits;
      toolMap.set(r.tool, existing);
    }

    return [...toolMap.entries()]
      .map(([tool, data]) => ({
        tool,
        count: data.count,
        errors: data.errors,
        avgLatencyMs: Math.round((data.latencySum / data.count) * 100) / 100,
        totalCredits: data.credits,
      }))
      .sort((a, b) => b.count - a.count);
  }

  /** Get time-series buckets. */
  getBuckets(granularity: MetricGranularity): MetricBucket[] {
    const records = this.getRelevantRecords();
    if (records.length === 0) return [];

    const bucketMs = GRANULARITY_MS[granularity];
    const oldest = records[0].timestamp;
    const newest = records[records.length - 1].timestamp;
    const buckets: MetricBucket[] = [];

    let start = Math.floor(oldest / bucketMs) * bucketMs;
    while (start <= newest) {
      const end = start + bucketMs;
      const inBucket = records.filter(r => r.timestamp >= start && r.timestamp < end);

      buckets.push({
        start,
        end,
        count: inBucket.length,
        errors: inBucket.filter(r => r.statusCode >= 400).length,
        latencies: inBucket.map(r => r.latencyMs),
        totalCredits: inBucket.reduce((s, r) => s + r.credits, 0),
      });

      start = end;
    }

    return buckets;
  }

  // ── Cleanup ───────────────────────────────────────────────────

  /** Remove records older than maxAge. */
  cleanup(): number {
    const cutoff = Date.now() - this.maxAgeMs;
    const before = this.records.length;
    this.records = this.records.filter(r => r.timestamp >= cutoff);
    return before - this.records.length;
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): APIMetricsStats {
    return {
      totalRecords: this.records.length,
      totalRequests: this.records.length,
      totalErrors: this.records.filter(r => r.statusCode >= 400).length,
      oldestRecord: this.records.length > 0 ? this.records[0].timestamp : null,
      newestRecord: this.records.length > 0 ? this.records[this.records.length - 1].timestamp : null,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.records = [];
  }

  // ── Private ───────────────────────────────────────────────────

  private getRelevantRecords(): StoredRecord[] {
    const cutoff = Date.now() - this.maxAgeMs;
    return this.records.filter(r => r.timestamp >= cutoff).sort((a, b) => a.timestamp - b.timestamp);
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }
}
