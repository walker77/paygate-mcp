/**
 * UsageTrendAnalyzer — Time-series usage analysis with anomaly detection.
 *
 * Track usage data points over time, compute moving averages,
 * detect anomalies (spikes/drops), identify trends (growth/decline),
 * and generate summary reports.
 *
 * @example
 * ```ts
 * const analyzer = new UsageTrendAnalyzer();
 *
 * analyzer.record('key_abc', 'search', 50);
 * analyzer.record('key_abc', 'search', 55);
 * analyzer.record('key_abc', 'search', 200); // anomaly!
 *
 * const trend = analyzer.getTrend('key_abc', 'search');
 * const anomalies = analyzer.getAnomalies('key_abc', 'search');
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface DataPoint {
  value: number;
  timestamp: number;
  key: string;
  tool: string;
}

export interface TrendResult {
  key: string;
  tool: string;
  dataPoints: number;
  currentValue: number;
  average: number;
  movingAverage: number;
  min: number;
  max: number;
  stddev: number;
  trend: 'growing' | 'declining' | 'stable';
  trendStrength: number; // 0 to 1
  changePercent: number; // vs first half
}

export interface Anomaly {
  key: string;
  tool: string;
  value: number;
  timestamp: number;
  expected: number;
  deviation: number;
  type: 'spike' | 'drop';
}

export interface UsageSummary {
  key: string;
  totalCalls: number;
  totalCredits: number;
  uniqueTools: number;
  topTools: { tool: string; calls: number; credits: number }[];
  period: { start: number; end: number };
}

export interface UsageTrendConfig {
  /** Window size for moving average. Default 10. */
  movingAverageWindow?: number;
  /** Standard deviations for anomaly detection. Default 2. */
  anomalyThreshold?: number;
  /** Max data points to retain per key+tool. Default 10000. */
  maxDataPoints?: number;
}

export interface UsageTrendStats {
  totalDataPoints: number;
  totalKeys: number;
  totalTools: number;
  totalAnomalies: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class UsageTrendAnalyzer {
  // key:tool → data points
  private data = new Map<string, DataPoint[]>();
  // Cached anomalies
  private anomalyCache = new Map<string, Anomaly[]>();
  private movingAverageWindow: number;
  private anomalyThreshold: number;
  private maxDataPoints: number;

  // Stats
  private totalAnomaliesDetected = 0;

  constructor(config: UsageTrendConfig = {}) {
    this.movingAverageWindow = config.movingAverageWindow ?? 10;
    this.anomalyThreshold = config.anomalyThreshold ?? 2;
    this.maxDataPoints = config.maxDataPoints ?? 10_000;
  }

  // ── Recording ─────────────────────────────────────────────────────

  /** Record a usage data point. */
  record(key: string, tool: string, value: number): DataPoint {
    const compositeKey = `${key}:${tool}`;
    if (!this.data.has(compositeKey)) {
      this.data.set(compositeKey, []);
    }
    const points = this.data.get(compositeKey)!;

    const point: DataPoint = {
      value,
      timestamp: Date.now(),
      key,
      tool,
    };

    // Check for anomaly before adding
    if (points.length >= this.movingAverageWindow) {
      const avg = this.computeMovingAverage(points);
      const stddev = this.computeStddev(points);
      let isAnomaly = false;
      let deviation = 0;

      if (stddev > 0) {
        deviation = Math.abs(value - avg) / stddev;
        isAnomaly = deviation > this.anomalyThreshold;
      } else if (avg > 0) {
        // Zero stddev but non-zero average: flag if value deviates by >50% from avg
        deviation = Math.abs(value - avg) / avg;
        isAnomaly = deviation > 0.5;
      } else {
        // All zeros — flag any non-zero value
        isAnomaly = value !== 0;
        deviation = value;
      }

      if (isAnomaly) {
          const anomaly: Anomaly = {
            key,
            tool,
            value,
            timestamp: point.timestamp,
            expected: avg,
            deviation,
            type: value > avg ? 'spike' : 'drop',
          };
          if (!this.anomalyCache.has(compositeKey)) {
            this.anomalyCache.set(compositeKey, []);
          }
          this.anomalyCache.get(compositeKey)!.push(anomaly);
          this.totalAnomaliesDetected++;
      }
    }

    points.push(point);

    // Evict oldest if over limit
    if (points.length > this.maxDataPoints) {
      points.splice(0, points.length - this.maxDataPoints);
    }

    return point;
  }

  /** Record multiple data points. */
  recordBatch(entries: { key: string; tool: string; value: number }[]): DataPoint[] {
    return entries.map(e => this.record(e.key, e.tool, e.value));
  }

  // ── Trend Analysis ────────────────────────────────────────────────

  /** Get trend analysis for a key+tool combination. */
  getTrend(key: string, tool: string): TrendResult | null {
    const compositeKey = `${key}:${tool}`;
    const points = this.data.get(compositeKey);
    if (!points || points.length === 0) return null;

    const values = points.map(p => p.value);
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    const movingAvg = this.computeMovingAverage(points);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const stddev = this.computeStddev(points);

    // Trend: compare first half average to second half average
    const mid = Math.floor(values.length / 2);
    const firstHalf = values.slice(0, mid);
    const secondHalf = values.slice(mid);

    let trend: 'growing' | 'declining' | 'stable' = 'stable';
    let trendStrength = 0;
    let changePercent = 0;

    if (firstHalf.length > 0 && secondHalf.length > 0) {
      const firstAvg = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;

      if (firstAvg > 0) {
        changePercent = ((secondAvg - firstAvg) / firstAvg) * 100;
      }

      // Threshold: 10% change = noticeable trend
      if (changePercent > 10) {
        trend = 'growing';
        trendStrength = Math.min(1, changePercent / 100);
      } else if (changePercent < -10) {
        trend = 'declining';
        trendStrength = Math.min(1, Math.abs(changePercent) / 100);
      }
    }

    return {
      key,
      tool,
      dataPoints: values.length,
      currentValue: values[values.length - 1],
      average: Math.round(avg * 100) / 100,
      movingAverage: Math.round(movingAvg * 100) / 100,
      min,
      max,
      stddev: Math.round(stddev * 100) / 100,
      trend,
      trendStrength: Math.round(trendStrength * 100) / 100,
      changePercent: Math.round(changePercent * 100) / 100,
    };
  }

  // ── Anomaly Detection ─────────────────────────────────────────────

  /** Get all anomalies for a key+tool. */
  getAnomalies(key: string, tool: string): Anomaly[] {
    return this.anomalyCache.get(`${key}:${tool}`) ?? [];
  }

  /** Get all anomalies across all keys/tools. */
  getAllAnomalies(): Anomaly[] {
    const all: Anomaly[] = [];
    for (const anomalies of this.anomalyCache.values()) {
      all.push(...anomalies);
    }
    return all.sort((a, b) => b.timestamp - a.timestamp);
  }

  // ── Summaries ─────────────────────────────────────────────────────

  /** Get usage summary for a key across all tools. */
  getKeySummary(key: string): UsageSummary | null {
    const toolMap = new Map<string, { calls: number; credits: number }>();
    let totalCalls = 0;
    let totalCredits = 0;
    let start = Infinity;
    let end = 0;

    for (const [compositeKey, points] of this.data.entries()) {
      if (!compositeKey.startsWith(`${key}:`)) continue;
      const tool = compositeKey.slice(key.length + 1);

      const calls = points.length;
      const credits = points.reduce((s, p) => s + p.value, 0);
      totalCalls += calls;
      totalCredits += credits;
      toolMap.set(tool, { calls, credits });

      if (points.length > 0) {
        start = Math.min(start, points[0].timestamp);
        end = Math.max(end, points[points.length - 1].timestamp);
      }
    }

    if (toolMap.size === 0) return null;

    const topTools = [...toolMap.entries()]
      .map(([tool, data]) => ({ tool, ...data }))
      .sort((a, b) => b.credits - a.credits);

    return {
      key,
      totalCalls,
      totalCredits,
      uniqueTools: toolMap.size,
      topTools,
      period: { start, end },
    };
  }

  /** List all tracked keys. */
  listKeys(): string[] {
    const keys = new Set<string>();
    for (const compositeKey of this.data.keys()) {
      keys.add(compositeKey.split(':')[0]);
    }
    return [...keys];
  }

  /** List all tracked tools. */
  listTools(): string[] {
    const tools = new Set<string>();
    for (const compositeKey of this.data.keys()) {
      tools.add(compositeKey.split(':').slice(1).join(':'));
    }
    return [...tools];
  }

  /** Get data points for a key+tool. */
  getDataPoints(key: string, tool: string): DataPoint[] {
    return this.data.get(`${key}:${tool}`) ?? [];
  }

  // ── Stats ─────────────────────────────────────────────────────────

  getStats(): UsageTrendStats {
    let totalPoints = 0;
    const keys = new Set<string>();
    const tools = new Set<string>();

    for (const [compositeKey, points] of this.data.entries()) {
      totalPoints += points.length;
      keys.add(compositeKey.split(':')[0]);
      tools.add(compositeKey.split(':').slice(1).join(':'));
    }

    return {
      totalDataPoints: totalPoints,
      totalKeys: keys.size,
      totalTools: tools.size,
      totalAnomalies: this.totalAnomaliesDetected,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.data.clear();
    this.anomalyCache.clear();
    this.totalAnomaliesDetected = 0;
  }

  // ── Private ───────────────────────────────────────────────────────

  private computeMovingAverage(points: DataPoint[]): number {
    const window = points.slice(-this.movingAverageWindow);
    if (window.length === 0) return 0;
    return window.reduce((s, p) => s + p.value, 0) / window.length;
  }

  private computeStddev(points: DataPoint[]): number {
    const values = points.slice(-this.movingAverageWindow).map(p => p.value);
    if (values.length < 2) return 0;
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  }
}
