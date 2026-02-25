import { Gate } from '../src/gate';
import { PayGateConfig, DEFAULT_CONFIG } from '../src/types';

describe('Gate', () => {
  let gate: Gate;
  let config: PayGateConfig;

  beforeEach(() => {
    config = {
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      globalRateLimitPerMin: 10,
      defaultCreditsPerCall: 1,
    };
    gate = new Gate(config);
  });

  afterEach(() => {
    gate.destroy();
  });

  describe('evaluate — happy path', () => {
    it('should allow valid key with sufficient credits', () => {
      const record = gate.store.createKey('test', 100);
      const decision = gate.evaluate(record.key, { name: 'search' });

      expect(decision.allowed).toBe(true);
      expect(decision.creditsCharged).toBe(1);
      expect(decision.remainingCredits).toBe(99);
    });

    it('should deduct credits on allow', () => {
      const record = gate.store.createKey('test', 10);
      gate.evaluate(record.key, { name: 'search' });
      gate.evaluate(record.key, { name: 'search' });
      gate.evaluate(record.key, { name: 'search' });

      expect(gate.store.getKey(record.key)!.credits).toBe(7);
      expect(gate.store.getKey(record.key)!.totalCalls).toBe(3);
    });
  });

  describe('evaluate — deny cases', () => {
    it('should deny missing API key', () => {
      const decision = gate.evaluate(null, { name: 'search' });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('missing_api_key');
    });

    it('should deny invalid API key', () => {
      const decision = gate.evaluate('pg_invalid_key', { name: 'search' });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('invalid_api_key');
    });

    it('should deny insufficient credits', () => {
      const record = gate.store.createKey('test', 0);
      const decision = gate.evaluate(record.key, { name: 'search' });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('insufficient_credits');
    });

    it('should deny when rate limited', () => {
      const record = gate.store.createKey('test', 1000);

      // Exhaust rate limit (10 calls/min)
      for (let i = 0; i < 10; i++) {
        const d = gate.evaluate(record.key, { name: 'search' });
        expect(d.allowed).toBe(true);
      }

      // 11th call should be denied
      const decision = gate.evaluate(record.key, { name: 'search' });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('rate_limited');
    });
  });

  describe('shadow mode', () => {
    beforeEach(() => {
      config.shadowMode = true;
      gate.destroy();
      gate = new Gate(config);
    });

    it('should allow but log missing key', () => {
      const decision = gate.evaluate(null, { name: 'search' });
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('shadow:missing_api_key');
    });

    it('should allow but log invalid key', () => {
      const decision = gate.evaluate('pg_fake', { name: 'search' });
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('shadow:invalid_api_key');
    });

    it('should allow but log insufficient credits', () => {
      const record = gate.store.createKey('test', 0);
      const decision = gate.evaluate(record.key, { name: 'search' });
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toBe('shadow:insufficient_credits');
    });
  });

  describe('tool pricing', () => {
    it('should use default pricing', () => {
      expect(gate.getToolPrice('unknown_tool')).toBe(1);
    });

    it('should use per-tool pricing overrides', () => {
      config.toolPricing = {
        'expensive-tool': { creditsPerCall: 10 },
        'cheap-tool': { creditsPerCall: 0 },
      };
      gate.destroy();
      gate = new Gate(config);

      expect(gate.getToolPrice('expensive-tool')).toBe(10);
      expect(gate.getToolPrice('cheap-tool')).toBe(0);
      expect(gate.getToolPrice('normal-tool')).toBe(1);
    });

    it('should charge correct per-tool price', () => {
      config.toolPricing = { 'premium': { creditsPerCall: 5 } };
      gate.destroy();
      gate = new Gate(config);

      const record = gate.store.createKey('test', 100);
      const decision = gate.evaluate(record.key, { name: 'premium' });
      expect(decision.creditsCharged).toBe(5);
      expect(decision.remainingCredits).toBe(95);
    });
  });

  describe('free methods', () => {
    it('should identify free methods', () => {
      expect(gate.isFreeMethod('initialize')).toBe(true);
      expect(gate.isFreeMethod('tools/list')).toBe(true);
      expect(gate.isFreeMethod('ping')).toBe(true);
      expect(gate.isFreeMethod('tools/call')).toBe(false);
    });
  });

  describe('status', () => {
    it('should return complete status', () => {
      gate.store.createKey('test', 100);
      const status = gate.getStatus();

      expect(status.name).toBe('PayGate MCP Server');
      expect(status.activeKeys).toBe(1);
      expect(status.keys).toHaveLength(1);
      expect(status.config.defaultCreditsPerCall).toBe(1);
    });
  });

  describe('metering', () => {
    it('should record events on evaluate', () => {
      const record = gate.store.createKey('test', 100);
      gate.evaluate(record.key, { name: 'search' });
      gate.evaluate(null, { name: 'search' });

      const summary = gate.meter.getSummary();
      expect(summary.totalCalls).toBe(2);
      expect(summary.totalDenied).toBe(1);
      expect(summary.totalCreditsSpent).toBe(1);
    });
  });
});
