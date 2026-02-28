/**
 * v10.1.0 Feature Tests
 *
 * Tests for Quota Management, Webhook Replay, and Config Profiles.
 * Unit tests for each module + integration tests via HTTP API.
 */

import { QuotaManager } from '../src/quota-manager';
import { WebhookReplayManager } from '../src/webhook-replay';
import { ConfigProfileManager } from '../src/config-profiles';
import { PayGateServer } from '../src/server';
import * as http from 'http';

// ─── QuotaManager Unit Tests ─────────────────────────────────────────────

describe('QuotaManager', () => {
  let qm: QuotaManager;

  beforeEach(() => {
    qm = new QuotaManager({ enabled: true });
  });

  it('should create and retrieve a quota rule', () => {
    const rule = qm.createRule({
      apiKey: 'key-1',
      period: 'daily',
      metric: 'calls',
      limit: 100,
    });
    expect(rule.id).toMatch(/^qr_/);
    expect(rule.apiKey).toBe('key-1');
    expect(rule.period).toBe('daily');
    expect(rule.metric).toBe('calls');
    expect(rule.limit).toBe(100);
    expect(rule.overageAction).toBe('deny');

    const retrieved = qm.getRule(rule.id);
    expect(retrieved).toBeTruthy();
    expect(retrieved!.id).toBe(rule.id);
  });

  it('should list rules filtered by apiKey', () => {
    qm.createRule({ apiKey: 'key-1', period: 'daily', metric: 'calls', limit: 100 });
    qm.createRule({ apiKey: 'key-2', period: 'daily', metric: 'calls', limit: 200 });
    qm.createRule({ apiKey: '*', period: 'monthly', metric: 'credits', limit: 5000 });

    const forKey1 = qm.listRules('key-1');
    expect(forKey1.length).toBe(2); // key-1 specific + global '*'

    const forKey2 = qm.listRules('key-2');
    expect(forKey2.length).toBe(2); // key-2 specific + global '*'
  });

  it('should allow requests within quota', () => {
    qm.createRule({ apiKey: 'key-1', period: 'daily', metric: 'calls', limit: 10 });

    const result = qm.check('key-1', 1);
    expect(result.allowed).toBe(true);
    expect(result.inBurst).toBe(false);
  });

  it('should deny requests exceeding quota', () => {
    qm.createRule({ apiKey: 'key-1', period: 'daily', metric: 'calls', limit: 3 });

    qm.check('key-1', 1); // 1/3
    qm.check('key-1', 1); // 2/3
    qm.check('key-1', 1); // 3/3
    const result = qm.check('key-1', 1); // 4/3 → denied

    expect(result.allowed).toBe(false);
    expect(result.action).toBe('deny');
    expect(result.reason).toContain('quota exceeded');
  });

  it('should allow burst within burst percentage', () => {
    qm.createRule({
      apiKey: 'key-1',
      period: 'daily',
      metric: 'calls',
      limit: 10,
      burstPercent: 20, // Allow up to 12
    });

    // Use 10 calls
    for (let i = 0; i < 10; i++) qm.check('key-1', 1);

    // 11th call → in burst zone
    const result = qm.check('key-1', 1);
    expect(result.allowed).toBe(true);
    expect(result.inBurst).toBe(true);
  });

  it('should support warn overage action', () => {
    qm.createRule({
      apiKey: 'key-1',
      period: 'daily',
      metric: 'calls',
      limit: 2,
      overageAction: 'warn',
    });

    qm.check('key-1', 1);
    qm.check('key-1', 1);
    const result = qm.check('key-1', 1); // over limit

    // warn action still allows the request
    expect(result.allowed).toBe(true);
    expect(result.action).toBe('warn');
  });

  it('should track tool-specific quotas', () => {
    qm.createRule({
      apiKey: 'key-1',
      tool: 'expensive-tool',
      period: 'daily',
      metric: 'calls',
      limit: 5,
    });

    // Calls to other tools should not be counted
    const result1 = qm.check('key-1', 1, 'cheap-tool');
    expect(result1.allowed).toBe(true);

    // Calls to the specified tool should be counted
    for (let i = 0; i < 5; i++) qm.check('key-1', 1, 'expensive-tool');
    const result2 = qm.check('key-1', 1, 'expensive-tool');
    expect(result2.allowed).toBe(false);
  });

  it('should update rules', () => {
    const rule = qm.createRule({ apiKey: 'key-1', period: 'daily', metric: 'calls', limit: 10 });
    const updated = qm.updateRule(rule.id, { limit: 20, overageAction: 'warn' });

    expect(updated).toBeTruthy();
    expect(updated!.limit).toBe(20);
    expect(updated!.overageAction).toBe('warn');
  });

  it('should delete rules', () => {
    const rule = qm.createRule({ apiKey: 'key-1', period: 'daily', metric: 'calls', limit: 10 });
    expect(qm.deleteRule(rule.id)).toBe(true);
    expect(qm.getRule(rule.id)).toBeUndefined();
  });

  it('should get usage for a key', () => {
    qm.createRule({ apiKey: 'key-1', period: 'daily', metric: 'calls', limit: 100 });
    qm.check('key-1', 5);

    const usage = qm.getUsage('key-1');
    expect(usage.length).toBeGreaterThan(0);
    expect(usage[0].used).toBe(5);
    expect(usage[0].limit).toBe(100);
  });

  it('should reset usage for a rule', () => {
    const rule = qm.createRule({ apiKey: 'key-1', period: 'daily', metric: 'calls', limit: 100 });
    qm.check('key-1', 10);

    expect(qm.resetUsage(rule.id)).toBe(true);

    const usage = qm.getUsage('key-1');
    expect(usage[0].used).toBe(0);
  });

  it('should report accurate stats', () => {
    qm.createRule({ apiKey: 'key-1', period: 'daily', metric: 'calls', limit: 2 });
    qm.check('key-1', 1);
    qm.check('key-1', 1);
    qm.check('key-1', 1); // denied

    const stats = qm.stats();
    expect(stats.totalRules).toBe(1);
    expect(stats.activeRules).toBe(1);
    expect(stats.totalChecks).toBe(3);
    expect(stats.totalDenied).toBe(1);
  });

  it('should pass through when disabled', () => {
    const disabled = new QuotaManager({ enabled: false });
    disabled.createRule({ apiKey: 'key-1', period: 'daily', metric: 'calls', limit: 1 });

    const result = disabled.check('key-1', 100);
    expect(result.allowed).toBe(true);
  });

  it('should clear all state', () => {
    qm.createRule({ apiKey: 'key-1', period: 'daily', metric: 'calls', limit: 10 });
    qm.check('key-1', 1);

    qm.clear();
    const stats = qm.stats();
    expect(stats.totalRules).toBe(0);
    expect(stats.totalChecks).toBe(0);
  });
});

// ─── WebhookReplayManager Unit Tests ─────────────────────────────────────

describe('WebhookReplayManager', () => {
  let wrm: WebhookReplayManager;

  beforeEach(() => {
    wrm = new WebhookReplayManager({ enabled: true });
  });

  it('should record a failed delivery', () => {
    const entry = wrm.recordFailure({
      url: 'https://example.com/webhook',
      payload: '{"event":"test"}',
      eventType: 'tool.call',
      statusCode: 500,
      errorMessage: 'Internal Server Error',
    });

    expect(entry.id).toMatch(/^dlq_/);
    expect(entry.status).toBe('pending');
    expect(entry.retryCount).toBe(0);
    expect(entry.url).toBe('https://example.com/webhook');
  });

  it('should retrieve a delivery by id', () => {
    const entry = wrm.recordFailure({
      url: 'https://example.com/webhook',
      payload: '{}',
      eventType: 'test',
      statusCode: 502,
      errorMessage: 'Bad Gateway',
    });

    const retrieved = wrm.getDelivery(entry.id);
    expect(retrieved).toBeTruthy();
    expect(retrieved!.id).toBe(entry.id);
    expect(retrieved!.statusCode).toBe(502);
  });

  it('should list dead letters with status filter', () => {
    wrm.recordFailure({ url: 'https://a.com', payload: '{}', eventType: 'a', statusCode: 500, errorMessage: 'err' });
    wrm.recordFailure({ url: 'https://b.com', payload: '{}', eventType: 'b', statusCode: 503, errorMessage: 'err' });

    const all = wrm.listDeadLetters();
    expect(all.length).toBe(2);

    const pending = wrm.listDeadLetters({ status: 'pending' });
    expect(pending.length).toBe(2);

    const succeeded = wrm.listDeadLetters({ status: 'succeeded' });
    expect(succeeded.length).toBe(0);
  });

  it('should filter by event type', () => {
    wrm.recordFailure({ url: 'https://a.com', payload: '{}', eventType: 'tool.call', statusCode: 500, errorMessage: 'err' });
    wrm.recordFailure({ url: 'https://b.com', payload: '{}', eventType: 'key.created', statusCode: 500, errorMessage: 'err' });

    const toolCalls = wrm.listDeadLetters({ eventType: 'tool.call' });
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].eventType).toBe('tool.call');
  });

  it('should purge a single entry', () => {
    const entry = wrm.recordFailure({ url: 'https://a.com', payload: '{}', eventType: 'a', statusCode: 500, errorMessage: 'err' });
    expect(wrm.purge(entry.id)).toBe(true);
    expect(wrm.getDelivery(entry.id)).toBeUndefined();
  });

  it('should purge by status', () => {
    wrm.recordFailure({ url: 'https://a.com', payload: '{}', eventType: 'a', statusCode: 500, errorMessage: 'err' });
    wrm.recordFailure({ url: 'https://b.com', payload: '{}', eventType: 'b', statusCode: 500, errorMessage: 'err' });

    const count = wrm.purgeByStatus('pending');
    expect(count).toBe(2);
    expect(wrm.listDeadLetters().length).toBe(0);
  });

  it('should report accurate stats', () => {
    wrm.recordFailure({ url: 'https://a.com', payload: '{}', eventType: 'a', statusCode: 500, errorMessage: 'err' });
    wrm.recordFailure({ url: 'https://b.com', payload: '{}', eventType: 'b', statusCode: 503, errorMessage: 'err' });

    const stats = wrm.stats();
    expect(stats.totalFailed).toBe(2);
    expect(stats.pendingRetry).toBe(2);
    expect(stats.succeeded).toBe(0);
    expect(stats.exhausted).toBe(0);
  });

  it('should clear all state', () => {
    wrm.recordFailure({ url: 'https://a.com', payload: '{}', eventType: 'a', statusCode: 500, errorMessage: 'err' });
    wrm.clear();

    const stats = wrm.stats();
    expect(stats.totalFailed).toBe(0);
    expect(stats.totalRetries).toBe(0);
  });
});

// ─── ConfigProfileManager Unit Tests ─────────────────────────────────────

describe('ConfigProfileManager', () => {
  let cpm: ConfigProfileManager;

  beforeEach(() => {
    cpm = new ConfigProfileManager({ enabled: true });
  });

  it('should save and retrieve a profile', () => {
    const profile = cpm.saveProfile({
      name: 'production',
      config: { rateLimit: 100, credits: 1000 },
      description: 'Production settings',
    });

    expect(profile.id).toMatch(/^prof_/);
    expect(profile.name).toBe('production');
    expect(profile.checksum).toBeTruthy();

    const retrieved = cpm.getProfile(profile.id);
    expect(retrieved).toBeTruthy();
    expect(retrieved!.name).toBe('production');
  });

  it('should get profile by name', () => {
    cpm.saveProfile({ name: 'dev', config: { debug: true } });
    const found = cpm.getProfileByName('dev');
    expect(found).toBeTruthy();
    expect(found!.name).toBe('dev');
  });

  it('should update existing profile with same name', () => {
    cpm.saveProfile({ name: 'staging', config: { rateLimit: 50 } });
    const updated = cpm.saveProfile({ name: 'staging', config: { rateLimit: 100 } });

    expect(cpm.listProfiles().length).toBe(1);
    expect(updated.config).toEqual({ rateLimit: 100 });
  });

  it('should activate a profile', () => {
    const profile = cpm.saveProfile({ name: 'prod', config: { env: 'production' } });
    const resolved = cpm.activateProfile(profile.id);

    expect(resolved).toEqual({ env: 'production' });
    expect(cpm.getActive()?.name).toBe('prod');
  });

  it('should rollback to previous profile', () => {
    const p1 = cpm.saveProfile({ name: 'v1', config: { version: 1 } });
    const p2 = cpm.saveProfile({ name: 'v2', config: { version: 2 } });

    cpm.activateProfile(p1.id);
    cpm.activateProfile(p2.id);

    const rolled = cpm.rollback();
    expect(rolled).toEqual({ version: 1 });
    expect(cpm.getActive()?.name).toBe('v1');
  });

  it('should resolve config with inheritance', () => {
    const base = cpm.saveProfile({
      name: 'base',
      config: { rateLimit: 100, credits: 500, debug: false },
    });

    const prod = cpm.saveProfile({
      name: 'prod',
      config: { credits: 5000, debug: false },
      extendsProfile: base.id,
    });

    const resolved = cpm.resolveConfig(prod.id);
    expect(resolved).toEqual({
      rateLimit: 100,   // inherited from base
      credits: 5000,    // overridden
      debug: false,     // overridden
    });
  });

  it('should compare two profiles', () => {
    const p1 = cpm.saveProfile({ name: 'p1', config: { a: 1, b: 2, c: 3 } });
    const p2 = cpm.saveProfile({ name: 'p2', config: { a: 1, b: 99, d: 4 } });

    const diff = cpm.compare(p1.id, p2.id);
    expect(diff.unchanged).toContain('a');
    expect(diff.changed.length).toBe(1);
    expect(diff.changed[0].key).toBe('b');
    expect(diff.onlyInA).toContain('c');
    expect(diff.onlyInB).toContain('d');
  });

  it('should delete a profile', () => {
    const profile = cpm.saveProfile({ name: 'tmp', config: {} });
    expect(cpm.deleteProfile(profile.id)).toBe(true);
    expect(cpm.getProfile(profile.id)).toBeUndefined();
  });

  it('should export and import profiles', () => {
    cpm.saveProfile({ name: 'dev', config: { env: 'dev' } });
    cpm.saveProfile({ name: 'prod', config: { env: 'prod' } });

    const json = cpm.exportProfiles();
    const data = JSON.parse(json);
    expect(data.profiles.length).toBe(2);
    expect(data.version).toBe(1);

    // Import into fresh manager
    const cpm2 = new ConfigProfileManager({ enabled: true });
    const count = cpm2.importProfiles(json, 'replace');
    expect(count).toBe(2);
    expect(cpm2.listProfiles().length).toBe(2);
  });

  it('should track stats', () => {
    cpm.saveProfile({ name: 'a', config: {} });
    cpm.saveProfile({ name: 'b', config: {} });

    const stats = cpm.stats();
    expect(stats.totalProfiles).toBe(2);
    expect(stats.activeProfile).toBeNull();
    expect(stats.rollbackAvailable).toBe(false);
  });

  it('should clear all state', () => {
    cpm.saveProfile({ name: 'a', config: {} });
    cpm.clear();

    expect(cpm.stats().totalProfiles).toBe(0);
    expect(cpm.getActive()).toBeNull();
  });
});

// ─── Integration Tests via HTTP API ──────────────────────────────────────

const echoScript = `
const http = require('http');
const s = http.createServer((req, res) => {
  let b = '';
  req.on('data', c => b += c);
  req.on('end', () => {
    const rpc = JSON.parse(b);
    if (rpc.method === 'initialize') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } }));
    } else if (rpc.method === 'tools/list') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] } }));
    } else {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
    }
  });
});
s.listen(0, () => console.log('ECHO_PORT=' + s.address().port));
`;

function rq(port: number, method: string, path: string, body?: Record<string, unknown>, headers?: Record<string, string>): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const hdrs: Record<string, string> = { 'Content-Type': 'application/json', ...headers };
    if (data) hdrs['Content-Length'] = String(Buffer.byteLength(data));
    const r = http.request({ hostname: '127.0.0.1', port, path, method, headers: hdrs }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, data: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode!, data: buf }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

describe('v10.1.0 HTTP Integration', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeEach(async () => {
    server = new PayGateServer({
      serverCommand: process.execPath,
      serverArgs: ['-e', echoScript],
      port: 0,
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 999,
    } as any);
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
  });

  afterEach(async () => { await server.stop(); });

  // ─── Quota Management HTTP Tests ─────────────────────────────────────

  it('GET /admin/quota-rules returns stats and rules', async () => {
    const res = await rq(port, 'GET', '/admin/quota-rules', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('totalRules');
    expect(res.data).toHaveProperty('rules');
  });

  it('POST /admin/quota-rules creates a quota rule', async () => {
    const res = await rq(port, 'POST', '/admin/quota-rules', {
      apiKey: 'key-1', period: 'daily', metric: 'calls', limit: 100,
    }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(201);
    expect(res.data.id).toMatch(/^qr_/);
    expect(res.data.apiKey).toBe('key-1');
  });

  it('POST /admin/quota-rules checkQuota checks quota', async () => {
    const res = await rq(port, 'POST', '/admin/quota-rules', { checkQuota: 'key-1', amount: 1 }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('allowed');
  });

  it('POST /admin/quota-rules deleteRule deletes a rule', async () => {
    const create = await rq(port, 'POST', '/admin/quota-rules', {
      apiKey: 'key-del', period: 'monthly', metric: 'credits', limit: 5000,
    }, { 'X-Admin-Key': adminKey });
    const res = await rq(port, 'POST', '/admin/quota-rules', { deleteRule: create.data.id }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.data.deleted).toBe(true);
  });

  it('DELETE /admin/quota-rules clears state', async () => {
    const res = await rq(port, 'DELETE', '/admin/quota-rules', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.data.cleared).toBe(true);
  });

  // ─── Webhook Replay HTTP Tests ────────────────────────────────────────

  it('GET /admin/webhook-replay returns stats', async () => {
    const res = await rq(port, 'GET', '/admin/webhook-replay', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('totalFailed');
    expect(res.data).toHaveProperty('entries');
  });

  it('POST /admin/webhook-replay records a failure', async () => {
    const res = await rq(port, 'POST', '/admin/webhook-replay', {
      recordFailure: true, url: 'https://example.com/hook', payload: '{"e":"test"}',
      eventType: 'tool.call', statusCode: 500, errorMessage: 'Server Error',
    }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(201);
    expect(res.data.id).toMatch(/^dlq_/);
  });

  it('POST /admin/webhook-replay purges an entry', async () => {
    const create = await rq(port, 'POST', '/admin/webhook-replay', {
      recordFailure: true, url: 'https://example.com/hook', payload: '{}',
      eventType: 'test', statusCode: 503, errorMessage: 'err',
    }, { 'X-Admin-Key': adminKey });
    const res = await rq(port, 'POST', '/admin/webhook-replay', { purge: create.data.id }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.data.purged).toBe(true);
  });

  it('DELETE /admin/webhook-replay clears state', async () => {
    const res = await rq(port, 'DELETE', '/admin/webhook-replay', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.data.cleared).toBe(true);
  });

  // ─── Config Profiles HTTP Tests ────────────────────────────────────────

  it('GET /admin/config-profiles returns stats', async () => {
    const res = await rq(port, 'GET', '/admin/config-profiles', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('totalProfiles');
    expect(res.data).toHaveProperty('profiles');
  });

  it('POST /admin/config-profiles saves a profile', async () => {
    const res = await rq(port, 'POST', '/admin/config-profiles', {
      name: 'test-profile', config: { rateLimit: 100, credits: 500 }, description: 'Test profile',
    }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(201);
    expect(res.data.name).toBe('test-profile');
    expect(res.data.checksum).toBeTruthy();
  });

  it('POST /admin/config-profiles activates a profile', async () => {
    const create = await rq(port, 'POST', '/admin/config-profiles', {
      name: 'activate-test', config: { env: 'test' },
    }, { 'X-Admin-Key': adminKey });
    const res = await rq(port, 'POST', '/admin/config-profiles', { activate: create.data.id }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.data.activated).toBe(create.data.id);
    expect(res.data.resolvedConfig).toEqual({ env: 'test' });
  });

  it('POST /admin/config-profiles compares two profiles', async () => {
    const p1 = await rq(port, 'POST', '/admin/config-profiles', { name: 'cmp-a', config: { a: 1, b: 2 } }, { 'X-Admin-Key': adminKey });
    const p2 = await rq(port, 'POST', '/admin/config-profiles', { name: 'cmp-b', config: { a: 1, c: 3 } }, { 'X-Admin-Key': adminKey });
    const res = await rq(port, 'POST', '/admin/config-profiles', { compare: [p1.data.id, p2.data.id] }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.data.unchanged).toContain('a');
    expect(res.data.onlyInA).toContain('b');
    expect(res.data.onlyInB).toContain('c');
  });

  it('POST /admin/config-profiles deletes a profile', async () => {
    const create = await rq(port, 'POST', '/admin/config-profiles', { name: 'del-me', config: {} }, { 'X-Admin-Key': adminKey });
    const res = await rq(port, 'POST', '/admin/config-profiles', { deleteProfile: create.data.id }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.data.deleted).toBe(true);
  });

  it('GET /admin/config-profiles?action=export exports profiles', async () => {
    const res = await rq(port, 'GET', '/admin/config-profiles?action=export', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('profiles');
    expect(res.data).toHaveProperty('version');
  });

  it('DELETE /admin/config-profiles clears state', async () => {
    const res = await rq(port, 'DELETE', '/admin/config-profiles', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.data.cleared).toBe(true);
  });

  // ─── Root listing ──────────────────────────────────────────────────────

  it('root listing includes v10.1.0 endpoints', async () => {
    const res = await rq(port, 'GET', '/');
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.data);
    expect(body).toContain('adminQuotaRules');
    expect(body).toContain('adminWebhookReplay');
    expect(body).toContain('adminConfigProfiles');
  });
});
