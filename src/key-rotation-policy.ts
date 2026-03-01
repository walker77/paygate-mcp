/**
 * APIKeyRotationPolicy — Policy-driven key rotation management.
 *
 * Define rotation policies (e.g., every 90 days), track key ages,
 * identify keys due for rotation, and manage grace periods
 * during rotation transitions.
 *
 * @example
 * ```ts
 * const rotator = new APIKeyRotationPolicy();
 *
 * rotator.definePolicy({ name: 'standard', rotationIntervalMs: 90 * 24 * 60 * 60 * 1000 });
 * rotator.registerKey('key_abc', 'standard');
 *
 * const due = rotator.getKeysDueForRotation();
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface RotationPolicy {
  id: string;
  name: string;
  rotationIntervalMs: number;
  gracePeriodMs: number;
  warnBeforeMs: number;
  createdAt: number;
}

export interface RotationPolicyParams {
  name: string;
  rotationIntervalMs: number;
  gracePeriodMs?: number;
  warnBeforeMs?: number;
}

export type KeyRotationStatus = 'current' | 'due' | 'overdue' | 'grace_period';

export interface ManagedKey {
  key: string;
  policyId: string;
  registeredAt: number;
  lastRotatedAt: number;
  rotationCount: number;
  status: KeyRotationStatus;
  nextRotationAt: number;
  graceExpiresAt: number | null;
}

export interface RotationEvent {
  id: string;
  key: string;
  oldKey: string | null;
  rotatedAt: number;
  policyId: string;
}

export interface KeyRotationPolicyConfig {
  /** Max policies. Default 50. */
  maxPolicies?: number;
  /** Max tracked keys. Default 10000. */
  maxKeys?: number;
}

export interface KeyRotationPolicyStats {
  totalPolicies: number;
  totalManagedKeys: number;
  keysDue: number;
  keysOverdue: number;
  keysInGrace: number;
  totalRotations: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class APIKeyRotationPolicy {
  private policies = new Map<string, RotationPolicy>();
  private keys = new Map<string, ManagedKey>();
  private events: RotationEvent[] = [];
  private nextPolicyId = 1;
  private nextEventId = 1;
  private maxPolicies: number;
  private maxKeys: number;

  constructor(config: KeyRotationPolicyConfig = {}) {
    this.maxPolicies = config.maxPolicies ?? 50;
    this.maxKeys = config.maxKeys ?? 10_000;
  }

  // ── Policy Management ──────────────────────────────────────────

  /** Define a rotation policy. */
  definePolicy(params: RotationPolicyParams): RotationPolicy {
    if (!params.name) throw new Error('Policy name is required');
    if (params.rotationIntervalMs <= 0) throw new Error('Rotation interval must be positive');
    if (this.policies.size >= this.maxPolicies) {
      throw new Error(`Maximum ${this.maxPolicies} policies reached`);
    }

    // Check for duplicate names
    for (const p of this.policies.values()) {
      if (p.name === params.name) throw new Error(`Policy '${params.name}' already exists`);
    }

    const policy: RotationPolicy = {
      id: `rp_${this.nextPolicyId++}`,
      name: params.name,
      rotationIntervalMs: params.rotationIntervalMs,
      gracePeriodMs: params.gracePeriodMs ?? 0,
      warnBeforeMs: params.warnBeforeMs ?? 0,
      createdAt: Date.now(),
    };

    this.policies.set(policy.id, policy);
    return policy;
  }

  /** Get a policy by ID. */
  getPolicy(id: string): RotationPolicy | null {
    return this.policies.get(id) ?? null;
  }

  /** List all policies. */
  listPolicies(): RotationPolicy[] {
    return [...this.policies.values()];
  }

  /** Remove a policy. */
  removePolicy(id: string): boolean {
    return this.policies.delete(id);
  }

  // ── Key Registration ──────────────────────────────────────────

  /** Register a key under a rotation policy. */
  registerKey(key: string, policyId: string): ManagedKey {
    const policy = this.policies.get(policyId);
    if (!policy) throw new Error(`Policy '${policyId}' not found`);
    if (this.keys.size >= this.maxKeys) {
      throw new Error(`Maximum ${this.maxKeys} managed keys reached`);
    }

    const now = Date.now();
    const managed: ManagedKey = {
      key,
      policyId,
      registeredAt: now,
      lastRotatedAt: now,
      rotationCount: 0,
      status: 'current',
      nextRotationAt: now + policy.rotationIntervalMs,
      graceExpiresAt: null,
    };

    this.keys.set(key, managed);
    return managed;
  }

  /** Unregister a key. */
  unregisterKey(key: string): boolean {
    return this.keys.delete(key);
  }

  /** Get a managed key. */
  getKey(key: string): ManagedKey | null {
    const managed = this.keys.get(key);
    if (!managed) return null;
    this.updateKeyStatus(managed);
    return managed;
  }

  // ── Rotation Operations ───────────────────────────────────────

  /** Record that a key has been rotated. */
  recordRotation(key: string, newKey?: string): RotationEvent | null {
    const managed = this.keys.get(key);
    if (!managed) return null;

    const policy = this.policies.get(managed.policyId);
    if (!policy) return null;

    const now = Date.now();
    const event: RotationEvent = {
      id: `re_${this.nextEventId++}`,
      key: newKey ?? key,
      oldKey: key,
      rotatedAt: now,
      policyId: managed.policyId,
    };

    managed.lastRotatedAt = now;
    managed.rotationCount++;
    managed.nextRotationAt = now + policy.rotationIntervalMs;
    managed.status = 'current';
    managed.graceExpiresAt = null;

    // If new key is different, update map
    if (newKey && newKey !== key) {
      managed.key = newKey;
      this.keys.delete(key);
      this.keys.set(newKey, managed);
    }

    this.events.push(event);
    return event;
  }

  /** Get keys due for rotation. */
  getKeysDueForRotation(): ManagedKey[] {
    const results: ManagedKey[] = [];
    for (const managed of this.keys.values()) {
      this.updateKeyStatus(managed);
      if (managed.status === 'due' || managed.status === 'overdue') {
        results.push(managed);
      }
    }
    return results.sort((a, b) => a.nextRotationAt - b.nextRotationAt);
  }

  /** Get keys with upcoming rotation (within warn period). */
  getKeysUpcomingRotation(): ManagedKey[] {
    const now = Date.now();
    const results: ManagedKey[] = [];
    for (const managed of this.keys.values()) {
      const policy = this.policies.get(managed.policyId);
      if (!policy || policy.warnBeforeMs <= 0) continue;

      this.updateKeyStatus(managed);
      if (managed.status === 'current' && managed.nextRotationAt - now <= policy.warnBeforeMs) {
        results.push(managed);
      }
    }
    return results.sort((a, b) => a.nextRotationAt - b.nextRotationAt);
  }

  /** Get rotation history for a key. */
  getRotationHistory(key: string, limit = 20): RotationEvent[] {
    return this.events
      .filter(e => e.key === key || e.oldKey === key)
      .slice(-limit);
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): KeyRotationPolicyStats {
    let due = 0;
    let overdue = 0;
    let inGrace = 0;

    for (const managed of this.keys.values()) {
      this.updateKeyStatus(managed);
      if (managed.status === 'due') due++;
      else if (managed.status === 'overdue') overdue++;
      else if (managed.status === 'grace_period') inGrace++;
    }

    return {
      totalPolicies: this.policies.size,
      totalManagedKeys: this.keys.size,
      keysDue: due,
      keysOverdue: overdue,
      keysInGrace: inGrace,
      totalRotations: this.events.length,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.policies.clear();
    this.keys.clear();
    this.events = [];
  }

  // ── Private ───────────────────────────────────────────────────

  private updateKeyStatus(managed: ManagedKey): void {
    const now = Date.now();
    const policy = this.policies.get(managed.policyId);
    if (!policy) return;

    if (now < managed.nextRotationAt) {
      managed.status = 'current';
    } else if (policy.gracePeriodMs > 0 && now < managed.nextRotationAt + policy.gracePeriodMs) {
      managed.status = 'due';
      managed.graceExpiresAt = managed.nextRotationAt + policy.gracePeriodMs;
    } else if (policy.gracePeriodMs > 0 && now >= managed.nextRotationAt + policy.gracePeriodMs) {
      managed.status = 'overdue';
    } else {
      managed.status = 'due';
    }
  }
}
