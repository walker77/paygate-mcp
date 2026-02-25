import { Gate } from '../src/gate';
import { PayGateConfig, DEFAULT_CONFIG } from '../src/types';

describe('Gate — refund-on-failure', () => {
  let gate: Gate;
  let config: PayGateConfig;

  beforeEach(() => {
    config = {
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100,
      defaultCreditsPerCall: 1,
      refundOnFailure: true,
    };
    gate = new Gate(config);
  });

  afterEach(() => {
    gate.destroy();
  });

  it('should refund credits back to the key', () => {
    const record = gate.store.createKey('test', 100);
    const key = record.key;

    // Simulate: gate allows, then downstream fails, so we refund
    const decision = gate.evaluate(key, { name: 'search' });
    expect(decision.allowed).toBe(true);
    expect(decision.creditsCharged).toBe(1);
    expect(gate.store.getKey(key)!.credits).toBe(99);

    gate.refund(key, 'search', 1);
    expect(gate.store.getKey(key)!.credits).toBe(100);
  });

  it('should roll back totalSpent and totalCalls on refund', () => {
    const record = gate.store.createKey('test', 100);
    const key = record.key;

    gate.evaluate(key, { name: 'search' });
    gate.evaluate(key, { name: 'search' });
    expect(gate.store.getKey(key)!.totalSpent).toBe(2);
    expect(gate.store.getKey(key)!.totalCalls).toBe(2);

    gate.refund(key, 'search', 1);
    expect(gate.store.getKey(key)!.totalSpent).toBe(1);
    expect(gate.store.getKey(key)!.totalCalls).toBe(1);
  });

  it('should not let totalSpent go negative on refund', () => {
    const record = gate.store.createKey('test', 100);
    const key = record.key;

    // Refund without any prior spending (edge case)
    gate.refund(key, 'search', 5);
    expect(gate.store.getKey(key)!.totalSpent).toBe(0);
    expect(gate.store.getKey(key)!.totalCalls).toBe(0);
  });

  it('should record refund event in meter', () => {
    const record = gate.store.createKey('test', 100);
    gate.evaluate(record.key, { name: 'search' });
    gate.refund(record.key, 'search', 1);

    const summary = gate.meter.getSummary();
    // 2 events: the original call + the refund
    expect(summary.totalCalls).toBe(2);
  });

  it('should expose refundOnFailure config', () => {
    expect(gate.refundOnFailure).toBe(true);

    const nonRefundConfig = { ...config, refundOnFailure: false };
    const gate2 = new Gate(nonRefundConfig);
    expect(gate2.refundOnFailure).toBe(false);
    gate2.destroy();
  });

  it('should refund correct amount for per-tool pricing', () => {
    config.toolPricing = { 'premium': { creditsPerCall: 5 } };
    gate.destroy();
    gate = new Gate(config);

    const record = gate.store.createKey('test', 100);
    const key = record.key;

    const decision = gate.evaluate(key, { name: 'premium' });
    expect(decision.creditsCharged).toBe(5);
    expect(gate.store.getKey(key)!.credits).toBe(95);

    gate.refund(key, 'premium', 5);
    expect(gate.store.getKey(key)!.credits).toBe(100);
    expect(gate.store.getKey(key)!.totalSpent).toBe(0);
  });
});
