/**
 * BatchCreditManager — Bulk credit operations.
 *
 * Supports batch top-ups, transfers, refunds, and adjustments
 * with atomic semantics (all-or-nothing per batch).
 *
 * @example
 * ```ts
 * const batch = new BatchCreditManager();
 *
 * // Bulk top-up
 * const result = batch.execute([
 *   { type: 'topup', key: 'key_a', amount: 1000, note: 'Monthly refill' },
 *   { type: 'topup', key: 'key_b', amount: 500 },
 * ]);
 *
 * // Transfer between keys
 * batch.execute([
 *   { type: 'transfer', fromKey: 'key_a', toKey: 'key_b', amount: 200, note: 'Team rebalance' },
 * ]);
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type BatchOpType = 'topup' | 'deduct' | 'transfer' | 'refund' | 'adjust';

export interface BatchTopup {
  type: 'topup';
  key: string;
  amount: number;
  note?: string;
}

export interface BatchDeduct {
  type: 'deduct';
  key: string;
  amount: number;
  note?: string;
}

export interface BatchTransfer {
  type: 'transfer';
  fromKey: string;
  toKey: string;
  amount: number;
  note?: string;
}

export interface BatchRefund {
  type: 'refund';
  key: string;
  amount: number;
  originalTxId?: string;
  note?: string;
}

export interface BatchAdjust {
  type: 'adjust';
  key: string;
  amount: number; // positive or negative
  reason: string;
}

export type BatchOp = BatchTopup | BatchDeduct | BatchTransfer | BatchRefund | BatchAdjust;

export interface BatchOpResult {
  index: number;
  op: BatchOp;
  success: boolean;
  error?: string;
  balanceBefore?: number;
  balanceAfter?: number;
}

export interface BatchExecutionResult {
  id: string;
  executedAt: string;
  totalOps: number;
  succeeded: number;
  failed: number;
  results: BatchOpResult[];
  rolledBack: boolean;
}

export interface BatchConfig {
  maxOpsPerBatch?: number;
  maxTransferAmount?: number;
  allowNegativeBalance?: boolean;
}

export interface BatchStats {
  totalBatches: number;
  totalOps: number;
  totalTopups: number;
  totalDeductions: number;
  totalTransfers: number;
  totalRefunds: number;
  totalAdjustments: number;
  totalFailed: number;
  totalRolledBack: number;
  trackedKeys: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class BatchCreditManager {
  private balances = new Map<string, number>();
  private history: BatchExecutionResult[] = [];
  private maxOpsPerBatch: number;
  private maxTransferAmount: number;
  private allowNegativeBalance: boolean;

  // Stats
  private totalBatches = 0;
  private totalOps = 0;
  private opCounts = { topup: 0, deduct: 0, transfer: 0, refund: 0, adjust: 0 };
  private totalFailed = 0;
  private totalRolledBack = 0;

  constructor(config: BatchConfig = {}) {
    this.maxOpsPerBatch = config.maxOpsPerBatch ?? 100;
    this.maxTransferAmount = config.maxTransferAmount ?? Infinity;
    this.allowNegativeBalance = config.allowNegativeBalance ?? false;
  }

  // ── Balance Management ──────────────────────────────────────────────

  /** Set balance for a key (seed / initialize). */
  setBalance(key: string, amount: number): void {
    this.balances.set(key, amount);
  }

  /** Get balance for a key. */
  getBalance(key: string): number {
    return this.balances.get(key) ?? 0;
  }

  /** Get all balances. */
  getAllBalances(): Map<string, number> {
    return new Map(this.balances);
  }

  // ── Batch Execution ─────────────────────────────────────────────────

  /**
   * Execute a batch of credit operations atomically.
   * If any op fails and `atomic` is true (default), all changes are rolled back.
   */
  execute(ops: BatchOp[], atomic = true): BatchExecutionResult {
    const id = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const executedAt = new Date().toISOString();

    // Validate batch size
    if (ops.length === 0) {
      return { id, executedAt, totalOps: 0, succeeded: 0, failed: 0, results: [], rolledBack: false };
    }

    if (ops.length > this.maxOpsPerBatch) {
      const results: BatchOpResult[] = ops.map((op, i) => ({
        index: i,
        op,
        success: false,
        error: `Batch exceeds max size (${this.maxOpsPerBatch})`,
      }));
      this.totalBatches++;
      this.totalFailed += ops.length;
      const result: BatchExecutionResult = { id, executedAt, totalOps: ops.length, succeeded: 0, failed: ops.length, results, rolledBack: false };
      this.history.push(result);
      return result;
    }

    // Snapshot for rollback
    const snapshot = new Map(this.balances);

    // Validate all ops first
    const validationErrors = this.validateOps(ops);
    if (validationErrors.length > 0 && atomic) {
      const results: BatchOpResult[] = ops.map((op, i) => ({
        index: i,
        op,
        success: false,
        error: validationErrors[i] || 'batch aborted due to other failures',
      }));
      this.totalBatches++;
      this.totalFailed += ops.length;
      this.totalRolledBack++;
      const result: BatchExecutionResult = { id, executedAt, totalOps: ops.length, succeeded: 0, failed: ops.length, results, rolledBack: true };
      this.history.push(result);
      return result;
    }

    // Execute ops
    const results: BatchOpResult[] = [];
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const opResult = this.executeOp(op, i);
      results.push(opResult);
      if (opResult.success) {
        succeeded++;
        this.opCounts[op.type]++;
      } else {
        failed++;
        if (atomic) {
          // Rollback all
          this.balances = new Map(snapshot);
          this.totalRolledBack++;
          // Mark remaining ops as failed
          for (let j = i + 1; j < ops.length; j++) {
            results.push({ index: j, op: ops[j], success: false, error: 'rolled back' });
            failed++;
          }
          // Mark previous successes as rolled back
          for (const r of results) {
            if (r.success) {
              r.success = false;
              r.error = 'rolled back';
              succeeded--;
              failed++;
            }
          }
          break;
        }
      }
    }

    this.totalBatches++;
    this.totalOps += ops.length;
    this.totalFailed += failed;

    const result: BatchExecutionResult = {
      id,
      executedAt,
      totalOps: ops.length,
      succeeded,
      failed,
      results,
      rolledBack: atomic && failed > 0,
    };
    this.history.push(result);
    return result;
  }

  /**
   * Dry-run: validate a batch without executing.
   * Returns validation errors (empty array = all valid).
   */
  validate(ops: BatchOp[]): string[] {
    return this.validateOps(ops);
  }

  // ── History ─────────────────────────────────────────────────────────

  /** Get batch execution history. */
  getHistory(limit?: number): BatchExecutionResult[] {
    const h = [...this.history].reverse();
    return limit ? h.slice(0, limit) : h;
  }

  /** Get a specific batch by ID. */
  getBatch(id: string): BatchExecutionResult | null {
    return this.history.find(b => b.id === id) ?? null;
  }

  // ── Stats ───────────────────────────────────────────────────────────

  getStats(): BatchStats {
    return {
      totalBatches: this.totalBatches,
      totalOps: this.totalOps,
      totalTopups: this.opCounts.topup,
      totalDeductions: this.opCounts.deduct,
      totalTransfers: this.opCounts.transfer,
      totalRefunds: this.opCounts.refund,
      totalAdjustments: this.opCounts.adjust,
      totalFailed: this.totalFailed,
      totalRolledBack: this.totalRolledBack,
      trackedKeys: this.balances.size,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.balances.clear();
    this.history = [];
    this.totalBatches = 0;
    this.totalOps = 0;
    this.opCounts = { topup: 0, deduct: 0, transfer: 0, refund: 0, adjust: 0 };
    this.totalFailed = 0;
    this.totalRolledBack = 0;
  }

  // ── Private ─────────────────────────────────────────────────────────

  private validateOps(ops: BatchOp[]): string[] {
    const errors: string[] = [];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const err = this.validateSingle(op);
      errors.push(err);
    }
    return errors.some(e => e !== '') ? errors : [];
  }

  private validateSingle(op: BatchOp): string {
    switch (op.type) {
      case 'topup':
        if (op.amount <= 0) return 'topup amount must be positive';
        if (!op.key) return 'key required';
        return '';
      case 'deduct':
        if (op.amount <= 0) return 'deduct amount must be positive';
        if (!op.key) return 'key required';
        if (!this.allowNegativeBalance) {
          const bal = this.getBalance(op.key);
          if (bal < op.amount) return `insufficient balance (has ${bal}, needs ${op.amount})`;
        }
        return '';
      case 'transfer':
        if (op.amount <= 0) return 'transfer amount must be positive';
        if (!op.fromKey || !op.toKey) return 'fromKey and toKey required';
        if (op.fromKey === op.toKey) return 'cannot transfer to same key';
        if (op.amount > this.maxTransferAmount) return `exceeds max transfer amount (${this.maxTransferAmount})`;
        if (!this.allowNegativeBalance) {
          const fromBal = this.getBalance(op.fromKey);
          if (fromBal < op.amount) return `insufficient balance on source key (has ${fromBal}, needs ${op.amount})`;
        }
        return '';
      case 'refund':
        if (op.amount <= 0) return 'refund amount must be positive';
        if (!op.key) return 'key required';
        return '';
      case 'adjust':
        if (!op.key) return 'key required';
        if (!op.reason) return 'reason required for adjustments';
        if (!this.allowNegativeBalance && op.amount < 0) {
          const bal = this.getBalance(op.key);
          if (bal + op.amount < 0) return `adjustment would result in negative balance`;
        }
        return '';
      default:
        return `unknown operation type`;
    }
  }

  private executeOp(op: BatchOp, index: number): BatchOpResult {
    const err = this.validateSingle(op);
    if (err) {
      return { index, op, success: false, error: err };
    }

    switch (op.type) {
      case 'topup': {
        const before = this.getBalance(op.key);
        this.balances.set(op.key, before + op.amount);
        return { index, op, success: true, balanceBefore: before, balanceAfter: before + op.amount };
      }
      case 'deduct': {
        const before = this.getBalance(op.key);
        this.balances.set(op.key, before - op.amount);
        return { index, op, success: true, balanceBefore: before, balanceAfter: before - op.amount };
      }
      case 'transfer': {
        const fromBefore = this.getBalance(op.fromKey);
        const toBefore = this.getBalance(op.toKey);
        this.balances.set(op.fromKey, fromBefore - op.amount);
        this.balances.set(op.toKey, toBefore + op.amount);
        return { index, op, success: true, balanceBefore: fromBefore, balanceAfter: fromBefore - op.amount };
      }
      case 'refund': {
        const before = this.getBalance(op.key);
        this.balances.set(op.key, before + op.amount);
        return { index, op, success: true, balanceBefore: before, balanceAfter: before + op.amount };
      }
      case 'adjust': {
        const before = this.getBalance(op.key);
        this.balances.set(op.key, before + op.amount);
        return { index, op, success: true, balanceBefore: before, balanceAfter: before + op.amount };
      }
      default:
        return { index, op, success: false, error: 'unknown op type' };
    }
  }
}
