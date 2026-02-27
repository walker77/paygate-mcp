/**
 * Tests for v4.9.0 — Webhook Pause/Resume.
 *
 * Covers:
 *   - POST /webhooks/pause pauses webhook delivery
 *   - POST /webhooks/resume resumes and flushes buffered events
 *   - Events are buffered during pause (not lost)
 *   - /webhooks/stats shows paused state and buffered count
 *   - Double-pause returns "already paused"
 *   - Resume when not paused returns "not paused"
 *   - Requires admin auth
 *   - Method validation (POST only)
 *   - Returns 400 when no webhook configured
 *   - Audit trail for pause/resume
 *   - Root listing includes endpoints
 */

import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';
import http from 'http';

// ─── Helper: make HTTP request ──────────────────────────────────────────────

function request(port: number, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode!, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Webhook receiver helper ────────────────────────────────────────────────

function createWebhookReceiver(): Promise<{
  server: http.Server;
  port: number;
  receivedRequests: Array<{ body: any }>;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const receivedRequests: Array<{ body: any }> = [];

    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        try {
          receivedRequests.push({ body: JSON.parse(data) });
        } catch {
          receivedRequests.push({ body: data });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      resolve({
        server,
        port: addr.port,
        receivedRequests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const ECHO_CMD = 'node';
const ECHO_ARGS = ['-e', 'process.stdin.resume(); process.stdin.on("data", d => { const r = JSON.parse(d.toString().trim()); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: {} }) + "\\n"); });'];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Webhook Pause/Resume', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let receiver: Awaited<ReturnType<typeof createWebhookReceiver>>;

  beforeAll(async () => {
    receiver = await createWebhookReceiver();

    server = new PayGateServer({
      ...DEFAULT_CONFIG,
      port: 0,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      webhookUrl: `http://127.0.0.1:${receiver.port}/webhook`,
      webhookSsrfAtDelivery: false,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.stop();
    await receiver.close();
  });

  test('POST /webhooks/pause pauses delivery', async () => {
    const res = await request(port, 'POST', '/webhooks/pause', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(true);
    expect(res.body.message).toContain('paused');
  });

  test('/webhooks/stats shows paused=true', async () => {
    const res = await request(port, 'GET', '/webhooks/stats', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(true);
    expect(res.body.pausedAt).toBeDefined();
  });

  test('double pause returns already paused', async () => {
    const res = await request(port, 'POST', '/webhooks/pause', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(true);
    expect(res.body.message).toContain('Already paused');
  });

  test('events are buffered during pause', async () => {
    const initialCount = receiver.receivedRequests.length;

    // Create a key and make a tool call to generate usage events
    const keyRes = await request(port, 'POST', '/keys', { name: 'pause-test', credits: 100 }, { 'X-Admin-Key': adminKey });
    const apiKey = keyRes.body.key;

    await request(port, 'POST', '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'echo', arguments: {} },
    }, { 'X-API-Key': apiKey });

    // Wait a bit for the flush interval to pass
    await new Promise(r => setTimeout(r, 6000));

    // Webhook should NOT have received the event (paused)
    expect(receiver.receivedRequests.length).toBe(initialCount);

    // Stats should show buffered events
    const statsRes = await request(port, 'GET', '/webhooks/stats', undefined, { 'X-Admin-Key': adminKey });
    expect(statsRes.body.bufferedEvents).toBeGreaterThanOrEqual(1);
  }, 15000);

  test('POST /webhooks/resume resumes and flushes', async () => {
    const initialCount = receiver.receivedRequests.length;

    const res = await request(port, 'POST', '/webhooks/resume', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(false);
    expect(res.body.flushedEvents).toBeGreaterThanOrEqual(1);

    // Wait for the flushed events to be delivered
    await new Promise(r => setTimeout(r, 1500));

    // Webhook should now have received the buffered events
    expect(receiver.receivedRequests.length).toBeGreaterThan(initialCount);
  }, 10000);

  test('/webhooks/stats shows paused=false after resume', async () => {
    const res = await request(port, 'GET', '/webhooks/stats', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(false);
    expect(res.body.pausedAt).toBeNull();
  });

  test('resume when not paused returns not paused', async () => {
    const res = await request(port, 'POST', '/webhooks/resume', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(false);
    expect(res.body.message).toContain('Not paused');
  });

  test('pause requires admin auth', async () => {
    const res = await request(port, 'POST', '/webhooks/pause', {});
    expect(res.status).toBe(401);
  });

  test('resume requires admin auth', async () => {
    const res = await request(port, 'POST', '/webhooks/resume', {});
    expect(res.status).toBe(401);
  });

  test('pause requires POST method', async () => {
    const res = await request(port, 'GET', '/webhooks/pause', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(405);
  });

  test('resume requires POST method', async () => {
    const res = await request(port, 'GET', '/webhooks/resume', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(405);
  });

  test('root listing includes pause/resume endpoints', async () => {
    const res = await request(port, 'GET', '/');
    expect(res.body.endpoints.webhookPause).toBeDefined();
    expect(res.body.endpoints.webhookResume).toBeDefined();
  });

  test('audit trail records pause and resume', async () => {
    // Pause and resume to generate fresh audit events
    await request(port, 'POST', '/webhooks/pause', {}, { 'X-Admin-Key': adminKey });
    await request(port, 'POST', '/webhooks/resume', {}, { 'X-Admin-Key': adminKey });

    const auditRes = await request(port, 'GET', '/audit?types=webhook.pause,webhook.resume', undefined, { 'X-Admin-Key': adminKey });
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.events.length).toBeGreaterThanOrEqual(2);

    const pauseEvents = auditRes.body.events.filter((e: any) => e.type === 'webhook.pause');
    const resumeEvents = auditRes.body.events.filter((e: any) => e.type === 'webhook.resume');
    expect(pauseEvents.length).toBeGreaterThanOrEqual(1);
    expect(resumeEvents.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Tests without webhook configured ───────────────────────────────────────

describe('Webhook Pause/Resume (no webhook)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      ...DEFAULT_CONFIG,
      port: 0,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('pause returns 400 when no webhook configured', async () => {
    const res = await request(port, 'POST', '/webhooks/pause', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No webhook configured');
  });

  test('resume returns 400 when no webhook configured', async () => {
    const res = await request(port, 'POST', '/webhooks/resume', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No webhook configured');
  });
});
