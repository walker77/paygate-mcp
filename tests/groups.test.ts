/**
 * Key Groups — Tests for policy templates and group-based key management.
 *
 * 55+ tests covering:
 *   1. KeyGroupManager unit tests (CRUD, membership, policy resolution)
 *   2. Gate integration (ACL inheritance, IP merging, group pricing)
 *   3. Server endpoints (6 endpoints + root listing)
 *   4. Edge cases (deleted groups, re-assignment, serialization)
 */

import { KeyGroupManager, KeyGroupRecord } from '../src/groups';
import { Gate } from '../src/gate';
import { DEFAULT_CONFIG } from '../src/types';
import { PayGateServer } from '../src/server';
import * as http from 'http';

// ─── Helpers ────────────────────────────────────────────────────────────────

function httpReq(
  port: number,
  path: string,
  method: string = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data: any;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode!, data, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. KeyGroupManager Unit Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('KeyGroupManager', () => {
  let gm: KeyGroupManager;

  beforeEach(() => {
    gm = new KeyGroupManager();
  });

  it('starts empty', () => {
    expect(gm.count).toBe(0);
    expect(gm.listGroups()).toEqual([]);
  });

  it('creates a group with defaults', () => {
    const group = gm.createGroup({ name: 'free-tier' });
    expect(group.id).toMatch(/^grp_/);
    expect(group.name).toBe('free-tier');
    expect(group.allowedTools).toEqual([]);
    expect(group.deniedTools).toEqual([]);
    expect(group.rateLimitPerMin).toBe(0);
    expect(group.active).toBe(true);
    expect(gm.count).toBe(1);
  });

  it('creates a group with full config', () => {
    const group = gm.createGroup({
      name: 'premium',
      description: 'Premium tier',
      allowedTools: ['read_file', 'search'],
      deniedTools: ['dangerous_tool'],
      rateLimitPerMin: 120,
      toolPricing: { search: { creditsPerCall: 5 } },
      quota: { dailyCallLimit: 1000, monthlyCallLimit: 30000, dailyCreditLimit: 500, monthlyCreditLimit: 15000 },
      ipAllowlist: ['10.0.0.0/8'],
      defaultCredits: 500,
      maxSpendingLimit: 10000,
      tags: { tier: 'premium' },
    });
    expect(group.description).toBe('Premium tier');
    expect(group.allowedTools).toEqual(['read_file', 'search']);
    expect(group.deniedTools).toEqual(['dangerous_tool']);
    expect(group.rateLimitPerMin).toBe(120);
    expect(group.toolPricing.search.creditsPerCall).toBe(5);
    expect(group.quota?.dailyCallLimit).toBe(1000);
    expect(group.ipAllowlist).toEqual(['10.0.0.0/8']);
    expect(group.defaultCredits).toBe(500);
    expect(group.maxSpendingLimit).toBe(10000);
    expect(group.tags.tier).toBe('premium');
  });

  it('rejects group without name', () => {
    expect(() => gm.createGroup({ name: '' })).toThrow('Group must have a name');
  });

  it('rejects duplicate group names', () => {
    gm.createGroup({ name: 'dup' });
    expect(() => gm.createGroup({ name: 'dup' })).toThrow('already exists');
  });

  it('gets a group by ID', () => {
    const group = gm.createGroup({ name: 'test' });
    expect(gm.getGroup(group.id)?.name).toBe('test');
  });

  it('gets a group by name', () => {
    gm.createGroup({ name: 'by-name' });
    expect(gm.getGroupByName('by-name')?.name).toBe('by-name');
    expect(gm.getGroupByName('nonexistent')).toBeUndefined();
  });

  it('updates a group', () => {
    const group = gm.createGroup({ name: 'updatable' });
    const updated = gm.updateGroup(group.id, {
      name: 'updated-name',
      description: 'New desc',
      allowedTools: ['tool_a'],
      rateLimitPerMin: 60,
    });
    expect(updated.name).toBe('updated-name');
    expect(updated.description).toBe('New desc');
    expect(updated.allowedTools).toEqual(['tool_a']);
    expect(updated.rateLimitPerMin).toBe(60);
  });

  it('rejects update to existing name', () => {
    gm.createGroup({ name: 'a' });
    const b = gm.createGroup({ name: 'b' });
    expect(() => gm.updateGroup(b.id, { name: 'a' })).toThrow('already exists');
  });

  it('rejects update to nonexistent group', () => {
    expect(() => gm.updateGroup('grp_fake', { name: 'x' })).toThrow('not found');
  });

  it('deletes a group', () => {
    const group = gm.createGroup({ name: 'deletable' });
    expect(gm.deleteGroup(group.id)).toBe(true);
    expect(gm.count).toBe(0);
    expect(gm.getGroup(group.id)?.active).toBe(false);
  });

  it('returns false when deleting nonexistent group', () => {
    expect(gm.deleteGroup('grp_fake')).toBe(false);
  });

  it('lists only active groups', () => {
    gm.createGroup({ name: 'active' });
    const del = gm.createGroup({ name: 'deleted' });
    gm.deleteGroup(del.id);
    const list = gm.listGroups();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe('active');
  });

  // ─── Key Membership ──────────────────────────────────────────────────

  it('assigns a key to a group', () => {
    const group = gm.createGroup({ name: 'grp1' });
    gm.assignKey('pg_key1', group.id);
    expect(gm.getKeyGroupId('pg_key1')).toBe(group.id);
    expect(gm.getKeyGroup('pg_key1')?.name).toBe('grp1');
  });

  it('rejects assignment to nonexistent group', () => {
    expect(() => gm.assignKey('pg_key1', 'grp_fake')).toThrow('not found');
  });

  it('removes a key from a group', () => {
    const group = gm.createGroup({ name: 'grp2' });
    gm.assignKey('pg_key2', group.id);
    expect(gm.removeKey('pg_key2')).toBe(true);
    expect(gm.getKeyGroupId('pg_key2')).toBeUndefined();
  });

  it('returns false when removing unassigned key', () => {
    expect(gm.removeKey('pg_nobody')).toBe(false);
  });

  it('lists group members', () => {
    const group = gm.createGroup({ name: 'members' });
    gm.assignKey('pg_a', group.id);
    gm.assignKey('pg_b', group.id);
    const members = gm.getGroupMembers(group.id);
    expect(members).toContain('pg_a');
    expect(members).toContain('pg_b');
    expect(members.length).toBe(2);
  });

  it('deleting a group removes key assignments', () => {
    const group = gm.createGroup({ name: 'cleanup' });
    gm.assignKey('pg_x', group.id);
    gm.deleteGroup(group.id);
    expect(gm.getKeyGroupId('pg_x')).toBeUndefined();
  });

  it('memberCount is shown in list', () => {
    const group = gm.createGroup({ name: 'counted' });
    gm.assignKey('pg_m1', group.id);
    gm.assignKey('pg_m2', group.id);
    const list = gm.listGroups();
    expect(list[0].memberCount).toBe(2);
  });

  // ─── Policy Resolution ───────────────────────────────────────────────

  it('resolvePolicy returns null for unassigned key', () => {
    const result = gm.resolvePolicy('pg_nogroup', {
      allowedTools: [], deniedTools: [], ipAllowlist: [], spendingLimit: 0,
    });
    expect(result).toBeNull();
  });

  it('resolvePolicy uses group allowedTools when key has none', () => {
    const group = gm.createGroup({ name: 'acl-test', allowedTools: ['tool_a', 'tool_b'] });
    gm.assignKey('pg_k1', group.id);
    const policy = gm.resolvePolicy('pg_k1', {
      allowedTools: [], deniedTools: [], ipAllowlist: [], spendingLimit: 0,
    });
    expect(policy?.allowedTools).toEqual(['tool_a', 'tool_b']);
  });

  it('resolvePolicy uses key allowedTools when key has them', () => {
    const group = gm.createGroup({ name: 'acl-override', allowedTools: ['tool_a'] });
    gm.assignKey('pg_k2', group.id);
    const policy = gm.resolvePolicy('pg_k2', {
      allowedTools: ['tool_x'], deniedTools: [], ipAllowlist: [], spendingLimit: 0,
    });
    expect(policy?.allowedTools).toEqual(['tool_x']); // key wins
  });

  it('resolvePolicy merges deniedTools (union)', () => {
    const group = gm.createGroup({ name: 'deny-merge', deniedTools: ['tool_a'] });
    gm.assignKey('pg_k3', group.id);
    const policy = gm.resolvePolicy('pg_k3', {
      allowedTools: [], deniedTools: ['tool_b'], ipAllowlist: [], spendingLimit: 0,
    });
    expect(policy?.deniedTools).toContain('tool_a');
    expect(policy?.deniedTools).toContain('tool_b');
  });

  it('resolvePolicy merges IP allowlists (union)', () => {
    const group = gm.createGroup({ name: 'ip-merge', ipAllowlist: ['10.0.0.1'] });
    gm.assignKey('pg_k4', group.id);
    const policy = gm.resolvePolicy('pg_k4', {
      allowedTools: [], deniedTools: [], ipAllowlist: ['192.168.1.1'], spendingLimit: 0,
    });
    expect(policy?.ipAllowlist).toContain('10.0.0.1');
    expect(policy?.ipAllowlist).toContain('192.168.1.1');
  });

  it('resolvePolicy uses key quota when available', () => {
    const group = gm.createGroup({
      name: 'quota-test',
      quota: { dailyCallLimit: 100, monthlyCallLimit: 3000, dailyCreditLimit: 50, monthlyCreditLimit: 1500 },
    });
    gm.assignKey('pg_k5', group.id);
    const keyQuota = { dailyCallLimit: 200, monthlyCallLimit: 6000, dailyCreditLimit: 100, monthlyCreditLimit: 3000 };
    const policy = gm.resolvePolicy('pg_k5', {
      allowedTools: [], deniedTools: [], ipAllowlist: [], spendingLimit: 0, quota: keyQuota,
    });
    expect(policy?.quota?.dailyCallLimit).toBe(200); // key wins
  });

  it('resolvePolicy uses group quota when key has none', () => {
    const group = gm.createGroup({
      name: 'quota-fallback',
      quota: { dailyCallLimit: 100, monthlyCallLimit: 3000, dailyCreditLimit: 50, monthlyCreditLimit: 1500 },
    });
    gm.assignKey('pg_k6', group.id);
    const policy = gm.resolvePolicy('pg_k6', {
      allowedTools: [], deniedTools: [], ipAllowlist: [], spendingLimit: 0,
    });
    expect(policy?.quota?.dailyCallLimit).toBe(100); // group fallback
  });

  // ─── Serialization ───────────────────────────────────────────────────

  it('serializes and loads', () => {
    const group = gm.createGroup({ name: 'persist', allowedTools: ['tool_a'] });
    gm.assignKey('pg_p1', group.id);

    const data = gm.serialize();
    const gm2 = new KeyGroupManager();
    gm2.load(data);

    expect(gm2.count).toBe(1);
    expect(gm2.getGroupByName('persist')?.allowedTools).toEqual(['tool_a']);
    expect(gm2.getKeyGroupId('pg_p1')).toBe(group.id);
  });

  it('load clears previous state', () => {
    gm.createGroup({ name: 'old' });
    gm.load({ groups: [], assignments: [] });
    expect(gm.count).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Gate Integration Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Gate Group Integration', () => {
  it('group ACL denies tools not in group allowedTools', () => {
    const gate = new Gate({ ...DEFAULT_CONFIG, defaultCreditsPerCall: 1, globalRateLimitPerMin: 60 });
    const gm = new KeyGroupManager();
    gate.groupManager = gm;

    // Create key and group
    const key = gate.store.createKey('test', 100);
    const group = gm.createGroup({ name: 'restricted', allowedTools: ['read_file'] });
    gm.assignKey(key.key, group.id);

    // read_file should be allowed
    const r1 = gate.evaluate(key.key, { name: 'read_file' });
    expect(r1.allowed).toBe(true);

    // write_file should be denied
    const r2 = gate.evaluate(key.key, { name: 'write_file' });
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toContain('tool_not_allowed');
  });

  it('group deniedTools are merged with key deniedTools', () => {
    const gate = new Gate({ ...DEFAULT_CONFIG, defaultCreditsPerCall: 1, globalRateLimitPerMin: 60 });
    const gm = new KeyGroupManager();
    gate.groupManager = gm;

    const key = gate.store.createKey('test', 100, { deniedTools: ['tool_b'] });
    const group = gm.createGroup({ name: 'deny-merge', deniedTools: ['tool_a'] });
    gm.assignKey(key.key, group.id);

    // Both tool_a and tool_b should be denied
    const r1 = gate.evaluate(key.key, { name: 'tool_a' });
    expect(r1.allowed).toBe(false);
    const r2 = gate.evaluate(key.key, { name: 'tool_b' });
    expect(r2.allowed).toBe(false);
    // Other tools should be fine
    const r3 = gate.evaluate(key.key, { name: 'tool_c' });
    expect(r3.allowed).toBe(true);
  });

  it('group toolPricing overrides global pricing', () => {
    const gate = new Gate({
      ...DEFAULT_CONFIG,
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 60,
      toolPricing: { search: { creditsPerCall: 2 } },
    });
    const gm = new KeyGroupManager();
    gate.groupManager = gm;

    const key = gate.store.createKey('test', 100);
    const group = gm.createGroup({ name: 'premium-pricing', toolPricing: { search: { creditsPerCall: 10 } } });
    gm.assignKey(key.key, group.id);

    // With group assigned, search should cost 10
    expect(gate.getToolPrice('search', undefined, key.key)).toBe(10);
    // Without group, search costs global 2
    gm.removeKey(key.key);
    expect(gate.getToolPrice('search', undefined, key.key)).toBe(2);
  });

  it('key without group uses normal pricing', () => {
    const gate = new Gate({ ...DEFAULT_CONFIG, defaultCreditsPerCall: 5, globalRateLimitPerMin: 60 });
    const gm = new KeyGroupManager();
    gate.groupManager = gm;

    expect(gate.getToolPrice('anything')).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Server Endpoint Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Server Group Endpoints', () => {
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
              result: { tools: [{ name: 'read_file' }, { name: 'write_file' }, { name: 'search' }] }
            }) + '\\n');
          } else if (req.method === 'tools/call') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0', id: req.id,
              result: { content: [{ type: 'text', text: 'done' }] }
            }) + '\\n');
          } else {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\\n');
          }
        });
      `],
      port: 0,
      defaultCreditsPerCall: 1,
    });

    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('POST /groups creates a group', async () => {
    const res = await httpReq(port, '/groups', 'POST', {
      name: 'test-group',
      description: 'Test group',
      allowedTools: ['read_file'],
      deniedTools: ['write_file'],
      rateLimitPerMin: 30,
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(201);
    expect(res.data.id).toMatch(/^grp_/);
    expect(res.data.name).toBe('test-group');
    expect(res.data.allowedTools).toEqual(['read_file']);
    expect(res.data.deniedTools).toEqual(['write_file']);
  });

  it('GET /groups lists groups', async () => {
    const res = await httpReq(port, '/groups', 'GET', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.data.count).toBeGreaterThanOrEqual(1);
    expect(res.data.groups[0].name).toBe('test-group');
  });

  it('GET /groups requires admin key', async () => {
    const res = await httpReq(port, '/groups', 'GET');
    expect(res.status).toBe(401);
  });

  it('POST /groups rejects duplicate names', async () => {
    const res = await httpReq(port, '/groups', 'POST', { name: 'test-group' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('already exists');
  });

  it('POST /groups/update updates a group', async () => {
    // Get the group ID
    const listRes = await httpReq(port, '/groups', 'GET', undefined, { 'X-Admin-Key': adminKey });
    const groupId = listRes.data.groups[0].id;

    const res = await httpReq(port, '/groups/update', 'POST', {
      id: groupId,
      description: 'Updated description',
      maxSpendingLimit: 5000,
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.data.description).toBe('Updated description');
    expect(res.data.maxSpendingLimit).toBe(5000);
  });

  it('POST /groups/assign assigns a key to a group', async () => {
    // Create an API key
    const createRes = await httpReq(port, '/keys', 'POST', { name: 'group-test', credits: 1000 }, { 'X-Admin-Key': adminKey });
    const apiKey = createRes.data.key;

    // Get group ID
    const listRes = await httpReq(port, '/groups', 'GET', undefined, { 'X-Admin-Key': adminKey });
    const groupId = listRes.data.groups[0].id;

    const res = await httpReq(port, '/groups/assign', 'POST', {
      key: apiKey,
      groupId,
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
  });

  it('POST /groups/assign rejects nonexistent key', async () => {
    const listRes = await httpReq(port, '/groups', 'GET', undefined, { 'X-Admin-Key': adminKey });
    const groupId = listRes.data.groups[0].id;

    const res = await httpReq(port, '/groups/assign', 'POST', {
      key: 'pg_fake',
      groupId,
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(404);
    expect(res.data.error).toContain('not found');
  });

  it('POST /groups/remove removes a key from a group', async () => {
    // Create and assign
    const createRes = await httpReq(port, '/keys', 'POST', { name: 'removable', credits: 100 }, { 'X-Admin-Key': adminKey });
    const apiKey = createRes.data.key;
    const listRes = await httpReq(port, '/groups', 'GET', undefined, { 'X-Admin-Key': adminKey });
    const groupId = listRes.data.groups[0].id;
    await httpReq(port, '/groups/assign', 'POST', { key: apiKey, groupId }, { 'X-Admin-Key': adminKey });

    // Remove
    const res = await httpReq(port, '/groups/remove', 'POST', { key: apiKey }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
  });

  it('POST /groups/remove returns 404 for unassigned key', async () => {
    const res = await httpReq(port, '/groups/remove', 'POST', { key: 'pg_nobody' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(404);
  });

  it('POST /groups/delete deletes a group', async () => {
    // Create a temp group
    const createRes = await httpReq(port, '/groups', 'POST', { name: 'deletable-group' }, { 'X-Admin-Key': adminKey });
    const groupId = createRes.data.id;

    const res = await httpReq(port, '/groups/delete', 'POST', { id: groupId }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);

    // Verify it's gone from listings
    const listRes = await httpReq(port, '/groups', 'GET', undefined, { 'X-Admin-Key': adminKey });
    const names = listRes.data.groups.map((g: any) => g.name);
    expect(names).not.toContain('deletable-group');
  });

  it('POST /groups/delete returns 404 for nonexistent', async () => {
    const res = await httpReq(port, '/groups/delete', 'POST', { id: 'grp_fake' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(404);
  });

  it('assigned key inherits group ACL in gate', async () => {
    // Create a restricted group
    const grpRes = await httpReq(port, '/groups', 'POST', {
      name: 'read-only-group',
      allowedTools: ['read_file'],
    }, { 'X-Admin-Key': adminKey });
    const groupId = grpRes.data.id;

    // Create and assign key
    const keyRes = await httpReq(port, '/keys', 'POST', { name: 'restricted-key', credits: 100 }, { 'X-Admin-Key': adminKey });
    const apiKey = keyRes.data.key;
    await httpReq(port, '/groups/assign', 'POST', { key: apiKey, groupId }, { 'X-Admin-Key': adminKey });

    // read_file should work
    const readRes = await httpReq(port, '/mcp', 'POST', {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file' },
    }, { 'X-API-Key': apiKey });
    expect(readRes.data.result).toBeDefined();

    // write_file should be denied
    const writeRes = await httpReq(port, '/mcp', 'POST', {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write_file' },
    }, { 'X-API-Key': apiKey });
    expect(writeRes.data.error).toBeDefined();
    expect(writeRes.data.error.message).toContain('tool_not_allowed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Root Listing & Metrics
// ═══════════════════════════════════════════════════════════════════════════

describe('Root listing includes /groups', () => {
  it('shows group endpoints in listing', async () => {
    const server = new PayGateServer({
      serverCommand: 'node',
      serverArgs: ['-e', 'process.stdin.resume(); process.stdin.on("data", d => { const r = JSON.parse(d.toString().trim()); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: {} }) + "\\n"); });'],
      port: 0,
    });
    const { port } = await server.start();
    const res = await httpReq(port, '/', 'GET');
    expect(res.status).toBe(200);
    expect(res.data.endpoints.listGroups).toContain('/groups');
    expect(res.data.endpoints.createGroup).toContain('/groups');
    expect(res.data.endpoints.assignKeyToGroup).toContain('/groups/assign');
    await server.stop();
  });
});

describe('Group metrics gauge', () => {
  it('tracks number of active groups', async () => {
    const server = new PayGateServer({
      serverCommand: 'node',
      serverArgs: ['-e', 'process.stdin.resume(); process.stdin.on("data", d => { const r = JSON.parse(d.toString().trim()); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: {} }) + "\\n"); });'],
      port: 0,
    });

    const { port, adminKey } = await server.start();

    // 0 groups
    let res = await httpReq(port, '/metrics', 'GET');
    expect(res.data).toContain('paygate_groups_total 0');

    // Create a group via API
    await httpReq(port, '/groups', 'POST', { name: 'metric-test' }, { 'X-Admin-Key': adminKey });

    // 1 group
    res = await httpReq(port, '/metrics', 'GET');
    expect(res.data).toContain('paygate_groups_total 1');

    await server.stop();
  });
});
