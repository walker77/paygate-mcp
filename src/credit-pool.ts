/**
 * CreditPoolManager — Shared credit pools across multiple API keys.
 *
 * Create named pools with credit budgets and allow multiple keys
 * to draw from the same pool.
 *
 * @example
 * ```ts
 * const pools = new CreditPoolManager();
 *
 * pools.createPool({ name: 'team-budget', credits: 10000 });
 * pools.addMember('pool_1', 'key_a');
 * pools.addMember('pool_1', 'key_b');
 *
 * pools.consume('pool_1', 'key_a', 500);
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface CreditPool {
  id: string;
  name: string;
  totalCredits: number;
  usedCredits: number;
  members: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CreditPoolCreateParams {
  name: string;
  credits: number;
}

export interface PoolConsumption {
  id: string;
  poolId: string;
  key: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  timestamp: number;
}

export interface PoolStatus {
  id: string;
  name: string;
  totalCredits: number;
  usedCredits: number;
  remainingCredits: number;
  percentUsed: number;
  memberCount: number;
}

export interface CreditPoolConfig {
  /** Max pools. Default 500. */
  maxPools?: number;
  /** Max members per pool. Default 500. */
  maxMembersPerPool?: number;
  /** Max consumption history. Default 10000. */
  maxHistory?: number;
}

export interface CreditPoolStats {
  totalPools: number;
  totalMembers: number;
  totalCreditsAllocated: number;
  totalCreditsUsed: number;
  avgUtilization: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class CreditPoolManager {
  private pools = new Map<string, CreditPool>();
  private keyToPools = new Map<string, Set<string>>(); // key -> pool IDs
  private history: PoolConsumption[] = [];
  private nextPoolId = 1;
  private nextConsumptionId = 1;
  private maxPools: number;
  private maxMembersPerPool: number;
  private maxHistory: number;

  constructor(config: CreditPoolConfig = {}) {
    this.maxPools = config.maxPools ?? 500;
    this.maxMembersPerPool = config.maxMembersPerPool ?? 500;
    this.maxHistory = config.maxHistory ?? 10_000;
  }

  // ── Pool Management ────────────────────────────────────────────

  /** Create a credit pool. */
  createPool(params: CreditPoolCreateParams): CreditPool {
    if (!params.name) throw new Error('Pool name is required');
    if (params.credits <= 0) throw new Error('Credits must be positive');
    if (this.pools.size >= this.maxPools) throw new Error(`Maximum ${this.maxPools} pools reached`);

    // Check duplicate names
    for (const p of this.pools.values()) {
      if (p.name === params.name) throw new Error(`Pool '${params.name}' already exists`);
    }

    const now = Date.now();
    const pool: CreditPool = {
      id: `pool_${this.nextPoolId++}`,
      name: params.name,
      totalCredits: params.credits,
      usedCredits: 0,
      members: [],
      createdAt: now,
      updatedAt: now,
    };

    this.pools.set(pool.id, pool);
    return pool;
  }

  /** Get a pool by ID. */
  getPool(id: string): CreditPool | null {
    return this.pools.get(id) ?? null;
  }

  /** Delete a pool. */
  deletePool(id: string): boolean {
    const pool = this.pools.get(id);
    if (!pool) return false;

    for (const key of pool.members) {
      const pools = this.keyToPools.get(key);
      if (pools) {
        pools.delete(id);
        if (pools.size === 0) this.keyToPools.delete(key);
      }
    }

    return this.pools.delete(id);
  }

  /** Add credits to a pool. */
  addCredits(poolId: string, amount: number): CreditPool | null {
    const pool = this.pools.get(poolId);
    if (!pool) return null;
    if (amount <= 0) throw new Error('Amount must be positive');
    pool.totalCredits += amount;
    pool.updatedAt = Date.now();
    return pool;
  }

  // ── Membership ─────────────────────────────────────────────────

  /** Add a key to a pool. */
  addMember(poolId: string, key: string): boolean {
    const pool = this.pools.get(poolId);
    if (!pool) throw new Error(`Pool '${poolId}' not found`);
    if (pool.members.includes(key)) return false;
    if (pool.members.length >= this.maxMembersPerPool) {
      throw new Error(`Maximum ${this.maxMembersPerPool} members per pool reached`);
    }

    pool.members.push(key);
    pool.updatedAt = Date.now();

    let pools = this.keyToPools.get(key);
    if (!pools) {
      pools = new Set();
      this.keyToPools.set(key, pools);
    }
    pools.add(poolId);

    return true;
  }

  /** Remove a key from a pool. */
  removeMember(poolId: string, key: string): boolean {
    const pool = this.pools.get(poolId);
    if (!pool) return false;

    const idx = pool.members.indexOf(key);
    if (idx === -1) return false;

    pool.members.splice(idx, 1);
    pool.updatedAt = Date.now();

    const pools = this.keyToPools.get(key);
    if (pools) {
      pools.delete(poolId);
      if (pools.size === 0) this.keyToPools.delete(key);
    }

    return true;
  }

  /** Get all pools a key belongs to. */
  getKeyPools(key: string): CreditPool[] {
    const poolIds = this.keyToPools.get(key);
    if (!poolIds) return [];
    return [...poolIds].map(id => this.pools.get(id)!).filter(Boolean);
  }

  // ── Credit Operations ──────────────────────────────────────────

  /** Consume credits from a pool. */
  consume(poolId: string, key: string, amount: number): PoolConsumption | null {
    const pool = this.pools.get(poolId);
    if (!pool) return null;
    if (!pool.members.includes(key)) return null;
    if (amount <= 0) throw new Error('Amount must be positive');

    const remaining = pool.totalCredits - pool.usedCredits;
    if (amount > remaining) return null; // insufficient

    const balanceBefore = remaining;
    pool.usedCredits += amount;
    pool.updatedAt = Date.now();

    const consumption: PoolConsumption = {
      id: `pc_${this.nextConsumptionId++}`,
      poolId,
      key,
      amount,
      balanceBefore,
      balanceAfter: pool.totalCredits - pool.usedCredits,
      timestamp: Date.now(),
    };

    this.history.push(consumption);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }

    return consumption;
  }

  /** Get remaining credits in a pool. */
  getRemaining(poolId: string): number {
    const pool = this.pools.get(poolId);
    if (!pool) return 0;
    return Math.max(0, pool.totalCredits - pool.usedCredits);
  }

  // ── Query ──────────────────────────────────────────────────────

  /** Get pool status. */
  getPoolStatus(poolId: string): PoolStatus | null {
    const pool = this.pools.get(poolId);
    if (!pool) return null;

    const remaining = pool.totalCredits - pool.usedCredits;
    return {
      id: pool.id,
      name: pool.name,
      totalCredits: pool.totalCredits,
      usedCredits: pool.usedCredits,
      remainingCredits: Math.max(0, remaining),
      percentUsed: Math.round((pool.usedCredits / pool.totalCredits) * 10000) / 100,
      memberCount: pool.members.length,
    };
  }

  /** Get consumption history for a pool. */
  getHistory(poolId: string, limit?: number): PoolConsumption[] {
    return this.history
      .filter(h => h.poolId === poolId)
      .slice(-(limit ?? 50));
  }

  /** List all pools. */
  listPools(): CreditPool[] {
    return [...this.pools.values()];
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): CreditPoolStats {
    let totalMembers = 0;
    let totalAllocated = 0;
    let totalUsed = 0;

    for (const pool of this.pools.values()) {
      totalMembers += pool.members.length;
      totalAllocated += pool.totalCredits;
      totalUsed += pool.usedCredits;
    }

    return {
      totalPools: this.pools.size,
      totalMembers,
      totalCreditsAllocated: totalAllocated,
      totalCreditsUsed: totalUsed,
      avgUtilization: totalAllocated > 0 ? Math.round((totalUsed / totalAllocated) * 10000) / 100 : 0,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.pools.clear();
    this.keyToPools.clear();
    this.history = [];
  }
}
