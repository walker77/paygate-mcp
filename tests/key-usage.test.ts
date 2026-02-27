/**
 * Tests for v4.6.0 — Per-Key Usage Endpoint.
 *
 * Covers:
 *   - UsageMeter.getKeyUsage() method
 *   - GET /keys/usage endpoint
 *   - Per-tool breakdown
 *   - Time-series (hourly buckets)
 *   - Deny reason aggregation
 *   - Recent events list
 *   - Key metadata in response (name, credits, active, suspended)
 *   - Time filtering with `since` param
 *   - Edge cases: no events, unknown key, missing key param
 */

import { UsageMeter } from '../src/meter';
import { DEFAULT_CONFIG } from '../src/types';
import { PayGateServer } from '../src/server';
import http from 'http';

// ─── Helper: make HTTP request ──────────────────────────────────────────────

function request(port: number, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode!, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── UsageMeter Unit Tests ──────────────────────────────────────────────────

describe('UsageMeter getKeyUsage', () => {
  let meter: UsageMeter;
  const apiKey = 'pg_testkey123';
  const otherKey = 'pg_otherkey456';

  beforeEach(() => {
    meter = new UsageMeter();
  });

  test('returns empty usage for key with no events', () => {
    const usage = meter.getKeyUsage(apiKey);
    expect(usage.totalCalls).toBe(0);
    expect(usage.totalAllowed).toBe(0);
    expect(usage.totalDenied).toBe(0);
    expect(usage.totalCreditsSpent).toBe(0);
    expect(Object.keys(usage.perTool)).toHaveLength(0);
    expect(Object.keys(usage.denyReasons)).toHaveLength(0);
    expect(usage.timeSeries).toHaveLength(0);
    expect(usage.recentEvents).toHaveLength(0);
  });

  test('counts total calls, allowed, and denied', () => {
    meter.record({ timestamp: '2025-01-01T10:00:00Z', apiKey, keyName: 'test', tool: 'tool_a', creditsCharged: 5, allowed: true });
    meter.record({ timestamp: '2025-01-01T10:01:00Z', apiKey, keyName: 'test', tool: 'tool_a', creditsCharged: 0, allowed: false, denyReason: 'insufficient_credits' });
    meter.record({ timestamp: '2025-01-01T10:02:00Z', apiKey, keyName: 'test', tool: 'tool_b', creditsCharged: 3, allowed: true });

    const usage = meter.getKeyUsage(apiKey);
    expect(usage.totalCalls).toBe(3);
    expect(usage.totalAllowed).toBe(2);
    expect(usage.totalDenied).toBe(1);
    expect(usage.totalCreditsSpent).toBe(8);
  });

  test('per-tool breakdown', () => {
    meter.record({ timestamp: '2025-01-01T10:00:00Z', apiKey, keyName: 'test', tool: 'tool_a', creditsCharged: 5, allowed: true });
    meter.record({ timestamp: '2025-01-01T10:01:00Z', apiKey, keyName: 'test', tool: 'tool_a', creditsCharged: 5, allowed: true });
    meter.record({ timestamp: '2025-01-01T10:02:00Z', apiKey, keyName: 'test', tool: 'tool_b', creditsCharged: 3, allowed: true });
    meter.record({ timestamp: '2025-01-01T10:03:00Z', apiKey, keyName: 'test', tool: 'tool_b', creditsCharged: 0, allowed: false, denyReason: 'rate_limited' });

    const usage = meter.getKeyUsage(apiKey);
    expect(usage.perTool['tool_a']).toEqual({ calls: 2, credits: 10, denied: 0 });
    expect(usage.perTool['tool_b']).toEqual({ calls: 2, credits: 3, denied: 1 });
  });

  test('deny reason aggregation', () => {
    meter.record({ timestamp: '2025-01-01T10:00:00Z', apiKey, keyName: 'test', tool: 'tool_a', creditsCharged: 0, allowed: false, denyReason: 'insufficient_credits' });
    meter.record({ timestamp: '2025-01-01T10:01:00Z', apiKey, keyName: 'test', tool: 'tool_a', creditsCharged: 0, allowed: false, denyReason: 'rate_limited' });
    meter.record({ timestamp: '2025-01-01T10:02:00Z', apiKey, keyName: 'test', tool: 'tool_a', creditsCharged: 0, allowed: false, denyReason: 'insufficient_credits' });

    const usage = meter.getKeyUsage(apiKey);
    expect(usage.denyReasons['insufficient_credits']).toBe(2);
    expect(usage.denyReasons['rate_limited']).toBe(1);
  });

  test('hourly time-series buckets', () => {
    meter.record({ timestamp: '2025-01-01T10:15:00Z', apiKey, keyName: 'test', tool: 'tool_a', creditsCharged: 5, allowed: true });
    meter.record({ timestamp: '2025-01-01T10:30:00Z', apiKey, keyName: 'test', tool: 'tool_a', creditsCharged: 3, allowed: true });
    meter.record({ timestamp: '2025-01-01T11:05:00Z', apiKey, keyName: 'test', tool: 'tool_a', creditsCharged: 2, allowed: true });

    const usage = meter.getKeyUsage(apiKey);
    expect(usage.timeSeries).toHaveLength(2);
    expect(usage.timeSeries[0].hour).toBe('2025-01-01T10:00:00');
    expect(usage.timeSeries[0].calls).toBe(2);
    expect(usage.timeSeries[0].credits).toBe(8);
    expect(usage.timeSeries[1].hour).toBe('2025-01-01T11:00:00');
    expect(usage.timeSeries[1].calls).toBe(1);
    expect(usage.timeSeries[1].credits).toBe(2);
  });

  test('recent events (newest first, max 50)', () => {
    for (let i = 0; i < 5; i++) {
      meter.record({ timestamp: `2025-01-01T10:0${i}:00Z`, apiKey, keyName: 'test', tool: 'tool_a', creditsCharged: 1, allowed: true });
    }

    const usage = meter.getKeyUsage(apiKey);
    expect(usage.recentEvents).toHaveLength(5);
    // Newest first
    expect(usage.recentEvents[0].timestamp).toBe('2025-01-01T10:04:00Z');
    expect(usage.recentEvents[4].timestamp).toBe('2025-01-01T10:00:00Z');
  });

  test('filters by apiKey (ignores other keys)', () => {
    meter.record({ timestamp: '2025-01-01T10:00:00Z', apiKey, keyName: 'test', tool: 'tool_a', creditsCharged: 5, allowed: true });
    meter.record({ timestamp: '2025-01-01T10:01:00Z', apiKey: otherKey, keyName: 'other', tool: 'tool_a', creditsCharged: 10, allowed: true });

    const usage = meter.getKeyUsage(apiKey);
    expect(usage.totalCalls).toBe(1);
    expect(usage.totalCreditsSpent).toBe(5);
  });

  test('since parameter filters events', () => {
    meter.record({ timestamp: '2025-01-01T10:00:00Z', apiKey, keyName: 'test', tool: 'tool_a', creditsCharged: 5, allowed: true });
    meter.record({ timestamp: '2025-01-02T10:00:00Z', apiKey, keyName: 'test', tool: 'tool_a', creditsCharged: 3, allowed: true });

    const usage = meter.getKeyUsage(apiKey, '2025-01-02T00:00:00Z');
    expect(usage.totalCalls).toBe(1);
    expect(usage.totalCreditsSpent).toBe(3);
  });

  test('recent events capped at 50', () => {
    for (let i = 0; i < 60; i++) {
      const ts = `2025-01-01T10:${String(i).padStart(2, '0')}:00Z`;
      meter.record({ timestamp: ts, apiKey, keyName: 'test', tool: 'tool_a', creditsCharged: 1, allowed: true });
    }

    const usage = meter.getKeyUsage(apiKey);
    expect(usage.recentEvents).toHaveLength(50);
  });
});

// ─── Server Endpoint Tests ──────────────────────────────────────────────────

describe('GET /keys/usage', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  const ECHO_CMD = 'node';
  const ECHO_ARGS = ['-e', 'process.stdin.resume(); process.stdin.on("data", d => { const r = JSON.parse(d.toString().trim()); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: {} }) + "\\n"); });'];

  beforeAll(async () => {
    server = new PayGateServer({
      ...DEFAULT_CONFIG,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  /** Helper: create a fresh test key */
  async function createTestKey(name = 'test', credits = 100): Promise<string> {
    const res = await request(port, 'POST', '/keys', { name, credits }, { 'X-Admin-Key': adminKey });
    return res.body.key;
  }

  /** Helper: make a tool call to generate usage events */
  async function makeToolCall(apiKey: string, toolName = 'test_tool'): Promise<void> {
    await request(port, 'POST', '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: {} },
    }, { 'X-API-Key': apiKey });
  }

  test('returns usage for key with events', async () => {
    const key = await createTestKey('usage-test', 100);
    await makeToolCall(key);
    await makeToolCall(key);

    const res = await request(port, 'GET', `/keys/usage?key=${encodeURIComponent(key)}`, undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('usage-test');
    expect(res.body.totalCalls).toBe(2);
    expect(res.body.totalAllowed).toBe(2);
    expect(res.body.totalDenied).toBe(0);
    expect(res.body.totalCreditsSpent).toBeGreaterThan(0);
    expect(res.body.perTool).toBeDefined();
    expect(res.body.timeSeries).toBeDefined();
    expect(res.body.recentEvents).toBeDefined();
    expect(res.body.recentEvents.length).toBe(2);
  });

  test('returns key metadata', async () => {
    const key = await createTestKey('usage-meta', 200);

    const res = await request(port, 'GET', `/keys/usage?key=${encodeURIComponent(key)}`, undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('usage-meta');
    expect(res.body.credits).toBe(200);
    expect(res.body.active).toBe(true);
    expect(res.body.suspended).toBe(false);
    expect(res.body.key).toMatch(/^pg_.{7}\.\.\./);
  });

  test('returns empty usage for key with no events', async () => {
    const key = await createTestKey('usage-empty', 100);

    const res = await request(port, 'GET', `/keys/usage?key=${encodeURIComponent(key)}`, undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.totalCalls).toBe(0);
    expect(res.body.recentEvents).toHaveLength(0);
  });

  test('per-tool breakdown in response', async () => {
    const key = await createTestKey('usage-tools', 100);
    await makeToolCall(key, 'test_tool');

    const res = await request(port, 'GET', `/keys/usage?key=${encodeURIComponent(key)}`, undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.perTool['test_tool']).toBeDefined();
    expect(res.body.perTool['test_tool'].calls).toBeGreaterThanOrEqual(1);
  });

  test('includes denied events', async () => {
    const key = await createTestKey('usage-denied', 1);
    await makeToolCall(key); // uses the 1 credit
    await makeToolCall(key); // should be denied (insufficient credits)

    const res = await request(port, 'GET', `/keys/usage?key=${encodeURIComponent(key)}`, undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.totalDenied).toBeGreaterThanOrEqual(1);
    expect(Object.keys(res.body.denyReasons).length).toBeGreaterThanOrEqual(1);
  });

  test('works for suspended key', async () => {
    const key = await createTestKey('usage-suspended', 100);
    await makeToolCall(key);
    await request(port, 'POST', '/keys/suspend', { key }, { 'X-Admin-Key': adminKey });

    const res = await request(port, 'GET', `/keys/usage?key=${encodeURIComponent(key)}`, undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.suspended).toBe(true);
    expect(res.body.totalCalls).toBeGreaterThanOrEqual(1);
  });

  test('requires admin auth', async () => {
    const key = await createTestKey('usage-auth', 100);
    const res = await request(port, 'GET', `/keys/usage?key=${encodeURIComponent(key)}`);
    expect(res.status).toBe(401);
  });

  test('requires GET method', async () => {
    const key = await createTestKey('usage-method', 100);
    const res = await request(port, 'POST', '/keys/usage', { key }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(405);
  });

  test('requires key query parameter', async () => {
    const res = await request(port, 'GET', '/keys/usage', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing key query parameter');
  });

  test('returns 404 for unknown key', async () => {
    const res = await request(port, 'GET', '/keys/usage?key=pg_nonexistent', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(404);
  });

  test('root listing includes keyUsage endpoint', async () => {
    const res = await request(port, 'GET', '/');
    expect(res.body.endpoints.keyUsage).toBeDefined();
  });

  test('masks API key in response', async () => {
    const key = await createTestKey('usage-mask', 100);
    const res = await request(port, 'GET', `/keys/usage?key=${encodeURIComponent(key)}`, undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    // Key should be masked (first 10 chars + '...')
    expect(res.body.key.endsWith('...')).toBe(true);
    expect(res.body.key.length).toBeLessThan(key.length);
  });
});
