/**
 * ConfigProfileManager — Named configuration presets.
 *
 * Store and switch between named configuration profiles for different
 * environments (dev, staging, production) or use cases:
 *   - Save current config as a named profile
 *   - Switch between profiles at runtime
 *   - Compare profiles to see differences
 *   - Import/export profiles as JSON
 *   - Profile inheritance (extend a base profile)
 *   - Rollback to previous profile
 *
 * Zero external dependencies.
 */

import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ConfigProfile {
  id: string;
  name: string;
  /** Optional description of what this profile is for. */
  description?: string;
  /** The configuration snapshot. */
  config: Record<string, unknown>;
  /** Profile this extends (inherits values from). */
  extendsProfile?: string;
  /** SHA-256 checksum of the config JSON. */
  checksum: string;
  /** Whether this is the currently active profile. */
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProfileDiff {
  /** Keys only in profile A. */
  onlyInA: string[];
  /** Keys only in profile B. */
  onlyInB: string[];
  /** Keys present in both but with different values. */
  changed: Array<{ key: string; valueA: unknown; valueB: unknown }>;
  /** Keys with identical values in both. */
  unchanged: string[];
}

export interface ProfileStats {
  totalProfiles: number;
  activeProfile: string | null;
  switchCount: number;
  lastSwitchAt: number | null;
  rollbackAvailable: boolean;
}

export interface ConfigProfileManagerConfig {
  enabled: boolean;
  maxProfiles: number;
  /** Max config size in bytes. Default 1MB. */
  maxConfigSize: number;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ConfigProfileManagerConfig = {
  enabled: false,
  maxProfiles: 50,
  maxConfigSize: 1_000_000,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeChecksum(config: Record<string, unknown>): string {
  const json = JSON.stringify(config, Object.keys(config).sort());
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
}

function flattenKeys(obj: Record<string, unknown>, prefix = ''): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = flattenKeys(value as Record<string, unknown>, fullKey);
      for (const [k, v] of nested) {
        result.set(k, v);
      }
    } else {
      result.set(fullKey, value);
    }
  }
  return result;
}

// ─── ConfigProfileManager Class ─────────────────────────────────────────────

export class ConfigProfileManager {
  private config: ConfigProfileManagerConfig;
  private profiles = new Map<string, ConfigProfile>();
  private activeProfileId: string | null = null;
  private previousProfileId: string | null = null;

  // Stats
  private _switchCount = 0;
  private _lastSwitchAt: number | null = null;

  private counter = 0;

  constructor(config?: Partial<ConfigProfileManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Profile CRUD ───────────────────────────────────────────────────────

  /**
   * Save a configuration as a named profile.
   */
  saveProfile(params: {
    name: string;
    config: Record<string, unknown>;
    description?: string;
    extendsProfile?: string;
    activate?: boolean;
  }): ConfigProfile {
    if (!params.name || params.name.length > 128) {
      throw new Error('Profile name required (max 128 chars)');
    }

    const configJson = JSON.stringify(params.config);
    if (configJson.length > this.config.maxConfigSize) {
      throw new Error(`Config too large (${configJson.length} bytes, max ${this.config.maxConfigSize})`);
    }

    if (params.extendsProfile && !this.profiles.has(params.extendsProfile)) {
      throw new Error(`Parent profile '${params.extendsProfile}' not found`);
    }

    // Check for existing profile with same name
    let existing: ConfigProfile | undefined;
    for (const p of this.profiles.values()) {
      if (p.name === params.name) {
        existing = p;
        break;
      }
    }

    if (existing) {
      // Update existing
      existing.config = JSON.parse(JSON.stringify(params.config));
      existing.description = params.description ?? existing.description;
      existing.extendsProfile = params.extendsProfile;
      existing.checksum = computeChecksum(params.config);
      existing.updatedAt = Date.now();

      if (params.activate) {
        this.activateProfile(existing.id);
      }

      return { ...existing, config: JSON.parse(JSON.stringify(existing.config)) };
    }

    // Create new
    if (this.profiles.size >= this.config.maxProfiles) {
      throw new Error(`Max profiles reached (${this.config.maxProfiles})`);
    }

    this.counter++;
    const id = `prof_${this.counter}_${Date.now().toString(36)}`;

    const profile: ConfigProfile = {
      id,
      name: params.name,
      description: params.description,
      config: JSON.parse(JSON.stringify(params.config)),
      extendsProfile: params.extendsProfile,
      checksum: computeChecksum(params.config),
      active: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.profiles.set(id, profile);

    if (params.activate) {
      this.activateProfile(id);
    }

    return { ...profile, config: JSON.parse(JSON.stringify(profile.config)) };
  }

  /**
   * Get a profile by ID.
   */
  getProfile(id: string): ConfigProfile | undefined {
    const p = this.profiles.get(id);
    if (!p) return undefined;
    return { ...p, config: JSON.parse(JSON.stringify(p.config)) };
  }

  /**
   * Get a profile by name.
   */
  getProfileByName(name: string): ConfigProfile | undefined {
    for (const p of this.profiles.values()) {
      if (p.name === name) {
        return { ...p, config: JSON.parse(JSON.stringify(p.config)) };
      }
    }
    return undefined;
  }

  /**
   * List all profiles.
   */
  listProfiles(): ConfigProfile[] {
    const results: ConfigProfile[] = [];
    for (const p of this.profiles.values()) {
      results.push({ ...p, config: JSON.parse(JSON.stringify(p.config)) });
    }
    return results;
  }

  /**
   * Delete a profile.
   */
  deleteProfile(id: string): boolean {
    if (id === this.activeProfileId) {
      this.activeProfileId = null;
    }
    // Remove from other profiles' extends references
    for (const p of this.profiles.values()) {
      if (p.extendsProfile === id) {
        p.extendsProfile = undefined;
      }
    }
    return this.profiles.delete(id);
  }

  // ─── Profile Switching ──────────────────────────────────────────────────

  /**
   * Activate a profile (makes it the current active profile).
   * Returns the resolved configuration (with inheritance applied).
   */
  activateProfile(id: string): Record<string, unknown> {
    const profile = this.profiles.get(id);
    if (!profile) throw new Error(`Profile '${id}' not found`);

    // Deactivate current
    if (this.activeProfileId) {
      const current = this.profiles.get(this.activeProfileId);
      if (current) current.active = false;
      this.previousProfileId = this.activeProfileId;
    }

    profile.active = true;
    this.activeProfileId = id;
    this._switchCount++;
    this._lastSwitchAt = Date.now();

    return this.resolveConfig(id);
  }

  /**
   * Rollback to the previously active profile.
   */
  rollback(): Record<string, unknown> | null {
    if (!this.previousProfileId) return null;
    if (!this.profiles.has(this.previousProfileId)) return null;

    return this.activateProfile(this.previousProfileId);
  }

  /**
   * Get the currently active profile.
   */
  getActive(): ConfigProfile | null {
    if (!this.activeProfileId) return null;
    return this.getProfile(this.activeProfileId) ?? null;
  }

  /**
   * Resolve configuration for a profile, applying inheritance.
   */
  resolveConfig(id: string): Record<string, unknown> {
    const profile = this.profiles.get(id);
    if (!profile) throw new Error(`Profile '${id}' not found`);

    // Build inheritance chain
    const chain: ConfigProfile[] = [profile];
    let current = profile;
    const visited = new Set<string>([id]);

    while (current.extendsProfile) {
      if (visited.has(current.extendsProfile)) {
        break; // Circular inheritance, stop
      }
      visited.add(current.extendsProfile);
      const parent = this.profiles.get(current.extendsProfile);
      if (!parent) break;
      chain.unshift(parent);
      current = parent;
    }

    // Merge configs from base to child
    const resolved: Record<string, unknown> = {};
    for (const p of chain) {
      Object.assign(resolved, JSON.parse(JSON.stringify(p.config)));
    }

    return resolved;
  }

  // ─── Comparison ─────────────────────────────────────────────────────────

  /**
   * Compare two profiles and return the differences.
   */
  compare(idA: string, idB: string): ProfileDiff {
    const configA = this.resolveConfig(idA);
    const configB = this.resolveConfig(idB);

    const flatA = flattenKeys(configA);
    const flatB = flattenKeys(configB);

    const onlyInA: string[] = [];
    const onlyInB: string[] = [];
    const changed: Array<{ key: string; valueA: unknown; valueB: unknown }> = [];
    const unchanged: string[] = [];

    for (const [key, valueA] of flatA) {
      if (!flatB.has(key)) {
        onlyInA.push(key);
      } else {
        const valueB = flatB.get(key);
        if (JSON.stringify(valueA) !== JSON.stringify(valueB)) {
          changed.push({ key, valueA, valueB });
        } else {
          unchanged.push(key);
        }
      }
    }

    for (const key of flatB.keys()) {
      if (!flatA.has(key)) {
        onlyInB.push(key);
      }
    }

    return { onlyInA, onlyInB, changed, unchanged };
  }

  // ─── Import/Export ──────────────────────────────────────────────────────

  /**
   * Export all profiles as JSON.
   */
  exportProfiles(): string {
    const profiles = this.listProfiles();
    return JSON.stringify({
      version: 1,
      exportedAt: Date.now(),
      activeProfileId: this.activeProfileId,
      profiles,
    }, null, 2);
  }

  /**
   * Import profiles from JSON. Returns count imported.
   */
  importProfiles(json: string, mode: 'merge' | 'replace' = 'merge'): number {
    const data = JSON.parse(json);
    if (!data.profiles || !Array.isArray(data.profiles)) {
      throw new Error('Invalid import format');
    }

    if (mode === 'replace') {
      this.profiles.clear();
      this.activeProfileId = null;
    }

    let imported = 0;
    for (const p of data.profiles) {
      if (!p.name || !p.config) continue;
      this.saveProfile({
        name: p.name,
        config: p.config,
        description: p.description,
        activate: p.active && data.activeProfileId === p.id,
      });
      imported++;
    }

    return imported;
  }

  // ─── Configuration ──────────────────────────────────────────────────────

  configure(updates: Partial<ConfigProfileManagerConfig>): ConfigProfileManagerConfig {
    if (updates.enabled !== undefined) this.config.enabled = updates.enabled;
    if (updates.maxProfiles !== undefined) this.config.maxProfiles = Math.max(1, updates.maxProfiles);
    if (updates.maxConfigSize !== undefined) this.config.maxConfigSize = Math.max(1000, updates.maxConfigSize);
    return { ...this.config };
  }

  stats(): ProfileStats {
    const active = this.activeProfileId ? this.profiles.get(this.activeProfileId) : null;
    return {
      totalProfiles: this.profiles.size,
      activeProfile: active ? active.name : null,
      switchCount: this._switchCount,
      lastSwitchAt: this._lastSwitchAt,
      rollbackAvailable: this.previousProfileId !== null && this.profiles.has(this.previousProfileId),
    };
  }

  clear(): void {
    this.profiles.clear();
    this.activeProfileId = null;
    this.previousProfileId = null;
    this._switchCount = 0;
    this._lastSwitchAt = null;
  }
}
