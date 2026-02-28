/**
 * Tests for v9.8.0 features:
 *   1. Request Deduplication (RequestDeduplicator)
 *   2. Priority Queue (PriorityQueue)
 *   3. Cost Allocation Tags (CostAllocator)
 *   4. Integration via HTTP admin endpoints
 */

import { RequestDeduplicator } from '../src/dedup';
import { PriorityQueue, PRIORITY_ORDER, TIER_VALUES } from '../src/priority-queue';
import { CostAllocator } from '../src/cost-tags';
import { PayGateServer } from '../src/server';
import * as http from 'http';
import * as path from 'path';

// ─── Helper: HTTP request to PayGateServer ──────────────────────────────────

function req(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(headers || {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk));
        res.on('end', () => {
          let parsed: unknown;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode || 0, body: parsed, headers: res.headers });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. RequestDeduplicator — unit tests
// ═══════════════════════════════════════════════════════════════════════════

describe('RequestDeduplicator', () => {
  test('generateKey: deterministic for same inputs', () => {
    const dd = new RequestDeduplicator();
    const k1 = dd.generateKey('key-1', 'echo', { msg: 'hello' });
    const k2 = dd.generateKey('key-1', 'echo', { msg: 'hello' });
    expect(k1).toBe(k2);
    expect(k1).toHaveLength(32);
  });

  test('generateKey: different for different inputs', () => {
    const dd = new RequestDeduplicator();
    const k1 = dd.generateKey('key-1', 'echo', { msg: 'hello' });
    const k2 = dd.generateKey('key-2', 'echo', { msg: 'hello' });
    const k3 = dd.generateKey('key-1', 'echo', { msg: 'world' });
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
  });

  test('generateKey: sorts object keys for consistency', () => {
    const dd = new RequestDeduplicator();
    const k1 = dd.generateKey('key-1', 'echo', { b: 2, a: 1 });
    const k2 = dd.generateKey('key-1', 'echo', { a: 1, b: 2 });
    expect(k1).toBe(k2);
  });

  test('execute: passes through when disabled', async () => {
    const dd = new RequestDeduplicator({ enabled: false });
    let calls = 0;
    const result = await dd.execute('k1', 'key-1', 'echo', 5, async () => { calls++; return 'ok'; });
    expect(result.result).toBe('ok');
    expect(result.deduplicated).toBe(false);
    expect(calls).toBe(1);
  });

  test('execute: caches completed result', async () => {
    const dd = new RequestDeduplicator({ ttlMs: 5000 });
    const key = 'test-key-1';
    let calls = 0;
    const fn = async () => { calls++; return 'result-1'; };

    const r1 = await dd.execute(key, 'key-1', 'echo', 5, fn);
    expect(r1.result).toBe('result-1');
    expect(r1.deduplicated).toBe(false);
    expect(calls).toBe(1);

    const r2 = await dd.execute(key, 'key-1', 'echo', 5, fn);
    expect(r2.result).toBe('result-1');
    expect(r2.deduplicated).toBe(true);
    expect(calls).toBe(1); // Function not called again
  });

  test('execute: does not cache errors', async () => {
    const dd = new RequestDeduplicator({ ttlMs: 5000 });
    const key = 'err-key';
    let calls = 0;

    await expect(dd.execute(key, 'key-1', 'echo', 5, async () => {
      calls++;
      throw new Error('fail');
    })).rejects.toThrow('fail');

    // Second call should execute again (error not cached)
    const r = await dd.execute(key, 'key-1', 'echo', 5, async () => {
      calls++;
      return 'recovered';
    });
    expect(r.result).toBe('recovered');
    expect(calls).toBe(2);
  });

  test('execute: tracks credits saved', async () => {
    const dd = new RequestDeduplicator({ ttlMs: 5000 });
    const key = 'credit-key';
    await dd.execute(key, 'key-1', 'echo', 10, async () => 'ok');
    await dd.execute(key, 'key-1', 'echo', 10, async () => 'ok');
    await dd.execute(key, 'key-1', 'echo', 10, async () => 'ok');

    const s = dd.stats();
    expect(s.totalDeduped).toBe(2);
    expect(s.creditsSaved).toBe(20);
  });

  test('configure: updates settings', () => {
    const dd = new RequestDeduplicator();
    const config = dd.configure({ ttlMs: 120_000, maxEntries: 500 });
    expect(config.ttlMs).toBe(120_000);
    expect(config.maxEntries).toBe(500);
  });

  test('clear: empties cache', async () => {
    const dd = new RequestDeduplicator({ ttlMs: 60_000 });
    await dd.execute('k1', 'key-1', 'echo', 5, async () => 'ok');
    expect(dd.stats().cachedEntries).toBe(1);
    dd.clear();
    expect(dd.stats().cachedEntries).toBe(0);
  });

  test('stats: returns summary', async () => {
    const dd = new RequestDeduplicator();
    await dd.execute('k1', 'key-1', 'echo', 5, async () => 'ok');
    const s = dd.stats();
    expect(s.enabled).toBe(true);
    expect(s.cachedEntries).toBe(1);
    expect(s.totalChecks).toBe(1);
    expect(s.hitRate).toBe(0);
  });

  test('LRU eviction: evicts oldest when at capacity', async () => {
    const dd = new RequestDeduplicator({ maxEntries: 3, ttlMs: 60_000 });
    await dd.execute('k1', 'key-1', 'echo', 1, async () => 'r1');
    await dd.execute('k2', 'key-1', 'echo', 1, async () => 'r2');
    await dd.execute('k3', 'key-1', 'echo', 1, async () => 'r3');
    expect(dd.stats().cachedEntries).toBe(3);

    // Adding 4th should evict first
    await dd.execute('k4', 'key-1', 'echo', 1, async () => 'r4');
    expect(dd.stats().cachedEntries).toBe(3);

    // First key should no longer be cached
    let calls = 0;
    await dd.execute('k1', 'key-1', 'echo', 1, async () => { calls++; return 'r1-new'; });
    expect(calls).toBe(1); // Had to call again
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. PriorityQueue — unit tests
// ═══════════════════════════════════════════════════════════════════════════

describe('PriorityQueue', () => {
  test('disabled by default: enqueue returns immediately', async () => {
    const pq = new PriorityQueue();
    await pq.enqueue('key-1', 'echo'); // Should not block
    expect(pq.depth).toBe(0);
  });

  test('setKeyPriority: stores and retrieves', () => {
    const pq = new PriorityQueue();
    pq.setKeyPriority('key-1', 'high');
    expect(pq.getKeyPriority('key-1')).toBe('high');
    expect(pq.getKeyPriority('unknown')).toBe('normal');
  });

  test('setKeyPriority: rejects invalid tier', () => {
    const pq = new PriorityQueue();
    expect(() => pq.setKeyPriority('key-1', 'mega' as any)).toThrow('Invalid priority tier');
  });

  test('removeKeyPriority: removes assignment', () => {
    const pq = new PriorityQueue();
    pq.setKeyPriority('key-1', 'high');
    expect(pq.removeKeyPriority('key-1')).toBe(true);
    expect(pq.getKeyPriority('key-1')).toBe('normal');
  });

  test('critical bypasses queue', async () => {
    const pq = new PriorityQueue({ enabled: true });
    pq.setKeyPriority('key-1', 'critical');
    await pq.enqueue('key-1', 'echo'); // Should not block
    expect(pq.depth).toBe(0);
  });

  test('enqueue and dequeue: FIFO within tier', async () => {
    const pq = new PriorityQueue({ enabled: true, maxWaitMs: { critical: 100, high: 100, normal: 500, low: 500, background: 500 } });

    // Enqueue 2 normal-priority requests
    const p1 = pq.enqueue('key-1', 'echo');
    const p2 = pq.enqueue('key-2', 'echo');
    expect(pq.depth).toBe(2);

    // Dequeue both
    pq.dequeue();
    pq.dequeue();
    expect(pq.depth).toBe(0);

    // Both promises should resolve
    await Promise.all([p1, p2]);
  });

  test('priority ordering: high dequeued before low', async () => {
    const pq = new PriorityQueue({ enabled: true, maxWaitMs: { critical: 100, high: 500, normal: 500, low: 500, background: 500 } });
    pq.setKeyPriority('low-key', 'low');
    pq.setKeyPriority('high-key', 'high');

    const pLow = pq.enqueue('low-key', 'echo');
    const pHigh = pq.enqueue('high-key', 'echo');

    // First dequeue should be the high-priority request
    const first = pq.dequeue();
    expect(first?.apiKey).toBe('high-key');

    // Second dequeue should be the low-priority request
    const second = pq.dequeue();
    expect(second?.apiKey).toBe('low-key');

    await Promise.all([pLow, pHigh]);
  });

  test('dequeueN: dequeues multiple', async () => {
    const pq = new PriorityQueue({ enabled: true, maxWaitMs: { critical: 100, high: 500, normal: 500, low: 500, background: 500 } });
    const promises = [
      pq.enqueue('k1', 'echo'),
      pq.enqueue('k2', 'echo'),
      pq.enqueue('k3', 'echo'),
    ];
    expect(pq.depth).toBe(3);

    const dequeued = pq.dequeueN(2);
    expect(dequeued).toHaveLength(2);
    expect(pq.depth).toBe(1);

    pq.dequeue(); // Dequeue remaining
    await Promise.all(promises);
  });

  test('configure: updates settings', () => {
    const pq = new PriorityQueue();
    const config = pq.configure({ enabled: true, maxQueueDepth: 500 });
    expect(config.enabled).toBe(true);
    expect(config.maxQueueDepth).toBe(500);
  });

  test('stats: returns summary', () => {
    const pq = new PriorityQueue({ enabled: true });
    const s = pq.stats();
    expect(s.enabled).toBe(true);
    expect(s.currentDepth).toBe(0);
    expect(s.depthPerTier.normal).toBe(0);
    expect(s.keyPriorities).toBe(0);
  });

  test('PRIORITY_ORDER and TIER_VALUES: consistent', () => {
    expect(PRIORITY_ORDER).toHaveLength(5);
    expect(TIER_VALUES.critical).toBe(0);
    expect(TIER_VALUES.background).toBe(4);
  });

  test('destroy: rejects all pending', async () => {
    const pq = new PriorityQueue({ enabled: true, maxWaitMs: { critical: 100, high: 5000, normal: 5000, low: 5000, background: 5000 } });
    const p = pq.enqueue('key-1', 'echo');
    pq.destroy();
    await expect(p).rejects.toThrow('Queue destroyed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. CostAllocator — unit tests
// ═══════════════════════════════════════════════════════════════════════════

describe('CostAllocator', () => {
  test('parseTags: parses valid JSON tags', () => {
    const ca = new CostAllocator();
    const tags = ca.parseTags('{"project":"acme","dept":"eng"}');
    expect(tags).toEqual({ project: 'acme', dept: 'eng' });
  });

  test('parseTags: returns empty for empty input', () => {
    const ca = new CostAllocator();
    expect(ca.parseTags('')).toEqual({});
    expect(ca.parseTags('  ')).toEqual({});
  });

  test('parseTags: rejects invalid JSON', () => {
    const ca = new CostAllocator();
    expect(() => ca.parseTags('not-json')).toThrow('Invalid X-Cost-Tags header');
  });

  test('parseTags: rejects non-object JSON', () => {
    const ca = new CostAllocator();
    expect(() => ca.parseTags('[1,2,3]')).toThrow('must be a JSON object');
  });

  test('parseTags: rejects too many tags', () => {
    const ca = new CostAllocator({ maxTagsPerRequest: 2 });
    expect(() => ca.parseTags('{"a":"1","b":"2","c":"3"}')).toThrow('Too many cost tags');
  });

  test('parseTags: rejects invalid key characters', () => {
    const ca = new CostAllocator();
    expect(() => ca.parseTags('{"bad key":"value"}')).toThrow('Invalid tag key');
  });

  test('parseTags: rejects invalid value characters', () => {
    const ca = new CostAllocator();
    expect(() => ca.parseTags('{"key":"bad value"}')).toThrow('Invalid tag value');
  });

  test('record and report: aggregates by dimension', () => {
    const ca = new CostAllocator();
    ca.record({ project: 'acme', dept: 'eng' }, 'key-1', 'echo', 10);
    ca.record({ project: 'acme', dept: 'sales' }, 'key-2', 'search', 20);
    ca.record({ project: 'beta', dept: 'eng' }, 'key-1', 'echo', 15);

    const report = ca.report('project');
    expect(report.rows).toHaveLength(2);
    expect(report.rows[0].value).toBe('acme');
    expect(report.rows[0].totalCredits).toBe(30);
    expect(report.rows[1].value).toBe('beta');
    expect(report.rows[1].totalCredits).toBe(15);
    expect(report.totalCredits).toBe(45);
  });

  test('crossTab: groups by two dimensions', () => {
    const ca = new CostAllocator();
    ca.record({ project: 'acme', dept: 'eng' }, 'key-1', 'echo', 10);
    ca.record({ project: 'acme', dept: 'sales' }, 'key-2', 'echo', 20);
    ca.record({ project: 'acme', dept: 'eng' }, 'key-1', 'search', 5);

    const report = ca.crossTab('project', 'dept');
    expect(report.rows).toHaveLength(2);
    const engRow = report.rows.find(r => r.dim2Value === 'eng');
    expect(engRow?.totalCredits).toBe(15);
    expect(engRow?.totalCalls).toBe(2);
  });

  test('reportToCsv: generates CSV', () => {
    const ca = new CostAllocator();
    ca.record({ project: 'acme' }, 'key-1', 'echo', 10);
    const report = ca.report('project');
    const csv = ca.reportToCsv(report);
    expect(csv).toContain('dimension,value,totalCredits');
    expect(csv).toContain('project,acme,10');
  });

  test('validateRequired: checks required tags', () => {
    const ca = new CostAllocator();
    ca.setRequiredTags('key-1', ['project', 'dept']);
    const missing = ca.validateRequired('key-1', { project: 'acme' });
    expect(missing).toEqual(['dept']);

    const ok = ca.validateRequired('key-1', { project: 'acme', dept: 'eng' });
    expect(ok).toEqual([]);
  });

  test('validateRequired: no requirements for unset keys', () => {
    const ca = new CostAllocator();
    const missing = ca.validateRequired('key-1', {});
    expect(missing).toEqual([]);
  });

  test('setRequiredTags: clears on empty array', () => {
    const ca = new CostAllocator();
    ca.setRequiredTags('key-1', ['project']);
    ca.setRequiredTags('key-1', []);
    expect(ca.getRequiredTags('key-1')).toEqual([]);
  });

  test('configure: updates settings', () => {
    const ca = new CostAllocator();
    const config = ca.configure({ maxTagsPerRequest: 5 });
    expect(config.maxTagsPerRequest).toBe(5);
  });

  test('clear: empties entries', () => {
    const ca = new CostAllocator();
    ca.record({ project: 'acme' }, 'key-1', 'echo', 10);
    expect(ca.size).toBe(1);
    ca.clear();
    expect(ca.size).toBe(0);
  });

  test('stats: returns summary', () => {
    const ca = new CostAllocator();
    ca.record({ project: 'acme' }, 'key-1', 'echo', 10);
    const s = ca.stats();
    expect(s.enabled).toBe(true);
    expect(s.totalEntries).toBe(1);
    expect(s.uniqueKeys).toBe(1);
    expect(s.totalCreditsTracked).toBe(10);
  });

  test('disabled: does not record', () => {
    const ca = new CostAllocator({ enabled: false });
    ca.record({ project: 'acme' }, 'key-1', 'echo', 10);
    expect(ca.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Integration tests — HTTP admin endpoints
// ═══════════════════════════════════════════════════════════════════════════

describe('v9.8 Integration', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  const echoScript = `
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', line => {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } }) + '\\n');
      } else if (msg.method === 'tools/list') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } }] } }) + '\\n');
      } else if (msg.method === 'tools/call') {
        const args = msg.params?.arguments || {};
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: args.msg || 'ok' }] } }) + '\\n');
      }
    });
  `;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: process.execPath,
      serverArgs: ['-e', echoScript],
      port: 0,
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 1000,
    } as any);
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  }, 20_000);

  afterAll(async () => {
    await server.stop();
  }, 10_000);

  // ─── Dedup ──────────────────────────────────────────────────────────────

  describe('Dedup via HTTP', () => {
    test('GET /admin/dedup: default stats', async () => {
      const r = await req(port, 'GET', '/admin/dedup', undefined, { 'X-Admin-Key': adminKey });
      expect(r.status).toBe(200);
      expect(r.body.enabled).toBe(true);
      expect(r.body.cachedEntries).toBe(0);
    });

    test('POST /admin/dedup: updates config', async () => {
      const r = await req(port, 'POST', '/admin/dedup', { ttlMs: 30000 }, { 'X-Admin-Key': adminKey });
      expect(r.status).toBe(200);
      expect(r.body.config.ttlMs).toBe(30000);
    });

    test('DELETE /admin/dedup: clears cache', async () => {
      const r = await req(port, 'DELETE', '/admin/dedup', undefined, { 'X-Admin-Key': adminKey });
      expect(r.status).toBe(200);
      expect(r.body.cleared).toBe(true);
    });
  });

  // ─── Priority Queue ─────────────────────────────────────────────────────

  describe('Priority Queue via HTTP', () => {
    test('GET /admin/priority-queue: default stats', async () => {
      const r = await req(port, 'GET', '/admin/priority-queue', undefined, { 'X-Admin-Key': adminKey });
      expect(r.status).toBe(200);
      expect(r.body.enabled).toBe(false);
      expect(r.body.currentDepth).toBe(0);
    });

    test('POST /admin/priority-queue: set key priority', async () => {
      const r = await req(port, 'POST', '/admin/priority-queue', { apiKey: 'key-vip', tier: 'high' }, { 'X-Admin-Key': adminKey });
      expect(r.status).toBe(200);
      expect(r.body.tier).toBe('high');
    });

    test('POST /admin/priority-queue: configure queue', async () => {
      const r = await req(port, 'POST', '/admin/priority-queue', { enabled: true, maxQueueDepth: 500 }, { 'X-Admin-Key': adminKey });
      expect(r.status).toBe(200);
      expect(r.body.enabled).toBe(true);
    });
  });

  // ─── Cost Tags ──────────────────────────────────────────────────────────

  describe('Cost Tags via HTTP', () => {
    test('GET /admin/cost-tags: default stats', async () => {
      const r = await req(port, 'GET', '/admin/cost-tags', undefined, { 'X-Admin-Key': adminKey });
      expect(r.status).toBe(200);
      expect(r.body.enabled).toBe(true);
      expect(r.body.totalEntries).toBe(0);
    });

    test('POST /admin/cost-tags: set required tags', async () => {
      const r = await req(port, 'POST', '/admin/cost-tags', { apiKey: 'key-1', requiredTags: ['project'] }, { 'X-Admin-Key': adminKey });
      expect(r.status).toBe(200);
      expect(r.body.requiredTags).toEqual(['project']);
    });

    test('POST /admin/cost-tags: configure', async () => {
      const r = await req(port, 'POST', '/admin/cost-tags', { maxTagsPerRequest: 5 }, { 'X-Admin-Key': adminKey });
      expect(r.status).toBe(200);
      expect(r.body.config.maxTagsPerRequest).toBe(5);
    });

    test('DELETE /admin/cost-tags: clears entries', async () => {
      const r = await req(port, 'DELETE', '/admin/cost-tags', undefined, { 'X-Admin-Key': adminKey });
      expect(r.status).toBe(200);
      expect(r.body.cleared).toBe(true);
    });
  });

  // ─── Root Listing ───────────────────────────────────────────────────────

  describe('Root Listing', () => {
    test('root listing includes v9.8 endpoints', async () => {
      const r = await req(port, 'GET', '/', undefined, { 'X-Admin-Key': adminKey });
      expect(r.status).toBe(200);
      const endpoints = r.body.endpoints || {};
      expect(endpoints.adminDedup).toBeTruthy();
      expect(endpoints.adminPriorityQueue).toBeTruthy();
      expect(endpoints.adminCostTags).toBeTruthy();
    });
  });
});
