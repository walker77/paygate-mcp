/**
 * KeyMigrationManager — Migrate API keys between tiers/profiles with rollback.
 *
 * Plan and execute key migrations between tiers, track migration history,
 * and support rollback of failed migrations.
 *
 * @example
 * ```ts
 * const mgr = new KeyMigrationManager();
 *
 * const plan = mgr.planMigration({
 *   keys: ['key_abc', 'key_xyz'],
 *   fromTier: 'free',
 *   toTier: 'pro',
 *   reason: 'Upgrade batch',
 * });
 *
 * mgr.executeMigration(plan.id);
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type MigrationStatus = 'planned' | 'executing' | 'completed' | 'failed' | 'rolled_back';

export interface Migration {
  id: string;
  keys: string[];
  fromTier: string;
  toTier: string;
  reason: string;
  status: MigrationStatus;
  migratedKeys: string[];
  failedKeys: { key: string; error: string }[];
  createdAt: number;
  executedAt: number | null;
  completedAt: number | null;
  rolledBackAt: number | null;
}

export interface MigrationPlanParams {
  keys: string[];
  fromTier: string;
  toTier: string;
  reason?: string;
}

export interface MigrationHandler {
  /** Called for each key during migration. Return true on success. */
  migrate: (key: string, fromTier: string, toTier: string) => boolean;
  /** Called for each key during rollback. */
  rollback: (key: string, fromTier: string, toTier: string) => boolean;
}

export interface KeyMigrationConfig {
  /** Max migrations to track. Default 1000. */
  maxMigrations?: number;
}

export interface KeyMigrationStats {
  totalMigrations: number;
  planned: number;
  completed: number;
  failed: number;
  rolledBack: number;
  totalKeysMigrated: number;
  totalKeysFailed: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class KeyMigrationManager {
  private migrations = new Map<string, Migration>();
  private handler: MigrationHandler | null = null;
  private nextId = 1;

  private maxMigrations: number;

  constructor(config: KeyMigrationConfig = {}) {
    this.maxMigrations = config.maxMigrations ?? 1000;
  }

  /** Set the migration handler. */
  setHandler(handler: MigrationHandler): void {
    this.handler = handler;
  }

  // ── Migration Lifecycle ───────────────────────────────────────

  /** Plan a migration (does not execute). */
  planMigration(params: MigrationPlanParams): Migration {
    if (!params.keys.length) throw new Error('At least one key is required');
    if (!params.fromTier) throw new Error('fromTier is required');
    if (!params.toTier) throw new Error('toTier is required');
    if (params.fromTier === params.toTier) throw new Error('fromTier and toTier must be different');
    if (this.migrations.size >= this.maxMigrations) {
      throw new Error(`Maximum ${this.maxMigrations} migrations reached`);
    }

    const migration: Migration = {
      id: `mig_${this.nextId++}`,
      keys: [...params.keys],
      fromTier: params.fromTier,
      toTier: params.toTier,
      reason: params.reason ?? '',
      status: 'planned',
      migratedKeys: [],
      failedKeys: [],
      createdAt: Date.now(),
      executedAt: null,
      completedAt: null,
      rolledBackAt: null,
    };

    this.migrations.set(migration.id, migration);
    return migration;
  }

  /** Execute a planned migration. */
  executeMigration(id: string): Migration {
    const mig = this.migrations.get(id);
    if (!mig) throw new Error(`Migration '${id}' not found`);
    if (mig.status !== 'planned') throw new Error(`Migration '${id}' is not in planned state`);

    mig.status = 'executing';
    mig.executedAt = Date.now();

    for (const key of mig.keys) {
      try {
        const success = this.handler
          ? this.handler.migrate(key, mig.fromTier, mig.toTier)
          : true;

        if (success) {
          mig.migratedKeys.push(key);
        } else {
          mig.failedKeys.push({ key, error: 'Migration handler returned false' });
        }
      } catch (e) {
        mig.failedKeys.push({ key, error: String(e) });
      }
    }

    mig.status = mig.failedKeys.length === 0 ? 'completed' : 'failed';
    mig.completedAt = Date.now();
    return mig;
  }

  /** Rollback a completed or failed migration. */
  rollbackMigration(id: string): Migration {
    const mig = this.migrations.get(id);
    if (!mig) throw new Error(`Migration '${id}' not found`);
    if (mig.status !== 'completed' && mig.status !== 'failed') {
      throw new Error(`Migration '${id}' cannot be rolled back from '${mig.status}' state`);
    }

    for (const key of mig.migratedKeys) {
      try {
        if (this.handler) {
          this.handler.rollback(key, mig.fromTier, mig.toTier);
        }
      } catch {
        // Best effort rollback
      }
    }

    mig.status = 'rolled_back';
    mig.rolledBackAt = Date.now();
    return mig;
  }

  // ── Query ─────────────────────────────────────────────────────

  /** Get migration by ID. */
  getMigration(id: string): Migration | null {
    return this.migrations.get(id) ?? null;
  }

  /** List migrations with optional status filter. */
  listMigrations(status?: MigrationStatus): Migration[] {
    const all = [...this.migrations.values()];
    return status ? all.filter(m => m.status === status) : all;
  }

  /** Remove a migration record. */
  removeMigration(id: string): boolean {
    return this.migrations.delete(id);
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): KeyMigrationStats {
    let planned = 0, completed = 0, failed = 0, rolledBack = 0;
    let totalMigrated = 0, totalFailed = 0;

    for (const m of this.migrations.values()) {
      switch (m.status) {
        case 'planned': planned++; break;
        case 'completed': completed++; break;
        case 'failed': failed++; break;
        case 'rolled_back': rolledBack++; break;
      }
      totalMigrated += m.migratedKeys.length;
      totalFailed += m.failedKeys.length;
    }

    return {
      totalMigrations: this.migrations.size,
      planned, completed, failed, rolledBack,
      totalKeysMigrated: totalMigrated,
      totalKeysFailed: totalFailed,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.migrations.clear();
  }
}
