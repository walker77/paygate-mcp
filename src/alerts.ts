/**
 * AlertEngine — Configurable alerts for proactive monitoring.
 *
 * Alert types:
 *   - spending_threshold: Fires when a key's totalSpent crosses X% of its credits
 *   - credits_low: Fires when remaining credits fall below threshold
 *   - quota_warning: Fires when daily/monthly quota usage exceeds X%
 *   - key_expiry_soon: Fires when a key will expire within N seconds
 *   - rate_limit_spike: Fires when rate limit denials exceed N in a window
 *
 * Each alert fires at most once per key per cooldown period (default 1 hour).
 */

import { ApiKeyRecord } from './types';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AlertType =
  | 'spending_threshold'
  | 'credits_low'
  | 'quota_warning'
  | 'key_expiry_soon'
  | 'rate_limit_spike';

export interface AlertRule {
  type: AlertType;
  /** Threshold value — meaning depends on type:
   *   - spending_threshold: percentage (0-100) of initial credits spent
   *   - credits_low: absolute credits remaining
   *   - quota_warning: percentage (0-100) of quota used
   *   - key_expiry_soon: seconds before expiry to alert
   *   - rate_limit_spike: number of denials in a 5-min window
   */
  threshold: number;
  /** Cooldown in seconds between repeated alerts for same key (default: 3600) */
  cooldownSeconds?: number;
}

export interface Alert {
  type: AlertType;
  timestamp: string;
  keyPrefix: string;
  keyName: string;
  message: string;
  threshold: number;
  currentValue: number;
  metadata: Record<string, unknown>;
}

export interface AlertEngineConfig {
  rules: AlertRule[];
  /** If true, alerts are only logged but not emitted */
  dryRun?: boolean;
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export class AlertEngine {
  private rules: AlertRule[];
  private readonly dryRun: boolean;
  /** Map of "alertType:keyPrefix" → last alert timestamp */
  private readonly cooldowns = new Map<string, number>();
  /** Rate limit denial counter: "keyPrefix" → timestamps of recent denials */
  private readonly rateLimitDenials = new Map<string, number[]>();
  /** Pending alerts waiting to be consumed */
  private pendingAlerts: Alert[] = [];

  constructor(config?: AlertEngineConfig) {
    this.rules = config?.rules || [];
    this.dryRun = config?.dryRun || false;
  }

  /**
   * Replace alert rules at runtime (for config hot-reload).
   */
  setRules(rules: AlertRule[]): void {
    this.rules = rules;
  }

  /**
   * Check a key record against all alert rules.
   * Call this after every gate evaluation.
   */
  check(key: string, record: ApiKeyRecord, context?: { rateLimitDenied?: boolean }): Alert[] {
    const fired: Alert[] = [];
    const keyPrefix = key.slice(0, 10) + '...';

    for (const rule of this.rules) {
      const cooldownKey = `${rule.type}:${keyPrefix}`;
      const cooldownMs = (rule.cooldownSeconds || 3600) * 1000;
      const lastFired = this.cooldowns.get(cooldownKey) || 0;
      const now = Date.now();

      if (now - lastFired < cooldownMs) continue;

      const alert = this.evaluateRule(rule, key, record, keyPrefix, context);
      if (alert) {
        this.cooldowns.set(cooldownKey, now);
        fired.push(alert);
        if (!this.dryRun) {
          this.pendingAlerts.push(alert);
        }
      }
    }

    return fired;
  }

  /**
   * Record a rate limit denial for spike detection.
   */
  recordRateLimitDenial(key: string): void {
    const keyPrefix = key.slice(0, 10) + '...';
    let denials = this.rateLimitDenials.get(keyPrefix);
    if (!denials) {
      denials = [];
      this.rateLimitDenials.set(keyPrefix, denials);
    }
    denials.push(Date.now());

    // Keep only last 5 minutes
    const cutoff = Date.now() - 5 * 60 * 1000;
    this.rateLimitDenials.set(keyPrefix, denials.filter(t => t > cutoff));
  }

  /**
   * Consume pending alerts (returns and clears the queue).
   */
  consumeAlerts(): Alert[] {
    const alerts = [...this.pendingAlerts];
    this.pendingAlerts = [];
    return alerts;
  }

  /**
   * Get pending alert count.
   */
  get pendingCount(): number {
    return this.pendingAlerts.length;
  }

  /**
   * Get configured rules.
   */
  get configuredRules(): AlertRule[] {
    return [...this.rules];
  }

  /**
   * Evaluate a single rule against a key record.
   */
  private evaluateRule(
    rule: AlertRule,
    key: string,
    record: ApiKeyRecord,
    keyPrefix: string,
    context?: { rateLimitDenied?: boolean },
  ): Alert | null {
    const now = new Date().toISOString();
    const base = {
      type: rule.type,
      timestamp: now,
      keyPrefix,
      keyName: record.name,
      threshold: rule.threshold,
    };

    switch (rule.type) {
      case 'spending_threshold': {
        // Alert when totalSpent exceeds threshold% of (totalSpent + remaining credits)
        const totalBudget = record.credits + record.totalSpent;
        if (totalBudget <= 0) return null;
        const spentPct = (record.totalSpent / totalBudget) * 100;
        if (spentPct >= rule.threshold) {
          return {
            ...base,
            currentValue: Math.round(spentPct * 10) / 10,
            message: `Key "${record.name}" has spent ${Math.round(spentPct)}% of total budget (${record.totalSpent}/${totalBudget} credits)`,
            metadata: { credits: record.credits, totalSpent: record.totalSpent, totalBudget },
          };
        }
        return null;
      }

      case 'credits_low': {
        if (record.credits <= rule.threshold) {
          return {
            ...base,
            currentValue: record.credits,
            message: `Key "${record.name}" has only ${record.credits} credits remaining (threshold: ${rule.threshold})`,
            metadata: { credits: record.credits },
          };
        }
        return null;
      }

      case 'quota_warning': {
        if (!record.quota) return null;
        // Check daily call quota
        if (record.quota.dailyCallLimit > 0) {
          const pct = (record.quotaDailyCalls / record.quota.dailyCallLimit) * 100;
          if (pct >= rule.threshold) {
            return {
              ...base,
              currentValue: Math.round(pct * 10) / 10,
              message: `Key "${record.name}" daily call quota at ${Math.round(pct)}% (${record.quotaDailyCalls}/${record.quota.dailyCallLimit})`,
              metadata: {
                quotaType: 'dailyCalls',
                used: record.quotaDailyCalls,
                limit: record.quota.dailyCallLimit,
              },
            };
          }
        }
        // Check monthly call quota
        if (record.quota.monthlyCallLimit > 0) {
          const pct = (record.quotaMonthlyCalls / record.quota.monthlyCallLimit) * 100;
          if (pct >= rule.threshold) {
            return {
              ...base,
              currentValue: Math.round(pct * 10) / 10,
              message: `Key "${record.name}" monthly call quota at ${Math.round(pct)}% (${record.quotaMonthlyCalls}/${record.quota.monthlyCallLimit})`,
              metadata: {
                quotaType: 'monthlyCalls',
                used: record.quotaMonthlyCalls,
                limit: record.quota.monthlyCallLimit,
              },
            };
          }
        }
        return null;
      }

      case 'key_expiry_soon': {
        if (!record.expiresAt) return null;
        const expiresMs = new Date(record.expiresAt).getTime();
        const remainingMs = expiresMs - Date.now();
        const thresholdMs = rule.threshold * 1000;
        if (remainingMs > 0 && remainingMs <= thresholdMs) {
          const remainingHours = Math.round(remainingMs / 3600_000 * 10) / 10;
          return {
            ...base,
            currentValue: Math.round(remainingMs / 1000),
            message: `Key "${record.name}" expires in ${remainingHours} hours (${record.expiresAt})`,
            metadata: { expiresAt: record.expiresAt, remainingSeconds: Math.round(remainingMs / 1000) },
          };
        }
        return null;
      }

      case 'rate_limit_spike': {
        if (!context?.rateLimitDenied) return null;
        const denials = this.rateLimitDenials.get(keyPrefix) || [];
        const recentCount = denials.length;
        if (recentCount >= rule.threshold) {
          return {
            ...base,
            currentValue: recentCount,
            message: `Key "${record.name}" hit ${recentCount} rate limit denials in 5 min (threshold: ${rule.threshold})`,
            metadata: { denialCount: recentCount, windowMinutes: 5 },
          };
        }
        return null;
      }

      default:
        return null;
    }
  }

  /**
   * Clear cooldowns (for testing).
   */
  clearCooldowns(): void {
    this.cooldowns.clear();
    this.rateLimitDenials.clear();
    this.pendingAlerts = [];
  }
}
