import { CreditTransferManager } from '../src/credit-transfer';

describe('CreditTransferManager', () => {
  let mgr: CreditTransferManager;

  beforeEach(() => {
    mgr = new CreditTransferManager();
  });

  afterEach(() => {
    mgr.destroy();
  });

  // ── Balance Management ──────────────────────────────────────────

  describe('balance management', () => {
    it('sets and gets balance', () => {
      mgr.setBalance('k1', 1000);
      expect(mgr.getBalance('k1')).toBe(1000);
    });

    it('returns null for unknown key', () => {
      expect(mgr.getBalance('unknown')).toBeNull();
    });

    it('adds credits to existing balance', () => {
      mgr.setBalance('k1', 100);
      const newBal = mgr.addCredits('k1', 50);
      expect(newBal).toBe(150);
      expect(mgr.getBalance('k1')).toBe(150);
    });

    it('adds credits to new key (starts at 0)', () => {
      const newBal = mgr.addCredits('k1', 200);
      expect(newBal).toBe(200);
    });

    it('rejects negative addCredits', () => {
      expect(() => mgr.addCredits('k1', -10)).toThrow('positive');
    });
  });

  // ── Transfer ────────────────────────────────────────────────────

  describe('transfer', () => {
    it('transfers credits between keys', () => {
      mgr.setBalance('alice', 1000);
      mgr.setBalance('bob', 200);

      const record = mgr.transfer({ fromKey: 'alice', toKey: 'bob', amount: 300 });

      expect(record.id).toMatch(/^xfer_/);
      expect(record.fromBalanceBefore).toBe(1000);
      expect(record.fromBalanceAfter).toBe(700);
      expect(record.toBalanceBefore).toBe(200);
      expect(record.toBalanceAfter).toBe(500);
      expect(mgr.getBalance('alice')).toBe(700);
      expect(mgr.getBalance('bob')).toBe(500);
    });

    it('records reason', () => {
      mgr.setBalance('a', 100);
      mgr.setBalance('b', 0);
      const record = mgr.transfer({ fromKey: 'a', toKey: 'b', amount: 50, reason: 'team rebalance' });
      expect(record.reason).toBe('team rebalance');
    });

    it('rejects transfer to same key', () => {
      mgr.setBalance('k1', 100);
      expect(() => mgr.transfer({ fromKey: 'k1', toKey: 'k1', amount: 10 })).toThrow('same key');
    });

    it('rejects insufficient balance', () => {
      mgr.setBalance('a', 50);
      mgr.setBalance('b', 0);
      expect(() => mgr.transfer({ fromKey: 'a', toKey: 'b', amount: 100 })).toThrow('Insufficient');
    });

    it('rejects unknown source key', () => {
      mgr.setBalance('b', 0);
      expect(() => mgr.transfer({ fromKey: 'unknown', toKey: 'b', amount: 10 })).toThrow('not found');
    });

    it('rejects unknown destination key', () => {
      mgr.setBalance('a', 100);
      expect(() => mgr.transfer({ fromKey: 'a', toKey: 'unknown', amount: 10 })).toThrow('not found');
    });

    it('enforces minAmount', () => {
      const strict = new CreditTransferManager({ minAmount: 10 });
      strict.setBalance('a', 100);
      strict.setBalance('b', 0);
      expect(() => strict.transfer({ fromKey: 'a', toKey: 'b', amount: 5 })).toThrow('at least 10');
      strict.destroy();
    });

    it('enforces maxAmount', () => {
      const strict = new CreditTransferManager({ maxAmount: 100 });
      strict.setBalance('a', 1000);
      strict.setBalance('b', 0);
      expect(() => strict.transfer({ fromKey: 'a', toKey: 'b', amount: 200 })).toThrow('cannot exceed 100');
      strict.destroy();
    });

    it('allows overdraft when configured', () => {
      const od = new CreditTransferManager({ allowOverdraft: true });
      od.setBalance('a', 10);
      od.setBalance('b', 0);
      const record = od.transfer({ fromKey: 'a', toKey: 'b', amount: 50 });
      expect(record.fromBalanceAfter).toBe(-40);
      expect(od.getBalance('a')).toBe(-40);
      od.destroy();
    });
  });

  // ── Reversal ────────────────────────────────────────────────────

  describe('reversal', () => {
    it('reverses a transfer', () => {
      mgr.setBalance('a', 1000);
      mgr.setBalance('b', 200);

      const original = mgr.transfer({ fromKey: 'a', toKey: 'b', amount: 300 });
      const reversal = mgr.reverse(original.id);

      expect(mgr.getBalance('a')).toBe(1000);
      expect(mgr.getBalance('b')).toBe(200);
      expect(reversal.fromKey).toBe('b');
      expect(reversal.toKey).toBe('a');
    });

    it('marks original as reversed', () => {
      mgr.setBalance('a', 100);
      mgr.setBalance('b', 0);
      const original = mgr.transfer({ fromKey: 'a', toKey: 'b', amount: 50 });
      const reversal = mgr.reverse(original.id);

      const updated = mgr.getTransfer(original.id)!;
      expect(updated.reversedAt).toBeTruthy();
      expect(updated.reversalId).toBe(reversal.id);
    });

    it('prevents double reversal', () => {
      mgr.setBalance('a', 100);
      mgr.setBalance('b', 0);
      const original = mgr.transfer({ fromKey: 'a', toKey: 'b', amount: 50 });
      mgr.reverse(original.id);
      expect(() => mgr.reverse(original.id)).toThrow('already reversed');
    });

    it('rejects unknown transfer ID', () => {
      expect(() => mgr.reverse('xfer_999')).toThrow('not found');
    });
  });

  // ── Query ───────────────────────────────────────────────────────

  describe('query', () => {
    it('gets key history', () => {
      mgr.setBalance('a', 1000);
      mgr.setBalance('b', 500);
      mgr.setBalance('c', 100);

      mgr.transfer({ fromKey: 'a', toKey: 'b', amount: 100 });
      mgr.transfer({ fromKey: 'a', toKey: 'c', amount: 50 });
      mgr.transfer({ fromKey: 'b', toKey: 'c', amount: 25 });

      const aHistory = mgr.getKeyHistory('a');
      expect(aHistory).toHaveLength(2);
    });

    it('gets all history', () => {
      mgr.setBalance('a', 100);
      mgr.setBalance('b', 100);
      mgr.transfer({ fromKey: 'a', toKey: 'b', amount: 10 });
      mgr.transfer({ fromKey: 'b', toKey: 'a', amount: 5 });
      expect(mgr.getHistory()).toHaveLength(2);
    });

    it('gets transfer by ID', () => {
      mgr.setBalance('a', 100);
      mgr.setBalance('b', 0);
      const record = mgr.transfer({ fromKey: 'a', toKey: 'b', amount: 25 });
      const found = mgr.getTransfer(record.id);
      expect(found).not.toBeNull();
      expect(found!.amount).toBe(25);
    });

    it('lists all balances sorted by balance', () => {
      mgr.setBalance('low', 10);
      mgr.setBalance('high', 1000);
      mgr.setBalance('mid', 500);
      const balances = mgr.listBalances();
      expect(balances[0].key).toBe('high');
      expect(balances[2].key).toBe('low');
    });
  });

  // ── Stats & Destroy ─────────────────────────────────────────────

  describe('stats and destroy', () => {
    it('tracks comprehensive stats', () => {
      mgr.setBalance('a', 1000);
      mgr.setBalance('b', 500);
      mgr.transfer({ fromKey: 'a', toKey: 'b', amount: 100 });
      mgr.transfer({ fromKey: 'a', toKey: 'b', amount: 200 });
      const t3 = mgr.transfer({ fromKey: 'b', toKey: 'a', amount: 50 });
      mgr.reverse(t3.id);

      const stats = mgr.getStats();
      expect(stats.trackedKeys).toBe(2);
      expect(stats.totalTransfers).toBe(4); // 3 + 1 reversal
      expect(stats.totalReversals).toBe(1);
      expect(stats.totalAmountTransferred).toBe(400); // 100+200+50+50
    });

    it('destroy resets everything', () => {
      mgr.setBalance('a', 100);
      mgr.destroy();
      expect(mgr.getBalance('a')).toBeNull();
      expect(mgr.getStats().totalTransfers).toBe(0);
    });
  });
});
