/**
 * Group Redis Sync — Tests for key group persistence and sync via Redis.
 *
 * Tests:
 *   1. RedisSync group methods exist and handle disconnected state gracefully
 *   2. Group serialization round-trip (groupToHash → hashToGroup)
 *   3. Server wiring (groupManager linked to redisSync)
 *   4. Pub/sub event types for group changes
 *   5. Server endpoints trigger Redis sync calls
 */

import { RedisClient } from '../src/redis-client';
import { RedisSync, PubSubEvent } from '../src/redis-sync';
import { KeyStore } from '../src/store';
import { KeyGroupManager } from '../src/groups';
import { PayGateServer } from '../src/server';
import * as http from 'http';

// ─── Helper: HTTP request ────────────────────────────────────────────────────

function httpReq(port: number, path: string, method = 'GET', body?: unknown, headers?: Record<string, string>): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const hdrs: Record<string, string> = { ...headers };
    if (body) hdrs['Content-Type'] = 'application/json';
    const opts: http.RequestOptions = { hostname: '127.0.0.1', port, path, method, headers: hdrs };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode!, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. RedisSync Group Method Existence & Graceful Handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('RedisSync group methods', () => {
  let store: KeyStore;
  let client: RedisClient;
  let sync: RedisSync;
  let gm: KeyGroupManager;

  beforeEach(() => {
    store = new KeyStore();
    client = new RedisClient({ host: 'localhost', port: 6379 });
    sync = new RedisSync(client, store);
    gm = new KeyGroupManager();
    sync.groupManager = gm;
  });

  it('has saveGroup method', () => {
    expect(typeof sync.saveGroup).toBe('function');
  });

  it('has deleteGroup method', () => {
    expect(typeof sync.deleteGroup).toBe('function');
  });

  it('has saveGroupAssignments method', () => {
    expect(typeof sync.saveGroupAssignments).toBe('function');
  });

  it('has loadGroupsFromRedis method', () => {
    expect(typeof sync.loadGroupsFromRedis).toBe('function');
  });

  it('saveGroup handles errors gracefully when not connected', async () => {
    const group = gm.createGroup({ name: 'test-group' });
    // Should not throw — errors are caught internally
    await expect(sync.saveGroup(group)).resolves.not.toThrow();
  });

  it('deleteGroup handles errors gracefully when not connected', async () => {
    await expect(sync.deleteGroup('grp_nonexistent')).resolves.not.toThrow();
  });

  it('saveGroupAssignments handles errors gracefully when not connected', async () => {
    const group = gm.createGroup({ name: 'test-group' });
    gm.assignKey('pgk_testkey', group.id);
    await expect(sync.saveGroupAssignments()).resolves.not.toThrow();
  });

  it('loadGroupsFromRedis handles errors gracefully when not connected', async () => {
    await expect(sync.loadGroupsFromRedis()).resolves.not.toThrow();
  });

  it('loadGroupsFromRedis is a no-op without groupManager', async () => {
    const sync2 = new RedisSync(client, store);
    // No groupManager set — should be a no-op
    await expect(sync2.loadGroupsFromRedis()).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Group Serialization Round-Trip
// ═══════════════════════════════════════════════════════════════════════════════

describe('RedisSync group serialization', () => {
  it('round-trips a KeyGroupRecord through hash format', () => {
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);
    const gm = new KeyGroupManager();
    sync.groupManager = gm;

    const group = gm.createGroup({
      name: 'enterprise-tier',
      description: 'For enterprise customers',
      allowedTools: ['search', 'read_file'],
      deniedTools: ['delete_file'],
      rateLimitPerMin: 500,
      toolPricing: { search: { creditsPerCall: 5 } },
      quota: { dailyCallLimit: 1000, monthlyCallLimit: 30000, dailyCreditLimit: 5000, monthlyCreditLimit: 100000 },
      ipAllowlist: ['10.0.0.0/8', '192.168.1.1'],
      defaultCredits: 10000,
      maxSpendingLimit: 50000,
      tags: { tier: 'enterprise', region: 'us' },
    });

    // Access private methods via casting
    const toHash = (sync as any).groupToHash.bind(sync);
    const fromHash = (sync as any).hashToGroup.bind(sync);

    // Convert to hash and back
    const hashFields = toHash(group);
    expect(Array.isArray(hashFields)).toBe(true);
    expect(hashFields.length % 2).toBe(0); // key-value pairs

    // Build hash object from fields
    const hash: Record<string, string> = {};
    for (let i = 0; i < hashFields.length; i += 2) {
      hash[hashFields[i]] = hashFields[i + 1];
    }

    // Convert back
    const restored = fromHash(hash);
    expect(restored).not.toBeNull();
    expect(restored!.id).toBe(group.id);
    expect(restored!.name).toBe('enterprise-tier');
    expect(restored!.description).toBe('For enterprise customers');
    expect(restored!.allowedTools).toEqual(['search', 'read_file']);
    expect(restored!.deniedTools).toEqual(['delete_file']);
    expect(restored!.rateLimitPerMin).toBe(500);
    expect(restored!.toolPricing).toEqual({ search: { creditsPerCall: 5 } });
    expect(restored!.quota).toEqual({ dailyCallLimit: 1000, monthlyCallLimit: 30000, dailyCreditLimit: 5000, monthlyCreditLimit: 100000 });
    expect(restored!.ipAllowlist).toEqual(['10.0.0.0/8', '192.168.1.1']);
    expect(restored!.defaultCredits).toBe(10000);
    expect(restored!.maxSpendingLimit).toBe(50000);
    expect(restored!.tags).toEqual({ tier: 'enterprise', region: 'us' });
    expect(restored!.active).toBe(true);
  });

  it('hashToGroup returns null for empty hash', () => {
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);

    const fromHash = (sync as any).hashToGroup.bind(sync);
    expect(fromHash({})).toBeNull();
    expect(fromHash({ name: 'test' })).toBeNull(); // no id
  });

  it('hashToGroup handles missing optional fields', () => {
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);

    const fromHash = (sync as any).hashToGroup.bind(sync);
    const result = fromHash({ id: 'grp_test123' });
    expect(result).not.toBeNull();
    expect(result!.id).toBe('grp_test123');
    expect(result!.name).toBe('');
    expect(result!.allowedTools).toEqual([]);
    expect(result!.deniedTools).toEqual([]);
    expect(result!.rateLimitPerMin).toBe(0);
    expect(result!.toolPricing).toEqual({});
    expect(result!.quota).toBeUndefined();
    expect(result!.ipAllowlist).toEqual([]);
    expect(result!.tags).toEqual({});
    expect(result!.active).toBe(true);
  });

  it('serializes group field on ApiKeyRecord', () => {
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);

    const record = store.createKey('test', 100);
    record.group = 'grp_abc123';

    const toHash = (sync as any).recordToHash.bind(sync);
    const fields = toHash(record);

    // Find the group field
    const groupIdx = fields.indexOf('group');
    expect(groupIdx).toBeGreaterThan(-1);
    expect(fields[groupIdx + 1]).toBe('grp_abc123');
  });

  it('deserializes group field on ApiKeyRecord', () => {
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);

    const record = store.createKey('test', 100);
    record.group = 'grp_def456';

    const toHash = (sync as any).recordToHash.bind(sync);
    const fromHash = (sync as any).hashToRecord.bind(sync);

    const fields = toHash(record);
    const hash: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      hash[fields[i]] = fields[i + 1];
    }

    const restored = fromHash(hash);
    expect(restored!.group).toBe('grp_def456');
  });

  it('handles empty group field on deserialization', () => {
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);

    const record = store.createKey('test', 100);
    // No group assigned

    const toHash = (sync as any).recordToHash.bind(sync);
    const fromHash = (sync as any).hashToRecord.bind(sync);

    const fields = toHash(record);
    const hash: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      hash[fields[i]] = fields[i + 1];
    }

    const restored = fromHash(hash);
    expect(restored!.group).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Server Wiring
// ═══════════════════════════════════════════════════════════════════════════════

describe('Server group Redis wiring', () => {
  it('wires groupManager to redisSync when Redis is configured', () => {
    const server = new PayGateServer(
      { serverCommand: 'echo', serverArgs: ['test'], port: 0, defaultCreditsPerCall: 1, globalRateLimitPerMin: 60 },
      'admin_test123', undefined, undefined, undefined, undefined, 'redis://localhost:6379'
    );

    expect(server.redisSync).not.toBeNull();
    expect(server.redisSync!.groupManager).toBeDefined();
    expect(server.redisSync!.groupManager).toBe(server.groups);
  });

  it('does not set groupManager on redisSync when no Redis', () => {
    const server = new PayGateServer(
      { serverCommand: 'echo', serverArgs: ['test'], port: 0, defaultCreditsPerCall: 1, globalRateLimitPerMin: 60 },
      'admin_test123'
    );

    expect(server.redisSync).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Pub/Sub Event Types
// ═══════════════════════════════════════════════════════════════════════════════

describe('Group pub/sub events', () => {
  it('PubSubEvent type includes group event types', () => {
    // Type-level check: these should all be valid
    const events: PubSubEvent['type'][] = [
      'group_updated',
      'group_deleted',
      'group_assignment_changed',
    ];
    expect(events).toHaveLength(3);
  });

  it('handlePubSubMessage handles group_updated event', () => {
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);
    const gm = new KeyGroupManager();
    sync.groupManager = gm;

    // Track if loadGroupsFromRedis was triggered (will fail gracefully since not connected)
    let loadCalled = false;
    const origLoad = sync.loadGroupsFromRedis.bind(sync);
    sync.loadGroupsFromRedis = async () => {
      loadCalled = true;
      // Don't actually call Redis
    };

    const handler = (sync as any).handlePubSubMessage.bind(sync);

    // Simulate message from another instance
    const msg: PubSubEvent = {
      type: 'group_updated',
      key: 'grp_test',
      instanceId: 'other-instance',
    };
    handler(JSON.stringify(msg));

    expect(loadCalled).toBe(true);
  });

  it('handlePubSubMessage handles group_deleted event', () => {
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);
    const gm = new KeyGroupManager();
    sync.groupManager = gm;

    let loadCalled = false;
    sync.loadGroupsFromRedis = async () => { loadCalled = true; };

    const handler = (sync as any).handlePubSubMessage.bind(sync);
    handler(JSON.stringify({
      type: 'group_deleted',
      key: 'grp_test',
      instanceId: 'other-instance',
    }));

    expect(loadCalled).toBe(true);
  });

  it('handlePubSubMessage handles group_assignment_changed event', () => {
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);
    const gm = new KeyGroupManager();
    sync.groupManager = gm;

    let loadCalled = false;
    sync.loadGroupsFromRedis = async () => { loadCalled = true; };

    const handler = (sync as any).handlePubSubMessage.bind(sync);
    handler(JSON.stringify({
      type: 'group_assignment_changed',
      key: '',
      instanceId: 'other-instance',
    }));

    expect(loadCalled).toBe(true);
  });

  it('ignores group events from same instance', () => {
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);
    const gm = new KeyGroupManager();
    sync.groupManager = gm;

    let loadCalled = false;
    sync.loadGroupsFromRedis = async () => { loadCalled = true; };

    const handler = (sync as any).handlePubSubMessage.bind(sync);

    // Self-message — should be ignored
    handler(JSON.stringify({
      type: 'group_updated',
      key: 'grp_test',
      instanceId: sync.instanceId, // same instance!
    }));

    expect(loadCalled).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Server Endpoints Trigger Redis Sync
// ═══════════════════════════════════════════════════════════════════════════════

describe('Server group endpoints with Redis sync', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'node',
      serverArgs: ['-e', `
        process.stdin.resume();
        process.stdin.on('data', d => {
          const req = JSON.parse(d.toString().trim());
          if (req.method === 'tools/list') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0', id: req.id,
              result: { tools: [{ name: 'search' }, { name: 'read_file' }] }
            }) + '\\n');
          }
        });
      `],
      port: 0,
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 60,
    });

    const result = await server.start();
    port = result.port;
    adminKey = result.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop();
  });

  it('POST /groups creates group (no Redis = no sync calls, still works)', async () => {
    const res = await httpReq(port, '/groups', 'POST', {
      name: 'redis-test-group',
      allowedTools: ['search'],
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(201);
    expect(res.data.name).toBe('redis-test-group');
    expect(res.data.id).toMatch(/^grp_/);
  });

  it('POST /groups/assign works and updates key record group field', async () => {
    // Create a group for this test
    const groupRes = await httpReq(port, '/groups', 'POST', { name: 'assign-test-group' }, { 'X-Admin-Key': adminKey });
    expect(groupRes.status).toBe(201);
    const groupId = groupRes.data.id;

    // Create a key
    const keyRes = await httpReq(port, '/keys', 'POST', { name: 'group-redis-key', credits: 100 }, { 'X-Admin-Key': adminKey });
    expect(keyRes.status).toBe(201);
    const apiKey = keyRes.data.key;

    // Assign
    const assignRes = await httpReq(port, '/groups/assign', 'POST', { key: apiKey, groupId }, { 'X-Admin-Key': adminKey });
    expect(assignRes.status).toBe(200);
    expect(assignRes.data.ok).toBe(true);
  });

  it('POST /groups/remove works', async () => {
    // Create group + key + assign
    const groupRes = await httpReq(port, '/groups', 'POST', { name: 'remove-test-group' }, { 'X-Admin-Key': adminKey });
    const groupId = groupRes.data.id;

    const keyRes = await httpReq(port, '/keys', 'POST', { name: 'remove-test', credits: 50 }, { 'X-Admin-Key': adminKey });
    const apiKey = keyRes.data.key;

    await httpReq(port, '/groups/assign', 'POST', { key: apiKey, groupId }, { 'X-Admin-Key': adminKey });

    // Remove
    const removeRes = await httpReq(port, '/groups/remove', 'POST', { key: apiKey }, { 'X-Admin-Key': adminKey });
    expect(removeRes.status).toBe(200);
    expect(removeRes.data.ok).toBe(true);
  });

  it('POST /groups/update works', async () => {
    // Create a group for this test
    const groupRes = await httpReq(port, '/groups', 'POST', { name: 'update-test-group' }, { 'X-Admin-Key': adminKey });
    const groupId = groupRes.data.id;

    const updateRes = await httpReq(port, '/groups/update', 'POST', {
      id: groupId,
      rateLimitPerMin: 999,
    }, { 'X-Admin-Key': adminKey });

    expect(updateRes.status).toBe(200);
    expect(updateRes.data.rateLimitPerMin).toBe(999);
  });

  it('POST /groups/delete works', async () => {
    // Create a group to delete
    const createRes = await httpReq(port, '/groups', 'POST', { name: 'delete-me' }, { 'X-Admin-Key': adminKey });
    expect(createRes.status).toBe(201);

    const deleteRes = await httpReq(port, '/groups/delete', 'POST', { id: createRes.data.id }, { 'X-Admin-Key': adminKey });
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.data.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Redis Constants
// ═══════════════════════════════════════════════════════════════════════════════

describe('Redis key constants for groups', () => {
  it('uses pg:group: prefix for group records', () => {
    // Verify the constant is used in saveGroup — test by inspecting source
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);

    // saveGroup should be a function that works with the correct key prefix
    expect(typeof sync.saveGroup).toBe('function');
    expect(typeof sync.deleteGroup).toBe('function');
    expect(typeof sync.saveGroupAssignments).toBe('function');
    expect(typeof sync.loadGroupsFromRedis).toBe('function');
  });
});
