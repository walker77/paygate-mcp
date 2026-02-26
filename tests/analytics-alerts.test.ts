import { AnalyticsEngine, BucketGranularity } from '../src/analytics';
import { AlertEngine, AlertRule } from '../src/alerts';
import { UsageEvent, ApiKeyRecord, DEFAULT_CONFIG } from '../src/types';
import { Gate } from '../src/gate';

// ─── Analytics Tests ─────────────────────────────────────────────────────────

describe('AnalyticsEngine', () => {
  let engine: AnalyticsEngine;

  beforeEach(() => {
    engine = new AnalyticsEngine();
  });

  function makeEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
    return {
      timestamp: new Date().toISOString(),
      apiKey: 'pg_testkey1234567890',
      keyName: 'test-key',
      tool: 'test_tool',
      creditsCharged: 1,
      allowed: true,
      ...overrides,
    };
  }

  describe('report', () => {
    it('should return empty report for no events', () => {
      const report = engine.report([]);
      expect(report.summary.totalCalls).toBe(0);
      expect(report.summary.totalCredits).toBe(0);
      expect(report.tools).toEqual([]);
      expect(report.topConsumers).toEqual([]);
    });

    it('should aggregate events within time range', () => {
      const now = new Date();
      const events = [
        makeEvent({ timestamp: new Date(now.getTime() - 3600_000).toISOString(), creditsCharged: 5 }),
        makeEvent({ timestamp: new Date(now.getTime() - 1800_000).toISOString(), creditsCharged: 3 }),
        makeEvent({ timestamp: new Date(now.getTime() - 600_000).toISOString(), creditsCharged: 2, allowed: false, denyReason: 'rate_limited' }),
      ];
      const report = engine.report(events, {
        from: new Date(now.getTime() - 4 * 3600_000).toISOString(),
        to: now.toISOString(),
      });

      expect(report.summary.totalCalls).toBe(3);
      expect(report.summary.totalCredits).toBe(8); // 5 + 3 (denied doesn't count)
      expect(report.summary.totalDenied).toBe(1);
      expect(report.summary.successRate).toBeCloseTo(2 / 3);
    });

    it('should filter events outside time range', () => {
      const now = new Date();
      const events = [
        makeEvent({ timestamp: new Date(now.getTime() - 48 * 3600_000).toISOString() }), // 2 days ago
        makeEvent({ timestamp: new Date(now.getTime() - 1800_000).toISOString() }), // 30 min ago
      ];
      const report = engine.report(events, {
        from: new Date(now.getTime() - 3600_000).toISOString(), // Last hour only
        to: now.toISOString(),
      });

      expect(report.summary.totalCalls).toBe(1);
    });
  });

  describe('timeSeries', () => {
    it('should bucket events hourly', () => {
      const base = new Date('2025-01-15T10:00:00Z');
      const events = [
        makeEvent({ timestamp: new Date(base.getTime() + 15 * 60_000).toISOString() }), // 10:15
        makeEvent({ timestamp: new Date(base.getTime() + 45 * 60_000).toISOString() }), // 10:45
        makeEvent({ timestamp: new Date(base.getTime() + 90 * 60_000).toISOString() }), // 11:30
      ];

      const report = engine.report(events, {
        from: base.toISOString(),
        to: new Date(base.getTime() + 3 * 3600_000).toISOString(),
        granularity: 'hourly',
      });

      expect(report.timeSeries.length).toBe(3);
      expect(report.timeSeries[0].calls).toBe(2); // 10:00-11:00
      expect(report.timeSeries[1].calls).toBe(1); // 11:00-12:00
      expect(report.timeSeries[2].calls).toBe(0); // 12:00-13:00
    });

    it('should bucket events daily', () => {
      const base = new Date('2025-01-10T00:00:00Z');
      const events = [
        makeEvent({ timestamp: new Date(base.getTime() + 12 * 3600_000).toISOString() }), // Jan 10 noon
        makeEvent({ timestamp: new Date(base.getTime() + 36 * 3600_000).toISOString() }), // Jan 11 noon
        makeEvent({ timestamp: new Date(base.getTime() + 36 * 3600_000 + 100).toISOString() }), // Jan 11 noon + 100ms
      ];

      const report = engine.report(events, {
        from: base.toISOString(),
        to: new Date(base.getTime() + 3 * 86400_000).toISOString(),
        granularity: 'daily',
      });

      expect(report.timeSeries.length).toBe(3);
      expect(report.timeSeries[0].calls).toBe(1); // Jan 10
      expect(report.timeSeries[1].calls).toBe(2); // Jan 11
      expect(report.timeSeries[2].calls).toBe(0); // Jan 12
    });

    it('should track credits in buckets', () => {
      const base = new Date('2025-01-15T10:00:00Z');
      const events = [
        makeEvent({ timestamp: new Date(base.getTime() + 15 * 60_000).toISOString(), creditsCharged: 5 }),
        makeEvent({ timestamp: new Date(base.getTime() + 45 * 60_000).toISOString(), creditsCharged: 3, allowed: false }),
      ];

      const report = engine.report(events, {
        from: base.toISOString(),
        to: new Date(base.getTime() + 2 * 3600_000).toISOString(),
        granularity: 'hourly',
      });

      expect(report.timeSeries[0].credits).toBe(5); // Only allowed credits
      expect(report.timeSeries[0].denied).toBe(1);
      expect(report.timeSeries[0].allowed).toBe(1);
    });
  });

  describe('toolBreakdown', () => {
    it('should break down by tool', () => {
      const now = new Date();
      const events = [
        makeEvent({ tool: 'search', creditsCharged: 1 }),
        makeEvent({ tool: 'search', creditsCharged: 2 }),
        makeEvent({ tool: 'generate', creditsCharged: 5 }),
        makeEvent({ tool: 'search', allowed: false, creditsCharged: 0, denyReason: 'rate_limited' }),
      ];

      const report = engine.report(events);

      const searchTool = report.tools.find(t => t.tool === 'search');
      expect(searchTool).toBeDefined();
      expect(searchTool!.calls).toBe(3);
      expect(searchTool!.allowed).toBe(2);
      expect(searchTool!.denied).toBe(1);
      expect(searchTool!.credits).toBe(3);
      expect(searchTool!.successRate).toBeCloseTo(2 / 3);
      expect(searchTool!.avgCreditsPerCall).toBe(1.5); // 3 credits / 2 allowed

      const genTool = report.tools.find(t => t.tool === 'generate');
      expect(genTool!.calls).toBe(1);
      expect(genTool!.credits).toBe(5);
    });

    it('should sort tools by calls descending', () => {
      const events = [
        makeEvent({ tool: 'rare_tool' }),
        makeEvent({ tool: 'popular_tool' }),
        makeEvent({ tool: 'popular_tool' }),
        makeEvent({ tool: 'popular_tool' }),
      ];

      const report = engine.report(events);
      expect(report.tools[0].tool).toBe('popular_tool');
      expect(report.tools[1].tool).toBe('rare_tool');
    });
  });

  describe('topConsumers', () => {
    it('should identify top consumers by credits', () => {
      const events = [
        makeEvent({ apiKey: 'pg_key1', keyName: 'big-spender', creditsCharged: 100 }),
        makeEvent({ apiKey: 'pg_key1', keyName: 'big-spender', creditsCharged: 50 }),
        makeEvent({ apiKey: 'pg_key2', keyName: 'small-user', creditsCharged: 5 }),
      ];

      const report = engine.report(events, { topN: 2 });

      expect(report.topConsumers.length).toBe(2);
      expect(report.topConsumers[0].keyName).toBe('big-spender');
      expect(report.topConsumers[0].credits).toBe(150);
      expect(report.topConsumers[1].keyName).toBe('small-user');
    });

    it('should limit to topN consumers', () => {
      const events = Array.from({ length: 20 }, (_, i) =>
        makeEvent({ apiKey: `pg_key${i}`, keyName: `key-${i}`, creditsCharged: 20 - i }),
      );

      const report = engine.report(events, { topN: 5 });
      expect(report.topConsumers.length).toBe(5);
    });

    it('should track top tool per consumer', () => {
      const events = [
        makeEvent({ apiKey: 'pg_key1', keyName: 'user', tool: 'search' }),
        makeEvent({ apiKey: 'pg_key1', keyName: 'user', tool: 'search' }),
        makeEvent({ apiKey: 'pg_key1', keyName: 'user', tool: 'generate' }),
      ];

      const report = engine.report(events);
      expect(report.topConsumers[0].topTool).toBe('search');
    });
  });

  describe('trend', () => {
    it('should compare current vs previous period', () => {
      const now = new Date();
      const events = [
        // Previous period (2-1 hours ago)
        makeEvent({ timestamp: new Date(now.getTime() - 90 * 60_000).toISOString(), creditsCharged: 10 }),
        makeEvent({ timestamp: new Date(now.getTime() - 80 * 60_000).toISOString(), creditsCharged: 5 }),
        // Current period (last hour)
        makeEvent({ timestamp: new Date(now.getTime() - 30 * 60_000).toISOString(), creditsCharged: 20 }),
        makeEvent({ timestamp: new Date(now.getTime() - 20 * 60_000).toISOString(), creditsCharged: 15 }),
        makeEvent({ timestamp: new Date(now.getTime() - 10 * 60_000).toISOString(), creditsCharged: 10 }),
      ];

      const report = engine.report(events, {
        from: new Date(now.getTime() - 3600_000).toISOString(),
        to: now.toISOString(),
      });

      expect(report.trend.current.calls).toBe(3);
      expect(report.trend.current.credits).toBe(45);
      expect(report.trend.previous.calls).toBe(2);
      expect(report.trend.previous.credits).toBe(15);
      expect(report.trend.change.calls).toBe(50); // 50% increase
      expect(report.trend.change.credits).toBe(200); // 200% increase
    });
  });

  describe('summary', () => {
    it('should count unique keys and tools', () => {
      const events = [
        makeEvent({ apiKey: 'pg_key1', tool: 'search' }),
        makeEvent({ apiKey: 'pg_key1', tool: 'generate' }),
        makeEvent({ apiKey: 'pg_key2', tool: 'search' }),
      ];

      const report = engine.report(events);
      expect(report.summary.uniqueKeys).toBe(2);
      expect(report.summary.uniqueTools).toBe(2);
    });
  });
});

// ─── Alert Engine Tests ──────────────────────────────────────────────────────

describe('AlertEngine', () => {
  function makeRecord(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
    return {
      key: 'pg_testkey1234567890abcdef1234567890abcdef12345678',
      name: 'test-key',
      credits: 100,
      totalSpent: 0,
      totalCalls: 0,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      active: true,
      allowedTools: [],
      deniedTools: [],
      spendingLimit: 0,
      expiresAt: null,
      quota: undefined,
      quotaDailyCalls: 0,
      quotaMonthlyCalls: 0,
      quotaDailyCredits: 0,
      quotaMonthlyCredits: 0,
      quotaLastResetDay: new Date().toISOString().split('T')[0],
      quotaLastResetMonth: new Date().toISOString().slice(0, 7),
      tags: {},
      ipAllowlist: [],
      ...overrides,
    };
  }

  describe('spending_threshold', () => {
    it('should fire when spending exceeds threshold percentage', () => {
      const engine = new AlertEngine({
        rules: [{ type: 'spending_threshold', threshold: 80 }],
      });

      const record = makeRecord({ credits: 10, totalSpent: 90 }); // 90% spent
      const alerts = engine.check('pg_testkey1234567890abcdef1234567890abcdef12345678', record);

      expect(alerts.length).toBe(1);
      expect(alerts[0].type).toBe('spending_threshold');
      expect(alerts[0].currentValue).toBe(90);
    });

    it('should not fire when spending is below threshold', () => {
      const engine = new AlertEngine({
        rules: [{ type: 'spending_threshold', threshold: 80 }],
      });

      const record = makeRecord({ credits: 50, totalSpent: 30 }); // 37.5% spent
      const alerts = engine.check('pg_testkey1234567890abcdef1234567890abcdef12345678', record);

      expect(alerts.length).toBe(0);
    });

    it('should respect cooldown', () => {
      const engine = new AlertEngine({
        rules: [{ type: 'spending_threshold', threshold: 80, cooldownSeconds: 3600 }],
      });

      const record = makeRecord({ credits: 10, totalSpent: 90 });
      const key = 'pg_testkey1234567890abcdef1234567890abcdef12345678';

      const first = engine.check(key, record);
      expect(first.length).toBe(1);

      // Should not fire again within cooldown
      const second = engine.check(key, record);
      expect(second.length).toBe(0);
    });
  });

  describe('credits_low', () => {
    it('should fire when credits fall below threshold', () => {
      const engine = new AlertEngine({
        rules: [{ type: 'credits_low', threshold: 50 }],
      });

      const record = makeRecord({ credits: 25 });
      const alerts = engine.check('pg_testkey1234567890abcdef1234567890abcdef12345678', record);

      expect(alerts.length).toBe(1);
      expect(alerts[0].type).toBe('credits_low');
      expect(alerts[0].currentValue).toBe(25);
    });

    it('should not fire when credits are above threshold', () => {
      const engine = new AlertEngine({
        rules: [{ type: 'credits_low', threshold: 50 }],
      });

      const record = makeRecord({ credits: 100 });
      const alerts = engine.check('pg_testkey1234567890abcdef1234567890abcdef12345678', record);
      expect(alerts.length).toBe(0);
    });
  });

  describe('quota_warning', () => {
    it('should fire when daily call quota exceeds threshold', () => {
      const engine = new AlertEngine({
        rules: [{ type: 'quota_warning', threshold: 90 }],
      });

      const record = makeRecord({
        quota: { dailyCallLimit: 100, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
        quotaDailyCalls: 95,
      });

      const alerts = engine.check('pg_testkey1234567890abcdef1234567890abcdef12345678', record);
      expect(alerts.length).toBe(1);
      expect(alerts[0].type).toBe('quota_warning');
    });

    it('should not fire when no quota is set', () => {
      const engine = new AlertEngine({
        rules: [{ type: 'quota_warning', threshold: 90 }],
      });

      const record = makeRecord({ quota: undefined });
      const alerts = engine.check('pg_testkey1234567890abcdef1234567890abcdef12345678', record);
      expect(alerts.length).toBe(0);
    });
  });

  describe('key_expiry_soon', () => {
    it('should fire when key expires within threshold seconds', () => {
      const engine = new AlertEngine({
        rules: [{ type: 'key_expiry_soon', threshold: 3600 }], // Alert if expiring within 1 hour
      });

      const record = makeRecord({
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), // 30 min from now
      });

      const alerts = engine.check('pg_testkey1234567890abcdef1234567890abcdef12345678', record);
      expect(alerts.length).toBe(1);
      expect(alerts[0].type).toBe('key_expiry_soon');
    });

    it('should not fire when key has no expiry', () => {
      const engine = new AlertEngine({
        rules: [{ type: 'key_expiry_soon', threshold: 3600 }],
      });

      const record = makeRecord({ expiresAt: null });
      const alerts = engine.check('pg_testkey1234567890abcdef1234567890abcdef12345678', record);
      expect(alerts.length).toBe(0);
    });

    it('should not fire when key expires far in the future', () => {
      const engine = new AlertEngine({
        rules: [{ type: 'key_expiry_soon', threshold: 3600 }],
      });

      const record = makeRecord({
        expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(), // 7 days from now
      });

      const alerts = engine.check('pg_testkey1234567890abcdef1234567890abcdef12345678', record);
      expect(alerts.length).toBe(0);
    });
  });

  describe('rate_limit_spike', () => {
    it('should fire when rate limit denials exceed threshold', () => {
      const engine = new AlertEngine({
        rules: [{ type: 'rate_limit_spike', threshold: 5 }],
      });

      const key = 'pg_testkey1234567890abcdef1234567890abcdef12345678';
      // Record 6 denials
      for (let i = 0; i < 6; i++) {
        engine.recordRateLimitDenial(key);
      }

      const record = makeRecord();
      const alerts = engine.check(key, record, { rateLimitDenied: true });

      expect(alerts.length).toBe(1);
      expect(alerts[0].type).toBe('rate_limit_spike');
      expect(alerts[0].currentValue).toBe(6);
    });

    it('should not fire without rateLimitDenied context', () => {
      const engine = new AlertEngine({
        rules: [{ type: 'rate_limit_spike', threshold: 5 }],
      });

      const key = 'pg_testkey1234567890abcdef1234567890abcdef12345678';
      for (let i = 0; i < 10; i++) {
        engine.recordRateLimitDenial(key);
      }

      const record = makeRecord();
      const alerts = engine.check(key, record); // No context
      expect(alerts.length).toBe(0);
    });
  });

  describe('consumeAlerts', () => {
    it('should return and clear pending alerts', () => {
      const engine = new AlertEngine({
        rules: [{ type: 'credits_low', threshold: 50 }],
      });

      const record = makeRecord({ credits: 10 });
      engine.check('pg_testkey1234567890abcdef1234567890abcdef12345678', record);

      expect(engine.pendingCount).toBe(1);
      const alerts = engine.consumeAlerts();
      expect(alerts.length).toBe(1);
      expect(engine.pendingCount).toBe(0);
    });
  });

  describe('dryRun', () => {
    it('should not add to pending alerts in dry run mode', () => {
      const engine = new AlertEngine({
        rules: [{ type: 'credits_low', threshold: 50 }],
        dryRun: true,
      });

      const record = makeRecord({ credits: 10 });
      const fired = engine.check('pg_testkey1234567890abcdef1234567890abcdef12345678', record);

      expect(fired.length).toBe(1); // Still returns alerts
      expect(engine.pendingCount).toBe(0); // But doesn't queue them
    });
  });

  describe('multiple rules', () => {
    it('should evaluate all rules and fire multiple alerts', () => {
      const engine = new AlertEngine({
        rules: [
          { type: 'credits_low', threshold: 50 },
          { type: 'spending_threshold', threshold: 80 },
        ],
      });

      const record = makeRecord({ credits: 10, totalSpent: 90 });
      const alerts = engine.check('pg_testkey1234567890abcdef1234567890abcdef12345678', record);

      expect(alerts.length).toBe(2);
      const types = alerts.map(a => a.type);
      expect(types).toContain('credits_low');
      expect(types).toContain('spending_threshold');
    });
  });

  describe('clearCooldowns', () => {
    it('should allow alerts to fire again after clearing cooldowns', () => {
      const engine = new AlertEngine({
        rules: [{ type: 'credits_low', threshold: 50 }],
      });

      const key = 'pg_testkey1234567890abcdef1234567890abcdef12345678';
      const record = makeRecord({ credits: 10 });

      engine.check(key, record);
      engine.clearCooldowns();

      const alerts = engine.check(key, record);
      expect(alerts.length).toBe(1);
    });
  });
});

// ─── Gate + Alert Integration ─────────────────────────────────────────────────

describe('Gate + Alert Integration', () => {
  it('should work with gate evaluate flow', () => {
    const config = {
      ...DEFAULT_CONFIG,
      defaultCreditsPerCall: 10,
      webhookSecret: null,
      alertRules: [
        { type: 'credits_low' as const, threshold: 50 },
      ],
    };
    const gate = new Gate(config);
    const alerts = new AlertEngine({ rules: config.alertRules });

    const record = gate.store.createKey('test', 100);
    // Use 60 credits (6 calls at 10 each)
    for (let i = 0; i < 6; i++) {
      gate.evaluate(record.key, { name: 'test_tool' });
    }

    // Now check alerts — should fire (40 credits remaining < 50 threshold)
    const keyRecord = gate.store.getKey(record.key)!;
    const fired = alerts.check(record.key, keyRecord);
    expect(fired.length).toBe(1);
    expect(fired[0].type).toBe('credits_low');
    expect(fired[0].currentValue).toBe(40);
  });
});
