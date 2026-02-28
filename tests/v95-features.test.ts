/**
 * v9.5.0 Feature Tests:
 *   1. Concurrency Limiter (per-key/per-tool inflight caps)
 *   2. Traffic Mirroring (fire-and-forget shadow requests)
 *   3. Tool Aliasing + Deprecation (RFC 8594)
 */

import { ConcurrencyLimiter } from '../src/concurrency-limiter';
import { TrafficMirror } from '../src/traffic-mirror';
import { ToolAliasManager } from '../src/tool-aliases';
import { PayGateServer } from '../src/server';
import * as http from 'http';

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
          { name: 'slow', description: 'Slow tool', inputSchema: { type: 'object', properties: { delay: { type: 'number' } } } },
          { name: 'new_echo', description: 'New Echo', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } },
        ] } }) + '\\n');
      } else if (req.method === 'tools/call') {
        const args = req.params?.arguments || {};
        if (req.params?.name === 'slow') {
          const delay = args.delay || 200;
          setTimeout(() => {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'done after ' + delay + 'ms' }] } }) + '\\n');
          }, delay);
        } else {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: args.msg || 'ok' }] } }) + '\\n');
        }
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

async function createKey(port: number, adminKey: string, credits = 100, extra: Record<string, unknown> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
    body: JSON.stringify({ name: 'test-key', credits, ...extra }),
  });
  return (await res.json()) as any;
}

async function callTool(port: number, apiKey: string, toolName: string, args: Record<string, unknown> = {}) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: args } }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Concurrency Limiter — Unit Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('ConcurrencyLimiter (unit)', () => {
  test('allows requests when disabled (limits = 0)', () => {
    const cl = new ConcurrencyLimiter({ maxConcurrentPerKey: 0, maxConcurrentPerTool: 0 });
    expect(cl.enabled).toBe(false);
    const r = cl.acquire('key1', 'tool1');
    expect(r.acquired).toBe(true);
    cl.release('key1', 'tool1');
  });

  test('enforces per-key limit', () => {
    const cl = new ConcurrencyLimiter({ maxConcurrentPerKey: 2, maxConcurrentPerTool: 0 });
    expect(cl.enabled).toBe(true);

    // First two succeed
    expect(cl.acquire('key1', 'tool1').acquired).toBe(true);
    expect(cl.acquire('key1', 'tool2').acquired).toBe(true);

    // Third for same key fails
    const r3 = cl.acquire('key1', 'tool3');
    expect(r3.acquired).toBe(false);
    expect(r3.reason).toContain('Key concurrency limit');
    expect(r3.currentInflight).toBe(2);
    expect(r3.limit).toBe(2);

    // Different key still works
    expect(cl.acquire('key2', 'tool1').acquired).toBe(true);

    // Release one, then key1 can acquire again
    cl.release('key1', 'tool1');
    expect(cl.acquire('key1', 'tool3').acquired).toBe(true);

    cl.release('key1', 'tool2');
    cl.release('key1', 'tool3');
    cl.release('key2', 'tool1');
  });

  test('enforces per-tool limit', () => {
    const cl = new ConcurrencyLimiter({ maxConcurrentPerKey: 0, maxConcurrentPerTool: 3 });

    expect(cl.acquire('k1', 'search').acquired).toBe(true);
    expect(cl.acquire('k2', 'search').acquired).toBe(true);
    expect(cl.acquire('k3', 'search').acquired).toBe(true);

    const r = cl.acquire('k4', 'search');
    expect(r.acquired).toBe(false);
    expect(r.reason).toContain('Tool concurrency limit');
    expect(r.reason).toContain('search');

    // Different tool still works
    expect(cl.acquire('k4', 'other_tool').acquired).toBe(true);

    cl.release('k1', 'search');
    cl.release('k2', 'search');
    cl.release('k3', 'search');
    cl.release('k4', 'other_tool');
  });

  test('enforces both key and tool limits simultaneously', () => {
    const cl = new ConcurrencyLimiter({ maxConcurrentPerKey: 2, maxConcurrentPerTool: 3 });

    // Key1: 2 calls
    expect(cl.acquire('k1', 't1').acquired).toBe(true);
    expect(cl.acquire('k1', 't1').acquired).toBe(true);
    // Key1 hits key limit
    expect(cl.acquire('k1', 't1').acquired).toBe(false);

    // Key2: 1 call to t1 (t1 now at 3 = tool limit)
    expect(cl.acquire('k2', 't1').acquired).toBe(true);
    // t1 at capacity
    const r = cl.acquire('k3', 't1');
    expect(r.acquired).toBe(false);
    expect(r.reason).toContain('Tool concurrency limit');

    cl.release('k1', 't1');
    cl.release('k1', 't1');
    cl.release('k2', 't1');
  });

  test('snapshot returns current inflight state', () => {
    const cl = new ConcurrencyLimiter({ maxConcurrentPerKey: 10, maxConcurrentPerTool: 10 });
    cl.acquire('k1', 't1');
    cl.acquire('k1', 't2');
    cl.acquire('k2', 't1');

    const snap = cl.snapshot();
    expect(snap.byKey['k1']).toBe(2);
    expect(snap.byKey['k2']).toBe(1);
    expect(snap.byTool['t1']).toBe(2);
    expect(snap.byTool['t2']).toBe(1);
    expect(snap.totalInflight).toBe(3);
    expect(snap.byKeyTool['k1:t1']).toBe(1);
    expect(snap.byKeyTool['k1:t2']).toBe(1);

    cl.release('k1', 't1');
    cl.release('k1', 't2');
    cl.release('k2', 't1');

    const snap2 = cl.snapshot();
    expect(snap2.totalInflight).toBe(0);
  });

  test('release cleans up zero-count entries', () => {
    const cl = new ConcurrencyLimiter({ maxConcurrentPerKey: 5, maxConcurrentPerTool: 5 });
    cl.acquire('k1', 't1');
    cl.release('k1', 't1');

    const snap = cl.snapshot();
    expect(snap.byKey['k1']).toBeUndefined();
    expect(snap.byTool['t1']).toBeUndefined();
  });

  test('double release does not go negative', () => {
    const cl = new ConcurrencyLimiter({ maxConcurrentPerKey: 5, maxConcurrentPerTool: 5 });
    cl.acquire('k1', 't1');
    cl.release('k1', 't1');
    cl.release('k1', 't1'); // extra release

    expect(cl.getKeyInflight('k1')).toBe(0);
    expect(cl.getToolInflight('t1')).toBe(0);
  });

  test('limits getter returns config copy', () => {
    const cl = new ConcurrencyLimiter({ maxConcurrentPerKey: 5, maxConcurrentPerTool: 10 });
    const l = cl.limits;
    expect(l.maxConcurrentPerKey).toBe(5);
    expect(l.maxConcurrentPerTool).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Traffic Mirroring — Unit Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('TrafficMirror (unit)', () => {
  test('disabled by default when no config', () => {
    const tm = new TrafficMirror();
    expect(tm.enabled).toBe(false);
    const s = tm.stats();
    expect(s.enabled).toBe(false);
    expect(s.mirrorUrl).toBeNull();
    expect(s.totalMirrored).toBe(0);
  });

  test('enabled when url is configured', () => {
    const tm = new TrafficMirror({ url: 'http://localhost:9999/mcp' });
    expect(tm.enabled).toBe(true);
    const s = tm.stats();
    expect(s.enabled).toBe(true);
    expect(s.mirrorUrl).toBe('http://localhost:9999/mcp');
    expect(s.percentage).toBe(100);
  });

  test('configure() enables mirroring', () => {
    const tm = new TrafficMirror();
    expect(tm.enabled).toBe(false);
    tm.configure({ url: 'http://mirror:3000', percentage: 50, timeoutMs: 3000 });
    expect(tm.enabled).toBe(true);
    expect(tm.stats().percentage).toBe(50);
  });

  test('disable() stops mirroring', () => {
    const tm = new TrafficMirror({ url: 'http://localhost:9999' });
    expect(tm.enabled).toBe(true);
    tm.disable();
    expect(tm.enabled).toBe(false);
  });

  test('clearStats resets counters', () => {
    const tm = new TrafficMirror({ url: 'http://localhost:9999' });
    // Simulate some stats by directly mirroring to non-existent server
    tm.mirror({ jsonrpc: '2.0', id: 1, method: 'tools/call' }, 'test_tool');
    // Wait a tick for the async mirror to record
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        tm.clearStats();
        const s = tm.stats();
        expect(s.totalMirrored).toBe(0);
        expect(s.totalSuccess).toBe(0);
        expect(s.totalErrors).toBe(0);
        resolve();
      }, 200);
    });
  });

  test('percentage clamped to 0-100', () => {
    const tm = new TrafficMirror({ url: 'http://test:1234', percentage: 150 });
    expect(tm.stats().percentage).toBe(100);

    tm.configure({ url: 'http://test:1234', percentage: -10 });
    expect(tm.stats().percentage).toBe(0);
  });

  test('mirror to real HTTP server records success', async () => {
    // Start a simple HTTP server that accepts POST
    const mirrorServer = http.createServer((_req, res) => {
      let body = '';
      _req.on('data', (chunk: Buffer) => { body += chunk; });
      _req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });

    await new Promise<void>((resolve) => mirrorServer.listen(0, '127.0.0.1', resolve));
    const mirrorPort = (mirrorServer.address() as any).port;

    try {
      const tm = new TrafficMirror({ url: `http://127.0.0.1:${mirrorPort}/mcp` });
      const request = { jsonrpc: '2.0' as const, id: 42, method: 'tools/call', params: { name: 'echo', arguments: { msg: 'test' } } };

      // Listen for mirror-result event
      const resultPromise = new Promise<any>((resolve) => {
        tm.on('mirror-result', resolve);
      });

      tm.mirror(request, 'echo');
      const result = await resultPromise;

      expect(result.statusCode).toBe(200);
      expect(result.error).toBeNull();
      expect(result.tool).toBe('echo');

      const s = tm.stats();
      expect(s.totalMirrored).toBe(1);
      expect(s.totalSuccess).toBe(1);
      expect(s.totalErrors).toBe(0);
    } finally {
      mirrorServer.close();
    }
  });

  test('mirror to non-existent server records error', async () => {
    const tm = new TrafficMirror({ url: 'http://127.0.0.1:1/never' });
    const request = { jsonrpc: '2.0' as const, id: 1, method: 'tools/call' };

    const resultPromise = new Promise<any>((resolve) => {
      tm.on('mirror-result', resolve);
    });

    tm.mirror(request, 'test_tool');
    const result = await resultPromise;

    expect(result.statusCode).toBeNull();
    expect(result.error).toBeTruthy();
    expect(tm.stats().totalErrors).toBe(1);
  });

  test('0% sampling never sends', () => {
    const tm = new TrafficMirror({ url: 'http://test:1234', percentage: 0 });
    // Mirror 100 requests — none should be sent
    for (let i = 0; i < 100; i++) {
      tm.mirror({ jsonrpc: '2.0', id: i, method: 'tools/call' }, 'tool');
    }
    expect(tm.stats().totalMirrored).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Tool Alias Manager — Unit Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('ToolAliasManager (unit)', () => {
  test('resolve returns unchanged name when no alias', () => {
    const m = new ToolAliasManager();
    const r = m.resolve('echo');
    expect(r.resolvedName).toBe('echo');
    expect(r.isAlias).toBe(false);
    expect(r.alias).toBeNull();
  });

  test('addAlias + resolve routes to target', () => {
    const m = new ToolAliasManager();
    const alias = m.addAlias('old_echo', 'new_echo');
    expect(alias.from).toBe('old_echo');
    expect(alias.to).toBe('new_echo');
    expect(alias.createdAt).toBeTruthy();

    const r = m.resolve('old_echo');
    expect(r.resolvedName).toBe('new_echo');
    expect(r.isAlias).toBe(true);
    expect(r.alias).not.toBeNull();
    expect(r.alias!.from).toBe('old_echo');
  });

  test('alias with sunset date and message', () => {
    const m = new ToolAliasManager();
    const sunset = '2026-06-01T00:00:00Z';
    const alias = m.addAlias('legacy_search', 'search_v2', sunset, 'Use search_v2 instead');
    expect(alias.sunsetDate).toBe(sunset);
    expect(alias.message).toBe('Use search_v2 instead');
  });

  test('prevents alias chains (A → B, then B → C)', () => {
    const m = new ToolAliasManager();
    m.addAlias('a', 'b');
    expect(() => m.addAlias('b', 'c')).toThrow('Cannot create chain');
  });

  test('prevents reverse alias chains (A → B, then C → A where A is a FROM)', () => {
    const m = new ToolAliasManager();
    m.addAlias('a', 'b');
    // 'a' is already a FROM, so trying to use 'a' as a TO should be caught
    // Actually this tests that the TO is itself an alias FROM
    expect(() => m.addAlias('c', 'a')).toThrow('Cannot create chain');
  });

  test('prevents self-referencing alias', () => {
    const m = new ToolAliasManager();
    expect(() => m.addAlias('echo', 'echo')).toThrow('cannot point to itself');
  });

  test('validates alias name format', () => {
    const m = new ToolAliasManager();
    expect(() => m.addAlias('bad name!', 'target')).toThrow('Invalid alias name');
    expect(() => m.addAlias('good_name', 'bad target!')).toThrow('Invalid target name');
  });

  test('validates sunset date', () => {
    const m = new ToolAliasManager();
    expect(() => m.addAlias('a', 'b', 'not-a-date')).toThrow('Invalid sunset date');
  });

  test('removeAlias removes it', () => {
    const m = new ToolAliasManager();
    m.addAlias('old', 'new');
    expect(m.resolve('old').isAlias).toBe(true);
    expect(m.removeAlias('old')).toBe(true);
    expect(m.resolve('old').isAlias).toBe(false);
    expect(m.removeAlias('old')).toBe(false); // already removed
  });

  test('tracks call counts per alias', () => {
    const m = new ToolAliasManager();
    m.addAlias('old', 'new');
    m.resolve('old');
    m.resolve('old');
    m.resolve('old');
    m.resolve('new'); // not an alias

    const s = m.stats();
    expect(s.totalAliasedCalls).toBe(3);
    expect(s.callsViaAlias['old']).toBe(3);
  });

  test('getDeprecationHeaders returns RFC 8594 headers', () => {
    const m = new ToolAliasManager();
    const alias = m.addAlias('old', 'new', '2026-12-31T00:00:00Z');
    const headers = m.getDeprecationHeaders(alias);

    expect(headers['Deprecation']).toBe('true');
    expect(headers['Sunset']).toContain('2026');
    expect(headers['Link']).toContain('successor-version');
    expect(headers['Link']).toContain('new');
  });

  test('getDeprecationHeaders without sunset date', () => {
    const m = new ToolAliasManager();
    const alias = m.addAlias('old', 'new');
    const headers = m.getDeprecationHeaders(alias);

    expect(headers['Deprecation']).toBe('true');
    expect(headers['Sunset']).toBeUndefined();
    expect(headers['Link']).toContain('successor-version');
  });

  test('importAliases and exportAliases round-trip', () => {
    const m = new ToolAliasManager();
    m.addAlias('a', 'b', '2026-06-01');
    m.addAlias('c', 'd');
    const exported = m.exportAliases();
    expect(exported).toHaveLength(2);

    const m2 = new ToolAliasManager();
    const imported = m2.importAliases(exported);
    expect(imported).toBe(2);
    expect(m2.resolve('a').resolvedName).toBe('b');
    expect(m2.resolve('c').resolvedName).toBe('d');
  });

  test('importAliases skips invalid entries', () => {
    const m = new ToolAliasManager();
    const imported = m.importAliases([
      { from: 'good', to: 'target' },
      { from: 'bad name!', to: 'target' }, // invalid
      { from: 'same', to: 'same' }, // self-ref
    ]);
    expect(imported).toBe(1);
    expect(m.size).toBe(1);
  });

  test('clearCounts keeps aliases but resets counts', () => {
    const m = new ToolAliasManager();
    m.addAlias('old', 'new');
    m.resolve('old');
    m.resolve('old');
    expect(m.stats().totalAliasedCalls).toBe(2);

    m.clearCounts();
    expect(m.stats().totalAliasedCalls).toBe(0);
    // Alias still works
    expect(m.resolve('old').isAlias).toBe(true);
  });

  test('message truncated at 500 chars', () => {
    const m = new ToolAliasManager();
    const longMsg = 'x'.repeat(600);
    const alias = m.addAlias('old', 'new', null, longMsg);
    expect(alias.message!.length).toBe(500);
  });

  test('size property reflects alias count', () => {
    const m = new ToolAliasManager();
    expect(m.size).toBe(0);
    m.addAlias('a', 'b');
    expect(m.size).toBe(1);
    m.addAlias('c', 'd');
    expect(m.size).toBe(2);
    m.removeAlias('a');
    expect(m.size).toBe(1);
  });

  test('allows colon and dot in tool names', () => {
    const m = new ToolAliasManager();
    const alias = m.addAlias('fs:read_file', 'filesystem:read_file');
    expect(alias.from).toBe('fs:read_file');
    expect(m.resolve('fs:read_file').resolvedName).toBe('filesystem:read_file');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Integration Tests — Concurrency Limiter via HTTP
// ═══════════════════════════════════════════════════════════════════════════

describe('Concurrency Limiter (integration)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    if (server) await server.stop();
  });

  test('rejects concurrent requests when per-key limit exceeded', async () => {
    ({ server, port, adminKey } = await startServer({
      maxConcurrentPerKey: 1,
      maxConcurrentPerTool: 0,
    }));
    const { key } = await createKey(port, adminKey, 100);

    // Fire two concurrent requests — slow tool takes 200ms
    const [r1, r2] = await Promise.all([
      callTool(port, key, 'slow', { delay: 200 }),
      // Small delay to ensure ordering
      new Promise<Response>(resolve => setTimeout(() => resolve(callTool(port, key, 'echo', { msg: 'hi' })), 20)),
    ]);

    const b1 = await r1.json() as any;
    const b2 = await r2.json() as any;

    // First should succeed, second should be denied with concurrency error
    expect(b1.result).toBeTruthy();
    expect(b2.error).toBeTruthy();
    expect(b2.error.code).toBe(-32005);
    expect(b2.error.message).toContain('concurrency');
  }, 10000);

  test('allows sequential requests when within limits', async () => {
    ({ server, port, adminKey } = await startServer({
      maxConcurrentPerKey: 5,
      maxConcurrentPerTool: 0,
    }));
    const { key } = await createKey(port, adminKey, 100);

    // Make 3 sequential requests — all well within limit of 5
    for (let i = 0; i < 3; i++) {
      const r = await callTool(port, key, 'echo', { msg: `msg-${i}` });
      const b = await r.json() as any;
      expect(b.result).toBeTruthy();
      expect(b.result.content[0].text).toBe(`msg-${i}`);
    }

    // Verify the snapshot shows 0 inflight after all complete
    const snap = await fetch(`http://127.0.0.1:${port}/admin/concurrency`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const snapBody = await snap.json() as any;
    expect(snapBody.snapshot.totalInflight).toBe(0);
  }, 10000);

  test('GET /admin/concurrency returns snapshot', async () => {
    ({ server, port, adminKey } = await startServer({
      maxConcurrentPerKey: 5,
      maxConcurrentPerTool: 10,
    }));

    const res = await fetch(`http://127.0.0.1:${port}/admin/concurrency`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.snapshot).toBeTruthy();
    expect(body.limits).toBeTruthy();
    expect(body.limits.maxConcurrentPerKey).toBe(5);
    expect(body.limits.maxConcurrentPerTool).toBe(10);
    expect(body.snapshot.totalInflight).toBe(0);
  });

  test('POST /admin/concurrency updates limits at runtime', async () => {
    ({ server, port, adminKey } = await startServer({
      maxConcurrentPerKey: 5,
      maxConcurrentPerTool: 10,
    }));

    const res = await fetch(`http://127.0.0.1:${port}/admin/concurrency`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ maxConcurrentPerKey: 3, maxConcurrentPerTool: 6 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.limits.maxConcurrentPerKey).toBe(3);
    expect(body.limits.maxConcurrentPerTool).toBe(6);
  });

  test('Retry-After header sent on concurrency denial', async () => {
    ({ server, port, adminKey } = await startServer({
      maxConcurrentPerKey: 1,
      maxConcurrentPerTool: 0,
    }));
    const { key } = await createKey(port, adminKey, 100);

    // Fire two concurrent requests
    const promises = [
      callTool(port, key, 'slow', { delay: 300 }),
      new Promise<Response>(resolve => setTimeout(() => resolve(callTool(port, key, 'echo', { msg: 'hi' })), 30)),
    ];
    const results = await Promise.all(promises);

    // Find the denied response
    for (const r of results) {
      const body = await r.json() as any;
      if (body.error) {
        // Check Retry-After header
        expect(r.headers.get('Retry-After')).toBe('1');
      }
    }
  }, 10000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Integration Tests — Traffic Mirroring via HTTP
// ═══════════════════════════════════════════════════════════════════════════

describe('Traffic Mirroring (integration)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let mirrorServer: http.Server;
  let mirrorPort: number;
  const mirrorRequests: any[] = [];

  beforeEach(async () => {
    mirrorRequests.length = 0;
    // Start mirror receiver
    mirrorServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk; });
      req.on('end', () => {
        try { mirrorRequests.push(JSON.parse(body)); } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => mirrorServer.listen(0, '127.0.0.1', resolve));
    mirrorPort = (mirrorServer.address() as any).port;
  });

  afterEach(async () => {
    if (server) await server.stop();
    mirrorServer.close();
  });

  test('GET /admin/mirror returns stats when disabled', async () => {
    ({ server, port, adminKey } = await startServer());

    const res = await fetch(`http://127.0.0.1:${port}/admin/mirror`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.enabled).toBe(false);
    expect(body.totalMirrored).toBe(0);
  });

  test('POST /admin/mirror configures mirroring', async () => {
    ({ server, port, adminKey } = await startServer());

    const res = await fetch(`http://127.0.0.1:${port}/admin/mirror`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ url: `http://127.0.0.1:${mirrorPort}/mcp`, percentage: 100 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.enabled).toBe(true);
    expect(body.mirrorUrl).toContain(`${mirrorPort}`);
  });

  test('DELETE /admin/mirror disables mirroring', async () => {
    ({ server, port, adminKey } = await startServer({
      mirror: { url: `http://127.0.0.1:${mirrorPort}/mcp`, percentage: 100, timeoutMs: 5000 },
    }));

    const res = await fetch(`http://127.0.0.1:${port}/admin/mirror`, {
      method: 'DELETE',
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.disabled).toBe(true);
  });

  test('mirrors tool calls to shadow backend', async () => {
    ({ server, port, adminKey } = await startServer({
      mirror: { url: `http://127.0.0.1:${mirrorPort}/mcp`, percentage: 100, timeoutMs: 5000 },
    }));
    const { key } = await createKey(port, adminKey, 100);

    // Make a tool call
    await callTool(port, key, 'echo', { msg: 'mirror-test' });

    // Wait for mirror to process (fire-and-forget)
    await new Promise(r => setTimeout(r, 300));

    // Mirror should have received the request
    expect(mirrorRequests.length).toBe(1);
    expect(mirrorRequests[0].method).toBe('tools/call');
    expect(mirrorRequests[0].params.name).toBe('echo');
  }, 10000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Integration Tests — Tool Aliasing via HTTP
// ═══════════════════════════════════════════════════════════════════════════

describe('Tool Aliasing (integration)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    if (server) await server.stop();
  });

  test('GET /admin/tool-aliases returns stats', async () => {
    ({ server, port, adminKey } = await startServer());

    const res = await fetch(`http://127.0.0.1:${port}/admin/tool-aliases`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.totalAliases).toBe(0);
    expect(body.aliases).toEqual([]);
  });

  test('POST /admin/tool-aliases creates alias', async () => {
    ({ server, port, adminKey } = await startServer());

    const res = await fetch(`http://127.0.0.1:${port}/admin/tool-aliases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ from: 'old_echo', to: 'echo', sunsetDate: '2026-12-31T00:00:00Z', message: 'Use echo instead' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.from).toBe('old_echo');
    expect(body.to).toBe('echo');
    expect(body.sunsetDate).toBe('2026-12-31T00:00:00Z');
    expect(body.message).toBe('Use echo instead');
  });

  test('DELETE /admin/tool-aliases removes alias', async () => {
    ({ server, port, adminKey } = await startServer());

    // Create first
    await fetch(`http://127.0.0.1:${port}/admin/tool-aliases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ from: 'old_echo', to: 'echo' }),
    });

    // Delete
    const res = await fetch(`http://127.0.0.1:${port}/admin/tool-aliases?from=old_echo`, {
      method: 'DELETE',
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.removed).toBe('old_echo');
  });

  test('tool call via alias resolves to target tool', async () => {
    ({ server, port, adminKey } = await startServer());
    const { key } = await createKey(port, adminKey, 100);

    // Create alias: old_echo → echo
    await fetch(`http://127.0.0.1:${port}/admin/tool-aliases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ from: 'old_echo', to: 'echo' }),
    });

    // Call via alias
    const res = await callTool(port, key, 'old_echo', { msg: 'via-alias' });
    const body = await res.json() as any;

    // Should succeed — routed to 'echo'
    expect(body.result).toBeTruthy();
    expect(body.result.content[0].text).toBe('via-alias');

    // Check Deprecation header
    expect(res.headers.get('Deprecation')).toBe('true');
    expect(res.headers.get('Link')).toContain('successor-version');
  }, 10000);

  test('tool call via alias includes Sunset header when set', async () => {
    ({ server, port, adminKey } = await startServer());
    const { key } = await createKey(port, adminKey, 100);

    // Create alias with sunset
    await fetch(`http://127.0.0.1:${port}/admin/tool-aliases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ from: 'old_echo', to: 'echo', sunsetDate: '2026-12-31T00:00:00Z' }),
    });

    const res = await callTool(port, key, 'old_echo', { msg: 'test' });
    expect(res.headers.get('Sunset')).toBeTruthy();
    expect(res.headers.get('Sunset')).toContain('2026');
  }, 10000);

  test('DELETE /admin/tool-aliases returns 404 for unknown alias', async () => {
    ({ server, port, adminKey } = await startServer());

    const res = await fetch(`http://127.0.0.1:${port}/admin/tool-aliases?from=nonexistent`, {
      method: 'DELETE',
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(404);
  });

  test('POST /admin/tool-aliases returns 400 for missing params', async () => {
    ({ server, port, adminKey } = await startServer());

    const res = await fetch(`http://127.0.0.1:${port}/admin/tool-aliases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ from: 'old' }),
    });
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Root Listing — New Endpoints
// ═══════════════════════════════════════════════════════════════════════════

describe('Root listing (v9.5.0 endpoints)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    if (server) await server.stop();
  });

  test('root endpoint lists concurrency, mirror, and tool-aliases', async () => {
    ({ server, port, adminKey } = await startServer());

    const res = await fetch(`http://127.0.0.1:${port}/`);
    const body = await res.json() as any;
    const endpoints = body.endpoints as Record<string, string>;

    expect(endpoints.adminConcurrency).toBeTruthy();
    expect(endpoints.adminConcurrency).toContain('/admin/concurrency');
    expect(endpoints.adminMirror).toBeTruthy();
    expect(endpoints.adminMirror).toContain('/admin/mirror');
    expect(endpoints.adminToolAliases).toBeTruthy();
    expect(endpoints.adminToolAliases).toContain('/admin/tool-aliases');
  });
});
