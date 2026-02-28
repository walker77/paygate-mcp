/**
 * v10.2.0 Tests — Scheduled Reports, Approval Workflows, Gateway Hooks
 */

import { ScheduledReportManager } from '../src/scheduled-reports';
import { ApprovalWorkflowManager } from '../src/approval-workflows';
import { GatewayHookManager } from '../src/gateway-hooks';
import { PayGateServer } from '../src/server';
import * as http from 'http';

/* ================================================================== */
/*  Unit Tests — ScheduledReportManager                                */
/* ================================================================== */

describe('ScheduledReportManager', () => {
  let mgr: ScheduledReportManager;

  beforeEach(() => {
    mgr = new ScheduledReportManager();
    mgr.configure({ enabled: true });
  });

  it('creates and retrieves a schedule', () => {
    const s = mgr.createSchedule({
      name: 'daily-usage',
      type: 'usage',
      frequency: 'daily',
      webhookUrl: 'https://example.com/reports',
    });
    expect(s.id).toMatch(/^rpt_/);
    expect(s.name).toBe('daily-usage');
    expect(s.type).toBe('usage');
    expect(s.frequency).toBe('daily');
    expect(s.enabled).toBe(true);

    const fetched = mgr.getSchedule(s.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe('daily-usage');
  });

  it('retrieves schedule by name', () => {
    mgr.createSchedule({ name: 'weekly-billing', type: 'billing', frequency: 'weekly', webhookUrl: 'https://example.com/r' });
    const found = mgr.getScheduleByName('weekly-billing');
    expect(found).toBeDefined();
    expect(found!.type).toBe('billing');
  });

  it('lists schedules with filters', () => {
    mgr.createSchedule({ name: 's1', type: 'usage', frequency: 'daily', webhookUrl: 'https://a.com' });
    mgr.createSchedule({ name: 's2', type: 'billing', frequency: 'weekly', webhookUrl: 'https://b.com' });
    mgr.createSchedule({ name: 's3', type: 'usage', frequency: 'monthly', webhookUrl: 'https://c.com' });

    expect(mgr.listSchedules({ type: 'usage' })).toHaveLength(2);
    expect(mgr.listSchedules({ frequency: 'weekly' })).toHaveLength(1);
    expect(mgr.listSchedules()).toHaveLength(3);
  });

  it('updates a schedule', () => {
    const s = mgr.createSchedule({ name: 'orig', type: 'usage', frequency: 'daily', webhookUrl: 'https://a.com' });
    mgr.updateSchedule(s.id, { name: 'updated', enabled: false });
    const fetched = mgr.getSchedule(s.id)!;
    expect(fetched.name).toBe('updated');
    expect(fetched.enabled).toBe(false);
  });

  it('deletes a schedule', () => {
    const s = mgr.createSchedule({ name: 'delete-me', type: 'usage', frequency: 'daily', webhookUrl: 'https://a.com' });
    expect(mgr.deleteSchedule(s.id)).toBe(true);
    expect(mgr.getSchedule(s.id)).toBeUndefined();
  });

  it('generates a report', () => {
    const s = mgr.createSchedule({ name: 'gen-test', type: 'compliance', frequency: 'monthly', webhookUrl: 'https://a.com' });
    const report = mgr.generateReport(s.id);
    expect(report.id).toMatch(/^rr_/);
    expect(report.scheduleId).toBe(s.id);
    expect(report.type).toBe('compliance');
    expect(report.data.summary).toBeDefined();

    const updated = mgr.getSchedule(s.id)!;
    expect(updated.runCount).toBe(1);
    expect(updated.lastRunStatus).toBe('success');
  });

  it('marks run as failed', () => {
    const s = mgr.createSchedule({ name: 'fail-test', type: 'usage', frequency: 'daily', webhookUrl: 'https://a.com' });
    mgr.markRunFailed(s.id);
    const updated = mgr.getSchedule(s.id)!;
    expect(updated.runCount).toBe(1);
    expect(updated.lastRunStatus).toBe('failed');
  });

  it('enforces duplicate name uniqueness', () => {
    mgr.createSchedule({ name: 'unique', type: 'usage', frequency: 'daily', webhookUrl: 'https://a.com' });
    expect(() => mgr.createSchedule({ name: 'unique', type: 'billing', frequency: 'weekly', webhookUrl: 'https://b.com' }))
      .toThrow('already exists');
  });

  it('provides stats', () => {
    mgr.createSchedule({ name: 's1', type: 'usage', frequency: 'daily', webhookUrl: 'https://a.com' });
    mgr.createSchedule({ name: 's2', type: 'billing', frequency: 'weekly', webhookUrl: 'https://b.com', enabled: false });
    const stats = mgr.stats();
    expect(stats.totalSchedules).toBe(2);
    expect(stats.enabledSchedules).toBe(1);
    expect(stats.disabledSchedules).toBe(1);
    expect(stats.byType.usage).toBe(1);
    expect(stats.byType.billing).toBe(1);
    expect(stats.byFrequency.daily).toBe(1);
    expect(stats.byFrequency.weekly).toBe(1);
  });

  it('clears all schedules', () => {
    mgr.createSchedule({ name: 'a', type: 'usage', frequency: 'daily', webhookUrl: 'https://a.com' });
    mgr.clear();
    expect(mgr.listSchedules()).toHaveLength(0);
  });
});

/* ================================================================== */
/*  Unit Tests — ApprovalWorkflowManager                               */
/* ================================================================== */

describe('ApprovalWorkflowManager', () => {
  let mgr: ApprovalWorkflowManager;

  beforeEach(() => {
    mgr = new ApprovalWorkflowManager();
    mgr.configure({ enabled: true });
  });

  it('creates and retrieves a rule', () => {
    const r = mgr.createRule({ name: 'high-cost', condition: 'cost_threshold', threshold: 100 });
    expect(r.id).toMatch(/^ar_/);
    expect(r.condition).toBe('cost_threshold');
    expect(r.threshold).toBe(100);

    const fetched = mgr.getRule(r.id);
    expect(fetched).toBeDefined();
  });

  it('checks cost threshold and creates pending request', () => {
    mgr.createRule({ name: 'cost-gate', condition: 'cost_threshold', threshold: 50 });
    const result = mgr.check('pg_test_key', 'my-tool', 100);
    expect(result.requiresApproval).toBe(true);
    expect(result.matchedRules).toHaveLength(1);
    expect(result.requestId).toMatch(/^areq_/);
  });

  it('allows calls below threshold', () => {
    mgr.createRule({ name: 'cost-gate', condition: 'cost_threshold', threshold: 50 });
    const result = mgr.check('pg_test_key', 'my-tool', 10);
    expect(result.requiresApproval).toBe(false);
    expect(result.matchedRules).toHaveLength(0);
  });

  it('checks tool match condition', () => {
    mgr.createRule({ name: 'tool-gate', condition: 'tool_match', toolPattern: 'dangerous-*' });
    const result = mgr.check('pg_test_key', 'dangerous-delete', 1);
    expect(result.requiresApproval).toBe(true);
  });

  it('checks key match condition', () => {
    mgr.createRule({ name: 'key-gate', condition: 'key_match', keyPrefix: 'pg_trial_' });
    const result = mgr.check('pg_trial_abc123', 'my-tool', 1);
    expect(result.requiresApproval).toBe(true);

    const result2 = mgr.check('pg_paid_xyz', 'my-tool', 1);
    expect(result2.requiresApproval).toBe(false);
  });

  it('approves a pending request', () => {
    mgr.createRule({ name: 'gate', condition: 'cost_threshold', threshold: 10 });
    const check = mgr.check('pg_key', 'tool', 50);
    const decided = mgr.decide({ requestId: check.requestId!, status: 'approved', decidedBy: 'admin' });
    expect(decided.status).toBe('approved');
    expect(decided.decidedBy).toBe('admin');
  });

  it('denies a pending request', () => {
    mgr.createRule({ name: 'gate', condition: 'cost_threshold', threshold: 10 });
    const check = mgr.check('pg_key', 'tool', 50);
    const decided = mgr.decide({ requestId: check.requestId!, status: 'denied', reason: 'too expensive' });
    expect(decided.status).toBe('denied');
    expect(decided.reason).toBe('too expensive');
  });

  it('lists requests by status', () => {
    mgr.createRule({ name: 'gate', condition: 'cost_threshold', threshold: 1 });
    mgr.check('pg_a', 'tool', 10);
    mgr.check('pg_b', 'tool', 10);
    const pending = mgr.listRequests({ status: 'pending' });
    expect(pending).toHaveLength(2);
  });

  it('expires pending requests', () => {
    mgr.configure({ defaultExpiryMs: 1 }); // 1ms expiry
    mgr.createRule({ name: 'gate', condition: 'cost_threshold', threshold: 1 });
    mgr.check('pg_key', 'tool', 10);

    // Wait for expiry
    const start = Date.now();
    while (Date.now() - start < 10) { /* spin */ }

    const count = mgr.expirePending();
    expect(count).toBe(1);
    expect(mgr.listRequests({ status: 'expired' })).toHaveLength(1);
  });

  it('updates a rule', () => {
    const r = mgr.createRule({ name: 'gate', condition: 'cost_threshold', threshold: 50 });
    mgr.updateRule(r.id, { threshold: 200 });
    expect(mgr.getRule(r.id)!.threshold).toBe(200);
  });

  it('deletes a rule', () => {
    const r = mgr.createRule({ name: 'delete-me', condition: 'cost_threshold', threshold: 50 });
    expect(mgr.deleteRule(r.id)).toBe(true);
    expect(mgr.getRule(r.id)).toBeUndefined();
  });

  it('provides stats', () => {
    mgr.createRule({ name: 'r1', condition: 'cost_threshold', threshold: 10 });
    mgr.createRule({ name: 'r2', condition: 'tool_match', toolPattern: '*' });
    mgr.check('pg_key', 'tool', 50);
    const stats = mgr.stats();
    expect(stats.totalRules).toBe(2);
    expect(stats.totalRequests).toBe(1);
    expect(stats.byCondition.cost_threshold).toBe(1);
    expect(stats.byCondition.tool_match).toBe(1);
  });

  it('disabled manager passes all checks', () => {
    mgr.configure({ enabled: false });
    mgr.configure({ enabled: true });
    mgr.createRule({ name: 'gate', condition: 'cost_threshold', threshold: 1 });
    mgr.configure({ enabled: false });
    const result = mgr.check('pg_key', 'tool', 1000);
    expect(result.requiresApproval).toBe(false);
  });

  it('clears all state', () => {
    mgr.createRule({ name: 'r', condition: 'cost_threshold', threshold: 10 });
    mgr.check('pg_key', 'tool', 50);
    mgr.clear();
    expect(mgr.listRules()).toHaveLength(0);
    expect(mgr.listRequests()).toHaveLength(0);
  });
});

/* ================================================================== */
/*  Unit Tests — GatewayHookManager                                    */
/* ================================================================== */

describe('GatewayHookManager', () => {
  let mgr: GatewayHookManager;

  beforeEach(() => {
    mgr = new GatewayHookManager();
    mgr.configure({ enabled: true });
  });

  it('registers and retrieves a hook', () => {
    const h = mgr.registerHook({
      name: 'log-hook',
      stage: 'pre_gate',
      type: 'log',
      config: { message: 'Request received' },
    });
    expect(h.id).toMatch(/^ghk_/);
    expect(h.name).toBe('log-hook');
    expect(h.stage).toBe('pre_gate');

    const fetched = mgr.getHook(h.id);
    expect(fetched).toBeDefined();
  });

  it('lists hooks by stage', () => {
    mgr.registerHook({ name: 'h1', stage: 'pre_gate', type: 'log', config: {} });
    mgr.registerHook({ name: 'h2', stage: 'post_backend', type: 'log', config: {} });
    mgr.registerHook({ name: 'h3', stage: 'pre_gate', type: 'header_inject', config: {} });

    expect(mgr.listHooks({ stage: 'pre_gate' })).toHaveLength(2);
    expect(mgr.listHooks({ stage: 'post_backend' })).toHaveLength(1);
  });

  it('executes log hook', () => {
    mgr.registerHook({ name: 'logger', stage: 'pre_gate', type: 'log', config: { message: 'hello' } });
    const result = mgr.executeStage('pre_gate', {
      apiKey: 'pg_test', tool: 'my-tool', timestamp: new Date().toISOString(),
    });
    expect(result.action).toBe('continue');
    expect(result.hookResults).toHaveLength(1);
    expect(result.hookResults[0].metadata?.message).toBe('hello');
  });

  it('executes header_inject hook', () => {
    mgr.registerHook({ name: 'headers', stage: 'pre_backend', type: 'header_inject', config: { headers: { 'X-Custom': 'value' } } });
    const result = mgr.executeStage('pre_backend', {
      apiKey: 'pg_test', tool: 'my-tool', timestamp: new Date().toISOString(),
    });
    expect(result.hookResults[0].headers).toEqual({ 'X-Custom': 'value' });
  });

  it('executes metadata_tag hook', () => {
    mgr.registerHook({ name: 'tagger', stage: 'pre_gate', type: 'metadata_tag', config: { tags: { env: 'prod' } } });
    const result = mgr.executeStage('pre_gate', {
      apiKey: 'pg_test', tool: 'my-tool', timestamp: new Date().toISOString(),
    });
    expect(result.hookResults[0].metadata).toEqual({ env: 'prod' });
  });

  it('executes reject hook and stops pipeline', () => {
    mgr.registerHook({ name: 'blocker', stage: 'pre_gate', type: 'reject', priority: 1, config: { rejectMessage: 'blocked', rejectCode: -32600 } });
    mgr.registerHook({ name: 'logger', stage: 'pre_gate', type: 'log', priority: 2, config: {} });
    const result = mgr.executeStage('pre_gate', {
      apiKey: 'pg_test', tool: 'my-tool', timestamp: new Date().toISOString(),
    });
    expect(result.action).toBe('reject');
    expect(result.hookResults).toHaveLength(1); // Second hook not reached
    expect(result.hookResults[0].rejectMessage).toBe('blocked');
  });

  it('filters hooks by tool pattern', () => {
    mgr.registerHook({ name: 'specific', stage: 'pre_gate', type: 'log', config: {}, toolFilter: 'admin-*' });
    const result1 = mgr.executeStage('pre_gate', { apiKey: 'pg_test', tool: 'admin-delete', timestamp: new Date().toISOString() });
    expect(result1.hookResults).toHaveLength(1);

    const result2 = mgr.executeStage('pre_gate', { apiKey: 'pg_test', tool: 'user-list', timestamp: new Date().toISOString() });
    expect(result2.hookResults).toHaveLength(0);
  });

  it('filters hooks by key prefix', () => {
    mgr.registerHook({ name: 'trial-only', stage: 'pre_gate', type: 'log', config: {}, keyFilter: 'pg_trial_*' });
    const result = mgr.executeStage('pre_gate', { apiKey: 'pg_trial_abc', tool: 'tool', timestamp: new Date().toISOString() });
    expect(result.hookResults).toHaveLength(1);

    const result2 = mgr.executeStage('pre_gate', { apiKey: 'pg_paid_xyz', tool: 'tool', timestamp: new Date().toISOString() });
    expect(result2.hookResults).toHaveLength(0);
  });

  it('updates a hook', () => {
    const h = mgr.registerHook({ name: 'orig', stage: 'pre_gate', type: 'log', config: {} });
    mgr.updateHook(h.id, { name: 'updated', priority: 50 });
    const fetched = mgr.getHook(h.id)!;
    expect(fetched.name).toBe('updated');
    expect(fetched.priority).toBe(50);
  });

  it('deletes a hook', () => {
    const h = mgr.registerHook({ name: 'delete-me', stage: 'pre_gate', type: 'log', config: {} });
    expect(mgr.deleteHook(h.id)).toBe(true);
    expect(mgr.getHook(h.id)).toBeUndefined();
  });

  it('tracks execution count', () => {
    const h = mgr.registerHook({ name: 'counter', stage: 'pre_gate', type: 'log', config: {} });
    mgr.executeStage('pre_gate', { apiKey: 'pg_test', tool: 'tool', timestamp: new Date().toISOString() });
    mgr.executeStage('pre_gate', { apiKey: 'pg_test', tool: 'tool', timestamp: new Date().toISOString() });
    expect(mgr.getHook(h.id)!.executionCount).toBe(2);
  });

  it('disabled manager returns continue', () => {
    mgr.registerHook({ name: 'h', stage: 'pre_gate', type: 'reject', config: { rejectMessage: 'no' } });
    mgr.configure({ enabled: false });
    const result = mgr.executeStage('pre_gate', { apiKey: 'pg_test', tool: 'tool', timestamp: new Date().toISOString() });
    expect(result.action).toBe('continue');
    expect(result.hookResults).toHaveLength(0);
  });

  it('provides stats', () => {
    mgr.registerHook({ name: 'h1', stage: 'pre_gate', type: 'log', config: {} });
    mgr.registerHook({ name: 'h2', stage: 'post_backend', type: 'reject', config: {} });
    const stats = mgr.stats();
    expect(stats.totalHooks).toBe(2);
    expect(stats.byStage.pre_gate).toBe(1);
    expect(stats.byStage.post_backend).toBe(1);
    expect(stats.byType.log).toBe(1);
    expect(stats.byType.reject).toBe(1);
  });

  it('clears all hooks', () => {
    mgr.registerHook({ name: 'h', stage: 'pre_gate', type: 'log', config: {} });
    mgr.clear();
    expect(mgr.listHooks()).toHaveLength(0);
  });
});

/* ================================================================== */
/*  Integration Tests                                                   */
/* ================================================================== */

const echoScript = `
const http = require('http');
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const rpc = JSON.parse(body);
    if (rpc.method === 'initialize') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '0.1.0' } } }));
    } else if (rpc.method === 'tools/list') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'echo', description: 'Echo tool', inputSchema: { type: 'object' } }] } }));
    } else if (rpc.method === 'tools/call') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
    } else {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {} }));
    }
  });
});
server.listen(0, () => console.log(JSON.stringify({ port: server.address().port })));
`;

function rq(port: number, path: string, method: string, adminKey: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: {
      'X-Admin-Key': adminKey, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data).toString() } : {}),
    } }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode!, body: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('Integration: /admin/scheduled-reports', () => {
  let server: InstanceType<typeof PayGateServer>;
  let port: number;
  let adminKey: string;

  beforeEach(async () => {
    server = new PayGateServer({
      serverCommand: process.execPath,
      serverArgs: ['-e', echoScript],
      port: 0,
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 600,
    } as any);
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterEach(async () => { await server.stop(); });

  it('configures scheduled reports', async () => {
    const res = await rq(port, '/admin/scheduled-reports', 'POST', adminKey, { action: 'configure', enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });

  it('creates a schedule', async () => {
    await rq(port, '/admin/scheduled-reports', 'POST', adminKey, { action: 'configure', enabled: true });
    const res = await rq(port, '/admin/scheduled-reports', 'POST', adminKey, {
      action: 'create', name: 'daily', type: 'usage', frequency: 'daily', webhookUrl: 'https://example.com/report',
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('daily');
  });

  it('generates a report', async () => {
    await rq(port, '/admin/scheduled-reports', 'POST', adminKey, { action: 'configure', enabled: true });
    const create = await rq(port, '/admin/scheduled-reports', 'POST', adminKey, {
      action: 'create', name: 'gen', type: 'billing', frequency: 'weekly', webhookUrl: 'https://example.com/r',
    });
    const res = await rq(port, '/admin/scheduled-reports', 'POST', adminKey, {
      action: 'generate', scheduleId: create.body.id,
    });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('billing');
    expect(res.body.data.summary).toBeDefined();
  });

  it('lists schedules via GET', async () => {
    await rq(port, '/admin/scheduled-reports', 'POST', adminKey, { action: 'configure', enabled: true });
    await rq(port, '/admin/scheduled-reports', 'POST', adminKey, {
      action: 'create', name: 's1', type: 'usage', frequency: 'daily', webhookUrl: 'https://a.com',
    });
    const res = await rq(port, '/admin/scheduled-reports', 'GET', adminKey);
    expect(res.status).toBe(200);
    expect(res.body.schedules.length).toBe(1);
    expect(res.body.stats.totalSchedules).toBe(1);
  });

  it('clears via DELETE', async () => {
    await rq(port, '/admin/scheduled-reports', 'POST', adminKey, { action: 'configure', enabled: true });
    await rq(port, '/admin/scheduled-reports', 'POST', adminKey, {
      action: 'create', name: 's1', type: 'usage', frequency: 'daily', webhookUrl: 'https://a.com',
    });
    const res = await rq(port, '/admin/scheduled-reports', 'DELETE', adminKey);
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(true);
  });
});

describe('Integration: /admin/approval-workflows', () => {
  let server: InstanceType<typeof PayGateServer>;
  let port: number;
  let adminKey: string;

  beforeEach(async () => {
    server = new PayGateServer({
      serverCommand: process.execPath,
      serverArgs: ['-e', echoScript],
      port: 0,
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 600,
    } as any);
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterEach(async () => { await server.stop(); });

  it('configures and creates a rule', async () => {
    await rq(port, '/admin/approval-workflows', 'POST', adminKey, { action: 'configure', enabled: true });
    const res = await rq(port, '/admin/approval-workflows', 'POST', adminKey, {
      action: 'createRule', name: 'high-cost', condition: 'cost_threshold', threshold: 50,
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('high-cost');
    expect(res.body.condition).toBe('cost_threshold');
  });

  it('checks approval requirement', async () => {
    await rq(port, '/admin/approval-workflows', 'POST', adminKey, { action: 'configure', enabled: true });
    await rq(port, '/admin/approval-workflows', 'POST', adminKey, {
      action: 'createRule', name: 'gate', condition: 'cost_threshold', threshold: 10,
    });
    const res = await rq(port, '/admin/approval-workflows', 'POST', adminKey, {
      action: 'check', apiKey: 'pg_test_key', tool: 'my-tool', creditCost: 50,
    });
    expect(res.status).toBe(200);
    expect(res.body.requiresApproval).toBe(true);
    expect(res.body.requestId).toMatch(/^areq_/);
  });

  it('decides (approves) a request', async () => {
    await rq(port, '/admin/approval-workflows', 'POST', adminKey, { action: 'configure', enabled: true });
    await rq(port, '/admin/approval-workflows', 'POST', adminKey, {
      action: 'createRule', name: 'gate', condition: 'cost_threshold', threshold: 10,
    });
    const check = await rq(port, '/admin/approval-workflows', 'POST', adminKey, {
      action: 'check', apiKey: 'pg_key', tool: 'tool', creditCost: 100,
    });
    const res = await rq(port, '/admin/approval-workflows', 'POST', adminKey, {
      action: 'decide', requestId: check.body.requestId, status: 'approved', decidedBy: 'admin',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
  });

  it('lists rules and requests via GET', async () => {
    await rq(port, '/admin/approval-workflows', 'POST', adminKey, { action: 'configure', enabled: true });
    await rq(port, '/admin/approval-workflows', 'POST', adminKey, {
      action: 'createRule', name: 'r1', condition: 'cost_threshold', threshold: 10,
    });
    const res = await rq(port, '/admin/approval-workflows', 'GET', adminKey);
    expect(res.status).toBe(200);
    expect(res.body.rules.length).toBe(1);
    expect(res.body.stats.totalRules).toBe(1);
  });

  it('clears via DELETE', async () => {
    const res = await rq(port, '/admin/approval-workflows', 'DELETE', adminKey);
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(true);
  });
});

describe('Integration: /admin/gateway-hooks', () => {
  let server: InstanceType<typeof PayGateServer>;
  let port: number;
  let adminKey: string;

  beforeEach(async () => {
    server = new PayGateServer({
      serverCommand: process.execPath,
      serverArgs: ['-e', echoScript],
      port: 0,
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 600,
    } as any);
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterEach(async () => { await server.stop(); });

  it('configures and registers a hook', async () => {
    await rq(port, '/admin/gateway-hooks', 'POST', adminKey, { action: 'configure', enabled: true });
    const res = await rq(port, '/admin/gateway-hooks', 'POST', adminKey, {
      action: 'register', name: 'my-hook', stage: 'pre_gate', type: 'log', config: { message: 'hi' },
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('my-hook');
    expect(res.body.stage).toBe('pre_gate');
  });

  it('tests hook execution', async () => {
    await rq(port, '/admin/gateway-hooks', 'POST', adminKey, { action: 'configure', enabled: true });
    await rq(port, '/admin/gateway-hooks', 'POST', adminKey, {
      action: 'register', name: 'logger', stage: 'pre_gate', type: 'log', config: { message: 'test-run' },
    });
    const res = await rq(port, '/admin/gateway-hooks', 'POST', adminKey, {
      action: 'test', stage: 'pre_gate', apiKey: 'pg_test', tool: 'my-tool',
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('continue');
    expect(res.body.hookResults.length).toBe(1);
    expect(res.body.hookResults[0].metadata.message).toBe('test-run');
  });

  it('tests reject hook execution', async () => {
    await rq(port, '/admin/gateway-hooks', 'POST', adminKey, { action: 'configure', enabled: true });
    await rq(port, '/admin/gateway-hooks', 'POST', adminKey, {
      action: 'register', name: 'blocker', stage: 'pre_gate', type: 'reject', config: { rejectMessage: 'nope' },
    });
    const res = await rq(port, '/admin/gateway-hooks', 'POST', adminKey, {
      action: 'test', stage: 'pre_gate', apiKey: 'pg_test', tool: 'my-tool',
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('reject');
  });

  it('lists hooks via GET', async () => {
    await rq(port, '/admin/gateway-hooks', 'POST', adminKey, { action: 'configure', enabled: true });
    await rq(port, '/admin/gateway-hooks', 'POST', adminKey, {
      action: 'register', name: 'h1', stage: 'pre_gate', type: 'log', config: {},
    });
    const res = await rq(port, '/admin/gateway-hooks', 'GET', adminKey);
    expect(res.status).toBe(200);
    expect(res.body.hooks.length).toBe(1);
    expect(res.body.stats.totalHooks).toBe(1);
  });

  it('gets hook by ID', async () => {
    await rq(port, '/admin/gateway-hooks', 'POST', adminKey, { action: 'configure', enabled: true });
    const create = await rq(port, '/admin/gateway-hooks', 'POST', adminKey, {
      action: 'register', name: 'fetch-me', stage: 'pre_backend', type: 'header_inject', config: { headers: { 'X-Env': 'test' } },
    });
    const res = await rq(port, `/admin/gateway-hooks?hookId=${create.body.id}`, 'GET', adminKey);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('fetch-me');
  });

  it('clears via DELETE', async () => {
    const res = await rq(port, '/admin/gateway-hooks', 'DELETE', adminKey);
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(true);
  });
});

describe('Integration: root listing includes v10.2.0 endpoints', () => {
  let server: InstanceType<typeof PayGateServer>;
  let port: number;
  let adminKey: string;

  beforeEach(async () => {
    server = new PayGateServer({
      serverCommand: process.execPath,
      serverArgs: ['-e', echoScript],
      port: 0,
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 600,
    } as any);
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterEach(async () => { await server.stop(); });

  it('lists v10.2.0 endpoints in root', async () => {
    const res = await rq(port, '/', 'GET', adminKey);
    expect(res.status).toBe(200);
    expect(res.body.endpoints.adminScheduledReports).toBeDefined();
    expect(res.body.endpoints.adminApprovalWorkflows).toBeDefined();
    expect(res.body.endpoints.adminGatewayHooks).toBeDefined();
  });
});
