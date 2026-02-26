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

  /**
   * Compute spending velocity and depletion forecast for a key.
   * Analyzes credit debit entries (deduction, transfer_out) over a rolling window.
   */
  getSpendingVelocity(key: string, currentBalance: number, windowHours = 24): SpendingVelocity {
    const list = this.entries.get(key);
    if (!list || list.length === 0) {
      return {
        creditsPerHour: 0,
        creditsPerDay: 0,
        callsPerHour: 0,
        callsPerDay: 0,
        estimatedDepletionDate: null,
        estimatedHoursRemaining: null,
        windowHours,
        dataPoints: 0,
      };
    }

    const now = Date.now();
    const cutoff = new Date(now - windowHours * 3_600_000).toISOString();

    // Debit types reduce balance
    const debitTypes = new Set(['deduction', 'transfer_out']);
    const debits = list.filter(e => debitTypes.has(e.type) && e.timestamp >= cutoff);

    const totalDebited = debits.reduce((sum, e) => sum + e.amount, 0);
    const debitCount = debits.length;

    // Compute the actual time span of debits (if any)
    let spanHours = windowHours;
    if (debits.length >= 2) {
      const oldest = new Date(debits[0].timestamp).getTime();
      const newest = new Date(debits[debits.length - 1].timestamp).getTime();
      const span = (newest - oldest) / 3_600_000;
      if (span > 0) spanHours = span;
    } else if (debits.length === 1) {
      // Single debit — use time from debit to now as span
      const debitTime = new Date(debits[0].timestamp).getTime();
      const span = (now - debitTime) / 3_600_000;
      if (span > 0.01) spanHours = span; // At least ~36 seconds
    }

    const creditsPerHour = debits.length > 0 ? totalDebited / spanHours : 0;
    const creditsPerDay = creditsPerHour * 24;
    const callsPerHour = debits.length > 0 ? debitCount / spanHours : 0;
    const callsPerDay = callsPerHour * 24;

    let estimatedDepletionDate: string | null = null;
    let estimatedHoursRemaining: number | null = null;

    if (creditsPerHour > 0 && currentBalance > 0) {
      estimatedHoursRemaining = Math.round((currentBalance / creditsPerHour) * 100) / 100;
      const depletionMs = now + estimatedHoursRemaining * 3_600_000;
      estimatedDepletionDate = new Date(depletionMs).toISOString();
    } else if (currentBalance <= 0) {
      estimatedHoursRemaining = 0;
      estimatedDepletionDate = new Date(now).toISOString();
    }

    return {
      creditsPerHour: Math.round(creditsPerHour * 100) / 100,
      creditsPerDay: Math.round(creditsPerDay * 100) / 100,
      callsPerHour: Math.round(callsPerHour * 100) / 100,
      callsPerDay: Math.round(callsPerDay * 100) / 100,
      estimatedDepletionDate,
      estimatedHoursRemaining,
      windowHours,
      dataPoints: debits.length,
    };
  }
}

export interface SpendingVelocity {
  creditsPerHour: number;
  creditsPerDay: number;
  callsPerHour: number;
  callsPerDay: number;
  estimatedDepletionDate: string | null;
  estimatedHoursRemaining: number | null;
  windowHours: number;
  dataPoints: number;
}
