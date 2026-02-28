/**
 * BudgetPolicyEngine — Spend governance and burn rate control.
 *
 * Protects against unexpected cost explosions from leaked tokens,
 * runaway agents, or usage pattern changes. Monitors burn rates
 * and enforces daily/monthly budgets with progressive throttling.
 *
 * Features:
 *   - Burn rate monitoring with configurable window and threshold
 *   - Progressive throttling (auto-reduce rate limits on overspend)
 *   - Daily and monthly budget enforcement
 *   - Budget remaining forecast via X-Budget-Remaining header
 *   - Per-namespace and per-group policy targeting
 *   - Stats: budget utilization, burn rate, throttle events
 *
 * Zero external dependencies.
 */

import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BudgetPolicy {
  policyId: string;
  name: string;
  /** Target namespace. Null = global. */
  targetNamespace?: string;
  /** Target API key. Null = all keys in namespace. */
  targetApiKey?: string;

  // Burn rate monitoring
  /** Credits per minute threshold to trigger alert. Default 100. */
  burnRateThreshold: number;
  /** Window in seconds to measure burn rate. Default 60. */
  burnRateWindowSec: number;

  // Budget limits
  /** Daily budget in credits. 0 = unlimited. */
  dailyBudget: number;
  /** Monthly budget in credits. 0 = unlimited. */
  monthlyBudget: number;

  // Actions
  /** Action when burn rate exceeded. */
  onBurnRateExceeded: 'alert' | 'throttle' | 'deny';
  /** Throttle reduction percent. Default 50. */
  throttleReductionPercent: number;
  /** Throttle cooldown in seconds. Default 300 (5 min). */
  throttleCooldownSec: number;

  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface BudgetState {
  policyId: string;
  /** Rolling window spend entries. */
  windowSpend: { time: number; credits: number }[];
  /** Is currently throttled? */
  isThrottled: boolean;
  /** Throttle expires at (epoch ms). */
  throttledUntil: number;
  /** Today's spend. */
  dailySpent: number;
  /** This month's spend. */
  monthlySpent: number;
  /** Day boundary (epoch ms). */
  dailyResetAt: number;
  /** Month boundary (epoch ms). */
  monthlyResetAt: number;
  /** Total burn rate alerts triggered. */
  burnRateAlerts: number;
  /** Total throttle events. */
  throttleEvents: number;
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  burnRateExceeded: boolean;
  isThrottled: boolean;
  dailyRemaining?: number;
  monthlyRemaining?: number;
  currentBurnRate: number;
  /** Estimated hours until budget exhaustion at current rate. */
  hoursRemaining?: number;
}

export interface BudgetPolicyStats {
  totalPolicies: number;
  activePolicies: number;
  totalBurnRateAlerts: number;
  totalThrottleEvents: number;
  policies: Array<{
    policyId: string;
    name: string;
    dailyUtilization: number;
    monthlyUtilization: number;
    currentBurnRate: number;
    isThrottled: boolean;
  }>;
}

export type BudgetPolicyCreateParams = Omit<BudgetPolicy, 'policyId' | 'createdAt' | 'updatedAt'>;

// ─── Default values ─────────────────────────────────────────────────────────

function generatePolicyId(): string {
  return 'bpol_' + crypto.randomBytes(8).toString('hex');
}

function nextDayStart(): number {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}

function nextMonthStart(): number {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}

// ─── BudgetPolicyEngine Class ───────────────────────────────────────────────

export class BudgetPolicyEngine {
  private policies = new Map<string, BudgetPolicy>();
  private state = new Map<string, BudgetState>();

  /**
   * Create a new budget policy.
   */
  createPolicy(params: BudgetPolicyCreateParams): BudgetPolicy {
    const policyId = generatePolicyId();
    const now = Date.now();
    const policy: BudgetPolicy = {
      policyId,
      name: params.name,
      targetNamespace: params.targetNamespace,
      targetApiKey: params.targetApiKey,
      burnRateThreshold: params.burnRateThreshold ?? 100,
      burnRateWindowSec: params.burnRateWindowSec ?? 60,
      dailyBudget: params.dailyBudget ?? 0,
      monthlyBudget: params.monthlyBudget ?? 0,
      onBurnRateExceeded: params.onBurnRateExceeded ?? 'alert',
      throttleReductionPercent: params.throttleReductionPercent ?? 50,
      throttleCooldownSec: params.throttleCooldownSec ?? 300,
      active: params.active ?? true,
      createdAt: now,
      updatedAt: now,
    };

    this.policies.set(policyId, policy);
    this.state.set(policyId, {
      policyId,
      windowSpend: [],
      isThrottled: false,
      throttledUntil: 0,
      dailySpent: 0,
      monthlySpent: 0,
      dailyResetAt: nextDayStart(),
      monthlyResetAt: nextMonthStart(),
      burnRateAlerts: 0,
      throttleEvents: 0,
    });

    return { ...policy };
  }

  /**
   * Get a policy by ID.
   */
  getPolicy(policyId: string): BudgetPolicy | undefined {
    const p = this.policies.get(policyId);
    return p ? { ...p } : undefined;
  }

  /**
   * List all policies.
   */
  listPolicies(): BudgetPolicy[] {
    return Array.from(this.policies.values()).map(p => ({ ...p }));
  }

  /**
   * Delete a policy.
   */
  deletePolicy(policyId: string): boolean {
    this.state.delete(policyId);
    return this.policies.delete(policyId);
  }

  /**
   * Record spending and check against budget policies.
   * Returns the most restrictive result from all applicable policies.
   */
  recordSpend(namespace: string | undefined, apiKey: string | undefined, credits: number): BudgetCheckResult {
    const applicablePolicies = this.findApplicable(namespace, apiKey);
    if (applicablePolicies.length === 0) {
      return { allowed: true, burnRateExceeded: false, isThrottled: false, currentBurnRate: 0 };
    }

    let mostRestrictive: BudgetCheckResult = {
      allowed: true,
      burnRateExceeded: false,
      isThrottled: false,
      currentBurnRate: 0,
    };

    for (const policy of applicablePolicies) {
      const result = this.checkPolicy(policy, credits);
      if (!result.allowed) {
        mostRestrictive = result;
        break;
      }
      if (result.burnRateExceeded) mostRestrictive.burnRateExceeded = true;
      if (result.isThrottled) mostRestrictive.isThrottled = true;
      if (result.currentBurnRate > mostRestrictive.currentBurnRate) {
        mostRestrictive.currentBurnRate = result.currentBurnRate;
      }
      if (result.dailyRemaining !== undefined) {
        mostRestrictive.dailyRemaining = Math.min(mostRestrictive.dailyRemaining ?? Infinity, result.dailyRemaining);
      }
      if (result.monthlyRemaining !== undefined) {
        mostRestrictive.monthlyRemaining = Math.min(mostRestrictive.monthlyRemaining ?? Infinity, result.monthlyRemaining);
      }
      if (result.hoursRemaining !== undefined) {
        mostRestrictive.hoursRemaining = Math.min(mostRestrictive.hoursRemaining ?? Infinity, result.hoursRemaining);
      }
    }

    return mostRestrictive;
  }

  /**
   * Get stats across all policies.
   */
  stats(): BudgetPolicyStats {
    let totalAlerts = 0;
    let totalThrottles = 0;
    const policyStats: BudgetPolicyStats['policies'] = [];

    for (const policy of this.policies.values()) {
      const st = this.state.get(policy.policyId);
      if (!st) continue;
      this.resetIfNeeded(st);
      totalAlerts += st.burnRateAlerts;
      totalThrottles += st.throttleEvents;

      const burnRate = this.computeBurnRate(st, policy);
      policyStats.push({
        policyId: policy.policyId,
        name: policy.name,
        dailyUtilization: policy.dailyBudget > 0 ? Math.round((st.dailySpent / policy.dailyBudget) * 100) : 0,
        monthlyUtilization: policy.monthlyBudget > 0 ? Math.round((st.monthlySpent / policy.monthlyBudget) * 100) : 0,
        currentBurnRate: burnRate,
        isThrottled: st.isThrottled && st.throttledUntil > Date.now(),
      });
    }

    return {
      totalPolicies: this.policies.size,
      activePolicies: Array.from(this.policies.values()).filter(p => p.active).length,
      totalBurnRateAlerts: totalAlerts,
      totalThrottleEvents: totalThrottles,
      policies: policyStats,
    };
  }

  /**
   * Clear all policies and state.
   */
  clear(): void {
    this.policies.clear();
    this.state.clear();
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private findApplicable(namespace?: string, apiKey?: string): BudgetPolicy[] {
    const results: BudgetPolicy[] = [];
    for (const policy of this.policies.values()) {
      if (!policy.active) continue;
      // Check targeting: most specific match wins
      if (policy.targetApiKey && policy.targetApiKey !== apiKey) continue;
      if (policy.targetNamespace && policy.targetNamespace !== namespace) continue;
      results.push(policy);
    }
    return results;
  }

  private checkPolicy(policy: BudgetPolicy, credits: number): BudgetCheckResult {
    const st = this.state.get(policy.policyId)!;
    this.resetIfNeeded(st);
    const now = Date.now();

    // Record spend
    st.dailySpent += credits;
    st.monthlySpent += credits;
    st.windowSpend.push({ time: now, credits });

    // Prune old window entries
    const windowCutoff = now - (policy.burnRateWindowSec * 1000);
    st.windowSpend = st.windowSpend.filter(e => e.time >= windowCutoff);

    // Compute burn rate (credits/minute)
    const burnRate = this.computeBurnRate(st, policy);
    const burnRateExceeded = burnRate > policy.burnRateThreshold;

    // Check daily budget
    if (policy.dailyBudget > 0 && st.dailySpent > policy.dailyBudget) {
      return {
        allowed: false,
        reason: 'daily-budget-exceeded',
        burnRateExceeded,
        isThrottled: false,
        dailyRemaining: 0,
        monthlyRemaining: policy.monthlyBudget > 0 ? Math.max(0, policy.monthlyBudget - st.monthlySpent) : undefined,
        currentBurnRate: burnRate,
      };
    }

    // Check monthly budget
    if (policy.monthlyBudget > 0 && st.monthlySpent > policy.monthlyBudget) {
      return {
        allowed: false,
        reason: 'monthly-budget-exceeded',
        burnRateExceeded,
        isThrottled: false,
        dailyRemaining: policy.dailyBudget > 0 ? Math.max(0, policy.dailyBudget - st.dailySpent) : undefined,
        monthlyRemaining: 0,
        currentBurnRate: burnRate,
      };
    }

    // Handle burn rate exceedance
    if (burnRateExceeded) {
      st.burnRateAlerts++;
      if (policy.onBurnRateExceeded === 'deny') {
        return {
          allowed: false,
          reason: 'burn-rate-exceeded',
          burnRateExceeded: true,
          isThrottled: false,
          currentBurnRate: burnRate,
        };
      }
      if (policy.onBurnRateExceeded === 'throttle' && !st.isThrottled) {
        st.isThrottled = true;
        st.throttledUntil = now + (policy.throttleCooldownSec * 1000);
        st.throttleEvents++;
      }
    }

    // Check if throttle expired
    if (st.isThrottled && now > st.throttledUntil) {
      st.isThrottled = false;
    }

    // Compute remaining
    const dailyRemaining = policy.dailyBudget > 0 ? Math.max(0, policy.dailyBudget - st.dailySpent) : undefined;
    const monthlyRemaining = policy.monthlyBudget > 0 ? Math.max(0, policy.monthlyBudget - st.monthlySpent) : undefined;
    const remaining = dailyRemaining !== undefined ? dailyRemaining : monthlyRemaining;
    const hoursRemaining = remaining !== undefined && burnRate > 0
      ? Math.round((remaining / burnRate) * 60) / 60 // convert from minutes
      : undefined;

    return {
      allowed: true,
      burnRateExceeded,
      isThrottled: st.isThrottled,
      dailyRemaining,
      monthlyRemaining,
      currentBurnRate: burnRate,
      hoursRemaining,
    };
  }

  private computeBurnRate(st: BudgetState, policy: BudgetPolicy): number {
    const now = Date.now();
    const windowCutoff = now - (policy.burnRateWindowSec * 1000);
    const windowCredits = st.windowSpend
      .filter(e => e.time >= windowCutoff)
      .reduce((sum, e) => sum + e.credits, 0);
    // Credits per minute
    return (windowCredits / policy.burnRateWindowSec) * 60;
  }

  private resetIfNeeded(st: BudgetState): void {
    const now = Date.now();
    if (now >= st.dailyResetAt) {
      st.dailySpent = 0;
      st.dailyResetAt = nextDayStart();
    }
    if (now >= st.monthlyResetAt) {
      st.monthlySpent = 0;
      st.monthlyResetAt = nextMonthStart();
    }
  }
}
