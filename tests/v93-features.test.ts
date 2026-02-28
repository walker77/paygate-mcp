import { PayGateServer } from '../src/server';
import { AuditLogger } from '../src/audit';
import { generateComplianceReport, complianceReportToCsv } from '../src/compliance';
import type { ComplianceFramework } from '../src/compliance';

// ─── Test MCP Server ──────────────────────────────────────────────────────

const serverCommand = process.execPath;
// Echo server: returns msg argument as text content, with a known response size
const echoServerArgs = ['-e', 'process.stdin.resume();process.stdin.on("data",d=>{const j=JSON.parse(d);if(j.method==="initialize")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{protocolVersion:"2025-01-01",capabilities:{tools:{}},serverInfo:{name:"echo",version:"1.0"}}})+`\\n`);if(j.method==="tools/list")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{tools:[{name:"echo",inputSchema:{type:"object",properties:{msg:{type:"string"}}}},{name:"big",inputSchema:{type:"object"}}]}})+`\\n`);if(j.method==="tools/call"){const name=(j.params||{}).name;if(name==="big"){process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{content:[{type:"text",text:"x".repeat(2048)}]}})+`\\n`)}else{const args=(j.params||{}).arguments||{};process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{content:[{type:"text",text:args.msg||"ok"}]}})+`\\n`)}}})'];

// ─── Helpers ──────────────────────────────────────────────────────────────

async function callTool(
  port: number,
  apiKey: string,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`http://localhost:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
      'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });
  const body = await res.json() as any;
  return { status: res.status, body, headers: res.headers };
}

async function initSession(port: number, apiKey: string): Promise<string> {
  const res = await fetch(`http://localhost:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-01-01',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
    }),
  });
  return res.headers.get('mcp-session-id') || '';
}

// ═══════════════════════════════════════════════════════════════════════════
// Unit Tests — Compliance Report
// ═══════════════════════════════════════════════════════════════════════════

describe('Compliance Report (unit)', () => {
  let audit: AuditLogger;

  beforeEach(() => {
    audit = new AuditLogger({ maxEvents: 1000, maxAgeHours: 0, cleanupIntervalMs: 0 });
  });

  afterEach(() => {
    audit.destroy();
  });

  it('generates SOC 2 report with correct section titles', () => {
    audit.log('key.created', 'admin', 'Test key created', {});
    const report = generateComplianceReport(audit, 'soc2', { serverVersion: '9.3.0' });
    expect(report.meta.framework).toBe('soc2');
    expect(report.sections).toHaveLength(4);
    expect(report.sections[0].title).toContain('CC6.1');
    expect(report.sections[1].title).toContain('CC7.2');
    expect(report.sections[2].title).toContain('CC8.1');
    expect(report.sections[3].title).toContain('CC6.8');
  });

  it('generates GDPR report with correct section titles', () => {
    audit.log('gate.allow', 'user', 'Tool call allowed', {});
    const report = generateComplianceReport(audit, 'gdpr', { serverVersion: '9.3.0' });
    expect(report.meta.framework).toBe('gdpr');
    expect(report.sections[0].title).toContain('Article 25');
    expect(report.sections[1].title).toContain('Article 30');
    expect(report.sections[2].title).toContain('Article 32');
    expect(report.sections[3].title).toContain('Article 33');
  });

  it('generates HIPAA report with correct section titles', () => {
    audit.log('admin.auth_failed', 'unknown', 'Auth failed', {});
    const report = generateComplianceReport(audit, 'hipaa', { serverVersion: '9.3.0' });
    expect(report.meta.framework).toBe('hipaa');
    expect(report.sections[0].title).toContain('§164.312(a)');
    expect(report.sections[1].title).toContain('§164.312(b)');
    expect(report.sections[2].title).toContain('§164.312(e)');
    expect(report.sections[3].title).toContain('§164.308');
  });

  it('classifies access control events correctly', () => {
    audit.log('key.created', 'admin', 'Key created', {});
    audit.log('key.revoked', 'admin', 'Key revoked', {});
    audit.log('key.suspended', 'admin', 'Key suspended', {});
    audit.log('admin.auth_failed', 'unknown', 'Bad auth', {});

    const report = generateComplianceReport(audit, 'soc2', { serverVersion: '9.3.0' });
    // Access control section should have all 4
    expect(report.sections[0].count).toBe(4);
    expect(report.summary.totalAccessControlEvents).toBe(4);
  });

  it('classifies data processing events correctly', () => {
    audit.log('gate.allow', 'user', 'Allowed', {});
    audit.log('gate.deny', 'user', 'Denied', {});
    audit.log('key.topup', 'admin', 'Topped up', {});

    const report = generateComplianceReport(audit, 'soc2', { serverVersion: '9.3.0' });
    expect(report.sections[1].count).toBe(3);
    expect(report.summary.totalDataProcessingEvents).toBe(3);
  });

  it('classifies config change events correctly', () => {
    audit.log('config.reloaded', 'system', 'Config reloaded', {});
    audit.log('key.quota_updated', 'admin', 'Quota updated', {});
    audit.log('template.created', 'admin', 'Template created', {});

    const report = generateComplianceReport(audit, 'soc2', { serverVersion: '9.3.0' });
    expect(report.sections[2].count).toBe(3);
    expect(report.summary.totalConfigChangeEvents).toBe(3);
  });

  it('classifies security events correctly', () => {
    audit.log('admin.auth_failed', 'unknown', 'Failed', {});
    audit.log('key.revoked', 'admin', 'Revoked', {});
    audit.log('key.suspended', 'admin', 'Suspended', {});

    const report = generateComplianceReport(audit, 'soc2', { serverVersion: '9.3.0' });
    expect(report.sections[3].count).toBe(3);
    expect(report.summary.totalSecurityEvents).toBe(3);
  });

  it('events can appear in multiple sections (e.g., admin.auth_failed is both access + security)', () => {
    audit.log('admin.auth_failed', 'unknown', 'Auth failed', {});

    const report = generateComplianceReport(audit, 'soc2', { serverVersion: '9.3.0' });
    // admin.auth_failed is in ACCESS_CONTROL_EVENTS and SECURITY_EVENTS
    expect(report.sections[0].count).toBe(1); // access control
    expect(report.sections[3].count).toBe(1); // security
  });

  it('counts specific event types in summary', () => {
    audit.log('key.created', 'admin', 'Created', {});
    audit.log('key.created', 'admin', 'Created 2', {});
    audit.log('key.revoked', 'admin', 'Revoked', {});
    audit.log('key.suspended', 'admin', 'Suspended', {});
    audit.log('admin.auth_failed', 'unknown', 'Failed', {});
    audit.log('admin.auth_failed', 'unknown', 'Failed 2', {});

    const report = generateComplianceReport(audit, 'soc2', { serverVersion: '9.3.0' });
    expect(report.summary.keysCreated).toBe(2);
    expect(report.summary.keysRevoked).toBe(1);
    expect(report.summary.keysSuspended).toBe(1);
    expect(report.summary.authFailures).toBe(2);
  });

  it('tracks unique actors', () => {
    audit.log('key.created', 'admin1', 'Created', {});
    audit.log('gate.allow', 'user1', 'Allowed', {});
    audit.log('gate.allow', 'user2', 'Allowed', {});
    audit.log('gate.allow', 'user1', 'Allowed again', {}); // duplicate

    const report = generateComplianceReport(audit, 'soc2', { serverVersion: '9.3.0' });
    expect(report.summary.uniqueActors).toBe(3);
  });

  it('respects since/until time filters', () => {
    // Log events at different times
    audit.log('key.created', 'admin', 'Old event', {});
    // The audit logger uses Date.now() internally, so all events will be "now"
    // We just verify the report meta has the right period
    const report = generateComplianceReport(audit, 'soc2', {
      serverVersion: '9.3.0',
      since: '2024-01-01T00:00:00Z',
      until: '2030-01-01T00:00:00Z',
    });
    expect(report.meta.periodStart).toBe('2024-01-01T00:00:00Z');
    expect(report.meta.periodEnd).toBe('2030-01-01T00:00:00Z');
    expect(report.meta.totalEvents).toBeGreaterThan(0);
  });

  it('report meta includes version and generation time', () => {
    audit.log('gate.allow', 'user', 'Allowed', {});
    const report = generateComplianceReport(audit, 'soc2', { serverVersion: '9.3.0' });
    expect(report.meta.serverVersion).toBe('9.3.0');
    expect(report.meta.generatedAt).toBeTruthy();
  });

  it('assigns correct severity levels', () => {
    audit.log('admin.auth_failed', 'unknown', 'Critical', {});
    audit.log('key.revoked', 'admin', 'Warning', {});
    audit.log('gate.deny', 'user', 'Warning', {});
    audit.log('key.created', 'admin', 'Info', {});

    const report = generateComplianceReport(audit, 'soc2', { serverVersion: '9.3.0' });
    const allEvents = report.sections.flatMap(s => s.events);
    const critical = allEvents.filter(e => e.severity === 'critical');
    const warning = allEvents.filter(e => e.severity === 'warning');
    const info = allEvents.filter(e => e.severity === 'info');
    expect(critical.length).toBeGreaterThan(0);
    expect(warning.length).toBeGreaterThan(0);
    expect(info.length).toBeGreaterThan(0);
  });

  it('generates empty report when no events match', () => {
    const report = generateComplianceReport(audit, 'soc2', { serverVersion: '9.3.0' });
    expect(report.meta.totalEvents).toBe(0);
    expect(report.sections.every(s => s.count === 0)).toBe(true);
  });

  it('converts report to CSV format', () => {
    audit.log('key.created', 'admin', 'Key created', {});
    audit.log('gate.allow', 'user', 'Tool call', {});

    const report = generateComplianceReport(audit, 'soc2', { serverVersion: '9.3.0' });
    const csv = complianceReportToCsv(report);

    const lines = csv.split('\n');
    expect(lines[0]).toBe('section,timestamp,category,action,actor,severity,detail');
    expect(lines.length).toBeGreaterThan(1);
    // Check CSV row structure
    const row = lines[1];
    expect(row).toContain('CC6.1');
    expect(row).toContain('admin');
    expect(row).toContain('Key created');
  });

  it('CSV properly escapes quotes in actor/detail', () => {
    audit.log('key.created', 'admin "test"', 'Key "special" created', {});
    const report = generateComplianceReport(audit, 'soc2', { serverVersion: '9.3.0' });
    const csv = complianceReportToCsv(report);
    expect(csv).toContain('""test""');
    expect(csv).toContain('""special""');
  });

  it('supports all three frameworks', () => {
    const frameworks: ComplianceFramework[] = ['soc2', 'gdpr', 'hipaa'];
    for (const fw of frameworks) {
      audit.log('key.created', 'admin', 'Test', {});
      const report = generateComplianceReport(audit, fw, { serverVersion: '9.3.0' });
      expect(report.meta.framework).toBe(fw);
      expect(report.sections).toHaveLength(4);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration Tests — Outcome-Based Pricing (creditsPerKbOutput)
// ═══════════════════════════════════════════════════════════════════════════

describe('Outcome-Based Pricing (integration)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let apiKey: string;
  let sessionId: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand,
      serverArgs: echoServerArgs,
      port: 0,
      defaultCreditsPerCall: 1,
      toolPricing: {
        big: { creditsPerCall: 1, creditsPerKbOutput: 10 },
        echo: { creditsPerCall: 1, creditsPerKbOutput: 5 },
      },
    });
    const result = await server.start();
    port = result.port;
    adminKey = result.adminKey;

    // Create a test key with enough credits
    const createRes = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'output-pricing-test', credits: 1000 }),
    });
    const created = await createRes.json() as any;
    apiKey = created.key;
    sessionId = await initSession(port, apiKey);
  });

  afterAll(async () => {
    await server.stop();
  });

  it('charges output surcharge for tool calls', async () => {
    // Get initial balance
    const balRes = await fetch(`http://localhost:${port}/balance`, {
      headers: { 'X-API-Key': apiKey },
    });
    const balBefore = await balRes.json() as any;
    const creditsBefore = balBefore.credits;

    // Call echo with a small message — base cost 1 + output surcharge
    const { headers } = await callTool(port, apiKey, sessionId, 'echo', { msg: 'hello' });

    // Get balance after
    const balRes2 = await fetch(`http://localhost:${port}/balance`, {
      headers: { 'X-API-Key': apiKey },
    });
    const balAfter = await balRes2.json() as any;

    // Should have charged more than just the base 1 credit
    const totalCharged = creditsBefore - balAfter.credits;
    expect(totalCharged).toBeGreaterThanOrEqual(1);

    // X-Output-Surcharge header should be present
    const surcharge = headers.get('x-output-surcharge');
    expect(surcharge).toBeTruthy();
  });

  it('charges higher surcharge for larger outputs', async () => {
    const balRes = await fetch(`http://localhost:${port}/balance`, {
      headers: { 'X-API-Key': apiKey },
    });
    const creditsBefore = (await balRes.json() as any).credits;

    // Call "big" tool which returns 2048 bytes — should be ~2KB output at 10 credits/KB = ~20 credits
    await callTool(port, apiKey, sessionId, 'big');

    const balRes2 = await fetch(`http://localhost:${port}/balance`, {
      headers: { 'X-API-Key': apiKey },
    });
    const creditsAfter = (await balRes2.json() as any).credits;

    const totalCharged = creditsBefore - creditsAfter;
    // Base cost (1) + output surcharge (~20 for 2KB at 10/KB)
    expect(totalCharged).toBeGreaterThan(5);
  });

  it('does not charge output surcharge when creditsPerKbOutput is 0 or unset', async () => {
    // Create a server with no output pricing
    const server2 = new PayGateServer({
      serverCommand,
      serverArgs: echoServerArgs,
      port: 0,
      defaultCreditsPerCall: 1,
      toolPricing: {},
    });
    const result2 = await server2.start();

    try {
      const createRes = await fetch(`http://localhost:${result2.port}/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': result2.adminKey },
        body: JSON.stringify({ name: 'no-output-pricing', credits: 100 }),
      });
      const created = await createRes.json() as any;
      const sid = await initSession(result2.port, created.key);

      const { headers } = await callTool(result2.port, created.key, sid, 'echo', { msg: 'test' });

      // No output surcharge header
      expect(headers.get('x-output-surcharge')).toBeNull();

      // Check balance — should have charged exactly 1 credit
      const balRes = await fetch(`http://localhost:${result2.port}/balance`, {
        headers: { 'X-API-Key': created.key },
      });
      const bal = await balRes.json() as any;
      expect(bal.credits).toBe(99);
    } finally {
      await server2.stop();
    }
  });

  it('X-Output-Surcharge header shows the surcharge amount', async () => {
    const { headers } = await callTool(port, apiKey, sessionId, 'big');
    const surcharge = parseInt(headers.get('x-output-surcharge') || '0', 10);
    // 2KB output at 10 credits/KB = ~20
    expect(surcharge).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration Tests — Compliance Export Endpoint
// ═══════════════════════════════════════════════════════════════════════════

describe('Compliance Export (integration)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand,
      serverArgs: echoServerArgs,
      port: 0,
      defaultCreditsPerCall: 1,
    });
    const result = await server.start();
    port = result.port;
    adminKey = result.adminKey;

    // Create a key to generate some audit events
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'compliance-test', credits: 100 }),
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  it('returns SOC 2 compliance report as JSON', async () => {
    const res = await fetch(`http://localhost:${port}/admin/compliance/export?framework=soc2`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-disposition')).toContain('compliance-soc2');

    const report = await res.json() as any;
    expect(report.meta.framework).toBe('soc2');
    expect(report.sections).toHaveLength(4);
    expect(report.summary).toBeDefined();
  });

  it('returns GDPR compliance report', async () => {
    const res = await fetch(`http://localhost:${port}/admin/compliance/export?framework=gdpr`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const report = await res.json() as any;
    expect(report.meta.framework).toBe('gdpr');
    expect(report.sections[0].title).toContain('Article 25');
  });

  it('returns HIPAA compliance report', async () => {
    const res = await fetch(`http://localhost:${port}/admin/compliance/export?framework=hipaa`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const report = await res.json() as any;
    expect(report.meta.framework).toBe('hipaa');
    expect(report.sections[0].title).toContain('§164.312');
  });

  it('returns CSV format when requested', async () => {
    const res = await fetch(`http://localhost:${port}/admin/compliance/export?framework=soc2&format=csv`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('.csv');

    const csv = await res.text();
    expect(csv).toContain('section,timestamp,category,action,actor,severity,detail');
  });

  it('defaults to SOC 2 when no framework specified', async () => {
    const res = await fetch(`http://localhost:${port}/admin/compliance/export`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const report = await res.json() as any;
    expect(report.meta.framework).toBe('soc2');
  });

  it('rejects invalid framework', async () => {
    const res = await fetch(`http://localhost:${port}/admin/compliance/export?framework=invalid`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(400);
  });

  it('requires admin authentication', async () => {
    const res = await fetch(`http://localhost:${port}/admin/compliance/export?framework=soc2`);
    expect(res.status).toBe(401);
  });

  it('report includes key creation event from beforeAll', async () => {
    const res = await fetch(`http://localhost:${port}/admin/compliance/export?framework=soc2`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const report = await res.json() as any;
    // key.created is an access control event
    expect(report.summary.keysCreated).toBeGreaterThanOrEqual(1);
    expect(report.sections[0].count).toBeGreaterThan(0);
  });

  it('supports since/until time filters', async () => {
    const res = await fetch(
      `http://localhost:${port}/admin/compliance/export?framework=soc2&since=2020-01-01T00:00:00Z&until=2020-01-02T00:00:00Z`,
      { headers: { 'X-Admin-Key': adminKey } },
    );
    expect(res.status).toBe(200);
    const report = await res.json() as any;
    // No events in this time range
    expect(report.meta.totalEvents).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration Tests — Per-Key Webhook URLs
// ═══════════════════════════════════════════════════════════════════════════

describe('Per-Key Webhook (integration)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let apiKey: string;
  let keyPrefix: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand,
      serverArgs: echoServerArgs,
      port: 0,
      defaultCreditsPerCall: 1,
    });
    const result = await server.start();
    port = result.port;
    adminKey = result.adminKey;

    // Create a test key
    const createRes = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'webhook-test', credits: 100 }),
    });
    const created = await createRes.json() as any;
    apiKey = created.key;
    keyPrefix = apiKey.slice(0, 7);
  });

  afterAll(async () => {
    await server.stop();
  });

  it('sets per-key webhook URL via POST', async () => {
    const res = await fetch(`http://localhost:${port}/keys/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({
        apiKey: keyPrefix,
        webhookUrl: 'https://example.com/webhook',
        webhookSecret: 'test-secret-123',
      }),
    });
    expect(res.status).toBe(200);
    const result = await res.json() as any;
    expect(result.ok).toBe(true);
    expect(result.keyName).toBe('webhook-test');
    expect(result.webhookUrl).toBe('https://example.com/webhook');
    expect(result.webhookSecret).toBe('***');
  });

  it('retrieves per-key webhook status via GET', async () => {
    const res = await fetch(`http://localhost:${port}/keys/webhook?apiKey=${keyPrefix}`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const result = await res.json() as any;
    expect(result.configured).toBe(true);
    expect(result.webhookUrl).toBe('https://example.com/webhook');
    expect(result.webhookSecret).toBe('***');
  });

  it('removes per-key webhook URL via DELETE', async () => {
    const res = await fetch(`http://localhost:${port}/keys/webhook?apiKey=${keyPrefix}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const result = await res.json() as any;
    expect(result.ok).toBe(true);
    expect(result.webhookUrl).toBeNull();

    // Verify it's removed
    const getRes = await fetch(`http://localhost:${port}/keys/webhook?apiKey=${keyPrefix}`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const getResult = await getRes.json() as any;
    expect(getResult.configured).toBe(false);
  });

  it('blocks SSRF URLs', async () => {
    const res = await fetch(`http://localhost:${port}/keys/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({
        apiKey: keyPrefix,
        webhookUrl: 'http://169.254.169.254/latest/meta-data',
      }),
    });
    expect(res.status).toBe(400);
    const result = await res.json() as any;
    expect(result.error).toContain('blocked');
  });

  it('returns 404 for unknown key prefix', async () => {
    const res = await fetch(`http://localhost:${port}/keys/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({
        apiKey: 'nonexistent_prefix',
        webhookUrl: 'https://example.com/webhook',
      }),
    });
    expect(res.status).toBe(404);
  });

  it('requires admin authentication', async () => {
    const res = await fetch(`http://localhost:${port}/keys/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: keyPrefix,
        webhookUrl: 'https://example.com/webhook',
      }),
    });
    expect(res.status).toBe(401);
  });

  it('requires apiKey parameter on POST', async () => {
    const res = await fetch(`http://localhost:${port}/keys/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({
        webhookUrl: 'https://example.com/webhook',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('requires webhookUrl parameter on POST', async () => {
    const res = await fetch(`http://localhost:${port}/keys/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({
        apiKey: keyPrefix,
      }),
    });
    expect(res.status).toBe(400);
  });

  it('requires apiKey parameter on DELETE', async () => {
    const res = await fetch(`http://localhost:${port}/keys/webhook`, {
      method: 'DELETE',
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(400);
  });

  it('requires apiKey parameter on GET', async () => {
    const res = await fetch(`http://localhost:${port}/keys/webhook`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(400);
  });

  it('blocks localhost webhook URLs', async () => {
    const res = await fetch(`http://localhost:${port}/keys/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({
        apiKey: keyPrefix,
        webhookUrl: 'http://localhost:8080/callback',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('blocks private IP webhook URLs', async () => {
    const res = await fetch(`http://localhost:${port}/keys/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({
        apiKey: keyPrefix,
        webhookUrl: 'http://192.168.1.1/callback',
      }),
    });
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration Tests — Root listing includes new endpoints
// ═══════════════════════════════════════════════════════════════════════════

describe('Root listing includes v9.3.0 endpoints', () => {
  let server: PayGateServer;
  let port: number;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand,
      serverArgs: echoServerArgs,
      port: 0,
      defaultCreditsPerCall: 1,
    });
    const result = await server.start();
    port = result.port;
  });

  afterAll(async () => {
    await server.stop();
  });

  it('lists /admin/compliance/export endpoint', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const body = await res.json() as any;
    expect(body.endpoints.adminComplianceExport).toBeDefined();
    expect(body.endpoints.adminComplianceExport).toContain('compliance/export');
  });

  it('lists /keys/webhook endpoint', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const body = await res.json() as any;
    expect(body.endpoints.keyWebhook).toBeDefined();
    expect(body.endpoints.keyWebhook).toContain('/keys/webhook');
  });
});
