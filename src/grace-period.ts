/**
 * GracePeriodManager — Grace periods for key expiry, quota overages, and payment failures.
 *
 * Define grace period policies, apply them to keys, and check
 * whether a key is within its grace period before hard enforcement.
 *
 * @example
 * ```ts
 * const mgr = new GracePeriodManager();
 *
 * mgr.definePolicy({
 *   name: 'payment_failure',
 *   durationMs: 7 * 24 * 60 * 60 * 1000, // 7 days
 *   reason: 'Payment failed',
 *   maxExtensions: 1,
 * });
 *
 * mgr.startGracePeriod('key_abc', 'payment_failure');
 *
 * const check = mgr.check('key_abc');
 * // { inGracePeriod: true, expiresAt: ..., remaining: ... }
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface GracePolicy {
  id: string;
  name: string;
  durationMs: number;
  reason: string;
  maxExtensions: number;
}

export interface PolicyDefineParams {
  name: string;
  durationMs: number;
  reason?: string;
  maxExtensions?: number;
}

export interface GracePeriod {
  id: string;
  key: string;
  policyId: string;
  policyName: string;
  reason: string;
  startedAt: number;
  expiresAt: number;
  extensions: number;
  maxExtensions: number;
  active: boolean;
  expiredAt: number | null;
  cancelledAt: number | null;
}

export interface GraceCheckResult {
  inGracePeriod: boolean;
  gracePeriod: GracePeriod | null;
  remainingMs: number;
  expired: boolean;
}

export interface GracePeriodConfig {
  /** Max active grace periods. Default 10000. */
  maxActivePeriods?: number;
  /** Max policies. Default 100. */
  maxPolicies?: number;
}

export interface GracePeriodStats {
  totalPolicies: number;
  activePeriods: number;
  expiredPeriods: number;
  cancelledPeriods: number;
  totalStarted: number;
  totalExpired: number;
  totalCancelled: number;
  totalExtended: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class GracePeriodManager {
  private policies = new Map<string, GracePolicy>();
  private periods = new Map<string, GracePeriod>();
  private keyPeriods = new Map<string, string>(); // key → periodId
  private nextPolicyId = 1;
  private nextPeriodId = 1;

  private maxActivePeriods: number;
  private maxPolicies: number;

  // Stats
  private totalStarted = 0;
  private totalExpired = 0;
  private totalCancelled = 0;
  private totalExtended = 0;

  constructor(config: GracePeriodConfig = {}) {
    this.maxActivePeriods = config.maxActivePeriods ?? 10_000;
    this.maxPolicies = config.maxPolicies ?? 100;
  }

  // ── Policy Management ──────────────────────────────────────────

  /** Define a grace period policy. */
  definePolicy(params: PolicyDefineParams): GracePolicy {
    if (!params.name) throw new Error('Policy name is required');
    if (params.durationMs <= 0) throw new Error('Duration must be positive');
    if (this.policies.size >= this.maxPolicies) {
      throw new Error(`Maximum ${this.maxPolicies} policies reached`);
    }

    // Check for duplicate names
    for (const p of this.policies.values()) {
      if (p.name === params.name) throw new Error(`Policy '${params.name}' already exists`);
    }

    const policy: GracePolicy = {
      id: `gp_${this.nextPolicyId++}`,
      name: params.name,
      durationMs: params.durationMs,
      reason: params.reason ?? '',
      maxExtensions: params.maxExtensions ?? 0,
    };

    this.policies.set(policy.id, policy);
    return policy;
  }

  /** Get a policy by ID or name. */
  getPolicy(idOrName: string): GracePolicy | null {
    const byId = this.policies.get(idOrName);
    if (byId) return byId;
    for (const p of this.policies.values()) {
      if (p.name === idOrName) return p;
    }
    return null;
  }

  /** List all policies. */
  listPolicies(): GracePolicy[] {
    return [...this.policies.values()];
  }

  /** Remove a policy. */
  removePolicy(id: string): boolean {
    return this.policies.delete(id);
  }

  // ── Grace Period Lifecycle ─────────────────────────────────────

  /** Start a grace period for a key. */
  startGracePeriod(key: string, policyIdOrName: string): GracePeriod {
    if (!key) throw new Error('Key is required');

    const policy = this.getPolicy(policyIdOrName);
    if (!policy) throw new Error(`Policy '${policyIdOrName}' not found`);

    // Check if key already has an active grace period
    const existingId = this.keyPeriods.get(key);
    if (existingId) {
      const existing = this.periods.get(existingId);
      if (existing && existing.active) {
        throw new Error(`Key '${key}' already has an active grace period`);
      }
    }

    if (this.getActivePeriodCount() >= this.maxActivePeriods) {
      throw new Error(`Maximum ${this.maxActivePeriods} active periods reached`);
    }

    const now = Date.now();
    const period: GracePeriod = {
      id: `gpr_${this.nextPeriodId++}`,
      key,
      policyId: policy.id,
      policyName: policy.name,
      reason: policy.reason,
      startedAt: now,
      expiresAt: now + policy.durationMs,
      extensions: 0,
      maxExtensions: policy.maxExtensions,
      active: true,
      expiredAt: null,
      cancelledAt: null,
    };

    this.periods.set(period.id, period);
    this.keyPeriods.set(key, period.id);
    this.totalStarted++;
    return period;
  }

  /** Check a key's grace period status. */
  check(key: string): GraceCheckResult {
    const periodId = this.keyPeriods.get(key);
    if (!periodId) {
      return { inGracePeriod: false, gracePeriod: null, remainingMs: 0, expired: false };
    }

    const period = this.periods.get(periodId);
    if (!period || !period.active) {
      return { inGracePeriod: false, gracePeriod: period ?? null, remainingMs: 0, expired: !!period };
    }

    const now = Date.now();
    if (now >= period.expiresAt) {
      // Grace period expired
      period.active = false;
      period.expiredAt = now;
      this.totalExpired++;
      return { inGracePeriod: false, gracePeriod: period, remainingMs: 0, expired: true };
    }

    return {
      inGracePeriod: true,
      gracePeriod: period,
      remainingMs: period.expiresAt - now,
      expired: false,
    };
  }

  /** Extend a key's grace period. */
  extend(key: string, additionalMs?: number): GracePeriod {
    const periodId = this.keyPeriods.get(key);
    if (!periodId) throw new Error(`No grace period for key '${key}'`);

    const period = this.periods.get(periodId);
    if (!period) throw new Error(`Grace period not found`);
    if (!period.active) throw new Error(`Grace period for key '${key}' is not active`);
    if (period.extensions >= period.maxExtensions) {
      throw new Error(`Maximum extensions (${period.maxExtensions}) reached for key '${key}'`);
    }

    const policy = this.policies.get(period.policyId);
    const extensionMs = additionalMs ?? policy?.durationMs ?? period.expiresAt - period.startedAt;
    period.expiresAt += extensionMs;
    period.extensions++;
    this.totalExtended++;
    return period;
  }

  /** Cancel a key's grace period. */
  cancel(key: string): GracePeriod {
    const periodId = this.keyPeriods.get(key);
    if (!periodId) throw new Error(`No grace period for key '${key}'`);

    const period = this.periods.get(periodId);
    if (!period) throw new Error(`Grace period not found`);
    if (!period.active) throw new Error(`Grace period for key '${key}' is not active`);

    period.active = false;
    period.cancelledAt = Date.now();
    this.totalCancelled++;
    return period;
  }

  // ── Query ──────────────────────────────────────────────────────

  /** Get a grace period by key. */
  getByKey(key: string): GracePeriod | null {
    const id = this.keyPeriods.get(key);
    return id ? (this.periods.get(id) ?? null) : null;
  }

  /** List all active grace periods. */
  listActive(): GracePeriod[] {
    return [...this.periods.values()].filter(p => p.active && Date.now() < p.expiresAt);
  }

  /** List expiring grace periods (within given ms). */
  listExpiring(withinMs: number): GracePeriod[] {
    const deadline = Date.now() + withinMs;
    return [...this.periods.values()]
      .filter(p => p.active && p.expiresAt <= deadline && p.expiresAt > Date.now())
      .sort((a, b) => a.expiresAt - b.expiresAt);
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): GracePeriodStats {
    let active = 0, expired = 0, cancelled = 0;
    const now = Date.now();
    for (const p of this.periods.values()) {
      if (p.active && now < p.expiresAt) active++;
      else if (p.expiredAt) expired++;
      else if (p.cancelledAt) cancelled++;
    }

    return {
      totalPolicies: this.policies.size,
      activePeriods: active,
      expiredPeriods: expired,
      cancelledPeriods: cancelled,
      totalStarted: this.totalStarted,
      totalExpired: this.totalExpired,
      totalCancelled: this.totalCancelled,
      totalExtended: this.totalExtended,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.policies.clear();
    this.periods.clear();
    this.keyPeriods.clear();
    this.totalStarted = 0;
    this.totalExpired = 0;
    this.totalCancelled = 0;
    this.totalExtended = 0;
  }

  // ── Private ───────────────────────────────────────────────────

  private getActivePeriodCount(): number {
    let count = 0;
    const now = Date.now();
    for (const p of this.periods.values()) {
      if (p.active && now < p.expiresAt) count++;
    }
    return count;
  }
}
