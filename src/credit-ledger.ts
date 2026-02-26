/**
 * CreditLedger — Per-key credit mutation history.
 *
 * Records credit balance changes (topup, deduction, transfer, auto-topup, refund,
 * initial allocation) with before/after snapshots. Capped at last N entries per key.
 */

export interface CreditEntry {
  timestamp: string;
  type: 'initial' | 'topup' | 'deduction' | 'transfer_in' | 'transfer_out' | 'auto_topup' | 'refund' | 'bulk_topup';
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  tool?: string;
  memo?: string;
}

export class CreditLedger {
  private entries = new Map<string, CreditEntry[]>();
  private maxEntriesPerKey: number;

  constructor(maxEntriesPerKey = 100) {
    this.maxEntriesPerKey = maxEntriesPerKey;
  }

  /**
   * Record a credit mutation for a key.
   */
  record(key: string, entry: Omit<CreditEntry, 'timestamp'>): void {
    if (!this.entries.has(key)) {
      this.entries.set(key, []);
    }
    const list = this.entries.get(key)!;
    list.push({
      ...entry,
      timestamp: new Date().toISOString(),
    });
    // Cap at max entries
    if (list.length > this.maxEntriesPerKey) {
      list.splice(0, list.length - this.maxEntriesPerKey);
    }
  }

  /**
   * Get credit history for a key, newest first.
   * Optionally filter by type and limit.
   */
  getHistory(key: string, opts?: { type?: string; limit?: number; since?: string }): CreditEntry[] {
    const list = this.entries.get(key);
    if (!list || list.length === 0) return [];

    let result = [...list].reverse(); // newest first

    if (opts?.type) {
      result = result.filter(e => e.type === opts.type);
    }
    if (opts?.since) {
      result = result.filter(e => e.timestamp >= opts.since!);
    }
    if (opts?.limit && opts.limit > 0) {
      result = result.slice(0, opts.limit);
    }

    return result;
  }

  /**
   * Get entry count for a key.
   */
  count(key: string): number {
    return this.entries.get(key)?.length || 0;
  }

  /**
   * Clear all entries for a key.
   */
  clear(key: string): void {
    this.entries.delete(key);
  }
}
