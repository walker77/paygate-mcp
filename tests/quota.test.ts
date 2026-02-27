/**
 * Tests for usage quotas and dynamic pricing.
 */

import { PayGateServer } from '../src/server';
import { PayGateConfig, DEFAULT_CONFIG, QuotaConfig } from '../src/types';
import * as http from 'http';
import * as path from 'path';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let server: PayGateServer;
let port: number;
let adminKey: string;

const MOCK_SERVER = path.join(__dirname, 'e2e', 'mock-mcp-server.js');

async function startServer(overrides: Partial<PayGateConfig> = {}) {
  server = new PayGateServer({
    serverCommand: 'node',
    serverArgs: [MOCK_SERVER],
    port: 0,
    ...overrides,
  } as PayGateConfig & { serverCommand: string });

  const info = await server.start();
  port = info.port;
  adminKey = info.adminKey;
}

function httpRequest(
  targetPort: number,
  urlPath: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const method = options.method || (options.body ? 'POST' : 'GET');
    const bodyStr = options.body ? JSON.stringify(options.body) : undefined;

    const req = http.request(
      { hostname: 'localhost', port: targetPort, path: urlPath, method, headers: { 'Content-Type': 'application/json', ...options.headers } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, body: data });
          }
        });
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function createApiKey(credits: number, options: { quota?: QuotaConfig } = {}): Promise<string> {
  const res = await httpRequest(port, '/keys', {
    method: 'POST',
    headers: { 'X-Admin-Key': adminKey },
    body: { name: 'quota-test', credits, ...options },
  });
  return res.body.key;
}

async function callTool(apiKey: string, toolName: string = 'search', args: Record<string, unknown> = { query: 'test' }): Promise<any> {
  return httpRequest(port, '/mcp', {
    method: 'POST',
    headers: { 'X-API-Key': apiKey },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: args } },
  });
}

afterEach(async () => {
  if (server) await server.gracefulStop(5_000);
}, 30_000);

// ─── Quota Tests ──────────────────────────────────────────────────────────────

describe('Usage Quotas', () => {
  describe('Per-key daily call quota', () => {
    it('should deny after daily call limit is reached', async () => {
      await startServer({ defaultCreditsPerCall: 1 });
      const apiKey = await createApiKey(100, {
        quota: { dailyCallLimit: 3, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
      });

      // 3 calls should succeed
      for (let i = 0; i < 3; i++) {
        const res = await callTool(apiKey);
        expect(res.body.result).toBeDefined();
      }

      // 4th call should be denied
      const res = await callTool(apiKey);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(-32402);
      expect(res.body.error.message).toContain('daily_call_quota_exceeded');
    });
  });

  describe('Per-key monthly call quota', () => {
    it('should deny after monthly call limit is reached', async () => {
      await startServer({ defaultCreditsPerCall: 1 });
      const apiKey = await createApiKey(100, {
        quota: { dailyCallLimit: 0, monthlyCallLimit: 2, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
      });

      // 2 calls should succeed
      for (let i = 0; i < 2; i++) {
        const res = await callTool(apiKey);
        expect(res.body.result).toBeDefined();
      }

      // 3rd call should be denied
      const res = await callTool(apiKey);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toContain('monthly_call_quota_exceeded');
    });
  });

  describe('Per-key daily credit quota', () => {
    it('should deny when daily credit limit would be exceeded', async () => {
      await startServer({ defaultCreditsPerCall: 5 });
      const apiKey = await createApiKey(100, {
        quota: { dailyCallLimit: 0, monthlyCallLimit: 0, dailyCreditLimit: 12, monthlyCreditLimit: 0 },
      });

      // 2 calls (10 credits) should succeed
      for (let i = 0; i < 2; i++) {
        const res = await callTool(apiKey);
        expect(res.body.result).toBeDefined();
      }

      // 3rd call would push to 15 credits, exceeding 12 limit
      const res = await callTool(apiKey);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toContain('daily_credit_quota_exceeded');
    });
  });

  describe('Per-key monthly credit quota', () => {
    it('should deny when monthly credit limit would be exceeded', async () => {
      await startServer({ defaultCreditsPerCall: 5 });
      const apiKey = await createApiKey(100, {
        quota: { dailyCallLimit: 0, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 8 },
      });

      // 1 call (5 credits) should succeed
      const res1 = await callTool(apiKey);
      expect(res1.body.result).toBeDefined();

      // 2nd call would push to 10 credits, exceeding 8 limit
      const res2 = await callTool(apiKey);
      expect(res2.body.error).toBeDefined();
      expect(res2.body.error.message).toContain('monthly_credit_quota_exceeded');
    });
  });

  describe('Global quota defaults', () => {
    it('should use global quota when key has no per-key quota', async () => {
      await startServer({
        defaultCreditsPerCall: 1,
        globalQuota: { dailyCallLimit: 2, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
      });
      const apiKey = await createApiKey(100); // No per-key quota

      // 2 calls should succeed
      for (let i = 0; i < 2; i++) {
        const res = await callTool(apiKey);
        expect(res.body.result).toBeDefined();
      }

      // 3rd should be denied by global quota
      const res = await callTool(apiKey);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toContain('daily_call_quota_exceeded');
    });

    it('should use per-key quota over global when both exist', async () => {
      await startServer({
        defaultCreditsPerCall: 1,
        globalQuota: { dailyCallLimit: 2, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
      });
      // Per-key quota: 5 calls/day (overrides global 2)
      const apiKey = await createApiKey(100, {
        quota: { dailyCallLimit: 5, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
      });

      // 4 calls should succeed (would fail at 2 if global were used)
      for (let i = 0; i < 4; i++) {
        const res = await callTool(apiKey);
        expect(res.body.result).toBeDefined();
      }
    });
  });

  describe('Quota admin endpoints', () => {
    it('should set quota via /keys/quota', async () => {
      await startServer({ defaultCreditsPerCall: 1 });
      const apiKey = await createApiKey(100);

      // Set quota
      const setRes = await httpRequest(port, '/keys/quota', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { key: apiKey, dailyCallLimit: 3 },
      });
      expect(setRes.status).toBe(200);
      expect(setRes.body.quota.dailyCallLimit).toBe(3);

      // Now the quota should be enforced
      for (let i = 0; i < 3; i++) {
        const res = await callTool(apiKey);
        expect(res.body.result).toBeDefined();
      }

      const res = await callTool(apiKey);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toContain('daily_call_quota_exceeded');
    });

    it('should remove quota via /keys/quota', async () => {
      await startServer({ defaultCreditsPerCall: 1 });
      const apiKey = await createApiKey(100, {
        quota: { dailyCallLimit: 1, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
      });

      // Use the 1 daily call
      await callTool(apiKey);

      // Should be denied
      const res1 = await callTool(apiKey);
      expect(res1.body.error).toBeDefined();

      // Remove quota
      await httpRequest(port, '/keys/quota', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { key: apiKey, remove: true },
      });

      // Should now succeed
      const res2 = await callTool(apiKey);
      expect(res2.body.result).toBeDefined();
    });

    it('should show quota in /balance', async () => {
      await startServer({ defaultCreditsPerCall: 1 });
      const apiKey = await createApiKey(100, {
        quota: { dailyCallLimit: 10, monthlyCallLimit: 100, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
      });

      // Make a call
      await callTool(apiKey);

      // Check balance
      const res = await httpRequest(port, '/balance', {
        headers: { 'X-API-Key': apiKey },
      });
      expect(res.status).toBe(200);
      expect(res.body.quota).toBeDefined();
      expect(res.body.quota.dailyCallLimit).toBe(10);
      expect(res.body.quotaUsage).toBeDefined();
      expect(res.body.quotaUsage.dailyCalls).toBe(1);
    });
  });
});

// ─── Dynamic Pricing Tests ────────────────────────────────────────────────────

describe('Dynamic Pricing', () => {
  describe('creditsPerKbInput', () => {
    it('should charge base price for small inputs', async () => {
      await startServer({
        defaultCreditsPerCall: 1,
        toolPricing: { search: { creditsPerCall: 2, creditsPerKbInput: 1 } },
      });
      const apiKey = await createApiKey(100);

      // Small input (< 1 KB) → base price (2) + ceil(~0.01 * 1) = 2 + 1 = 3
      await callTool(apiKey, 'search', { query: 'hello' });

      const balance = await httpRequest(port, '/balance', { headers: { 'X-API-Key': apiKey } });
      // Small input: base 2 + ceil(~smallKb * 1) = 3
      expect(balance.body.credits).toBeLessThan(100);
      expect(balance.body.credits).toBeGreaterThanOrEqual(96); // At most 4 credits for a small input
    });

    it('should charge more for large inputs', async () => {
      await startServer({
        defaultCreditsPerCall: 1,
        toolPricing: { search: { creditsPerCall: 2, creditsPerKbInput: 10 } },
      });
      const apiKey = await createApiKey(100);

      // Large input: ~2KB of data → base 2 + ceil(2 * 10) = 22
      const largeContent = 'x'.repeat(2048);
      await callTool(apiKey, 'search', { query: largeContent });

      const balance = await httpRequest(port, '/balance', { headers: { 'X-API-Key': apiKey } });
      // Should have charged significantly more than base price
      expect(balance.body.credits).toBeLessThan(80);
    });

    it('should use base price when no creditsPerKbInput is set', async () => {
      await startServer({
        defaultCreditsPerCall: 1,
        toolPricing: { search: { creditsPerCall: 5 } },
      });
      const apiKey = await createApiKey(100);

      await callTool(apiKey, 'search', { query: 'x'.repeat(2048) });

      const balance = await httpRequest(port, '/balance', { headers: { 'X-API-Key': apiKey } });
      expect(balance.body.credits).toBe(95); // Exactly base price of 5
    });
  });
});

// ─── QuotaTracker Unit Tests ──────────────────────────────────────────────────

describe('QuotaTracker unit tests', () => {
  const { QuotaTracker } = require('../src/quota');
  const tracker = new QuotaTracker();

  function makeRecord(quota?: QuotaConfig): any {
    const today = new Date().toISOString().slice(0, 10);
    const month = new Date().toISOString().slice(0, 7);
    return {
      quotaDailyCalls: 0,
      quotaMonthlyCalls: 0,
      quotaDailyCredits: 0,
      quotaMonthlyCredits: 0,
      quotaLastResetDay: today,
      quotaLastResetMonth: month,
      quota,
    };
  }

  it('should allow calls when no quota is set', () => {
    const record = makeRecord();
    expect(tracker.check(record, 5).allowed).toBe(true);
  });

  it('should enforce daily call limit', () => {
    const record = makeRecord({ dailyCallLimit: 2, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 0 });
    tracker.record(record, 1);
    tracker.record(record, 1);
    expect(tracker.check(record, 1).allowed).toBe(false);
    expect(tracker.check(record, 1).reason).toContain('daily_call_quota');
  });

  it('should enforce monthly credit limit', () => {
    const record = makeRecord({ dailyCallLimit: 0, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 10 });
    tracker.record(record, 8);
    // 8 + 5 = 13 > 10
    expect(tracker.check(record, 5).allowed).toBe(false);
    // 8 + 2 = 10, exactly at limit — should still be allowed
    expect(tracker.check(record, 2).allowed).toBe(true);
  });

  it('should reset daily counters on new day', () => {
    const record = makeRecord({ dailyCallLimit: 1, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 0 });
    tracker.record(record, 1);
    expect(tracker.check(record, 1).allowed).toBe(false);

    // Simulate day change
    record.quotaLastResetDay = '1970-01-01';
    expect(tracker.check(record, 1).allowed).toBe(true);
    expect(record.quotaDailyCalls).toBe(0); // Was reset
  });

  it('should reset monthly counters on new month', () => {
    const record = makeRecord({ dailyCallLimit: 0, monthlyCallLimit: 1, dailyCreditLimit: 0, monthlyCreditLimit: 0 });
    tracker.record(record, 1);
    expect(tracker.check(record, 1).allowed).toBe(false);

    // Simulate month change
    record.quotaLastResetMonth = '1970-01';
    expect(tracker.check(record, 1).allowed).toBe(true);
    expect(record.quotaMonthlyCalls).toBe(0); // Was reset
  });

  it('should unrecord correctly', () => {
    const record = makeRecord();
    tracker.record(record, 5);
    tracker.record(record, 3);
    expect(record.quotaDailyCalls).toBe(2);
    expect(record.quotaDailyCredits).toBe(8);

    tracker.unrecord(record, 3);
    expect(record.quotaDailyCalls).toBe(1);
    expect(record.quotaDailyCredits).toBe(5);
  });

  it('should not go negative on unrecord', () => {
    const record = makeRecord();
    tracker.unrecord(record, 100);
    expect(record.quotaDailyCalls).toBe(0);
    expect(record.quotaDailyCredits).toBe(0);
  });
});
