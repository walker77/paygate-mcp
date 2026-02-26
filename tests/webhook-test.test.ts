/**
 * Tests for v4.7.0 — Webhook Test Endpoint.
 *
 * Covers:
 *   - POST /webhooks/test sends test event to configured webhook URL
 *   - Synchronous response with success/failure and timing
 *   - Custom message support
 *   - Handles no webhook configured (400)
 *   - Handles webhook delivery failure
 *   - Admin auth required
 *   - Method validation (POST only)
 *   - X-PayGate-Test header sent
 *   - X-PayGate-Signature header when secret configured
 *   - Audit trail
 *   - Root listing includes endpoint
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

function createWebhookReceiver(statusCode = 200): Promise<{
  server: http.Server;
  port: number;
  receivedRequests: Array<{
    body: any;
    headers: Record<string, string | string[] | undefined>;
  }>;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const receivedRequests: Array<{
      body: any;
      headers: Record<string, string | string[] | undefined>;
    }> = [];

    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        try {
          receivedRequests.push({
            body: JSON.parse(data),
            headers: req.headers,
          });
        } catch {
          receivedRequests.push({ body: data, headers: req.headers });
        }
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(statusCode >= 400 ? '{"error":"fail"}' : '{"ok":true}');
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

// ─── Tests with webhook configured ──────────────────────────────────────────

describe('POST /webhooks/test (with webhook)', () => {
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
      webhookSecret: 'test-secret-123',
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.stop();
    await receiver.close();
  });

  test('sends test event and returns success', async () => {
    const res = await request(port, 'POST', '/webhooks/test', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.statusCode).toBe(200);
    expect(res.body.responseTime).toBeGreaterThanOrEqual(0);
    expect(res.body.url).toContain('127.0.0.1');
  });

  test('webhook receiver gets test event payload', async () => {
    const initialCount = receiver.receivedRequests.length;
    await request(port, 'POST', '/webhooks/test', {}, { 'X-Admin-Key': adminKey });

    const testReqs = receiver.receivedRequests.slice(initialCount);
    expect(testReqs.length).toBeGreaterThanOrEqual(1);

    const testReq = testReqs[testReqs.length - 1];
    expect(testReq.body.adminEvents).toBeDefined();
    expect(testReq.body.adminEvents[0].type).toBe('alert.fired');
    expect(testReq.body.adminEvents[0].metadata.test).toBe(true);
  });

  test('X-PayGate-Test header is sent', async () => {
    const initialCount = receiver.receivedRequests.length;
    await request(port, 'POST', '/webhooks/test', {}, { 'X-Admin-Key': adminKey });

    const testReqs = receiver.receivedRequests.slice(initialCount);
    expect(testReqs.length).toBeGreaterThanOrEqual(1);
    const testReq = testReqs[testReqs.length - 1];
    expect(testReq.headers['x-paygate-test']).toBe('1');
  });

  test('includes X-PayGate-Signature when secret is configured', async () => {
    const initialCount = receiver.receivedRequests.length;
    await request(port, 'POST', '/webhooks/test', {}, { 'X-Admin-Key': adminKey });

    const testReqs = receiver.receivedRequests.slice(initialCount);
    expect(testReqs.length).toBeGreaterThanOrEqual(1);
    const testReq = testReqs[testReqs.length - 1];
    const sig = testReq.headers['x-paygate-signature'] as string;
    expect(sig).toBeDefined();
    expect(sig).toMatch(/^t=\d+,v1=[a-f0-9]+$/);
  });

  test('custom message in test event', async () => {
    const initialCount = receiver.receivedRequests.length;
    await request(port, 'POST', '/webhooks/test', { message: 'hello world' }, { 'X-Admin-Key': adminKey });

    const testReqs = receiver.receivedRequests.slice(initialCount);
    expect(testReqs.length).toBeGreaterThanOrEqual(1);
    const testReq = testReqs[testReqs.length - 1];
    expect(testReq.body.adminEvents[0].metadata.message).toBe('hello world');
  });

  test('default message when no body', async () => {
    const initialCount = receiver.receivedRequests.length;
    await request(port, 'POST', '/webhooks/test', undefined, { 'X-Admin-Key': adminKey });

    const testReqs = receiver.receivedRequests.slice(initialCount);
    expect(testReqs.length).toBeGreaterThanOrEqual(1);
    const testReq = testReqs[testReqs.length - 1];
    expect(testReq.body.adminEvents[0].metadata.message).toBe('Test event from paygate-mcp');
  });

  test('requires admin auth', async () => {
    const res = await request(port, 'POST', '/webhooks/test', {});
    expect(res.status).toBe(401);
  });

  test('requires POST method', async () => {
    const res = await request(port, 'GET', '/webhooks/test', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(405);
  });

  test('root listing includes webhookTest endpoint', async () => {
    const res = await request(port, 'GET', '/');
    expect(res.body.endpoints.webhookTest).toBeDefined();
  });

  test('creates audit trail', async () => {
    await request(port, 'POST', '/webhooks/test', {}, { 'X-Admin-Key': adminKey });

    const auditRes = await request(port, 'GET', '/audit?types=webhook.test', undefined, { 'X-Admin-Key': adminKey });
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.events.length).toBeGreaterThanOrEqual(1);
    expect(auditRes.body.events[0].type).toBe('webhook.test');
    expect(auditRes.body.events[0].message).toContain('Webhook test');
  });
});

// ─── Tests without webhook configured ───────────────────────────────────────

describe('POST /webhooks/test (no webhook)', () => {
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
    await server.stop();
  });

  test('returns 400 when no webhook is configured', async () => {
    const res = await request(port, 'POST', '/webhooks/test', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No webhook configured');
  });
});

// ─── Tests with failing webhook endpoint ────────────────────────────────────

describe('POST /webhooks/test (failing receiver)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let failingReceiver: Awaited<ReturnType<typeof createWebhookReceiver>>;

  beforeAll(async () => {
    failingReceiver = await createWebhookReceiver(500);

    server = new PayGateServer({
      ...DEFAULT_CONFIG,
      port: 0,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      webhookUrl: `http://127.0.0.1:${failingReceiver.port}/webhook`,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.stop();
    await failingReceiver.close();
  });

  test('returns failure when webhook endpoint returns 500', async () => {
    const res = await request(port, 'POST', '/webhooks/test', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200); // Our endpoint succeeds — the webhook delivery failed
    expect(res.body.success).toBe(false);
    expect(res.body.statusCode).toBe(500);
    expect(res.body.error).toBe('HTTP 500');
    expect(res.body.responseTime).toBeGreaterThanOrEqual(0);
  });
});

// ─── Test with unreachable webhook ──────────────────────────────────────────

describe('POST /webhooks/test (unreachable)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      ...DEFAULT_CONFIG,
      port: 0,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      webhookUrl: 'http://127.0.0.1:19999/webhook',
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.stop();
  });

  test('returns failure when webhook is unreachable', async () => {
    const res = await request(port, 'POST', '/webhooks/test', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeDefined();
    expect(res.body.responseTime).toBeGreaterThanOrEqual(0);
  });
});
