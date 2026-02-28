/**
 * FeatureFlagManager — Toggle features per key with rollouts and scheduling.
 *
 * Control feature visibility per API key with percentage-based rollouts,
 * A/B groups, and time-based scheduling. Useful for gradual feature
 * launches, beta testing, and kill switches.
 *
 * @example
 * ```ts
 * const flags = new FeatureFlagManager();
 *
 * flags.createFlag({
 *   name: 'new_search_v2',
 *   rolloutPercent: 50,    // 50% of keys get this
 *   enabledKeys: ['key_beta'],
 * });
 *
 * flags.isEnabled('new_search_v2', 'key_abc'); // depends on hash
 * flags.isEnabled('new_search_v2', 'key_beta'); // always true
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface FeatureFlag {
  name: string;
  description?: string;
  /** Global enable/disable. If false, flag is off for everyone. */
  enabled: boolean;
  /** Percentage of keys that get this feature (0-100). */
  rolloutPercent: number;
  /** Keys that always have this feature, regardless of rollout. */
  enabledKeys: Set<string>;
  /** Keys that never have this feature, regardless of rollout. */
  disabledKeys: Set<string>;
  /** A/B group name. Keys are consistently assigned to the same group. */
  group?: string;
  /** Schedule: only active between these times (ISO strings). */
  activeFrom?: number;
  activeUntil?: number;
  createdAt: number;
  updatedAt: number;
}

export interface FlagCreateParams {
  name: string;
  description?: string;
  enabled?: boolean;
  rolloutPercent?: number;
  enabledKeys?: string[];
  disabledKeys?: string[];
  group?: string;
  activeFrom?: string;
  activeUntil?: string;
}

export interface FlagEvaluation {
  flag: string;
  key: string;
  enabled: boolean;
  reason: 'flag_disabled' | 'key_allowlist' | 'key_blocklist' | 'schedule_inactive' | 'rollout_included' | 'rollout_excluded' | 'flag_not_found';
}

export interface FeatureFlagConfig {
  /** Default rollout percent for new flags. Default 100 (enabled for all). */
  defaultRolloutPercent?: number;
}

export interface FeatureFlagStats {
  totalFlags: number;
  enabledFlags: number;
  disabledFlags: number;
  totalEvaluations: number;
  totalEnabled: number;
  totalDisabled: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class FeatureFlagManager {
  private flags = new Map<string, FeatureFlag>();
  private defaultRolloutPercent: number;

  // Stats
  private totalEvaluations = 0;
  private totalEnabled = 0;
  private totalDisabled = 0;

  constructor(config: FeatureFlagConfig = {}) {
    this.defaultRolloutPercent = config.defaultRolloutPercent ?? 100;
  }

  // ── Flag Management ───────────────────────────────────────────────

  /** Create a new feature flag. */
  createFlag(params: FlagCreateParams): FeatureFlag {
    if (this.flags.has(params.name)) {
      throw new Error(`Flag already exists: ${params.name}`);
    }

    const now = Date.now();
    const flag: FeatureFlag = {
      name: params.name,
      description: params.description,
      enabled: params.enabled ?? true,
      rolloutPercent: Math.min(100, Math.max(0, params.rolloutPercent ?? this.defaultRolloutPercent)),
      enabledKeys: new Set(params.enabledKeys ?? []),
      disabledKeys: new Set(params.disabledKeys ?? []),
      group: params.group,
      activeFrom: params.activeFrom ? new Date(params.activeFrom).getTime() : undefined,
      activeUntil: params.activeUntil ? new Date(params.activeUntil).getTime() : undefined,
      createdAt: now,
      updatedAt: now,
    };

    this.flags.set(params.name, flag);
    return flag;
  }

  /** Remove a flag. */
  removeFlag(name: string): boolean {
    return this.flags.delete(name);
  }

  /** Get a flag definition. */
  getFlag(name: string): FeatureFlag | null {
    return this.flags.get(name) ?? null;
  }

  /** List all flags. */
  listFlags(): FeatureFlag[] {
    return [...this.flags.values()];
  }

  /** Enable or disable a flag globally. */
  setEnabled(name: string, enabled: boolean): boolean {
    const flag = this.flags.get(name);
    if (!flag) return false;
    flag.enabled = enabled;
    flag.updatedAt = Date.now();
    return true;
  }

  /** Update rollout percentage. */
  setRolloutPercent(name: string, percent: number): boolean {
    const flag = this.flags.get(name);
    if (!flag) return false;
    flag.rolloutPercent = Math.min(100, Math.max(0, percent));
    flag.updatedAt = Date.now();
    return true;
  }

  /** Add a key to the allowlist. */
  addToAllowlist(name: string, key: string): boolean {
    const flag = this.flags.get(name);
    if (!flag) return false;
    flag.enabledKeys.add(key);
    flag.disabledKeys.delete(key);
    flag.updatedAt = Date.now();
    return true;
  }

  /** Add a key to the blocklist. */
  addToBlocklist(name: string, key: string): boolean {
    const flag = this.flags.get(name);
    if (!flag) return false;
    flag.disabledKeys.add(key);
    flag.enabledKeys.delete(key);
    flag.updatedAt = Date.now();
    return true;
  }

  /** Remove a key from both lists. */
  removeFromLists(name: string, key: string): boolean {
    const flag = this.flags.get(name);
    if (!flag) return false;
    flag.enabledKeys.delete(key);
    flag.disabledKeys.delete(key);
    flag.updatedAt = Date.now();
    return true;
  }

  /** Set schedule window. */
  setSchedule(name: string, activeFrom?: string, activeUntil?: string): boolean {
    const flag = this.flags.get(name);
    if (!flag) return false;
    flag.activeFrom = activeFrom ? new Date(activeFrom).getTime() : undefined;
    flag.activeUntil = activeUntil ? new Date(activeUntil).getTime() : undefined;
    flag.updatedAt = Date.now();
    return true;
  }

  // ── Evaluation ────────────────────────────────────────────────────

  /** Check if a flag is enabled for a specific key. */
  isEnabled(name: string, key: string): boolean {
    return this.evaluate(name, key).enabled;
  }

  /** Evaluate a flag for a key with full details. */
  evaluate(name: string, key: string): FlagEvaluation {
    this.totalEvaluations++;

    const flag = this.flags.get(name);
    if (!flag) {
      this.totalDisabled++;
      return { flag: name, key, enabled: false, reason: 'flag_not_found' };
    }

    // Global disable
    if (!flag.enabled) {
      this.totalDisabled++;
      return { flag: name, key, enabled: false, reason: 'flag_disabled' };
    }

    // Blocklist takes precedence
    if (flag.disabledKeys.has(key)) {
      this.totalDisabled++;
      return { flag: name, key, enabled: false, reason: 'key_blocklist' };
    }

    // Allowlist
    if (flag.enabledKeys.has(key)) {
      this.totalEnabled++;
      return { flag: name, key, enabled: true, reason: 'key_allowlist' };
    }

    // Schedule check
    const now = Date.now();
    if (flag.activeFrom && now < flag.activeFrom) {
      this.totalDisabled++;
      return { flag: name, key, enabled: false, reason: 'schedule_inactive' };
    }
    if (flag.activeUntil && now > flag.activeUntil) {
      this.totalDisabled++;
      return { flag: name, key, enabled: false, reason: 'schedule_inactive' };
    }

    // Rollout: deterministic hash-based assignment
    const hash = this.hashKey(key, flag.group ?? name);
    const bucket = hash % 100;
    if (bucket < flag.rolloutPercent) {
      this.totalEnabled++;
      return { flag: name, key, enabled: true, reason: 'rollout_included' };
    }

    this.totalDisabled++;
    return { flag: name, key, enabled: false, reason: 'rollout_excluded' };
  }

  /** Evaluate all flags for a key. Returns map of flag name → enabled. */
  evaluateAll(key: string): Map<string, boolean> {
    const result = new Map<string, boolean>();
    for (const flag of this.flags.values()) {
      result.set(flag.name, this.isEnabled(flag.name, key));
    }
    return result;
  }

  /** Get all keys that would have a flag enabled (from allowlist + rollout sampling). */
  getEnabledKeys(name: string, sampleKeys: string[]): string[] {
    return sampleKeys.filter(key => this.isEnabled(name, key));
  }

  // ── Stats ─────────────────────────────────────────────────────────

  getStats(): FeatureFlagStats {
    let enabled = 0, disabled = 0;
    for (const flag of this.flags.values()) {
      if (flag.enabled) enabled++;
      else disabled++;
    }
    return {
      totalFlags: this.flags.size,
      enabledFlags: enabled,
      disabledFlags: disabled,
      totalEvaluations: this.totalEvaluations,
      totalEnabled: this.totalEnabled,
      totalDisabled: this.totalDisabled,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.flags.clear();
    this.totalEvaluations = 0;
    this.totalEnabled = 0;
    this.totalDisabled = 0;
  }

  // ── Private ───────────────────────────────────────────────────────

  /** Simple deterministic hash for consistent rollout bucketing. */
  private hashKey(key: string, salt: string): number {
    const str = `${key}:${salt}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }
}
