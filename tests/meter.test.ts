import { UsageMeter } from '../src/meter';

describe('UsageMeter', () => {
  let meter: UsageMeter;

  beforeEach(() => {
    meter = new UsageMeter(100); // Low max for testing
  });

  it('should record events and count them', () => {
    meter.record({
      timestamp: new Date().toISOString(),
      apiKey: 'pg_test1234',
      keyName: 'test',
      tool: 'search',
      creditsCharged: 1,
      allowed: true,
    });

    expect(meter.eventCount).toBe(1);
  });

  it('should summarize events correctly', () => {
    // 2 allowed, 1 denied
    meter.record({
      timestamp: new Date().toISOString(),
      apiKey: 'pg_test1234',
      keyName: 'alpha',
      tool: 'search',
      creditsCharged: 2,
      allowed: true,
    });
    meter.record({
      timestamp: new Date().toISOString(),
      apiKey: 'pg_test1234',
      keyName: 'alpha',
      tool: 'generate',
      creditsCharged: 5,
      allowed: true,
    });
    meter.record({
      timestamp: new Date().toISOString(),
      apiKey: 'pg_test5678',
      keyName: 'beta',
      tool: 'search',
      creditsCharged: 0,
      allowed: false,
      denyReason: 'insufficient_credits',
    });

    const summary = meter.getSummary();

    expect(summary.totalCalls).toBe(3);
    expect(summary.totalCreditsSpent).toBe(7);
    expect(summary.totalDenied).toBe(1);

    expect(summary.perTool['search'].calls).toBe(2);
    expect(summary.perTool['search'].credits).toBe(2);
    expect(summary.perTool['search'].denied).toBe(1);
    expect(summary.perTool['generate'].calls).toBe(1);
    expect(summary.perTool['generate'].credits).toBe(5);

    expect(summary.perKey['alpha'].calls).toBe(2);
    expect(summary.perKey['beta'].calls).toBe(1);

    expect(summary.denyReasons['insufficient_credits']).toBe(1);
  });

  it('should drop oldest events when overflow', () => {
    for (let i = 0; i < 120; i++) {
      meter.record({
        timestamp: new Date().toISOString(),
        apiKey: 'pg_test1234',
        keyName: 'test',
        tool: 'search',
        creditsCharged: 1,
        allowed: true,
      });
    }

    // maxEvents=100, overflow triggers 25% drop
    // After 100+1 events, drops 25 oldest → 76 remaining, then continues to 120
    // Actually: after each push if > 100, drops 25
    expect(meter.eventCount).toBeLessThanOrEqual(100);
  });

  it('should clear events', () => {
    meter.record({
      timestamp: new Date().toISOString(),
      apiKey: 'pg_test1234',
      keyName: 'test',
      tool: 'search',
      creditsCharged: 1,
      allowed: true,
    });
    meter.clear();
    expect(meter.eventCount).toBe(0);
  });
});
