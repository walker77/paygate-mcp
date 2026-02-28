/**
 * Usage Forecast Engine — Predictive Analytics for Credit Consumption.
 *
 * Tracks historical usage patterns and projects future consumption.
 * Uses exponential moving average (EMA) for trend detection and
 * simple linear regression for forecasting.
 *
 * Use cases:
 *   - Predict when a key will run out of credits
 *   - Estimate monthly billing before period ends
 *   - Alert on unusual usage spikes
 *   - Capacity planning for server resources
 *
 * Zero external dependencies.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UsageDataPoint {
  /** Timestamp (epoch ms). */
  timestamp: number;
  /** Credits consumed in this period. */
  credits: number;
  /** Number of calls in this period. */
  calls: number;
}

export interface UsageForecast {
  /** Key being forecasted. */
  key: string;
  /** Projected credits per day (next 7 days avg). */
  dailyProjection: number;
  /** Projected credits per week. */
  weeklyProjection: number;
  /** Projected credits per month. */
  monthlyProjection: number;
  /** Estimated days until credits run out. Null if balance unknown or unlimited. */
  daysUntilExhaustion: number | null;
  /** Trend: rising, falling, or stable. */
  trend: 'rising' | 'falling' | 'stable';
  /** Trend strength (0-1). Higher = more pronounced trend. */
  trendStrength: number;
  /** Confidence level (0-1). More data = higher confidence. */
  confidence: number;
  /** Data points used for forecast. */
  dataPointCount: number;
  /** When this forecast was generated (ISO). */
  generatedAt: string;
}

export interface AnomalyAlert {
  /** Key that triggered the alert. */
  key: string;
  /** Type of anomaly. */
  type: 'spike' | 'drop' | 'new_pattern';
  /** Current value. */
  currentValue: number;
  /** Expected value. */
  expectedValue: number;
  /** Deviation factor (how many standard deviations away). */
  deviationFactor: number;
  /** When detected (ISO). */
  detectedAt: string;
}

export interface ForecastConfig {
  /** Bucket size for aggregation in seconds. Default: 3600 (1 hour). */
  bucketSeconds?: number;
  /** Maximum data points to retain per key. Default: 720 (30 days at hourly). */
  maxDataPoints?: number;
  /** EMA smoothing factor (0-1). Lower = smoother. Default: 0.3. */
  emaAlpha?: number;
  /** Anomaly detection threshold (standard deviations). Default: 2.0. */
  anomalyThreshold?: number;
  /** Maximum keys to track. Default: 10000. */
  maxKeys?: number;
}

export interface ForecastStats {
  /** Keys being tracked. */
  trackedKeys: number;
  /** Total data points stored. */
  totalDataPoints: number;
  /** Total forecasts generated. */
  totalForecasts: number;
  /** Total anomalies detected. */
  totalAnomalies: number;
}

// ─── Usage Forecast Engine ──────────────────────────────────────────────────

export class UsageForecastEngine {
  private data = new Map<string, UsageDataPoint[]>(); // key → time series
  private emas = new Map<string, number>(); // key → current EMA
  private bucketSeconds: number;
  private maxDataPoints: number;
  private emaAlpha: number;
  private anomalyThreshold: number;
  private maxKeys: number;

  // Stats
  private totalForecasts = 0;
  private totalAnomalies = 0;

  constructor(config: ForecastConfig = {}) {
    this.bucketSeconds = config.bucketSeconds ?? 3600;
    this.maxDataPoints = config.maxDataPoints ?? 720;
    this.emaAlpha = config.emaAlpha ?? 0.3;
    this.anomalyThreshold = config.anomalyThreshold ?? 2.0;
    this.maxKeys = config.maxKeys ?? 10_000;
  }

  /**
   * Record a usage event for a key.
   * Events are aggregated into time buckets.
   */
  record(key: string, credits: number, calls: number = 1): void {
    const now = Date.now();
    const bucketTime = Math.floor(now / (this.bucketSeconds * 1000)) * (this.bucketSeconds * 1000);

    if (!this.data.has(key)) {
      if (this.data.size >= this.maxKeys) return; // At capacity
      this.data.set(key, []);
    }

    const points = this.data.get(key)!;
    const lastPoint = points.length > 0 ? points[points.length - 1] : null;

    if (lastPoint && lastPoint.timestamp === bucketTime) {
      // Aggregate into existing bucket
      lastPoint.credits += credits;
      lastPoint.calls += calls;
    } else {
      // New bucket
      points.push({ timestamp: bucketTime, credits, calls });
      if (points.length > this.maxDataPoints) {
        points.splice(0, points.length - this.maxDataPoints);
      }
    }

    // Update EMA
    const currentEma = this.emas.get(key);
    if (currentEma !== undefined) {
      this.emas.set(key, this.emaAlpha * credits + (1 - this.emaAlpha) * currentEma);
    } else {
      this.emas.set(key, credits);
    }
  }

  /**
   * Generate a forecast for a key.
   *
   * @param key - API key to forecast
   * @param currentBalance - Current credit balance (for exhaustion prediction)
   */
  forecast(key: string, currentBalance?: number): UsageForecast | null {
    const points = this.data.get(key);
    if (!points || points.length < 2) return null;

    this.totalForecasts++;

    // Calculate daily average from recent data
    const bucketsPerDay = 86400 / this.bucketSeconds;
    const recentPoints = points.slice(-Math.ceil(bucketsPerDay * 7)); // Last 7 days

    const totalCredits = recentPoints.reduce((sum, p) => sum + p.credits, 0);
    const totalBuckets = recentPoints.length;
    const avgPerBucket = totalCredits / totalBuckets;
    const dailyProjection = Math.round(avgPerBucket * bucketsPerDay);

    // Linear regression for trend
    const { slope, r2 } = this.linearRegression(recentPoints.map((p, i) => ({ x: i, y: p.credits })));

    // Determine trend
    let trend: 'rising' | 'falling' | 'stable';
    const slopePerDay = slope * bucketsPerDay;
    const relativeSlopePerDay = dailyProjection > 0 ? Math.abs(slopePerDay) / dailyProjection : 0;

    if (relativeSlopePerDay < 0.05) {
      trend = 'stable';
    } else if (slope > 0) {
      trend = 'rising';
    } else {
      trend = 'falling';
    }

    // Days until exhaustion
    let daysUntilExhaustion: number | null = null;
    if (currentBalance !== undefined && dailyProjection > 0) {
      daysUntilExhaustion = Math.round(currentBalance / dailyProjection);
    }

    // Confidence based on data volume
    const confidence = Math.min(1, points.length / (bucketsPerDay * 7));

    return {
      key,
      dailyProjection,
      weeklyProjection: dailyProjection * 7,
      monthlyProjection: dailyProjection * 30,
      daysUntilExhaustion,
      trend,
      trendStrength: Math.min(1, Math.abs(r2)),
      confidence: Math.round(confidence * 100) / 100,
      dataPointCount: points.length,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Check for usage anomalies in a key.
   * Compares recent usage against the EMA baseline.
   */
  checkAnomaly(key: string, recentCredits: number): AnomalyAlert | null {
    const points = this.data.get(key);
    if (!points || points.length < 10) return null; // Need enough data

    const ema = this.emas.get(key);
    if (ema === undefined || ema === 0) return null;

    // Calculate standard deviation from recent data
    const recentValues = points.slice(-24).map(p => p.credits);
    const mean = recentValues.reduce((a, b) => a + b, 0) / recentValues.length;
    const variance = recentValues.reduce((sum, v) => sum + (v - mean) ** 2, 0) / recentValues.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return null;

    const deviation = Math.abs(recentCredits - ema) / stdDev;

    if (deviation >= this.anomalyThreshold) {
      this.totalAnomalies++;
      return {
        key,
        type: recentCredits > ema ? 'spike' : 'drop',
        currentValue: recentCredits,
        expectedValue: Math.round(ema),
        deviationFactor: Math.round(deviation * 100) / 100,
        detectedAt: new Date().toISOString(),
      };
    }

    return null;
  }

  /** Get the EMA (smoothed average) for a key. */
  getEma(key: string): number | null {
    return this.emas.get(key) ?? null;
  }

  /** Get raw data points for a key. */
  getDataPoints(key: string, limit?: number): UsageDataPoint[] {
    const points = this.data.get(key);
    if (!points) return [];
    return limit ? points.slice(-limit) : [...points];
  }

  /** Get all tracked keys. */
  getTrackedKeys(): string[] {
    return [...this.data.keys()];
  }

  /** Remove tracking for a key. */
  removeKey(key: string): boolean {
    this.emas.delete(key);
    return this.data.delete(key);
  }

  /** Get stats. */
  getStats(): ForecastStats {
    let totalDataPoints = 0;
    for (const points of this.data.values()) {
      totalDataPoints += points.length;
    }

    return {
      trackedKeys: this.data.size,
      totalDataPoints,
      totalForecasts: this.totalForecasts,
      totalAnomalies: this.totalAnomalies,
    };
  }

  /** Reset stats. */
  resetStats(): void {
    this.totalForecasts = 0;
    this.totalAnomalies = 0;
  }

  /** Destroy and release resources. */
  destroy(): void {
    this.data.clear();
    this.emas.clear();
    this.resetStats();
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private linearRegression(points: Array<{ x: number; y: number }>): { slope: number; intercept: number; r2: number } {
    const n = points.length;
    if (n < 2) return { slope: 0, intercept: 0, r2: 0 };

    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0, sumYY = 0;
    for (const p of points) {
      sumX += p.x;
      sumY += p.y;
      sumXY += p.x * p.y;
      sumXX += p.x * p.x;
      sumYY += p.y * p.y;
    }

    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) return { slope: 0, intercept: sumY / n, r2: 0 };

    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;

    // R-squared
    const yMean = sumY / n;
    let ssRes = 0, ssTot = 0;
    for (const p of points) {
      const predicted = slope * p.x + intercept;
      ssRes += (p.y - predicted) ** 2;
      ssTot += (p.y - yMean) ** 2;
    }

    const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

    return { slope, intercept, r2 };
  }
}
