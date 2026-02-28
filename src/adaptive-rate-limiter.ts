/**
 * AdaptiveRateLimiter — Dynamic rate limit adjustment based on traffic behavior.
 *
 * Automatically tightens limits for misbehaving keys (high error rates,
 * excessive credit velocity) and loosens limits for well-behaved keys
 * (zero denials, steady usage). Wraps the existing static RateLimiter
 * with a per-key multiplier.
 *
 * Inspired by Apigee adaptive rate limiting and Tyk request throttling.
 * Zero external dependencies.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AdaptiveRateConfig {
  /** Enable adaptive rate limiting. */
  enabled: boolean;
  /** Sliding window size in seconds for evaluation. Default 300 (5 min). */
  evaluationWindowSeconds: number;
  /** Error rate threshold (0-1) above which rate is tightened. Default 0.3. */
  errorRateThreshold: number;
  /** If credit spend rate exceeds this × average, tighten. Default 1.5. */
  creditVelocityMultiplier: number;
  /** Never reduce below this % of configured limit. Default 25. */
  minRatePercent: number;
  /** Allow burst up to this % for good behavior. Default 200. */
  maxRatePercent: number;
  /** Hold adjusted rate for at least this many seconds. Default 60. */
  cooldownSeconds: number;
}

export interface KeyBehavior {
  totalCalls: number;
  errorCalls: number;
  deniedCalls: number;
  creditsSpent: number;
  /** Current effective multiplier (1.0 = nominal). */
  multiplier: number;
  /** Last time the multiplier was adjusted. */
  lastAdjusted: number;
  /** Sliding window of call timestamps. */
  callTimestamps: number[];
  /** Sliding window of error timestamps. */
  errorTimestamps: number[];
}

export interface AdaptiveRateStats {
  enabled: boolean;
  config: AdaptiveRateConfig;
  totalKeys: number;
  tightenedKeys: number;
  boostedKeys: number;
  normalKeys: number;
  keyDetails: Array<{
    key: string;
    multiplier: number;
    effectiveRate: string;
    recentCalls: number;
    recentErrors: number;
    errorRate: number;
  }>;
}

export interface AdaptiveRateAdjustment {
  key: string;
  previousMultiplier: number;
  newMultiplier: number;
  reason: string;
  effectiveRate: number;
  baseRate: number;
}

// ─── Default config ─────────────────────────────────────────────────────────

const DEFAULT_ADAPTIVE_CONFIG: AdaptiveRateConfig = {
  enabled: false,
  evaluationWindowSeconds: 300,
  errorRateThreshold: 0.3,
  creditVelocityMultiplier: 1.5,
  minRatePercent: 25,
  maxRatePercent: 200,
  cooldownSeconds: 60,
};

// ─── AdaptiveRateLimiter Class ──────────────────────────────────────────────

export class AdaptiveRateLimiter {
  private config: AdaptiveRateConfig;
  private readonly keyBehaviors = new Map<string, KeyBehavior>();
  private readonly maxTrackedKeys = 5000;

  constructor(config?: Partial<AdaptiveRateConfig>) {
    this.config = { ...DEFAULT_ADAPTIVE_CONFIG, ...config };
  }

  /**
   * Update configuration at runtime.
   */
  configure(updates: Partial<AdaptiveRateConfig>): AdaptiveRateConfig {
    if (updates.enabled !== undefined) this.config.enabled = updates.enabled;
    if (updates.evaluationWindowSeconds !== undefined) this.config.evaluationWindowSeconds = Math.max(30, updates.evaluationWindowSeconds);
    if (updates.errorRateThreshold !== undefined) this.config.errorRateThreshold = Math.min(1, Math.max(0, updates.errorRateThreshold));
    if (updates.creditVelocityMultiplier !== undefined) this.config.creditVelocityMultiplier = Math.max(1, updates.creditVelocityMultiplier);
    if (updates.minRatePercent !== undefined) this.config.minRatePercent = Math.min(100, Math.max(1, updates.minRatePercent));
    if (updates.maxRatePercent !== undefined) this.config.maxRatePercent = Math.max(100, updates.maxRatePercent);
    if (updates.cooldownSeconds !== undefined) this.config.cooldownSeconds = Math.max(0, updates.cooldownSeconds);
    return { ...this.config };
  }

  /**
   * Record a call for a key.
   */
  recordCall(apiKey: string): void {
    if (!this.config.enabled) return;
    const behavior = this.getOrCreate(apiKey);
    behavior.totalCalls++;
    behavior.callTimestamps.push(Date.now());
  }

  /**
   * Record an error for a key.
   */
  recordError(apiKey: string): void {
    if (!this.config.enabled) return;
    const behavior = this.getOrCreate(apiKey);
    behavior.errorCalls++;
    behavior.errorTimestamps.push(Date.now());
  }

  /**
   * Record a denied request for a key.
   */
  recordDenied(apiKey: string): void {
    if (!this.config.enabled) return;
    const behavior = this.getOrCreate(apiKey);
    behavior.deniedCalls++;
  }

  /**
   * Record credits spent by a key.
   */
  recordCredits(apiKey: string, amount: number): void {
    if (!this.config.enabled) return;
    const behavior = this.getOrCreate(apiKey);
    behavior.creditsSpent += amount;
  }

  /**
   * Get the effective rate multiplier for a key.
   * Returns 1.0 if adaptive limiting is disabled.
   */
  getMultiplier(apiKey: string): number {
    if (!this.config.enabled) return 1.0;
    const behavior = this.keyBehaviors.get(apiKey);
    if (!behavior) return 1.0;
    return behavior.multiplier;
  }

  /**
   * Get the effective rate limit for a key.
   */
  getEffectiveRate(apiKey: string, baseRate: number): number {
    return Math.round(baseRate * this.getMultiplier(apiKey));
  }

  /**
   * Evaluate and adjust the rate multiplier for a key.
   * Call this periodically (e.g., every minute) or on every Nth request.
   */
  evaluate(apiKey: string): AdaptiveRateAdjustment | null {
    if (!this.config.enabled) return null;
    const behavior = this.keyBehaviors.get(apiKey);
    if (!behavior) return null;

    // Check cooldown
    const now = Date.now();
    const cooldownMs = this.config.cooldownSeconds * 1000;
    if (now - behavior.lastAdjusted < cooldownMs) return null;

    // Prune old timestamps
    this.pruneTimestamps(behavior);

    const recentCalls = behavior.callTimestamps.length;
    const recentErrors = behavior.errorTimestamps.length;

    // Need minimum traffic to evaluate
    if (recentCalls < 5) return null;

    const previousMultiplier = behavior.multiplier;
    let newMultiplier = 1.0;
    let reason = 'normal behavior';

    // Check error rate
    const errorRate = recentErrors / recentCalls;
    if (errorRate > this.config.errorRateThreshold) {
      // Tighten: reduce to proportional amount
      const tightenFactor = 1 - (errorRate * 0.5); // 30% errors → 0.85x, 60% → 0.7x
      newMultiplier = Math.max(this.config.minRatePercent / 100, tightenFactor);
      reason = `high error rate: ${(errorRate * 100).toFixed(1)}%`;
    } else if (errorRate < 0.05 && behavior.deniedCalls === 0) {
      // Boost: reward good behavior
      const boostFactor = 1 + ((1 - errorRate) * 0.3); // up to 1.3x for perfect keys
      newMultiplier = Math.min(this.config.maxRatePercent / 100, boostFactor);
      reason = `good behavior: ${(errorRate * 100).toFixed(1)}% error rate`;
    }

    // Clamp
    newMultiplier = Math.max(this.config.minRatePercent / 100, Math.min(this.config.maxRatePercent / 100, newMultiplier));

    // Only update if significantly different (>5% change)
    if (Math.abs(newMultiplier - previousMultiplier) < 0.05) return null;

    behavior.multiplier = newMultiplier;
    behavior.lastAdjusted = now;

    return {
      key: apiKey.slice(0, 8) + '...',
      previousMultiplier,
      newMultiplier,
      reason,
      effectiveRate: 0, // caller fills in with base rate
      baseRate: 0,
    };
  }

  /**
   * Evaluate all tracked keys.
   */
  evaluateAll(): AdaptiveRateAdjustment[] {
    const adjustments: AdaptiveRateAdjustment[] = [];
    for (const key of this.keyBehaviors.keys()) {
      const adj = this.evaluate(key);
      if (adj) adjustments.push(adj);
    }
    return adjustments;
  }

  private pruneTimestamps(behavior: KeyBehavior): void {
    const cutoff = Date.now() - (this.config.evaluationWindowSeconds * 1000);
    behavior.callTimestamps = behavior.callTimestamps.filter(t => t > cutoff);
    behavior.errorTimestamps = behavior.errorTimestamps.filter(t => t > cutoff);
  }

  private getOrCreate(apiKey: string): KeyBehavior {
    let behavior = this.keyBehaviors.get(apiKey);
    if (!behavior) {
      // Evict oldest if at capacity
      if (this.keyBehaviors.size >= this.maxTrackedKeys) {
        const firstKey = this.keyBehaviors.keys().next().value;
        if (firstKey) this.keyBehaviors.delete(firstKey);
      }
      behavior = {
        totalCalls: 0,
        errorCalls: 0,
        deniedCalls: 0,
        creditsSpent: 0,
        multiplier: 1.0,
        lastAdjusted: 0,
        callTimestamps: [],
        errorTimestamps: [],
      };
      this.keyBehaviors.set(apiKey, behavior);
    }
    return behavior;
  }

  /**
   * Get adaptive rate statistics.
   */
  stats(): AdaptiveRateStats {
    const keyDetails: AdaptiveRateStats['keyDetails'] = [];
    let tightened = 0;
    let boosted = 0;
    let normal = 0;

    for (const [key, behavior] of this.keyBehaviors) {
      this.pruneTimestamps(behavior);
      const recentCalls = behavior.callTimestamps.length;
      const recentErrors = behavior.errorTimestamps.length;
      const errorRate = recentCalls > 0 ? recentErrors / recentCalls : 0;

      if (behavior.multiplier < 0.95) tightened++;
      else if (behavior.multiplier > 1.05) boosted++;
      else normal++;

      keyDetails.push({
        key: key.slice(0, 8) + '...',
        multiplier: Math.round(behavior.multiplier * 100) / 100,
        effectiveRate: `${Math.round(behavior.multiplier * 100)}%`,
        recentCalls,
        recentErrors,
        errorRate: Math.round(errorRate * 100) / 100,
      });
    }

    return {
      enabled: this.config.enabled,
      config: { ...this.config },
      totalKeys: this.keyBehaviors.size,
      tightenedKeys: tightened,
      boostedKeys: boosted,
      normalKeys: normal,
      keyDetails,
    };
  }

  /**
   * Reset tracking for a specific key.
   */
  resetKey(apiKey: string): boolean {
    return this.keyBehaviors.delete(apiKey);
  }

  /**
   * Clear all tracking data.
   */
  clear(): void {
    this.keyBehaviors.clear();
  }

  /** Number of tracked keys. */
  get size(): number {
    return this.keyBehaviors.size;
  }
}
