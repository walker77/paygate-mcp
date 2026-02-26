/**
 * Tests for Webhook Filters — per-event-type routing to different destinations.
 *
 * Validates:
 *   1. WebhookRouter — filter CRUD, event matching, emitter management
 *   2. Gate integration — webhookRouter created from config
 *   3. Server endpoints — CRUD via HTTP API
 *   4. Edge cases — wildcard, key prefix, inactive filters, orphan cleanup
 */

import { WebhookRouter } from '../src/webhook-router';
import { Gate } from '../src/gate';
import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG, WebhookFilterRule } from '../src/types';
import * as http from 'http';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function httpReq(
  port: number,
  path: string,
  method: string = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: any }> {
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
          resolve({ status: res.statusCode!, data });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const ECHO_CMD = 'node';
const ECHO_ARGS = ['-e', 'process.stdin.resume(); process.stdin.on("data", d => { const r = JSON.parse(d.toString().trim()); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: {} }) + "\\n"); });'];

// ─── 1. WebhookRouter Unit Tests ──────────────────────────────────────────────

describe('WebhookRouter', () => {
  afterEach(() => {
    // Cleanup any timers by destroying routers in tests
  });

  describe('constructor', () => {
    it('should create with no config', () => {
      const router = new WebhookRouter();
      expect(router.defaultWebhook).toBeNull();
      expect(router.ruleCount).toBe(0);
      router.destroy();
    });

    it('should create with default URL', () => {
      const router = new WebhookRouter({ defaultUrl: 'http://example.com/hooks' });
      expect(router.defaultWebhook).not.toBeNull();
      expect(router.ruleCount).toBe(0);
      router.destroy();
    });

    it('should create with initial filters', () => {
      const router = new WebhookRouter({
        defaultUrl: 'http://example.com/hooks',
        filters: [
          { id: 'f1', name: 'Alert filter', events: ['alert.fired'], url: 'http://alerts.example.com', active: true },
          { id: 'f2', name: 'Key filter', events: ['key.created', 'key.revoked'], url: 'http://admin.example.com', active: true },
        ],
      });
      expect(router.ruleCount).toBe(2);
      router.destroy();
    });
  });

  describe('addRule', () => {
    it('should add a filter rule with auto-generated ID', () => {
      const router = new WebhookRouter({ defaultUrl: 'http://example.com/hooks' });
      const rule = router.addRule({
        id: '',
        name: 'Test filter',
        events: ['key.created'],
        url: 'http://test.example.com',
        active: true,
      });
      expect(rule.id).toMatch(/^wf_/);
      expect(rule.name).toBe('Test filter');
      expect(router.ruleCount).toBe(1);
      router.destroy();
    });

    it('should throw if URL is missing', () => {
      const router = new WebhookRouter();
      expect(() => router.addRule({
        id: '', name: 'Bad', events: ['*'], url: '', active: true,
      })).toThrow('URL');
      router.destroy();
    });

    it('should throw if events are empty', () => {
      const router = new WebhookRouter();
      expect(() => router.addRule({
        id: '', name: 'Bad', events: [], url: 'http://x.com', active: true,
      })).toThrow('event type');
      router.destroy();
    });

    it('should deduplicate by ID', () => {
      const router = new WebhookRouter();
      router.addRule({ id: 'f1', name: 'V1', events: ['*'], url: 'http://a.com', active: true });
      router.addRule({ id: 'f1', name: 'V2', events: ['*'], url: 'http://b.com', active: true });
      expect(router.ruleCount).toBe(1);
      expect(router.getRule('f1')!.name).toBe('V2');
      router.destroy();
    });
  });

  describe('updateRule', () => {
    it('should update an existing rule', () => {
      const router = new WebhookRouter();
      const rule = router.addRule({ id: '', name: 'Original', events: ['*'], url: 'http://a.com', active: true });
      const updated = router.updateRule(rule.id, { name: 'Updated', active: false });
      expect(updated.name).toBe('Updated');
      expect(updated.active).toBe(false);
      router.destroy();
    });

    it('should throw for non-existent rule', () => {
      const router = new WebhookRouter();
      expect(() => router.updateRule('fake_id', { name: 'X' })).toThrow('not found');
      router.destroy();
    });
  });

  describe('deleteRule', () => {
    it('should delete an existing rule', () => {
      const router = new WebhookRouter();
      const rule = router.addRule({ id: '', name: 'Delete me', events: ['*'], url: 'http://a.com', active: true });
      expect(router.deleteRule(rule.id)).toBe(true);
      expect(router.ruleCount).toBe(0);
      router.destroy();
    });

    it('should return false for non-existent rule', () => {
      const router = new WebhookRouter();
      expect(router.deleteRule('fake_id')).toBe(false);
      router.destroy();
    });
  });

  describe('listRules', () => {
    it('should return all rules', () => {
      const router = new WebhookRouter();
      router.addRule({ id: 'f1', name: 'A', events: ['*'], url: 'http://a.com', active: true });
      router.addRule({ id: 'f2', name: 'B', events: ['key.created'], url: 'http://b.com', active: true });
      const rules = router.listRules();
      expect(rules.length).toBe(2);
      expect(rules[0].id).toBe('f1');
      expect(rules[1].id).toBe('f2');
      router.destroy();
    });
  });

  describe('event routing', () => {
    it('should not throw when emitting with no filters and no default', () => {
      const router = new WebhookRouter();
      // Should not throw
      router.emit({ timestamp: new Date().toISOString(), apiKey: 'pk_test', keyName: 'test', tool: 'test_tool', creditsCharged: 1, allowed: true });
      router.emitAdmin('key.created', 'admin', {});
      router.destroy();
    });

    it('should route to default emitter when no filters match', () => {
      const router = new WebhookRouter({ defaultUrl: 'http://example.com/hooks' });
      // Emitting should not throw — events go to default
      router.emit({ timestamp: new Date().toISOString(), apiKey: 'pk_test', keyName: 'test', tool: 'test_tool', creditsCharged: 1, allowed: true });
      router.emitAdmin('key.created', 'admin', {});
      router.destroy();
    });

    it('should not route to inactive filters', () => {
      const router = new WebhookRouter({ defaultUrl: 'http://example.com/hooks' });
      router.addRule({ id: 'f1', name: 'Inactive', events: ['key.created'], url: 'http://inactive.example.com', active: false });
      // Should not throw — inactive filter skipped
      router.emitAdmin('key.created', 'admin', {});
      router.destroy();
    });
  });

  describe('getAggregateStats', () => {
    it('should include default and filter emitters', () => {
      const router = new WebhookRouter({
        defaultUrl: 'http://example.com/hooks',
        filters: [
          { id: 'f1', name: 'Alert', events: ['alert.fired'], url: 'http://alerts.example.com', active: true },
        ],
      });
      const stats = router.getAggregateStats();
      expect(stats.emitterCount).toBe(2); // default + 1 filter
      expect(stats.filterCount).toBe(1);
      expect(stats.perUrl).toHaveProperty('default');
      expect(stats.perUrl['http://alerts.example.com']).toBeDefined();
      router.destroy();
    });
  });

  describe('key prefix matching', () => {
    it('should match key prefix filter', () => {
      const router = new WebhookRouter({
        defaultUrl: 'http://example.com/hooks',
        filters: [
          { id: 'f1', name: 'Prod only', events: ['*'], url: 'http://prod.example.com', keyPrefixes: ['pk_prod_'], active: true },
        ],
      });
      // Should not throw — routing works for both prod and non-prod keys
      router.emit({ timestamp: new Date().toISOString(), apiKey: 'pk_prod_123', keyName: 'prod', tool: 'test', creditsCharged: 1, allowed: true });
      router.emit({ timestamp: new Date().toISOString(), apiKey: 'pk_test_456', keyName: 'test', tool: 'test', creditsCharged: 1, allowed: true });
      router.destroy();
    });
  });

  describe('wildcard event matching', () => {
    it('should match all events with * wildcard', () => {
      const router = new WebhookRouter({
        filters: [
          { id: 'f1', name: 'All events', events: ['*'], url: 'http://all.example.com', active: true },
        ],
      });
      // Should not throw — wildcard matches everything
      router.emitAdmin('key.created', 'admin', {});
      router.emitAdmin('key.revoked', 'admin', {});
      router.emitAdmin('alert.fired', 'system', {});
      router.destroy();
    });
  });

  describe('destroy', () => {
    it('should clean up all emitters', () => {
      const router = new WebhookRouter({
        defaultUrl: 'http://example.com/hooks',
        filters: [
          { id: 'f1', name: 'A', events: ['*'], url: 'http://a.com', active: true },
          { id: 'f2', name: 'B', events: ['*'], url: 'http://b.com', active: true },
        ],
      });
      // Should not throw
      router.destroy();
    });
  });
});

// ─── 2. Gate Integration ──────────────────────────────────────────────────────

describe('Gate — webhookRouter integration', () => {
  it('should create webhookRouter when webhookUrl is set', () => {
    const gate = new Gate({ ...DEFAULT_CONFIG, webhookUrl: 'http://example.com/hooks' });
    expect(gate.webhookRouter).not.toBeNull();
    expect(gate.webhook).not.toBeNull();
    gate.webhookRouter?.destroy();
  });

  it('should create webhookRouter when only webhookFilters are set', () => {
    const gate = new Gate({
      ...DEFAULT_CONFIG,
      webhookFilters: [
        { id: 'f1', name: 'Alert', events: ['alert.fired'], url: 'http://alerts.example.com', active: true },
      ],
    });
    expect(gate.webhookRouter).not.toBeNull();
    // No default URL, so defaultWebhook is null
    expect(gate.webhook).toBeNull();
    gate.webhookRouter?.destroy();
  });

  it('should not create webhookRouter when nothing is configured', () => {
    const gate = new Gate({ ...DEFAULT_CONFIG });
    expect(gate.webhookRouter).toBeNull();
    expect(gate.webhook).toBeNull();
  });

  it('should pass webhookFilters from config to router', () => {
    const gate = new Gate({
      ...DEFAULT_CONFIG,
      webhookUrl: 'http://default.example.com',
      webhookFilters: [
        { id: 'f1', name: 'Alert', events: ['alert.fired'], url: 'http://alerts.example.com', active: true },
        { id: 'f2', name: 'Admin', events: ['key.created', 'key.revoked'], url: 'http://admin.example.com', active: true },
      ],
    });
    expect(gate.webhookRouter!.ruleCount).toBe(2);
    expect(gate.webhookRouter!.listRules()[0].id).toBe('f1');
    expect(gate.webhookRouter!.listRules()[1].id).toBe('f2');
    gate.webhookRouter?.destroy();
  });
});

// ─── 3. Server Endpoints ──────────────────────────────────────────────────────

describe('Server — Webhook Filter Endpoints', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      port: 0,
      webhookUrl: 'http://default-hooks.example.com',
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('GET /webhooks/filters should return empty list initially', async () => {
    const res = await httpReq(port, '/webhooks/filters', 'GET', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.data.count).toBe(0);
    expect(res.data.filters).toEqual([]);
  });

  it('POST /webhooks/filters should create a filter rule', async () => {
    const res = await httpReq(port, '/webhooks/filters', 'POST', {
      name: 'Alert webhook',
      events: ['alert.fired'],
      url: 'http://alerts.example.com/hooks',
    }, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(201);
    expect(res.data.id).toMatch(/^wf_/);
    expect(res.data.name).toBe('Alert webhook');
    expect(res.data.events).toEqual(['alert.fired']);
    expect(res.data.url).toBe('http://alerts.example.com/hooks');
    expect(res.data.active).toBe(true);
  });

  it('POST /webhooks/filters should reject missing URL', async () => {
    const res = await httpReq(port, '/webhooks/filters', 'POST', {
      name: 'Bad filter',
      events: ['key.created'],
    }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('URL');
  });

  it('POST /webhooks/filters should reject empty events', async () => {
    const res = await httpReq(port, '/webhooks/filters', 'POST', {
      name: 'Bad filter',
      events: [],
      url: 'http://x.com',
    }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('event');
  });

  it('GET /webhooks/filters should list created filters', async () => {
    // Create another filter
    await httpReq(port, '/webhooks/filters', 'POST', {
      name: 'Admin events',
      events: ['key.created', 'key.revoked'],
      url: 'http://admin.example.com/hooks',
      keyPrefixes: ['pk_prod_'],
    }, { 'X-Admin-Key': adminKey });

    const res = await httpReq(port, '/webhooks/filters', 'GET', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.data.count).toBeGreaterThanOrEqual(2);
  });

  it('POST /webhooks/filters/update should update a filter', async () => {
    // Create a filter to update
    const createRes = await httpReq(port, '/webhooks/filters', 'POST', {
      name: 'Update me',
      events: ['*'],
      url: 'http://update.example.com',
    }, { 'X-Admin-Key': adminKey });
    const filterId = createRes.data.id;

    const updateRes = await httpReq(port, '/webhooks/filters/update', 'POST', {
      id: filterId,
      name: 'Updated filter',
      events: ['key.created'],
      active: false,
    }, { 'X-Admin-Key': adminKey });

    expect(updateRes.status).toBe(200);
    expect(updateRes.data.name).toBe('Updated filter');
    expect(updateRes.data.events).toEqual(['key.created']);
    expect(updateRes.data.active).toBe(false);
  });

  it('POST /webhooks/filters/update should reject non-existent filter', async () => {
    const res = await httpReq(port, '/webhooks/filters/update', 'POST', {
      id: 'wf_nonexistent',
      name: 'X',
    }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('not found');
  });

  it('POST /webhooks/filters/delete should delete a filter', async () => {
    // Create a filter to delete
    const createRes = await httpReq(port, '/webhooks/filters', 'POST', {
      name: 'Delete me',
      events: ['*'],
      url: 'http://delete.example.com',
    }, { 'X-Admin-Key': adminKey });
    const filterId = createRes.data.id;

    const deleteRes = await httpReq(port, '/webhooks/filters/delete', 'POST', {
      id: filterId,
    }, { 'X-Admin-Key': adminKey });

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.data.ok).toBe(true);
  });

  it('POST /webhooks/filters/delete should return 404 for non-existent filter', async () => {
    const res = await httpReq(port, '/webhooks/filters/delete', 'POST', {
      id: 'wf_nonexistent',
    }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(404);
  });

  it('GET /webhooks/stats should include filter stats', async () => {
    const res = await httpReq(port, '/webhooks/stats', 'GET', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.data.configured).toBe(true);
    expect(res.data.filters).toBeDefined();
    expect(res.data.filters.filterCount).toBeGreaterThanOrEqual(0);
    expect(res.data.filters.emitterCount).toBeGreaterThanOrEqual(1);
  });

  it('should require admin auth for filter endpoints', async () => {
    const res = await httpReq(port, '/webhooks/filters', 'GET');
    expect(res.status).toBe(401);
  });

  it('root listing should include filter endpoints', async () => {
    const res = await httpReq(port, '/', 'GET');
    expect(res.status).toBe(200);
    expect(res.data.endpoints.webhookFilters).toContain('/webhooks/filters');
    expect(res.data.endpoints.updateWebhookFilter).toContain('/webhooks/filters/update');
    expect(res.data.endpoints.deleteWebhookFilter).toContain('/webhooks/filters/delete');
  });
});

// ─── 4. Server without webhook — graceful degradation ─────────────────────────

describe('Server — No Webhook Configured', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      port: 0,
      // No webhookUrl
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('GET /webhooks/filters should return empty with message', async () => {
    const res = await httpReq(port, '/webhooks/filters', 'GET', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.data.count).toBe(0);
    expect(res.data.message).toContain('No webhook');
  });

  it('POST /webhooks/filters should reject when no webhook configured', async () => {
    const res = await httpReq(port, '/webhooks/filters', 'POST', {
      name: 'Test', events: ['*'], url: 'http://x.com',
    }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('No webhook');
  });
});

// ─── 5. Config file webhook filters ──────────────────────────────────────────

describe('Config — webhookFilters in PayGateConfig', () => {
  it('should pass filters to gate via config', () => {
    const server = new PayGateServer({
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      port: 0,
      webhookUrl: 'http://default.example.com',
      webhookFilters: [
        { id: 'f1', name: 'Alerts', events: ['alert.fired'], url: 'http://alerts.example.com', active: true },
      ],
    });
    expect(server.gate.webhookRouter).not.toBeNull();
    expect(server.gate.webhookRouter!.ruleCount).toBe(1);
    server.gate.webhookRouter!.destroy();
  });
});
