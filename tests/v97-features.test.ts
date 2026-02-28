/**
 * v9.7.0 Feature Tests:
 *   1. Request/Response Transform Pipeline
 *   2. Backend Retry Policy
 *   3. Adaptive Rate Limiting
 */

import { TransformPipeline } from '../src/transforms';
import { RetryPolicy } from '../src/retry-policy';
import { AdaptiveRateLimiter } from '../src/adaptive-rate-limiter';
import { PayGateServer } from '../src/server';

// ─── Echo MCP server for integration tests ──────────────────────────────────
const ECHO_SERVER_SCRIPT = `
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    try {
      const req = JSON.parse(line);
      if (req.method === 'initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0' } } }) + '\\n');
      } else if (req.method === 'tools/list') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tools: [
          { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } },
        ] } }) + '\\n');
      } else if (req.method === 'tools/call') {
        const args = req.params?.arguments || {};
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: args.msg || 'ok' }] } }) + '\\n');
      } else {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\\n');
      }
    } catch {}
  });
`;

function createTestServer(overrides: Record<string, unknown> = {}) {
  return new PayGateServer({
    serverCommand: process.execPath,
    serverArgs: ['-e', ECHO_SERVER_SCRIPT],
    port: 0,
    defaultCreditsPerCall: 1,
    globalRateLimitPerMin: 1000,
    ...overrides,
  } as any);
}

async function startServer(overrides: Record<string, unknown> = {}) {
  const server = createTestServer(overrides);
  const { port, adminKey } = await server.start();
  return { server, port, adminKey };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. TransformPipeline — Unit Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('TransformPipeline', () => {
  let tp: TransformPipeline;

  beforeEach(() => {
    tp = new TransformPipeline();
  });

  test('createRule: creates rule with defaults', () => {
    const rule = tp.createRule({
      tool: 'echo',
      direction: 'request',
      operations: [{ op: 'set', path: 'timeout', value: 5000 }],
    });
    expect(rule.id).toBeTruthy();
    expect(rule.tool).toBe('echo');
    expect(rule.direction).toBe('request');
    expect(rule.enabled).toBe(true);
    expect(rule.priority).toBe(0);
    expect(tp.size).toBe(1);
  });

  test('createRule: rejects invalid direction', () => {
    expect(() => tp.createRule({ tool: 'echo', direction: 'invalid' as any, operations: [{ op: 'set', path: 'x', value: 1 }] })).toThrow('direction');
  });

  test('createRule: rejects empty operations', () => {
    expect(() => tp.createRule({ tool: 'echo', direction: 'request', operations: [] })).toThrow('at least one');
  });

  test('createRule: rejects invalid op type', () => {
    expect(() => tp.createRule({ tool: 'echo', direction: 'request', operations: [{ op: 'invalid' as any, path: 'x' }] })).toThrow('Invalid operation');
  });

  test('createRule: rejects rename without from', () => {
    expect(() => tp.createRule({ tool: 'echo', direction: 'request', operations: [{ op: 'rename', path: 'x' }] })).toThrow('requires "from"');
  });

  test('removeRule: removes and returns true', () => {
    const rule = tp.createRule({ tool: 'echo', direction: 'request', operations: [{ op: 'set', path: 'x', value: 1 }] });
    expect(tp.removeRule(rule.id)).toBe(true);
    expect(tp.size).toBe(0);
  });

  test('removeRule: returns false for missing', () => {
    expect(tp.removeRule('nonexistent')).toBe(false);
  });

  test('updateRule: updates priority and enabled', () => {
    const rule = tp.createRule({ tool: 'echo', direction: 'request', operations: [{ op: 'set', path: 'x', value: 1 }] });
    const updated = tp.updateRule(rule.id, { priority: 10, enabled: false });
    expect(updated.priority).toBe(10);
    expect(updated.enabled).toBe(false);
  });

  test('updateRule: throws for missing rule', () => {
    expect(() => tp.updateRule('nope', { priority: 1 })).toThrow('not found');
  });

  test('apply: set operation', () => {
    tp.createRule({ tool: 'echo', direction: 'request', operations: [{ op: 'set', path: 'timeout', value: 5000 }] });
    const result = tp.apply('echo', 'request', { msg: 'hi' });
    expect(result.timeout).toBe(5000);
    expect(result.msg).toBe('hi');
  });

  test('apply: remove operation', () => {
    tp.createRule({ tool: 'echo', direction: 'request', operations: [{ op: 'remove', path: 'debug' }] });
    const result = tp.apply('echo', 'request', { msg: 'hi', debug: true });
    expect(result.debug).toBeUndefined();
    expect(result.msg).toBe('hi');
  });

  test('apply: rename operation', () => {
    tp.createRule({ tool: 'echo', direction: 'request', operations: [{ op: 'rename', from: 'q', to: 'query', path: 'query' }] });
    const result = tp.apply('echo', 'request', { q: 'search term' });
    expect(result.query).toBe('search term');
    expect(result.q).toBeUndefined();
  });

  test('apply: template operation', () => {
    tp.createRule({ tool: 'echo', direction: 'request', operations: [{ op: 'template', path: 'prefix', value: '{{namespace}}_data' }] });
    const result = tp.apply('echo', 'request', { msg: 'hi' }, { namespace: 'tenant1' });
    expect(result.prefix).toBe('tenant1_data');
  });

  test('apply: template with missing variable resolves to empty', () => {
    tp.createRule({ tool: 'echo', direction: 'request', operations: [{ op: 'template', path: 'x', value: 'hello {{missing}}!' }] });
    const result = tp.apply('echo', 'request', {});
    expect(result.x).toBe('hello !');
  });

  test('apply: nested path set', () => {
    tp.createRule({ tool: 'echo', direction: 'request', operations: [{ op: 'set', path: 'config.timeout', value: 3000 }] });
    const result = tp.apply('echo', 'request', { msg: 'hi' });
    expect((result.config as any).timeout).toBe(3000);
  });

  test('apply: wildcard tool matches all', () => {
    tp.createRule({ tool: '*', direction: 'request', operations: [{ op: 'set', path: 'injected', value: true }] });
    const r1 = tp.apply('echo', 'request', {});
    const r2 = tp.apply('other', 'request', {});
    expect(r1.injected).toBe(true);
    expect(r2.injected).toBe(true);
  });

  test('apply: direction filter', () => {
    tp.createRule({ tool: 'echo', direction: 'request', operations: [{ op: 'set', path: 'req', value: true }] });
    tp.createRule({ tool: 'echo', direction: 'response', operations: [{ op: 'set', path: 'resp', value: true }] });
    const reqResult = tp.apply('echo', 'request', {});
    const respResult = tp.apply('echo', 'response', {});
    expect(reqResult.req).toBe(true);
    expect(reqResult.resp).toBeUndefined();
    expect(respResult.resp).toBe(true);
    expect(respResult.req).toBeUndefined();
  });

  test('apply: disabled rules skipped', () => {
    const rule = tp.createRule({ tool: 'echo', direction: 'request', operations: [{ op: 'set', path: 'x', value: 1 }], enabled: false });
    const result = tp.apply('echo', 'request', {});
    expect(result.x).toBeUndefined();
  });

  test('apply: priority ordering', () => {
    tp.createRule({ tool: 'echo', direction: 'request', operations: [{ op: 'set', path: 'order', value: 'second' }], priority: 10 });
    tp.createRule({ tool: 'echo', direction: 'request', operations: [{ op: 'set', path: 'order', value: 'first' }], priority: 1 });
    const result = tp.apply('echo', 'request', {});
    expect(result.order).toBe('second'); // priority 10 runs after priority 1
  });

  test('apply: does not mutate input', () => {
    tp.createRule({ tool: 'echo', direction: 'request', operations: [{ op: 'set', path: 'added', value: true }] });
    const input = { msg: 'hi' };
    tp.apply('echo', 'request', input);
    expect((input as any).added).toBeUndefined();
  });

  test('apply: no matching rules returns input unchanged', () => {
    const input = { msg: 'hi' };
    const result = tp.apply('echo', 'request', input);
    expect(result).toEqual(input);
  });

  test('stats: tracks operations', () => {
    tp.createRule({ tool: 'echo', direction: 'request', operations: [{ op: 'set', path: 'x', value: 1 }] });
    tp.createRule({ tool: 'echo', direction: 'response', operations: [{ op: 'remove', path: 'y' }] });
    tp.apply('echo', 'request', {});
    const s = tp.stats();
    expect(s.totalRules).toBe(2);
    expect(s.activeRules).toBe(2);
    expect(s.requestRules).toBe(1);
    expect(s.responseRules).toBe(1);
    expect(s.totalApplied).toBe(1);
  });

  test('exportRules + importRules: round-trip', () => {
    tp.createRule({ tool: 'echo', direction: 'request', operations: [{ op: 'set', path: 'x', value: 1 }] });
    const exported = tp.exportRules();

    const tp2 = new TransformPipeline();
    const imported = tp2.importRules(exported);
    expect(imported).toBe(1);
    expect(tp2.size).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. RetryPolicy — Unit Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('RetryPolicy', () => {
  test('disabled: no retries with maxRetries=0', async () => {
    const rp = new RetryPolicy({ maxRetries: 0 });
    let attempts = 0;
    const result = await rp.execute('echo', async () => { attempts++; return 'ok'; });
    expect(result.result).toBe('ok');
    expect(result.attempts).toBe(1);
    expect(attempts).toBe(1);
  });

  test('succeeds on first attempt', async () => {
    const rp = new RetryPolicy({ maxRetries: 3 });
    const result = await rp.execute('echo', async () => 'ok');
    expect(result.result).toBe('ok');
    expect(result.attempts).toBe(1);
    expect(result.retriedFrom).toBeUndefined();
  });

  test('retries on transient failure then succeeds', async () => {
    const rp = new RetryPolicy({ maxRetries: 3, backoffBaseMs: 1, backoffMaxMs: 5, jitter: false });
    let callCount = 0;
    const result = await rp.execute(
      'echo',
      async () => {
        callCount++;
        if (callCount <= 2) {
          throw Object.assign(new Error('Transient'), { code: -32603 });
        }
        return 'ok';
      },
      () => true, // Always retry
    );
    expect(result.result).toBe('ok');
    expect(callCount).toBe(3);
    expect(result.attempts).toBe(3);
  });

  test('exhausts retries and throws', async () => {
    const rp = new RetryPolicy({ maxRetries: 2, backoffBaseMs: 10, backoffMaxMs: 20 });
    await expect(rp.execute('echo', async () => {
      throw { code: -32603, message: 'Internal error' };
    })).rejects.toMatchObject({ code: -32603 });

    const s = rp.stats();
    expect(s.totalExhausted).toBe(1);
  });

  test('does not retry non-retryable errors', async () => {
    const rp = new RetryPolicy({ maxRetries: 3, backoffBaseMs: 10 });
    let attempts = 0;
    await expect(rp.execute('echo', async () => {
      attempts++;
      throw { code: -32600, message: 'Invalid request' }; // not in retryable list
    })).rejects.toMatchObject({ code: -32600 });
    expect(attempts).toBe(1);
  });

  test('custom retryable checker', async () => {
    const rp = new RetryPolicy({ maxRetries: 2, backoffBaseMs: 10, backoffMaxMs: 20 });
    let attempts = 0;
    const result = await rp.execute(
      'echo',
      async () => {
        attempts++;
        if (attempts < 2) throw new Error('custom retryable');
        return 'ok';
      },
      (err) => err instanceof Error && err.message.includes('custom'),
    );
    expect(result.result).toBe('ok');
    expect(result.attempts).toBe(2);
  });

  test('configure: updates config at runtime', () => {
    const rp = new RetryPolicy();
    const config = rp.configure({ maxRetries: 5, backoffBaseMs: 100 });
    expect(config.maxRetries).toBe(5);
    expect(config.backoffBaseMs).toBe(100);
    expect(rp.isEnabled).toBe(true);
  });

  test('configure: disable by setting maxRetries=0', () => {
    const rp = new RetryPolicy({ maxRetries: 3 });
    rp.configure({ maxRetries: 0 });
    expect(rp.isEnabled).toBe(false);
  });

  test('stats: tracks per-tool stats', async () => {
    const rp = new RetryPolicy({ maxRetries: 2, backoffBaseMs: 10, backoffMaxMs: 20 });
    let attempt = 0;
    await rp.execute('echo', async () => {
      attempt++;
      if (attempt < 2) throw { code: -32603, message: 'fail' };
      return 'ok';
    });
    const s = rp.stats();
    expect(s.totalSuccessAfterRetry).toBe(1);
    expect(s.perTool.echo.successes).toBe(1);
  });

  test('isRetryableError: matches code and message', () => {
    const rp = new RetryPolicy();
    expect(rp.isRetryableError({ code: -32603, message: 'fail' })).toBe(true);
    expect(rp.isRetryableError({ code: -32004, message: 'timeout' })).toBe(true);
    expect(rp.isRetryableError({ code: 'ETIMEDOUT', message: '' })).toBe(true);
    expect(rp.isRetryableError({ message: 'ECONNRESET' })).toBe(true);
    expect(rp.isRetryableError({ code: -32600, message: 'bad request' })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. AdaptiveRateLimiter — Unit Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('AdaptiveRateLimiter', () => {
  let ar: AdaptiveRateLimiter;

  beforeEach(() => {
    ar = new AdaptiveRateLimiter({ enabled: true, cooldownSeconds: 0 });
  });

  test('disabled: always returns 1.0', () => {
    const arDisabled = new AdaptiveRateLimiter({ enabled: false });
    arDisabled.recordCall('key1');
    expect(arDisabled.getMultiplier('key1')).toBe(1.0);
  });

  test('enabled: returns 1.0 for unknown key', () => {
    expect(ar.getMultiplier('unknown')).toBe(1.0);
  });

  test('recordCall and recordError: tracks behavior', () => {
    for (let i = 0; i < 10; i++) ar.recordCall('key1');
    for (let i = 0; i < 5; i++) ar.recordError('key1');
    const s = ar.stats();
    expect(s.totalKeys).toBe(1);
  });

  test('evaluate: tightens for high error rate', () => {
    // 10 calls, 5 errors = 50% error rate (above 30% threshold)
    for (let i = 0; i < 10; i++) {
      ar.recordCall('key1');
      if (i < 5) ar.recordError('key1');
    }
    const adj = ar.evaluate('key1');
    expect(adj).not.toBeNull();
    expect(adj!.newMultiplier).toBeLessThan(1.0);
    expect(adj!.reason).toContain('high error rate');
  });

  test('evaluate: boosts for good behavior', () => {
    // 10 calls, 0 errors, 0 denials
    for (let i = 0; i < 10; i++) ar.recordCall('key1');
    const adj = ar.evaluate('key1');
    expect(adj).not.toBeNull();
    expect(adj!.newMultiplier).toBeGreaterThan(1.0);
    expect(adj!.reason).toContain('good behavior');
  });

  test('evaluate: respects cooldown', () => {
    const arCooldown = new AdaptiveRateLimiter({ enabled: true, cooldownSeconds: 300 });
    for (let i = 0; i < 10; i++) arCooldown.recordCall('key1');
    const first = arCooldown.evaluate('key1');
    expect(first).not.toBeNull();
    // Second evaluation within cooldown should return null
    const second = arCooldown.evaluate('key1');
    expect(second).toBeNull();
  });

  test('evaluate: returns null for insufficient traffic', () => {
    ar.recordCall('key1');
    ar.recordCall('key1');
    const adj = ar.evaluate('key1');
    expect(adj).toBeNull(); // < 5 calls
  });

  test('getEffectiveRate: applies multiplier', () => {
    for (let i = 0; i < 10; i++) ar.recordCall('key1');
    ar.evaluate('key1'); // Should boost to > 1.0
    const effective = ar.getEffectiveRate('key1', 60);
    expect(effective).toBeGreaterThan(60);
  });

  test('evaluateAll: processes all keys', () => {
    for (let i = 0; i < 10; i++) {
      ar.recordCall('key1');
      ar.recordCall('key2');
      if (i < 5) ar.recordError('key2');
    }
    const adjustments = ar.evaluateAll();
    expect(adjustments.length).toBeGreaterThan(0);
  });

  test('configure: updates at runtime', () => {
    const config = ar.configure({ errorRateThreshold: 0.5, maxRatePercent: 300 });
    expect(config.errorRateThreshold).toBe(0.5);
    expect(config.maxRatePercent).toBe(300);
  });

  test('resetKey: removes tracking', () => {
    ar.recordCall('key1');
    ar.resetKey('key1');
    expect(ar.size).toBe(0);
  });

  test('clear: removes all tracking', () => {
    ar.recordCall('key1');
    ar.recordCall('key2');
    ar.clear();
    expect(ar.size).toBe(0);
  });

  test('stats: returns summary', () => {
    for (let i = 0; i < 10; i++) ar.recordCall('key1');
    ar.evaluate('key1');
    const s = ar.stats();
    expect(s.enabled).toBe(true);
    expect(s.totalKeys).toBe(1);
    expect(s.keyDetails.length).toBe(1);
    expect(s.keyDetails[0].recentCalls).toBe(10);
  });

  test('minRatePercent: clamps lower bound', () => {
    ar.configure({ minRatePercent: 50 });
    // All errors → should tighten but not below 50%
    for (let i = 0; i < 10; i++) {
      ar.recordCall('key1');
      ar.recordError('key1');
    }
    ar.evaluate('key1');
    expect(ar.getMultiplier('key1')).toBeGreaterThanOrEqual(0.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Integration Tests — HTTP API
// ═══════════════════════════════════════════════════════════════════════════

describe('v9.7 Integration: Transforms via HTTP', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    ({ server, port, adminKey } = await startServer());
  });

  afterAll(async () => {
    await server.stop();
  });

  test('GET /admin/transforms: empty stats', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/transforms`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.totalRules).toBe(0);
  });

  test('POST /admin/transforms: creates rule', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/transforms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ tool: 'echo', direction: 'request', operations: [{ op: 'set', path: 'injected', value: true }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.id).toBeTruthy();
    expect(body.tool).toBe('echo');
  });

  test('GET /admin/transforms: lists rules', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/transforms`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body = await res.json() as any;
    expect(body.totalRules).toBe(1);
  });

  test('DELETE /admin/transforms: removes rule', async () => {
    // Create a temp rule
    const createRes = await fetch(`http://127.0.0.1:${port}/admin/transforms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ tool: 'temp', direction: 'request', operations: [{ op: 'set', path: 'x', value: 1 }] }),
    });
    const { id } = await createRes.json() as any;

    const delRes = await fetch(`http://127.0.0.1:${port}/admin/transforms?id=${id}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(delRes.status).toBe(200);
    const body = await delRes.json() as any;
    expect(body.deleted).toBe(id);
  });
});

describe('v9.7 Integration: Retry Policy via HTTP', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    ({ server, port, adminKey } = await startServer());
  });

  afterAll(async () => {
    await server.stop();
  });

  test('GET /admin/retry-policy: default stats', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/retry-policy`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.config.maxRetries).toBe(3);
    expect(body.totalAttempts).toBe(0);
  });

  test('POST /admin/retry-policy: updates config', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/retry-policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ maxRetries: 5, backoffBaseMs: 100 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.config.maxRetries).toBe(5);
    expect(body.config.backoffBaseMs).toBe(100);
  });
});

describe('v9.7 Integration: Adaptive Rates via HTTP', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    ({ server, port, adminKey } = await startServer());
  });

  afterAll(async () => {
    await server.stop();
  });

  test('GET /admin/adaptive-rates: default stats', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/adaptive-rates`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.enabled).toBe(false);
    expect(body.totalKeys).toBe(0);
  });

  test('POST /admin/adaptive-rates: enables adaptive rates', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/adaptive-rates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ enabled: true, errorRateThreshold: 0.5 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.enabled).toBe(true);
    expect(body.config.errorRateThreshold).toBe(0.5);
  });
});

describe('v9.7 Integration: Root Listing', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    ({ server, port, adminKey } = await startServer());
  });

  afterAll(async () => {
    await server.stop();
  });

  test('root listing includes v9.7 endpoints', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const endpoints = body.endpoints || {};
    expect(endpoints.adminTransforms).toBeTruthy();
    expect(endpoints.adminRetryPolicy).toBeTruthy();
    expect(endpoints.adminAdaptiveRates).toBeTruthy();
  });
});
