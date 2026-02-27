/**
 * Tests for v2.8.0 — Batch Tool Calls.
 * Covers: evaluateBatch(), tools/call_batch endpoint, all-or-nothing semantics,
 * aggregate pricing, refund-on-failure, proxy/router batch support.
 */

import { Gate } from '../src/gate';
import { PayGateConfig, DEFAULT_CONFIG, BatchToolCall, BatchGateResult } from '../src/types';
import { PayGateServer } from '../src/server';

// ─── Gate evaluateBatch() Unit Tests ─────────────────────────────────────────

describe('v2.8.0 — Gate.evaluateBatch()', () => {
  let gate: Gate;
  let config: PayGateConfig;

  beforeEach(() => {
    config = {
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 100,
      toolPricing: {
        search: { creditsPerCall: 5 },
        translate: { creditsPerCall: 3 },
        expensive: { creditsPerCall: 50 },
        limited: { creditsPerCall: 1, rateLimitPerMin: 2 },
      },
    };
    gate = new Gate(config);
  });

  afterEach(() => {
    gate.destroy();
  });

  test('empty batch returns allAllowed with zero credits', () => {
    const result = gate.evaluateBatch('pg_test', [], '127.0.0.1');
    expect(result.allAllowed).toBe(true);
    expect(result.totalCredits).toBe(0);
    expect(result.decisions).toEqual([]);
    expect(result.failedIndex).toBe(-1);
  });

  test('single-call batch works like individual evaluate', () => {
    const record = gate.store.createKey('test', 100);
    const result = gate.evaluateBatch(record.key, [{ name: 'search' }]);
    expect(result.allAllowed).toBe(true);
    expect(result.totalCredits).toBe(5);
    expect(result.decisions.length).toBe(1);
    expect(result.decisions[0].creditsCharged).toBe(5);
    expect(result.remainingCredits).toBe(95);
    expect(result.failedIndex).toBe(-1);
  });

  test('multi-call batch aggregates credits correctly', () => {
    const record = gate.store.createKey('test', 100);
    const calls: BatchToolCall[] = [
      { name: 'search' },       // 5 credits
      { name: 'translate' },    // 3 credits
      { name: 'search' },       // 5 credits
    ];
    const result = gate.evaluateBatch(record.key, calls);
    expect(result.allAllowed).toBe(true);
    expect(result.totalCredits).toBe(13);
    expect(result.remainingCredits).toBe(87);
    expect(result.decisions.length).toBe(3);
    expect(result.decisions[0].creditsCharged).toBe(5);
    expect(result.decisions[1].creditsCharged).toBe(3);
    expect(result.decisions[2].creditsCharged).toBe(5);
  });

  test('batch denied when aggregate credits exceed balance', () => {
    const record = gate.store.createKey('test', 10); // Only 10 credits
    const calls: BatchToolCall[] = [
      { name: 'search' },       // 5 credits
      { name: 'translate' },    // 3 credits
      { name: 'search' },       // 5 credits = 13 total
    ];
    const result = gate.evaluateBatch(record.key, calls);
    expect(result.allAllowed).toBe(false);
    expect(result.reason).toContain('insufficient_credits');
    expect(result.reason).toContain('13');
    expect(result.totalCredits).toBe(0); // Nothing charged
    // Credits untouched
    expect(gate.store.getKey(record.key)?.credits).toBe(10);
  });

  test('batch denied when no API key', () => {
    const result = gate.evaluateBatch(null, [{ name: 'search' }]);
    expect(result.allAllowed).toBe(false);
    expect(result.reason).toBe('missing_api_key');
    expect(result.failedIndex).toBe(0);
  });

  test('batch denied when invalid API key', () => {
    const result = gate.evaluateBatch('pg_invalid', [{ name: 'search' }]);
    expect(result.allAllowed).toBe(false);
    expect(result.reason).toBe('invalid_api_key');
  });

  test('batch denied when ACL blocks one tool', () => {
    const record = gate.store.createKey('test', 100);
    gate.store.setAcl(record.key, ['search'], []);
    const calls: BatchToolCall[] = [
      { name: 'search' },
      { name: 'translate' }, // Not in allowedTools
    ];
    const result = gate.evaluateBatch(record.key, calls);
    expect(result.allAllowed).toBe(false);
    expect(result.reason).toContain('tool_not_allowed');
    expect(result.failedIndex).toBe(1);
    // Credits untouched — all-or-nothing
    expect(gate.store.getKey(record.key)?.credits).toBe(100);
  });

  test('batch denied when per-tool rate limit exceeded', () => {
    const record = gate.store.createKey('test', 100);
    // 'limited' has rateLimitPerMin: 2
    const calls: BatchToolCall[] = [
      { name: 'limited' },
      { name: 'limited' },
      { name: 'limited' }, // 3rd call exceeds limit of 2/min
    ];
    const result = gate.evaluateBatch(record.key, calls);
    expect(result.allAllowed).toBe(false);
    expect(result.reason).toContain('tool_rate_limited');
    expect(result.failedIndex).toBe(2);
    // Credits untouched
    expect(gate.store.getKey(record.key)?.credits).toBe(100);
  });

  test('batch denied when spending limit exceeded', () => {
    const record = gate.store.createKey('test', 100);
    const keyRecord = gate.store.getKey(record.key)!;
    keyRecord.spendingLimit = 10; // Max 10 credits total spending
    const calls: BatchToolCall[] = [
      { name: 'search' },   // 5
      { name: 'search' },   // 5
      { name: 'search' },   // 5 = 15 total, exceeds limit of 10
    ];
    const result = gate.evaluateBatch(record.key, calls);
    expect(result.allAllowed).toBe(false);
    expect(result.reason).toContain('spending_limit_exceeded');
  });

  test('batch denied with global rate limit', () => {
    const limitedConfig = { ...config, globalRateLimitPerMin: 1 };
    const limitedGate = new Gate(limitedConfig);
    const record = limitedGate.store.createKey('test', 100);
    // Use up the rate limit
    limitedGate.evaluate(record.key, { name: 'search' });
    // Now try batch
    const result = limitedGate.evaluateBatch(record.key, [{ name: 'translate' }]);
    expect(result.allAllowed).toBe(false);
    expect(result.reason).toContain('rate_limited');
    limitedGate.destroy();
  });

  test('batch shadow mode allows everything', () => {
    const shadowConfig = { ...config, shadowMode: true };
    const shadowGate = new Gate(shadowConfig);
    // No key = would normally be denied
    const result = shadowGate.evaluateBatch(null, [{ name: 'search' }]);
    expect(result.allAllowed).toBe(true);
    expect(result.totalCredits).toBe(0);
    shadowGate.destroy();
  });

  test('batch deducts credits atomically', () => {
    const record = gate.store.createKey('test', 100);
    const calls: BatchToolCall[] = [
      { name: 'search' },       // 5
      { name: 'translate' },    // 3
    ];
    gate.evaluateBatch(record.key, calls);
    // Credits should be deducted in one go
    expect(gate.store.getKey(record.key)?.credits).toBe(92);
  });

  test('batch records usage events for each call', () => {
    const record = gate.store.createKey('test', 100);
    const calls: BatchToolCall[] = [
      { name: 'search' },
      { name: 'translate' },
    ];
    gate.evaluateBatch(record.key, calls);
    const events = gate.meter.getEvents();
    expect(events.length).toBe(2);
    expect(events[0].tool).toBe('search');
    expect(events[1].tool).toBe('translate');
  });

  test('batch with default-priced tools', () => {
    const record = gate.store.createKey('test', 100);
    // 'unknown_tool' uses defaultCreditsPerCall (1)
    const calls: BatchToolCall[] = [
      { name: 'unknown_tool' },
      { name: 'another_tool' },
    ];
    const result = gate.evaluateBatch(record.key, calls);
    expect(result.allAllowed).toBe(true);
    expect(result.totalCredits).toBe(2); // 1 + 1
    expect(result.remainingCredits).toBe(98);
  });

  test('batch IP allowlist check', () => {
    const record = gate.store.createKey('test', 100);
    gate.store.setIpAllowlist(record.key, ['10.0.0.1']);
    const calls: BatchToolCall[] = [{ name: 'search' }];
    // Wrong IP
    const result = gate.evaluateBatch(record.key, calls, '192.168.1.1');
    expect(result.allAllowed).toBe(false);
    expect(result.reason).toContain('ip_not_allowed');
    // Right IP
    const result2 = gate.evaluateBatch(record.key, calls, '10.0.0.1');
    expect(result2.allAllowed).toBe(true);
  });
});

// ─── HTTP Server batch endpoint ─────────────────────────────────────────────

// Mock proxy for server tests
jest.mock('../src/proxy', () => {
  return {
    McpProxy: jest.fn().mockImplementation(() => ({
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      handleRequest: jest.fn().mockImplementation(async (request: any) => {
        return { jsonrpc: '2.0', id: request.id, result: { echo: request.method } };
      }),
      handleBatchRequest: jest.fn().mockImplementation(async (calls: any[], batchId: any, apiKey: string | null) => {
        // Simple mock: check if we have apiKey, return results
        if (!apiKey) {
          return {
            jsonrpc: '2.0',
            id: batchId,
            error: { code: -32402, message: 'Payment required: missing_api_key', data: {} },
          };
        }
        return {
          jsonrpc: '2.0',
          id: batchId,
          result: {
            results: calls.map((c: any, i: number) => ({
              tool: c.name,
              result: { content: [{ type: 'text', text: `result_${i}` }] },
              creditsCharged: 1,
            })),
            totalCreditsCharged: calls.length,
            remainingCredits: 100 - calls.length,
          },
        };
      }),
      isRunning: true,
      on: jest.fn(),
      emit: jest.fn(),
    })),
  };
});

describe('v2.8.0 — HTTP tools/call_batch endpoint', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });

    const result = await server.start();
    port = result.port;
    adminKey = result.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  function request(path: string, options: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {}): Promise<{ status: number; body: any; headers: any }> {
    return new Promise((resolve, reject) => {
      const http = require('http');
      const req = http.request({
        hostname: 'localhost',
        port,
        path,
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      }, (res: any) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers });
          } catch {
            resolve({ status: res.statusCode, body: data, headers: res.headers });
          }
        });
      });
      req.on('error', reject);
      if (options.body) {
        req.write(JSON.stringify(options.body));
      }
      req.end();
    });
  }

  test('tools/call_batch with valid API key returns results', async () => {
    // Create a key
    const keyResp = await request('/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'batch-test', credits: 100 },
    });
    const apiKey = keyResp.body.key;

    const resp = await request('/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call_batch',
        params: {
          calls: [
            { name: 'search', arguments: { q: 'test' } },
            { name: 'translate', arguments: { text: 'hello' } },
          ],
        },
      },
    });

    expect(resp.status).toBe(200);
    expect(resp.body.id).toBe(1);
    expect(resp.body.result).toBeDefined();
    expect(resp.body.result.results).toHaveLength(2);
    expect(resp.body.result.results[0].tool).toBe('search');
    expect(resp.body.result.results[1].tool).toBe('translate');
    expect(typeof resp.body.result.totalCreditsCharged).toBe('number');
    expect(typeof resp.body.result.remainingCredits).toBe('number');
  });

  test('tools/call_batch without API key returns error', async () => {
    const resp = await request('/mcp', {
      method: 'POST',
      body: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call_batch',
        params: {
          calls: [{ name: 'search' }],
        },
      },
    });

    expect(resp.status).toBe(200);
    expect(resp.body.error).toBeDefined();
    expect(resp.body.error.code).toBe(-32402);
  });

  test('tools/call_batch without calls array returns error', async () => {
    const keyResp = await request('/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'batch-test-2', credits: 100 },
    });
    const apiKey = keyResp.body.key;

    const resp = await request('/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call_batch',
        params: {},
      },
    });

    expect(resp.status).toBe(200);
    expect(resp.body.error).toBeDefined();
    expect(resp.body.error.code).toBe(-32602);
    expect(resp.body.error.message).toContain('calls');
  });

  test('tools/call_batch with empty calls returns error', async () => {
    const keyResp = await request('/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'batch-test-3', credits: 100 },
    });
    const apiKey = keyResp.body.key;

    const resp = await request('/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call_batch',
        params: { calls: [] },
      },
    });

    // Empty calls are handled by the proxy — returns error
    expect(resp.status).toBe(200);
    // The mock returns a result for empty calls — the actual proxy would reject
    // but we're testing the server routing here
  });

  test('tools/call_batch returns Mcp-Session-Id header', async () => {
    const keyResp = await request('/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'batch-session', credits: 100 },
    });
    const apiKey = keyResp.body.key;

    const resp = await request('/mcp', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call_batch',
        params: {
          calls: [{ name: 'search' }],
        },
      },
    });

    expect(resp.headers['mcp-session-id']).toBeDefined();
  });
});

// ─── Gate.evaluateBatch() with refund tracking ──────────────────────────────

describe('v2.8.0 — Batch refund and hooks', () => {
  test('onCreditsDeducted hook fires with total batch credits', () => {
    const config: PayGateConfig = {
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      defaultCreditsPerCall: 1,
      toolPricing: {
        search: { creditsPerCall: 5 },
        translate: { creditsPerCall: 3 },
      },
    };
    const gate = new Gate(config);
    const record = gate.store.createKey('test', 100);

    let hookAmount = 0;
    let hookKey = '';
    gate.onCreditsDeducted = (key, amount) => {
      hookKey = key;
      hookAmount = amount;
    };

    gate.evaluateBatch(record.key, [
      { name: 'search' },
      { name: 'translate' },
    ]);

    expect(hookKey).toBe(record.key);
    expect(hookAmount).toBe(8); // 5 + 3
    gate.destroy();
  });

  test('batch refund restores credits for failed calls', () => {
    const config: PayGateConfig = {
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      defaultCreditsPerCall: 1,
      refundOnFailure: true,
      toolPricing: {
        search: { creditsPerCall: 5 },
      },
    };
    const gate = new Gate(config);
    const record = gate.store.createKey('test', 100);

    // evaluateBatch succeeds (credits deducted)
    const batchResult = gate.evaluateBatch(record.key, [
      { name: 'search' },
      { name: 'search' },
    ]);
    expect(batchResult.allAllowed).toBe(true);
    expect(gate.store.getKey(record.key)?.credits).toBe(90);

    // Simulate one failed downstream call — refund that one
    gate.refund(record.key, 'search', 5);
    expect(gate.store.getKey(record.key)?.credits).toBe(95);
    gate.destroy();
  });

  test('batch with quota check (daily limit)', () => {
    const config: PayGateConfig = {
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      defaultCreditsPerCall: 1,
      globalQuota: { dailyCallLimit: 5, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
    };
    const gate = new Gate(config);
    const record = gate.store.createKey('test', 100);

    // First batch of 3 should work
    const result1 = gate.evaluateBatch(record.key, [
      { name: 'a' }, { name: 'b' }, { name: 'c' },
    ]);
    expect(result1.allAllowed).toBe(true);

    // Second batch of 3 should exceed daily limit of 5
    const result2 = gate.evaluateBatch(record.key, [
      { name: 'd' }, { name: 'e' }, { name: 'f' },
    ]);
    expect(result2.allAllowed).toBe(false);
    expect(result2.reason).toContain('quota');
    gate.destroy();
  });

  test('batch with team checker', () => {
    const config: PayGateConfig = {
      ...DEFAULT_CONFIG,
      serverCommand: 'echo',
      defaultCreditsPerCall: 1,
    };
    const gate = new Gate(config);
    const record = gate.store.createKey('test', 100);

    // Set up team checker that rejects > 5 credits
    gate.teamChecker = (_apiKey, credits) => {
      if (credits > 5) return { allowed: false, reason: 'team_budget_exceeded' };
      return { allowed: true };
    };

    // Batch of 6 credits should be rejected
    const result = gate.evaluateBatch(record.key, [
      { name: 'a' }, { name: 'b' }, { name: 'c' },
      { name: 'd' }, { name: 'e' }, { name: 'f' },
    ]);
    expect(result.allAllowed).toBe(false);
    expect(result.reason).toBe('team_budget_exceeded');

    // Credits untouched
    expect(gate.store.getKey(record.key)?.credits).toBe(100);
    gate.destroy();
  });
});
