import { DynamicPricingEngine } from '../src/dynamic-pricing';

describe('DynamicPricingEngine', () => {
  let engine: DynamicPricingEngine;

  beforeEach(() => {
    engine = new DynamicPricingEngine();
  });

  // ── Base Prices ────────────────────────────────────────────────

  it('uses default base price when none set', () => {
    const result = engine.getPrice('search');
    expect(result.basePrice).toBe(1);
    expect(result.finalPrice).toBe(1);
  });

  it('sets and gets base price', () => {
    engine.setBasePrice('search', 10);
    expect(engine.getBasePrice('search')).toBe(10);
    const result = engine.getPrice('search');
    expect(result.finalPrice).toBe(10);
  });

  it('rejects negative base price', () => {
    expect(() => engine.setBasePrice('search', -5)).toThrow('negative');
  });

  it('removes base price (falls back to default)', () => {
    engine.setBasePrice('search', 10);
    engine.removeBasePrice('search');
    expect(engine.getBasePrice('search')).toBe(1);
  });

  it('uses custom default base price', () => {
    const e = new DynamicPricingEngine({ defaultBasePrice: 5 });
    expect(e.getPrice('anything').finalPrice).toBe(5);
    e.destroy();
  });

  // ── Time of Day Rule ──────────────────────────────────────────

  it('applies time-of-day multiplier during peak hours', () => {
    engine.setBasePrice('search', 10);
    const currentHour = new Date().getHours();
    engine.addRule({
      tool: 'search',
      type: 'time_of_day',
      config: { peakHours: [currentHour], multiplier: 2.0 },
    });
    const result = engine.getPrice('search');
    expect(result.finalPrice).toBe(20);
    expect(result.appliedRules).toHaveLength(1);
  });

  it('does not apply time-of-day multiplier outside peak hours', () => {
    engine.setBasePrice('search', 10);
    const offPeakHour = (new Date().getHours() + 12) % 24;
    engine.addRule({
      tool: 'search',
      type: 'time_of_day',
      config: { peakHours: [offPeakHour], multiplier: 2.0 },
    });
    const result = engine.getPrice('search');
    expect(result.finalPrice).toBe(10);
    expect(result.appliedRules).toHaveLength(0);
  });

  // ── Demand Rule ───────────────────────────────────────────────

  it('applies demand surge pricing when threshold exceeded', () => {
    engine.setBasePrice('search', 10);
    engine.addRule({
      tool: 'search',
      type: 'demand',
      config: { threshold: 5, windowSeconds: 300, maxMultiplier: 3.0 },
    });

    // Record 10 calls (2x threshold → max surge)
    for (let i = 0; i < 10; i++) {
      engine.recordCall('search');
    }

    const result = engine.getPrice('search');
    expect(result.finalPrice).toBe(30); // 10 * 3.0
    expect(result.appliedRules).toHaveLength(1);
  });

  it('does not surge below threshold', () => {
    engine.setBasePrice('search', 10);
    engine.addRule({
      tool: 'search',
      type: 'demand',
      config: { threshold: 100, windowSeconds: 300, maxMultiplier: 3.0 },
    });
    engine.recordCall('search');
    const result = engine.getPrice('search');
    expect(result.finalPrice).toBe(10);
  });

  // ── Volume Discount Rule ──────────────────────────────────────

  it('applies volume discount based on key usage', () => {
    engine.setBasePrice('search', 100);
    engine.addRule({
      tool: 'search',
      type: 'volume_discount',
      config: {
        tiers: [
          { minCalls: 100, discount: 0.1 },
          { minCalls: 500, discount: 0.2 },
          { minCalls: 1000, discount: 0.3 },
        ],
      },
    });

    // Record 600 calls for key
    for (let i = 0; i < 600; i++) {
      engine.recordCall('search', 'key_abc');
    }

    const result = engine.getPrice('search', 'key_abc');
    expect(result.finalPrice).toBe(80); // 100 * (1 - 0.2) = 80
  });

  it('does not apply volume discount without key', () => {
    engine.setBasePrice('search', 100);
    engine.addRule({
      tool: 'search',
      type: 'volume_discount',
      config: { tiers: [{ minCalls: 1, discount: 0.5 }] },
    });
    const result = engine.getPrice('search');
    expect(result.finalPrice).toBe(100);
  });

  // ── Key Override Rule ─────────────────────────────────────────

  it('applies key-specific price override', () => {
    engine.setBasePrice('search', 10);
    const keyPrices = new Map<string, number>();
    keyPrices.set('key_vip', 1);
    engine.addRule({
      tool: 'search',
      type: 'key_override',
      config: { keyPrices },
    });
    const result = engine.getPrice('search', 'key_vip');
    expect(result.finalPrice).toBe(1);
  });

  it('ignores key override for unknown keys', () => {
    engine.setBasePrice('search', 10);
    const keyPrices = new Map<string, number>();
    keyPrices.set('key_vip', 1);
    engine.addRule({
      tool: 'search',
      type: 'key_override',
      config: { keyPrices },
    });
    const result = engine.getPrice('search', 'key_other');
    expect(result.finalPrice).toBe(10);
  });

  // ── Custom Rule ───────────────────────────────────────────────

  it('applies custom pricing function', () => {
    engine.setBasePrice('search', 10);
    engine.addRule({
      tool: 'search',
      type: 'custom',
      config: { fn: (price) => price * 1.5 },
    });
    const result = engine.getPrice('search');
    expect(result.finalPrice).toBe(15);
  });

  it('fails safe on custom rule error', () => {
    engine.setBasePrice('search', 10);
    engine.addRule({
      tool: 'search',
      type: 'custom',
      config: { fn: () => { throw new Error('boom'); } },
    });
    const result = engine.getPrice('search');
    expect(result.finalPrice).toBe(10); // Fail-safe
  });

  // ── Rule Management ───────────────────────────────────────────

  it('enables and disables rules', () => {
    engine.setBasePrice('search', 10);
    const id = engine.addRule({
      tool: 'search',
      type: 'custom',
      config: { fn: (price) => price * 2 },
    });
    expect(engine.getPrice('search').finalPrice).toBe(20);

    engine.setRuleEnabled(id, false);
    expect(engine.getPrice('search').finalPrice).toBe(10);

    engine.setRuleEnabled(id, true);
    expect(engine.getPrice('search').finalPrice).toBe(20);
  });

  it('removes rules', () => {
    engine.setBasePrice('search', 10);
    const id = engine.addRule({
      tool: 'search',
      type: 'custom',
      config: { fn: (price) => price * 3 },
    });
    expect(engine.getPrice('search').finalPrice).toBe(30);

    engine.removeRule(id);
    expect(engine.getPrice('search').finalPrice).toBe(10);
  });

  it('lists rules for a tool sorted by priority', () => {
    engine.addRule({ tool: 'search', type: 'custom', config: { fn: (p) => p }, priority: 1 });
    engine.addRule({ tool: 'search', type: 'custom', config: { fn: (p) => p }, priority: 10 });
    engine.addRule({ tool: 'search', type: 'custom', config: { fn: (p) => p }, priority: 5 });
    const rules = engine.getToolRules('search');
    expect(rules).toHaveLength(3);
    expect(rules[0].priority).toBe(10);
    expect(rules[1].priority).toBe(5);
    expect(rules[2].priority).toBe(1);
  });

  // ── Rule Priority ─────────────────────────────────────────────

  it('evaluates rules in priority order', () => {
    engine.setBasePrice('search', 10);
    // Higher priority: double the price
    engine.addRule({
      tool: 'search',
      type: 'custom',
      config: { fn: (price) => price * 2 },
      priority: 10,
    });
    // Lower priority: add 5
    engine.addRule({
      tool: 'search',
      type: 'custom',
      config: { fn: (price) => price + 5 },
      priority: 1,
    });
    const result = engine.getPrice('search');
    // First double (10→20), then add 5 (20→25)
    expect(result.finalPrice).toBe(25);
  });

  // ── Demand Tracking ───────────────────────────────────────────

  it('tracks recent call count', () => {
    engine.recordCall('search');
    engine.recordCall('search');
    engine.recordCall('search');
    expect(engine.getRecentCallCount('search')).toBe(3);
  });

  it('tracks key+tool volume', () => {
    engine.recordCall('search', 'key_a');
    engine.recordCall('search', 'key_a');
    engine.recordCall('other', 'key_a');
    expect(engine.getKeyToolVolume('key_a', 'search')).toBe(2);
    expect(engine.getKeyToolVolume('key_a', 'other')).toBe(1);
  });

  // ── Price Result ──────────────────────────────────────────────

  it('includes multiplier in result', () => {
    engine.setBasePrice('search', 10);
    engine.addRule({
      tool: 'search',
      type: 'custom',
      config: { fn: (price) => price * 3 },
    });
    const result = engine.getPrice('search');
    expect(result.multiplier).toBe(3);
  });

  it('ensures price is non-negative', () => {
    engine.setBasePrice('search', 10);
    engine.addRule({
      tool: 'search',
      type: 'custom',
      config: { fn: () => -50 },
    });
    const result = engine.getPrice('search');
    expect(result.finalPrice).toBe(0);
  });

  // ── Stats ─────────────────────────────────────────────────────

  it('tracks stats', () => {
    engine.setBasePrice('search', 10);
    engine.addRule({ tool: 'search', type: 'custom', config: { fn: (p) => p } });
    engine.recordCall('search');
    engine.getPrice('search');

    const stats = engine.getStats();
    expect(stats.totalTools).toBe(1);
    expect(stats.totalRules).toBe(1);
    expect(stats.enabledRules).toBe(1);
    expect(stats.totalPriceCalculations).toBe(1);
    expect(stats.totalCallsTracked).toBe(1);
  });

  // ── Destroy ───────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    engine.setBasePrice('search', 10);
    engine.addRule({ tool: 'search', type: 'custom', config: { fn: (p) => p } });
    engine.recordCall('search');
    engine.destroy();
    const stats = engine.getStats();
    expect(stats.totalTools).toBe(0);
    expect(stats.totalRules).toBe(0);
    expect(stats.totalCallsTracked).toBe(0);
  });
});
