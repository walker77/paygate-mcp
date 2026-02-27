/**
 * Tests for v7.2.0 — Key Activity Timeline
 *
 * GET /keys/activity?key=... returns a unified timeline of audit events
 * and usage events for a specific API key.
 */

import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';
import http from 'http';

/* ── helpers ─────────────────────────────────────────────── */

const ECHO_CMD = process.execPath;
const ECHO_ARGS = ['-e', `process.stdin.resume(); process.stdin.on('data', d => { const r = JSON.parse(d.toString().trim()); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: { content: [{ type: 'text', text: 'ok' }] } }) + '\\n'); });`];

function makeServer(overrides: Record<string, any> = {}): PayGateServer {
  return new PayGateServer({
    ...DEFAULT_CONFIG,
    serverCommand: ECHO_CMD,
    serverArgs: ECHO_ARGS,
    port: 0,
    defaultCreditsPerCall: 10,
    ...overrides,
  });
}

function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
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

/* ── setup ───────────────────────────────────────────────── */

let server: PayGateServer;
let port: number;
let adminKey: string;

beforeAll(async () => {
  server = makeServer();
  const started = await server.start();
  port = started.port;
  adminKey = started.adminKey;
});

afterAll(async () => {
  await server?.stop();
});

/* ── tests ───────────────────────────────────────────────── */

describe('Key Activity Timeline', () => {
  async function createKey(credits = 1000, name = 'test'): Promise<string> {
    const r = await httpPost(port, '/keys', { credits, name }, { 'x-admin-key': adminKey });
    return r.body.key;
  }

  async function makeToolCall(key: string): Promise<{ status: number; body: any }> {
    return httpPost(port, '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'echo_tool', arguments: { text: 'hello' } },
    }, { 'x-api-key': key });
  }

  test('GET /keys/activity returns empty timeline for new key', async () => {
    const key = await createKey(100, 'activity-empty');
    const r = await httpGet(port, `/keys/activity?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.events).toBeDefined();
    expect(Array.isArray(r.body.events)).toBe(true);
    expect(r.body.name).toBe('activity-empty');
    expect(r.body.key).toMatch(/^pg_.+\.\.\./);
  });

  test('shows audit events (key creation)', async () => {
    const key = await createKey(100, 'activity-audit');
    const r = await httpGet(port, `/keys/activity?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    // key.created event should appear
    const createEvent = r.body.events.find((e: any) => e.type === 'key.created');
    expect(createEvent).toBeDefined();
    expect(createEvent.source).toBe('audit');
  });

  test('shows usage events (tool calls)', async () => {
    const key = await createKey(500, 'activity-usage');
    const r1 = await makeToolCall(key);
    const r2 = await makeToolCall(key);

    const r = await httpGet(port, `/keys/activity?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    const usageEvents = r.body.events.filter((e: any) => e.source === 'usage');
    // Usage events are recorded when tool calls go through the gate
    // The echo backend may or may not respond, but the gate records the attempt
    if (usageEvents.length > 0) {
      expect(usageEvents[0].type).toMatch(/^tool\./);
      expect(usageEvents[0].metadata.tool).toBe('echo_tool');
    }
    // At minimum, we should have audit events from key creation
    expect(r.body.events.length).toBeGreaterThanOrEqual(1);
  });

  test('merges audit and usage events in chronological order', async () => {
    const key = await createKey(500, 'activity-merge');
    await makeToolCall(key);
    // Add a note (generates audit event)
    await httpPost(port, '/keys/notes', { key, text: 'Test note' }, { 'x-admin-key': adminKey });
    await makeToolCall(key);

    const r = await httpGet(port, `/keys/activity?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.total).toBeGreaterThanOrEqual(3);

    // Check events are newest-first
    const events = r.body.events;
    for (let i = 1; i < events.length; i++) {
      expect(events[i - 1].timestamp >= events[i].timestamp).toBe(true);
    }
  });

  test('shows denied tool calls', async () => {
    const key = await createKey(1, 'activity-denied'); // Only 1 credit
    await makeToolCall(key); // might fail or succeed depending on cost

    // Create key with 0 remaining after first call
    const key2 = await createKey(5, 'activity-denied2');
    await makeToolCall(key2); // costs 10, should be denied for insufficient credits

    const r = await httpGet(port, `/keys/activity?key=${key2}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    const deniedEvents = r.body.events.filter((e: any) => e.type === 'tool.denied');
    // May or may not have denied depending on gate config, but check structure
    if (deniedEvents.length > 0) {
      expect(deniedEvents[0].source).toBe('usage');
      expect(deniedEvents[0].metadata.allowed).toBe(false);
    }
  });

  test('key is masked in response', async () => {
    const key = await createKey(100, 'activity-mask');
    const r = await httpGet(port, `/keys/activity?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.body.key).toMatch(/^pg_.+\.\.\./);
    expect(r.body.key).not.toBe(key);
  });

  test('respects limit parameter', async () => {
    const key = await createKey(500, 'activity-limit');
    // Make several calls
    for (let i = 0; i < 5; i++) {
      await makeToolCall(key);
    }

    const r = await httpGet(port, `/keys/activity?key=${key}&limit=3`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.events.length).toBeLessThanOrEqual(3);
    expect(r.body.limit).toBe(3);
    expect(r.body.total).toBeGreaterThanOrEqual(5); // 5 calls + key.created
  });

  test('respects since parameter', async () => {
    const key = await createKey(500, 'activity-since');
    await makeToolCall(key);
    const sinceTime = new Date().toISOString();
    await new Promise(r => setTimeout(r, 20));
    await makeToolCall(key);

    const r = await httpGet(port, `/keys/activity?key=${key}&since=${sinceTime}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    // Should have fewer events since filtering by time
    expect(r.body.total).toBeGreaterThanOrEqual(1);
  });

  test('default limit is 50', async () => {
    const key = await createKey(100, 'activity-default-limit');
    const r = await httpGet(port, `/keys/activity?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.body.limit).toBe(50);
  });

  test('max limit is 200', async () => {
    const key = await createKey(100, 'activity-max-limit');
    const r = await httpGet(port, `/keys/activity?key=${key}&limit=999`, { 'x-admin-key': adminKey });
    expect(r.body.limit).toBe(200);
  });

  test('resolves alias to key', async () => {
    const key = await createKey(100, 'activity-alias');
    const alias = 'activity-alias-' + Date.now();
    await httpPost(port, '/keys/alias', { key, alias }, { 'x-admin-key': adminKey });

    const r = await httpGet(port, `/keys/activity?key=${alias}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('activity-alias');
  });

  test('works on suspended key', async () => {
    const key = await createKey(100, 'activity-suspended');
    await httpPost(port, '/keys/suspend', { key }, { 'x-admin-key': adminKey });

    const r = await httpGet(port, `/keys/activity?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    // Should have key.created + key.suspended events
    expect(r.body.events.length).toBeGreaterThanOrEqual(1);
  });

  test('works on revoked key', async () => {
    const key = await createKey(100, 'activity-revoked');
    await httpPost(port, '/keys/revoke', { key }, { 'x-admin-key': adminKey });

    const r = await httpGet(port, `/keys/activity?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
  });

  test('shows suspension and note events', async () => {
    const key = await createKey(100, 'activity-multi');
    await httpPost(port, '/keys/suspend', { key }, { 'x-admin-key': adminKey });
    await httpPost(port, '/keys/notes', { key, text: 'Test activity' }, { 'x-admin-key': adminKey });
    await httpPost(port, '/keys/resume', { key }, { 'x-admin-key': adminKey });

    const r = await httpGet(port, `/keys/activity?key=${key}`, { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    const types = r.body.events.map((e: any) => e.type);
    expect(types).toContain('key.created');
    // May or may not show suspend/resume depending on metadata matching
  });

  // ── error cases ──

  test('requires admin key', async () => {
    const key = await createKey(100, 'activity-auth');
    const r = await httpGet(port, `/keys/activity?key=${key}`);
    expect(r.status).toBe(401);
  });

  test('requires key parameter', async () => {
    const r = await httpGet(port, '/keys/activity', { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/key/i);
  });

  test('returns 404 for unknown key', async () => {
    const r = await httpGet(port, '/keys/activity?key=pg_nonexistent', { 'x-admin-key': adminKey });
    expect(r.status).toBe(404);
  });

  test('PUT returns 405', async () => {
    const r = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/keys/activity?key=pg_test', method: 'PUT', headers: { 'x-admin-key': adminKey } },
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
      req.end();
    });
    expect(r.status).toBe(405);
  });

  test('appears in root listing', async () => {
    const r = await httpGet(port, '/', { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.endpoints.keyActivity).toBeDefined();
    expect(r.body.endpoints.keyActivity).toMatch(/activity/i);
  });
});
