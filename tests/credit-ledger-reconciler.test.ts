import { CreditLedgerReconciler } from '../src/credit-ledger-reconciler';

describe('CreditLedgerReconciler', () => {
  let reconciler: CreditLedgerReconciler;

  beforeEach(() => {
    reconciler = new CreditLedgerReconciler();
  });

  afterEach(() => {
    reconciler.destroy();
  });

  // ── Ledger Operations ──────────────────────────────────────────────

  describe('ledger operations', () => {
    it('records a grant', () => {
      const entry = reconciler.recordGrant('k1', 1000, 'initial');
      expect(entry.id).toMatch(/^le_/);
      expect(entry.type).toBe('grant');
      expect(entry.amount).toBe(1000);
      expect(entry.balanceAfter).toBe(1000);
    });

    it('records a debit', () => {
      reconciler.recordGrant('k1', 1000, 'initial');
      const entry = reconciler.recordDebit('k1', 200, 'tool_call');
      expect(entry.type).toBe('debit');
      expect(entry.amount).toBe(-200);
      expect(entry.balanceAfter).toBe(800);
    });

    it('records an adjustment', () => {
      reconciler.recordGrant('k1', 1000, 'initial');
      const entry = reconciler.recordAdjustment('k1', -50, 'correction');
      expect(entry.type).toBe('adjustment');
      expect(entry.balanceAfter).toBe(950);
    });

    it('records a refund', () => {
      reconciler.recordGrant('k1', 1000, 'initial');
      reconciler.recordDebit('k1', 300, 'tool_call');
      const entry = reconciler.recordRefund('k1', 100, 'error_refund');
      expect(entry.type).toBe('refund');
      expect(entry.balanceAfter).toBe(800);
    });

    it('rejects non-positive grant', () => {
      expect(() => reconciler.recordGrant('k1', 0, 'bad')).toThrow();
    });

    it('rejects non-positive debit', () => {
      expect(() => reconciler.recordDebit('k1', 0, 'bad')).toThrow();
    });

    it('rejects non-positive refund', () => {
      expect(() => reconciler.recordRefund('k1', 0, 'bad')).toThrow();
    });
  });

  // ── Reconciliation ─────────────────────────────────────────────────

  describe('reconciliation', () => {
    it('reconciles matching balance', () => {
      reconciler.recordGrant('k1', 1000, 'initial');
      reconciler.recordDebit('k1', 200, 'use');
      const result = reconciler.reconcile('k1', 800);
      expect(result.balanced).toBe(true);
      expect(result.discrepancy).toBe(0);
    });

    it('detects discrepancy', () => {
      reconciler.recordGrant('k1', 1000, 'initial');
      reconciler.recordDebit('k1', 200, 'use');
      const result = reconciler.reconcile('k1', 750);
      expect(result.balanced).toBe(false);
      expect(result.discrepancy).toBe(50);
      expect(result.ledgerBalance).toBe(800);
      expect(result.reportedBalance).toBe(750);
    });

    it('reconciles unknown key with zero', () => {
      const result = reconciler.reconcile('unknown', 0);
      expect(result.balanced).toBe(true);
    });

    it('reconciles unknown key with non-zero', () => {
      const result = reconciler.reconcile('unknown', 100);
      expect(result.balanced).toBe(false);
      expect(result.discrepancy).toBe(100);
    });
  });

  // ── Query ──────────────────────────────────────────────────────────

  describe('query', () => {
    beforeEach(() => {
      reconciler.recordGrant('k1', 1000, 'initial');
      reconciler.recordDebit('k1', 200, 'tool_call');
      reconciler.recordRefund('k1', 50, 'error');
      reconciler.recordGrant('k2', 500, 'initial');
    });

    it('gets balance for key', () => {
      expect(reconciler.getBalance('k1')).toBe(850);
      expect(reconciler.getBalance('unknown')).toBe(0);
    });

    it('gets entries for key', () => {
      expect(reconciler.getEntries('k1')).toHaveLength(3);
      expect(reconciler.getEntries('unknown')).toEqual([]);
    });

    it('gets entries by type', () => {
      expect(reconciler.getEntriesByType('k1', 'grant')).toHaveLength(1);
      expect(reconciler.getEntriesByType('k1', 'debit')).toHaveLength(1);
      expect(reconciler.getEntriesByType('k1', 'refund')).toHaveLength(1);
    });

    it('gets all balances', () => {
      const balances = reconciler.getAllBalances();
      expect(balances).toHaveLength(2);
    });

    it('removes a key', () => {
      expect(reconciler.removeKey('k1')).toBe(true);
      expect(reconciler.getBalance('k1')).toBe(0);
      expect(reconciler.removeKey('k1')).toBe(false);
    });
  });

  // ── Stats & Destroy ────────────────────────────────────────────────

  describe('stats and destroy', () => {
    it('tracks comprehensive stats', () => {
      reconciler.recordGrant('k1', 1000, 'initial');
      reconciler.recordDebit('k1', 200, 'use');
      reconciler.recordRefund('k1', 50, 'err');
      reconciler.recordAdjustment('k1', -10, 'fix');
      reconciler.reconcile('k1', 840);
      reconciler.reconcile('k1', 800); // discrepancy

      const stats = reconciler.getStats();
      expect(stats.totalEntries).toBe(4);
      expect(stats.totalGrants).toBe(1);
      expect(stats.totalDebits).toBe(1);
      expect(stats.totalRefunds).toBe(1);
      expect(stats.totalAdjustments).toBe(1);
      expect(stats.reconciliationCount).toBe(2);
      expect(stats.discrepancyCount).toBe(1);
    });

    it('destroy resets everything', () => {
      reconciler.recordGrant('k1', 100, 'test');
      reconciler.destroy();
      expect(reconciler.getStats().trackedKeys).toBe(0);
      expect(reconciler.getStats().totalGrants).toBe(0);
    });
  });
});
