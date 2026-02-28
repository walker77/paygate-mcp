/**
 * DataRetentionManager — Lifecycle policies for automatic data aging and purging.
 *
 * Define retention policies for different data categories, register data stores,
 * run enforcement sweeps that purge expired data, and track purge history.
 *
 * @example
 * ```ts
 * const mgr = new DataRetentionManager();
 *
 * mgr.addPolicy({
 *   name: 'usage_logs',
 *   category: 'logs',
 *   retentionDays: 90,
 *   action: 'delete',
 * });
 *
 * mgr.registerStore('usage_logs', {
 *   count: () => store.length,
 *   purge: (before) => { store = store.filter(r => r.ts >= before); return deleted; },
 * });
 *
 * const result = mgr.enforce(); // purge data older than 90 days
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type RetentionAction = 'delete' | 'archive' | 'anonymize';

export interface RetentionPolicy {
  id: string;
  name: string;
  category: string;
  retentionDays: number;
  action: RetentionAction;
  enabled: boolean;
  priority: number;
  createdAt: number;
}

export interface PolicyCreateParams {
  name: string;
  category: string;
  retentionDays: number;
  action?: RetentionAction;
  enabled?: boolean;
  priority?: number;
}

export interface DataStore {
  /** Get current record count. */
  count: () => number;
  /** Purge records older than timestamp. Returns count purged. */
  purge: (beforeTimestamp: number) => number;
}

export interface PurgeRecord {
  id: string;
  policyName: string;
  category: string;
  action: RetentionAction;
  purgedCount: number;
  cutoffTimestamp: number;
  timestamp: number;
  durationMs: number;
}

export interface EnforceResult {
  policiesEvaluated: number;
  policiesTriggered: number;
  totalPurged: number;
  purgeRecords: PurgeRecord[];
  durationMs: number;
}

export interface RetentionStatus {
  policyName: string;
  category: string;
  retentionDays: number;
  action: RetentionAction;
  enabled: boolean;
  currentCount: number;
  cutoffDate: string;
  lastPurge: PurgeRecord | null;
}

export interface DataRetentionConfig {
  /** Max policies. Default 50. */
  maxPolicies?: number;
  /** Max purge history entries. Default 1000. */
  maxHistory?: number;
}

export interface DataRetentionStats {
  totalPolicies: number;
  enabledPolicies: number;
  totalStores: number;
  totalPurgeRecords: number;
  totalPurged: number;
  lastEnforcement: number | null;
}

// ── Implementation ───────────────────────────────────────────────────

export class DataRetentionManager {
  private policies = new Map<string, RetentionPolicy>();
  private stores = new Map<string, DataStore>(); // policy name → store
  private purgeHistory: PurgeRecord[] = [];
  private nextPolicyId = 1;
  private nextPurgeId = 1;

  private maxPolicies: number;
  private maxHistory: number;

  // Stats
  private totalPurgedCount = 0;
  private lastEnforcement: number | null = null;

  constructor(config: DataRetentionConfig = {}) {
    this.maxPolicies = config.maxPolicies ?? 50;
    this.maxHistory = config.maxHistory ?? 1_000;
  }

  // ── Policy Management ──────────────────────────────────────────

  /** Add a retention policy. */
  addPolicy(params: PolicyCreateParams): RetentionPolicy {
    if (!params.name) throw new Error('Policy name is required');
    if (!params.category) throw new Error('Category is required');
    if (params.retentionDays <= 0) throw new Error('Retention days must be positive');
    if (this.getPolicyByName(params.name)) {
      throw new Error(`Policy '${params.name}' already exists`);
    }
    if (this.policies.size >= this.maxPolicies) {
      throw new Error(`Maximum ${this.maxPolicies} policies reached`);
    }

    const policy: RetentionPolicy = {
      id: `ret_${this.nextPolicyId++}`,
      name: params.name,
      category: params.category,
      retentionDays: params.retentionDays,
      action: params.action ?? 'delete',
      enabled: params.enabled ?? true,
      priority: params.priority ?? 0,
      createdAt: Date.now(),
    };

    this.policies.set(policy.id, policy);
    return policy;
  }

  /** Get policy by name. */
  getPolicyByName(name: string): RetentionPolicy | null {
    for (const p of this.policies.values()) {
      if (p.name === name) return p;
    }
    return null;
  }

  /** Get policy by ID. */
  getPolicy(id: string): RetentionPolicy | null {
    return this.policies.get(id) ?? null;
  }

  /** List all policies. */
  listPolicies(): RetentionPolicy[] {
    return [...this.policies.values()].sort((a, b) => b.priority - a.priority);
  }

  /** Remove a policy. */
  removePolicy(name: string): boolean {
    const policy = this.getPolicyByName(name);
    if (!policy) return false;
    this.policies.delete(policy.id);
    this.stores.delete(name);
    return true;
  }

  /** Enable/disable a policy. */
  setPolicyEnabled(name: string, enabled: boolean): void {
    const policy = this.getPolicyByName(name);
    if (!policy) throw new Error(`Policy '${name}' not found`);
    policy.enabled = enabled;
  }

  /** Update retention days for a policy. */
  setRetentionDays(name: string, days: number): void {
    if (days <= 0) throw new Error('Retention days must be positive');
    const policy = this.getPolicyByName(name);
    if (!policy) throw new Error(`Policy '${name}' not found`);
    policy.retentionDays = days;
  }

  // ── Store Registration ─────────────────────────────────────────

  /** Register a data store for a policy. */
  registerStore(policyName: string, store: DataStore): void {
    if (!this.getPolicyByName(policyName)) {
      throw new Error(`Policy '${policyName}' not found`);
    }
    this.stores.set(policyName, store);
  }

  /** Unregister a data store. */
  unregisterStore(policyName: string): boolean {
    return this.stores.delete(policyName);
  }

  // ── Enforcement ────────────────────────────────────────────────

  /** Enforce all enabled policies. Purge expired data from registered stores. */
  enforce(): EnforceResult {
    const start = Date.now();
    const result: EnforceResult = {
      policiesEvaluated: 0,
      policiesTriggered: 0,
      totalPurged: 0,
      purgeRecords: [],
      durationMs: 0,
    };

    const sortedPolicies = this.listPolicies();

    for (const policy of sortedPolicies) {
      if (!policy.enabled) continue;
      result.policiesEvaluated++;

      const store = this.stores.get(policy.name);
      if (!store) continue;

      const cutoff = Date.now() - (policy.retentionDays * 24 * 60 * 60 * 1000);
      const purgeStart = Date.now();

      try {
        const purged = store.purge(cutoff);
        if (purged > 0) {
          result.policiesTriggered++;
          result.totalPurged += purged;
          this.totalPurgedCount += purged;

          const record: PurgeRecord = {
            id: `purge_${this.nextPurgeId++}`,
            policyName: policy.name,
            category: policy.category,
            action: policy.action,
            purgedCount: purged,
            cutoffTimestamp: cutoff,
            timestamp: Date.now(),
            durationMs: Date.now() - purgeStart,
          };

          result.purgeRecords.push(record);
          this.addToHistory(record);
        }
      } catch (_err) {
        // Store purge errors are silently skipped
      }
    }

    result.durationMs = Date.now() - start;
    this.lastEnforcement = Date.now();
    return result;
  }

  // ── Status ─────────────────────────────────────────────────────

  /** Get status for all policies. */
  getStatus(): RetentionStatus[] {
    const statuses: RetentionStatus[] = [];

    for (const policy of this.listPolicies()) {
      const store = this.stores.get(policy.name);
      const cutoff = new Date(Date.now() - (policy.retentionDays * 24 * 60 * 60 * 1000));

      const lastPurge = this.purgeHistory
        .filter(r => r.policyName === policy.name)
        .sort((a, b) => b.timestamp - a.timestamp)[0] ?? null;

      statuses.push({
        policyName: policy.name,
        category: policy.category,
        retentionDays: policy.retentionDays,
        action: policy.action,
        enabled: policy.enabled,
        currentCount: store ? store.count() : 0,
        cutoffDate: cutoff.toISOString(),
        lastPurge,
      });
    }

    return statuses;
  }

  /** Get purge history. */
  getPurgeHistory(limit?: number): PurgeRecord[] {
    const l = limit ?? 100;
    return this.purgeHistory.slice(-l);
  }

  // ── Stats ───────────────────────────────────────────────────────

  getStats(): DataRetentionStats {
    let enabled = 0;
    for (const p of this.policies.values()) {
      if (p.enabled) enabled++;
    }

    return {
      totalPolicies: this.policies.size,
      enabledPolicies: enabled,
      totalStores: this.stores.size,
      totalPurgeRecords: this.purgeHistory.length,
      totalPurged: this.totalPurgedCount,
      lastEnforcement: this.lastEnforcement,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.policies.clear();
    this.stores.clear();
    this.purgeHistory = [];
    this.totalPurgedCount = 0;
    this.lastEnforcement = null;
  }

  // ── Private ─────────────────────────────────────────────────────

  private addToHistory(record: PurgeRecord): void {
    this.purgeHistory.push(record);
    if (this.purgeHistory.length > this.maxHistory) {
      this.purgeHistory.splice(0, this.purgeHistory.length - this.maxHistory);
    }
  }
}
