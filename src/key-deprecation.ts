/**
 * APIKeyDeprecation — Manage key deprecation schedules with sunset dates.
 *
 * Schedule keys for deprecation with warning periods, sunset dates,
 * and migration guidance.
 *
 * @example
 * ```ts
 * const dep = new APIKeyDeprecation();
 *
 * dep.deprecateKey({
 *   key: 'old_key_1',
 *   sunsetAt: Date.now() + 30 * 86400000, // 30 days
 *   reason: 'Migrating to v2 API keys',
 *   replacement: 'new_key_1',
 * });
 *
 * const status = dep.getKeyStatus('old_key_1');
 * // { status: 'deprecated', daysUntilSunset: 30, ... }
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type DeprecationStatus = 'active' | 'deprecated' | 'sunset' | 'expired';

export interface DeprecationRecord {
  id: string;
  key: string;
  status: DeprecationStatus;
  reason: string;
  replacement?: string;
  deprecatedAt: number;
  sunsetAt: number;
  expiredAt?: number;
  notifiedAt?: number;
}

export interface DeprecateKeyParams {
  key: string;
  sunsetAt: number;
  reason: string;
  replacement?: string;
}

export interface DeprecationKeyStatus {
  key: string;
  status: DeprecationStatus;
  reason: string;
  replacement?: string;
  daysUntilSunset: number;
  sunsetAt: number;
  deprecatedAt: number;
}

export interface DeprecationQuery {
  status?: DeprecationStatus;
  expiringSoon?: number; // days threshold
  limit?: number;
}

export interface APIKeyDeprecationConfig {
  /** Max tracked keys. Default 10000. */
  maxKeys?: number;
}

export interface APIKeyDeprecationStats {
  totalTracked: number;
  activeCount: number;
  deprecatedCount: number;
  sunsetCount: number;
  expiredCount: number;
  avgDaysToSunset: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class APIKeyDeprecation {
  private records = new Map<string, DeprecationRecord>();
  private nextId = 1;
  private maxKeys: number;

  constructor(config: APIKeyDeprecationConfig = {}) {
    this.maxKeys = config.maxKeys ?? 10_000;
  }

  // ── Deprecation Management ─────────────────────────────────────

  /** Schedule a key for deprecation. */
  deprecateKey(params: DeprecateKeyParams): DeprecationRecord {
    if (!params.key) throw new Error('Key is required');
    if (!params.reason) throw new Error('Reason is required');
    if (params.sunsetAt <= Date.now()) throw new Error('Sunset date must be in the future');
    if (this.records.has(params.key)) throw new Error(`Key '${params.key}' already has a deprecation record`);
    if (this.records.size >= this.maxKeys) throw new Error(`Maximum ${this.maxKeys} keys reached`);

    const record: DeprecationRecord = {
      id: `dep_${this.nextId++}`,
      key: params.key,
      status: 'deprecated',
      reason: params.reason,
      replacement: params.replacement,
      deprecatedAt: Date.now(),
      sunsetAt: params.sunsetAt,
    };

    this.records.set(params.key, record);
    return record;
  }

  /** Cancel a deprecation. */
  cancelDeprecation(key: string): boolean {
    return this.records.delete(key);
  }

  /** Mark a key as expired (post-sunset). */
  expireKey(key: string): boolean {
    const record = this.records.get(key);
    if (!record) return false;
    record.status = 'expired';
    record.expiredAt = Date.now();
    return true;
  }

  /** Update sunset date. */
  extendSunset(key: string, newSunsetAt: number): DeprecationRecord | null {
    const record = this.records.get(key);
    if (!record) return null;
    if (newSunsetAt <= Date.now()) throw new Error('New sunset date must be in the future');
    record.sunsetAt = newSunsetAt;
    return record;
  }

  // ── Query ──────────────────────────────────────────────────────

  /** Get deprecation status for a key. */
  getKeyStatus(key: string): DeprecationKeyStatus | null {
    const record = this.records.get(key);
    if (!record) return null;

    this.updateStatus(record);

    const daysUntilSunset = Math.max(0, Math.ceil((record.sunsetAt - Date.now()) / 86_400_000));
    return {
      key: record.key,
      status: record.status,
      reason: record.reason,
      replacement: record.replacement,
      daysUntilSunset,
      sunsetAt: record.sunsetAt,
      deprecatedAt: record.deprecatedAt,
    };
  }

  /** Get the raw record. */
  getRecord(key: string): DeprecationRecord | null {
    const record = this.records.get(key);
    if (record) this.updateStatus(record);
    return record ?? null;
  }

  /** Query deprecation records. */
  query(params: DeprecationQuery = {}): DeprecationKeyStatus[] {
    const results: DeprecationKeyStatus[] = [];

    for (const record of this.records.values()) {
      this.updateStatus(record);
      const daysUntilSunset = Math.max(0, Math.ceil((record.sunsetAt - Date.now()) / 86_400_000));

      if (params.status && record.status !== params.status) continue;
      if (params.expiringSoon !== undefined && daysUntilSunset > params.expiringSoon) continue;

      results.push({
        key: record.key,
        status: record.status,
        reason: record.reason,
        replacement: record.replacement,
        daysUntilSunset,
        sunsetAt: record.sunsetAt,
        deprecatedAt: record.deprecatedAt,
      });
    }

    return results.slice(0, params.limit ?? 50);
  }

  /** Get keys expiring within N days. */
  getExpiringSoon(days: number): DeprecationKeyStatus[] {
    return this.query({ expiringSoon: days });
  }

  /** Check if a key is deprecated. */
  isDeprecated(key: string): boolean {
    const record = this.records.get(key);
    if (!record) return false;
    this.updateStatus(record);
    return record.status !== 'active';
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): APIKeyDeprecationStats {
    let active = 0, deprecated = 0, sunset = 0, expired = 0;
    let totalDays = 0;
    let deprecatedOrSunsetCount = 0;

    for (const record of this.records.values()) {
      this.updateStatus(record);
      switch (record.status) {
        case 'active': active++; break;
        case 'deprecated': deprecated++; break;
        case 'sunset': sunset++; break;
        case 'expired': expired++; break;
      }
      if (record.status === 'deprecated' || record.status === 'sunset') {
        totalDays += Math.max(0, Math.ceil((record.sunsetAt - Date.now()) / 86_400_000));
        deprecatedOrSunsetCount++;
      }
    }

    return {
      totalTracked: this.records.size,
      activeCount: active,
      deprecatedCount: deprecated,
      sunsetCount: sunset,
      expiredCount: expired,
      avgDaysToSunset: deprecatedOrSunsetCount > 0 ? Math.round(totalDays / deprecatedOrSunsetCount) : 0,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.records.clear();
  }

  // ── Private ────────────────────────────────────────────────────

  private updateStatus(record: DeprecationRecord): void {
    if (record.status === 'expired') return;
    if (Date.now() >= record.sunsetAt) {
      record.status = 'sunset';
    }
  }
}
