/**
 * QuotaRolloverManager — Manage recurring quotas with rollover support.
 *
 * Track usage against periodic quotas (daily, weekly, monthly) with
 * configurable rollover of unused quota to the next period. Supports
 * max rollover caps, grace periods, and quota reset scheduling.
 *
 * @example
 * ```ts
 * const mgr = new QuotaRolloverManager();
 *
 * mgr.createQuota({
 *   key: 'key_abc',
 *   limit: 1000,
 *   period: 'monthly',
 *   rolloverPercent: 50,   // roll over 50% of unused
 *   maxRollover: 500,      // cap rollover at 500
 * });
 *
 * mgr.consume('key_abc', 200);
 * const status = mgr.getStatus('key_abc');
 * // { used: 200, limit: 1000, rollover: 0, remaining: 800 }
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type QuotaPeriod = 'daily' | 'weekly' | 'monthly';

export interface QuotaDefinition {
  key: string;
  limit: number;
  period: QuotaPeriod;
  /** Percentage of unused quota to roll over (0-100). Default 0. */
  rolloverPercent: number;
  /** Maximum rollover credits. Default: unlimited. */
  maxRollover: number;
  /** When the current period started. */
  periodStart: number;
  /** When the current period ends. */
  periodEnd: number;
  /** Usage in the current period. */
  used: number;
  /** Rolled-over credits from previous periods. */
  rollover: number;
  /** Total periods completed. */
  periodsCompleted: number;
  createdAt: number;
}

export interface QuotaCreateParams {
  key: string;
  limit: number;
  period: QuotaPeriod;
  rolloverPercent?: number;
  maxRollover?: number;
}

export interface QuotaStatus {
  key: string;
  limit: number;
  used: number;
  rollover: number;
  /** Total available: limit + rollover - used. */
  remaining: number;
  /** Percentage used of total available. */
  usagePercent: number;
  period: QuotaPeriod;
  periodStart: number;
  periodEnd: number;
  periodsCompleted: number;
}

export interface QuotaConsumeResult {
  success: boolean;
  consumed: number;
  remaining: number;
  error?: string;
}

export interface QuotaRolloverEvent {
  key: string;
  fromPeriodStart: number;
  fromPeriodEnd: number;
  toPeriodStart: number;
  toPeriodEnd: number;
  unused: number;
  rolledOver: number;
  cappedAt?: number;
}

export interface QuotaRolloverConfig {
  /** Auto-advance periods when they expire. Default true. */
  autoAdvance?: boolean;
}

export interface QuotaRolloverStats {
  totalQuotas: number;
  totalConsumed: number;
  totalRollovers: number;
  totalRolloverCredits: number;
  totalDenied: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class QuotaRolloverManager {
  private quotas = new Map<string, QuotaDefinition>();
  private autoAdvance: boolean;

  // Rollover history
  private rolloverHistory: QuotaRolloverEvent[] = [];

  // Stats
  private totalConsumed = 0;
  private totalRollovers = 0;
  private totalRolloverCredits = 0;
  private totalDenied = 0;

  constructor(config: QuotaRolloverConfig = {}) {
    this.autoAdvance = config.autoAdvance ?? true;
  }

  // ── Quota Management ──────────────────────────────────────────────

  /** Create a new quota for a key. */
  createQuota(params: QuotaCreateParams): QuotaDefinition {
    if (this.quotas.has(params.key)) {
      throw new Error(`Quota already exists for key: ${params.key}`);
    }
    if (params.limit <= 0) throw new Error('Limit must be positive');

    const now = Date.now();
    const periodEnd = this.calculatePeriodEnd(now, params.period);

    const quota: QuotaDefinition = {
      key: params.key,
      limit: params.limit,
      period: params.period,
      rolloverPercent: Math.min(100, Math.max(0, params.rolloverPercent ?? 0)),
      maxRollover: params.maxRollover ?? Infinity,
      periodStart: now,
      periodEnd,
      used: 0,
      rollover: 0,
      periodsCompleted: 0,
      createdAt: now,
    };

    this.quotas.set(params.key, quota);
    return quota;
  }

  /** Remove a quota. */
  removeQuota(key: string): boolean {
    return this.quotas.delete(key);
  }

  /** Update quota limit (takes effect immediately). */
  updateLimit(key: string, newLimit: number): boolean {
    const quota = this.quotas.get(key);
    if (!quota) return false;
    if (newLimit <= 0) throw new Error('Limit must be positive');
    quota.limit = newLimit;
    return true;
  }

  /** Update rollover settings. */
  updateRollover(key: string, rolloverPercent: number, maxRollover?: number): boolean {
    const quota = this.quotas.get(key);
    if (!quota) return false;
    quota.rolloverPercent = Math.min(100, Math.max(0, rolloverPercent));
    if (maxRollover !== undefined) quota.maxRollover = maxRollover;
    return true;
  }

  // ── Consumption ───────────────────────────────────────────────────

  /** Consume credits against a key's quota. */
  consume(key: string, amount: number): QuotaConsumeResult {
    const quota = this.quotas.get(key);
    if (!quota) {
      return { success: false, consumed: 0, remaining: 0, error: 'Quota not found' };
    }

    // Auto-advance period if expired
    if (this.autoAdvance && Date.now() >= quota.periodEnd) {
      this.advancePeriod(key);
    }

    const totalAvailable = quota.limit + quota.rollover - quota.used;
    if (amount > totalAvailable) {
      this.totalDenied++;
      return {
        success: false,
        consumed: 0,
        remaining: totalAvailable,
        error: `Insufficient quota: need ${amount}, have ${totalAvailable}`,
      };
    }

    quota.used += amount;
    this.totalConsumed += amount;

    return {
      success: true,
      consumed: amount,
      remaining: quota.limit + quota.rollover - quota.used,
    };
  }

  // ── Period Management ─────────────────────────────────────────────

  /** Manually advance to the next period (triggers rollover). */
  advancePeriod(key: string): QuotaRolloverEvent | null {
    const quota = this.quotas.get(key);
    if (!quota) return null;

    const unused = quota.limit + quota.rollover - quota.used;
    let rolledOver = 0;

    if (quota.rolloverPercent > 0 && unused > 0) {
      rolledOver = Math.floor(unused * (quota.rolloverPercent / 100));
      // Cap rollover
      if (rolledOver > quota.maxRollover) {
        rolledOver = quota.maxRollover;
      }
    }

    const event: QuotaRolloverEvent = {
      key,
      fromPeriodStart: quota.periodStart,
      fromPeriodEnd: quota.periodEnd,
      toPeriodStart: quota.periodEnd,
      toPeriodEnd: this.calculatePeriodEnd(quota.periodEnd, quota.period),
      unused,
      rolledOver,
      cappedAt: rolledOver < Math.floor(unused * (quota.rolloverPercent / 100)) ? quota.maxRollover : undefined,
    };

    // Advance the quota
    quota.periodStart = event.toPeriodStart;
    quota.periodEnd = event.toPeriodEnd;
    quota.used = 0;
    quota.rollover = rolledOver;
    quota.periodsCompleted++;

    this.rolloverHistory.push(event);
    this.totalRollovers++;
    this.totalRolloverCredits += rolledOver;

    return event;
  }

  // ── Status ────────────────────────────────────────────────────────

  /** Get current quota status for a key. */
  getStatus(key: string): QuotaStatus | null {
    const quota = this.quotas.get(key);
    if (!quota) return null;

    // Auto-advance if needed
    if (this.autoAdvance && Date.now() >= quota.periodEnd) {
      this.advancePeriod(key);
    }

    const total = quota.limit + quota.rollover;
    const remaining = total - quota.used;

    return {
      key: quota.key,
      limit: quota.limit,
      used: quota.used,
      rollover: quota.rollover,
      remaining,
      usagePercent: total > 0 ? Math.round((quota.used / total) * 100) : 0,
      period: quota.period,
      periodStart: quota.periodStart,
      periodEnd: quota.periodEnd,
      periodsCompleted: quota.periodsCompleted,
    };
  }

  /** List all quota keys. */
  listQuotas(): string[] {
    return [...this.quotas.keys()];
  }

  /** Get rollover history for a key. */
  getRolloverHistory(key: string): QuotaRolloverEvent[] {
    return this.rolloverHistory.filter(e => e.key === key);
  }

  /** Get all rollover history. */
  getAllRolloverHistory(): QuotaRolloverEvent[] {
    return [...this.rolloverHistory];
  }

  // ── Stats ─────────────────────────────────────────────────────────

  getStats(): QuotaRolloverStats {
    return {
      totalQuotas: this.quotas.size,
      totalConsumed: this.totalConsumed,
      totalRollovers: this.totalRollovers,
      totalRolloverCredits: this.totalRolloverCredits,
      totalDenied: this.totalDenied,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.quotas.clear();
    this.rolloverHistory = [];
    this.totalConsumed = 0;
    this.totalRollovers = 0;
    this.totalRolloverCredits = 0;
    this.totalDenied = 0;
  }

  // ── Private ───────────────────────────────────────────────────────

  private calculatePeriodEnd(start: number, period: QuotaPeriod): number {
    const d = new Date(start);
    switch (period) {
      case 'daily':
        d.setDate(d.getDate() + 1);
        break;
      case 'weekly':
        d.setDate(d.getDate() + 7);
        break;
      case 'monthly':
        d.setMonth(d.getMonth() + 1);
        break;
    }
    return d.getTime();
  }
}
