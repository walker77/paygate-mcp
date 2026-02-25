/**
 * Tests for Per-Tool Rate Limits.
 * v0.8.0 feature: independent rate limits per tool (in addition to global).
 */

import { Gate } from '../src/gate';
import { PayGateConfig, DEFAULT_CONFIG } from '../src/types';

describe('Per-Tool Rate Limits', () => {
  let gate: Gate;
  let config: PayGateConfig;

  beforeEach(() => {
    config = {
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 100, // High global limit
      defaultCreditsPerCall: 1,
      toolPricing: {
        'expensive-tool': { creditsPerCall: 5, rateLimitPerMin: 3 },
        'cheap-tool': { creditsPerCall: 1, rateLimitPerMin: 10 },
        'unlimited-tool': { creditsPerCall: 1, rateLimitPerMin: 0 }, // 0 = no per-tool limit
        'price-only': { creditsPerCall: 10 }, // No rate limit override
      },
    };
    gate = new Gate(config);
  });

  afterEach(() => {
    gate.destroy();
  });

  it('should enforce per-tool rate limit independently of global', () => {
    const record = gate.store.createKey('test', 1000);

    // Call expensive-tool 3 times (limit is 3/min)
    for (let i = 0; i < 3; i++) {
      const d = gate.evaluate(record.key, { name: 'expensive-tool' });
      expect(d.allowed).toBe(true);
    }

    // 4th call should be denied by per-tool limit
    const denied = gate.evaluate(record.key, { name: 'expensive-tool' });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('tool_rate_limited');
    expect(denied.reason).toContain('expensive-tool');
  });

  it('should allow different tools to have independent limits', () => {
    const record = gate.store.createKey('test', 1000);

    // Exhaust expensive-tool limit (3/min)
    for (let i = 0; i < 3; i++) {
      gate.evaluate(record.key, { name: 'expensive-tool' });
    }

    // expensive-tool is now rate limited
    expect(gate.evaluate(record.key, { name: 'expensive-tool' }).allowed).toBe(false);

    // cheap-tool should still work (different per-tool counter)
    const cheapResult = gate.evaluate(record.key, { name: 'cheap-tool' });
    expect(cheapResult.allowed).toBe(true);
  });

  it('should not apply per-tool limit when rateLimitPerMin is 0', () => {
    const record = gate.store.createKey('test', 1000);

    // unlimited-tool has rateLimitPerMin: 0 — no per-tool limit
    for (let i = 0; i < 50; i++) {
      const d = gate.evaluate(record.key, { name: 'unlimited-tool' });
      expect(d.allowed).toBe(true);
    }
  });

  it('should not apply per-tool limit when rateLimitPerMin is undefined', () => {
    const record = gate.store.createKey('test', 1000);

    // price-only has no rateLimitPerMin — no per-tool limit
    for (let i = 0; i < 20; i++) {
      const d = gate.evaluate(record.key, { name: 'price-only' });
      expect(d.allowed).toBe(true);
    }
  });

  it('should enforce global limit even when per-tool is not exceeded', () => {
    config.globalRateLimitPerMin = 5; // Low global limit
    gate.destroy();
    gate = new Gate(config);

    const record = gate.store.createKey('test', 1000);

    // cheap-tool has per-tool limit of 10, but global is 5
    for (let i = 0; i < 5; i++) {
      const d = gate.evaluate(record.key, { name: 'cheap-tool' });
      expect(d.allowed).toBe(true);
    }

    // 6th call should be denied by global limit (not per-tool)
    const denied = gate.evaluate(record.key, { name: 'cheap-tool' });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('rate_limited');
    // Global rate limit reason doesn't say "tool_rate_limited"
    expect(denied.reason).not.toContain('tool_rate_limited');
  });

  it('should track per-tool limits per API key independently', () => {
    const key1 = gate.store.createKey('user1', 1000);
    const key2 = gate.store.createKey('user2', 1000);

    // Key1: exhaust expensive-tool limit
    for (let i = 0; i < 3; i++) {
      gate.evaluate(key1.key, { name: 'expensive-tool' });
    }
    expect(gate.evaluate(key1.key, { name: 'expensive-tool' }).allowed).toBe(false);

    // Key2: should still have its own limit
    const d = gate.evaluate(key2.key, { name: 'expensive-tool' });
    expect(d.allowed).toBe(true);
  });

  it('should not charge credits when per-tool rate limited', () => {
    const record = gate.store.createKey('test', 1000);

    // Exhaust expensive-tool limit (costs 5 credits each)
    for (let i = 0; i < 3; i++) {
      gate.evaluate(record.key, { name: 'expensive-tool' });
    }
    // 3 calls * 5 credits = 15 deducted
    expect(gate.store.getKey(record.key)!.credits).toBe(985);

    // Next call is rate limited — no credits deducted
    gate.evaluate(record.key, { name: 'expensive-tool' });
    expect(gate.store.getKey(record.key)!.credits).toBe(985);
  });

  describe('shadow mode', () => {
    beforeEach(() => {
      config.shadowMode = true;
      gate.destroy();
      gate = new Gate(config);
    });

    it('should allow but log per-tool rate limit in shadow mode', () => {
      const record = gate.store.createKey('test', 1000);

      for (let i = 0; i < 3; i++) {
        gate.evaluate(record.key, { name: 'expensive-tool' });
      }

      const decision = gate.evaluate(record.key, { name: 'expensive-tool' });
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toContain('shadow:tool_rate_limited');
    });
  });
});
