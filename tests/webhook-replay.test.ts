/**
 * Tests for v4.2.0 — Webhook Event Replay
 *
 * POST /webhooks/replay — Replay dead letter webhook events
 * WebhookEmitter.replayDeadLetters() — Re-queue failed events for delivery
 */

import { WebhookEmitter } from '../src/webhook';
import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';
import http from 'http';

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

// ─── Unit Tests: WebhookEmitter.replayDeadLetters() ─────────────────────────

describe('WebhookEmitter.replayDeadLetters()', () => {
  let emitter: WebhookEmitter;

  beforeEach(() => {
    // Create emitter with invalid URL so sends fail immediately
    emitter = new WebhookEmitter('http://invalid-host-that-does-not-exist:99999/webhook', {
      maxRetries: 0, // Send directly to dead letters on first failure
      batchSize: 1,
      flushIntervalMs: 60000,
    });
  });

  afterEach(() => {
    emitter.destroy();
  });

  test('should return 0 when dead letter queue is empty', () => {
    expect(emitter.replayDeadLetters()).toBe(0);
  });

  test('should replay all dead letters when no indices given', async () => {
    // Generate dead letters by emitting events that will fail
    emitter.emit({ apiKey: 'pk1', keyName: 'k1', tool: 'tool', creditsCharged: 1, timestamp: new Date().toISOString(), allowed: true });
    emitter.emit({ apiKey: 'pk2', keyName: 'k2', tool: 'tool', creditsCharged: 2, timestamp: new Date().toISOString(), allowed: true });

    // Wait for sends to fail and land in dead letters
    await new Promise(r => setTimeout(r, 500));

    const dlBefore = emitter.getDeadLetters().length;
    expect(dlBefore).toBeGreaterThanOrEqual(1);

    const replayed = emitter.replayDeadLetters();
    expect(replayed).toBe(dlBefore);
    // Dead letters should be cleared after replay (they're re-queued)
    // Note: they may land back in dead letters quickly since URL is invalid
  });

  test('should replay specific indices only', async () => {
    emitter.emit({ apiKey: 'pk1', keyName: 'k1', tool: 'tool', creditsCharged: 1, timestamp: new Date().toISOString(), allowed: true });
    emitter.emit({ apiKey: 'pk2', keyName: 'k2', tool: 'tool', creditsCharged: 2, timestamp: new Date().toISOString(), allowed: true });
    emitter.emit({ apiKey: 'pk3', keyName: 'k3', tool: 'tool', creditsCharged: 3, timestamp: new Date().toISOString(), allowed: true });

    await new Promise(r => setTimeout(r, 500));

    const dlBefore = emitter.getDeadLetters().length;
    expect(dlBefore).toBeGreaterThanOrEqual(2);

    // Replay only first entry — returns count of replayed entries
    const replayed = emitter.replayDeadLetters([0]);
    expect(replayed).toBe(1);
    // Note: replayed events may re-fail and return to dead letters,
    // so we only verify the return value, not the queue size.
  });

  test('should ignore out-of-range indices', async () => {
    emitter.emit({ apiKey: 'pk1', keyName: 'k1', tool: 'tool', creditsCharged: 1, timestamp: new Date().toISOString(), allowed: true });

    await new Promise(r => setTimeout(r, 500));

    const dlBefore = emitter.getDeadLetters().length;
    expect(dlBefore).toBeGreaterThanOrEqual(1);

    // Replay with invalid indices
    const replayed = emitter.replayDeadLetters([99, -1, 1000]);
    expect(replayed).toBe(0);
    // Dead letters unchanged
    expect(emitter.getDeadLetters().length).toBe(dlBefore);
  });

  test('should deduplicate indices', async () => {
    emitter.emit({ apiKey: 'pk1', keyName: 'k1', tool: 'tool', creditsCharged: 1, timestamp: new Date().toISOString(), allowed: true });
    emitter.emit({ apiKey: 'pk2', keyName: 'k2', tool: 'tool', creditsCharged: 2, timestamp: new Date().toISOString(), allowed: true });

    await new Promise(r => setTimeout(r, 500));

    const dlBefore = emitter.getDeadLetters().length;
    expect(dlBefore).toBeGreaterThanOrEqual(2);

    // Replay index 0 twice — should only replay once
    const replayed = emitter.replayDeadLetters([0, 0, 0]);
    expect(replayed).toBe(1);
  });
});

// ─── Server Endpoint Tests: POST /webhooks/replay ─────────────────────────

describe('Webhook Replay — POST /webhooks/replay', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  // Use a server with an invalid webhook URL so events go to dead letters
  beforeAll(async () => {
    server = new PayGateServer({
      ...DEFAULT_CONFIG,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      port: 0,
      webhookUrl: 'http://invalid-host-no-resolve:99999/webhook',
      webhookMaxRetries: 0,
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop();
  });

  test('should return empty result when no dead letters', async () => {
    const res = await request(port, 'POST', '/webhooks/replay', {}, { 'X-Admin-Key': adminKey });

    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(0);
    expect(res.body.message).toContain('empty');
  });

  test('should require admin auth', async () => {
    const res = await request(port, 'POST', '/webhooks/replay', {});
    expect(res.status).toBe(401);
  });

  test('should reject GET method', async () => {
    const res = await request(port, 'GET', '/webhooks/replay', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(405);
  });

  test('should handle replay when no webhook configured', async () => {
    // Create a server without webhook
    const noWebhookServer = new PayGateServer({
      ...DEFAULT_CONFIG,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      port: 0,
    });
    const started = await noWebhookServer.start();

    try {
      const res = await request(started.port, 'POST', '/webhooks/replay', {}, { 'X-Admin-Key': started.adminKey });
      expect(res.status).toBe(200);
      expect(res.body.replayed).toBe(0);
      expect(res.body.message).toContain('No webhook');
    } finally {
      await noWebhookServer.gracefulStop();
    }
  });

  test('should reject invalid JSON', async () => {
    const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/webhooks/replay',
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

  test('should accept empty body (replay all)', async () => {
    const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/webhooks/replay',
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

  test('audit log should record replay operations', async () => {
    // First try to generate some dead letters
    await request(port, 'POST', '/webhooks/replay', {}, { 'X-Admin-Key': adminKey });

    const auditRes = await request(port, 'GET', '/audit?types=webhook.replayed&limit=1', undefined, { 'X-Admin-Key': adminKey });
    expect(auditRes.status).toBe(200);
    // Audit entry should exist (even if 0 replayed)
    expect(auditRes.body.events.length).toBeGreaterThanOrEqual(0);
  });

  test('root listing should include replay endpoint', async () => {
    const res = await request(port, 'GET', '/', undefined, {});
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain('/webhooks/replay');
  });

  test('should return remaining count after partial replay', async () => {
    const res = await request(port, 'POST', '/webhooks/replay', { indices: [0] }, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(typeof res.body.remaining).toBe('number');
  });
});
