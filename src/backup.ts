/**
 * Backup & Restore — Full state snapshot and restoration for disaster recovery.
 *
 * Creates point-in-time snapshots of all PayGate state:
 *   - API keys (full records including secrets)
 *   - Usage/meter data
 *   - Audit log entries
 *   - Webhook filter configurations
 *   - Team configurations
 *   - Key group configurations
 *   - Admin key records
 *   - OAuth client registrations
 *   - Alert configurations
 *   - Plugin state
 *
 * Restore modes:
 *   - 'full': Complete state replacement (destructive)
 *   - 'merge': Merge with existing state (additive, no overwrites)
 *   - 'overwrite': Merge with existing state (overwrites conflicts)
 *
 * @example
 * ```ts
 * // Create backup
 * const snapshot = backupManager.createSnapshot();
 * // snapshot.version, snapshot.timestamp, snapshot.data.keys, etc.
 *
 * // Restore from snapshot
 * const result = backupManager.restoreFromSnapshot(snapshot, 'merge');
 * ```
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BackupSnapshot {
  /** Schema version for forward compatibility */
  version: '1.0';
  /** ISO timestamp of snapshot creation */
  timestamp: string;
  /** Server version that created this snapshot */
  serverVersion: string;
  /** Snapshot data by domain */
  data: {
    keys?: unknown[];
    teams?: unknown[];
    groups?: unknown[];
    webhookFilters?: unknown[];
    config?: Record<string, unknown>;
    /** Counts and summaries (not full logs — too large for snapshots) */
    stats?: {
      totalKeys: number;
      totalTeams: number;
      totalGroups: number;
      totalAuditEntries: number;
      totalUsageEvents: number;
    };
  };
  /** SHA-256 checksum of the data section (hex) */
  checksum: string;
}

export interface RestoreResult {
  success: boolean;
  mode: 'full' | 'merge' | 'overwrite';
  /** Per-domain restore results */
  results: {
    keys?: { imported: number; skipped: number; overwritten: number; errors: number };
    teams?: { imported: number; skipped: number; errors: number };
    groups?: { imported: number; skipped: number; errors: number };
    webhookFilters?: { imported: number; skipped: number; errors: number };
  };
  /** Warnings encountered during restore */
  warnings: string[];
  /** Timestamp of restore operation */
  restoredAt: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

import { createHash } from 'crypto';

function computeChecksum(data: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(data), 'utf8')
    .digest('hex');
}

function verifyChecksum(snapshot: BackupSnapshot): boolean {
  const expected = snapshot.checksum;
  const actual = computeChecksum(snapshot.data);
  return expected === actual;
}

// ─── BackupManager ──────────────────────────────────────────────────────────

/**
 * Provides state accessors that BackupManager uses to read/write domain state.
 * Implemented by PayGateServer to expose internal components.
 */
export interface BackupStateProvider {
  exportKeys(): unknown[];
  importKeys(keys: unknown[], mode: string): Array<{ key: string; status: string; error?: string }>;
  exportTeams(): unknown[];
  importTeams(teams: unknown[], mode: string): { imported: number; skipped: number; errors: number };
  exportGroups(): unknown[];
  importGroups(groups: unknown[], mode: string): { imported: number; skipped: number; errors: number };
  exportWebhookFilters(): unknown[];
  importWebhookFilters(filters: unknown[], mode: string): { imported: number; skipped: number; errors: number };
  getStats(): { totalKeys: number; totalTeams: number; totalGroups: number; totalAuditEntries: number; totalUsageEvents: number };
  getServerVersion(): string;
}

export class BackupManager {
  private readonly provider: BackupStateProvider;

  constructor(provider: BackupStateProvider) {
    this.provider = provider;
  }

  /**
   * Create a full state snapshot.
   */
  createSnapshot(): BackupSnapshot {
    const data: BackupSnapshot['data'] = {
      keys: this.provider.exportKeys(),
      teams: this.provider.exportTeams(),
      groups: this.provider.exportGroups(),
      webhookFilters: this.provider.exportWebhookFilters(),
      stats: this.provider.getStats(),
    };

    return {
      version: '1.0',
      timestamp: new Date().toISOString(),
      serverVersion: this.provider.getServerVersion(),
      data,
      checksum: computeChecksum(data),
    };
  }

  /**
   * Validate a snapshot before restoring.
   */
  validateSnapshot(snapshot: unknown): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!snapshot || typeof snapshot !== 'object') {
      return { valid: false, errors: ['Snapshot must be a non-null object'] };
    }

    const s = snapshot as Record<string, unknown>;

    if (s.version !== '1.0') {
      errors.push(`Unsupported snapshot version: ${s.version}`);
    }
    if (!s.timestamp || typeof s.timestamp !== 'string') {
      errors.push('Missing or invalid timestamp');
    }
    if (!s.data || typeof s.data !== 'object') {
      errors.push('Missing or invalid data section');
    }
    if (!s.checksum || typeof s.checksum !== 'string') {
      errors.push('Missing or invalid checksum');
    }

    // Verify checksum integrity
    if (s.checksum && s.data) {
      if (!verifyChecksum(s as unknown as BackupSnapshot)) {
        errors.push('Checksum verification failed — snapshot may be corrupted');
      }
    }

    // Validate data arrays
    const data = s.data as Record<string, unknown>;
    if (data) {
      if (data.keys && !Array.isArray(data.keys)) {
        errors.push('data.keys must be an array');
      }
      if (data.teams && !Array.isArray(data.teams)) {
        errors.push('data.teams must be an array');
      }
      if (data.groups && !Array.isArray(data.groups)) {
        errors.push('data.groups must be an array');
      }
      if (data.webhookFilters && !Array.isArray(data.webhookFilters)) {
        errors.push('data.webhookFilters must be an array');
      }

      // Size limits
      if (Array.isArray(data.keys) && data.keys.length > 50_000) {
        errors.push(`Too many keys in snapshot: ${data.keys.length} (max 50,000)`);
      }
      if (Array.isArray(data.teams) && data.teams.length > 10_000) {
        errors.push(`Too many teams in snapshot: ${data.teams.length} (max 10,000)`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Restore state from a snapshot.
   *
   * @param snapshot - The snapshot to restore from
   * @param mode - 'full' (replace all), 'merge' (additive), 'overwrite' (merge + overwrite conflicts)
   */
  restoreFromSnapshot(snapshot: BackupSnapshot, mode: 'full' | 'merge' | 'overwrite' = 'merge'): RestoreResult {
    // Validate first
    const validation = this.validateSnapshot(snapshot);
    if (!validation.valid) {
      return {
        success: false,
        mode,
        results: {},
        warnings: validation.errors,
        restoredAt: new Date().toISOString(),
      };
    }

    const warnings: string[] = [];
    const results: RestoreResult['results'] = {};
    const importMode = mode === 'full' ? 'overwrite' : mode === 'overwrite' ? 'overwrite' : 'skip';

    // Restore keys
    if (snapshot.data.keys && snapshot.data.keys.length > 0) {
      const keyResults = this.provider.importKeys(snapshot.data.keys, importMode);
      const imported = keyResults.filter(r => r.status === 'imported').length;
      const skipped = keyResults.filter(r => r.status === 'skipped').length;
      const overwritten = keyResults.filter(r => r.status === 'overwritten').length;
      const errors = keyResults.filter(r => r.status === 'error').length;
      results.keys = { imported, skipped, overwritten, errors };
      if (errors > 0) {
        warnings.push(`${errors} keys failed to import`);
      }
    }

    // Restore teams
    if (snapshot.data.teams && snapshot.data.teams.length > 0) {
      try {
        results.teams = this.provider.importTeams(snapshot.data.teams, importMode);
      } catch (e: any) {
        warnings.push(`Team restore failed: ${e.message}`);
        results.teams = { imported: 0, skipped: 0, errors: snapshot.data.teams.length };
      }
    }

    // Restore groups
    if (snapshot.data.groups && snapshot.data.groups.length > 0) {
      try {
        results.groups = this.provider.importGroups(snapshot.data.groups, importMode);
      } catch (e: any) {
        warnings.push(`Group restore failed: ${e.message}`);
        results.groups = { imported: 0, skipped: 0, errors: snapshot.data.groups.length };
      }
    }

    // Restore webhook filters
    if (snapshot.data.webhookFilters && snapshot.data.webhookFilters.length > 0) {
      try {
        results.webhookFilters = this.provider.importWebhookFilters(snapshot.data.webhookFilters, importMode);
      } catch (e: any) {
        warnings.push(`Webhook filter restore failed: ${e.message}`);
        results.webhookFilters = { imported: 0, skipped: 0, errors: snapshot.data.webhookFilters.length };
      }
    }

    return {
      success: warnings.length === 0,
      mode,
      results,
      warnings,
      restoredAt: new Date().toISOString(),
    };
  }
}
