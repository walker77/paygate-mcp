/**
 * v9.6.0 Feature Tests:
 *   1. Usage Plans (tiered key policies: free/pro/enterprise)
 *   2. Tool Input Schema Validation (per-tool JSON Schema at gateway)
 *   3. Canary Routing (weighted traffic splitting)
 */

import { UsagePlanManager } from '../src/usage-plans';
import { ToolSchemaValidator } from '../src/schema-validator';
import { CanaryRouter } from '../src/canary-router';
import { PayGateServer } from '../src/server';

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
          { name: 'premium', description: 'Premium tool', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
          { name: 'greet', description: 'Greet', inputSchema: { type: 'object', properties: { name: { type: 'string' }, age: { type: 'number' } }, required: ['name'] } },
        ] } }) + '\\n');
      } else if (req.method === 'tools/call') {
        const args = req.params?.arguments || {};
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: args.msg || args.q || args.name || 'ok' }] } }) + '\\n');
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
// 1. UsagePlanManager — Unit Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('UsagePlanManager', () => {
  let pm: UsagePlanManager;

  beforeEach(() => {
    pm = new UsagePlanManager();
  });

  test('createPlan: creates plan with defaults', () => {
    const plan = pm.createPlan({ name: 'free' });
    expect(plan.name).toBe('free');
    expect(plan.description).toBe('');
    expect(plan.rateLimitPerMin).toBe(0);
    expect(plan.dailyCallLimit).toBe(0);
    expect(plan.monthlyCallLimit).toBe(0);
    expect(plan.dailyCreditLimit).toBe(0);
    expect(plan.monthlyCreditLimit).toBe(0);
    expect(plan.creditMultiplier).toBe(1.0);
    expect(plan.allowedTools).toEqual([]);
    expect(plan.deniedTools).toEqual([]);
    expect(plan.maxConcurrent).toBe(0);
    expect(plan.createdAt).toBeTruthy();
    expect(plan.updatedAt).toBeTruthy();
  });

  test('createPlan: creates plan with custom values', () => {
    const plan = pm.createPlan({
      name: 'pro',
      description: 'Professional tier',
      rateLimitPerMin: 60,
      dailyCallLimit: 1000,
      monthlyCallLimit: 30000,
      dailyCreditLimit: 500,
      monthlyCreditLimit: 15000,
      creditMultiplier: 0.8,
      allowedTools: ['echo', 'premium'],
      deniedTools: [],
      maxConcurrent: 10,
    });
    expect(plan.name).toBe('pro');
    expect(plan.rateLimitPerMin).toBe(60);
    expect(plan.creditMultiplier).toBe(0.8);
    expect(plan.allowedTools).toEqual(['echo', 'premium']);
    expect(plan.maxConcurrent).toBe(10);
  });

  test('createPlan: rejects invalid plan name', () => {
    expect(() => pm.createPlan({ name: '' })).toThrow('Invalid plan name');
    expect(() => pm.createPlan({ name: 'has spaces' })).toThrow('Invalid plan name');
    expect(() => pm.createPlan({ name: 'a'.repeat(65) })).toThrow('Invalid plan name');
  });

  test('createPlan: rejects duplicate plan name', () => {
    pm.createPlan({ name: 'free' });
    expect(() => pm.createPlan({ name: 'free' })).toThrow('already exists');
  });

  test('createPlan: clamps negative credit multiplier to 0', () => {
    const plan = pm.createPlan({ name: 'neg', creditMultiplier: -1 });
    expect(plan.creditMultiplier).toBe(0);
  });

  test('updatePlan: partial update', () => {
    pm.createPlan({ name: 'free', rateLimitPerMin: 10 });
    const updated = pm.updatePlan('free', { rateLimitPerMin: 20, description: 'Updated' });
    expect(updated.rateLimitPerMin).toBe(20);
    expect(updated.description).toBe('Updated');
    expect(updated.name).toBe('free');
  });

  test('updatePlan: throws for unknown plan', () => {
    expect(() => pm.updatePlan('nope', { rateLimitPerMin: 10 })).toThrow('not found');
  });

  test('deletePlan: deletes unassigned plan', () => {
    pm.createPlan({ name: 'temp' });
    expect(pm.deletePlan('temp')).toBe(true);
    expect(pm.getPlan('temp')).toBeNull();
  });

  test('deletePlan: blocks if keys assigned', () => {
    pm.createPlan({ name: 'free' });
    pm.assignKey('key123', 'free');
    expect(() => pm.deletePlan('free')).toThrow('key(s) still assigned');
  });

  test('deletePlan: returns false for unknown plan', () => {
    expect(pm.deletePlan('nope')).toBe(false);
  });

  test('assignKey + getKeyPlan: round-trip', () => {
    pm.createPlan({ name: 'pro' });
    pm.assignKey('key1', 'pro');
    const plan = pm.getKeyPlan('key1');
    expect(plan!.name).toBe('pro');
    expect(pm.getKeyPlanName('key1')).toBe('pro');
  });

  test('assignKey: null unassigns', () => {
    pm.createPlan({ name: 'pro' });
    pm.assignKey('key1', 'pro');
    pm.assignKey('key1', null);
    expect(pm.getKeyPlan('key1')).toBeNull();
    expect(pm.getKeyPlanName('key1')).toBeNull();
  });

  test('assignKey: throws for unknown plan', () => {
    expect(() => pm.assignKey('key1', 'nope')).toThrow('not found');
  });

  test('getCreditMultiplier: returns plan multiplier', () => {
    pm.createPlan({ name: 'half', creditMultiplier: 0.5 });
    pm.assignKey('k1', 'half');
    expect(pm.getCreditMultiplier('k1')).toBe(0.5);
  });

  test('getCreditMultiplier: returns 1.0 for unassigned key', () => {
    expect(pm.getCreditMultiplier('no-key')).toBe(1.0);
  });

  test('isToolAllowedByPlan: no plan = all allowed', () => {
    const result = pm.isToolAllowedByPlan('unassigned', 'any-tool');
    expect(result.allowed).toBe(true);
  });

  test('isToolAllowedByPlan: denied tools take precedence', () => {
    pm.createPlan({ name: 'limited', deniedTools: ['premium'] });
    pm.assignKey('k1', 'limited');
    const result = pm.isToolAllowedByPlan('k1', 'premium');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('denied');
  });

  test('isToolAllowedByPlan: allowed tools whitelist', () => {
    pm.createPlan({ name: 'strict', allowedTools: ['echo'] });
    pm.assignKey('k1', 'strict');
    expect(pm.isToolAllowedByPlan('k1', 'echo').allowed).toBe(true);
    expect(pm.isToolAllowedByPlan('k1', 'premium').allowed).toBe(false);
  });

  test('stats: returns plan list with assigned key counts', () => {
    pm.createPlan({ name: 'free' });
    pm.createPlan({ name: 'pro' });
    pm.assignKey('k1', 'free');
    pm.assignKey('k2', 'free');
    pm.assignKey('k3', 'pro');
    const s = pm.stats();
    expect(s.totalPlans).toBe(2);
    const freePlan = s.plans.find(p => p.name === 'free');
    expect(freePlan!.assignedKeys).toBe(2);
    const proPlan = s.plans.find(p => p.name === 'pro');
    expect(proPlan!.assignedKeys).toBe(1);
  });

  test('exportPlans + importPlans: round-trip', () => {
    pm.createPlan({ name: 'free', rateLimitPerMin: 10 });
    pm.createPlan({ name: 'pro', rateLimitPerMin: 100 });
    pm.assignKey('k1', 'pro');
    const exported = pm.exportPlans();

    const pm2 = new UsagePlanManager();
    const imported = pm2.importPlans(exported);
    expect(imported).toBe(2);
    expect(pm2.getKeyPlanName('k1')).toBe('pro');
    expect(pm2.getPlan('free')!.rateLimitPerMin).toBe(10);
  });

  test('size: returns plan count', () => {
    expect(pm.size).toBe(0);
    pm.createPlan({ name: 'a' });
    pm.createPlan({ name: 'b' });
    expect(pm.size).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. ToolSchemaValidator — Unit Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('ToolSchemaValidator', () => {
  let sv: ToolSchemaValidator;

  beforeEach(() => {
    sv = new ToolSchemaValidator();
  });

  test('registerSchema: stores schema', () => {
    const s = sv.registerSchema('echo', { type: 'object', properties: { msg: { type: 'string' } } });
    expect(s.toolName).toBe('echo');
    expect(s.createdAt).toBeTruthy();
    expect(sv.size).toBe(1);
  });

  test('registerSchema: rejects invalid tool name', () => {
    expect(() => sv.registerSchema('', { type: 'object' })).toThrow('Invalid tool name');
    expect(() => sv.registerSchema('has spaces', { type: 'object' })).toThrow('Invalid tool name');
  });

  test('registerSchema: rejects non-object schema', () => {
    expect(() => sv.registerSchema('echo', null as any)).toThrow('non-null object');
  });

  test('registerSchema: updates existing schema', () => {
    sv.registerSchema('echo', { type: 'object' });
    const updated = sv.registerSchema('echo', { type: 'object', required: ['msg'] });
    expect(updated.schema.required).toEqual(['msg']);
    expect(sv.size).toBe(1); // no duplicate
  });

  test('removeSchema: removes and returns true', () => {
    sv.registerSchema('echo', { type: 'object' });
    expect(sv.removeSchema('echo')).toBe(true);
    expect(sv.size).toBe(0);
  });

  test('removeSchema: returns false for missing', () => {
    expect(sv.removeSchema('nope')).toBe(false);
  });

  test('getSchema: returns schema or null', () => {
    sv.registerSchema('echo', { type: 'object' });
    expect(sv.getSchema('echo')!.toolName).toBe('echo');
    expect(sv.getSchema('nope')).toBeNull();
  });

  test('validate: passes when no schema registered', () => {
    const result = sv.validate('echo', { msg: 'hi' });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('validate: type check — string', () => {
    sv.registerSchema('echo', { type: 'object', properties: { msg: { type: 'string' } } });
    expect(sv.validate('echo', { msg: 123 }).valid).toBe(false);
    expect(sv.validate('echo', { msg: 'hi' }).valid).toBe(true);
  });

  test('validate: type check — number', () => {
    sv.registerSchema('math', { type: 'object', properties: { x: { type: 'number' } } });
    expect(sv.validate('math', { x: 'abc' }).valid).toBe(false);
    expect(sv.validate('math', { x: 42 }).valid).toBe(true);
  });

  test('validate: required fields', () => {
    sv.registerSchema('greet', { type: 'object', required: ['name'], properties: { name: { type: 'string' } } });
    const r = sv.validate('greet', {});
    expect(r.valid).toBe(false);
    expect(r.errors[0].message).toContain('Missing required');
    expect(sv.validate('greet', { name: 'Alice' }).valid).toBe(true);
  });

  test('validate: enum check', () => {
    sv.registerSchema('status', { type: 'object', properties: { level: { type: 'string', enum: ['low', 'medium', 'high'] } } });
    expect(sv.validate('status', { level: 'low' }).valid).toBe(true);
    expect(sv.validate('status', { level: 'extreme' }).valid).toBe(false);
  });

  test('validate: minLength / maxLength', () => {
    sv.registerSchema('name', { type: 'object', properties: { s: { type: 'string', minLength: 2, maxLength: 5 } } });
    expect(sv.validate('name', { s: 'a' }).valid).toBe(false);
    expect(sv.validate('name', { s: 'ab' }).valid).toBe(true);
    expect(sv.validate('name', { s: 'abcdef' }).valid).toBe(false);
  });

  test('validate: minimum / maximum', () => {
    sv.registerSchema('range', { type: 'object', properties: { n: { type: 'number', minimum: 0, maximum: 100 } } });
    expect(sv.validate('range', { n: -1 }).valid).toBe(false);
    expect(sv.validate('range', { n: 50 }).valid).toBe(true);
    expect(sv.validate('range', { n: 101 }).valid).toBe(false);
  });

  test('validate: pattern', () => {
    sv.registerSchema('email', { type: 'object', properties: { e: { type: 'string', pattern: '^[^@]+@[^@]+$' } } });
    expect(sv.validate('email', { e: 'a@b.com' }).valid).toBe(true);
    expect(sv.validate('email', { e: 'nope' }).valid).toBe(false);
  });

  test('validate: array items', () => {
    sv.registerSchema('tags', { type: 'object', properties: { items: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 } } });
    expect(sv.validate('tags', { items: [] }).valid).toBe(false); // too short
    expect(sv.validate('tags', { items: ['a', 'b'] }).valid).toBe(true);
    expect(sv.validate('tags', { items: ['a', 'b', 'c', 'd'] }).valid).toBe(false); // too long
    expect(sv.validate('tags', { items: ['a', 123] }).valid).toBe(false); // wrong item type
  });

  test('validate: nested objects', () => {
    sv.registerSchema('nested', {
      type: 'object',
      properties: {
        config: {
          type: 'object',
          required: ['key'],
          properties: {
            key: { type: 'string' },
            value: { type: 'number' },
          },
        },
      },
    });
    expect(sv.validate('nested', { config: { key: 'a', value: 1 } }).valid).toBe(true);
    expect(sv.validate('nested', { config: {} }).valid).toBe(false); // missing required 'key'
    expect(sv.validate('nested', { config: { key: 123 } }).valid).toBe(false); // wrong type
  });

  test('validate: root type mismatch', () => {
    sv.registerSchema('echo', { type: 'object' });
    expect(sv.validate('echo', 'not-an-object').valid).toBe(false);
    expect(sv.validate('echo', []).valid).toBe(false);
  });

  test('stats: tracks validations and failures', () => {
    sv.registerSchema('echo', { type: 'object', required: ['msg'] });
    sv.validate('echo', { msg: 'hi' }); // pass
    sv.validate('echo', {}); // fail
    sv.validate('echo', {}); // fail
    const s = sv.stats();
    expect(s.totalSchemas).toBe(1);
    expect(s.totalValidations).toBe(3);
    expect(s.totalFailures).toBe(2);
    expect(s.schemas[0].toolName).toBe('echo');
  });

  test('exportSchemas + importSchemas: round-trip', () => {
    sv.registerSchema('echo', { type: 'object' });
    sv.registerSchema('math', { type: 'object', properties: { x: { type: 'number' } } });
    const exported = sv.exportSchemas();

    const sv2 = new ToolSchemaValidator();
    const imported = sv2.importSchemas(exported);
    expect(imported).toBe(2);
    expect(sv2.size).toBe(2);
    expect(sv2.getSchema('math')!.schema.properties!.x!.type).toBe('number');
  });

  test('validate: multiple type union', () => {
    sv.registerSchema('flex', { type: 'object', properties: { val: { type: ['string', 'number'] } } });
    expect(sv.validate('flex', { val: 'hello' }).valid).toBe(true);
    expect(sv.validate('flex', { val: 42 }).valid).toBe(true);
    expect(sv.validate('flex', { val: true }).valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. CanaryRouter — Unit Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('CanaryRouter', () => {
  let cr: CanaryRouter;

  beforeEach(() => {
    cr = new CanaryRouter();
  });

  test('disabled by default', () => {
    expect(cr.enabled).toBe(false);
    expect(cr.weight).toBe(0);
    expect(cr.canaryConfig).toBeNull();
  });

  test('route to primary when disabled', () => {
    const d = cr.route();
    expect(d.backend).toBe('primary');
    expect(d.weight).toBe(0);
  });

  test('enable: stores config', () => {
    cr.enable({ serverCommand: 'node', serverArgs: ['canary.js'], weight: 20 });
    expect(cr.enabled).toBe(true);
    expect(cr.weight).toBe(20);
    expect(cr.canaryConfig!.serverCommand).toBe('node');
  });

  test('enable: clamps weight 0-100', () => {
    cr.enable({ serverCommand: 'node', serverArgs: [], weight: 150 });
    expect(cr.weight).toBe(100);
    cr.enable({ serverCommand: 'node', serverArgs: [], weight: -10 });
    expect(cr.weight).toBe(0);
  });

  test('enable: throws without server command', () => {
    expect(() => cr.enable({ serverCommand: '', serverArgs: [], weight: 50 })).toThrow('required');
  });

  test('disable: clears config', () => {
    cr.enable({ serverCommand: 'node', serverArgs: [], weight: 50 });
    cr.disable();
    expect(cr.enabled).toBe(false);
    expect(cr.weight).toBe(0);
  });

  test('setWeight: updates weight', () => {
    cr.enable({ serverCommand: 'node', serverArgs: [], weight: 10 });
    cr.setWeight(75);
    expect(cr.weight).toBe(75);
  });

  test('setWeight: throws when not enabled', () => {
    expect(() => cr.setWeight(50)).toThrow('not enabled');
  });

  test('route: weight=0 always primary', () => {
    cr.enable({ serverCommand: 'node', serverArgs: [], weight: 0 });
    for (let i = 0; i < 20; i++) {
      expect(cr.route().backend).toBe('primary');
    }
  });

  test('route: weight=100 always canary', () => {
    cr.enable({ serverCommand: 'node', serverArgs: [], weight: 100 });
    for (let i = 0; i < 20; i++) {
      expect(cr.route().backend).toBe('canary');
    }
  });

  test('route: weight=50 produces both backends', () => {
    cr.enable({ serverCommand: 'node', serverArgs: [], weight: 50 });
    const backends = new Set<string>();
    for (let i = 0; i < 100; i++) {
      backends.add(cr.route().backend);
    }
    expect(backends.has('primary')).toBe(true);
    expect(backends.has('canary')).toBe(true);
  });

  test('recordError: tracks per-backend errors', () => {
    cr.enable({ serverCommand: 'node', serverArgs: [], weight: 50 });
    cr.recordError('primary');
    cr.recordError('primary');
    cr.recordError('canary');
    const s = cr.stats();
    expect(s.primaryErrors).toBe(2);
    expect(s.canaryErrors).toBe(1);
  });

  test('stats: tracks calls and errors', () => {
    cr.enable({ serverCommand: 'node', serverArgs: ['--canary'], weight: 100 });
    cr.route(); // canary
    cr.route(); // canary
    cr.route(); // canary
    const s = cr.stats();
    expect(s.enabled).toBe(true);
    expect(s.weight).toBe(100);
    expect(s.canaryCalls).toBe(3);
    expect(s.primaryCalls).toBe(0);
    expect(s.canaryCommand).toBe('node --canary');
    expect(s.createdAt).toBeTruthy();
  });

  test('events: emits enabled, disabled, weight-changed', () => {
    const events: string[] = [];
    cr.on('enabled', () => events.push('enabled'));
    cr.on('disabled', () => events.push('disabled'));
    cr.on('weight-changed', () => events.push('weight-changed'));

    cr.enable({ serverCommand: 'node', serverArgs: [], weight: 50 });
    cr.setWeight(75);
    cr.disable();

    expect(events).toEqual(['enabled', 'weight-changed', 'disabled']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Integration Tests — HTTP API
// ═══════════════════════════════════════════════════════════════════════════

describe('v9.6 Integration: Usage Plans via HTTP', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    ({ server, port, adminKey } = await startServer());
  });

  afterAll(async () => {
    await server.stop();
  });

  test('GET /admin/plans: returns empty stats', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/plans`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.totalPlans).toBe(0);
    expect(body.plans).toEqual([]);
  });

  test('POST /admin/plans: creates plan', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'free', description: 'Free tier', rateLimitPerMin: 10, deniedTools: ['premium'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.name).toBe('free');
    expect(body.rateLimitPerMin).toBe(10);
    expect(body.deniedTools).toEqual(['premium']);
  });

  test('POST /admin/plans: creates pro plan', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'pro', description: 'Pro tier', creditMultiplier: 0.5 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.creditMultiplier).toBe(0.5);
  });

  test('GET /admin/plans: lists created plans', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/plans`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body = await res.json() as any;
    expect(body.totalPlans).toBe(2);
    expect(body.plans.map((p: any) => p.name).sort()).toEqual(['free', 'pro']);
  });

  test('POST /admin/keys/plan: assigns key to plan', async () => {
    const keyData = await createKey(port, adminKey, 100);
    const res = await fetch(`http://127.0.0.1:${port}/admin/keys/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ key: keyData.key, plan: 'free' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.plan).toBe('free');
  });

  test('Plan ACL: free plan denies premium tool', async () => {
    const keyData = await createKey(port, adminKey, 100);
    // Assign to free plan (denies premium)
    await fetch(`http://127.0.0.1:${port}/admin/keys/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ key: keyData.key, plan: 'free' }),
    });

    // Try calling premium tool
    const res = await callTool(port, keyData.key, 'premium', { q: 'test' });
    const body = await res.json() as any;
    expect(body.error).toBeTruthy();
    expect(body.error.code).toBe(-32403);
  });

  test('Plan ACL: unassigned key can call any tool', async () => {
    const keyData = await createKey(port, adminKey, 100);
    const res = await callTool(port, keyData.key, 'premium', { q: 'test' });
    const body = await res.json() as any;
    expect(body.result).toBeTruthy();
  });

  test('DELETE /admin/plans: deletes plan', async () => {
    // Create a temp plan with no keys
    await fetch(`http://127.0.0.1:${port}/admin/plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'temp' }),
    });
    const res = await fetch(`http://127.0.0.1:${port}/admin/plans?name=temp`, {
      method: 'DELETE',
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.deleted).toBe('temp');
  });
});

describe('v9.6 Integration: Tool Schema Validation via HTTP', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let apiKey: string;

  beforeAll(async () => {
    ({ server, port, adminKey } = await startServer());
    const keyData = await createKey(port, adminKey, 100);
    apiKey = keyData.key;
  });

  afterAll(async () => {
    await server.stop();
  });

  test('GET /admin/tools/schema: empty stats', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/tools/schema`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.totalSchemas).toBe(0);
  });

  test('POST /admin/tools/schema: registers schema', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/tools/schema`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({
        tool: 'greet',
        schema: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1 },
            age: { type: 'number', minimum: 0, maximum: 150 },
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.toolName).toBe('greet');
  });

  test('Schema validation: passes valid args', async () => {
    const res = await callTool(port, apiKey, 'greet', { name: 'Alice', age: 30 });
    const body = await res.json() as any;
    expect(body.result).toBeTruthy();
    expect(body.result.content[0].text).toBe('Alice');
  });

  test('Schema validation: rejects missing required field', async () => {
    const res = await callTool(port, apiKey, 'greet', { age: 30 });
    const body = await res.json() as any;
    expect(body.error).toBeTruthy();
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain('schema validation failed');
    expect(body.error.data.errors.some((e: any) => e.message.includes('required'))).toBe(true);
  });

  test('Schema validation: rejects wrong type', async () => {
    const res = await callTool(port, apiKey, 'greet', { name: 123 });
    const body = await res.json() as any;
    expect(body.error).toBeTruthy();
    expect(body.error.code).toBe(-32602);
  });

  test('Schema validation: rejects out-of-range number', async () => {
    const res = await callTool(port, apiKey, 'greet', { name: 'Bob', age: 200 });
    const body = await res.json() as any;
    expect(body.error).toBeTruthy();
    expect(body.error.code).toBe(-32602);
    expect(body.error.data.errors.some((e: any) => e.message.includes('too large'))).toBe(true);
  });

  test('Schema validation: no schema = no validation', async () => {
    const res = await callTool(port, apiKey, 'echo', { msg: 123 }); // echo has no schema
    const body = await res.json() as any;
    expect(body.result).toBeTruthy(); // passes through
  });

  test('DELETE /admin/tools/schema: removes schema', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/tools/schema?tool=greet`, {
      method: 'DELETE',
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);

    // Now greet calls pass without validation
    const callRes = await callTool(port, apiKey, 'greet', { age: 30 });
    const body = await callRes.json() as any;
    expect(body.result).toBeTruthy();
  });
});

describe('v9.6 Integration: Canary Router via HTTP', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    ({ server, port, adminKey } = await startServer());
  });

  afterAll(async () => {
    await server.stop();
  });

  test('GET /admin/canary: disabled by default', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/canary`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.enabled).toBe(false);
    expect(body.weight).toBe(0);
  });

  test('POST /admin/canary: enables canary', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/canary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ serverCommand: process.execPath, serverArgs: ['-e', 'process.exit(0)'], weight: 30 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.enabled).toBe(true);
    expect(body.weight).toBe(30);
  });

  test('POST /admin/canary: updates weight only', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/canary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ weight: 75 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.weight).toBe(75);
  });

  test('DELETE /admin/canary: disables canary', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/canary`, {
      method: 'DELETE',
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.disabled).toBe(true);
  });
});

describe('v9.6 Integration: Root Listing', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    ({ server, port, adminKey } = await startServer());
  });

  afterAll(async () => {
    await server.stop();
  });

  test('root listing includes v9.6 endpoints', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const endpoints = body.endpoints || {};
    expect(endpoints.adminPlans).toBeTruthy();
    expect(endpoints.adminKeyPlan).toBeTruthy();
    expect(endpoints.adminToolSchema).toBeTruthy();
    expect(endpoints.adminCanary).toBeTruthy();
  });
});
