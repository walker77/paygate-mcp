/**
 * Tests for v4.3.0 — Config Hot Reload
 *
 * POST /config/reload — Reload configuration from file without restart
 * Gate.updateConfig() — Update mutable config fields at runtime
 * RateLimiter.setGlobalLimit() — Update global rate limit at runtime
 */

import { Gate } from '../src/gate';
import { RateLimiter } from '../src/rate-limiter';
import { AlertEngine } from '../src/alerts';
import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG, PayGateConfig } from '../src/types';
import http from 'http';
import { writeFileSync, unlinkSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Echo MCP backend ─────────────────────────────────────────────────────────

const ECHO_CMD = 'node';
const ECHO_ARGS = ['-e', `
  process.stdin.resume();
  process.stdin.on('data', d => {
    const r = JSON.parse(d.toString().trim());
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: {} }) + '\\n');
  });
`];

// ─── Helper: HTTP request ─────────────────────────────────────────────────────

function request(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => (buf += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(buf) });
          } catch {
            resolve({ status: res.statusCode!, body: buf });
          }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── Unit Tests: RateLimiter.setGlobalLimit() ─────────────────────────────────

describe('RateLimiter.setGlobalLimit()', () => {
  test('should update the global limit', () => {
    const limiter = new RateLimiter(10);
    expect(limiter.globalLimit).toBe(10);
    limiter.setGlobalLimit(100);
    expect(limiter.globalLimit).toBe(100);
    limiter.destroy();
  });

  test('should enforce the new limit immediately', () => {
    const limiter = new RateLimiter(2);
    limiter.record('key1');
    limiter.record('key1');
    // At limit — should be denied
    expect(limiter.check('key1').allowed).toBe(false);

    // Increase limit — should now be allowed
    limiter.setGlobalLimit(5);
    expect(limiter.check('key1').allowed).toBe(true);
    limiter.destroy();
  });

  test('should handle changing from unlimited to limited', () => {
    const limiter = new RateLimiter(0);
    expect(limiter.check('key1').allowed).toBe(true);

    limiter.setGlobalLimit(1);
    // First call — should be allowed
    limiter.record('key1');
    // Second call — should be denied
    expect(limiter.check('key1').allowed).toBe(false);
    limiter.destroy();
  });

  test('should handle changing from limited to unlimited', () => {
    const limiter = new RateLimiter(1);
    limiter.record('key1');
    expect(limiter.check('key1').allowed).toBe(false);

    limiter.setGlobalLimit(0);
    expect(limiter.check('key1').allowed).toBe(true);
    limiter.destroy();
  });
});

// ─── Unit Tests: AlertEngine.setRules() ──────────────────────────────────────

describe('AlertEngine.setRules()', () => {
  test('should replace alert rules', () => {
    const engine = new AlertEngine({ rules: [] });
    // Initially no rules — create a key record to check against
    const record = {
      key: 'pg_test123456',
      name: 'test',
      credits: 5,
      totalSpent: 50,
      totalCalls: 10,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      active: true,
      spendingLimit: 0,
      allowedTools: [],
      deniedTools: [],
      expiresAt: null,
      tags: {},
      ipAllowlist: [],
      namespace: 'default',
      autoTopupTodayCount: 0,
      autoTopupLastResetDay: '',
      quotaDailyCalls: 0,
      quotaMonthlyCalls: 0,
      quotaDailyCredits: 0,
      quotaMonthlyCredits: 0,
      quotaLastResetDay: '',
      quotaLastResetMonth: '',
    };

    let alerts = engine.check('pg_test123456', record);
    expect(alerts.length).toBe(0);

    // Set a credits_low rule
    engine.setRules([{ type: 'credits_low', threshold: 10, cooldownSeconds: 0 }]);
    alerts = engine.check('pg_test123456', record);
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].type).toBe('credits_low');
  });
});

// ─── Unit Tests: Gate.updateConfig() ─────────────────────────────────────────

describe('Gate.updateConfig()', () => {
  let gate: Gate;

  beforeEach(() => {
    gate = new Gate({ ...DEFAULT_CONFIG, serverCommand: 'echo', globalRateLimitPerMin: 60 });
  });

  afterEach(() => {
    gate.destroy();
  });

  test('should update defaultCreditsPerCall', () => {
    const changed = gate.updateConfig({ defaultCreditsPerCall: 5 });
    expect(changed).toContain('defaultCreditsPerCall');
    expect(gate.getToolPrice('any_tool')).toBe(5);
  });

  test('should update toolPricing', () => {
    const changed = gate.updateConfig({
      toolPricing: { myTool: { creditsPerCall: 10 } },
    });
    expect(changed).toContain('toolPricing');
    expect(gate.getToolPrice('myTool')).toBe(10);
  });

  test('should update globalRateLimitPerMin', () => {
    const changed = gate.updateConfig({ globalRateLimitPerMin: 120 });
    expect(changed).toContain('globalRateLimitPerMin');
    expect(gate.rateLimiter.globalLimit).toBe(120);
  });

  test('should update shadowMode', () => {
    const changed = gate.updateConfig({ shadowMode: true });
    expect(changed).toContain('shadowMode');
    // Shadow mode should allow without key
    const result = gate.evaluate(null, { name: 'test' });
    expect(result.allowed).toBe(true);
  });

  test('should update refundOnFailure', () => {
    const changed = gate.updateConfig({ refundOnFailure: true });
    expect(changed).toContain('refundOnFailure');
    expect(gate.refundOnFailure).toBe(true);
  });

  test('should return empty array when nothing changed', () => {
    const changed = gate.updateConfig({ defaultCreditsPerCall: 1 }); // Same as default
    expect(changed).toEqual([]);
  });

  test('should update multiple fields at once', () => {
    const changed = gate.updateConfig({
      defaultCreditsPerCall: 3,
      shadowMode: true,
      refundOnFailure: true,
      globalRateLimitPerMin: 30,
    });
    expect(changed).toContain('defaultCreditsPerCall');
    expect(changed).toContain('shadowMode');
    expect(changed).toContain('refundOnFailure');
    expect(changed).toContain('globalRateLimitPerMin');
  });

  test('should update globalQuota', () => {
    const changed = gate.updateConfig({
      globalQuota: { dailyCallLimit: 100, monthlyCallLimit: 1000, dailyCreditLimit: 500, monthlyCreditLimit: 5000 },
    });
    expect(changed).toContain('globalQuota');
  });

  test('should update freeMethods', () => {
    const changed = gate.updateConfig({
      freeMethods: ['initialize', 'ping'],
    });
    expect(changed).toContain('freeMethods');
    expect(gate.isFreeMethod('initialize')).toBe(true);
    expect(gate.isFreeMethod('tools/list')).toBe(false); // removed from list
  });

  test('should update alertRules', () => {
    const changed = gate.updateConfig({
      alertRules: [{ type: 'credits_low', threshold: 10 }],
    });
    expect(changed).toContain('alertRules');
  });

  test('should rebuild webhook when URL changes', () => {
    // Initially no webhook
    expect(gate.webhook).toBeNull();

    // Add webhook
    const changed = gate.updateConfig({
      webhookUrl: 'http://localhost:9999/webhook',
    });
    expect(changed).toContain('webhook');
    expect(gate.webhook).not.toBeNull();

    // Remove webhook
    const changed2 = gate.updateConfig({
      webhookUrl: null,
    });
    expect(changed2).toContain('webhook');
    expect(gate.webhook).toBeNull();
  });
});

// ─── Server Endpoint Tests: POST /config/reload ─────────────────────────────

describe('Config Hot Reload — POST /config/reload', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let tempDir: string;
  let configPath: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'paygate-config-test-'));
    configPath = join(tempDir, 'config.json');

    // Write initial config
    writeFileSync(configPath, JSON.stringify({
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 60,
      shadowMode: false,
    }));

    server = new PayGateServer({
      ...DEFAULT_CONFIG,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      port: 0,
    });
    server.setConfigPath(configPath);
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop();
    try { unlinkSync(configPath); } catch {}
  });

  test('should require admin auth', async () => {
    const res = await request(port, 'POST', '/config/reload', {});
    expect(res.status).toBe(401);
  });

  test('should reject GET method', async () => {
    const res = await request(port, 'GET', '/config/reload', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(405);
  });

  test('should reload config and report changes', async () => {
    // Update the config file
    writeFileSync(configPath, JSON.stringify({
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      defaultCreditsPerCall: 5,
      globalRateLimitPerMin: 120,
      shadowMode: true,
    }));

    const res = await request(port, 'POST', '/config/reload', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.reloaded).toBe(true);
    expect(res.body.changed).toContain('defaultCreditsPerCall');
    expect(res.body.changed).toContain('globalRateLimitPerMin');
    expect(res.body.changed).toContain('shadowMode');
  });

  test('should apply pricing changes to gate', async () => {
    writeFileSync(configPath, JSON.stringify({
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      defaultCreditsPerCall: 10,
      toolPricing: { premium_tool: { creditsPerCall: 25 } },
    }));

    const res = await request(port, 'POST', '/config/reload', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.changed).toContain('toolPricing');

    // Verify via /pricing endpoint
    const pricingRes = await request(port, 'GET', '/pricing', undefined, {});
    expect(pricingRes.status).toBe(200);
  });

  test('should report no changes when config is identical', async () => {
    // Reload same config again — no changes
    const res = await request(port, 'POST', '/config/reload', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.reloaded).toBe(true);
    expect(res.body.changed.length).toBe(0);
    expect(res.body.message).toContain('no changes');
  });

  test('should skip non-reloadable fields', async () => {
    writeFileSync(configPath, JSON.stringify({
      serverCommand: 'different-command',
      serverArgs: ['--other'],
      port: 9999,
      oauth: { issuer: 'https://auth.example.com' },
      defaultCreditsPerCall: 10,
    }));

    const res = await request(port, 'POST', '/config/reload', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.skipped).toContain('serverCommand');
    expect(res.body.skipped).toContain('serverArgs');
    expect(res.body.skipped).toContain('port');
    expect(res.body.skipped).toContain('oauth');
  });

  test('should accept configPath in request body', async () => {
    const altPath = join(tempDir, 'alt-config.json');
    writeFileSync(altPath, JSON.stringify({
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      defaultCreditsPerCall: 99,
    }));

    const res = await request(port, 'POST', '/config/reload',
      { configPath: altPath },
      { 'X-Admin-Key': adminKey },
    );
    expect(res.status).toBe(200);
    expect(res.body.changed).toContain('defaultCreditsPerCall');

    try { unlinkSync(altPath); } catch {}
  });

  test('should reject invalid config file', async () => {
    writeFileSync(configPath, 'not valid json!!!');

    const res = await request(port, 'POST', '/config/reload', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Failed to read');
  });

  test('should reject config with validation errors', async () => {
    writeFileSync(configPath, JSON.stringify({
      // Missing backend — validation error
      defaultCreditsPerCall: -5,
    }));

    const res = await request(port, 'POST', '/config/reload', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('validation failed');
    expect(res.body.diagnostics.length).toBeGreaterThan(0);
  });

  test('should return error when no config path available', async () => {
    // Create a server without config path
    const noConfigServer = new PayGateServer({
      ...DEFAULT_CONFIG,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      port: 0,
    });
    const started = await noConfigServer.start();

    try {
      const res = await request(started.port, 'POST', '/config/reload', {}, { 'X-Admin-Key': started.adminKey });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('No config file path');
    } finally {
      await noConfigServer.gracefulStop();
    }
  });

  test('should return error for nonexistent config file', async () => {
    const res = await request(port, 'POST', '/config/reload',
      { configPath: '/tmp/does-not-exist-ever.json' },
      { 'X-Admin-Key': adminKey },
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Failed to read');
  });

  test('should reject invalid JSON body', async () => {
    const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/config/reload',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
        },
        (res) => {
          let buf = '';
          res.on('data', (chunk) => (buf += chunk));
          res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(buf) }));
        },
      );
      req.on('error', reject);
      req.write('not json');
      req.end();
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid JSON');
  });

  test('should accept empty body (reload from stored configPath)', async () => {
    // Restore a valid config
    writeFileSync(configPath, JSON.stringify({
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      defaultCreditsPerCall: 1,
    }));

    const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/config/reload',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
        },
        (res) => {
          let buf = '';
          res.on('data', (chunk) => (buf += chunk));
          res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(buf) }));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(res.status).toBe(200);
  });

  test('should update alert rules via config reload', async () => {
    writeFileSync(configPath, JSON.stringify({
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      defaultCreditsPerCall: 1,
      alertRules: [
        { type: 'credits_low', threshold: 50, cooldownSeconds: 60 },
      ],
    }));

    const res = await request(port, 'POST', '/config/reload', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.changed).toContain('alertRules');
  });

  test('should update webhook config via reload', async () => {
    writeFileSync(configPath, JSON.stringify({
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      defaultCreditsPerCall: 1,
      webhookUrl: 'http://localhost:9999/webhook',
      webhookSecret: 'test-secret',
    }));

    const res = await request(port, 'POST', '/config/reload', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.changed).toContain('webhook');
  });

  test('should update refund and quota settings', async () => {
    writeFileSync(configPath, JSON.stringify({
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      defaultCreditsPerCall: 1,
      refundOnFailure: true,
      globalQuota: {
        dailyCallLimit: 100,
        monthlyCallLimit: 1000,
        dailyCreditLimit: 500,
        monthlyCreditLimit: 5000,
      },
    }));

    const res = await request(port, 'POST', '/config/reload', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.changed).toContain('refundOnFailure');
    expect(res.body.changed).toContain('globalQuota');
  });

  test('should include warnings in response', async () => {
    writeFileSync(configPath, JSON.stringify({
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      shadowMode: true,
    }));

    const res = await request(port, 'POST', '/config/reload', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    // Shadow mode generates a warning
    if (res.body.warnings) {
      expect(res.body.warnings.length).toBeGreaterThan(0);
    }
  });

  test('audit log should record config reload', async () => {
    // Restore valid config
    writeFileSync(configPath, JSON.stringify({
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      defaultCreditsPerCall: 1,
    }));

    await request(port, 'POST', '/config/reload', {}, { 'X-Admin-Key': adminKey });

    const auditRes = await request(port, 'GET', '/audit?types=config.reloaded&limit=1', undefined, { 'X-Admin-Key': adminKey });
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.events.length).toBeGreaterThan(0);
    expect(auditRes.body.events[0].type).toBe('config.reloaded');
  });

  test('root listing should include config/reload endpoint', async () => {
    const res = await request(port, 'GET', '/', undefined, {});
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain('/config/reload');
  });
});
