/**
 * Tests for Team/Organization Management (v1.9.0).
 *
 * Covers:
 *   - TeamManager: create, list, update, delete, assign/remove keys
 *   - Team budgets and quota enforcement
 *   - Team usage recording and summaries
 *   - Gate integration with team budget/quota checks
 *   - Server HTTP endpoints for team management
 */

import { TeamManager, TeamRecord } from '../src/teams';
import { ApiKeyRecord, QuotaConfig } from '../src/types';
import { Gate } from '../src/gate';
import { PayGateServer } from '../src/server';
import http from 'http';

// ─── TeamManager Unit Tests ─────────────────────────────────────────────────

describe('TeamManager', () => {
  let mgr: TeamManager;

  beforeEach(() => {
    mgr = new TeamManager();
  });

  describe('createTeam', () => {
    it('should create a team with defaults', () => {
      const team = mgr.createTeam({ name: 'Backend Team' });
      expect(team.id).toMatch(/^team_[0-9a-f]{16}$/);
      expect(team.name).toBe('Backend Team');
      expect(team.description).toBe('');
      expect(team.memberKeys).toEqual([]);
      expect(team.budget).toBe(0);
      expect(team.totalSpent).toBe(0);
      expect(team.active).toBe(true);
      expect(team.tags).toEqual({});
    });

    it('should create a team with all options', () => {
      const team = mgr.createTeam({
        name: 'Frontend Team',
        description: 'UI engineers',
        budget: 10000,
        quota: { dailyCallLimit: 100, monthlyCallLimit: 1000, dailyCreditLimit: 500, monthlyCreditLimit: 5000 },
        tags: { env: 'production', tier: 'premium' },
      });
      expect(team.name).toBe('Frontend Team');
      expect(team.description).toBe('UI engineers');
      expect(team.budget).toBe(10000);
      expect(team.quota?.dailyCallLimit).toBe(100);
      expect(team.tags.env).toBe('production');
    });

    it('should sanitize name to 200 chars', () => {
      const team = mgr.createTeam({ name: 'x'.repeat(300) });
      expect(team.name.length).toBe(200);
    });
  });

  describe('getTeam / listTeams', () => {
    it('should return team by ID', () => {
      const team = mgr.createTeam({ name: 'Test' });
      expect(mgr.getTeam(team.id)).toEqual(team);
    });

    it('should return null for unknown ID', () => {
      expect(mgr.getTeam('team_unknown')).toBeNull();
    });

    it('should list only active teams', () => {
      const t1 = mgr.createTeam({ name: 'A' });
      const t2 = mgr.createTeam({ name: 'B' });
      mgr.deleteTeam(t1.id);
      const list = mgr.listTeams();
      expect(list.length).toBe(1);
      expect(list[0].id).toBe(t2.id);
    });
  });

  describe('updateTeam', () => {
    it('should update name and description', () => {
      const team = mgr.createTeam({ name: 'Old' });
      const ok = mgr.updateTeam(team.id, { name: 'New', description: 'Updated' });
      expect(ok).toBe(true);
      expect(mgr.getTeam(team.id)!.name).toBe('New');
      expect(mgr.getTeam(team.id)!.description).toBe('Updated');
    });

    it('should update budget', () => {
      const team = mgr.createTeam({ name: 'T', budget: 100 });
      mgr.updateTeam(team.id, { budget: 500 });
      expect(mgr.getTeam(team.id)!.budget).toBe(500);
    });

    it('should merge tags (null removes)', () => {
      const team = mgr.createTeam({ name: 'T', tags: { a: '1', b: '2' } });
      mgr.updateTeam(team.id, { tags: { b: null, c: '3' } });
      const t = mgr.getTeam(team.id)!;
      expect(t.tags).toEqual({ a: '1', c: '3' });
    });

    it('should return false for unknown team', () => {
      expect(mgr.updateTeam('team_nope', { name: 'x' })).toBe(false);
    });

    it('should return false for deleted team', () => {
      const team = mgr.createTeam({ name: 'T' });
      mgr.deleteTeam(team.id);
      expect(mgr.updateTeam(team.id, { name: 'x' })).toBe(false);
    });
  });

  describe('deleteTeam', () => {
    it('should deactivate team and unassign keys', () => {
      const team = mgr.createTeam({ name: 'T' });
      mgr.assignKey(team.id, 'pg_key1');
      const ok = mgr.deleteTeam(team.id);
      expect(ok).toBe(true);
      expect(mgr.getTeam(team.id)!.active).toBe(false);
      expect(mgr.getTeamForKey('pg_key1')).toBeNull();
    });

    it('should return false for already deleted team', () => {
      const team = mgr.createTeam({ name: 'T' });
      mgr.deleteTeam(team.id);
      expect(mgr.deleteTeam(team.id)).toBe(false);
    });
  });

  describe('assignKey / removeKey', () => {
    it('should assign a key to a team', () => {
      const team = mgr.createTeam({ name: 'T' });
      const result = mgr.assignKey(team.id, 'pg_abc');
      expect(result.success).toBe(true);
      expect(mgr.getTeamForKey('pg_abc')).toBe(team.id);
      expect(mgr.getTeam(team.id)!.memberKeys).toContain('pg_abc');
    });

    it('should fail if key already in another team', () => {
      const t1 = mgr.createTeam({ name: 'T1' });
      const t2 = mgr.createTeam({ name: 'T2' });
      mgr.assignKey(t1.id, 'pg_abc');
      const result = mgr.assignKey(t2.id, 'pg_abc');
      expect(result.success).toBe(false);
      expect(result.error).toBe('key_already_in_team');
    });

    it('should be idempotent for same team', () => {
      const team = mgr.createTeam({ name: 'T' });
      mgr.assignKey(team.id, 'pg_abc');
      const result = mgr.assignKey(team.id, 'pg_abc');
      expect(result.success).toBe(true);
      expect(mgr.getTeam(team.id)!.memberKeys.length).toBe(1);
    });

    it('should enforce max 100 keys per team', () => {
      const team = mgr.createTeam({ name: 'T' });
      for (let i = 0; i < 100; i++) {
        mgr.assignKey(team.id, `pg_key_${i}`);
      }
      const result = mgr.assignKey(team.id, 'pg_key_overflow');
      expect(result.success).toBe(false);
      expect(result.error).toBe('team_full');
    });

    it('should fail to assign to non-existent team', () => {
      const result = mgr.assignKey('team_nope', 'pg_abc');
      expect(result.success).toBe(false);
      expect(result.error).toBe('team_not_found');
    });

    it('should remove key from team', () => {
      const team = mgr.createTeam({ name: 'T' });
      mgr.assignKey(team.id, 'pg_abc');
      const ok = mgr.removeKey(team.id, 'pg_abc');
      expect(ok).toBe(true);
      expect(mgr.getTeamForKey('pg_abc')).toBeNull();
      expect(mgr.getTeam(team.id)!.memberKeys).not.toContain('pg_abc');
    });

    it('should return false when removing non-member key', () => {
      const team = mgr.createTeam({ name: 'T' });
      expect(mgr.removeKey(team.id, 'pg_nonexist')).toBe(false);
    });
  });

  describe('checkBudget', () => {
    it('should allow when no team', () => {
      expect(mgr.checkBudget('pg_unassigned', 100).allowed).toBe(true);
    });

    it('should allow when budget is 0 (unlimited)', () => {
      const team = mgr.createTeam({ name: 'T', budget: 0 });
      mgr.assignKey(team.id, 'pg_abc');
      expect(mgr.checkBudget('pg_abc', 1000).allowed).toBe(true);
    });

    it('should allow when within budget', () => {
      const team = mgr.createTeam({ name: 'T', budget: 1000 });
      mgr.assignKey(team.id, 'pg_abc');
      expect(mgr.checkBudget('pg_abc', 500).allowed).toBe(true);
    });

    it('should deny when budget exceeded', () => {
      const team = mgr.createTeam({ name: 'T', budget: 100 });
      mgr.assignKey(team.id, 'pg_abc');
      mgr.recordUsage('pg_abc', 80);
      const result = mgr.checkBudget('pg_abc', 30);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('team_budget_exceeded');
    });
  });

  describe('checkQuota', () => {
    it('should allow when no team', () => {
      expect(mgr.checkQuota('pg_unassigned', 10).allowed).toBe(true);
    });

    it('should allow when no quota set', () => {
      const team = mgr.createTeam({ name: 'T' });
      mgr.assignKey(team.id, 'pg_abc');
      expect(mgr.checkQuota('pg_abc', 10).allowed).toBe(true);
    });

    it('should deny when daily call limit exceeded', () => {
      const team = mgr.createTeam({
        name: 'T',
        quota: { dailyCallLimit: 5, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 0 },
      });
      mgr.assignKey(team.id, 'pg_abc');
      for (let i = 0; i < 5; i++) mgr.recordUsage('pg_abc', 1);
      const result = mgr.checkQuota('pg_abc', 1);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('team_daily_call_limit');
    });

    it('should deny when daily credit limit exceeded', () => {
      const team = mgr.createTeam({
        name: 'T',
        quota: { dailyCallLimit: 0, monthlyCallLimit: 0, dailyCreditLimit: 50, monthlyCreditLimit: 0 },
      });
      mgr.assignKey(team.id, 'pg_abc');
      mgr.recordUsage('pg_abc', 40);
      const result = mgr.checkQuota('pg_abc', 20);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('team_daily_credit_limit');
    });
  });

  describe('recordUsage', () => {
    it('should increment team counters', () => {
      const team = mgr.createTeam({ name: 'T' });
      mgr.assignKey(team.id, 'pg_abc');
      mgr.recordUsage('pg_abc', 10);
      mgr.recordUsage('pg_abc', 5);
      const t = mgr.getTeam(team.id)!;
      expect(t.totalSpent).toBe(15);
      expect(t.quotaDailyCalls).toBe(2);
      expect(t.quotaDailyCredits).toBe(15);
    });

    it('should be no-op for unassigned key', () => {
      // Should not throw
      mgr.recordUsage('pg_orphan', 100);
    });
  });

  describe('getUsageSummary', () => {
    it('should return null for unknown team', () => {
      expect(mgr.getUsageSummary('team_nope', () => null)).toBeNull();
    });

    it('should return summary with member breakdown', () => {
      const team = mgr.createTeam({ name: 'T', budget: 1000 });
      mgr.assignKey(team.id, 'pg_abc');
      mgr.recordUsage('pg_abc', 50);

      const mockKey: ApiKeyRecord = {
        key: 'pg_abc',
        name: 'test',
        credits: 50,
        totalSpent: 50,
        totalCalls: 5,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        active: true,
        spendingLimit: 0,
        allowedTools: [],
        deniedTools: [],
        expiresAt: null,
        tags: {},
        ipAllowlist: [],
        quotaDailyCalls: 0,
        quotaMonthlyCalls: 0,
        quotaDailyCredits: 0,
        quotaMonthlyCredits: 0,
        quotaLastResetDay: '',
        quotaLastResetMonth: '',
      };

      const summary = mgr.getUsageSummary(team.id, (key) => key === 'pg_abc' ? mockKey : null);
      expect(summary).not.toBeNull();
      expect(summary!.teamName).toBe('T');
      expect(summary!.totalBudget).toBe(1000);
      expect(summary!.totalSpent).toBe(50);
      expect(summary!.remainingBudget).toBe(950);
      expect(summary!.members.length).toBe(1);
      expect(summary!.members[0].keyMasked).toMatch(/^pg_abc\.\.\./);
    });
  });

  describe('serialization', () => {
    it('should export and import state', () => {
      const team = mgr.createTeam({ name: 'T', budget: 500, tags: { env: 'prod' } });
      mgr.assignKey(team.id, 'pg_key1');
      mgr.recordUsage('pg_key1', 100);

      const data = mgr.toJSON();

      const mgr2 = new TeamManager();
      mgr2.fromJSON(data);

      const restored = mgr2.getTeam(team.id);
      expect(restored).not.toBeNull();
      expect(restored!.name).toBe('T');
      expect(restored!.budget).toBe(500);
      expect(restored!.totalSpent).toBe(100);
      expect(restored!.tags.env).toBe('prod');
      expect(mgr2.getTeamForKey('pg_key1')).toBe(team.id);
    });
  });
});

// ─── Gate + Team Integration ────────────────────────────────────────────────

describe('Gate + Team Integration', () => {
  it('should deny tool call when team budget exceeded', () => {
    const gate = new Gate({
      name: 'Test',
      serverCommand: '',
      serverArgs: [],
      port: 0,
      defaultCreditsPerCall: 10,
      toolPricing: {},
      globalRateLimitPerMin: 0,
      freeMethods: [],
      shadowMode: false,
      webhookUrl: null,
      webhookSecret: null,
      refundOnFailure: false,
    });

    const teams = new TeamManager();
    const team = teams.createTeam({ name: 'T', budget: 15 });

    const keyRecord = gate.store.createKey('test', 1000);
    const key = keyRecord.key;
    teams.assignKey(team.id, key);

    // Wire up team checker
    gate.teamChecker = (apiKey, credits) => {
      const budgetCheck = teams.checkBudget(apiKey, credits);
      if (!budgetCheck.allowed) return budgetCheck;
      return teams.checkQuota(apiKey, credits);
    };
    gate.teamRecorder = (apiKey, credits) => {
      teams.recordUsage(apiKey, credits);
    };

    // First call: should work (10 credits, budget 15)
    const d1 = gate.evaluate(key, { name: 'tool1' });
    expect(d1.allowed).toBe(true);
    expect(d1.creditsCharged).toBe(10);

    // Second call: should fail (would need 10 more, only 5 budget left)
    const d2 = gate.evaluate(key, { name: 'tool1' });
    expect(d2.allowed).toBe(false);
    expect(d2.reason).toBe('team_budget_exceeded');
  });
});

// ─── Server HTTP Endpoints ──────────────────────────────────────────────────

describe('Team Server Endpoints', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      defaultCreditsPerCall: 1,
    });
    const result = await server.start();
    port = result.port;
    adminKey = result.adminKey;
  });

  afterAll(async () => {
    await server.stop();
  });

  function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : undefined;
      const req = http.request({
        hostname: 'localhost',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      }, (res) => {
        let responseBody = '';
        res.on('data', (chunk: Buffer) => responseBody += chunk.toString());
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(responseBody) });
          } catch {
            resolve({ status: res.statusCode!, body: responseBody });
          }
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  it('POST /teams should create a team', async () => {
    const res = await request('POST', '/teams', { name: 'Engineering', budget: 5000 }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(201);
    expect(res.body.team.name).toBe('Engineering');
    expect(res.body.team.budget).toBe(5000);
    expect(res.body.team.id).toMatch(/^team_/);
  });

  it('POST /teams should require admin key', async () => {
    const res = await request('POST', '/teams', { name: 'Test' });
    expect(res.status).toBe(401);
  });

  it('POST /teams should require name', async () => {
    const res = await request('POST', '/teams', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
  });

  it('GET /teams should list teams', async () => {
    const res = await request('GET', '/teams', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.teams.length).toBeGreaterThanOrEqual(1);
    // Keys should be masked
    if (res.body.teams[0].memberKeys.length > 0) {
      expect(res.body.teams[0].memberKeys[0]).toContain('...');
    }
  });

  it('POST /teams/update should update a team', async () => {
    const createRes = await request('POST', '/teams', { name: 'ToUpdate' }, { 'X-Admin-Key': adminKey });
    const teamId = createRes.body.team.id;

    const res = await request('POST', '/teams/update', {
      teamId,
      name: 'Updated',
      budget: 9999,
    }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.team.name).toBe('Updated');
    expect(res.body.team.budget).toBe(9999);
  });

  it('POST /teams/assign should assign key to team', async () => {
    const createTeamRes = await request('POST', '/teams', { name: 'AssignTest' }, { 'X-Admin-Key': adminKey });
    const teamId = createTeamRes.body.team.id;

    const createKeyRes = await request('POST', '/keys', { name: 'team-key', credits: 100 }, { 'X-Admin-Key': adminKey });
    const key = createKeyRes.body.key;

    const res = await request('POST', '/teams/assign', { teamId, key }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Key assigned to team');
  });

  it('POST /teams/assign should reject unknown key', async () => {
    const createTeamRes = await request('POST', '/teams', { name: 'BadKey' }, { 'X-Admin-Key': adminKey });
    const teamId = createTeamRes.body.team.id;

    const res = await request('POST', '/teams/assign', { teamId, key: 'pg_nonexistent' }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(404);
  });

  it('POST /teams/remove should remove key from team', async () => {
    const createTeamRes = await request('POST', '/teams', { name: 'RemoveTest' }, { 'X-Admin-Key': adminKey });
    const teamId = createTeamRes.body.team.id;

    const createKeyRes = await request('POST', '/keys', { name: 'rem-key', credits: 100 }, { 'X-Admin-Key': adminKey });
    const key = createKeyRes.body.key;

    await request('POST', '/teams/assign', { teamId, key }, { 'X-Admin-Key': adminKey });
    const res = await request('POST', '/teams/remove', { teamId, key }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
  });

  it('POST /teams/delete should deactivate team', async () => {
    const createRes = await request('POST', '/teams', { name: 'ToDelete' }, { 'X-Admin-Key': adminKey });
    const teamId = createRes.body.team.id;

    const res = await request('POST', '/teams/delete', { teamId }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);

    // Should not appear in list
    const listRes = await request('GET', '/teams', undefined, { 'X-Admin-Key': adminKey });
    const ids = listRes.body.teams.map((t: any) => t.id);
    expect(ids).not.toContain(teamId);
  });

  it('GET /teams/usage should return team usage summary', async () => {
    const createTeamRes = await request('POST', '/teams', { name: 'UsageTest', budget: 1000 }, { 'X-Admin-Key': adminKey });
    const teamId = createTeamRes.body.team.id;

    const createKeyRes = await request('POST', '/keys', { name: 'usage-key', credits: 500 }, { 'X-Admin-Key': adminKey });
    const key = createKeyRes.body.key;

    await request('POST', '/teams/assign', { teamId, key }, { 'X-Admin-Key': adminKey });

    const res = await request('GET', `/teams/usage?teamId=${teamId}`, undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.teamName).toBe('UsageTest');
    expect(res.body.totalBudget).toBe(1000);
    expect(res.body.memberCount).toBe(1);
  });

  it('GET /teams/usage should 400 without teamId', async () => {
    const res = await request('GET', '/teams/usage', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
  });

  it('root endpoint should list team endpoints', async () => {
    const res = await request('GET', '/', undefined, {});
    expect(res.status).toBe(200);
    expect(res.body.endpoints.teams).toBeDefined();
  });
});
