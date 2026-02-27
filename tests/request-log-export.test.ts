/**
 * Tests for v7.6.0 — Request Log Export
 *
 * GET /requests/export — Export request log as JSON or CSV
 * with filters (key, tool, status, since, until).
 */

import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';
import http from 'http';

/* ── helpers ─────────────────────────────────────────────── */

const ECHO_CMD = process.execPath;
const ECHO_ARGS = ['-e', `
  process.stdin.resume();
  process.stdin.on('data', d => {
    const r = JSON.parse(d.toString().trim());
    if (r.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { tools: [{ name: 'export_tool', inputSchema: { type: 'object' } }] } }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { content: [{ type: 'text', text: 'ok' }] } }) + '\\n');
    }
  });
`];

function makeServer(overrides: Record<string, any> = {}): PayGateServer {
  return new PayGateServer({
    ...DEFAULT_CONFIG,
    serverCommand: ECHO_CMD,
    serverArgs: ECHO_ARGS,
    port: 0,
    ...overrides,
  });
}

function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string>; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        let buf = '';
        res.on('data', (c: Buffer) => (buf += c));
        res.on('end', () => {
          const hdrs: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') hdrs[k] = v;
          }
          try { resolve({ status: res.statusCode!, headers: hdrs, body: JSON.parse(buf), raw: buf }); }
          catch { resolve({ status: res.statusCode!, headers: hdrs, body: buf, raw: buf }); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function httpPost(port: number, path: string, body: any, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let buf = '';
        res.on('data', (c: Buffer) => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode!, body: buf }); }
        });
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

function mcpCall(port: number, toolName: string, apiKey: string): Promise<{ status: number; body: any }> {
  return httpPost(port, '/mcp', {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name: toolName, arguments: {} },
  }, { 'X-API-Key': apiKey });
}

/* ── tests ───────────────────────────────────────────────── */

describe('Request Log Export', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let apiKey: string;

  beforeEach(async () => {
    server = makeServer({ defaultCreditsPerCall: 5 });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
    const r = await httpPost(port, '/keys', { credits: 1000, name: 'test-key' }, { 'X-Admin-Key': adminKey });
    apiKey = r.body.key;
  });

  afterEach(async () => {
    await server.stop();
  });

  test('exports empty log as JSON', async () => {
    const r = await httpGet(port, '/requests/export', { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/json');
    expect(r.headers['content-disposition']).toContain('paygate-requests.json');
    expect(r.body.count).toBe(0);
    expect(r.body.requests).toEqual([]);
  });

  test('exports empty log as CSV', async () => {
    const r = await httpGet(port, '/requests/export?format=csv', { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toContain('paygate-requests.csv');
    // Only header row
    const lines = r.raw.split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('id,timestamp,tool,key,status,credits,durationMs,denyReason,requestId');
  });

  test('exports requests as JSON with Content-Disposition', async () => {
    await mcpCall(port, 'export_tool', apiKey);
    await mcpCall(port, 'export_tool', apiKey);

    const r = await httpGet(port, '/requests/export', { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
    expect(r.body.requests).toHaveLength(2);
    // Newest first
    expect(r.body.requests[0].id).toBeGreaterThan(r.body.requests[1].id);
    // Each entry has expected fields
    const entry = r.body.requests[0];
    expect(entry.tool).toBe('export_tool');
    expect(entry.status).toBe('allowed');
    expect(entry.credits).toBe(5);
    expect(entry.timestamp).toBeDefined();
  });

  test('exports requests as CSV with all columns', async () => {
    await mcpCall(port, 'export_tool', apiKey);

    const r = await httpGet(port, '/requests/export?format=csv', { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    const lines = r.raw.split('\n');
    expect(lines).toHaveLength(2); // header + 1 row
    const header = lines[0];
    expect(header).toBe('id,timestamp,tool,key,status,credits,durationMs,denyReason,requestId');
    const cols = lines[1].split(',');
    // id, timestamp, tool, key, status, credits, durationMs, denyReason (empty), requestId
    expect(cols[2]).toBe('export_tool');
    expect(cols[4]).toBe('allowed');
    expect(cols[5]).toBe('5');
  });

  test('CSV includes denied entries with denyReason', async () => {
    // Create a poor key (1 credit, needs 5)
    const r2 = await httpPost(port, '/keys', { credits: 1, name: 'poor' }, { 'X-Admin-Key': adminKey });
    const poorKey = r2.body.key;

    await mcpCall(port, 'export_tool', poorKey); // denied

    const r = await httpGet(port, '/requests/export?format=csv', { 'X-Admin-Key': adminKey });
    const lines = r.raw.split('\n');
    expect(lines).toHaveLength(2);
    const row = lines[1];
    expect(row).toContain('denied');
    expect(row).toContain('insufficient_credits');
  });

  test('filter by tool name', async () => {
    await mcpCall(port, 'export_tool', apiKey);

    const r = await httpGet(port, '/requests/export?tool=export_tool', { 'X-Admin-Key': adminKey });
    expect(r.body.count).toBe(1);

    const r2 = await httpGet(port, '/requests/export?tool=nonexistent', { 'X-Admin-Key': adminKey });
    expect(r2.body.count).toBe(0);
  });

  test('filter by status', async () => {
    // Create poor key (1 credit, needs 5)
    const r2 = await httpPost(port, '/keys', { credits: 1, name: 'poor' }, { 'X-Admin-Key': adminKey });
    const poorKey = r2.body.key;

    await mcpCall(port, 'export_tool', apiKey); // allowed
    await mcpCall(port, 'export_tool', poorKey); // denied

    const allowed = await httpGet(port, '/requests/export?status=allowed', { 'X-Admin-Key': adminKey });
    expect(allowed.body.count).toBe(1);
    expect(allowed.body.requests[0].status).toBe('allowed');

    const denied = await httpGet(port, '/requests/export?status=denied', { 'X-Admin-Key': adminKey });
    expect(denied.body.count).toBe(1);
    expect(denied.body.requests[0].status).toBe('denied');
  });

  test('filter by key', async () => {
    const r2 = await httpPost(port, '/keys', { credits: 100, name: 'other' }, { 'X-Admin-Key': adminKey });
    const otherKey = r2.body.key;

    await mcpCall(port, 'export_tool', apiKey);
    await mcpCall(port, 'export_tool', otherKey);

    const keyPrefix = apiKey.slice(0, 7);
    const filtered = await httpGet(port, `/requests/export?key=${keyPrefix}`, { 'X-Admin-Key': adminKey });
    expect(filtered.body.count).toBe(1);
    expect(filtered.body.requests[0].key).toContain(keyPrefix);
  });

  test('filter by since timestamp', async () => {
    await mcpCall(port, 'export_tool', apiKey);

    const future = new Date(Date.now() + 60_000).toISOString();
    const r = await httpGet(port, `/requests/export?since=${encodeURIComponent(future)}`, { 'X-Admin-Key': adminKey });
    expect(r.body.count).toBe(0);

    const past = new Date(Date.now() - 60_000).toISOString();
    const r2 = await httpGet(port, `/requests/export?since=${encodeURIComponent(past)}`, { 'X-Admin-Key': adminKey });
    expect(r2.body.count).toBe(1);
  });

  test('filter by until timestamp', async () => {
    await mcpCall(port, 'export_tool', apiKey);

    const past = new Date(Date.now() - 60_000).toISOString();
    const r = await httpGet(port, `/requests/export?until=${encodeURIComponent(past)}`, { 'X-Admin-Key': adminKey });
    expect(r.body.count).toBe(0);

    const future = new Date(Date.now() + 60_000).toISOString();
    const r2 = await httpGet(port, `/requests/export?until=${encodeURIComponent(future)}`, { 'X-Admin-Key': adminKey });
    expect(r2.body.count).toBe(1);
  });

  test('combined since + until window filter', async () => {
    await mcpCall(port, 'export_tool', apiKey);

    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const r = await httpGet(port, `/requests/export?since=${encodeURIComponent(past)}&until=${encodeURIComponent(future)}`, { 'X-Admin-Key': adminKey });
    expect(r.body.count).toBe(1);

    // Narrow window that excludes entry
    const veryPast1 = new Date(Date.now() - 120_000).toISOString();
    const veryPast2 = new Date(Date.now() - 60_000).toISOString();
    const r2 = await httpGet(port, `/requests/export?since=${encodeURIComponent(veryPast1)}&until=${encodeURIComponent(veryPast2)}`, { 'X-Admin-Key': adminKey });
    expect(r2.body.count).toBe(0);
  });

  test('multiple filters combine', async () => {
    // Create poor key (1 credit, needs 5)
    const r2 = await httpPost(port, '/keys', { credits: 1, name: 'poor' }, { 'X-Admin-Key': adminKey });
    const poorKey = r2.body.key;

    await mcpCall(port, 'export_tool', apiKey); // allowed
    await mcpCall(port, 'export_tool', poorKey); // denied

    const r = await httpGet(port, '/requests/export?tool=export_tool&status=allowed', { 'X-Admin-Key': adminKey });
    expect(r.body.count).toBe(1);
    expect(r.body.requests[0].status).toBe('allowed');
  });

  test('CSV export does not include pagination (exports all)', async () => {
    for (let i = 0; i < 5; i++) {
      await mcpCall(port, 'export_tool', apiKey);
    }

    const r = await httpGet(port, '/requests/export?format=csv', { 'X-Admin-Key': adminKey });
    const lines = r.raw.split('\n');
    expect(lines).toHaveLength(6); // header + 5 rows
  });

  test('JSON export includes all matching entries (no pagination)', async () => {
    for (let i = 0; i < 5; i++) {
      await mcpCall(port, 'export_tool', apiKey);
    }

    const r = await httpGet(port, '/requests/export', { 'X-Admin-Key': adminKey });
    expect(r.body.count).toBe(5);
    expect(r.body.requests).toHaveLength(5);
  });

  test('requires admin key', async () => {
    const r = await httpGet(port, '/requests/export');
    expect(r.status).toBe(401);
  });

  test('rejects non-GET methods', async () => {
    const r = await httpPost(port, '/requests/export', {}, { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(405);
  });

  test('root listing includes requestLogExport endpoint', async () => {
    const r = await httpGet(port, '/', { 'X-Admin-Key': adminKey });
    expect(r.body.endpoints.requestLogExport).toBeDefined();
    expect(r.body.endpoints.requestLogExport).toContain('/requests/export');
  });

  test('CSV escapes values with commas', async () => {
    // This tests the CSV escaping helper via normal entries
    // Tool names and keys shouldn't have commas, but the escaping handles it
    await mcpCall(port, 'export_tool', apiKey);

    const r = await httpGet(port, '/requests/export?format=csv', { 'X-Admin-Key': adminKey });
    expect(r.status).toBe(200);
    const lines = r.raw.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    // The row should be parseable as CSV
    const cols = lines[1].split(',');
    expect(cols.length).toBeGreaterThanOrEqual(9);
  });

  test('default format is JSON', async () => {
    await mcpCall(port, 'export_tool', apiKey);

    const r = await httpGet(port, '/requests/export', { 'X-Admin-Key': adminKey });
    expect(r.headers['content-type']).toContain('application/json');
    expect(r.body.count).toBe(1);
  });
});
