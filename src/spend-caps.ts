/**
 * SpendCapManager — Server-wide and per-key spend caps with auto-suspend.
 *
 * Prevents runaway agent spending by enforcing hard limits:
 *   - Server-wide daily credit/call caps across ALL keys
 *   - Per-key hourly credit/call caps (finer-grained than daily)
 *   - Auto-suspend: keys that breach caps are automatically suspended
 *   - Auto-resume: suspended keys can be auto-resumed after a cooldown period
 *
 * Unlike quotas (which just deny), spend caps can suspend keys to prevent
 * further abuse until an admin reviews.
 */

import { ApiKeyRecord, QuotaConfig, SpendCapConfig } from './types';

// Re-export for convenience
export type { SpendCapConfig } from './types';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SpendCapCheckResult {
  allowed: boolean;
  reason?: string;
  /** Whether the key should be auto-suspended (only when breachAction = 'suspend'). */
  shouldSuspend?: boolean;
}

// ─── Hourly Tracking ─────────────────────────────────────────────────────────

interface HourlyBucket {
  hour: string; // YYYY-MM-DDTHH format
  calls: number;
  credits: number;
}

// ─── SpendCapManager ─────────────────────────────────────────────────────────

export class SpendCapManager {
  private config: SpendCapConfig;
  /** Server-wide daily counters (reset at UTC midnight). */
  private serverDailyCalls = 0;
  private serverDailyCredits = 0;
  private serverDailyResetDay = '';
  /** Per-key hourly buckets (keyed by API key prefix). */
  private hourlyBuckets = new Map<string, HourlyBucket>();
  /** Auto-suspend timestamps (keyed by API key prefix → Unix ms when suspended). */
  private suspendedAt = new Map<string, number>();
  /** Callback: notified when a key is auto-suspended. */
  onAutoSuspend?: (apiKeyPrefix: string, reason: string) => void;
  /** Callback: notified when a key is auto-resumed. */
  onAutoResume?: (apiKeyPrefix: string) => void;

  constructor(config: SpendCapConfig) {
    this.config = config;
    this.serverDailyResetDay = this.todayUTC();
  }

  /**
   * Update spend cap config at runtime (hot-reload).
   */
  updateConfig(config: SpendCapConfig): void {
    this.config = config;
  }

  /**
   * Check server-wide spend caps.
   * Call BEFORE per-key checks to fail fast on global limits.
   */
  checkServerCap(creditsRequired: number): SpendCapCheckResult {
    this.resetServerIfNeeded();

    // Server-wide daily credit cap
    if (this.config.serverDailyCreditCap > 0) {
      if (this.serverDailyCredits + creditsRequired > this.config.serverDailyCreditCap) {
        return {
          allowed: false,
          reason: `server_daily_credit_cap: ${this.serverDailyCredits}+${creditsRequired} would exceed ${this.config.serverDailyCreditCap} credits/day (server-wide)`,
        };
      }
    }

    // Server-wide daily call cap
    if (this.config.serverDailyCallCap > 0) {
      if (this.serverDailyCalls + 1 > this.config.serverDailyCallCap) {
        return {
          allowed: false,
          reason: `server_daily_call_cap: ${this.serverDailyCalls}+1 would exceed ${this.config.serverDailyCallCap} calls/day (server-wide)`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Check per-key hourly spend caps.
   */
  checkHourlyCap(apiKeyPrefix: string, creditsRequired: number, quota?: QuotaConfig): SpendCapCheckResult {
    if (!quota) return { allowed: true };
    const hourlyCallLimit = (quota as any).hourlyCallLimit || 0;
    const hourlyCreditLimit = (quota as any).hourlyCreditLimit || 0;
    if (hourlyCallLimit === 0 && hourlyCreditLimit === 0) return { allowed: true };

    const bucket = this.getOrCreateHourlyBucket(apiKeyPrefix);

    if (hourlyCallLimit > 0 && bucket.calls + 1 > hourlyCallLimit) {
      return {
        allowed: false,
        reason: `hourly_call_cap: ${bucket.calls}+1 would exceed ${hourlyCallLimit} calls/hour`,
        shouldSuspend: this.config.breachAction === 'suspend',
      };
    }

    if (hourlyCreditLimit > 0 && bucket.credits + creditsRequired > hourlyCreditLimit) {
      return {
        allowed: false,
        reason: `hourly_credit_cap: ${bucket.credits}+${creditsRequired} would exceed ${hourlyCreditLimit} credits/hour`,
        shouldSuspend: this.config.breachAction === 'suspend',
      };
    }

    return { allowed: true };
  }

  /**
   * Check if a key is auto-suspended and whether it should be auto-resumed.
   * Returns true if the key is still suspended (should deny).
   */
  isAutoSuspended(apiKeyPrefix: string): boolean {
    const suspendTime = this.suspendedAt.get(apiKeyPrefix);
    if (!suspendTime) return false;

    // Check auto-resume
    if (this.config.autoResumeAfterSeconds > 0) {
      const elapsed = (Date.now() - suspendTime) / 1000;
      if (elapsed >= this.config.autoResumeAfterSeconds) {
        this.suspendedAt.delete(apiKeyPrefix);
        this.onAutoResume?.(apiKeyPrefix);
        return false;
      }
    }

    return true;
  }

  /**
   * Auto-suspend a key (called when breachAction = 'suspend').
   */
  autoSuspendKey(apiKeyPrefix: string, reason: string): void {
    this.suspendedAt.set(apiKeyPrefix, Date.now());
    this.onAutoSuspend?.(apiKeyPrefix, reason);
  }

  /**
   * Manually clear auto-suspend for a key (admin action).
   */
  clearAutoSuspend(apiKeyPrefix: string): boolean {
    return this.suspendedAt.delete(apiKeyPrefix);
  }

  /**
   * Record successful call against server-wide and hourly caps.
   */
  record(apiKeyPrefix: string, creditsCharged: number): void {
    this.resetServerIfNeeded();
    this.serverDailyCalls++;
    this.serverDailyCredits += creditsCharged;

    const bucket = this.getOrCreateHourlyBucket(apiKeyPrefix);
    bucket.calls++;
    bucket.credits += creditsCharged;
  }

  /**
   * Record a batch of successful calls.
   */
  recordBatch(apiKeyPrefix: string, callCount: number, totalCreditsCharged: number): void {
    this.resetServerIfNeeded();
    this.serverDailyCalls += callCount;
    this.serverDailyCredits += totalCreditsCharged;

    const bucket = this.getOrCreateHourlyBucket(apiKeyPrefix);
    bucket.calls += callCount;
    bucket.credits += totalCreditsCharged;
  }

  /**
   * Get server-wide daily stats.
   */
  getServerStats(): { dailyCalls: number; dailyCredits: number; dailyCallCap: number; dailyCreditCap: number; resetDay: string } {
    this.resetServerIfNeeded();
    return {
      dailyCalls: this.serverDailyCalls,
      dailyCredits: this.serverDailyCredits,
      dailyCallCap: this.config.serverDailyCreditCap,
      dailyCreditCap: this.config.serverDailyCreditCap,
      resetDay: this.serverDailyResetDay,
    };
  }

  /**
   * Get per-key hourly stats.
   */
  getKeyHourlyStats(apiKeyPrefix: string): { hourlyCalls: number; hourlyCredits: number; hour: string } {
    const bucket = this.getOrCreateHourlyBucket(apiKeyPrefix);
    return {
      hourlyCalls: bucket.calls,
      hourlyCredits: bucket.credits,
      hour: bucket.hour,
    };
  }

  /**
   * Get auto-suspend status for a key.
   */
  getAutoSuspendStatus(apiKeyPrefix: string): { suspended: boolean; suspendedAt?: number; autoResumeIn?: number } {
    const suspendTime = this.suspendedAt.get(apiKeyPrefix);
    if (!suspendTime) return { suspended: false };

    const result: { suspended: boolean; suspendedAt: number; autoResumeIn?: number } = {
      suspended: true,
      suspendedAt: suspendTime,
    };

    if (this.config.autoResumeAfterSeconds > 0) {
      const elapsed = (Date.now() - suspendTime) / 1000;
      result.autoResumeIn = Math.max(0, Math.ceil(this.config.autoResumeAfterSeconds - elapsed));
    }

    return result;
  }

  /** Get number of currently auto-suspended keys. */
  get suspendedCount(): number {
    return this.suspendedAt.size;
  }

  /** Get the current config. */
  get currentConfig(): SpendCapConfig {
    return { ...this.config };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private todayUTC(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private hourUTC(): string {
    return new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  }

  private resetServerIfNeeded(): void {
    const today = this.todayUTC();
    if (this.serverDailyResetDay !== today) {
      this.serverDailyCalls = 0;
      this.serverDailyCredits = 0;
      this.serverDailyResetDay = today;
    }
  }

  private getOrCreateHourlyBucket(apiKeyPrefix: string): HourlyBucket {
    const currentHour = this.hourUTC();
    const existing = this.hourlyBuckets.get(apiKeyPrefix);

    if (existing && existing.hour === currentHour) {
      return existing;
    }

    // New hour — reset bucket
    const bucket: HourlyBucket = { hour: currentHour, calls: 0, credits: 0 };
    this.hourlyBuckets.set(apiKeyPrefix, bucket);
    return bucket;
  }
}
