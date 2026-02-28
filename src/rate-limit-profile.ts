/**
 * RateLimitProfile — Named rate limit configurations assignable to keys/tiers.
 *
 * Define named rate limit profiles (e.g., 'free', 'pro', 'enterprise'),
 * assign profiles to keys, and check rate limits per profile.
 *
 * @example
 * ```ts
 * const mgr = new RateLimitProfileManager();
 *
 * mgr.createProfile({
 *   name: 'free',
 *   limits: { requestsPerMinute: 10, requestsPerHour: 100, requestsPerDay: 500 },
 * });
 *
 * mgr.assignProfile('key_abc', 'free');
 * const check = mgr.checkLimit('key_abc');
 * // check.allowed === true
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface RateLimits {
  requestsPerMinute?: number;
  requestsPerHour?: number;
  requestsPerDay?: number;
}

export interface RateLimitProfileDef {
  id: string;
  name: string;
  description: string;
  limits: RateLimits;
  burstMultiplier: number; // allow burst above limit * multiplier briefly
  enabled: boolean;
  createdAt: number;
}

export interface ProfileCreateParams {
  name: string;
  description?: string;
  limits: RateLimits;
  burstMultiplier?: number;
  enabled?: boolean;
}

export interface RateLimitCheck {
  allowed: boolean;
  profile: string;
  key: string;
  currentMinute: number;
  currentHour: number;
  currentDay: number;
  limitMinute: number | null;
  limitHour: number | null;
  limitDay: number | null;
  retryAfterMs: number | null;
  reason: string;
}

export interface RateLimitProfileConfig {
  /** Max profiles. Default 50. */
  maxProfiles?: number;
  /** Default profile name for unassigned keys. Default null. */
  defaultProfile?: string | null;
}

export interface RateLimitProfileStats {
  totalProfiles: number;
  enabledProfiles: number;
  totalAssignments: number;
  totalChecks: number;
  totalAllowed: number;
  totalDenied: number;
}

// ── Implementation ───────────────────────────────────────────────────

interface WindowCounter {
  minute: { count: number; start: number };
  hour: { count: number; start: number };
  day: { count: number; start: number };
}

export class RateLimitProfileManager {
  private profiles = new Map<string, RateLimitProfileDef>();
  private assignments = new Map<string, string>(); // key → profile name
  private counters = new Map<string, WindowCounter>(); // key → counters
  private nextId = 1;

  private maxProfiles: number;
  private defaultProfile: string | null;

  // Stats
  private totalChecks = 0;
  private totalAllowed = 0;
  private totalDenied = 0;

  constructor(config: RateLimitProfileConfig = {}) {
    this.maxProfiles = config.maxProfiles ?? 50;
    this.defaultProfile = config.defaultProfile ?? null;
  }

  // ── Profile Management ─────────────────────────────────────────

  /** Create a rate limit profile. */
  createProfile(params: ProfileCreateParams): RateLimitProfileDef {
    if (!params.name) throw new Error('Profile name is required');
    if (this.getProfileByName(params.name)) {
      throw new Error(`Profile '${params.name}' already exists`);
    }
    if (this.profiles.size >= this.maxProfiles) {
      throw new Error(`Maximum ${this.maxProfiles} profiles reached`);
    }

    const profile: RateLimitProfileDef = {
      id: `prof_${this.nextId++}`,
      name: params.name,
      description: params.description ?? '',
      limits: { ...params.limits },
      burstMultiplier: params.burstMultiplier ?? 1,
      enabled: params.enabled ?? true,
      createdAt: Date.now(),
    };

    this.profiles.set(profile.id, profile);
    return profile;
  }

  /** Get profile by name. */
  getProfileByName(name: string): RateLimitProfileDef | null {
    for (const p of this.profiles.values()) {
      if (p.name === name) return p;
    }
    return null;
  }

  /** Get profile by ID. */
  getProfile(id: string): RateLimitProfileDef | null {
    return this.profiles.get(id) ?? null;
  }

  /** List all profiles. */
  listProfiles(): RateLimitProfileDef[] {
    return [...this.profiles.values()];
  }

  /** Remove a profile. */
  removeProfile(name: string): boolean {
    const p = this.getProfileByName(name);
    if (!p) return false;

    // Remove assignments using this profile
    for (const [key, profileName] of this.assignments) {
      if (profileName === name) this.assignments.delete(key);
    }

    return this.profiles.delete(p.id);
  }

  /** Update profile limits. */
  updateLimits(name: string, limits: Partial<RateLimits>): void {
    const p = this.getProfileByName(name);
    if (!p) throw new Error(`Profile '${name}' not found`);
    Object.assign(p.limits, limits);
  }

  /** Enable/disable a profile. */
  setProfileEnabled(name: string, enabled: boolean): void {
    const p = this.getProfileByName(name);
    if (!p) throw new Error(`Profile '${name}' not found`);
    p.enabled = enabled;
  }

  // ── Assignment ─────────────────────────────────────────────────

  /** Assign a profile to a key. */
  assignProfile(key: string, profileName: string): void {
    if (!this.getProfileByName(profileName)) {
      throw new Error(`Profile '${profileName}' not found`);
    }
    this.assignments.set(key, profileName);
  }

  /** Unassign a profile from a key. */
  unassignProfile(key: string): boolean {
    return this.assignments.delete(key);
  }

  /** Get profile assigned to a key. */
  getKeyProfile(key: string): string | null {
    return this.assignments.get(key) ?? this.defaultProfile;
  }

  /** List all assignments. */
  listAssignments(): { key: string; profile: string }[] {
    return [...this.assignments.entries()].map(([key, profile]) => ({ key, profile }));
  }

  // ── Rate Limiting ──────────────────────────────────────────────

  /** Check if a request is allowed under the key's rate limit profile. */
  checkLimit(key: string): RateLimitCheck {
    const profileName = this.getKeyProfile(key);
    this.totalChecks++;

    if (!profileName) {
      this.totalAllowed++;
      return {
        allowed: true,
        profile: 'none',
        key,
        currentMinute: 0,
        currentHour: 0,
        currentDay: 0,
        limitMinute: null,
        limitHour: null,
        limitDay: null,
        retryAfterMs: null,
        reason: 'No profile assigned',
      };
    }

    const profile = this.getProfileByName(profileName);
    if (!profile || !profile.enabled) {
      this.totalAllowed++;
      return {
        allowed: true,
        profile: profileName,
        key,
        currentMinute: 0,
        currentHour: 0,
        currentDay: 0,
        limitMinute: null,
        limitHour: null,
        limitDay: null,
        retryAfterMs: null,
        reason: profile ? 'Profile disabled' : 'Profile not found',
      };
    }

    const counter = this.getOrCreateCounter(key);
    const now = Date.now();

    // Reset windows if expired
    this.resetExpiredWindows(counter, now);

    const { limits, burstMultiplier } = profile;
    const effectiveMinute = limits.requestsPerMinute ? Math.floor(limits.requestsPerMinute * burstMultiplier) : null;
    const effectiveHour = limits.requestsPerHour ? Math.floor(limits.requestsPerHour * burstMultiplier) : null;
    const effectiveDay = limits.requestsPerDay ? Math.floor(limits.requestsPerDay * burstMultiplier) : null;

    // Check limits
    let retryAfterMs: number | null = null;
    let denied = false;
    let reason = 'Allowed';

    if (effectiveMinute !== null && counter.minute.count >= effectiveMinute) {
      denied = true;
      retryAfterMs = (counter.minute.start + 60_000) - now;
      reason = 'Minute limit exceeded';
    }
    if (effectiveHour !== null && counter.hour.count >= effectiveHour) {
      denied = true;
      const hourRetry = (counter.hour.start + 3_600_000) - now;
      retryAfterMs = retryAfterMs === null ? hourRetry : Math.min(retryAfterMs, hourRetry);
      reason = 'Hour limit exceeded';
    }
    if (effectiveDay !== null && counter.day.count >= effectiveDay) {
      denied = true;
      const dayRetry = (counter.day.start + 86_400_000) - now;
      retryAfterMs = retryAfterMs === null ? dayRetry : Math.min(retryAfterMs, dayRetry);
      reason = 'Day limit exceeded';
    }

    if (!denied) {
      counter.minute.count++;
      counter.hour.count++;
      counter.day.count++;
      this.totalAllowed++;
    } else {
      this.totalDenied++;
    }

    return {
      allowed: !denied,
      profile: profileName,
      key,
      currentMinute: counter.minute.count,
      currentHour: counter.hour.count,
      currentDay: counter.day.count,
      limitMinute: limits.requestsPerMinute ?? null,
      limitHour: limits.requestsPerHour ?? null,
      limitDay: limits.requestsPerDay ?? null,
      retryAfterMs: denied ? Math.max(0, retryAfterMs ?? 0) : null,
      reason,
    };
  }

  /** Reset counters for a key. */
  resetCounters(key: string): void {
    this.counters.delete(key);
  }

  // ── Stats ───────────────────────────────────────────────────────

  getStats(): RateLimitProfileStats {
    let enabled = 0;
    for (const p of this.profiles.values()) {
      if (p.enabled) enabled++;
    }

    return {
      totalProfiles: this.profiles.size,
      enabledProfiles: enabled,
      totalAssignments: this.assignments.size,
      totalChecks: this.totalChecks,
      totalAllowed: this.totalAllowed,
      totalDenied: this.totalDenied,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.profiles.clear();
    this.assignments.clear();
    this.counters.clear();
    this.totalChecks = 0;
    this.totalAllowed = 0;
    this.totalDenied = 0;
  }

  // ── Private ─────────────────────────────────────────────────────

  private getOrCreateCounter(key: string): WindowCounter {
    if (!this.counters.has(key)) {
      const now = Date.now();
      this.counters.set(key, {
        minute: { count: 0, start: now },
        hour: { count: 0, start: now },
        day: { count: 0, start: now },
      });
    }
    return this.counters.get(key)!;
  }

  private resetExpiredWindows(counter: WindowCounter, now: number): void {
    if (now - counter.minute.start >= 60_000) {
      counter.minute = { count: 0, start: now };
    }
    if (now - counter.hour.start >= 3_600_000) {
      counter.hour = { count: 0, start: now };
    }
    if (now - counter.day.start >= 86_400_000) {
      counter.day = { count: 0, start: now };
    }
  }
}
