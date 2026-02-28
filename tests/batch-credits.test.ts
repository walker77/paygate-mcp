import { BatchCreditManager } from '../src/batch-credits';

describe('BatchCreditManager', () => {
  let mgr: BatchCreditManager;

  beforeEach(() => {
    mgr = new BatchCreditManager();
  });

  afterEach(() => {
    mgr.destroy();
  });

  // ─── Balance Management ────────────────────────────────────────────

  test('set and get balance', () => {
    mgr.setBalance('key_a', 1000);
    expect(mgr.getBalance('key_a')).toBe(1000);
    expect(mgr.getBalance('unknown')).toBe(0);
  });

  test('get all balances', () => {
    mgr.setBalance('a', 100);
    mgr.setBalance('b', 200);
    const all = mgr.getAllBalances();
    expect(all.size).toBe(2);
    expect(all.get('a')).toBe(100);
  });

  // ─── Topup ─────────────────────────────────────────────────────────

  test('batch topup increases balances', () => {
    mgr.setBalance('key_a', 100);
    const result = mgr.execute([
      { type: 'topup', key: 'key_a', amount: 500 },
      { type: 'topup', key: 'key_b', amount: 300 },
    ]);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(mgr.getBalance('key_a')).toBe(600);
    expect(mgr.getBalance('key_b')).toBe(300);
  });

  test('topup rejects non-positive amount', () => {
    const result = mgr.execute([{ type: 'topup', key: 'k', amount: 0 }]);
    expect(result.failed).toBe(1);
  });

  // ─── Deduct ────────────────────────────────────────────────────────

  test('batch deduct decreases balance', () => {
    mgr.setBalance('key_a', 1000);
    const result = mgr.execute([{ type: 'deduct', key: 'key_a', amount: 300 }]);
    expect(result.succeeded).toBe(1);
    expect(mgr.getBalance('key_a')).toBe(700);
  });

  test('deduct fails with insufficient balance', () => {
    mgr.setBalance('key_a', 100);
    const result = mgr.execute([{ type: 'deduct', key: 'key_a', amount: 200 }]);
    expect(result.failed).toBe(1);
    expect(result.rolledBack).toBe(true);
    expect(mgr.getBalance('key_a')).toBe(100); // unchanged
  });

  test('deduct allows negative with config', () => {
    const m = new BatchCreditManager({ allowNegativeBalance: true });
    m.setBalance('k', 50);
    const result = m.execute([{ type: 'deduct', key: 'k', amount: 100 }]);
    expect(result.succeeded).toBe(1);
    expect(m.getBalance('k')).toBe(-50);
    m.destroy();
  });

  // ─── Transfer ──────────────────────────────────────────────────────

  test('transfer moves credits between keys', () => {
    mgr.setBalance('from', 1000);
    mgr.setBalance('to', 100);
    const result = mgr.execute([{ type: 'transfer', fromKey: 'from', toKey: 'to', amount: 400 }]);
    expect(result.succeeded).toBe(1);
    expect(mgr.getBalance('from')).toBe(600);
    expect(mgr.getBalance('to')).toBe(500);
  });

  test('transfer fails with insufficient source balance', () => {
    mgr.setBalance('from', 100);
    const result = mgr.execute([{ type: 'transfer', fromKey: 'from', toKey: 'to', amount: 500 }]);
    expect(result.failed).toBe(1);
  });

  test('transfer rejects same key', () => {
    mgr.setBalance('k', 1000);
    const result = mgr.execute([{ type: 'transfer', fromKey: 'k', toKey: 'k', amount: 100 }]);
    expect(result.failed).toBe(1);
  });

  test('transfer respects max amount', () => {
    const m = new BatchCreditManager({ maxTransferAmount: 500 });
    m.setBalance('from', 10000);
    const result = m.execute([{ type: 'transfer', fromKey: 'from', toKey: 'to', amount: 1000 }]);
    expect(result.failed).toBe(1);
    m.destroy();
  });

  // ─── Refund ────────────────────────────────────────────────────────

  test('refund adds credits back', () => {
    mgr.setBalance('k', 500);
    const result = mgr.execute([{ type: 'refund', key: 'k', amount: 200, note: 'Service outage' }]);
    expect(result.succeeded).toBe(1);
    expect(mgr.getBalance('k')).toBe(700);
  });

  // ─── Adjust ────────────────────────────────────────────────────────

  test('positive adjustment adds credits', () => {
    mgr.setBalance('k', 500);
    const result = mgr.execute([{ type: 'adjust', key: 'k', amount: 100, reason: 'Correction' }]);
    expect(result.succeeded).toBe(1);
    expect(mgr.getBalance('k')).toBe(600);
  });

  test('negative adjustment removes credits', () => {
    mgr.setBalance('k', 500);
    const result = mgr.execute([{ type: 'adjust', key: 'k', amount: -100, reason: 'Correction' }]);
    expect(result.succeeded).toBe(1);
    expect(mgr.getBalance('k')).toBe(400);
  });

  test('adjust requires reason', () => {
    const result = mgr.execute([{ type: 'adjust', key: 'k', amount: 100, reason: '' }]);
    expect(result.failed).toBe(1);
  });

  // ─── Atomic Rollback ──────────────────────────────────────────────

  test('atomic batch rolls back on failure', () => {
    mgr.setBalance('a', 1000);
    mgr.setBalance('b', 100);
    const result = mgr.execute([
      { type: 'topup', key: 'a', amount: 500 },       // would succeed
      { type: 'deduct', key: 'b', amount: 500 },       // fails — insufficient
    ], true);
    expect(result.rolledBack).toBe(true);
    expect(result.failed).toBe(2); // both marked failed after rollback
    expect(mgr.getBalance('a')).toBe(1000); // rolled back
    expect(mgr.getBalance('b')).toBe(100);  // unchanged
  });

  test('non-atomic batch allows partial success', () => {
    mgr.setBalance('a', 1000);
    mgr.setBalance('b', 100);
    const result = mgr.execute([
      { type: 'topup', key: 'a', amount: 500 },
      { type: 'deduct', key: 'b', amount: 500 },
    ], false);
    expect(result.rolledBack).toBe(false);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(mgr.getBalance('a')).toBe(1500); // applied
    expect(mgr.getBalance('b')).toBe(100);  // failed, unchanged
  });

  // ─── Batch Size Limit ─────────────────────────────────────────────

  test('reject batch exceeding max ops', () => {
    const m = new BatchCreditManager({ maxOpsPerBatch: 3 });
    const ops = Array.from({ length: 5 }, (_, i) => ({ type: 'topup' as const, key: `k${i}`, amount: 10 }));
    const result = m.execute(ops);
    expect(result.failed).toBe(5);
    m.destroy();
  });

  test('empty batch succeeds with zero ops', () => {
    const result = mgr.execute([]);
    expect(result.totalOps).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
  });

  // ─── Validation ───────────────────────────────────────────────────

  test('validate returns errors for invalid ops', () => {
    mgr.setBalance('k', 100);
    const errors = mgr.validate([
      { type: 'topup', key: 'k', amount: -5 },
      { type: 'deduct', key: 'k', amount: 500 },
    ]);
    expect(errors.length).toBe(2);
    expect(errors[0]).toContain('positive');
    expect(errors[1]).toContain('insufficient');
  });

  test('validate returns empty for valid ops', () => {
    mgr.setBalance('k', 1000);
    const errors = mgr.validate([
      { type: 'topup', key: 'k', amount: 100 },
      { type: 'deduct', key: 'k', amount: 50 },
    ]);
    expect(errors.length).toBe(0);
  });

  // ─── History ──────────────────────────────────────────────────────

  test('getHistory returns batch results', () => {
    mgr.execute([{ type: 'topup', key: 'k', amount: 100 }]);
    mgr.execute([{ type: 'topup', key: 'k', amount: 200 }]);
    const history = mgr.getHistory();
    expect(history.length).toBe(2);
    expect(history[0].results[0].op.type).toBe('topup');
  });

  test('getHistory respects limit', () => {
    for (let i = 0; i < 5; i++) mgr.execute([{ type: 'topup', key: 'k', amount: 10 }]);
    expect(mgr.getHistory(2).length).toBe(2);
  });

  test('getBatch returns specific batch', () => {
    const result = mgr.execute([{ type: 'topup', key: 'k', amount: 100 }]);
    expect(mgr.getBatch(result.id)).toBeTruthy();
    expect(mgr.getBatch('nonexistent')).toBeNull();
  });

  // ─── Stats ────────────────────────────────────────────────────────

  test('stats track operations', () => {
    mgr.setBalance('a', 1000);
    mgr.setBalance('b', 1000);
    mgr.execute([
      { type: 'topup', key: 'a', amount: 100 },
      { type: 'deduct', key: 'a', amount: 50 },
      { type: 'transfer', fromKey: 'a', toKey: 'b', amount: 200 },
      { type: 'refund', key: 'b', amount: 30 },
      { type: 'adjust', key: 'a', amount: -10, reason: 'fix' },
    ]);
    const stats = mgr.getStats();
    expect(stats.totalBatches).toBe(1);
    expect(stats.totalOps).toBe(5);
    expect(stats.totalTopups).toBe(1);
    expect(stats.totalDeductions).toBe(1);
    expect(stats.totalTransfers).toBe(1);
    expect(stats.totalRefunds).toBe(1);
    expect(stats.totalAdjustments).toBe(1);
    expect(stats.trackedKeys).toBe(2);
  });

  test('stats track failures and rollbacks', () => {
    mgr.execute([{ type: 'deduct', key: 'k', amount: 1000 }]); // fails, rolls back
    const stats = mgr.getStats();
    expect(stats.totalFailed).toBeGreaterThan(0);
    expect(stats.totalRolledBack).toBe(1);
  });

  test('destroy clears everything', () => {
    mgr.setBalance('k', 1000);
    mgr.execute([{ type: 'topup', key: 'k', amount: 100 }]);
    mgr.destroy();
    expect(mgr.getBalance('k')).toBe(0);
    expect(mgr.getHistory().length).toBe(0);
    expect(mgr.getStats().totalBatches).toBe(0);
  });
});
