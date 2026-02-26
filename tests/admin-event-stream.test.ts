/**
 * Tests for v6.9.0 — Admin Event Stream
 *
 * GET /admin/events opens an SSE stream that broadcasts audit events in real-time.
 * Requires admin auth and Accept: text/event-stream header.
 * Supports optional ?types= filter for event type filtering.
 */

import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';
import http from 'http';

/* ── helpers ─────────────────────────────────────────────── */

const ECHO_CMD = process.execPath;
const ECHO_ARGS = ['-e', `process.stdin.resume(); process.stdin.on('data', d => { const r = JSON.parse(d.toString().trim()); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: {} }) + '\\n'); });`];

function makeServer(overrides: Record<string, any> = {}): PayGateServer {
  return new PayGateServer({
    ...DEFAULT_CONFIG,
    serverCommand: ECHO_CMD,
    serverArgs: ECHO_ARGS,
    port: 0,
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

/** Open an SSE connection and collect events until manually closed */
function openSseStream(
  port: number,
  path: string,
  headers: Record<string, string> = {}
): { events: Array<{ event: string; data: any }>; close: () => void; statusPromise: Promise<number> } {
  const events: Array<{ event: string; data: any }> = [];
  let req: http.ClientRequest;
  let statusResolve: (status: number) => void;
  const statusPromise = new Promise<number>((resolve) => { statusResolve = resolve; });

  req = http.request(
    {
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: { 'Accept': 'text/event-stream', ...headers },
    },
    (res) => {
      statusResolve(res.statusCode!);
      let buffer = '';
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        // Parse SSE events from buffer
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || ''; // Keep incomplete part
        for (const part of parts) {
          if (!part.trim() || part.trim().startsWith(':')) continue; // Skip keepalives and empty
          let eventType = 'message';
          let data = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7);
            else if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (data) {
            try {
              events.push({ event: eventType, data: JSON.parse(data) });
            } catch {
              events.push({ event: eventType, data });
            }
          }
        }
      });
    }
  );
  req.on('error', () => { /* ignore connection close errors */ });
  req.end();

  return {
    events,
    close: () => { req.destroy(); },
    statusPromise,
  };
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

describe('Admin Event Stream', () => {
  test('returns connected event on SSE open', async () => {
    const stream = openSseStream(port, '/admin/events', { 'x-admin-key': adminKey });
    const status = await stream.statusPromise;
    expect(status).toBe(200);
    // Wait for connected event
    await new Promise(r => setTimeout(r, 50));
    expect(stream.events.length).toBeGreaterThanOrEqual(1);
    expect(stream.events[0].event).toBe('connected');
    expect(stream.events[0].data.message).toMatch(/connected/i);
    stream.close();
  });

  test('streams key.created events', async () => {
    const stream = openSseStream(port, '/admin/events', { 'x-admin-key': adminKey });
    await stream.statusPromise;
    await new Promise(r => setTimeout(r, 50)); // Wait for connected event

    const beforeCount = stream.events.length;

    // Trigger an audit event by creating a key
    await httpPost(port, '/keys', { credits: 100, name: 'stream-test' }, { 'x-admin-key': adminKey });

    // Wait for event to arrive
    await new Promise(r => setTimeout(r, 100));

    const newEvents = stream.events.slice(beforeCount);
    const keyCreated = newEvents.find(e => e.data.type === 'key.created');
    expect(keyCreated).toBeDefined();
    expect(keyCreated!.event).toBe('audit');
    expect(keyCreated!.data.message).toMatch(/created/i);

    stream.close();
  });

  test('streams maintenance events', async () => {
    const stream = openSseStream(port, '/admin/events', { 'x-admin-key': adminKey });
    await stream.statusPromise;
    await new Promise(r => setTimeout(r, 50));

    const beforeCount = stream.events.length;

    // Enable maintenance mode
    await httpPost(port, '/maintenance', { enabled: true, message: 'Stream test' }, { 'x-admin-key': adminKey });
    // Disable maintenance mode
    await httpPost(port, '/maintenance', { enabled: false }, { 'x-admin-key': adminKey });

    await new Promise(r => setTimeout(r, 100));

    const newEvents = stream.events.slice(beforeCount);
    const enabled = newEvents.find(e => e.data.type === 'maintenance.enabled');
    const disabled = newEvents.find(e => e.data.type === 'maintenance.disabled');
    expect(enabled).toBeDefined();
    expect(disabled).toBeDefined();

    stream.close();
  });

  test('filters events by types parameter', async () => {
    const stream = openSseStream(port, '/admin/events?types=key.revoked', { 'x-admin-key': adminKey });
    await stream.statusPromise;
    await new Promise(r => setTimeout(r, 50));

    const beforeCount = stream.events.length;

    // Create a key (should NOT appear in stream)
    const keyResp = await httpPost(port, '/keys', { credits: 100, name: 'filter-test' }, { 'x-admin-key': adminKey });
    const key = keyResp.body.key;

    // Revoke it (SHOULD appear in stream)
    await httpPost(port, '/keys/revoke', { key }, { 'x-admin-key': adminKey });

    await new Promise(r => setTimeout(r, 100));

    const newEvents = stream.events.slice(beforeCount);
    // Should only have key.revoked, not key.created
    expect(newEvents.every(e => e.data.type === 'key.revoked')).toBe(true);
    expect(newEvents.length).toBeGreaterThanOrEqual(1);

    stream.close();
  });

  test('filters with multiple types', async () => {
    const stream = openSseStream(port, '/admin/events?types=key.created,key.revoked', { 'x-admin-key': adminKey });
    await stream.statusPromise;
    await new Promise(r => setTimeout(r, 50));

    const beforeCount = stream.events.length;

    // Create and revoke a key
    const keyResp = await httpPost(port, '/keys', { credits: 100, name: 'multi-filter' }, { 'x-admin-key': adminKey });
    const key = keyResp.body.key;
    await httpPost(port, '/keys/revoke', { key }, { 'x-admin-key': adminKey });

    await new Promise(r => setTimeout(r, 100));

    const newEvents = stream.events.slice(beforeCount);
    const types = new Set(newEvents.map(e => e.data.type));
    expect(types.has('key.created')).toBe(true);
    expect(types.has('key.revoked')).toBe(true);

    stream.close();
  });

  test('connected event shows filter info', async () => {
    const stream = openSseStream(port, '/admin/events?types=key.created', { 'x-admin-key': adminKey });
    await stream.statusPromise;
    await new Promise(r => setTimeout(r, 50));

    expect(stream.events[0].data.filters).toBe('key.created');
    stream.close();
  });

  test('connected event shows all when no filter', async () => {
    const stream = openSseStream(port, '/admin/events', { 'x-admin-key': adminKey });
    await stream.statusPromise;
    await new Promise(r => setTimeout(r, 50));

    expect(stream.events[0].data.filters).toBe('all');
    stream.close();
  });

  test('multiple clients receive same events', async () => {
    const stream1 = openSseStream(port, '/admin/events', { 'x-admin-key': adminKey });
    const stream2 = openSseStream(port, '/admin/events', { 'x-admin-key': adminKey });
    await Promise.all([stream1.statusPromise, stream2.statusPromise]);
    await new Promise(r => setTimeout(r, 50));

    const before1 = stream1.events.length;
    const before2 = stream2.events.length;

    await httpPost(port, '/keys', { credits: 100, name: 'multi-client' }, { 'x-admin-key': adminKey });
    await new Promise(r => setTimeout(r, 100));

    const new1 = stream1.events.slice(before1);
    const new2 = stream2.events.slice(before2);

    expect(new1.find(e => e.data.type === 'key.created')).toBeDefined();
    expect(new2.find(e => e.data.type === 'key.created')).toBeDefined();

    stream1.close();
    stream2.close();
  });

  test('event has audit event structure', async () => {
    const stream = openSseStream(port, '/admin/events', { 'x-admin-key': adminKey });
    await stream.statusPromise;
    await new Promise(r => setTimeout(r, 50));

    const beforeCount = stream.events.length;

    await httpPost(port, '/keys', { credits: 100, name: 'structure-test' }, { 'x-admin-key': adminKey });
    await new Promise(r => setTimeout(r, 100));

    const newEvents = stream.events.slice(beforeCount);
    const evt = newEvents.find(e => e.data.type === 'key.created');
    expect(evt).toBeDefined();
    expect(evt!.data.id).toEqual(expect.any(Number));
    expect(evt!.data.timestamp).toBeDefined();
    expect(evt!.data.type).toBe('key.created');
    expect(evt!.data.actor).toBeDefined();
    expect(evt!.data.message).toBeDefined();
    expect(evt!.data.metadata).toBeDefined();

    stream.close();
  });

  // ── auth + error cases ──

  test('requires admin key', async () => {
    const r = await httpGet(port, '/admin/events', { 'Accept': 'text/event-stream' });
    expect(r.status).toBe(401);
  });

  test('requires Accept: text/event-stream', async () => {
    const r = await httpGet(port, '/admin/events', { 'x-admin-key': adminKey });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/text\/event-stream/i);
  });

  test('rejects POST method', async () => {
    const r = await httpPost(port, '/admin/events', {}, { 'x-admin-key': adminKey });
    expect(r.status).toBe(405);
  });

  test('appears in root listing', async () => {
    const r = await httpGet(port, '/', { 'x-admin-key': adminKey });
    expect(r.status).toBe(200);
    expect(r.body.endpoints.adminEvents).toBeDefined();
    expect(r.body.endpoints.adminEvents).toMatch(/admin\/events/i);
  });

  test('stream cleans up on client disconnect', async () => {
    const stream = openSseStream(port, '/admin/events', { 'x-admin-key': adminKey });
    await stream.statusPromise;
    await new Promise(r => setTimeout(r, 50));

    // Close the connection
    stream.close();

    // Wait for cleanup
    await new Promise(r => setTimeout(r, 100));

    // Create a key — this should not throw even with disconnected client
    const r = await httpPost(port, '/keys', { credits: 100, name: 'cleanup-test' }, { 'x-admin-key': adminKey });
    expect(r.status).toBe(201);
  });

  test('topup event streams to connected clients', async () => {
    // Create a key first
    const keyResp = await httpPost(port, '/keys', { credits: 100, name: 'topup-stream' }, { 'x-admin-key': adminKey });
    const key = keyResp.body.key;

    const stream = openSseStream(port, '/admin/events?types=key.topup', { 'x-admin-key': adminKey });
    await stream.statusPromise;
    await new Promise(r => setTimeout(r, 50));

    const beforeCount = stream.events.length;

    // Topup the key
    await httpPost(port, '/topup', { key, credits: 50 }, { 'x-admin-key': adminKey });
    await new Promise(r => setTimeout(r, 100));

    const newEvents = stream.events.slice(beforeCount);
    expect(newEvents.find(e => e.data.type === 'key.topup')).toBeDefined();

    stream.close();
  });
});
