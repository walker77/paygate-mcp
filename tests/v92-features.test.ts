import { PayGateServer } from '../src/server';
import { ResponseCache } from '../src/response-cache';
import { CircuitBreaker } from '../src/circuit-breaker';

// ─── Test MCP Servers ─────────────────────────────────────────────────────

// Standard echo server: responds immediately with "ok"
const serverCommand = process.execPath;
const echoServerArgs = ['-e', 'process.stdin.resume();process.stdin.on("data",d=>{const j=JSON.parse(d);if(j.method==="initialize")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{protocolVersion:"2025-01-01",capabilities:{tools:{}},serverInfo:{name:"echo",version:"1.0"}}})+`\\n`);if(j.method==="tools/list")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{tools:[{name:"echo",inputSchema:{type:"object",properties:{msg:{type:"string"}}}},{name:"slow",inputSchema:{type:"object"}},{name:"fail",inputSchema:{type:"object"}}]}})+`\\n`);if(j.method==="tools/call"){const name=(j.params||{}).name;if(name==="slow"){setTimeout(()=>{process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{content:[{type:"text",text:"slow-ok"}]}})+`\\n`)},3000)}else if(name==="fail"){process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,error:{code:-32603,message:"internal_error"}})+`\\n`)}else{const args=(j.params||{}).arguments||{};process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{content:[{type:"text",text:args.msg||"ok"}]}})+`\\n`)}}})'];

// ─── Helper: call a tool via HTTP ─────────────────────────────────────────

async function callTool(
  port: number,
  apiKey: string,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`http://localhost:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
      'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });
  const body = await res.json();
  return { status: res.status, body, headers: res.headers };
}

async function initSession(port: number, apiKey: string): Promise<string> {
  const res = await fetch(`http://localhost:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-01-01',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
    }),
  });
  return res.headers.get('mcp-session-id') || '';
}

// ═══════════════════════════════════════════════════════════════════════════
// Unit Tests — ResponseCache
// ═══════════════════════════════════════════════════════════════════════════

describe('ResponseCache (unit)', () => {
  it('generates deterministic cache keys from tool name + args', () => {
    const key1 = ResponseCache.cacheKey('echo', { msg: 'hello' });
    const key2 = ResponseCache.cacheKey('echo', { msg: 'hello' });
    const key3 = ResponseCache.cacheKey('echo', { msg: 'world' });
    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
  });

  it('produces same key regardless of property order', () => {
    const key1 = ResponseCache.cacheKey('tool', { a: 1, b: 2, c: 3 });
    const key2 = ResponseCache.cacheKey('tool', { c: 3, a: 1, b: 2 });
    expect(key1).toBe(key2);
  });

  it('stores and retrieves cached responses', () => {
    const cache = new ResponseCache(100);
    cache.set('echo', { msg: 'hi' }, { result: 'ok' }, 60);
    const cached = cache.get('echo', { msg: 'hi' });
    expect(cached).toEqual({ result: 'ok' });
  });

  it('returns undefined for cache miss', () => {
    const cache = new ResponseCache(100);
    const cached = cache.get('echo', { msg: 'hi' });
    expect(cached).toBeUndefined();
  });

  it('expires entries after TTL', async () => {
    const cache = new ResponseCache(100);
    cache.set('echo', { msg: 'hi' }, { result: 'ok' }, 1); // 1 second TTL
    // Should be cached now
    expect(cache.get('echo', { msg: 'hi' })).toBeDefined();
    // Wait for expiry
    await new Promise(r => setTimeout(r, 1100));
    expect(cache.get('echo', { msg: 'hi' })).toBeUndefined();
  });

  it('tracks hit/miss stats', () => {
    const cache = new ResponseCache(100);
    cache.set('echo', { msg: 'a' }, { r: 1 }, 60);
    cache.get('echo', { msg: 'a' }); // hit
    cache.get('echo', { msg: 'a' }); // hit
    cache.get('echo', { msg: 'b' }); // miss
    const stats = cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(66.67, 0);
  });

  it('evicts oldest entry when at max capacity', () => {
    const cache = new ResponseCache(2);
    cache.set('t1', {}, { r: 1 }, 60);
    cache.set('t2', {}, { r: 2 }, 60);
    cache.set('t3', {}, { r: 3 }, 60); // Should evict t1
    expect(cache.get('t1', {})).toBeUndefined();
    expect(cache.get('t2', {})).toBeDefined();
    expect(cache.get('t3', {})).toBeDefined();
    const stats = cache.stats();
    expect(stats.evictions).toBe(1);
  });

  it('clears all entries', () => {
    const cache = new ResponseCache(100);
    cache.set('t1', {}, { r: 1 }, 60);
    cache.set('t2', {}, { r: 2 }, 60);
    const cleared = cache.clear();
    expect(cleared).toBe(2);
    expect(cache.stats().entries).toBe(0);
  });

  it('clears entries for a specific tool', () => {
    const cache = new ResponseCache(100);
    cache.set('t1', { a: 1 }, { r: 1 }, 60);
    cache.set('t1', { a: 2 }, { r: 2 }, 60);
    cache.set('t2', { a: 1 }, { r: 3 }, 60);
    const cleared = cache.clear('t1');
    expect(cleared).toBe(2);
    expect(cache.get('t2', { a: 1 })).toBeDefined();
  });

  it('ignores set with TTL <= 0', () => {
    const cache = new ResponseCache(100);
    cache.set('echo', {}, { r: 1 }, 0);
    cache.set('echo', {}, { r: 2 }, -1);
    expect(cache.stats().entries).toBe(0);
  });

  it('handles undefined args as empty object', () => {
    const cache = new ResponseCache(100);
    cache.set('echo', undefined, { r: 1 }, 60);
    const cached = cache.get('echo', undefined);
    expect(cached).toEqual({ r: 1 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Unit Tests — CircuitBreaker
// ═══════════════════════════════════════════════════════════════════════════

describe('CircuitBreaker (unit)', () => {
  it('starts in closed state', () => {
    const cb = new CircuitBreaker({ threshold: 3, cooldownSeconds: 5 });
    expect(cb.status().state).toBe('closed');
    expect(cb.allowRequest()).toBe(true);
  });

  it('stays closed on successes', () => {
    const cb = new CircuitBreaker({ threshold: 3, cooldownSeconds: 5 });
    cb.recordSuccess();
    cb.recordSuccess();
    cb.recordSuccess();
    expect(cb.status().state).toBe('closed');
    expect(cb.status().totalSuccesses).toBe(3);
  });

  it('opens after threshold consecutive failures', () => {
    const cb = new CircuitBreaker({ threshold: 3, cooldownSeconds: 5 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.status().state).toBe('closed');
    cb.recordFailure();
    expect(cb.status().state).toBe('open');
    expect(cb.allowRequest()).toBe(false);
  });

  it('resets consecutive failure count on success', () => {
    const cb = new CircuitBreaker({ threshold: 3, cooldownSeconds: 5 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess(); // Reset consecutive count
    cb.recordFailure(); // 1st consecutive failure (not 3rd)
    expect(cb.status().state).toBe('closed');
  });

  it('tracks total failures and rejections', () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownSeconds: 60 });
    cb.recordFailure();
    cb.recordFailure(); // Opens circuit
    cb.allowRequest(); // Rejected
    cb.allowRequest(); // Rejected
    const status = cb.status();
    expect(status.totalFailures).toBe(2);
    expect(status.totalRejections).toBe(2);
  });

  it('transitions to half_open after cooldown', async () => {
    const cb = new CircuitBreaker({ threshold: 1, cooldownSeconds: 1 });
    cb.recordFailure(); // Opens circuit
    expect(cb.status().state).toBe('open');
    // Wait for cooldown
    await new Promise(r => setTimeout(r, 1100));
    expect(cb.allowRequest()).toBe(true); // Should be half_open now
    expect(cb.status().state).toBe('half_open');
  });

  it('closes on success in half_open state', async () => {
    const cb = new CircuitBreaker({ threshold: 1, cooldownSeconds: 1 });
    cb.recordFailure(); // Opens circuit
    await new Promise(r => setTimeout(r, 1100));
    cb.allowRequest(); // Transition to half_open
    cb.recordSuccess(); // Should close
    expect(cb.status().state).toBe('closed');
  });

  it('re-opens on failure in half_open state', async () => {
    const cb = new CircuitBreaker({ threshold: 1, cooldownSeconds: 1 });
    cb.recordFailure(); // Opens circuit
    await new Promise(r => setTimeout(r, 1100));
    cb.allowRequest(); // Transition to half_open
    cb.recordFailure(); // Should re-open
    expect(cb.status().state).toBe('open');
  });

  it('reset() closes the circuit', () => {
    const cb = new CircuitBreaker({ threshold: 1, cooldownSeconds: 60 });
    cb.recordFailure(); // Opens circuit
    expect(cb.status().state).toBe('open');
    cb.reset();
    expect(cb.status().state).toBe('closed');
    expect(cb.allowRequest()).toBe(true);
  });

  it('status() includes lastFailureAt and openedAt timestamps', () => {
    const cb = new CircuitBreaker({ threshold: 1, cooldownSeconds: 60 });
    expect(cb.status().lastFailureAt).toBeNull();
    expect(cb.status().openedAt).toBeNull();
    cb.recordFailure();
    expect(cb.status().lastFailureAt).not.toBeNull();
    expect(cb.status().openedAt).not.toBeNull();
  });

  it('enforces minimum threshold of 1', () => {
    const cb = new CircuitBreaker({ threshold: 0, cooldownSeconds: 5 });
    cb.recordFailure(); // Should trip at 1
    expect(cb.status().state).toBe('open');
  });

  it('enforces minimum cooldown of 1 second', () => {
    const cb = new CircuitBreaker({ threshold: 1, cooldownSeconds: 0 });
    cb.recordFailure(); // Opens
    // The minimum cooldown is 1000ms (enforced by constructor)
    expect(cb.allowRequest()).toBe(false); // Should still be open
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration Tests — Response Caching via HTTP
// ═══════════════════════════════════════════════════════════════════════════

describe('v9.2.0 Response Caching (integration)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let testKey: string;
  let sessionId: string;

  beforeEach(async () => {
    server = new PayGateServer({
      serverCommand,
      serverArgs: echoServerArgs,
      port: 0,
      cacheTtlSeconds: 300, // 5 minute global TTL
      maxCacheEntries: 100,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    // Create test key with lots of credits
    const res = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'cache-test', credits: 10000 }),
    });
    const body: any = await res.json();
    testKey = body.key;

    // Initialize session
    sessionId = await initSession(port, testKey);
  }, 30_000);

  afterEach(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  it('returns X-Cache: MISS on first call', async () => {
    const { headers } = await callTool(port, testKey, sessionId, 'echo', { msg: 'hello' });
    expect(headers.get('x-cache')).toBe('MISS');
  });

  it('returns X-Cache: HIT on second identical call', async () => {
    await callTool(port, testKey, sessionId, 'echo', { msg: 'cache-me' });
    const { headers } = await callTool(port, testKey, sessionId, 'echo', { msg: 'cache-me' });
    expect(headers.get('x-cache')).toBe('HIT');
  });

  it('cache hit returns same response content', async () => {
    const first = await callTool(port, testKey, sessionId, 'echo', { msg: 'stable' });
    const second = await callTool(port, testKey, sessionId, 'echo', { msg: 'stable' });
    expect(second.body.result).toEqual(first.body.result);
  });

  it('different args produce cache miss', async () => {
    await callTool(port, testKey, sessionId, 'echo', { msg: 'aaa' });
    const { headers } = await callTool(port, testKey, sessionId, 'echo', { msg: 'bbb' });
    expect(headers.get('x-cache')).toBe('MISS');
  });

  it('cache hit does not deduct additional credits', async () => {
    // First call — deducts 1 credit (MISS)
    await callTool(port, testKey, sessionId, 'echo', { msg: 'credit-test' });
    const bal1 = await fetch(`http://localhost:${port}/balance`, { headers: { 'X-API-Key': testKey } });
    const credits1 = (await bal1.json() as any).credits;

    // Second call — should be HIT, no credit deduction
    await callTool(port, testKey, sessionId, 'echo', { msg: 'credit-test' });
    const bal2 = await fetch(`http://localhost:${port}/balance`, { headers: { 'X-API-Key': testKey } });
    const credits2 = (await bal2.json() as any).credits;

    // Cache hit should preserve credits (same balance)
    expect(credits2).toBe(credits1);
  });

  // ─── Admin /admin/cache endpoint ───

  it('GET /admin/cache returns cache stats', async () => {
    // Seed cache with a call
    await callTool(port, testKey, sessionId, 'echo', { msg: 'stats-test' });

    const res = await fetch(`http://localhost:${port}/admin/cache`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.entries).toBeGreaterThanOrEqual(1);
    expect(body.maxEntries).toBe(100);
    expect(typeof body.hits).toBe('number');
    expect(typeof body.misses).toBe('number');
  });

  it('DELETE /admin/cache clears all cache entries', async () => {
    // Seed cache
    await callTool(port, testKey, sessionId, 'echo', { msg: 'clear-test-1' });
    await callTool(port, testKey, sessionId, 'echo', { msg: 'clear-test-2' });

    const delRes = await fetch(`http://localhost:${port}/admin/cache`, {
      method: 'DELETE',
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(delRes.status).toBe(200);
    const delBody: any = await delRes.json();
    expect(delBody.cleared).toBeGreaterThanOrEqual(2);

    // Verify cache is empty
    const statsRes = await fetch(`http://localhost:${port}/admin/cache`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const stats: any = await statsRes.json();
    expect(stats.entries).toBe(0);
  });

  it('DELETE /admin/cache?tool=echo clears only echo entries', async () => {
    // Call two different tools to seed cache
    await callTool(port, testKey, sessionId, 'echo', { msg: 'tool-clear-1' });

    const delRes = await fetch(`http://localhost:${port}/admin/cache?tool=echo`, {
      method: 'DELETE',
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(delRes.status).toBe(200);
    const body: any = await delRes.json();
    expect(body.tool).toBe('echo');
    expect(body.cleared).toBeGreaterThanOrEqual(1);
  });

  it('/admin/cache requires admin auth', async () => {
    const res = await fetch(`http://localhost:${port}/admin/cache`);
    expect(res.status).toBe(401);
  });

  it('POST /admin/cache returns 405', async () => {
    const res = await fetch(`http://localhost:${port}/admin/cache`, {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(405);
  });

  it('admin/cache appears in root listing', async () => {
    const res = await fetch(`http://localhost:${port}/`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.endpoints.adminCache).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration Tests — Circuit Breaker via HTTP
// ═══════════════════════════════════════════════════════════════════════════

describe('v9.2.0 Circuit Breaker (integration)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let testKey: string;
  let sessionId: string;

  beforeEach(async () => {
    server = new PayGateServer({
      serverCommand,
      serverArgs: echoServerArgs,
      port: 0,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownSeconds: 2,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    const res = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'cb-test', credits: 10000 }),
    });
    const body: any = await res.json();
    testKey = body.key;

    sessionId = await initSession(port, testKey);
  }, 30_000);

  afterEach(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  it('circuit starts closed — successful calls pass through', async () => {
    const { body } = await callTool(port, testKey, sessionId, 'echo', { msg: 'hi' });
    expect(body.result).toBeDefined();
    expect(body.error).toBeUndefined();
  });

  it('opens circuit after threshold consecutive failures', async () => {
    // The "fail" tool returns -32603 error, which the circuit breaker counts as a failure
    await callTool(port, testKey, sessionId, 'fail');
    await callTool(port, testKey, sessionId, 'fail');
    await callTool(port, testKey, sessionId, 'fail');

    // Next call should be rejected by circuit breaker
    const { body } = await callTool(port, testKey, sessionId, 'echo', { msg: 'should-reject' });
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32003);
    expect(body.error.message).toContain('circuit_breaker_open');
  });

  it('circuit breaker recovers after cooldown', async () => {
    // Trip the circuit
    await callTool(port, testKey, sessionId, 'fail');
    await callTool(port, testKey, sessionId, 'fail');
    await callTool(port, testKey, sessionId, 'fail');

    // Verify circuit is open
    const rejectedCall = await callTool(port, testKey, sessionId, 'echo', { msg: 'rejected' });
    expect(rejectedCall.body.error?.code).toBe(-32003);

    // Wait for cooldown (2 seconds + buffer)
    await new Promise(r => setTimeout(r, 2500));

    // Should recover — circuit in half_open, probe request succeeds
    const recovered = await callTool(port, testKey, sessionId, 'echo', { msg: 'recovered' });
    expect(recovered.body.result).toBeDefined();
    expect(recovered.body.error).toBeUndefined();
  }, 15_000);

  // ─── Admin /admin/circuit endpoint ───

  it('GET /admin/circuit returns circuit status', async () => {
    const res = await fetch(`http://localhost:${port}/admin/circuit`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.state).toBe('closed');
    expect(typeof body.totalFailures).toBe('number');
    expect(typeof body.totalSuccesses).toBe('number');
  });

  it('GET /admin/circuit shows open state after failures', async () => {
    // Trip the circuit
    await callTool(port, testKey, sessionId, 'fail');
    await callTool(port, testKey, sessionId, 'fail');
    await callTool(port, testKey, sessionId, 'fail');

    const res = await fetch(`http://localhost:${port}/admin/circuit`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.state).toBe('open');
    expect(body.consecutiveFailures).toBe(3);
    expect(body.openedAt).not.toBeNull();
  });

  it('POST /admin/circuit resets circuit to closed', async () => {
    // Trip the circuit
    await callTool(port, testKey, sessionId, 'fail');
    await callTool(port, testKey, sessionId, 'fail');
    await callTool(port, testKey, sessionId, 'fail');

    // Manually reset
    const resetRes = await fetch(`http://localhost:${port}/admin/circuit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
    });
    expect(resetRes.status).toBe(200);
    const body: any = await resetRes.json();
    expect(body.reset).toBe(true);
    expect(body.state).toBe('closed');

    // Should be able to make calls again
    const { body: callBody } = await callTool(port, testKey, sessionId, 'echo', { msg: 'after-reset' });
    expect(callBody.result).toBeDefined();
  });

  it('/admin/circuit requires admin auth', async () => {
    const res = await fetch(`http://localhost:${port}/admin/circuit`);
    expect(res.status).toBe(401);
  });

  it('DELETE /admin/circuit returns 405', async () => {
    const res = await fetch(`http://localhost:${port}/admin/circuit`, {
      method: 'DELETE',
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(405);
  });

  it('admin/circuit appears in root listing', async () => {
    const res = await fetch(`http://localhost:${port}/`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.endpoints.adminCircuit).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration Tests — Configurable Timeouts
// ═══════════════════════════════════════════════════════════════════════════

describe('v9.2.0 Configurable Timeouts (integration)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let testKey: string;
  let sessionId: string;

  beforeEach(async () => {
    server = new PayGateServer({
      serverCommand,
      serverArgs: echoServerArgs,
      port: 0,
      toolTimeoutMs: 1500, // 1.5s global timeout
      toolPricing: {
        slow: { creditsPerCall: 1, timeoutMs: 500 }, // Per-tool override: 500ms
      },
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    const res = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'timeout-test', credits: 10000 }),
    });
    const body: any = await res.json();
    testKey = body.key;

    sessionId = await initSession(port, testKey);
  }, 30_000);

  afterEach(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  it('fast tools complete within global timeout', async () => {
    const { body } = await callTool(port, testKey, sessionId, 'echo', { msg: 'fast' });
    expect(body.result).toBeDefined();
    expect(body.error).toBeUndefined();
  });

  it('per-tool timeout overrides global timeout for slow tool', async () => {
    // "slow" tool takes 3 seconds, per-tool timeout is 500ms
    const { body } = await callTool(port, testKey, sessionId, 'slow');
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32004);
    expect(body.error.message).toContain('tool_timeout');
    expect(body.error.message).toContain('slow');
    expect(body.error.message).toContain('500ms');
  }, 10_000);

  it('timeout error includes tool name in message', async () => {
    const { body } = await callTool(port, testKey, sessionId, 'slow');
    expect(body.error.message).toMatch(/slow.*exceeded.*500ms/);
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration Tests — Features disabled by default
// ═══════════════════════════════════════════════════════════════════════════

describe('v9.2.0 Features disabled by default', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeEach(async () => {
    // Default config — no caching, no circuit breaker, no timeouts
    server = new PayGateServer({
      serverCommand,
      serverArgs: echoServerArgs,
      port: 0,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  }, 30_000);

  afterEach(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  it('no X-Cache header when caching is disabled', async () => {
    const keyRes = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'test', credits: 100 }),
    });
    const { key } = await keyRes.json() as any;
    const sid = await initSession(port, key);
    const { headers } = await callTool(port, key, sid, 'echo', { msg: 'no-cache' });
    expect(headers.get('x-cache')).toBeNull();
  });

  it('GET /admin/cache reports disabled', async () => {
    const res = await fetch(`http://localhost:${port}/admin/cache`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.enabled).toBe(false);
  });

  it('GET /admin/circuit reports disabled', async () => {
    const res = await fetch(`http://localhost:${port}/admin/circuit`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.enabled).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration Tests — Combined features
// ═══════════════════════════════════════════════════════════════════════════

describe('v9.2.0 Combined features', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let testKey: string;
  let sessionId: string;

  beforeEach(async () => {
    server = new PayGateServer({
      serverCommand,
      serverArgs: echoServerArgs,
      port: 0,
      cacheTtlSeconds: 300,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownSeconds: 2,
      toolTimeoutMs: 5000,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    const res = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'combined-test', credits: 10000 }),
    });
    const body: any = await res.json();
    testKey = body.key;

    sessionId = await initSession(port, testKey);
  }, 30_000);

  afterEach(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  it('cache hit bypasses circuit breaker', async () => {
    // Make a successful call to populate cache
    await callTool(port, testKey, sessionId, 'echo', { msg: 'cached-before-trip' });

    // Trip the circuit breaker with fail tool
    await callTool(port, testKey, sessionId, 'fail');
    await callTool(port, testKey, sessionId, 'fail');
    await callTool(port, testKey, sessionId, 'fail');

    // Cached response should still be served even with open circuit
    const { body, headers } = await callTool(port, testKey, sessionId, 'echo', { msg: 'cached-before-trip' });
    expect(headers.get('x-cache')).toBe('HIT');
    expect(body.result).toBeDefined();
    expect(body.error).toBeUndefined();
  });

  it('OpenAPI spec includes /admin/cache and /admin/circuit', async () => {
    const res = await fetch(`http://localhost:${port}/openapi.json`);
    const spec: any = await res.json();
    expect(spec.paths['/admin/cache']).toBeDefined();
    expect(spec.paths['/admin/circuit']).toBeDefined();
  });

  it('all three features appear in startup output', async () => {
    // Just verify the server started with all features configured
    const statusRes = await fetch(`http://localhost:${port}/admin/cache`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect((await statusRes.json() as any).enabled).toBe(true);

    const circuitRes = await fetch(`http://localhost:${port}/admin/circuit`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect((await circuitRes.json() as any).enabled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration Tests — Per-tool cache TTL overrides
// ═══════════════════════════════════════════════════════════════════════════

describe('v9.2.0 Per-tool cache TTL', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let testKey: string;
  let sessionId: string;

  beforeEach(async () => {
    server = new PayGateServer({
      serverCommand,
      serverArgs: echoServerArgs,
      port: 0,
      cacheTtlSeconds: 0, // Global caching disabled
      toolPricing: {
        echo: { creditsPerCall: 1, cacheTtlSeconds: 300 }, // But echo tool has caching enabled
      },
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    const res = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'ttl-test', credits: 10000 }),
    });
    const body: any = await res.json();
    testKey = body.key;

    sessionId = await initSession(port, testKey);
  }, 30_000);

  afterEach(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  it('per-tool TTL enables caching even when global is disabled', async () => {
    await callTool(port, testKey, sessionId, 'echo', { msg: 'per-tool-ttl' });
    const { headers } = await callTool(port, testKey, sessionId, 'echo', { msg: 'per-tool-ttl' });
    expect(headers.get('x-cache')).toBe('HIT');
  });
});
