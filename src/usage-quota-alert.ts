/**
 * UsageQuotaAlert — Quota threshold alerting with configurable triggers.
 *
 * Define percentage thresholds on usage quotas and generate alerts
 * when keys cross those thresholds.
 *
 * @example
 * ```ts
 * const alerter = new UsageQuotaAlert();
 *
 * alerter.defineThreshold({ name: 'warning', percentage: 80 });
 * alerter.defineThreshold({ name: 'critical', percentage: 95 });
 *
 * alerter.setQuota('k1', 1000);
 * alerter.recordUsage('k1', 850);
 * // Alert: 'warning' threshold crossed (85%)
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface QuotaThreshold {
  id: string;
  name: string;
  percentage: number;
  createdAt: number;
}

export interface QuotaThresholdParams {
  name: string;
  percentage: number;
}

export interface QuotaAlert {
  id: string;
  key: string;
  thresholdId: string;
  thresholdName: string;
  percentage: number;
  currentUsage: number;
  quota: number;
  triggeredAt: number;
  acknowledged: boolean;
}

export interface KeyQuotaStatus {
  key: string;
  quota: number;
  used: number;
  remaining: number;
  percentUsed: number;
  crossedThresholds: string[];
}

export interface UsageQuotaAlertConfig {
  /** Max tracked keys. Default 10000. */
  maxKeys?: number;
  /** Max alerts to keep. Default 5000. */
  maxAlerts?: number;
}

export interface UsageQuotaAlertStats {
  trackedKeys: number;
  totalThresholds: number;
  totalAlerts: number;
  unacknowledgedAlerts: number;
  topAlertedKeys: { key: string; alertCount: number }[];
}

// ── Implementation ───────────────────────────────────────────────────

interface KeyQuota {
  quota: number;
  used: number;
  crossedThresholds: Set<string>;
  alertCount: number;
}

export class UsageQuotaAlert {
  private thresholds: QuotaThreshold[] = [];
  private quotas = new Map<string, KeyQuota>();
  private alerts: QuotaAlert[] = [];
  private nextThresholdId = 1;
  private nextAlertId = 1;
  private maxKeys: number;
  private maxAlerts: number;

  constructor(config: UsageQuotaAlertConfig = {}) {
    this.maxKeys = config.maxKeys ?? 10_000;
    this.maxAlerts = config.maxAlerts ?? 5000;
  }

  // ── Threshold Management ──────────────────────────────────────

  /** Define an alert threshold. */
  defineThreshold(params: QuotaThresholdParams): QuotaThreshold {
    if (!params.name) throw new Error('Threshold name is required');
    if (params.percentage <= 0 || params.percentage > 100) {
      throw new Error('Percentage must be between 1 and 100');
    }

    const threshold: QuotaThreshold = {
      id: `qt_${this.nextThresholdId++}`,
      name: params.name,
      percentage: params.percentage,
      createdAt: Date.now(),
    };

    this.thresholds.push(threshold);
    this.thresholds.sort((a, b) => a.percentage - b.percentage);
    return threshold;
  }

  /** Remove a threshold. */
  removeThreshold(id: string): boolean {
    const idx = this.thresholds.findIndex(t => t.id === id);
    if (idx === -1) return false;
    this.thresholds.splice(idx, 1);
    return true;
  }

  /** List all thresholds. */
  listThresholds(): QuotaThreshold[] {
    return [...this.thresholds];
  }

  // ── Quota Management ──────────────────────────────────────────

  /** Set quota for a key. */
  setQuota(key: string, quota: number): void {
    if (quota <= 0) throw new Error('Quota must be positive');

    let kq = this.quotas.get(key);
    if (!kq) {
      if (this.quotas.size >= this.maxKeys) {
        throw new Error(`Maximum ${this.maxKeys} keys reached`);
      }
      kq = { quota, used: 0, crossedThresholds: new Set(), alertCount: 0 };
      this.quotas.set(key, kq);
    } else {
      kq.quota = quota;
      // Re-evaluate thresholds
      kq.crossedThresholds.clear();
      this.checkThresholds(key, kq);
    }
  }

  /** Record usage for a key and check thresholds. */
  recordUsage(key: string, amount: number): QuotaAlert[] {
    const kq = this.quotas.get(key);
    if (!kq) return [];

    kq.used += amount;
    return this.checkThresholds(key, kq);
  }

  /** Reset usage for a key. */
  resetUsage(key: string): boolean {
    const kq = this.quotas.get(key);
    if (!kq) return false;
    kq.used = 0;
    kq.crossedThresholds.clear();
    return true;
  }

  /** Get quota status for a key. */
  getKeyStatus(key: string): KeyQuotaStatus | null {
    const kq = this.quotas.get(key);
    if (!kq) return null;

    const percentUsed = Math.round((kq.used / kq.quota) * 10000) / 100;
    return {
      key,
      quota: kq.quota,
      used: kq.used,
      remaining: Math.max(0, kq.quota - kq.used),
      percentUsed,
      crossedThresholds: [...kq.crossedThresholds],
    };
  }

  // ── Alert Management ──────────────────────────────────────────

  /** Get alerts. */
  getAlerts(options?: { key?: string; unacknowledgedOnly?: boolean; limit?: number }): QuotaAlert[] {
    let results = [...this.alerts];
    if (options?.key) results = results.filter(a => a.key === options.key);
    if (options?.unacknowledgedOnly) results = results.filter(a => !a.acknowledged);
    return results.slice(-(options?.limit ?? 50));
  }

  /** Acknowledge an alert. */
  acknowledgeAlert(id: string): boolean {
    const alert = this.alerts.find(a => a.id === id);
    if (!alert) return false;
    alert.acknowledged = true;
    return true;
  }

  /** Acknowledge all alerts for a key. */
  acknowledgeAllForKey(key: string): number {
    let count = 0;
    for (const a of this.alerts) {
      if (a.key === key && !a.acknowledged) { a.acknowledged = true; count++; }
    }
    return count;
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): UsageQuotaAlertStats {
    const keyCounts: { key: string; alertCount: number }[] = [];
    for (const [key, kq] of this.quotas) {
      if (kq.alertCount > 0) keyCounts.push({ key, alertCount: kq.alertCount });
    }
    keyCounts.sort((a, b) => b.alertCount - a.alertCount);

    return {
      trackedKeys: this.quotas.size,
      totalThresholds: this.thresholds.length,
      totalAlerts: this.alerts.length,
      unacknowledgedAlerts: this.alerts.filter(a => !a.acknowledged).length,
      topAlertedKeys: keyCounts.slice(0, 5),
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.thresholds = [];
    this.quotas.clear();
    this.alerts = [];
  }

  // ── Private ───────────────────────────────────────────────────

  private checkThresholds(key: string, kq: KeyQuota): QuotaAlert[] {
    const percentUsed = (kq.used / kq.quota) * 100;
    const newAlerts: QuotaAlert[] = [];

    for (const threshold of this.thresholds) {
      if (percentUsed >= threshold.percentage && !kq.crossedThresholds.has(threshold.id)) {
        kq.crossedThresholds.add(threshold.id);
        kq.alertCount++;

        const alert: QuotaAlert = {
          id: `qa_${this.nextAlertId++}`,
          key,
          thresholdId: threshold.id,
          thresholdName: threshold.name,
          percentage: Math.round(percentUsed * 100) / 100,
          currentUsage: kq.used,
          quota: kq.quota,
          triggeredAt: Date.now(),
          acknowledged: false,
        };

        this.alerts.push(alert);
        newAlerts.push(alert);

        if (this.alerts.length > this.maxAlerts) {
          this.alerts.splice(0, this.alerts.length - this.maxAlerts);
        }
      }
    }

    return newAlerts;
  }
}
