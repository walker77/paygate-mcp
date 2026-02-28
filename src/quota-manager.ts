/**
 * QuotaManager — Daily/weekly/monthly hard caps per API key.
 *
 * Distinct from rate limiting (requests/min), quotas enforce absolute
 * call or credit ceilings over calendar periods:
 *   - Daily quota resets at midnight UTC
 *   - Weekly quota resets Monday 00:00 UTC
 *   - Monthly quota resets 1st of month 00:00 UTC
 *
 * Features:
 *   - Per-key quotas with separate call and credit limits
 *   - Per-tool quotas (restrict specific tool usage per key)
 *   - Quota inheritance from key groups
 *   - Usage tracking with period-aware rollover
 *   - Overage actions: deny, warn, throttle
 *   - Quota utilization reporting with forecast
 *   - Burst allowance: temporary over-limit (configurable %)
 *
 * Zero external dependencies.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type QuotaPeriod = 'daily' | 'weekly' | 'monthly';
export type QuotaMetric = 'calls' | 'credits';
export type OverageAction = 'deny' | 'warn' | 'throttle';

export interface QuotaRule {
  id: string;
  /** API key or '*' for global default. */
  apiKey: string;
  /** Optional tool name — if set, quota applies only to this tool. */
  tool?: string;
  period: QuotaPeriod;
  metric: QuotaMetric;
  limit: number;
  /** What happens when quota is exceeded. Default 'deny'. */
  overageAction: OverageAction;
  /** Burst allowance — allow up to this % over limit before hard deny. Default 0. */
  burstPercent: number;
  /** Whether this rule is active. */
  enabled: boolean;
  createdAt: number;
}

export interface QuotaUsage {
  ruleId: string;
  apiKey: string;
  tool?: string;
  period: QuotaPeriod;
  metric: QuotaMetric;
  /** Current usage in this period. */
  used: number;
  /** The limit from the rule. */
  limit: number;
  /** Period start timestamp. */
  periodStart: number;
  /** Period end timestamp. */
  periodEnd: number;
}

export interface QuotaCheckResult {
  allowed: boolean;
  ruleId?: string;
  apiKey: string;
  tool?: string;
  /** Current usage after this check. */
  used: number;
  limit: number;
  remaining: number;
  period?: QuotaPeriod;
  metric?: QuotaMetric;
  action?: OverageAction;
  /** Whether in burst zone (over limit but under burst cap). */
  inBurst: boolean;
  reason?: string;
}

export interface QuotaStats {
  totalRules: number;
  activeRules: number;
  totalChecks: number;
  totalDenied: number;
  totalWarned: number;
  totalThrottled: number;
  totalBursts: number;
}

export interface QuotaManagerConfig {
  enabled: boolean;
  maxRules: number;
  /** Max usage records to keep. Default 50,000. */
  maxUsageRecords: number;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: QuotaManagerConfig = {
  enabled: false,
  maxRules: 1000,
  maxUsageRecords: 50_000,
};

// ─── Period Helpers ─────────────────────────────────────────────────────────

function getPeriodBounds(period: QuotaPeriod, now: number = Date.now()): { start: number; end: number } {
  const d = new Date(now);

  if (period === 'daily') {
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).getTime();
    const end = start + 24 * 60 * 60 * 1000;
    return { start, end };
  }

  if (period === 'weekly') {
    // Week starts Monday
    const day = d.getUTCDay(); // 0=Sun, 1=Mon...
    const mondayOffset = day === 0 ? 6 : day - 1;
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - mondayOffset));
    const start = monday.getTime();
    const end = start + 7 * 24 * 60 * 60 * 1000;
    return { start, end };
  }

  // monthly
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).getTime();
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).getTime();
  return { start, end };
}

function usageKey(ruleId: string, periodStart: number): string {
  return `${ruleId}:${periodStart}`;
}

// ─── QuotaManager Class ─────────────────────────────────────────────────────

export class QuotaManager {
  private config: QuotaManagerConfig;
  private rules = new Map<string, QuotaRule>();
  /** usageKey → current count */
  private usage = new Map<string, number>();

  // Stats
  private _totalChecks = 0;
  private _totalDenied = 0;
  private _totalWarned = 0;
  private _totalThrottled = 0;
  private _totalBursts = 0;

  private ruleCounter = 0;

  constructor(config?: Partial<QuotaManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Rule CRUD ──────────────────────────────────────────────────────────

  createRule(params: {
    apiKey: string;
    tool?: string;
    period: QuotaPeriod;
    metric: QuotaMetric;
    limit: number;
    overageAction?: OverageAction;
    burstPercent?: number;
    enabled?: boolean;
  }): QuotaRule {
    if (!params.apiKey) throw new Error('apiKey required');
    if (params.limit <= 0) throw new Error('limit must be positive');
    if (this.rules.size >= this.config.maxRules) {
      throw new Error(`Max rules reached (${this.config.maxRules})`);
    }

    const burst = params.burstPercent ?? 0;
    if (burst < 0 || burst > 100) throw new Error('burstPercent must be 0-100');

    this.ruleCounter++;
    const id = `qr_${this.ruleCounter}_${Date.now().toString(36)}`;

    const rule: QuotaRule = {
      id,
      apiKey: params.apiKey,
      tool: params.tool,
      period: params.period,
      metric: params.metric,
      limit: params.limit,
      overageAction: params.overageAction ?? 'deny',
      burstPercent: burst,
      enabled: params.enabled ?? true,
      createdAt: Date.now(),
    };

    this.rules.set(id, rule);
    return { ...rule };
  }

  getRule(id: string): QuotaRule | undefined {
    const r = this.rules.get(id);
    return r ? { ...r } : undefined;
  }

  listRules(apiKey?: string): QuotaRule[] {
    const results: QuotaRule[] = [];
    for (const r of this.rules.values()) {
      if (apiKey && r.apiKey !== apiKey && r.apiKey !== '*') continue;
      results.push({ ...r });
    }
    return results;
  }

  updateRule(id: string, updates: Partial<Pick<QuotaRule, 'limit' | 'overageAction' | 'burstPercent' | 'enabled'>>): QuotaRule | null {
    const rule = this.rules.get(id);
    if (!rule) return null;

    if (updates.limit !== undefined) {
      if (updates.limit <= 0) throw new Error('limit must be positive');
      rule.limit = updates.limit;
    }
    if (updates.overageAction !== undefined) rule.overageAction = updates.overageAction;
    if (updates.burstPercent !== undefined) {
      if (updates.burstPercent < 0 || updates.burstPercent > 100) throw new Error('burstPercent must be 0-100');
      rule.burstPercent = updates.burstPercent;
    }
    if (updates.enabled !== undefined) rule.enabled = updates.enabled;

    return { ...rule };
  }

  deleteRule(id: string): boolean {
    return this.rules.delete(id);
  }

  // ─── Quota Checking ─────────────────────────────────────────────────────

  /**
   * Check if a request is within quota. Optionally record usage.
   * @param apiKey The API key making the request.
   * @param amount The amount to consume (1 for calls, credit amount for credits).
   * @param tool Optional tool name for tool-specific quotas.
   * @param record If true, increment usage counters. Default true.
   */
  check(apiKey: string, amount: number = 1, tool?: string, record: boolean = true): QuotaCheckResult {
    this._totalChecks++;

    if (!this.config.enabled) {
      return { allowed: true, apiKey, tool, used: 0, limit: 0, remaining: 0, inBurst: false };
    }

    // Find applicable rules (key-specific + global defaults)
    const applicable = this.findApplicableRules(apiKey, tool);

    if (applicable.length === 0) {
      return { allowed: true, apiKey, tool, used: 0, limit: 0, remaining: 0, inBurst: false };
    }

    // Check each applicable rule — most restrictive wins
    let mostRestrictive: QuotaCheckResult | null = null;

    for (const rule of applicable) {
      const bounds = getPeriodBounds(rule.period);
      const key = usageKey(rule.id, bounds.start);
      const currentUsage = this.usage.get(key) ?? 0;
      const afterUsage = currentUsage + amount;
      const effectiveLimit = rule.limit + (rule.limit * rule.burstPercent / 100);

      const remaining = Math.max(0, rule.limit - currentUsage);
      const inBurst = afterUsage > rule.limit && afterUsage <= effectiveLimit;

      if (afterUsage > effectiveLimit) {
        // Over limit (including burst)
        const result: QuotaCheckResult = {
          allowed: rule.overageAction !== 'deny',
          ruleId: rule.id,
          apiKey,
          tool,
          used: currentUsage,
          limit: rule.limit,
          remaining: 0,
          period: rule.period,
          metric: rule.metric,
          action: rule.overageAction,
          inBurst: false,
          reason: `${rule.period} ${rule.metric} quota exceeded (${currentUsage}/${rule.limit})`,
        };

        if (rule.overageAction === 'deny') {
          this._totalDenied++;
          if (record) this.recordUsageInternal(key, amount); // still record the attempt
          return result;
        } else if (rule.overageAction === 'warn') {
          this._totalWarned++;
        } else if (rule.overageAction === 'throttle') {
          this._totalThrottled++;
        }

        if (!mostRestrictive || !result.allowed) {
          mostRestrictive = result;
        }
      } else if (inBurst) {
        this._totalBursts++;
        const result: QuotaCheckResult = {
          allowed: true,
          ruleId: rule.id,
          apiKey,
          tool,
          used: afterUsage,
          limit: rule.limit,
          remaining: 0,
          period: rule.period,
          metric: rule.metric,
          inBurst: true,
          reason: `In burst zone (${afterUsage}/${rule.limit}, burst cap ${Math.floor(effectiveLimit)})`,
        };
        if (!mostRestrictive) {
          mostRestrictive = result;
        }
      }
    }

    // Record usage for all applicable rules
    if (record) {
      for (const rule of applicable) {
        const bounds = getPeriodBounds(rule.period);
        const key = usageKey(rule.id, bounds.start);
        this.recordUsageInternal(key, amount);
      }
    }

    if (mostRestrictive) {
      return mostRestrictive;
    }

    // All quotas OK
    const firstRule = applicable[0];
    const bounds = getPeriodBounds(firstRule.period);
    const key = usageKey(firstRule.id, bounds.start);
    const used = this.usage.get(key) ?? 0;

    return {
      allowed: true,
      apiKey,
      tool,
      used,
      limit: firstRule.limit,
      remaining: Math.max(0, firstRule.limit - used),
      period: firstRule.period,
      metric: firstRule.metric,
      inBurst: false,
    };
  }

  // ─── Usage Reporting ────────────────────────────────────────────────────

  /**
   * Get current usage for a key across all its quota rules.
   */
  getUsage(apiKey: string, tool?: string): QuotaUsage[] {
    const rules = this.findApplicableRules(apiKey, tool);
    const results: QuotaUsage[] = [];

    for (const rule of rules) {
      const bounds = getPeriodBounds(rule.period);
      const key = usageKey(rule.id, bounds.start);
      const used = this.usage.get(key) ?? 0;

      results.push({
        ruleId: rule.id,
        apiKey: rule.apiKey,
        tool: rule.tool,
        period: rule.period,
        metric: rule.metric,
        used,
        limit: rule.limit,
        periodStart: bounds.start,
        periodEnd: bounds.end,
      });
    }

    return results;
  }

  /**
   * Reset usage for a specific rule (admin override).
   */
  resetUsage(ruleId: string): boolean {
    const rule = this.rules.get(ruleId);
    if (!rule) return false;

    const bounds = getPeriodBounds(rule.period);
    const key = usageKey(ruleId, bounds.start);
    this.usage.delete(key);
    return true;
  }

  // ─── Configuration ─────────────────────────────────────────────────────

  configure(updates: Partial<QuotaManagerConfig>): QuotaManagerConfig {
    if (updates.enabled !== undefined) this.config.enabled = updates.enabled;
    if (updates.maxRules !== undefined) this.config.maxRules = Math.max(1, updates.maxRules);
    if (updates.maxUsageRecords !== undefined) this.config.maxUsageRecords = Math.max(100, updates.maxUsageRecords);
    return { ...this.config };
  }

  stats(): QuotaStats {
    let activeRules = 0;
    for (const r of this.rules.values()) {
      if (r.enabled) activeRules++;
    }

    return {
      totalRules: this.rules.size,
      activeRules,
      totalChecks: this._totalChecks,
      totalDenied: this._totalDenied,
      totalWarned: this._totalWarned,
      totalThrottled: this._totalThrottled,
      totalBursts: this._totalBursts,
    };
  }

  clear(): void {
    this.rules.clear();
    this.usage.clear();
    this._totalChecks = 0;
    this._totalDenied = 0;
    this._totalWarned = 0;
    this._totalThrottled = 0;
    this._totalBursts = 0;
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private findApplicableRules(apiKey: string, tool?: string): QuotaRule[] {
    const results: QuotaRule[] = [];
    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;
      // Key match: specific key or global default
      if (rule.apiKey !== apiKey && rule.apiKey !== '*') continue;
      // Tool match: rule with no tool applies to all; rule with tool only applies to that tool
      if (rule.tool && rule.tool !== tool) continue;
      results.push(rule);
    }
    return results;
  }

  private recordUsageInternal(key: string, amount: number): void {
    // Prune old records if needed
    if (this.usage.size >= this.config.maxUsageRecords) {
      // Remove oldest entries (first inserted)
      const iter = this.usage.keys();
      const toDelete = Math.floor(this.config.maxUsageRecords * 0.1); // remove 10%
      for (let i = 0; i < toDelete; i++) {
        const k = iter.next().value;
        if (k) this.usage.delete(k);
      }
    }

    const current = this.usage.get(key) ?? 0;
    this.usage.set(key, current + amount);
  }
}
