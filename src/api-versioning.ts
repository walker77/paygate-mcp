/**
 * ApiVersionRouter — Route tool calls to versioned backends.
 *
 * Manage multiple versions of tools, route requests to the correct
 * version based on key configuration, and enable safe migrations
 * with deprecation warnings and sunset dates.
 *
 * @example
 * ```ts
 * const router = new ApiVersionRouter();
 *
 * router.registerVersion({
 *   tool: 'search',
 *   version: 'v1',
 *   status: 'deprecated',
 *   sunsetDate: '2026-04-01',
 * });
 *
 * router.registerVersion({
 *   tool: 'search',
 *   version: 'v2',
 *   status: 'current',
 * });
 *
 * router.setKeyVersion('key_abc', 'search', 'v2');
 *
 * const resolved = router.resolve('key_abc', 'search');
 * // { version: 'v2', status: 'current', deprecated: false }
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type VersionStatus = 'preview' | 'current' | 'deprecated' | 'sunset';

export interface ToolVersion {
  tool: string;
  version: string;
  status: VersionStatus;
  /** ISO date string when this version will be sunset. */
  sunsetDate?: string;
  /** Description of changes in this version. */
  changelog?: string;
  /** When this version was registered. */
  registeredAt: number;
}

export interface VersionRegistration {
  tool: string;
  version: string;
  status?: VersionStatus;
  sunsetDate?: string;
  changelog?: string;
}

export interface VersionResolveResult {
  tool: string;
  version: string;
  status: VersionStatus;
  deprecated: boolean;
  sunsetDate?: string;
  warning?: string;
}

export interface MigrationPlan {
  tool: string;
  fromVersion: string;
  toVersion: string;
  affectedKeys: string[];
  fromStatus: VersionStatus;
  toStatus: VersionStatus;
}

export interface ApiVersionConfig {
  /** Default version to use when no key-specific version is set. */
  defaultVersionStrategy?: 'latest' | 'current';
  /** Auto-sunset versions past their sunset date. */
  autoSunset?: boolean;
}

export interface ApiVersionStats {
  totalTools: number;
  totalVersions: number;
  currentVersions: number;
  deprecatedVersions: number;
  sunsetVersions: number;
  previewVersions: number;
  keyOverrides: number;
  totalResolutions: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class ApiVersionRouter {
  // tool → version → ToolVersion
  private versions = new Map<string, Map<string, ToolVersion>>();
  // key:tool → version
  private keyVersions = new Map<string, string>();
  private defaultStrategy: 'latest' | 'current';
  private autoSunset: boolean;

  // Stats
  private totalResolutions = 0;

  constructor(config: ApiVersionConfig = {}) {
    this.defaultStrategy = config.defaultVersionStrategy ?? 'current';
    this.autoSunset = config.autoSunset ?? true;
  }

  // ── Version Registration ────────────────────────────────────────────

  /** Register a tool version. */
  registerVersion(reg: VersionRegistration): ToolVersion {
    if (!this.versions.has(reg.tool)) {
      this.versions.set(reg.tool, new Map());
    }
    const toolVersions = this.versions.get(reg.tool)!;

    const version: ToolVersion = {
      tool: reg.tool,
      version: reg.version,
      status: reg.status ?? 'current',
      sunsetDate: reg.sunsetDate,
      changelog: reg.changelog,
      registeredAt: Date.now(),
    };

    toolVersions.set(reg.version, version);
    return version;
  }

  /** Remove a tool version. */
  removeVersion(tool: string, version: string): boolean {
    const toolVersions = this.versions.get(tool);
    if (!toolVersions) return false;
    const result = toolVersions.delete(version);
    if (toolVersions.size === 0) this.versions.delete(tool);

    // Remove key overrides pointing to this version
    for (const [k, v] of this.keyVersions.entries()) {
      if (k.startsWith(tool + ':') && v === version) {
        // Actually key format is key:tool, so check differently
      }
    }
    // Clean up key overrides for removed version
    const keysToRemove: string[] = [];
    for (const [compositeKey, ver] of this.keyVersions.entries()) {
      const parts = compositeKey.split(':');
      const keyTool = parts.slice(1).join(':');
      if (keyTool === tool && ver === version) {
        keysToRemove.push(compositeKey);
      }
    }
    for (const k of keysToRemove) this.keyVersions.delete(k);

    return result;
  }

  /** Get a specific tool version. */
  getVersion(tool: string, version: string): ToolVersion | null {
    return this.versions.get(tool)?.get(version) ?? null;
  }

  /** List all versions for a tool. */
  getToolVersions(tool: string): ToolVersion[] {
    const toolVersions = this.versions.get(tool);
    if (!toolVersions) return [];
    return [...toolVersions.values()].sort((a, b) => a.version.localeCompare(b.version));
  }

  /** List all tools that have versions. */
  getVersionedTools(): string[] {
    return [...this.versions.keys()];
  }

  /** Update the status of a version. */
  setVersionStatus(tool: string, version: string, status: VersionStatus): boolean {
    const v = this.versions.get(tool)?.get(version);
    if (!v) return false;
    v.status = status;
    return true;
  }

  // ── Key Version Overrides ──────────────────────────────────────────

  /** Set a specific version for a key+tool combination. */
  setKeyVersion(key: string, tool: string, version: string): boolean {
    // Verify version exists
    if (!this.versions.get(tool)?.has(version)) return false;
    this.keyVersions.set(`${key}:${tool}`, version);
    return true;
  }

  /** Remove key-specific version override. */
  removeKeyVersion(key: string, tool: string): boolean {
    return this.keyVersions.delete(`${key}:${tool}`);
  }

  /** Get key-specific version override. */
  getKeyVersion(key: string, tool: string): string | null {
    return this.keyVersions.get(`${key}:${tool}`) ?? null;
  }

  // ── Resolution ──────────────────────────────────────────────────────

  /** Resolve which version to use for a key+tool request. */
  resolve(key: string, tool: string): VersionResolveResult | null {
    this.totalResolutions++;

    // Auto-sunset check
    if (this.autoSunset) this.checkSunsets(tool);

    const toolVersions = this.versions.get(tool);
    if (!toolVersions || toolVersions.size === 0) return null;

    // Check key-specific override first
    let version: string | undefined;
    const keyOverride = this.keyVersions.get(`${key}:${tool}`);
    if (keyOverride && toolVersions.has(keyOverride)) {
      version = keyOverride;
    }

    // Fall back to default strategy
    if (!version) {
      if (this.defaultStrategy === 'current') {
        // Find the version with status 'current'
        for (const v of toolVersions.values()) {
          if (v.status === 'current') { version = v.version; break; }
        }
      }
      // If no 'current', use latest registered (version string as tiebreaker)
      if (!version) {
        const all = [...toolVersions.values()].sort((a, b) =>
          b.registeredAt - a.registeredAt || b.version.localeCompare(a.version)
        );
        // Prefer non-sunset versions
        const active = all.filter(v => v.status !== 'sunset');
        version = (active.length > 0 ? active[0] : all[0]).version;
      }
    }

    const v = toolVersions.get(version)!;
    const deprecated = v.status === 'deprecated';
    let warning: string | undefined;

    if (deprecated) {
      warning = `Tool "${tool}" version "${version}" is deprecated.`;
      if (v.sunsetDate) warning += ` Sunset date: ${v.sunsetDate}.`;
      // Suggest current version
      for (const candidate of toolVersions.values()) {
        if (candidate.status === 'current') {
          warning += ` Please migrate to "${candidate.version}".`;
          break;
        }
      }
    } else if (v.status === 'sunset') {
      warning = `Tool "${tool}" version "${version}" is sunset and should no longer be used.`;
    }

    return {
      tool,
      version: v.version,
      status: v.status,
      deprecated,
      sunsetDate: v.sunsetDate,
      warning,
    };
  }

  // ── Migration Planning ─────────────────────────────────────────────

  /** Generate a migration plan for moving keys from one version to another. */
  planMigration(tool: string, fromVersion: string, toVersion: string): MigrationPlan | null {
    const from = this.getVersion(tool, fromVersion);
    const to = this.getVersion(tool, toVersion);
    if (!from || !to) return null;

    // Find keys currently using fromVersion
    const affectedKeys: string[] = [];
    for (const [compositeKey, ver] of this.keyVersions.entries()) {
      const parts = compositeKey.split(':');
      const key = parts[0];
      const keyTool = parts.slice(1).join(':');
      if (keyTool === tool && ver === fromVersion) {
        affectedKeys.push(key);
      }
    }

    return {
      tool,
      fromVersion,
      toVersion,
      affectedKeys,
      fromStatus: from.status,
      toStatus: to.status,
    };
  }

  /** Execute a migration: move all keys from one version to another. */
  executeMigration(tool: string, fromVersion: string, toVersion: string): number {
    const plan = this.planMigration(tool, fromVersion, toVersion);
    if (!plan) return 0;

    let migrated = 0;
    for (const key of plan.affectedKeys) {
      this.setKeyVersion(key, tool, toVersion);
      migrated++;
    }
    return migrated;
  }

  // ── Deprecation ────────────────────────────────────────────────────

  /** Get all deprecated versions across all tools. */
  getDeprecatedVersions(): ToolVersion[] {
    const result: ToolVersion[] = [];
    for (const toolVersions of this.versions.values()) {
      for (const v of toolVersions.values()) {
        if (v.status === 'deprecated') result.push(v);
      }
    }
    return result;
  }

  /** Get versions approaching sunset (within days). */
  getApproachingSunset(withinDays: number = 30): ToolVersion[] {
    const cutoff = Date.now() + withinDays * 24 * 3600_000;
    const result: ToolVersion[] = [];
    for (const toolVersions of this.versions.values()) {
      for (const v of toolVersions.values()) {
        if (v.sunsetDate) {
          const sunsetMs = new Date(v.sunsetDate).getTime();
          if (sunsetMs <= cutoff && v.status !== 'sunset') result.push(v);
        }
      }
    }
    return result;
  }

  // ── Stats ──────────────────────────────────────────────────────────

  getStats(): ApiVersionStats {
    let totalVersions = 0;
    let current = 0, deprecated = 0, sunset = 0, preview = 0;

    for (const toolVersions of this.versions.values()) {
      for (const v of toolVersions.values()) {
        totalVersions++;
        switch (v.status) {
          case 'current': current++; break;
          case 'deprecated': deprecated++; break;
          case 'sunset': sunset++; break;
          case 'preview': preview++; break;
        }
      }
    }

    return {
      totalTools: this.versions.size,
      totalVersions,
      currentVersions: current,
      deprecatedVersions: deprecated,
      sunsetVersions: sunset,
      previewVersions: preview,
      keyOverrides: this.keyVersions.size,
      totalResolutions: this.totalResolutions,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.versions.clear();
    this.keyVersions.clear();
    this.totalResolutions = 0;
  }

  // ── Private ─────────────────────────────────────────────────────────

  private checkSunsets(tool: string): void {
    const toolVersions = this.versions.get(tool);
    if (!toolVersions) return;

    const now = Date.now();
    for (const v of toolVersions.values()) {
      if (v.sunsetDate && v.status !== 'sunset') {
        const sunsetMs = new Date(v.sunsetDate).getTime();
        if (sunsetMs <= now) v.status = 'sunset';
      }
    }
  }
}
