/**
 * AnalyticsEngine — Time-series analytics over UsageEvents.
 *
 * Provides:
 *   - Time-bucketed aggregation (hourly, daily)
 *   - Per-tool breakdown with success/failure rates
 *   - Top consumers by credits or call count
 *   - Trend comparison (current vs previous period)
 *   - Revenue (credits) over time
 */

import { UsageEvent } from './types';

// ─── Types ────────────────────────────────────────────────────────────────────

export type BucketGranularity = 'hourly' | 'daily';

export interface TimeBucket {
  /** Bucket start time (ISO 8601) */
  start: string;
  /** Bucket end time (ISO 8601) */
  end: string;
  /** Total calls in this bucket */
  calls: number;
  /** Allowed calls */
  allowed: number;
  /** Denied calls */
  denied: number;
  /** Credits charged */
  credits: number;
}

export interface ToolBreakdown {
  tool: string;
  calls: number;
  allowed: number;
  denied: number;
  credits: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Average credits per allowed call */
  avgCreditsPerCall: number;
}

export interface TopConsumer {
  /** Key name (or masked prefix) */
  keyName: string;
  calls: number;
  credits: number;
  denied: number;
  /** Most-used tool */
  topTool: string;
}

export interface TrendComparison {
  /** Current period stats */
  current: { calls: number; credits: number; denied: number };
  /** Previous period stats (same duration) */
  previous: { calls: number; credits: number; denied: number };
  /** Percentage change (-100 to +Infinity) */
  change: {
    calls: number | null;
    credits: number | null;
    denied: number | null;
  };
}

export interface AnalyticsReport {
  /** Query time range */
  from: string;
  to: string;
  granularity: BucketGranularity;
  /** Time-series data */
  timeSeries: TimeBucket[];
  /** Per-tool breakdown (sorted by calls desc) */
  tools: ToolBreakdown[];
  /** Top consumers (sorted by credits desc) */
  topConsumers: TopConsumer[];
  /** Trend vs previous equivalent period */
  trend: TrendComparison;
  /** Summary stats */
  summary: {
    totalCalls: number;
    totalCredits: number;
    totalDenied: number;
    uniqueKeys: number;
    uniqueTools: number;
    successRate: number;
  };
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export class AnalyticsEngine {
  /**
   * Generate a full analytics report from usage events.
   */
  report(
    events: UsageEvent[],
    options: {
      from?: string;
      to?: string;
      granularity?: BucketGranularity;
      topN?: number;
    } = {},
  ): AnalyticsReport {
    const now = new Date();
    const to = options.to || now.toISOString();
    const from = options.from || new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const granularity = options.granularity || 'hourly';
    const topN = options.topN || 10;

    // Filter events to range
    const filtered = events.filter(e => e.timestamp >= from && e.timestamp <= to);

    // Build time series
    const timeSeries = this.buildTimeSeries(filtered, from, to, granularity);

    // Build tool breakdown
    const tools = this.buildToolBreakdown(filtered);

    // Build top consumers
    const topConsumers = this.buildTopConsumers(filtered, topN);

    // Build trend comparison
    const periodMs = new Date(to).getTime() - new Date(from).getTime();
    const prevFrom = new Date(new Date(from).getTime() - periodMs).toISOString();
    const prevTo = from;
    const prevFiltered = events.filter(e => e.timestamp >= prevFrom && e.timestamp < prevTo);
    const trend = this.buildTrend(filtered, prevFiltered);

    // Summary
    const uniqueKeys = new Set(filtered.map(e => e.apiKey)).size;
    const uniqueTools = new Set(filtered.map(e => e.tool)).size;
    const totalCalls = filtered.length;
    const totalCredits = filtered.filter(e => e.allowed).reduce((s, e) => s + e.creditsCharged, 0);
    const totalDenied = filtered.filter(e => !e.allowed).length;

    return {
      from,
      to,
      granularity,
      timeSeries,
      tools,
      topConsumers,
      trend,
      summary: {
        totalCalls,
        totalCredits,
        totalDenied,
        uniqueKeys,
        uniqueTools,
        successRate: totalCalls > 0 ? (totalCalls - totalDenied) / totalCalls : 1,
      },
    };
  }

  /**
   * Bucket events into time intervals.
   */
  private buildTimeSeries(
    events: UsageEvent[],
    from: string,
    to: string,
    granularity: BucketGranularity,
  ): TimeBucket[] {
    const buckets: TimeBucket[] = [];
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    const intervalMs = granularity === 'hourly' ? 3600_000 : 86400_000;

    // Create empty buckets
    let bucketStart = fromMs;
    while (bucketStart < toMs) {
      const bucketEnd = Math.min(bucketStart + intervalMs, toMs);
      buckets.push({
        start: new Date(bucketStart).toISOString(),
        end: new Date(bucketEnd).toISOString(),
        calls: 0,
        allowed: 0,
        denied: 0,
        credits: 0,
      });
      bucketStart += intervalMs;
    }

    // Fill buckets
    for (const event of events) {
      const eventMs = new Date(event.timestamp).getTime();
      const bucketIdx = Math.floor((eventMs - fromMs) / intervalMs);
      if (bucketIdx >= 0 && bucketIdx < buckets.length) {
        buckets[bucketIdx].calls++;
        if (event.allowed) {
          buckets[bucketIdx].allowed++;
          buckets[bucketIdx].credits += event.creditsCharged;
        } else {
          buckets[bucketIdx].denied++;
        }
      }
    }

    return buckets;
  }

  /**
   * Breakdown per tool, sorted by calls descending.
   */
  private buildToolBreakdown(events: UsageEvent[]): ToolBreakdown[] {
    const map = new Map<string, { calls: number; allowed: number; denied: number; credits: number }>();

    for (const event of events) {
      let entry = map.get(event.tool);
      if (!entry) {
        entry = { calls: 0, allowed: 0, denied: 0, credits: 0 };
        map.set(event.tool, entry);
      }
      entry.calls++;
      if (event.allowed) {
        entry.allowed++;
        entry.credits += event.creditsCharged;
      } else {
        entry.denied++;
      }
    }

    return Array.from(map.entries())
      .map(([tool, stats]) => ({
        tool,
        ...stats,
        successRate: stats.calls > 0 ? stats.allowed / stats.calls : 1,
        avgCreditsPerCall: stats.allowed > 0 ? stats.credits / stats.allowed : 0,
      }))
      .sort((a, b) => b.calls - a.calls);
  }

  /**
   * Top consumers by credits spent, with their most-used tool.
   */
  private buildTopConsumers(events: UsageEvent[], topN: number): TopConsumer[] {
    const keyMap = new Map<string, {
      keyName: string;
      calls: number;
      credits: number;
      denied: number;
      toolCounts: Map<string, number>;
    }>();

    for (const event of events) {
      const keyId = event.apiKey;
      let entry = keyMap.get(keyId);
      if (!entry) {
        entry = {
          keyName: event.keyName || keyId.slice(0, 10) + '...',
          calls: 0,
          credits: 0,
          denied: 0,
          toolCounts: new Map(),
        };
        keyMap.set(keyId, entry);
      }
      entry.calls++;
      if (event.allowed) {
        entry.credits += event.creditsCharged;
      } else {
        entry.denied++;
      }
      entry.toolCounts.set(event.tool, (entry.toolCounts.get(event.tool) || 0) + 1);
    }

    return Array.from(keyMap.values())
      .map(entry => {
        // Find top tool
        let topTool = 'none';
        let topCount = 0;
        for (const [tool, count] of entry.toolCounts) {
          if (count > topCount) {
            topTool = tool;
            topCount = count;
          }
        }
        return {
          keyName: entry.keyName,
          calls: entry.calls,
          credits: entry.credits,
          denied: entry.denied,
          topTool,
        };
      })
      .sort((a, b) => b.credits - a.credits)
      .slice(0, topN);
  }

  /**
   * Compare current period vs previous period of same length.
   */
  private buildTrend(current: UsageEvent[], previous: UsageEvent[]): TrendComparison {
    const cur = {
      calls: current.length,
      credits: current.filter(e => e.allowed).reduce((s, e) => s + e.creditsCharged, 0),
      denied: current.filter(e => !e.allowed).length,
    };
    const prev = {
      calls: previous.length,
      credits: previous.filter(e => e.allowed).reduce((s, e) => s + e.creditsCharged, 0),
      denied: previous.filter(e => !e.allowed).length,
    };

    const pctChange = (cur: number, prev: number): number | null => {
      if (prev === 0) return cur === 0 ? null : null;
      return Math.round(((cur - prev) / prev) * 100 * 10) / 10; // 1 decimal
    };

    return {
      current: cur,
      previous: prev,
      change: {
        calls: pctChange(cur.calls, prev.calls),
        credits: pctChange(cur.credits, prev.credits),
        denied: pctChange(cur.denied, prev.denied),
      },
    };
  }
}
