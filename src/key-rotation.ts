/**
 * Key Rotation Scheduler — Automated API Key Lifecycle Management.
 *
 * Schedule automatic key rotation with configurable policies.
 * Supports grace periods (old key works during transition),
 * notification hooks, and rotation history tracking.
 *
 * Use cases:
 *   - Compliance requirements for periodic key rotation
 *   - Automated credential lifecycle management
 *   - Security-hardened key policies
 *
 * Zero external dependencies.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RotationPolicy {
  /** Unique policy ID. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Rotation interval in seconds. Default: 2592000 (30 days). */
  intervalSeconds: number;
  /** Grace period in seconds (old key still works). Default: 86400 (24 hours). */
  gracePeriodSeconds: number;
  /** Whether to auto-generate the new key. Default: true. */
  autoGenerate: boolean;
  /** Whether to copy credits from old key to new key. Default: true. */
  copyCredits: boolean;
  /** Whether to copy allowed/denied tools. Default: true. */
  copyAcl: boolean;
  /** Whether this policy is active. */
  active: boolean;
  /** When this policy was created (ISO). */
  createdAt: string;
}

export interface RotationSchedule {
  /** API key being tracked. */
  apiKey: string;
  /** Policy ID governing rotation. */
  policyId: string;
  /** When the key was last rotated (ISO). */
  lastRotatedAt: string;
  /** When the next rotation is due (ISO). */
  nextRotationAt: string;
  /** Whether grace period is active (old key still valid). */
  graceActive: boolean;
  /** The old key during grace period. */
  gracePreviousKey?: string;
  /** When grace period ends (ISO). */
  graceExpiresAt?: string;
}

export interface RotationEvent {
  /** Old key that was rotated. */
  oldKey: string;
  /** New key that replaced it. */
  newKey: string;
  /** Policy ID. */
  policyId: string;
  /** When the rotation occurred (ISO). */
  rotatedAt: string;
  /** Whether it was automatic or manual. */
  trigger: 'auto' | 'manual';
  /** Whether grace period is in effect. */
  graceActive: boolean;
}

export interface KeyRotationConfig {
  /** Maximum policies. Default: 100. */
  maxPolicies?: number;
  /** Maximum history entries. Default: 10000. */
  maxHistory?: number;
}

export interface KeyRotationStats {
  /** Total policies. */
  totalPolicies: number;
  /** Active policies. */
  activePolicies: number;
  /** Keys with rotation schedules. */
  scheduledKeys: number;
  /** Keys due for rotation now. */
  keysDueForRotation: number;
  /** Keys in grace period. */
  keysInGrace: number;
  /** Total rotations performed. */
  totalRotations: number;
  /** Auto vs manual rotations. */
  autoRotations: number;
  /** Manual rotations. */
  manualRotations: number;
}

// ─── Key Rotation Scheduler ─────────────────────────────────────────────────

export class KeyRotationScheduler {
  private policies = new Map<string, RotationPolicy>();
  private schedules = new Map<string, RotationSchedule>(); // apiKey → schedule
  private history: RotationEvent[] = [];
  private maxPolicies: number;
  private maxHistory: number;

  // Stats
  private totalRotations = 0;
  private autoRotations = 0;
  private manualRotations = 0;

  constructor(config: KeyRotationConfig = {}) {
    this.maxPolicies = config.maxPolicies ?? 100;
    this.maxHistory = config.maxHistory ?? 10_000;
  }

  /** Create or update a rotation policy. */
  upsertPolicy(policy: Omit<RotationPolicy, 'createdAt'> & { createdAt?: string }): boolean {
    if (this.policies.size >= this.maxPolicies && !this.policies.has(policy.id)) {
      return false;
    }

    this.policies.set(policy.id, {
      ...policy,
      createdAt: policy.createdAt ?? new Date().toISOString(),
    });
    return true;
  }

  /** Remove a policy. */
  removePolicy(id: string): boolean {
    return this.policies.delete(id);
  }

  /** Get a policy. */
  getPolicy(id: string): RotationPolicy | null {
    return this.policies.get(id) ?? null;
  }

  /** Get all policies. */
  getPolicies(): RotationPolicy[] {
    return [...this.policies.values()];
  }

  /** Schedule rotation for a key. */
  scheduleKey(apiKey: string, policyId: string): boolean {
    const policy = this.policies.get(policyId);
    if (!policy || !policy.active) return false;

    const now = new Date();
    const nextRotation = new Date(now.getTime() + policy.intervalSeconds * 1000);

    this.schedules.set(apiKey, {
      apiKey,
      policyId,
      lastRotatedAt: now.toISOString(),
      nextRotationAt: nextRotation.toISOString(),
      graceActive: false,
    });
    return true;
  }

  /** Remove rotation schedule for a key. */
  unscheduleKey(apiKey: string): boolean {
    return this.schedules.delete(apiKey);
  }

  /** Get schedule for a key. */
  getSchedule(apiKey: string): RotationSchedule | null {
    return this.schedules.get(apiKey) ?? null;
  }

  /** Get all schedules. */
  getSchedules(): RotationSchedule[] {
    return [...this.schedules.values()];
  }

  /** Get keys that are due for rotation. */
  getDueKeys(): string[] {
    const now = Date.now();
    const due: string[] = [];

    for (const schedule of this.schedules.values()) {
      const nextTime = new Date(schedule.nextRotationAt).getTime();
      if (nextTime <= now && !schedule.graceActive) {
        due.push(schedule.apiKey);
      }
    }

    return due;
  }

  /** Get keys currently in grace period. */
  getGraceKeys(): string[] {
    return [...this.schedules.values()]
      .filter(s => s.graceActive)
      .map(s => s.apiKey);
  }

  /**
   * Perform a key rotation.
   *
   * @param apiKey - The key to rotate
   * @param newKey - The new key (if not auto-generating)
   * @param trigger - Whether this is auto or manual
   * @returns The rotation event, or null if the key has no schedule
   */
  rotate(apiKey: string, newKey: string, trigger: 'auto' | 'manual' = 'manual'): RotationEvent | null {
    const schedule = this.schedules.get(apiKey);
    if (!schedule) return null;

    const policy = this.policies.get(schedule.policyId);
    if (!policy) return null;

    const now = new Date();
    const hasGrace = policy.gracePeriodSeconds > 0;

    const event: RotationEvent = {
      oldKey: apiKey,
      newKey,
      policyId: schedule.policyId,
      rotatedAt: now.toISOString(),
      trigger,
      graceActive: hasGrace,
    };

    // Update schedule to point to new key
    const nextRotation = new Date(now.getTime() + policy.intervalSeconds * 1000);
    const newSchedule: RotationSchedule = {
      apiKey: newKey,
      policyId: schedule.policyId,
      lastRotatedAt: now.toISOString(),
      nextRotationAt: nextRotation.toISOString(),
      graceActive: hasGrace,
      gracePreviousKey: hasGrace ? apiKey : undefined,
      graceExpiresAt: hasGrace ? new Date(now.getTime() + policy.gracePeriodSeconds * 1000).toISOString() : undefined,
    };

    // Remove old schedule, add new one
    this.schedules.delete(apiKey);
    this.schedules.set(newKey, newSchedule);

    // Track history
    if (this.history.length >= this.maxHistory) {
      this.history.splice(0, Math.floor(this.maxHistory * 0.1));
    }
    this.history.push(event);

    // Stats
    this.totalRotations++;
    if (trigger === 'auto') this.autoRotations++;
    else this.manualRotations++;

    return event;
  }

  /** Check and expire grace periods. Returns keys whose grace period ended. */
  expireGracePeriods(): string[] {
    const now = Date.now();
    const expired: string[] = [];

    for (const schedule of this.schedules.values()) {
      if (schedule.graceActive && schedule.graceExpiresAt) {
        if (new Date(schedule.graceExpiresAt).getTime() <= now) {
          schedule.graceActive = false;
          if (schedule.gracePreviousKey) {
            expired.push(schedule.gracePreviousKey);
          }
          schedule.gracePreviousKey = undefined;
          schedule.graceExpiresAt = undefined;
        }
      }
    }

    return expired;
  }

  /** Check if a key is valid (either active or in grace period). */
  isKeyValid(key: string): boolean {
    // Check if it's a current key
    if (this.schedules.has(key)) return true;

    // Check if it's in a grace period of another key
    for (const schedule of this.schedules.values()) {
      if (schedule.graceActive && schedule.gracePreviousKey === key) {
        return true;
      }
    }

    return false;
  }

  /** Get rotation history. */
  getHistory(limit = 100, apiKey?: string): RotationEvent[] {
    let events = this.history;
    if (apiKey) {
      events = events.filter(e => e.oldKey === apiKey || e.newKey === apiKey);
    }
    return events.slice(-limit);
  }

  /** Get stats. */
  getStats(): KeyRotationStats {
    const now = Date.now();
    let keysDue = 0;
    let keysInGrace = 0;

    for (const schedule of this.schedules.values()) {
      if (schedule.graceActive) keysInGrace++;
      else if (new Date(schedule.nextRotationAt).getTime() <= now) keysDue++;
    }

    return {
      totalPolicies: this.policies.size,
      activePolicies: [...this.policies.values()].filter(p => p.active).length,
      scheduledKeys: this.schedules.size,
      keysDueForRotation: keysDue,
      keysInGrace,
      totalRotations: this.totalRotations,
      autoRotations: this.autoRotations,
      manualRotations: this.manualRotations,
    };
  }

  /** Reset stats. */
  resetStats(): void {
    this.totalRotations = 0;
    this.autoRotations = 0;
    this.manualRotations = 0;
  }

  /** Destroy and release resources. */
  destroy(): void {
    this.policies.clear();
    this.schedules.clear();
    this.history = [];
    this.resetStats();
  }
}
