/**
 * v9.4.0 Feature Tests:
 *   1. Content Guardrails (PII detection/redaction)
 *   2. IP Country Restrictions (geo-fencing)
 *   3. Bulk Key Operations (suspend/resume additions)
 */

import { ContentGuardrails, BUILT_IN_RULES, GuardrailRule } from '../src/guardrails';
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
          { name: 'sensitive', description: 'Returns sensitive data', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
        ] } }) + '\\n');
      } else if (req.method === 'tools/call') {
        const args = req.params?.arguments || {};
        if (req.params?.name === 'sensitive') {
          // Return output containing PII
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'Card: 4111111111111111, SSN: 123-45-6789' }] } }) + '\\n');
        } else {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: args.msg || 'ok' }] } }) + '\\n');
        }
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
// 1. Content Guardrails — Unit Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('ContentGuardrails (unit)', () => {
  test('detects credit card numbers', () => {
    const gr = new ContentGuardrails({ enabled: true });
    const result = gr.check('My card is 4111111111111111', 'echo', 'input', 'pk_test_12');
    expect(result.blocked).toBe(true);
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    expect(result.violations[0].ruleId).toBe('pii_credit_card');
  });

  test('detects SSN patterns', () => {
    const gr = new ContentGuardrails({ enabled: true });
    const result = gr.check('SSN: 123-45-6789', 'echo', 'input', 'pk_test_12');
    expect(result.blocked).toBe(true);
    expect(result.violations.some(v => v.ruleId === 'pii_ssn')).toBe(true);
  });

  test('detects email addresses (log action, not block)', () => {
    const gr = new ContentGuardrails({ enabled: true });
    const result = gr.check('Contact user@example.com for info', 'echo', 'input', 'pk_test_12');
    expect(result.blocked).toBe(false); // email is log, not block
    expect(result.violations.some(v => v.ruleId === 'pii_email')).toBe(true);
  });

  test('detects AWS access keys', () => {
    const gr = new ContentGuardrails({ enabled: true });
    const result = gr.check('Use AKIAIOSFODNN7EXAMPLE to connect', 'echo', 'input', 'pk_test_12');
    expect(result.blocked).toBe(true);
    expect(result.violations.some(v => v.ruleId === 'secret_aws_key')).toBe(true);
  });

  test('detects IBAN numbers', () => {
    const gr = new ContentGuardrails({ enabled: true });
    const result = gr.check('Transfer to GB29NWBK60161331926819', 'echo', 'input', 'pk_test_12');
    expect(result.blocked).toBe(true);
    expect(result.violations.some(v => v.ruleId === 'pii_iban')).toBe(true);
  });

  test('does not trigger on clean content', () => {
    const gr = new ContentGuardrails({ enabled: true });
    const result = gr.check('Hello world, this is a normal message', 'echo', 'input', 'pk_test_12');
    expect(result.blocked).toBe(false);
    expect(result.violations.length).toBe(0);
  });

  test('disabled guardrails skip all checks', () => {
    const gr = new ContentGuardrails({ enabled: false });
    const result = gr.check('Card: 4111111111111111', 'echo', 'input', 'pk_test_12');
    expect(result.blocked).toBe(false);
    expect(result.violations.length).toBe(0);
  });

  test('redact action replaces matched content', () => {
    const rules: GuardrailRule[] = [{
      id: 'test_redact',
      name: 'Test Redact',
      pattern: '\\b\\d{4}[-\\s]?\\d{4}[-\\s]?\\d{4}[-\\s]?\\d{4}\\b',
      action: 'redact',
      active: true,
      scope: 'both',
      tools: [],
    }];
    const gr = new ContentGuardrails({ enabled: true, rules });
    const result = gr.check('Pay with 4111 1111 1111 1111 now', 'echo', 'input', 'pk_test_12');
    expect(result.blocked).toBe(false);
    expect(result.redactedContent).toBeDefined();
    expect(result.redactedContent).toContain('[REDACTED]');
    expect(result.redactedContent).not.toContain('4111');
  });

  test('warn action adds warning messages', () => {
    const rules: GuardrailRule[] = [{
      id: 'test_warn',
      name: 'Test Warn',
      pattern: 'secret_data',
      action: 'warn',
      active: true,
      scope: 'both',
      tools: [],
    }];
    const gr = new ContentGuardrails({ enabled: true, rules });
    const result = gr.check('Contains secret_data here', 'echo', 'input', 'pk_test_12');
    expect(result.blocked).toBe(false);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('Test Warn');
  });

  test('scope filtering: input-only rule does not trigger on output', () => {
    const rules: GuardrailRule[] = [{
      id: 'input_only',
      name: 'Input Only',
      pattern: 'forbidden',
      action: 'block',
      active: true,
      scope: 'input',
      tools: [],
    }];
    const gr = new ContentGuardrails({ enabled: true, rules });
    expect(gr.check('forbidden', 'echo', 'input', 'pk').blocked).toBe(true);
    expect(gr.check('forbidden', 'echo', 'output', 'pk').blocked).toBe(false);
  });

  test('tool filtering: rule only triggers for specified tools', () => {
    const rules: GuardrailRule[] = [{
      id: 'tool_specific',
      name: 'Tool Specific',
      pattern: 'block_me',
      action: 'block',
      active: true,
      scope: 'both',
      tools: ['sensitive'],
    }];
    const gr = new ContentGuardrails({ enabled: true, rules });
    expect(gr.check('block_me', 'sensitive', 'input', 'pk').blocked).toBe(true);
    expect(gr.check('block_me', 'echo', 'input', 'pk').blocked).toBe(false);
  });

  test('inactive rules are skipped', () => {
    const rules: GuardrailRule[] = [{
      id: 'inactive_rule',
      name: 'Inactive',
      pattern: 'should_not_match',
      action: 'block',
      active: false,
      scope: 'both',
      tools: [],
    }];
    const gr = new ContentGuardrails({ enabled: true, rules });
    expect(gr.check('should_not_match', 'echo', 'input', 'pk').blocked).toBe(false);
  });

  test('upsert adds and updates rules', () => {
    const gr = new ContentGuardrails({ enabled: true, rules: [] });
    expect(gr.getRules().length).toBe(0);

    gr.upsertRule({ id: 'custom', name: 'Custom', pattern: 'test', action: 'block', active: true, scope: 'both', tools: [] });
    expect(gr.getRules().length).toBe(1);

    gr.upsertRule({ id: 'custom', name: 'Custom Updated', pattern: 'test2', action: 'warn', active: true, scope: 'both', tools: [] });
    expect(gr.getRules().length).toBe(1);
    expect(gr.getRules()[0].name).toBe('Custom Updated');
    expect(gr.getRules()[0].action).toBe('warn');
  });

  test('remove deletes a rule', () => {
    const gr = new ContentGuardrails({ enabled: true });
    const initialCount = gr.getRules().length;
    gr.removeRule('pii_credit_card');
    expect(gr.getRules().length).toBe(initialCount - 1);
    expect(gr.getRules().find(r => r.id === 'pii_credit_card')).toBeUndefined();
  });

  test('violation tracking and stats', () => {
    const gr = new ContentGuardrails({ enabled: true });
    gr.check('4111111111111111', 'echo', 'input', 'pk_test');
    gr.check('user@test.com', 'echo', 'input', 'pk_test');

    const stats = gr.getStats();
    expect(stats.totalViolations).toBeGreaterThanOrEqual(2);
    expect(stats.byRule['pii_credit_card']).toBeGreaterThanOrEqual(1);

    const violations = gr.getViolations(10);
    expect(violations.total).toBeGreaterThanOrEqual(2);
  });

  test('queryViolations filters by ruleId', () => {
    const gr = new ContentGuardrails({ enabled: true });
    gr.check('4111111111111111', 'echo', 'input', 'pk_test');
    gr.check('user@test.com', 'tool2', 'input', 'pk_test');

    const result = gr.queryViolations({ ruleId: 'pii_email' });
    expect(result.violations.every(v => v.ruleId === 'pii_email')).toBe(true);
  });

  test('clearViolations resets history', () => {
    const gr = new ContentGuardrails({ enabled: true });
    gr.check('4111111111111111', 'echo', 'input', 'pk_test');
    const count = gr.clearViolations();
    expect(count).toBeGreaterThan(0);
    expect(gr.getViolations().total).toBe(0);
  });

  test('import/export rules roundtrip', () => {
    const gr = new ContentGuardrails({ enabled: true });
    const exported = gr.exportRules();
    const gr2 = new ContentGuardrails({ enabled: true, rules: [] });
    const imported = gr2.importRules(exported);
    expect(imported).toBe(exported.length);
    expect(gr2.getRules().length).toBe(exported.length);
  });

  test('toggle enabled/disabled at runtime', () => {
    const gr = new ContentGuardrails({ enabled: false });
    expect(gr.isEnabled).toBe(false);
    gr.setEnabled(true);
    expect(gr.isEnabled).toBe(true);
  });

  test('BUILT_IN_RULES contains standard patterns', () => {
    expect(BUILT_IN_RULES.length).toBeGreaterThanOrEqual(7);
    expect(BUILT_IN_RULES.find(r => r.id === 'pii_credit_card')).toBeDefined();
    expect(BUILT_IN_RULES.find(r => r.id === 'pii_ssn')).toBeDefined();
    expect(BUILT_IN_RULES.find(r => r.id === 'pii_email')).toBeDefined();
    expect(BUILT_IN_RULES.find(r => r.id === 'secret_aws_key')).toBeDefined();
  });

  test('includeContext provides masked match context', () => {
    const gr = new ContentGuardrails({ enabled: true, includeContext: true });
    const result = gr.check('Card: 4111111111111111', 'echo', 'input', 'pk_test');
    const ccViolation = result.violations.find(v => v.ruleId === 'pii_credit_card');
    expect(ccViolation?.context).toBeDefined();
    expect(ccViolation?.context).toContain('***');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Content Guardrails — Integration Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Content Guardrails (integration)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let apiKey: string;

  beforeAll(async () => {
    ({ server, port, adminKey } = await startServer({ guardrails: { enabled: true } }));
    const created = await createKey(port, adminKey, 1000);
    apiKey = created.key;
  });

  afterAll(async () => {
    await server.stop();
  });

  test('GET /admin/guardrails returns rules and stats', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/guardrails`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.enabled).toBe(true);
    expect(body.rules).toBeDefined();
    expect(body.rules.length).toBeGreaterThan(0);
    expect(body.stats).toBeDefined();
  });

  test('POST /admin/guardrails toggles enabled state', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/guardrails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.enabled).toBe(false);

    // Re-enable
    await fetch(`http://127.0.0.1:${port}/admin/guardrails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ enabled: true }),
    });
  });

  test('POST /admin/guardrails upserts a custom rule', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/guardrails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({
        rule: {
          id: 'test_custom',
          name: 'Test Custom',
          pattern: 'CUSTOM_SECRET_\\d+',
          action: 'block',
          active: true,
          scope: 'both',
          tools: [],
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.rule.id).toBe('test_custom');
  });

  test('DELETE /admin/guardrails?id= removes a rule', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/guardrails?id=test_custom`, {
      method: 'DELETE',
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.deleted).toBe('test_custom');
  });

  test('tool call with credit card in input is blocked', async () => {
    const res = await callTool(port, apiKey, 'echo', { msg: 'Pay with 4111111111111111' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32406);
    expect(body.error.message).toContain('Content policy violation');
  });

  test('tool call with clean input passes through', async () => {
    const res = await callTool(port, apiKey, 'echo', { msg: 'Hello clean world' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
  });

  test('tool call with sensitive output is blocked', async () => {
    const res = await callTool(port, apiKey, 'sensitive', { query: 'get data' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // Output contains credit card and SSN, should be blocked
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32406);
  });

  test('GET /admin/guardrails/violations returns logged violations', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/guardrails/violations`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.violations).toBeDefined();
    expect(body.total).toBeGreaterThan(0);
  });

  test('DELETE /admin/guardrails/violations clears all', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/guardrails/violations`, {
      method: 'DELETE',
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.cleared).toBeGreaterThanOrEqual(0);
  });

  test('guardrails requires admin auth', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/guardrails`);
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. IP Country Restrictions (Geo-fencing)
// ═══════════════════════════════════════════════════════════════════════════

describe('IP Country Restrictions (geo-fencing)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let apiKey: string;

  beforeAll(async () => {
    ({ server, port, adminKey } = await startServer({ geoCountryHeader: 'X-Country' }));
    const created = await createKey(port, adminKey, 1000);
    apiKey = created.key;
  });

  afterAll(async () => {
    await server.stop();
  });

  test('POST /keys/geo sets allowed countries', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/keys/geo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ key: apiKey.slice(0, 10), allowedCountries: ['US', 'GB', 'DE'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.allowedCountries).toEqual(['US', 'GB', 'DE']);
  });

  test('GET /keys/geo returns current restrictions', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/keys/geo?key=${apiKey.slice(0, 10)}`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.allowedCountries).toEqual(['US', 'GB', 'DE']);
  });

  test('tool call from allowed country succeeds', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        'X-Country': 'US',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { msg: 'geo ok' } } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.error).toBeUndefined();
  });

  test('tool call from denied country is rejected', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        'X-Country': 'CN',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { msg: 'geo blocked' } } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.error).toBeDefined();
    expect(body.error.message).toContain('country_not_allowed');
  });

  test('POST /keys/geo sets denied countries', async () => {
    // Clear allowed, set denied
    const res = await fetch(`http://127.0.0.1:${port}/keys/geo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ key: apiKey.slice(0, 10), allowedCountries: [], deniedCountries: ['RU', 'KP'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.deniedCountries).toEqual(['RU', 'KP']);
  });

  test('tool call from denied-listed country is rejected', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        'X-Country': 'RU',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { msg: 'denied' } } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.error).toBeDefined();
    expect(body.error.message).toContain('country_denied');
  });

  test('tool call from non-denied country passes', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        'X-Country': 'US',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { msg: 'not denied' } } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.error).toBeUndefined();
  });

  test('DELETE /keys/geo clears all restrictions', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/keys/geo?key=${apiKey.slice(0, 10)}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.allowedCountries).toEqual([]);
    expect(body.deniedCountries).toEqual([]);
  });

  test('tool call without country header passes (no restriction)', async () => {
    const res = await callTool(port, apiKey, 'echo', { msg: 'no country header' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.error).toBeUndefined();
  });

  test('POST /keys/geo rejects invalid country codes', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/keys/geo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ key: apiKey.slice(0, 10), allowedCountries: ['USA'] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain('Invalid country code');
  });

  test('POST /keys/geo requires admin auth', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/keys/geo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: apiKey.slice(0, 10), allowedCountries: ['US'] }),
    });
    expect(res.status).toBe(401);
  });

  test('GET /keys/geo returns 404 for unknown key', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/keys/geo?key=nonexistent`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Bulk Key Operations — suspend/resume additions
// ═══════════════════════════════════════════════════════════════════════════

describe('Bulk Key Operations (suspend/resume)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let key1: string;
  let key2: string;

  beforeAll(async () => {
    ({ server, port, adminKey } = await startServer());
    const k1 = await createKey(port, adminKey, 500, { name: 'bulk-test-1' });
    const k2 = await createKey(port, adminKey, 500, { name: 'bulk-test-2' });
    key1 = k1.key;
    key2 = k2.key;
  });

  afterAll(async () => {
    await server.stop();
  });

  test('bulk suspend suspends multiple keys', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/keys/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({
        operations: [
          { action: 'suspend', key: key1 },
          { action: 'suspend', key: key2 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.succeeded).toBe(2);
    expect(body.failed).toBe(0);
    expect(body.results[0].success).toBe(true);
    expect(body.results[1].success).toBe(true);
  });

  test('suspended keys are rejected for tool calls', async () => {
    const res = await callTool(port, key1, 'echo', { msg: 'should fail' });
    const body = await res.json() as any;
    expect(body.error).toBeDefined();
    expect(body.error.message).toContain('key_suspended');
  });

  test('bulk resume resumes multiple keys', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/keys/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({
        operations: [
          { action: 'resume', key: key1 },
          { action: 'resume', key: key2 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.succeeded).toBe(2);
    expect(body.results[0].success).toBe(true);
  });

  test('resumed keys work for tool calls', async () => {
    const res = await callTool(port, key1, 'echo', { msg: 'should work now' });
    const body = await res.json() as any;
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
  });

  test('bulk suspend handles missing key gracefully', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/keys/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({
        operations: [
          { action: 'suspend', key: key1 },
          { action: 'suspend', key: 'nonexistent_key_12345' },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.results[1].error).toContain('Key not found');
  });

  test('already suspended key returns success with flag', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/keys/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({
        operations: [
          { action: 'suspend', key: key1 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results[0].success).toBe(true);
    expect(body.results[0].result?.alreadySuspended).toBe(true);

    // Resume for cleanup
    await fetch(`http://127.0.0.1:${port}/keys/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ operations: [{ action: 'resume', key: key1 }] }),
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Root Listing — New endpoints appear
// ═══════════════════════════════════════════════════════════════════════════

describe('Root listing (v9.4.0 endpoints)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    ({ server, port, adminKey } = await startServer());
  });

  afterAll(async () => {
    await server.stop();
  });

  test('root listing includes adminGuardrails', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const body = await res.json() as any;
    expect(body.endpoints.adminGuardrails).toContain('/admin/guardrails');
  });

  test('root listing includes keyGeo', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const body = await res.json() as any;
    expect(body.endpoints.keyGeo).toContain('/keys/geo');
  });

  test('root listing includes adminGuardrailViolations', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const body = await res.json() as any;
    expect(body.endpoints.adminGuardrailViolations).toContain('/admin/guardrails/violations');
  });
});
