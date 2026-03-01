/**
 * CreditLedgerReconciler — Reconcile credit ledger entries with expected balances.
 *
 * Track credit operations (grants, debits, adjustments) and
 * detect discrepancies between ledger totals and reported balances.
 *
 * @example
 * ```ts
 * const reconciler = new CreditLedgerReconciler();
 *
 * reconciler.recordGrant('k1', 1000, 'initial');
 * reconciler.recordDebit('k1', 200, 'tool_call');
 *
 * const result = reconciler.reconcile('k1', 800); // expected balance
 * // { balanced: true, ledgerBalance: 800, reportedBalance: 800 }
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type LedgerEntryType = 'grant' | 'debit' | 'adjustment' | 'refund';

export interface LedgerEntry {
  id: string;
  key: string;
  type: LedgerEntryType;
  amount: number;
  reason: string;
  timestamp: number;
  balanceAfter: number;
}

export interface ReconciliationResult {
  key: string;
  balanced: boolean;
  ledgerBalance: number;
  reportedBalance: number;
  discrepancy: number;
  entryCount: number;
  lastEntry: LedgerEntry | null;
  reconciledAt: number;
}

export interface CreditLedgerReconcilerConfig {
  /** Max tracked keys. Default 10000. */
  maxKeys?: number;
  /** Max entries per key. Default 5000. */
  maxEntriesPerKey?: number;
}

export interface CreditLedgerReconcilerStats {
  trackedKeys: number;
  totalEntries: number;
  totalGrants: number;
  totalDebits: number;
  totalAdjustments: number;
  totalRefunds: number;
  reconciliationCount: number;
  discrepancyCount: number;
}

// ── Implementation ───────────────────────────────────────────────────

interface KeyLedger {
  entries: LedgerEntry[];
  balance: number;
}

export class CreditLedgerReconciler {
  private ledgers = new Map<string, KeyLedger>();
  private nextId = 1;
  private maxKeys: number;
  private maxEntriesPerKey: number;

  // Stats
  private totalGrants = 0;
  private totalDebits = 0;
  private totalAdjustments = 0;
  private totalRefunds = 0;
  private reconciliationCount = 0;
  private discrepancyCount = 0;

  constructor(config: CreditLedgerReconcilerConfig = {}) {
    this.maxKeys = config.maxKeys ?? 10_000;
    this.maxEntriesPerKey = config.maxEntriesPerKey ?? 5000;
  }

  // ── Ledger Operations ──────────────────────────────────────────

  /** Record a credit grant. */
  recordGrant(key: string, amount: number, reason: string): LedgerEntry {
    if (amount <= 0) throw new Error('Grant amount must be positive');
    this.totalGrants++;
    return this.addEntry(key, 'grant', amount, reason);
  }

  /** Record a credit debit. */
  recordDebit(key: string, amount: number, reason: string): LedgerEntry {
    if (amount <= 0) throw new Error('Debit amount must be positive');
    this.totalDebits++;
    return this.addEntry(key, 'debit', -amount, reason);
  }

  /** Record a manual adjustment. */
  recordAdjustment(key: string, amount: number, reason: string): LedgerEntry {
    this.totalAdjustments++;
    return this.addEntry(key, 'adjustment', amount, reason);
  }

  /** Record a refund. */
  recordRefund(key: string, amount: number, reason: string): LedgerEntry {
    if (amount <= 0) throw new Error('Refund amount must be positive');
    this.totalRefunds++;
    return this.addEntry(key, 'refund', amount, reason);
  }

  // ── Reconciliation ─────────────────────────────────────────────

  /** Reconcile ledger balance with reported balance. */
  reconcile(key: string, reportedBalance: number): ReconciliationResult {
    const ledger = this.ledgers.get(key);
    const ledgerBalance = ledger?.balance ?? 0;
    const discrepancy = Math.abs(ledgerBalance - reportedBalance);
    const balanced = discrepancy === 0;

    this.reconciliationCount++;
    if (!balanced) this.discrepancyCount++;

    return {
      key,
      balanced,
      ledgerBalance,
      reportedBalance,
      discrepancy,
      entryCount: ledger?.entries.length ?? 0,
      lastEntry: ledger?.entries[ledger.entries.length - 1] ?? null,
      reconciledAt: Date.now(),
    };
  }

  // ── Query ──────────────────────────────────────────────────────

  /** Get ledger balance for a key. */
  getBalance(key: string): number {
    return this.ledgers.get(key)?.balance ?? 0;
  }

  /** Get ledger entries for a key. */
  getEntries(key: string, limit?: number): LedgerEntry[] {
    const ledger = this.ledgers.get(key);
    if (!ledger) return [];
    return ledger.entries.slice(-(limit ?? 100));
  }

  /** Get entries by type for a key. */
  getEntriesByType(key: string, type: LedgerEntryType): LedgerEntry[] {
    const ledger = this.ledgers.get(key);
    if (!ledger) return [];
    return ledger.entries.filter(e => e.type === type);
  }

  /** Get all tracked keys with balances. */
  getAllBalances(): { key: string; balance: number; entryCount: number }[] {
    return [...this.ledgers.entries()].map(([key, ledger]) => ({
      key,
      balance: ledger.balance,
      entryCount: ledger.entries.length,
    }));
  }

  /** Remove a key's ledger. */
  removeKey(key: string): boolean {
    return this.ledgers.delete(key);
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): CreditLedgerReconcilerStats {
    let totalEntries = 0;
    for (const ledger of this.ledgers.values()) totalEntries += ledger.entries.length;

    return {
      trackedKeys: this.ledgers.size,
      totalEntries,
      totalGrants: this.totalGrants,
      totalDebits: this.totalDebits,
      totalAdjustments: this.totalAdjustments,
      totalRefunds: this.totalRefunds,
      reconciliationCount: this.reconciliationCount,
      discrepancyCount: this.discrepancyCount,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.ledgers.clear();
    this.totalGrants = 0;
    this.totalDebits = 0;
    this.totalAdjustments = 0;
    this.totalRefunds = 0;
    this.reconciliationCount = 0;
    this.discrepancyCount = 0;
  }

  // ── Private ────────────────────────────────────────────────────

  private addEntry(key: string, type: LedgerEntryType, amount: number, reason: string): LedgerEntry {
    let ledger = this.ledgers.get(key);
    if (!ledger) {
      if (this.ledgers.size >= this.maxKeys) throw new Error(`Maximum ${this.maxKeys} keys reached`);
      ledger = { entries: [], balance: 0 };
      this.ledgers.set(key, ledger);
    }

    ledger.balance += amount;

    const entry: LedgerEntry = {
      id: `le_${this.nextId++}`,
      key,
      type,
      amount,
      reason,
      timestamp: Date.now(),
      balanceAfter: ledger.balance,
    };

    ledger.entries.push(entry);
    if (ledger.entries.length > this.maxEntriesPerKey) {
      ledger.entries.splice(0, ledger.entries.length - this.maxEntriesPerKey);
    }

    return entry;
  }
}
