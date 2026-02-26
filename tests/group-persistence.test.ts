/**
 * Tests for Key Group state file persistence.
 *
 * Validates:
 *   - Groups saved to / loaded from *-groups.json file
 *   - Assignments survive restart
 *   - Corrupted file handled gracefully
 *   - No file path = no-op
 *   - Server wiring derives correct file path
 *   - Endpoints trigger file persistence
 */

import { KeyGroupManager } from '../src/groups';
import { PayGateServer } from '../src/server';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { randomBytes } from 'crypto';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), 'paygate-groups-test-' + randomBytes(8).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tmpGroupsPath(): string {
  return path.join(tmpDir(), 'groups.json');
}

function cleanup(...paths: string[]): void {
  for (const p of paths) {
    try { fs.unlinkSync(p); } catch {}
  }
  // Clean directories too
  const dirs = new Set(paths.map(p => path.dirname(p)));
  for (const d of dirs) {
    try { fs.rmdirSync(d); } catch {}
  }
}

function httpReq(
  port: number,
  urlPath: string,
  method: string = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data: any;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode!, data });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Minimal MCP backend that responds to all requests
const ECHO_CMD = 'node';
const ECHO_ARGS = ['-e', 'process.stdin.resume(); process.stdin.on("data", d => { const r = JSON.parse(d.toString().trim()); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: {} }) + "\\n"); });'];

// ─── KeyGroupManager File Persistence ─────────────────────────────────────────

describe('KeyGroupManager — File Persistence', () => {
  it('should save and reload groups from file', () => {
    const filePath = tmpGroupsPath();
    try {
      const mgr1 = new KeyGroupManager(filePath);
      const group = mgr1.createGroup({ name: 'test-group', description: 'A test group' });
      mgr1.saveToFile();

      expect(fs.existsSync(filePath)).toBe(true);

      // Load into new manager
      const mgr2 = new KeyGroupManager(filePath);
      const loaded = mgr2.getGroup(group.id);
      expect(loaded).toBeDefined();
      expect(loaded!.name).toBe('test-group');
      expect(loaded!.description).toBe('A test group');
      expect(loaded!.active).toBe(true);
    } finally {
      cleanup(filePath);
    }
  });

  it('should persist key-to-group assignments', () => {
    const filePath = tmpGroupsPath();
    try {
      const mgr1 = new KeyGroupManager(filePath);
      const group = mgr1.createGroup({ name: 'assign-group' });
      mgr1.assignKey('pk_test_key_1', group.id);
      mgr1.assignKey('pk_test_key_2', group.id);
      mgr1.saveToFile();

      const mgr2 = new KeyGroupManager(filePath);
      expect(mgr2.getKeyGroupId('pk_test_key_1')).toBe(group.id);
      expect(mgr2.getKeyGroupId('pk_test_key_2')).toBe(group.id);
      expect(mgr2.getGroupMembers(group.id)).toEqual(
        expect.arrayContaining(['pk_test_key_1', 'pk_test_key_2'])
      );
    } finally {
      cleanup(filePath);
    }
  });

  it('should persist group policy fields', () => {
    const filePath = tmpGroupsPath();
    try {
      const mgr1 = new KeyGroupManager(filePath);
      const group = mgr1.createGroup({
        name: 'policy-group',
        allowedTools: ['tool_a', 'tool_b'],
        deniedTools: ['tool_c'],
        rateLimitPerMin: 100,
        toolPricing: { tool_a: { creditsPerCall: 5 } },
        quota: { dailyCallLimit: 1000, monthlyCallLimit: 30000, dailyCreditLimit: 500, monthlyCreditLimit: 15000 },
        ipAllowlist: ['10.0.0.0/8'],
        defaultCredits: 500,
        maxSpendingLimit: 10000,
        tags: { env: 'prod', tier: 'enterprise' },
      });
      mgr1.saveToFile();

      const mgr2 = new KeyGroupManager(filePath);
      const loaded = mgr2.getGroup(group.id)!;
      expect(loaded.allowedTools).toEqual(['tool_a', 'tool_b']);
      expect(loaded.deniedTools).toEqual(['tool_c']);
      expect(loaded.rateLimitPerMin).toBe(100);
      expect(loaded.toolPricing).toEqual({ tool_a: { creditsPerCall: 5 } });
      expect(loaded.quota).toEqual({
        dailyCallLimit: 1000,
        monthlyCallLimit: 30000,
        dailyCreditLimit: 500,
        monthlyCreditLimit: 15000,
      });
      expect(loaded.ipAllowlist).toEqual(['10.0.0.0/8']);
      expect(loaded.defaultCredits).toBe(500);
      expect(loaded.maxSpendingLimit).toBe(10000);
      expect(loaded.tags).toEqual({ env: 'prod', tier: 'enterprise' });
    } finally {
      cleanup(filePath);
    }
  });

  it('should persist multiple groups', () => {
    const filePath = tmpGroupsPath();
    try {
      const mgr1 = new KeyGroupManager(filePath);
      mgr1.createGroup({ name: 'group-alpha' });
      mgr1.createGroup({ name: 'group-beta' });
      mgr1.createGroup({ name: 'group-gamma' });
      mgr1.saveToFile();

      const mgr2 = new KeyGroupManager(filePath);
      expect(mgr2.count).toBe(3);
      expect(mgr2.getGroupByName('group-alpha')).toBeDefined();
      expect(mgr2.getGroupByName('group-beta')).toBeDefined();
      expect(mgr2.getGroupByName('group-gamma')).toBeDefined();
    } finally {
      cleanup(filePath);
    }
  });

  it('should persist deleted groups (inactive)', () => {
    const filePath = tmpGroupsPath();
    try {
      const mgr1 = new KeyGroupManager(filePath);
      const g1 = mgr1.createGroup({ name: 'keep-me' });
      const g2 = mgr1.createGroup({ name: 'delete-me' });
      mgr1.deleteGroup(g2.id);
      mgr1.saveToFile();

      const mgr2 = new KeyGroupManager(filePath);
      expect(mgr2.count).toBe(1); // Only active groups
      expect(mgr2.getGroupByName('keep-me')).toBeDefined();
      expect(mgr2.getGroupByName('delete-me')).toBeUndefined();
      // But the raw group record is still in the map (just inactive)
      expect(mgr2.getGroup(g2.id)).toBeDefined();
      expect(mgr2.getGroup(g2.id)!.active).toBe(false);
    } finally {
      cleanup(filePath);
    }
  });

  it('should handle corrupted state file gracefully', () => {
    const filePath = tmpGroupsPath();
    try {
      fs.writeFileSync(filePath, '{{{{NOT VALID JSON}}}}');
      const mgr = new KeyGroupManager(filePath);
      expect(mgr.count).toBe(0);
    } finally {
      cleanup(filePath);
    }
  });

  it('should handle missing state file gracefully', () => {
    const filePath = tmpGroupsPath();
    cleanup(filePath); // Ensure it doesn't exist
    const mgr = new KeyGroupManager(filePath);
    expect(mgr.count).toBe(0);
  });

  it('should no-op saveToFile when no filePath', () => {
    const mgr = new KeyGroupManager(); // No path
    mgr.createGroup({ name: 'ephemeral' });
    // Should not throw
    mgr.saveToFile();
    expect(mgr.count).toBe(1);
  });

  it('should overwrite file on each save', () => {
    const filePath = tmpGroupsPath();
    try {
      const mgr = new KeyGroupManager(filePath);
      mgr.createGroup({ name: 'first' });
      mgr.saveToFile();

      const contents1 = fs.readFileSync(filePath, 'utf-8');
      expect(contents1).toContain('first');

      mgr.createGroup({ name: 'second' });
      mgr.saveToFile();

      const contents2 = fs.readFileSync(filePath, 'utf-8');
      expect(contents2).toContain('first');
      expect(contents2).toContain('second');
    } finally {
      cleanup(filePath);
    }
  });

  it('should produce valid JSON on save', () => {
    const filePath = tmpGroupsPath();
    try {
      const mgr = new KeyGroupManager(filePath);
      mgr.createGroup({ name: 'json-test' });
      mgr.saveToFile();

      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed).toHaveProperty('groups');
      expect(parsed).toHaveProperty('assignments');
      expect(Array.isArray(parsed.groups)).toBe(true);
      expect(Array.isArray(parsed.assignments)).toBe(true);
    } finally {
      cleanup(filePath);
    }
  });

  it('should persist assignment removal', () => {
    const filePath = tmpGroupsPath();
    try {
      const mgr1 = new KeyGroupManager(filePath);
      const group = mgr1.createGroup({ name: 'removal-test' });
      mgr1.assignKey('pk_key_a', group.id);
      mgr1.assignKey('pk_key_b', group.id);
      mgr1.removeKey('pk_key_a');
      mgr1.saveToFile();

      const mgr2 = new KeyGroupManager(filePath);
      expect(mgr2.getKeyGroupId('pk_key_a')).toBeUndefined();
      expect(mgr2.getKeyGroupId('pk_key_b')).toBe(group.id);
    } finally {
      cleanup(filePath);
    }
  });

  it('should persist group updates', () => {
    const filePath = tmpGroupsPath();
    try {
      const mgr1 = new KeyGroupManager(filePath);
      const group = mgr1.createGroup({ name: 'update-test', description: 'original' });
      mgr1.updateGroup(group.id, { description: 'updated desc', rateLimitPerMin: 200 });
      mgr1.saveToFile();

      const mgr2 = new KeyGroupManager(filePath);
      const loaded = mgr2.getGroup(group.id)!;
      expect(loaded.description).toBe('updated desc');
      expect(loaded.rateLimitPerMin).toBe(200);
    } finally {
      cleanup(filePath);
    }
  });

  it('should handle empty groups + assignments gracefully', () => {
    const filePath = tmpGroupsPath();
    try {
      // Write a minimal valid file with empty arrays
      fs.writeFileSync(filePath, JSON.stringify({ groups: [], assignments: [] }));
      const mgr = new KeyGroupManager(filePath);
      expect(mgr.count).toBe(0);
    } finally {
      cleanup(filePath);
    }
  });

  it('should handle partial state file (missing assignments)', () => {
    const filePath = tmpGroupsPath();
    try {
      const mgr1 = new KeyGroupManager(filePath);
      const group = mgr1.createGroup({ name: 'partial-test' });
      mgr1.saveToFile();

      // Manually remove assignments from file (simulate old version)
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      delete data.assignments;
      fs.writeFileSync(filePath, JSON.stringify(data));

      // Should still load groups
      const mgr2 = new KeyGroupManager(filePath);
      expect(mgr2.count).toBe(1);
      expect(mgr2.getGroup(group.id)).toBeDefined();
    } finally {
      cleanup(filePath);
    }
  });
});

// ─── Server Wiring ────────────────────────────────────────────────────────────

describe('Server — Group State Path Derivation', () => {
  it('should derive groups path from statePath', () => {
    const server = new PayGateServer(
      { serverCommand: 'echo', serverArgs: ['test'] },
      'admin_test',
      '/tmp/paygate-state.json'
    );
    expect(server.groups).toBeDefined();
    expect(server.groups.count).toBe(0);
  });

  it('should work without statePath (no persistence)', () => {
    const server = new PayGateServer(
      { serverCommand: 'echo', serverArgs: ['test'] },
      'admin_test'
    );
    expect(server.groups).toBeDefined();
    expect(server.groups.count).toBe(0);
  });
});

// ─── Server Endpoint Persistence ──────────────────────────────────────────────

describe('Server Endpoints — Group File Persistence', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let statePath: string;
  let groupsPath: string;

  beforeAll(async () => {
    const dir = tmpDir();
    statePath = path.join(dir, 'state.json');
    groupsPath = statePath.replace(/\.json$/, '-groups.json');

    server = new PayGateServer(
      { serverCommand: ECHO_CMD, serverArgs: ECHO_ARGS, port: 0 },
      undefined, // auto-generate admin key
      statePath,
    );

    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
  });

  afterAll(async () => {
    await server.stop();
    cleanup(statePath, groupsPath);
    // Also clean adjacent files
    try { fs.unlinkSync(statePath.replace(/\.json$/, '-admin.json')); } catch {}
    try { fs.rmdirSync(path.dirname(statePath)); } catch {}
  });

  it('POST /groups should persist to file', async () => {
    const res = await httpReq(port, '/groups', 'POST', { name: 'persist-create' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(201);

    // Verify file was written
    expect(fs.existsSync(groupsPath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(groupsPath, 'utf-8'));
    const found = raw.groups.find((g: any) => g[1].name === 'persist-create');
    expect(found).toBeDefined();
  });

  it('POST /groups/update should persist to file', async () => {
    const createRes = await httpReq(port, '/groups', 'POST', { name: 'persist-update' }, { 'X-Admin-Key': adminKey });
    expect(createRes.status).toBe(201);
    const groupId = createRes.data.id;

    const updateRes = await httpReq(port, '/groups/update', 'POST', { id: groupId, description: 'new desc' }, { 'X-Admin-Key': adminKey });
    expect(updateRes.status).toBe(200);

    const raw = JSON.parse(fs.readFileSync(groupsPath, 'utf-8'));
    const found = raw.groups.find((g: any) => g[0] === groupId);
    expect(found).toBeDefined();
    expect(found[1].description).toBe('new desc');
  });

  it('POST /groups/delete should persist to file', async () => {
    const createRes = await httpReq(port, '/groups', 'POST', { name: 'persist-delete' }, { 'X-Admin-Key': adminKey });
    expect(createRes.status).toBe(201);
    const groupId = createRes.data.id;

    const deleteRes = await httpReq(port, '/groups/delete', 'POST', { id: groupId }, { 'X-Admin-Key': adminKey });
    expect(deleteRes.status).toBe(200);

    const raw = JSON.parse(fs.readFileSync(groupsPath, 'utf-8'));
    const found = raw.groups.find((g: any) => g[0] === groupId);
    expect(found).toBeDefined();
    expect(found[1].active).toBe(false);
  });

  it('POST /groups/assign should persist assignments to file', async () => {
    const createRes = await httpReq(port, '/groups', 'POST', { name: 'persist-assign' }, { 'X-Admin-Key': adminKey });
    expect(createRes.status).toBe(201);
    const groupId = createRes.data.id;

    // Create a key
    const keyRes = await httpReq(port, '/keys', 'POST', { credits: 100 }, { 'X-Admin-Key': adminKey });
    expect(keyRes.status).toBe(201);
    const apiKey = keyRes.data.key;

    const assignRes = await httpReq(port, '/groups/assign', 'POST', { key: apiKey, groupId }, { 'X-Admin-Key': adminKey });
    expect(assignRes.status).toBe(200);

    const raw = JSON.parse(fs.readFileSync(groupsPath, 'utf-8'));
    expect(raw.assignments.some((a: any) => a[0] === apiKey && a[1] === groupId)).toBe(true);
  });

  it('POST /groups/remove should persist assignment removal to file', async () => {
    const createRes = await httpReq(port, '/groups', 'POST', { name: 'persist-remove' }, { 'X-Admin-Key': adminKey });
    expect(createRes.status).toBe(201);
    const groupId = createRes.data.id;

    const keyRes = await httpReq(port, '/keys', 'POST', { credits: 100 }, { 'X-Admin-Key': adminKey });
    expect(keyRes.status).toBe(201);
    const apiKey = keyRes.data.key;

    await httpReq(port, '/groups/assign', 'POST', { key: apiKey, groupId }, { 'X-Admin-Key': adminKey });

    const removeRes = await httpReq(port, '/groups/remove', 'POST', { key: apiKey }, { 'X-Admin-Key': adminKey });
    expect(removeRes.status).toBe(200);

    const raw = JSON.parse(fs.readFileSync(groupsPath, 'utf-8'));
    expect(raw.assignments.some((a: any) => a[0] === apiKey)).toBe(false);
  });

  it('groups should survive simulated restart', async () => {
    const createRes = await httpReq(port, '/groups', 'POST', { name: 'survive-restart' }, { 'X-Admin-Key': adminKey });
    expect(createRes.status).toBe(201);
    const groupId = createRes.data.id;

    const keyRes = await httpReq(port, '/keys', 'POST', { credits: 100 }, { 'X-Admin-Key': adminKey });
    expect(keyRes.status).toBe(201);
    const apiKey = keyRes.data.key;

    await httpReq(port, '/groups/assign', 'POST', { key: apiKey, groupId }, { 'X-Admin-Key': adminKey });

    // Load from the same file (simulates restart)
    const mgr2 = new KeyGroupManager(groupsPath);
    expect(mgr2.getGroupByName('survive-restart')).toBeDefined();
    expect(mgr2.getGroupByName('survive-restart')!.id).toBe(groupId);
    expect(mgr2.getKeyGroupId(apiKey)).toBe(groupId);
  });
});
