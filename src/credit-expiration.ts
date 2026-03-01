/**
 * CreditExpirationManager — Time-based credit expiration with FIFO consumption.
 *
 * Grant credits with expiration dates, consume oldest credits first,
 * and track expiring-soon grants for proactive notifications.
 *
 * @example
 * ```ts
 * const mgr = new CreditExpirationManager();
 *
 * mgr.grant({ key: 'k1', amount: 100, expiresInMs: 86400000 }); // 24h
 * mgr.grant({ key: 'k1', amount: 50, expiresInMs: 172800000 });  // 48h
 *
 * const result = mgr.consume('k1', 120);
 * // Uses all 100 from first grant + 20 from second
 * // result.consumed === 120, result.remaining === 30
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface CreditGrant {
  id: string;
  key: string;
  originalAmount: number;
  remainingAmount: number;
  grantedAt: number;
  expiresAt: number;
  expired: boolean;
  source: string;
}

export interface CreditGrantParams {
  key: string;
  amount: number;
  expiresInMs: number;
  source?: string;
}

export interface CreditConsumeResult {
  key: string;
  requested: number;
  consumed: number;
  remaining: number;
  grantsUsed: number;
  timestamp: number;
}

export interface ExpiringGrant {
  id: string;
  key: string;
  remainingAmount: number;
  expiresAt: number;
  expiresInMs: number;
}

export interface CreditExpirationConfig {
  /** Max grants per key. Default 100. */
  maxGrantsPerKey?: number;
  /** Max tracked keys. Default 10000. */
  maxKeys?: number;
}

export interface CreditExpirationStats {
  trackedKeys: number;
  totalGrants: number;
  activeGrants: number;
  expiredGrants: number;
  totalGranted: number;
  totalConsumed: number;
  totalExpired: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class CreditExpirationManager {
  private grants = new Map<string, CreditGrant[]>();
  private nextId = 1;
  private maxGrantsPerKey: number;
  private maxKeys: number;

  // Stats
  private totalGranted = 0;
  private totalConsumed = 0;
  private totalExpiredAmount = 0;

  constructor(config: CreditExpirationConfig = {}) {
    this.maxGrantsPerKey = config.maxGrantsPerKey ?? 100;
    this.maxKeys = config.maxKeys ?? 10_000;
  }

  // ── Grant Management ────────────────────────────────────────────

  /** Grant credits with expiration. */
  grant(params: CreditGrantParams): CreditGrant {
    if (params.amount <= 0) throw new Error('Amount must be positive');
    if (params.expiresInMs <= 0) throw new Error('Expiration must be positive');

    let keyGrants = this.grants.get(params.key);
    if (!keyGrants) {
      if (this.grants.size >= this.maxKeys) {
        throw new Error(`Maximum ${this.maxKeys} keys reached`);
      }
      keyGrants = [];
      this.grants.set(params.key, keyGrants);
    }

    if (keyGrants.length >= this.maxGrantsPerKey) {
      // Remove expired grants first
      this.pruneExpired(params.key);
      keyGrants = this.grants.get(params.key) ?? [];
      if (keyGrants.length >= this.maxGrantsPerKey) {
        throw new Error(`Maximum ${this.maxGrantsPerKey} grants per key reached`);
      }
    }

    const now = Date.now();
    const grant: CreditGrant = {
      id: `cg_${this.nextId++}`,
      key: params.key,
      originalAmount: params.amount,
      remainingAmount: params.amount,
      grantedAt: now,
      expiresAt: now + params.expiresInMs,
      expired: false,
      source: params.source ?? '',
    };

    keyGrants.push(grant);
    this.totalGranted += params.amount;
    return grant;
  }

  // ── Consumption ─────────────────────────────────────────────────

  /** Consume credits from a key (FIFO — oldest grants first). */
  consume(key: string, amount: number): CreditConsumeResult {
    if (amount <= 0) throw new Error('Amount must be positive');
    this.pruneExpired(key);

    const keyGrants = this.grants.get(key);
    if (!keyGrants) {
      return { key, requested: amount, consumed: 0, remaining: 0, grantsUsed: 0, timestamp: Date.now() };
    }

    // Sort by expiration (earliest first = FIFO)
    const active = keyGrants
      .filter(g => !g.expired && g.remainingAmount > 0)
      .sort((a, b) => a.expiresAt - b.expiresAt);

    let consumed = 0;
    let grantsUsed = 0;
    let remaining = amount;

    for (const grant of active) {
      if (remaining <= 0) break;

      const take = Math.min(remaining, grant.remainingAmount);
      grant.remainingAmount -= take;
      consumed += take;
      remaining -= take;
      grantsUsed++;
    }

    this.totalConsumed += consumed;

    // Calculate total remaining balance
    const totalRemaining = keyGrants
      .filter(g => !g.expired)
      .reduce((sum, g) => sum + g.remainingAmount, 0);

    return {
      key,
      requested: amount,
      consumed,
      remaining: totalRemaining,
      grantsUsed,
      timestamp: Date.now(),
    };
  }

  // ── Query ───────────────────────────────────────────────────────

  /** Get available balance for a key. */
  getBalance(key: string): number {
    this.pruneExpired(key);
    const keyGrants = this.grants.get(key);
    if (!keyGrants) return 0;
    return keyGrants
      .filter(g => !g.expired)
      .reduce((sum, g) => sum + g.remainingAmount, 0);
  }

  /** Get active grants for a key. */
  getGrants(key: string): CreditGrant[] {
    this.pruneExpired(key);
    return (this.grants.get(key) ?? []).filter(g => !g.expired && g.remainingAmount > 0);
  }

  /** Get grants expiring within a time window. */
  getExpiringSoon(withinMs: number): ExpiringGrant[] {
    const now = Date.now();
    const deadline = now + withinMs;
    const results: ExpiringGrant[] = [];

    for (const keyGrants of this.grants.values()) {
      for (const g of keyGrants) {
        if (!g.expired && g.remainingAmount > 0 && g.expiresAt <= deadline && g.expiresAt > now) {
          results.push({
            id: g.id,
            key: g.key,
            remainingAmount: g.remainingAmount,
            expiresAt: g.expiresAt,
            expiresInMs: g.expiresAt - now,
          });
        }
      }
    }

    return results.sort((a, b) => a.expiresAt - b.expiresAt);
  }

  /** Force expire all grants for a key. */
  expireAll(key: string): number {
    const keyGrants = this.grants.get(key);
    if (!keyGrants) return 0;

    let expired = 0;
    for (const g of keyGrants) {
      if (!g.expired && g.remainingAmount > 0) {
        this.totalExpiredAmount += g.remainingAmount;
        g.remainingAmount = 0;
        g.expired = true;
        expired++;
      }
    }
    return expired;
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): CreditExpirationStats {
    let totalGrants = 0;
    let activeGrants = 0;
    let expiredGrants = 0;

    for (const keyGrants of this.grants.values()) {
      for (const g of keyGrants) {
        totalGrants++;
        if (g.expired || g.expiresAt <= Date.now()) {
          expiredGrants++;
        } else if (g.remainingAmount > 0) {
          activeGrants++;
        }
      }
    }

    return {
      trackedKeys: this.grants.size,
      totalGrants,
      activeGrants,
      expiredGrants,
      totalGranted: this.totalGranted,
      totalConsumed: this.totalConsumed,
      totalExpired: this.totalExpiredAmount,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.grants.clear();
    this.totalGranted = 0;
    this.totalConsumed = 0;
    this.totalExpiredAmount = 0;
  }

  // ── Private ───────────────────────────────────────────────────

  private pruneExpired(key: string): void {
    const keyGrants = this.grants.get(key);
    if (!keyGrants) return;

    const now = Date.now();
    for (const g of keyGrants) {
      if (!g.expired && g.expiresAt <= now) {
        this.totalExpiredAmount += g.remainingAmount;
        g.remainingAmount = 0;
        g.expired = true;
      }
    }
  }
}
