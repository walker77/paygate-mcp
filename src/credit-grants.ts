/**
 * Prepaid Credit Grants — Named credit grants with expiration, priority, and rollover.
 *
 * Extends the simple balance -= cost model with named credit grants that:
 *   - Expire at a configurable date
 *   - Have priority ordering (grants with earlier expiry consume first)
 *   - Support rollover into new grants before expiration
 *   - Track usage per grant for billing reconciliation
 *
 * This is modeled after OpenMeter and Orb's prepaid credit systems.
 *
 * Example:
 *   const manager = new CreditGrantManager();
 *   manager.createGrant('key-1', {
 *     id: 'welcome-100',
 *     name: 'Welcome Credits',
 *     amount: 100,
 *     expiresAt: '2026-04-01T00:00:00Z',
 *     priority: 1,
 *   });
 *
 *   const result = manager.deduct('key-1', 15, 'readFile');
 *   // → deducts from highest-priority unexpired grant first
 *
 * Zero external dependencies.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CreditGrant {
  /** Unique grant ID. */
  id: string;
  /** Human-readable name (e.g., 'Welcome Credits', 'Monthly Allowance'). */
  name: string;
  /** Original amount allocated. */
  amount: number;
  /** Remaining balance in this grant. */
  balance: number;
  /** Credits consumed from this grant. */
  used: number;
  /** Priority for consumption order. Lower = consumed first. */
  priority: number;
  /** ISO date when this grant expires. Null = never expires. */
  expiresAt: string | null;
  /** ISO date when this grant was created. */
  createdAt: string;
  /** Whether this grant is active. Expired/voided grants are inactive. */
  active: boolean;
  /** Whether this grant was rolled over from another grant. */
  rolledOverFrom?: string;
  /** Arbitrary metadata. */
  metadata?: Record<string, string>;
  /** Last deduction timestamp. */
  lastUsedAt?: string;
}

export interface GrantCreateParams {
  /** Unique grant ID. Auto-generated if not provided. */
  id?: string;
  /** Human-readable name. */
  name: string;
  /** Credit amount. */
  amount: number;
  /** Priority for consumption order. Lower = consumed first. Default: 10. */
  priority?: number;
  /** ISO date when this grant expires. Null = never. */
  expiresAt?: string | null;
  /** Arbitrary metadata. */
  metadata?: Record<string, string>;
}

export interface DeductResult {
  /** Whether full amount was successfully deducted. */
  success: boolean;
  /** Total credits deducted (may be less than requested if insufficient). */
  totalDeducted: number;
  /** Per-grant breakdown of deductions. */
  breakdown: Array<{ grantId: string; grantName: string; amount: number }>;
  /** Remaining balance across all active grants. */
  remainingBalance: number;
  /** Shortfall if deduction failed. */
  shortfall: number;
}

export interface RolloverResult {
  /** New grant created from rollover. */
  newGrant: CreditGrant;
  /** Original grant that was rolled over. */
  sourceGrant: CreditGrant;
  /** Credits rolled over. */
  creditsRolled: number;
  /** Credits that were expired/lost (if partial rollover). */
  creditsLost: number;
}

export interface GrantSummary {
  /** Total grants for this key (all statuses). */
  totalGrants: number;
  /** Active (non-expired, non-voided) grants. */
  activeGrants: number;
  /** Expired grants. */
  expiredGrants: number;
  /** Total balance across all active grants. */
  totalBalance: number;
  /** Total used across all grants. */
  totalUsed: number;
  /** Nearest expiration date among active grants. */
  nearestExpiry: string | null;
  /** Grants sorted by consumption order. */
  grantsByPriority: CreditGrant[];
}

export interface CreditGrantStats {
  /** Total keys with grants. */
  totalKeys: number;
  /** Total grants across all keys. */
  totalGrants: number;
  /** Total active grants. */
  activeGrants: number;
  /** Total expired grants. */
  expiredGrants: number;
  /** Total credits allocated. */
  totalAllocated: number;
  /** Total credits consumed. */
  totalConsumed: number;
  /** Total credits expired (lost). */
  totalExpired: number;
  /** Total deduction operations. */
  totalDeductions: number;
  /** Total rollovers performed. */
  totalRollovers: number;
}

// ─── Credit Grant Manager ────────────────────────────────────────────────────

export class CreditGrantManager {
  private grants: Map<string, CreditGrant[]> = new Map(); // key → grants[]
  private stats: CreditGrantStats = {
    totalKeys: 0,
    totalGrants: 0,
    activeGrants: 0,
    expiredGrants: 0,
    totalAllocated: 0,
    totalConsumed: 0,
    totalExpired: 0,
    totalDeductions: 0,
    totalRollovers: 0,
  };

  /**
   * Create a named credit grant for a key.
   */
  createGrant(key: string, params: GrantCreateParams): CreditGrant {
    if (!this.grants.has(key)) {
      this.grants.set(key, []);
      this.stats.totalKeys++;
    }

    const grant: CreditGrant = {
      id: params.id ?? `grant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: params.name,
      amount: params.amount,
      balance: params.amount,
      used: 0,
      priority: params.priority ?? 10,
      expiresAt: params.expiresAt ?? null,
      createdAt: new Date().toISOString(),
      active: true,
      metadata: params.metadata,
    };

    this.grants.get(key)!.push(grant);
    this.stats.totalGrants++;
    this.stats.activeGrants++;
    this.stats.totalAllocated += params.amount;

    return { ...grant };
  }

  /**
   * Deduct credits from a key's grants.
   * Consumes from highest-priority (lowest number) unexpired grant first.
   * If a single grant doesn't have enough, spills over to the next.
   */
  deduct(key: string, amount: number, tool?: string): DeductResult {
    const result: DeductResult = {
      success: false,
      totalDeducted: 0,
      breakdown: [],
      remainingBalance: 0,
      shortfall: 0,
    };

    const grants = this.grants.get(key);
    if (!grants || grants.length === 0) {
      result.shortfall = amount;
      return result;
    }

    // Expire stale grants first
    this.expireGrants(key);

    // Get active grants sorted by priority (ascending), then by expiry (soonest first)
    const active = grants
      .filter(g => g.active && g.balance > 0)
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        // Among same priority, consume soonest-expiring first
        if (a.expiresAt && b.expiresAt) return a.expiresAt.localeCompare(b.expiresAt);
        if (a.expiresAt) return -1; // expiring before non-expiring
        if (b.expiresAt) return 1;
        return 0;
      });

    // Check total available
    const totalAvailable = active.reduce((sum, g) => sum + g.balance, 0);
    if (totalAvailable < amount) {
      result.shortfall = amount - totalAvailable;
      result.remainingBalance = totalAvailable;
      return result;
    }

    // Deduct from grants in order
    let remaining = amount;
    const now = new Date().toISOString();

    for (const grant of active) {
      if (remaining <= 0) break;

      const deductFromThis = Math.min(grant.balance, remaining);
      grant.balance -= deductFromThis;
      grant.used += deductFromThis;
      grant.lastUsedAt = now;
      remaining -= deductFromThis;

      result.breakdown.push({
        grantId: grant.id,
        grantName: grant.name,
        amount: deductFromThis,
      });

      result.totalDeducted += deductFromThis;
    }

    result.success = true;
    result.remainingBalance = active.reduce((sum, g) => sum + g.balance, 0);
    this.stats.totalConsumed += result.totalDeducted;
    this.stats.totalDeductions++;

    return result;
  }

  /**
   * Refund credits back to a specific grant.
   */
  refund(key: string, grantId: string, amount: number): boolean {
    const grants = this.grants.get(key);
    if (!grants) return false;

    const grant = grants.find(g => g.id === grantId);
    if (!grant) return false;

    const refundable = Math.min(amount, grant.used);
    grant.balance += refundable;
    grant.used -= refundable;
    this.stats.totalConsumed -= refundable;
    return true;
  }

  /**
   * Rollover remaining balance from a grant into a new grant.
   * Useful before expiration to preserve credits.
   *
   * @param key - API key
   * @param sourceGrantId - Grant to roll over from
   * @param newParams - Parameters for the new grant (amount will be overridden with rollover amount)
   * @param percentage - Percentage of balance to roll over (0-100). Default: 100.
   */
  rollover(key: string, sourceGrantId: string, newParams: GrantCreateParams, percentage: number = 100): RolloverResult | null {
    const grants = this.grants.get(key);
    if (!grants) return null;

    const source = grants.find(g => g.id === sourceGrantId);
    if (!source || source.balance <= 0) return null;

    const pct = Math.max(0, Math.min(100, percentage));
    const rolloverAmount = Math.floor(source.balance * (pct / 100));
    const lost = source.balance - rolloverAmount;

    // Deactivate source
    source.active = false;
    this.stats.activeGrants--;
    this.stats.expiredGrants++;
    this.stats.totalExpired += lost;

    // Credit the remaining balance as consumed from source
    source.balance = 0;

    // Create new grant with rolled-over amount
    const newGrant = this.createGrant(key, {
      ...newParams,
      amount: rolloverAmount,
    });
    newGrant.rolledOverFrom = sourceGrantId;

    // Update the actual grant object (createGrant returns a copy)
    const actual = grants.find(g => g.id === newGrant.id);
    if (actual) actual.rolledOverFrom = sourceGrantId;

    this.stats.totalRollovers++;

    return {
      newGrant,
      sourceGrant: { ...source },
      creditsRolled: rolloverAmount,
      creditsLost: lost,
    };
  }

  /**
   * Expire grants that have passed their expiration date.
   * Called automatically during deductions, but can be called manually.
   */
  expireGrants(key: string): number {
    const grants = this.grants.get(key);
    if (!grants) return 0;

    const now = new Date().toISOString();
    let expired = 0;

    for (const grant of grants) {
      if (grant.active && grant.expiresAt && grant.expiresAt <= now) {
        grant.active = false;
        this.stats.activeGrants--;
        this.stats.expiredGrants++;
        this.stats.totalExpired += grant.balance;
        grant.balance = 0;
        expired++;
      }
    }

    return expired;
  }

  /**
   * Expire all grants across all keys.
   */
  expireAll(): number {
    let total = 0;
    for (const key of this.grants.keys()) {
      total += this.expireGrants(key);
    }
    return total;
  }

  /**
   * Get a specific grant.
   */
  getGrant(key: string, grantId: string): CreditGrant | null {
    const grants = this.grants.get(key);
    if (!grants) return null;
    const grant = grants.find(g => g.id === grantId);
    return grant ? { ...grant } : null;
  }

  /**
   * Get all grants for a key.
   */
  getGrants(key: string, opts?: { active?: boolean }): CreditGrant[] {
    const grants = this.grants.get(key);
    if (!grants) return [];

    let result = grants.map(g => ({ ...g }));
    if (opts?.active !== undefined) {
      result = result.filter(g => g.active === opts.active);
    }
    return result;
  }

  /**
   * Get summary for a key's grants.
   */
  getSummary(key: string): GrantSummary {
    this.expireGrants(key);
    const grants = this.grants.get(key) ?? [];
    const active = grants.filter(g => g.active);
    const expired = grants.filter(g => !g.active);

    // Sort active by consumption order
    const sorted = [...active].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.expiresAt && b.expiresAt) return a.expiresAt.localeCompare(b.expiresAt);
      if (a.expiresAt) return -1;
      if (b.expiresAt) return 1;
      return 0;
    });

    const expiringGrants = active.filter(g => g.expiresAt);
    const nearestExpiry = expiringGrants.length > 0
      ? expiringGrants.reduce((min, g) => g.expiresAt! < min ? g.expiresAt! : min, expiringGrants[0].expiresAt!)
      : null;

    return {
      totalGrants: grants.length,
      activeGrants: active.length,
      expiredGrants: expired.length,
      totalBalance: active.reduce((sum, g) => sum + g.balance, 0),
      totalUsed: grants.reduce((sum, g) => sum + g.used, 0),
      nearestExpiry,
      grantsByPriority: sorted.map(g => ({ ...g })),
    };
  }

  /**
   * Get total available balance across all active grants for a key.
   */
  getBalance(key: string): number {
    this.expireGrants(key);
    const grants = this.grants.get(key);
    if (!grants) return 0;
    return grants.filter(g => g.active).reduce((sum, g) => sum + g.balance, 0);
  }

  /**
   * Void a grant (cancel it, mark remaining as lost).
   */
  voidGrant(key: string, grantId: string): boolean {
    const grants = this.grants.get(key);
    if (!grants) return false;

    const grant = grants.find(g => g.id === grantId && g.active);
    if (!grant) return false;

    this.stats.totalExpired += grant.balance;
    grant.balance = 0;
    grant.active = false;
    this.stats.activeGrants--;
    this.stats.expiredGrants++;
    return true;
  }

  /**
   * Remove all grants for a key.
   */
  clearGrants(key: string): void {
    const grants = this.grants.get(key);
    if (grants) {
      for (const g of grants) {
        if (g.active) this.stats.activeGrants--;
        else this.stats.expiredGrants--;
      }
      this.stats.totalGrants -= grants.length;
      this.stats.totalKeys--;
    }
    this.grants.delete(key);
  }

  /**
   * Get stats.
   */
  getStats(): CreditGrantStats {
    return { ...this.stats };
  }

  /**
   * Export all grants as a serializable object.
   */
  exportAll(): Record<string, CreditGrant[]> {
    const result: Record<string, CreditGrant[]> = {};
    for (const [key, grants] of this.grants) {
      result[key] = grants.map(g => ({ ...g }));
    }
    return result;
  }

  /**
   * Import grants from a serialized object.
   */
  importAll(data: Record<string, CreditGrant[]>): void {
    for (const [key, grants] of Object.entries(data)) {
      this.grants.set(key, grants.map(g => ({ ...g })));
      this.stats.totalKeys++;
      this.stats.totalGrants += grants.length;
      for (const g of grants) {
        if (g.active) this.stats.activeGrants++;
        else this.stats.expiredGrants++;
        this.stats.totalAllocated += g.amount;
        this.stats.totalConsumed += g.used;
      }
    }
  }

  /**
   * Destroy and release all resources.
   */
  destroy(): void {
    this.grants.clear();
    this.stats = {
      totalKeys: 0,
      totalGrants: 0,
      activeGrants: 0,
      expiredGrants: 0,
      totalAllocated: 0,
      totalConsumed: 0,
      totalExpired: 0,
      totalDeductions: 0,
      totalRollovers: 0,
    };
  }
}
