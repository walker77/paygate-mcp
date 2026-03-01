/**
 * UsageAnomalyDetector — Statistical anomaly detection on usage patterns.
 *
 * Track per-key usage patterns and detect anomalies using
 * z-score analysis with configurable sensitivity thresholds.
 *
 * @example
 * ```ts
 * const detector = new UsageAnomalyDetector({ windowSize: 10, zScoreThreshold: 2.0 });
 *
 * // Record normal usage
 * for (let i = 0; i < 10; i++) detector.recordUsage('key1', 100);
 *
 * // This spike should trigger an anomaly
 * const result = detector.recordUsage('key1', 500);
 * if (result.anomaly) console.log(`Anomaly: z-score ${result.zScore}`);
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface UsageDataPoint {
  value: number;
  timestamp: number;
}

export interface AnomalyResult {
  key: string;
  value: number;
  anomaly: boolean;
  zScore: number;
  mean: number;
  stdDev: number;
  threshold: number;
  timestamp: number;
}

export interface AnomalyEvent {
  id: string;
  key: string;
  value: number;
  zScore: number;
  mean: number;
  stdDev: number;
  detectedAt: number;
  acknowledged: boolean;
}

export interface UsageAnomalyConfig {
  /** Number of data points for baseline calculation. Default 20. */
  windowSize?: number;
  /** Z-score threshold for anomaly detection. Default 2.5. */
  zScoreThreshold?: number;
  /** Max tracked keys. Default 10000. */
  maxKeys?: number;
  /** Max anomaly events to keep. Default 1000. */
  maxEvents?: number;
}

export interface UsageAnomalyStats {
  trackedKeys: number;
  totalDataPoints: number;
  totalAnomalies: number;
  unacknowledgedAnomalies: number;
  topAnomalyKeys: { key: string; count: number }[];
}

// ── Implementation ───────────────────────────────────────────────────

interface KeyHistory {
  points: UsageDataPoint[];
  anomalyCount: number;
}

export class UsageAnomalyDetector {
  private keyHistories = new Map<string, KeyHistory>();
  private events: AnomalyEvent[] = [];
  private nextEventId = 1;

  private windowSize: number;
  private zScoreThreshold: number;
  private maxKeys: number;
  private maxEvents: number;

  // Stats
  private totalDataPoints = 0;
  private totalAnomalies = 0;

  constructor(config: UsageAnomalyConfig = {}) {
    this.windowSize = config.windowSize ?? 20;
    this.zScoreThreshold = config.zScoreThreshold ?? 2.5;
    this.maxKeys = config.maxKeys ?? 10_000;
    this.maxEvents = config.maxEvents ?? 1000;
  }

  // ── Recording ──────────────────────────────────────────────────

  /** Record a usage data point and check for anomalies. */
  recordUsage(key: string, value: number): AnomalyResult {
    const now = Date.now();
    this.totalDataPoints++;

    let history = this.keyHistories.get(key);
    if (!history) {
      if (this.keyHistories.size >= this.maxKeys) {
        // Evict key with oldest last data point
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        for (const [k, h] of this.keyHistories) {
          const last = h.points[h.points.length - 1]?.timestamp ?? 0;
          if (last < oldestTime) {
            oldestTime = last;
            oldestKey = k;
          }
        }
        if (oldestKey) this.keyHistories.delete(oldestKey);
      }
      history = { points: [], anomalyCount: 0 };
      this.keyHistories.set(key, history);
    }

    // Calculate stats from existing window
    const windowPoints = history.points.slice(-this.windowSize);
    const { mean, stdDev } = this.calculateStats(windowPoints);

    // Calculate z-score
    let zScore = 0;
    let isAnomaly = false;

    if (windowPoints.length >= 3 && stdDev > 0) {
      zScore = Math.abs(value - mean) / stdDev;
      zScore = Math.round(zScore * 100) / 100;
      isAnomaly = zScore > this.zScoreThreshold;
    }

    // Record the data point
    history.points.push({ value, timestamp: now });
    if (history.points.length > this.windowSize * 2) {
      history.points = history.points.slice(-this.windowSize * 2);
    }

    // Record anomaly event
    if (isAnomaly) {
      this.totalAnomalies++;
      history.anomalyCount++;

      const event: AnomalyEvent = {
        id: `anom_${this.nextEventId++}`,
        key,
        value,
        zScore,
        mean,
        stdDev,
        detectedAt: now,
        acknowledged: false,
      };
      this.events.push(event);
      if (this.events.length > this.maxEvents) {
        this.events.splice(0, this.events.length - this.maxEvents);
      }
    }

    return {
      key,
      value,
      anomaly: isAnomaly,
      zScore,
      mean: Math.round(mean * 100) / 100,
      stdDev: Math.round(stdDev * 100) / 100,
      threshold: this.zScoreThreshold,
      timestamp: now,
    };
  }

  // ── Query ──────────────────────────────────────────────────────

  /** Get anomaly events. */
  getEvents(options?: { key?: string; unacknowledgedOnly?: boolean; limit?: number }): AnomalyEvent[] {
    let events = [...this.events];
    if (options?.key) events = events.filter(e => e.key === options.key);
    if (options?.unacknowledgedOnly) events = events.filter(e => !e.acknowledged);
    return events.slice(-(options?.limit ?? 50));
  }

  /** Acknowledge an anomaly event. */
  acknowledgeEvent(id: string): boolean {
    const event = this.events.find(e => e.id === id);
    if (!event) return false;
    event.acknowledged = true;
    return true;
  }

  /** Acknowledge all anomaly events for a key. */
  acknowledgeAllForKey(key: string): number {
    let count = 0;
    for (const e of this.events) {
      if (e.key === key && !e.acknowledged) {
        e.acknowledged = true;
        count++;
      }
    }
    return count;
  }

  /** Get current baseline stats for a key. */
  getKeyBaseline(key: string): { mean: number; stdDev: number; dataPoints: number } | null {
    const history = this.keyHistories.get(key);
    if (!history) return null;

    const windowPoints = history.points.slice(-this.windowSize);
    const { mean, stdDev } = this.calculateStats(windowPoints);

    return {
      mean: Math.round(mean * 100) / 100,
      stdDev: Math.round(stdDev * 100) / 100,
      dataPoints: windowPoints.length,
    };
  }

  /** Reset a key's baseline history. */
  resetKey(key: string): boolean {
    return this.keyHistories.delete(key);
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): UsageAnomalyStats {
    const keyCounts: { key: string; count: number }[] = [];
    for (const [key, history] of this.keyHistories) {
      if (history.anomalyCount > 0) {
        keyCounts.push({ key, count: history.anomalyCount });
      }
    }
    keyCounts.sort((a, b) => b.count - a.count);

    return {
      trackedKeys: this.keyHistories.size,
      totalDataPoints: this.totalDataPoints,
      totalAnomalies: this.totalAnomalies,
      unacknowledgedAnomalies: this.events.filter(e => !e.acknowledged).length,
      topAnomalyKeys: keyCounts.slice(0, 5),
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.keyHistories.clear();
    this.events = [];
    this.totalDataPoints = 0;
    this.totalAnomalies = 0;
  }

  // ── Private ───────────────────────────────────────────────────

  private calculateStats(points: UsageDataPoint[]): { mean: number; stdDev: number } {
    if (points.length === 0) return { mean: 0, stdDev: 0 };

    const values = points.map(p => p.value);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;

    if (values.length < 2) return { mean, stdDev: 0 };

    const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (values.length - 1);
    return { mean, stdDev: Math.sqrt(variance) };
  }
}
