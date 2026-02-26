/**
 * QuotaTracker — Usage quota enforcement for daily/monthly limits.
 *
 * Quotas are separate from rate limits:
 *   - Rate limits: sliding window per-minute burst control
 *   - Quotas: cumulative daily/monthly usage caps
 *
 * Quota counters reset at UTC midnight (daily) and UTC month boundary (monthly).
 * Counters are persisted on the ApiKeyRecord for crash recovery.
 */

import { ApiKeyRecord, QuotaConfig } from './types';

/** Get today's date as YYYY-MM-DD in UTC */
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Get current month as YYYY-MM in UTC */
function monthUTC(): string {
  return new Date().toISOString().slice(0, 7);
}

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
}

export class QuotaTracker {
  /**
   * Reset quota counters if the day or month has rolled over.
   * Mutates the record in-place. Returns true if any reset occurred.
   */
  resetIfNeeded(record: ApiKeyRecord): boolean {
    let reset = false;
    const today = todayUTC();
    const month = monthUTC();

    if (record.quotaLastResetDay !== today) {
      record.quotaDailyCalls = 0;
      record.quotaDailyCredits = 0;
      record.quotaLastResetDay = today;
      reset = true;
    }

    if (record.quotaLastResetMonth !== month) {
      record.quotaMonthlyCalls = 0;
      record.quotaMonthlyCredits = 0;
      record.quotaLastResetMonth = month;
      reset = true;
    }

    return reset;
  }

  /**
   * Check if a call is within quota limits.
   * Does NOT increment counters — call `record()` after the call succeeds.
   */
  check(record: ApiKeyRecord, creditsRequired: number, globalQuota?: QuotaConfig): QuotaCheckResult {
    this.resetIfNeeded(record);

    // Merge: per-key quota overrides global
    const quota = record.quota || globalQuota;
    if (!quota) return { allowed: true };

    // Daily call limit
    if (quota.dailyCallLimit > 0 && record.quotaDailyCalls >= quota.dailyCallLimit) {
      return {
        allowed: false,
        reason: `daily_call_quota_exceeded: ${record.quotaDailyCalls}/${quota.dailyCallLimit} calls today`,
      };
    }

    // Monthly call limit
    if (quota.monthlyCallLimit > 0 && record.quotaMonthlyCalls >= quota.monthlyCallLimit) {
      return {
        allowed: false,
        reason: `monthly_call_quota_exceeded: ${record.quotaMonthlyCalls}/${quota.monthlyCallLimit} calls this month`,
      };
    }

    // Daily credit limit
    if (quota.dailyCreditLimit > 0 && (record.quotaDailyCredits + creditsRequired) > quota.dailyCreditLimit) {
      return {
        allowed: false,
        reason: `daily_credit_quota_exceeded: ${record.quotaDailyCredits}+${creditsRequired} would exceed ${quota.dailyCreditLimit} credits/day`,
      };
    }

    // Monthly credit limit
    if (quota.monthlyCreditLimit > 0 && (record.quotaMonthlyCredits + creditsRequired) > quota.monthlyCreditLimit) {
      return {
        allowed: false,
        reason: `monthly_credit_quota_exceeded: ${record.quotaMonthlyCredits}+${creditsRequired} would exceed ${quota.monthlyCreditLimit} credits/month`,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a successful call against quota counters.
   * Call AFTER the gate decision is ALLOW and credits are deducted.
   */
  record(record: ApiKeyRecord, creditsCharged: number): void {
    this.resetIfNeeded(record);
    record.quotaDailyCalls++;
    record.quotaMonthlyCalls++;
    record.quotaDailyCredits += creditsCharged;
    record.quotaMonthlyCredits += creditsCharged;
  }

  /**
   * Undo a recorded call (for refunds).
   */
  unrecord(record: ApiKeyRecord, creditsCharged: number): void {
    record.quotaDailyCalls = Math.max(0, record.quotaDailyCalls - 1);
    record.quotaMonthlyCalls = Math.max(0, record.quotaMonthlyCalls - 1);
    record.quotaDailyCredits = Math.max(0, record.quotaDailyCredits - creditsCharged);
    record.quotaMonthlyCredits = Math.max(0, record.quotaMonthlyCredits - creditsCharged);
  }
}
