/**
 * CreditTransferManager — Transfer credits between API keys with audit trail.
 *
 * Enable credit transfers between keys, enforce balance checks,
 * and maintain a complete audit trail of all transfers.
 *
 * @example
 * ```ts
 * const mgr = new CreditTransferManager();
 *
 * mgr.setBalance('key_alice', 1000);
 * mgr.setBalance('key_bob', 200);
 *
 * const result = mgr.transfer({
 *   fromKey: 'key_alice',
 *   toKey: 'key_bob',
 *   amount: 100,
 *   reason: 'Team rebalance',
 * });
 * // Alice: 900, Bob: 300
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface TransferRecord {
  id: string;
  fromKey: string;
  toKey: string;
  amount: number;
  reason: string;
  fromBalanceBefore: number;
  fromBalanceAfter: number;
  toBalanceBefore: number;
  toBalanceAfter: number;
  createdAt: number;
  reversedAt: number | null;
  reversalId: string | null;
}

export interface TransferParams {
  fromKey: string;
  toKey: string;
  amount: number;
  reason?: string;
}

export interface CreditTransferConfig {
  /** Max transfer history. Default 10000. */
  maxHistory?: number;
  /** Minimum transfer amount. Default 1. */
  minAmount?: number;
  /** Maximum single transfer amount. Default Infinity. */
  maxAmount?: number;
  /** Allow overdraft (negative balance). Default false. */
  allowOverdraft?: boolean;
}

export interface CreditTransferStats {
  trackedKeys: number;
  totalTransfers: number;
  totalReversals: number;
  totalAmountTransferred: number;
  totalBalance: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class CreditTransferManager {
  private balances = new Map<string, number>();
  private history: TransferRecord[] = [];
  private nextId = 1;

  private maxHistory: number;
  private minAmount: number;
  private maxAmount: number;
  private allowOverdraft: boolean;

  constructor(config: CreditTransferConfig = {}) {
    this.maxHistory = config.maxHistory ?? 10_000;
    this.minAmount = config.minAmount ?? 1;
    this.maxAmount = config.maxAmount ?? Infinity;
    this.allowOverdraft = config.allowOverdraft ?? false;
  }

  // ── Balance Management ─────────────────────────────────────────

  /** Set a key's balance. */
  setBalance(key: string, balance: number): void {
    this.balances.set(key, balance);
  }

  /** Get a key's balance. */
  getBalance(key: string): number | null {
    return this.balances.get(key) ?? null;
  }

  /** Add credits to a key. */
  addCredits(key: string, amount: number): number {
    if (amount <= 0) throw new Error('Amount must be positive');
    const current = this.balances.get(key) ?? 0;
    const newBalance = current + amount;
    this.balances.set(key, newBalance);
    return newBalance;
  }

  // ── Transfer ───────────────────────────────────────────────────

  /** Transfer credits from one key to another. */
  transfer(params: TransferParams): TransferRecord {
    if (!params.fromKey) throw new Error('fromKey is required');
    if (!params.toKey) throw new Error('toKey is required');
    if (params.fromKey === params.toKey) throw new Error('Cannot transfer to same key');
    if (params.amount < this.minAmount) throw new Error(`Amount must be at least ${this.minAmount}`);
    if (params.amount > this.maxAmount) throw new Error(`Amount cannot exceed ${this.maxAmount}`);

    const fromBalance = this.balances.get(params.fromKey);
    if (fromBalance === undefined) throw new Error(`Key '${params.fromKey}' not found`);
    const toBalance = this.balances.get(params.toKey);
    if (toBalance === undefined) throw new Error(`Key '${params.toKey}' not found`);

    if (!this.allowOverdraft && fromBalance < params.amount) {
      throw new Error(`Insufficient balance: ${fromBalance} < ${params.amount}`);
    }

    const newFromBalance = fromBalance - params.amount;
    const newToBalance = toBalance + params.amount;

    this.balances.set(params.fromKey, newFromBalance);
    this.balances.set(params.toKey, newToBalance);

    const record: TransferRecord = {
      id: `xfer_${this.nextId++}`,
      fromKey: params.fromKey,
      toKey: params.toKey,
      amount: params.amount,
      reason: params.reason ?? '',
      fromBalanceBefore: fromBalance,
      fromBalanceAfter: newFromBalance,
      toBalanceBefore: toBalance,
      toBalanceAfter: newToBalance,
      createdAt: Date.now(),
      reversedAt: null,
      reversalId: null,
    };

    this.history.push(record);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }

    return record;
  }

  /** Reverse a transfer. */
  reverse(transferId: string, reason?: string): TransferRecord {
    const original = this.history.find(r => r.id === transferId);
    if (!original) throw new Error(`Transfer '${transferId}' not found`);
    if (original.reversedAt) throw new Error(`Transfer '${transferId}' already reversed`);

    const reversal = this.transfer({
      fromKey: original.toKey,
      toKey: original.fromKey,
      amount: original.amount,
      reason: reason ?? `Reversal of ${transferId}`,
    });

    original.reversedAt = Date.now();
    original.reversalId = reversal.id;
    return reversal;
  }

  // ── Query ──────────────────────────────────────────────────────

  /** Get transfer history for a key. */
  getKeyHistory(key: string, limit = 50): TransferRecord[] {
    return this.history
      .filter(r => r.fromKey === key || r.toKey === key)
      .slice(-limit);
  }

  /** Get all transfer history. */
  getHistory(limit = 50): TransferRecord[] {
    return this.history.slice(-limit);
  }

  /** Get a transfer by ID. */
  getTransfer(id: string): TransferRecord | null {
    return this.history.find(r => r.id === id) ?? null;
  }

  /** List all tracked keys with balances. */
  listBalances(): { key: string; balance: number }[] {
    return [...this.balances.entries()]
      .map(([key, balance]) => ({ key, balance }))
      .sort((a, b) => b.balance - a.balance);
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): CreditTransferStats {
    let totalAmount = 0;
    let totalBalance = 0;
    let reversals = 0;

    for (const r of this.history) {
      totalAmount += r.amount;
      if (r.reversedAt) reversals++;
    }
    for (const b of this.balances.values()) totalBalance += b;

    return {
      trackedKeys: this.balances.size,
      totalTransfers: this.history.length,
      totalReversals: reversals,
      totalAmountTransferred: totalAmount,
      totalBalance,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.balances.clear();
    this.history = [];
  }
}
