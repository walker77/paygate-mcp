/**
 * v10.0.0 Feature Tests — Request Tracing, Budget Policies, Tool Dependency Graph
 *
 * Unit tests for each module + integration tests via HTTP endpoints.
 */

import { RequestTracer } from '../src/request-tracer';
import { BudgetPolicyEngine } from '../src/budget-policy';
import { ToolDependencyGraph } from '../src/tool-deps';

// ═══════════════════════════════════════════════════════════════════════════
// REQUEST TRACER — Unit Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('RequestTracer', () => {
  let tracer: RequestTracer;
  beforeEach(() => { tracer = new RequestTracer({ enabled: true }); });

  it('starts and ends traces', () => {
    const traceId = tracer.startTrace('req-1', 'POST', '/mcp', 'key-1');
    expect(traceId).toMatch(/^trc_/);

    tracer.addSpan(traceId!, 'gate.check', 5, 'ok');
    tracer.addSpan(traceId!, 'backend.call', 50, 'ok');

    const trace = tracer.endTrace(traceId!, { statusCode: 200, creditsCost: 10, cacheHit: false });
    expect(trace).toBeDefined();
    expect(trace!.spans).toHaveLength(2);
    expect(trace!.summary.gateMs).toBe(5);
    expect(trace!.summary.backendMs).toBe(50);
    expect(trace!.summary.statusCode).toBe(200);
    expect(trace!.summary.creditsCost).toBe(10);
  });

  it('retrieves by trace ID and request ID', () => {
    const traceId = tracer.startTrace('req-abc', 'POST', '/');
    tracer.endTrace(traceId!, { statusCode: 200 });

    expect(tracer.getTrace(traceId!)).toBeDefined();
    const byReq = tracer.getByRequestId('req-abc');
    expect(byReq.length).toBeGreaterThan(0);
    expect(tracer.getByRequestId('nonexistent')).toHaveLength(0);
  });

  it('lists recent and slow traces', () => {
    for (let i = 0; i < 5; i++) {
      const id = tracer.startTrace(`req-${i}`, 'POST', '/');
      tracer.addSpan(id!, 'backend.call', (i + 1) * 100, 'ok');
      tracer.endTrace(id!, { statusCode: 200 });
    }

    const recent = tracer.getRecent(3);
    expect(recent).toHaveLength(3);

    // getSlow takes thresholdMs first, then limit
    const slow = tracer.getSlow(0, 2);
    expect(slow).toHaveLength(2);
    // Slowest first
    expect(slow[0].totalDurationMs).toBeGreaterThanOrEqual(slow[1].totalDurationMs);
  });

  it('exports traces', () => {
    const id = tracer.startTrace('r1', 'POST', '/');
    tracer.endTrace(id!, { statusCode: 200 });

    const exported = tracer.exportTraces();
    expect(exported).toHaveLength(1);
    expect(exported[0].traceId).toBe(id);
  });

  it('respects sample rate', () => {
    tracer.configure({ sampleRate: 0 });
    const id = tracer.startTrace('r1', 'POST', '/');
    expect(id).toBeNull();
  });

  it('returns stats', () => {
    const id = tracer.startTrace('r1', 'POST', '/');
    tracer.addSpan(id!, 'gate.check', 10, 'ok');
    tracer.endTrace(id!, { statusCode: 200 });

    const stats = tracer.stats();
    expect(stats.totalTraces).toBe(1);
    expect(stats.activeTraces).toBe(0);
    expect(stats.completedTraces).toBe(1);
    expect(stats.avgDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('disabled tracer passes everything through', () => {
    tracer.configure({ enabled: false });
    const id = tracer.startTrace('r1', 'POST', '/');
    expect(id).toBeNull();
  });

  it('clears all state', () => {
    const id = tracer.startTrace('r1', 'POST', '/');
    tracer.endTrace(id!, { statusCode: 200 });
    expect(tracer.stats().completedTraces).toBe(1);
    tracer.clear();
    expect(tracer.stats().completedTraces).toBe(0);
  });

  it('categorizes transform spans', () => {
    const id = tracer.startTrace('r1', 'POST', '/');
    tracer.addSpan(id!, 'transform.request', 3, 'ok');
    tracer.addSpan(id!, 'transform.response', 7, 'ok');
    const trace = tracer.endTrace(id!, { statusCode: 200 });
    expect(trace!.summary.transformMs).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BUDGET POLICY ENGINE — Unit Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('BudgetPolicyEngine', () => {
  let engine: BudgetPolicyEngine;
  beforeEach(() => { engine = new BudgetPolicyEngine(); });

  it('creates and retrieves policies', () => {
    const policy = engine.createPolicy({
      name: 'Test Policy',
      burnRateThreshold: 100,
      burnRateWindowSec: 60,
      dailyBudget: 1000,
      monthlyBudget: 10000,
      onBurnRateExceeded: 'alert',
      throttleReductionPercent: 50,
      throttleCooldownSec: 300,
      active: true,
    });
    expect(policy.policyId).toMatch(/^bpol_/);
    expect(policy.name).toBe('Test Policy');

    const retrieved = engine.getPolicy(policy.policyId);
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe('Test Policy');
  });

  it('lists and deletes policies', () => {
    engine.createPolicy({
      name: 'P1', burnRateThreshold: 100, burnRateWindowSec: 60,
      dailyBudget: 0, monthlyBudget: 0, onBurnRateExceeded: 'alert',
      throttleReductionPercent: 50, throttleCooldownSec: 300, active: true,
    });
    engine.createPolicy({
      name: 'P2', burnRateThreshold: 100, burnRateWindowSec: 60,
      dailyBudget: 0, monthlyBudget: 0, onBurnRateExceeded: 'alert',
      throttleReductionPercent: 50, throttleCooldownSec: 300, active: true,
    });
    expect(engine.listPolicies()).toHaveLength(2);

    engine.deletePolicy(engine.listPolicies()[0].policyId);
    expect(engine.listPolicies()).toHaveLength(1);
  });

  it('allows spend under daily budget', () => {
    engine.createPolicy({
      name: 'DailyLimit', burnRateThreshold: 9999, burnRateWindowSec: 60,
      dailyBudget: 100, monthlyBudget: 0, onBurnRateExceeded: 'alert',
      throttleReductionPercent: 50, throttleCooldownSec: 300, active: true,
    });

    const result = engine.recordSpend(undefined, undefined, 50);
    expect(result.allowed).toBe(true);
    expect(result.dailyRemaining).toBe(50);
  });

  it('denies spend over daily budget', () => {
    engine.createPolicy({
      name: 'DailyLimit', burnRateThreshold: 9999, burnRateWindowSec: 60,
      dailyBudget: 100, monthlyBudget: 0, onBurnRateExceeded: 'alert',
      throttleReductionPercent: 50, throttleCooldownSec: 300, active: true,
    });

    engine.recordSpend(undefined, undefined, 80);
    const result = engine.recordSpend(undefined, undefined, 30);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('daily-budget-exceeded');
  });

  it('denies spend over monthly budget', () => {
    engine.createPolicy({
      name: 'MonthlyLimit', burnRateThreshold: 9999, burnRateWindowSec: 60,
      dailyBudget: 0, monthlyBudget: 200, onBurnRateExceeded: 'alert',
      throttleReductionPercent: 50, throttleCooldownSec: 300, active: true,
    });

    engine.recordSpend(undefined, undefined, 150);
    const result = engine.recordSpend(undefined, undefined, 60);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('monthly-budget-exceeded');
  });

  it('denies on burn rate exceeded with deny action', () => {
    engine.createPolicy({
      name: 'BurnDeny', burnRateThreshold: 10, burnRateWindowSec: 60,
      dailyBudget: 0, monthlyBudget: 0, onBurnRateExceeded: 'deny',
      throttleReductionPercent: 50, throttleCooldownSec: 300, active: true,
    });

    // Burn > 10 credits/minute → 1000 credits in 60 seconds = 1000 credits/min
    const result = engine.recordSpend(undefined, undefined, 1000);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('burn-rate-exceeded');
    expect(result.burnRateExceeded).toBe(true);
  });

  it('throttles on burn rate exceeded with throttle action', () => {
    engine.createPolicy({
      name: 'BurnThrottle', burnRateThreshold: 10, burnRateWindowSec: 60,
      dailyBudget: 0, monthlyBudget: 0, onBurnRateExceeded: 'throttle',
      throttleReductionPercent: 50, throttleCooldownSec: 300, active: true,
    });

    const result = engine.recordSpend(undefined, undefined, 1000);
    expect(result.allowed).toBe(true);
    expect(result.isThrottled).toBe(true);
    expect(result.burnRateExceeded).toBe(true);
  });

  it('targets specific namespace', () => {
    engine.createPolicy({
      name: 'NSPolicy', targetNamespace: 'production', burnRateThreshold: 9999,
      burnRateWindowSec: 60, dailyBudget: 50, monthlyBudget: 0,
      onBurnRateExceeded: 'alert', throttleReductionPercent: 50,
      throttleCooldownSec: 300, active: true,
    });

    // Different namespace → no policy applies → allowed
    const r1 = engine.recordSpend('staging', undefined, 9999);
    expect(r1.allowed).toBe(true);

    // Target namespace → budget applies
    const r2 = engine.recordSpend('production', undefined, 60);
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toBe('daily-budget-exceeded');
  });

  it('no policies → always allowed', () => {
    const result = engine.recordSpend(undefined, undefined, 99999);
    expect(result.allowed).toBe(true);
    expect(result.currentBurnRate).toBe(0);
  });

  it('inactive policies ignored', () => {
    engine.createPolicy({
      name: 'Inactive', burnRateThreshold: 1, burnRateWindowSec: 60,
      dailyBudget: 1, monthlyBudget: 0, onBurnRateExceeded: 'deny',
      throttleReductionPercent: 50, throttleCooldownSec: 300, active: false,
    });

    const result = engine.recordSpend(undefined, undefined, 99999);
    expect(result.allowed).toBe(true);
  });

  it('returns stats', () => {
    engine.createPolicy({
      name: 'S1', burnRateThreshold: 100, burnRateWindowSec: 60,
      dailyBudget: 1000, monthlyBudget: 0, onBurnRateExceeded: 'alert',
      throttleReductionPercent: 50, throttleCooldownSec: 300, active: true,
    });
    engine.recordSpend(undefined, undefined, 100);

    const stats = engine.stats();
    expect(stats.totalPolicies).toBe(1);
    expect(stats.activePolicies).toBe(1);
    expect(stats.policies[0].dailyUtilization).toBe(10);
  });

  it('clears all state', () => {
    engine.createPolicy({
      name: 'X', burnRateThreshold: 100, burnRateWindowSec: 60,
      dailyBudget: 0, monthlyBudget: 0, onBurnRateExceeded: 'alert',
      throttleReductionPercent: 50, throttleCooldownSec: 300, active: true,
    });
    engine.clear();
    expect(engine.listPolicies()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TOOL DEPENDENCY GRAPH — Unit Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('ToolDependencyGraph', () => {
  let graph: ToolDependencyGraph;
  beforeEach(() => { graph = new ToolDependencyGraph({ enabled: true }); });

  it('registers and retrieves dependencies', () => {
    const dep = graph.register('transform', ['fetch'], { group: 'pipeline' });
    expect(dep.tool).toBe('transform');
    expect(dep.dependsOn).toEqual(['fetch']);
    expect(dep.group).toBe('pipeline');

    const retrieved = graph.getDep('transform');
    expect(retrieved).toBeDefined();
    expect(retrieved!.dependsOn).toEqual(['fetch']);
  });

  it('lists deps with group filter', () => {
    graph.register('a', ['x'], { group: 'g1' });
    graph.register('b', ['y'], { group: 'g2' });

    expect(graph.listDeps('g1')).toHaveLength(1);
    expect(graph.listDeps('g2')).toHaveLength(1);
    expect(graph.listDeps()).toHaveLength(2);
  });

  it('unregisters a tool and removes from dependsOn', () => {
    graph.register('b', ['a']);
    graph.register('c', ['a', 'b']);
    graph.unregister('a');

    expect(graph.getDep('a')).toBeUndefined();
    const c = graph.getDep('c');
    expect(c!.dependsOn).toEqual(['b']); // 'a' removed
  });

  it('allows tool with no deps', () => {
    const wfId = graph.startWorkflow();
    const result = graph.check('fetch', wfId);
    expect(result.allowed).toBe(true);
  });

  it('blocks tool with unsatisfied deps', () => {
    graph.register('transform', ['fetch']);
    const wfId = graph.startWorkflow();

    const result = graph.check('transform', wfId);
    expect(result.allowed).toBe(false);
    expect(result.unsatisfied).toEqual(['fetch']);
    expect(result.reason).toBe('dependency-unsatisfied');
  });

  it('allows tool after deps succeed', () => {
    graph.register('transform', ['fetch']);
    const wfId = graph.startWorkflow();

    graph.recordExecution('fetch', wfId, 'success');
    const result = graph.check('transform', wfId);
    expect(result.allowed).toBe(true);
  });

  it('blocks on failed hard dependency', () => {
    graph.register('transform', ['fetch'], { hardDependency: true });
    const wfId = graph.startWorkflow();

    graph.recordExecution('fetch', wfId, 'failure');
    const result = graph.check('transform', wfId);
    expect(result.allowed).toBe(false);
    expect(result.failed).toEqual(['fetch']);
    expect(result.reason).toBe('dependency-failed');
  });

  it('allows on failed soft dependency', () => {
    graph.register('transform', ['fetch'], { hardDependency: false });
    const wfId = graph.startWorkflow();

    graph.recordExecution('fetch', wfId, 'failure');
    const result = graph.check('transform', wfId);
    expect(result.allowed).toBe(true);
  });

  it('computes topological sort', () => {
    graph.register('c', ['b']);
    graph.register('b', ['a']);

    const sorted = graph.topologicalSort();
    expect(sorted.order.indexOf('a')).toBeLessThan(sorted.order.indexOf('b'));
    expect(sorted.order.indexOf('b')).toBeLessThan(sorted.order.indexOf('c'));
    expect(sorted.cycles).toHaveLength(0);
  });

  it('detects cycles', () => {
    graph.register('a', ['c']);
    graph.register('b', ['a']);
    graph.register('c', ['b']);

    const sorted = graph.topologicalSort();
    expect(sorted.cycles.length).toBeGreaterThan(0);
    expect(sorted.cycles[0]).toContain('a');
    expect(sorted.cycles[0]).toContain('b');
    expect(sorted.cycles[0]).toContain('c');
  });

  it('validates graph', () => {
    graph.register('b', ['a']);
    expect(graph.validate().valid).toBe(true);

    graph.register('a', ['b']); // creates cycle
    expect(graph.validate().valid).toBe(false);
  });

  it('computes dependents (downstream impact)', () => {
    graph.register('b', ['a']);
    graph.register('c', ['a']);
    graph.register('d', ['b']);

    const deps = graph.getDependents('a');
    expect(deps).toContain('b');
    expect(deps).toContain('c');
    expect(deps).toContain('d');
  });

  it('computes prerequisites (upstream)', () => {
    graph.register('c', ['b']);
    graph.register('b', ['a']);

    const prereqs = graph.getPrerequisites('c');
    expect(prereqs).toContain('b');
    expect(prereqs).toContain('a');
  });

  it('tracks workflow execution history', () => {
    const wfId = graph.startWorkflow();
    expect(wfId).toMatch(/^wf_/);

    graph.recordExecution('fetch', wfId, 'success');
    graph.recordExecution('transform', wfId, 'failure');

    const history = graph.getWorkflow(wfId);
    expect(history).toHaveLength(2);
    expect(history[0].tool).toBe('fetch');
    expect(history[0].status).toBe('success');
    expect(history[1].tool).toBe('transform');
    expect(history[1].status).toBe('failure');
  });

  it('disabled graph allows everything', () => {
    graph.configure({ enabled: false });
    graph.register('b', ['a']);
    const wfId = graph.startWorkflow();
    const result = graph.check('b', wfId);
    expect(result.allowed).toBe(true);
  });

  it('returns stats', () => {
    graph.register('b', ['a']);
    graph.register('c', ['a', 'b']);
    const wfId = graph.startWorkflow();
    graph.check('b', wfId);

    const stats = graph.stats();
    expect(stats.totalTools).toBe(2);
    expect(stats.totalEdges).toBe(3); // b→a, c→a, c→b
    expect(stats.checksPerformed).toBe(1);
  });

  it('clears all state', () => {
    graph.register('b', ['a']);
    graph.clear();
    expect(graph.stats().totalTools).toBe(0);
    expect(graph.stats().totalWorkflows).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS — HTTP Endpoints
// ═══════════════════════════════════════════════════════════════════════════

import http from 'http';
import { PayGateServer } from '../src/server';

function request(port: number, method: string, path: string, body?: Record<string, unknown>, headers?: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const hdrs: Record<string, string> = { 'Content-Type': 'application/json', ...headers };
    if (data) hdrs['Content-Length'] = String(Buffer.byteLength(data));
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: hdrs }, (res) => {
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
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'echo', description: 'Echo tool', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } }] } }));
    } else if (rpc.method === 'tools/call') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'echo: ' + JSON.stringify(rpc.params?.arguments) }] } }));
    } else {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {} }));
    }
  });
});
s.listen(0, () => console.log('ECHO_PORT=' + s.address().port));
`;

describe('v10.0.0 Integration Tests', () => {
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

  // ─── Request Tracing Endpoints ──────────────────────────────────────────

  it('GET /admin/tracing returns stats', async () => {
    const r = await request(port, 'GET', '/admin/tracing', undefined, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.totalTraces).toBeDefined();
  });

  it('POST /admin/tracing configures tracing', async () => {
    const r = await request(port, 'POST', '/admin/tracing', { enabled: true, sampleRate: 0.5 }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
  });

  it('GET /admin/tracing?action=recent returns recent list', async () => {
    const r = await request(port, 'GET', '/admin/tracing?action=recent', undefined, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.recent).toBeDefined();
  });

  it('GET /admin/tracing?action=slow returns slow list', async () => {
    const r = await request(port, 'GET', '/admin/tracing?action=slow', undefined, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.slow).toBeDefined();
  });

  it('GET /admin/tracing?action=export returns export', async () => {
    const r = await request(port, 'GET', '/admin/tracing?action=export', undefined, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });

  it('DELETE /admin/tracing clears traces', async () => {
    const r = await request(port, 'DELETE', '/admin/tracing', undefined, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.cleared).toBe(true);
  });

  // ─── Budget Policies Endpoints ──────────────────────────────────────────

  it('GET /admin/budget-policies returns stats', async () => {
    const r = await request(port, 'GET', '/admin/budget-policies', undefined, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.totalPolicies).toBeDefined();
  });

  it('POST /admin/budget-policies creates a policy', async () => {
    const r = await request(port, 'POST', '/admin/budget-policies', {
      name: 'Test Policy',
      dailyBudget: 1000,
      monthlyBudget: 10000,
      burnRateThreshold: 100,
    }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(201);
    expect(r.body.policyId).toMatch(/^bpol_/);
    expect(r.body.name).toBe('Test Policy');
  });

  it('POST /admin/budget-policies records spend', async () => {
    // Create a policy first
    await request(port, 'POST', '/admin/budget-policies', {
      name: 'SpendTest',
      dailyBudget: 1000,
    }, { 'X-Admin-Key': adminKey });

    const r = await request(port, 'POST', '/admin/budget-policies', {
      recordSpend: 50,
    }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.allowed).toBe(true);
  });

  it('POST /admin/budget-policies deletes a policy', async () => {
    const create = await request(port, 'POST', '/admin/budget-policies', {
      name: 'ToDelete',
      dailyBudget: 100,
    }, { 'X-Admin-Key': adminKey });
    const policyId = create.body.policyId;

    const r = await request(port, 'POST', '/admin/budget-policies', {
      deletePolicy: policyId,
    }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(true);
  });

  it('GET /admin/budget-policies?policyId= returns specific policy', async () => {
    const create = await request(port, 'POST', '/admin/budget-policies', {
      name: 'Specific',
      dailyBudget: 500,
    }, { 'X-Admin-Key': adminKey });

    const r = await request(port, 'GET', `/admin/budget-policies?policyId=${create.body.policyId}`, undefined, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Specific');
  });

  it('DELETE /admin/budget-policies clears all', async () => {
    const r = await request(port, 'DELETE', '/admin/budget-policies', undefined, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.cleared).toBe(true);
  });

  // ─── Tool Deps Endpoints ──────────────────────────────────────────────

  it('GET /admin/tool-deps returns stats', async () => {
    const r = await request(port, 'GET', '/admin/tool-deps', undefined, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.totalTools).toBeDefined();
  });

  it('POST /admin/tool-deps registers dependency', async () => {
    const r = await request(port, 'POST', '/admin/tool-deps', {
      register: 'transform',
      dependsOn: ['fetch'],
      group: 'pipeline',
    }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(201);
    expect(r.body.tool).toBe('transform');
    expect(r.body.dependsOn).toEqual(['fetch']);
  });

  it('POST /admin/tool-deps starts workflow', async () => {
    const r = await request(port, 'POST', '/admin/tool-deps', {
      startWorkflow: true,
    }, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.workflowId).toMatch(/^wf_/);
  });

  it('POST /admin/tool-deps checks and records execution', async () => {
    // Register deps
    await request(port, 'POST', '/admin/tool-deps', {
      register: 'step2', dependsOn: ['step1'],
    }, { 'X-Admin-Key': adminKey });

    // Enable
    await request(port, 'POST', '/admin/tool-deps', { enabled: true }, { 'X-Admin-Key': adminKey });

    // Start workflow
    const wf = await request(port, 'POST', '/admin/tool-deps', { startWorkflow: true }, { 'X-Admin-Key': adminKey });
    const wfId = wf.body.workflowId;

    // Check step2 — should be blocked
    const check1 = await request(port, 'POST', '/admin/tool-deps', {
      check: 'step2', workflowId: wfId,
    }, { 'X-Admin-Key': adminKey });
    expect(check1.body.allowed).toBe(false);

    // Record step1 success
    await request(port, 'POST', '/admin/tool-deps', {
      recordExecution: 'step1', workflowId: wfId, status: 'success',
    }, { 'X-Admin-Key': adminKey });

    // Check step2 again — should be allowed
    const check2 = await request(port, 'POST', '/admin/tool-deps', {
      check: 'step2', workflowId: wfId,
    }, { 'X-Admin-Key': adminKey });
    expect(check2.body.allowed).toBe(true);
  });

  it('GET /admin/tool-deps?action=sort returns topological order', async () => {
    await request(port, 'POST', '/admin/tool-deps', {
      register: 'b', dependsOn: ['a'],
    }, { 'X-Admin-Key': adminKey });

    const r = await request(port, 'GET', '/admin/tool-deps?action=sort', undefined, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.order).toBeDefined();
    expect(r.body.order.indexOf('a')).toBeLessThan(r.body.order.indexOf('b'));
  });

  it('GET /admin/tool-deps?action=validate validates graph', async () => {
    await request(port, 'POST', '/admin/tool-deps', {
      register: 'b', dependsOn: ['a'],
    }, { 'X-Admin-Key': adminKey });

    const r = await request(port, 'GET', '/admin/tool-deps?action=validate', undefined, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.valid).toBe(true);
  });

  it('GET /admin/tool-deps?action=dependents returns dependents', async () => {
    await request(port, 'POST', '/admin/tool-deps', {
      register: 'b', dependsOn: ['a'],
    }, { 'X-Admin-Key': adminKey });

    const r = await request(port, 'GET', '/admin/tool-deps?action=dependents&tool=a', undefined, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.dependents).toContain('b');
  });

  it('DELETE /admin/tool-deps clears all', async () => {
    const r = await request(port, 'DELETE', '/admin/tool-deps', undefined, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.cleared).toBe(true);
  });

  // ─── Root Listing includes new endpoints ────────────────────────────────

  it('root listing includes v10.0.0 endpoints', async () => {
    const r = await request(port, 'GET', '/', undefined, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.endpoints.adminTracing).toBeDefined();
    expect(r.body.endpoints.adminBudgetPolicies).toBeDefined();
    expect(r.body.endpoints.adminToolDeps).toBeDefined();
  });
});
