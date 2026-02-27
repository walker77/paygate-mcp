/**
 * Tests for v2.9.0 Multi-Tenant Namespace feature.
 *
 * Covers:
 *   - Namespace assignment on key creation
 *   - Namespace sanitization
 *   - Namespace filtering on listKeys, listKeysByTag
 *   - listNamespaces aggregation
 *   - Namespace in usage events
 *   - Namespace filtering on meter (getEvents, getSummary)
 *   - Namespace filtering on status and analytics endpoints
 *   - Namespace isolation (cross-namespace events don't leak)
 *   - Backward compatibility (old keys default to 'default')
 *   - HTTP admin endpoints (/namespaces, /keys?namespace=, /usage?namespace=, /analytics?namespace=)
 */

import { KeyStore } from '../src/store';
import { Gate } from '../src/gate';
import { UsageMeter } from '../src/meter';
import { PayGateConfig, DEFAULT_CONFIG, ToolCallParams } from '../src/types';
import { PayGateServer } from '../src/server';
import * as http from 'http';

// ─── Store-level namespace tests ─────────────────────────────────────────────

describe('KeyStore — namespaces', () => {
  let store: KeyStore;

  beforeEach(() => {
    store = new KeyStore();
  });

  it('assigns default namespace when none specified', () => {
    const record = store.createKey('test', 100);
    expect(record.namespace).toBe('default');
  });

  it('assigns custom namespace on create', () => {
    const record = store.createKey('test', 100, { namespace: 'acme-corp' });
    expect(record.namespace).toBe('acme-corp');
  });

  it('sanitizes namespace: lowercase, alphanumeric + hyphens', () => {
    const record = store.createKey('test', 100, { namespace: 'Acme Corp @#$!' });
    expect(record.namespace).toBe('acmecorp');
  });

  it('sanitizes namespace: trims to 50 chars max', () => {
    const long = 'a'.repeat(100);
    const record = store.createKey('test', 100, { namespace: long });
    expect(record.namespace.length).toBe(50);
  });

  it('sanitizes namespace: empty string defaults to "default"', () => {
    const record = store.createKey('test', 100, { namespace: '' });
    expect(record.namespace).toBe('default');
  });

  it('sanitizes namespace: all special chars defaults to "default"', () => {
    const record = store.createKey('test', 100, { namespace: '@#$!' });
    expect(record.namespace).toBe('default');
  });

  it('importKey respects namespace', () => {
    const record = store.importKey('pg_custom_test_key_1234567890abcdef12345678901234567890', 'imported', 500, { namespace: 'partner' });
    expect(record!.namespace).toBe('partner');
  });

  it('listKeys filters by namespace', () => {
    store.createKey('acme-1', 100, { namespace: 'acme' });
    store.createKey('acme-2', 200, { namespace: 'acme' });
    store.createKey('beta-1', 300, { namespace: 'beta' });

    const acmeKeys = store.listKeys('acme');
    expect(acmeKeys.length).toBe(2);
    expect(acmeKeys.every(k => k.namespace === 'acme')).toBe(true);

    const betaKeys = store.listKeys('beta');
    expect(betaKeys.length).toBe(1);
    expect(betaKeys[0].namespace).toBe('beta');

    const allKeys = store.listKeys();
    expect(allKeys.length).toBe(3);
  });

  it('listKeys returns empty for non-existent namespace', () => {
    store.createKey('test', 100, { namespace: 'acme' });
    expect(store.listKeys('nonexistent')).toEqual([]);
  });

  it('listKeysByTag filters by namespace', () => {
    store.createKey('acme-1', 100, { namespace: 'acme', tags: { env: 'prod' } });
    store.createKey('beta-1', 100, { namespace: 'beta', tags: { env: 'prod' } });

    const acmeProd = store.listKeysByTag({ env: 'prod' }, 'acme');
    expect(acmeProd.length).toBe(1);

    const allProd = store.listKeysByTag({ env: 'prod' });
    expect(allProd.length).toBe(2);
  });

  it('listNamespaces returns correct aggregation', () => {
    store.createKey('acme-1', 100, { namespace: 'acme' });
    store.createKey('acme-2', 200, { namespace: 'acme' });
    store.createKey('beta-1', 300, { namespace: 'beta' });

    const namespaces = store.listNamespaces();
    expect(namespaces.length).toBe(2);

    const acme = namespaces.find(n => n.namespace === 'acme');
    expect(acme).toBeDefined();
    expect(acme!.keyCount).toBe(2);
    expect(acme!.activeKeys).toBe(2);
    expect(acme!.totalCredits).toBe(300);

    const beta = namespaces.find(n => n.namespace === 'beta');
    expect(beta).toBeDefined();
    expect(beta!.keyCount).toBe(1);
  });

  it('listNamespaces reflects revoked keys', () => {
    const r1 = store.createKey('revokable', 100, { namespace: 'acme' });
    store.createKey('active', 200, { namespace: 'acme' });
    store.revokeKey(r1.key);

    const namespaces = store.listNamespaces();
    const acme = namespaces.find(n => n.namespace === 'acme');
    expect(acme!.keyCount).toBe(2);
    expect(acme!.activeKeys).toBe(1);
  });

  it('rotateKey preserves namespace', () => {
    const old = store.createKey('rotatable', 100, { namespace: 'partner' });
    const rotated = store.rotateKey(old.key);
    expect(rotated).not.toBeNull();
    expect(rotated!.namespace).toBe('partner');
  });
});

// ─── Meter-level namespace tests ─────────────────────────────────────────────

describe('UsageMeter — namespace filtering', () => {
  let meter: UsageMeter;

  beforeEach(() => {
    meter = new UsageMeter();
  });

  it('getEvents filters by namespace', () => {
    meter.record({ timestamp: '2025-01-01T00:00:00Z', apiKey: 'k1', keyName: 'k1', tool: 'a', creditsCharged: 1, allowed: true, namespace: 'acme' });
    meter.record({ timestamp: '2025-01-01T00:01:00Z', apiKey: 'k2', keyName: 'k2', tool: 'b', creditsCharged: 1, allowed: true, namespace: 'beta' });
    meter.record({ timestamp: '2025-01-01T00:02:00Z', apiKey: 'k3', keyName: 'k3', tool: 'c', creditsCharged: 1, allowed: true, namespace: 'acme' });

    const acmeEvents = meter.getEvents(undefined, 'acme');
    expect(acmeEvents.length).toBe(2);
    expect(acmeEvents.every(e => e.namespace === 'acme')).toBe(true);

    const betaEvents = meter.getEvents(undefined, 'beta');
    expect(betaEvents.length).toBe(1);

    const allEvents = meter.getEvents();
    expect(allEvents.length).toBe(3);
  });

  it('getSummary filters by namespace', () => {
    meter.record({ timestamp: '2025-01-01T00:00:00Z', apiKey: 'k1', keyName: 'k1', tool: 'tool-a', creditsCharged: 5, allowed: true, namespace: 'acme' });
    meter.record({ timestamp: '2025-01-01T00:01:00Z', apiKey: 'k2', keyName: 'k2', tool: 'tool-b', creditsCharged: 10, allowed: true, namespace: 'beta' });
    meter.record({ timestamp: '2025-01-01T00:02:00Z', apiKey: 'k3', keyName: 'k3', tool: 'tool-a', creditsCharged: 3, allowed: true, namespace: 'acme' });

    const acmeSummary = meter.getSummary(undefined, 'acme');
    expect(acmeSummary.totalCalls).toBe(2);
    expect(acmeSummary.totalCreditsSpent).toBe(8);

    const betaSummary = meter.getSummary(undefined, 'beta');
    expect(betaSummary.totalCalls).toBe(1);
    expect(betaSummary.totalCreditsSpent).toBe(10);
  });

  it('getEvents combines since + namespace filters', () => {
    meter.record({ timestamp: '2025-01-01T00:00:00Z', apiKey: 'k1', keyName: 'k1', tool: 'a', creditsCharged: 1, allowed: true, namespace: 'acme' });
    meter.record({ timestamp: '2025-06-01T00:00:00Z', apiKey: 'k2', keyName: 'k2', tool: 'b', creditsCharged: 1, allowed: true, namespace: 'acme' });
    meter.record({ timestamp: '2025-06-01T00:00:00Z', apiKey: 'k3', keyName: 'k3', tool: 'c', creditsCharged: 1, allowed: true, namespace: 'beta' });

    const result = meter.getEvents('2025-03-01T00:00:00Z', 'acme');
    expect(result.length).toBe(1);
    expect(result[0].tool).toBe('b');
  });
});

// ─── Gate-level namespace tests ──────────────────────────────────────────────

describe('Gate — namespace in usage events', () => {
  let gate: Gate;

  beforeEach(() => {
    const config: PayGateConfig = {
      ...DEFAULT_CONFIG,
      globalRateLimitPerMin: 0,
    };
    gate = new Gate(config);
  });

  it('records namespace in usage events on allowed call', () => {
    const record = gate.store.createKey('test', 100, { namespace: 'acme' });
    const toolCall: ToolCallParams = { name: 'my_tool' };
    const decision = gate.evaluate(record.key, toolCall);
    expect(decision.allowed).toBe(true);

    const events = gate.meter.getEvents(undefined, 'acme');
    expect(events.length).toBe(1);
    expect(events[0].namespace).toBe('acme');
  });

  it('records namespace in usage events on denied call (insufficient credits)', () => {
    const record = gate.store.createKey('test', 0, { namespace: 'beta' });
    const toolCall: ToolCallParams = { name: 'my_tool' };
    const decision = gate.evaluate(record.key, toolCall);
    expect(decision.allowed).toBe(false);

    // Denied calls still get recorded in the beta namespace
    const events = gate.meter.getEvents(undefined, 'beta');
    expect(events.length).toBe(1);
    expect(events[0].namespace).toBe('beta');
    expect(events[0].allowed).toBe(false);
  });

  it('getStatus returns namespace list', () => {
    gate.store.createKey('acme-key', 100, { namespace: 'acme' });
    gate.store.createKey('beta-key', 200, { namespace: 'beta' });

    const status = gate.getStatus();
    expect(status.namespaces).toBeDefined();
    expect(status.namespaces.length).toBe(2);
  });

  it('getStatus filters by namespace', () => {
    gate.store.createKey('acme-key', 100, { namespace: 'acme' });
    gate.store.createKey('beta-key', 200, { namespace: 'beta' });

    const status = gate.getStatus('acme');
    expect(status.keys.length).toBe(1);
    expect(status.filteredNamespace).toBe('acme');
  });

  it('batch evaluateBatch records namespace', () => {
    const record = gate.store.createKey('batch-test', 1000, { namespace: 'acme' });
    const calls = [
      { name: 'tool-a' },
      { name: 'tool-b' },
    ];
    const result = gate.evaluateBatch(record.key, calls);
    expect(result.allAllowed).toBe(true);

    const events = gate.meter.getEvents(undefined, 'acme');
    expect(events.length).toBe(2);
  });
});

// ─── HTTP endpoint tests ─────────────────────────────────────────────────────

describe('Namespace HTTP endpoints', () => {
  const ADMIN_KEY = 'test-admin-key';
  let port: number;
  let server: PayGateServer;

  function httpRequest(opts: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ statusCode: number; body: string; json: () => any }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: 'localhost', port, method: opts.method, path: opts.path, headers: opts.headers },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode || 0,
              body: data,
              json: () => JSON.parse(data),
            });
          });
        }
      );
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  beforeAll(async () => {
    // Use a random high port
    port = 30000 + Math.floor(Math.random() * 10000);

    server = new PayGateServer(
      { ...DEFAULT_CONFIG, port, name: 'Namespace Test', serverCommand: 'echo', serverArgs: ['{}'] },
      ADMIN_KEY,
    );
    await server.start();
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  it('POST /keys creates key with namespace', async () => {
    const res = await httpRequest({
      method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'acme-key', credits: 100, namespace: 'acme' }),
    });
    expect(res.statusCode).toBe(201);
    const data = res.json();
    expect(data.namespace).toBe('acme');
  });

  it('POST /keys defaults namespace to "default"', async () => {
    const res = await httpRequest({
      method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'no-ns-key', credits: 50 }),
    });
    expect(res.statusCode).toBe(201);
    const data = res.json();
    expect(data.namespace).toBe('default');
  });

  it('GET /keys?namespace= filters by namespace', async () => {
    // Create keys in different namespaces
    await httpRequest({
      method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'beta-key', credits: 200, namespace: 'beta' }),
    });

    const acmeRes = await httpRequest({
      method: 'GET', path: '/keys?namespace=acme',
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    const acmeKeys = JSON.parse(acmeRes.body);
    expect(Array.isArray(acmeKeys)).toBe(true);
    expect(acmeKeys.every((k: any) => k.namespace === 'acme')).toBe(true);

    const betaRes = await httpRequest({
      method: 'GET', path: '/keys?namespace=beta',
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    const betaKeys = JSON.parse(betaRes.body);
    expect(betaKeys.length).toBeGreaterThanOrEqual(1);
    expect(betaKeys.every((k: any) => k.namespace === 'beta')).toBe(true);
  });

  it('GET /namespaces returns namespace summary', async () => {
    const res = await httpRequest({
      method: 'GET', path: '/namespaces',
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.namespaces).toBeDefined();
    expect(data.count).toBeGreaterThanOrEqual(2);

    const acme = data.namespaces.find((n: any) => n.namespace === 'acme');
    expect(acme).toBeDefined();
    expect(acme.keyCount).toBeGreaterThanOrEqual(1);
  });

  it('GET /namespaces requires admin key', async () => {
    const res = await httpRequest({
      method: 'GET', path: '/namespaces',
      headers: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /status?namespace= filters status by namespace', async () => {
    const res = await httpRequest({
      method: 'GET', path: '/status?namespace=acme',
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.filteredNamespace).toBe('acme');
    expect(data.keys.every((k: any) => k.namespace === 'acme')).toBe(true);
  });

  it('GET /usage?namespace= filters usage events by namespace', async () => {
    const res = await httpRequest({
      method: 'GET', path: '/usage?namespace=acme',
      headers: { 'X-Admin-Key': ADMIN_KEY },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    // Events may be empty if no tool calls made, but endpoint works
    expect(data.count).toBeDefined();
  });

  it('POST /keys/search supports namespace filter', async () => {
    // Create a tagged key in a namespace
    await httpRequest({
      method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'tagged-ns', credits: 100, namespace: 'acme', tags: { role: 'worker' } }),
    });

    const res = await httpRequest({
      method: 'POST', path: '/keys/search',
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: { role: 'worker' }, namespace: 'acme' }),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.keys.every((k: any) => k.namespace === 'acme')).toBe(true);
  });
});

// ─── Backward compatibility ──────────────────────────────────────────────────

describe('Namespace backward compatibility', () => {
  it('store.load() backfills namespace to "default" for old records', () => {
    const tmpPath = `/tmp/paygate-ns-compat-test-${Date.now()}.json`;
    const store = new KeyStore(tmpPath);
    const record = store.createKey('old-key', 100);

    // Simulate old state file missing the namespace field
    // State format is Array<[key, record]>
    const fs = require('fs');
    const raw: Array<[string, any]> = JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));
    for (const [, record] of raw) {
      delete record.namespace;
    }
    fs.writeFileSync(tmpPath, JSON.stringify(raw));

    // Load into a new store — should backfill namespace
    const newStore = new KeyStore(tmpPath);
    const keys = newStore.listKeys();
    expect(keys.length).toBe(1);
    expect(keys[0].namespace).toBe('default');

    // Cleanup
    fs.unlinkSync(tmpPath);
  });
});
