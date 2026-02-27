/**
 * Webhook Signatures + Admin Lifecycle Events Tests.
 *
 * Tests:
 *   - WebhookEmitter.sign/verify (HMAC-SHA256)
 *   - Signature header format (t=...,v1=...)
 *   - Admin lifecycle events (key.created, key.revoked, key.rotated, key.topup)
 *   - E2E: Signed webhooks with real HTTP server
 *   - E2E: Admin events fire on key management operations
 */

import * as http from 'http';
import { WebhookEmitter } from '../src/webhook';
import { PayGateServer } from '../src/server';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function httpRequest(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: options.port,
      method: options.method,
      path: options.path,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body,
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Create a simple HTTP server that captures webhook requests.
 */
function createWebhookReceiver(): {
  server: http.Server;
  port: number;
  start: () => Promise<number>;
  stop: () => Promise<void>;
  requests: Array<{ headers: http.IncomingHttpHeaders; body: string }>;
} {
  const requests: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      requests.push({ headers: req.headers, body });
      res.writeHead(200);
      res.end('OK');
    });
  });

  return {
    server,
    port: 0,
    start: () => new Promise<number>((resolve) => {
      server.listen(0, () => {
        const addr = server.address() as { port: number };
        (server as any)._port = addr.port;
        resolve(addr.port);
      });
    }),
    stop: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
    requests,
  };
}

// ─── Unit Tests: Sign/Verify ────────────────────────────────────────────────

describe('WebhookEmitter Signatures', () => {
  it('sign() produces consistent HMAC-SHA256 output', () => {
    const sig = WebhookEmitter.sign('test payload', 'mysecret');
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
    // Same input = same output
    expect(WebhookEmitter.sign('test payload', 'mysecret')).toBe(sig);
  });

  it('sign() produces different output for different payloads', () => {
    const sig1 = WebhookEmitter.sign('payload1', 'secret');
    const sig2 = WebhookEmitter.sign('payload2', 'secret');
    expect(sig1).not.toBe(sig2);
  });

  it('sign() produces different output for different secrets', () => {
    const sig1 = WebhookEmitter.sign('payload', 'secret1');
    const sig2 = WebhookEmitter.sign('payload', 'secret2');
    expect(sig1).not.toBe(sig2);
  });

  it('verify() returns true for valid signatures', () => {
    const payload = '{"events":[],"sentAt":"2024-01-01T00:00:00Z"}';
    const secret = 'whsec_test123';
    const sig = WebhookEmitter.sign(payload, secret);
    expect(WebhookEmitter.verify(payload, sig, secret)).toBe(true);
  });

  it('verify() returns false for invalid signatures', () => {
    const payload = 'test payload';
    const secret = 'mysecret';
    expect(WebhookEmitter.verify(payload, 'invalidsig', secret)).toBe(false);
  });

  it('verify() returns false for wrong secret', () => {
    const payload = 'test payload';
    const sig = WebhookEmitter.sign(payload, 'secret1');
    expect(WebhookEmitter.verify(payload, sig, 'secret2')).toBe(false);
  });

  it('verify() returns false for tampered payload', () => {
    const secret = 'mysecret';
    const sig = WebhookEmitter.sign('original', secret);
    expect(WebhookEmitter.verify('tampered', sig, secret)).toBe(false);
  });

  it('verify() handles mismatched lengths safely', () => {
    expect(WebhookEmitter.verify('payload', 'short', 'secret')).toBe(false);
    expect(WebhookEmitter.verify('payload', '', 'secret')).toBe(false);
  });
});

// ─── Unit Tests: Admin Events ───────────────────────────────────────────────

describe('WebhookEmitter Admin Events', () => {
  it('emitAdmin adds event to buffer', () => {
    // Create emitter with very long flush interval so we can inspect buffer
    const emitter = new WebhookEmitter('http://localhost:1234', {
      flushIntervalMs: 999999,
    });

    emitter.emitAdmin('key.created', 'admin', { name: 'test-key', credits: 100 });

    // Force flush and check (buffer is private, so we test via E2E)
    emitter.destroy();
  });

  it('emitAdmin supports all lifecycle event types', () => {
    const emitter = new WebhookEmitter('http://localhost:1234', {
      flushIntervalMs: 999999,
    });

    // These should not throw
    emitter.emitAdmin('key.created', 'admin', { name: 'test' });
    emitter.emitAdmin('key.revoked', 'admin', { key: 'masked' });
    emitter.emitAdmin('key.rotated', 'admin', { old: 'old', new: 'new' });
    emitter.emitAdmin('key.topup', 'admin', { credits: 100 });
    emitter.emitAdmin('key.expired', 'system', { key: 'expired' });

    emitter.destroy();
  });
});

// ─── E2E Tests: Signed Webhooks ─────────────────────────────────────────────

describe('Signed Webhooks E2E', () => {
  let receiver: ReturnType<typeof createWebhookReceiver>;
  let receiverPort: number;

  beforeAll(async () => {
    receiver = createWebhookReceiver();
    receiverPort = await receiver.start();
  });

  afterAll(async () => {
    await receiver.stop();
  });

  it('sends X-PayGate-Signature header when secret is configured', async () => {
    const secret = 'whsec_testkey123';
    const emitter = new WebhookEmitter(`http://127.0.0.1:${receiverPort}/webhook`, {
      secret,
      flushIntervalMs: 999999, // Manual flush
      ssrfCheckOnDelivery: false,
    });

    emitter.emit({
      timestamp: new Date().toISOString(),
      apiKey: 'pg_test...',
      keyName: 'test-key',
      tool: 'search',
      creditsCharged: 5,
      allowed: true,
    });

    emitter.flush();
    emitter.destroy();

    // Wait for the HTTP request to arrive (socket setup + delivery)
    await new Promise(r => setTimeout(r, 500));

    expect(receiver.requests.length).toBeGreaterThanOrEqual(1);
    const req = receiver.requests[receiver.requests.length - 1];

    // Verify signature header exists and has correct format
    const sigHeader = req.headers['x-paygate-signature'] as string;
    expect(sigHeader).toBeDefined();
    expect(sigHeader).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);

    // Extract and verify the signature
    const [tPart, v1Part] = sigHeader.split(',');
    const timestamp = tPart.split('=')[1];
    const signature = v1Part.split('=')[1];

    const signaturePayload = `${timestamp}.${req.body}`;
    expect(WebhookEmitter.verify(signaturePayload, signature, secret)).toBe(true);
  });

  it('does not send signature header when no secret', async () => {
    const emitter = new WebhookEmitter(`http://127.0.0.1:${receiverPort}/webhook`, {
      flushIntervalMs: 999999,
      ssrfCheckOnDelivery: false,
    });

    const beforeCount = receiver.requests.length;

    emitter.emit({
      timestamp: new Date().toISOString(),
      apiKey: 'pg_nosig...',
      keyName: 'no-sig-key',
      tool: 'basic',
      creditsCharged: 1,
      allowed: true,
    });

    emitter.flush();
    emitter.destroy();

    await new Promise(r => setTimeout(r, 200));

    expect(receiver.requests.length).toBeGreaterThan(beforeCount);
    const req = receiver.requests[receiver.requests.length - 1];
    expect(req.headers['x-paygate-signature']).toBeUndefined();
  });

  it('admin events appear in webhook payload', async () => {
    const emitter = new WebhookEmitter(`http://127.0.0.1:${receiverPort}/webhook`, {
      secret: 'test_secret',
      flushIntervalMs: 999999,
      ssrfCheckOnDelivery: false,
    });

    const beforeCount = receiver.requests.length;

    emitter.emitAdmin('key.created', 'admin', { name: 'webhook-test', credits: 500 });
    emitter.flush();
    emitter.destroy();

    await new Promise(r => setTimeout(r, 200));

    expect(receiver.requests.length).toBeGreaterThan(beforeCount);
    const req = receiver.requests[receiver.requests.length - 1];
    const payload = JSON.parse(req.body);

    expect(payload.adminEvents).toBeDefined();
    expect(payload.adminEvents.length).toBe(1);
    expect(payload.adminEvents[0].type).toBe('key.created');
    expect(payload.adminEvents[0].actor).toBe('admin');
    expect(payload.adminEvents[0].metadata.name).toBe('webhook-test');
    expect(payload.adminEvents[0].metadata.credits).toBe(500);
  });

  it('mixed usage + admin events in same batch', async () => {
    const emitter = new WebhookEmitter(`http://127.0.0.1:${receiverPort}/webhook`, {
      flushIntervalMs: 999999,
      ssrfCheckOnDelivery: false,
    });

    const beforeCount = receiver.requests.length;

    emitter.emit({
      timestamp: new Date().toISOString(),
      apiKey: 'pg_mixed...',
      keyName: 'mixed-key',
      tool: 'search',
      creditsCharged: 5,
      allowed: true,
    });
    emitter.emitAdmin('key.topup', 'admin', { credits: 100 });
    emitter.flush();
    emitter.destroy();

    await new Promise(r => setTimeout(r, 200));

    expect(receiver.requests.length).toBeGreaterThan(beforeCount);
    const req = receiver.requests[receiver.requests.length - 1];
    const payload = JSON.parse(req.body);

    expect(payload.events).toBeDefined();
    expect(payload.events.length).toBe(1);
    expect(payload.adminEvents).toBeDefined();
    expect(payload.adminEvents.length).toBe(1);
  });
});

// ─── E2E Tests: Server Integration ──────────────────────────────────────────

describe('Webhook Server Integration', () => {
  let receiver: ReturnType<typeof createWebhookReceiver>;
  let receiverPort: number;
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    receiver = createWebhookReceiver();
    receiverPort = await receiver.start();

    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: [],
      port: 0,
      defaultCreditsPerCall: 2,
      webhookUrl: `http://127.0.0.1:${receiverPort}/webhook`,
      webhookSecret: 'srv_webhook_secret_123',
      webhookSsrfAtDelivery: false,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.stop();
    await receiver.stop();
  });

  it('key creation fires webhook admin event', async () => {
    const beforeCount = receiver.requests.length;

    await httpRequest({
      port, method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'webhook-key', credits: 100 }),
    });

    // Flush webhooks
    server.gate.webhook?.flush();
    await new Promise(r => setTimeout(r, 300));

    expect(receiver.requests.length).toBeGreaterThan(beforeCount);
    const req = receiver.requests[receiver.requests.length - 1];
    const payload = JSON.parse(req.body);

    // Should have admin event
    expect(payload.adminEvents).toBeDefined();
    const keyCreated = payload.adminEvents.find((e: any) => e.type === 'key.created');
    expect(keyCreated).toBeDefined();
    expect(keyCreated.metadata.name).toBe('webhook-key');

    // Should be signed
    expect(req.headers['x-paygate-signature']).toBeDefined();
    expect(req.headers['x-paygate-signature']).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
  });

  it('key revocation fires webhook admin event', async () => {
    // Create a key
    const createRes = await httpRequest({
      port, method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'revoke-webhook', credits: 50 }),
    });
    const { key } = JSON.parse(createRes.body);

    // Flush creation event
    server.gate.webhook?.flush();
    await new Promise(r => setTimeout(r, 200));
    const beforeCount = receiver.requests.length;

    // Revoke
    await httpRequest({
      port, method: 'POST', path: '/keys/revoke',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ key }),
    });

    server.gate.webhook?.flush();
    await new Promise(r => setTimeout(r, 300));

    expect(receiver.requests.length).toBeGreaterThan(beforeCount);
    const req = receiver.requests[receiver.requests.length - 1];
    const payload = JSON.parse(req.body);

    expect(payload.adminEvents).toBeDefined();
    const keyRevoked = payload.adminEvents.find((e: any) => e.type === 'key.revoked');
    expect(keyRevoked).toBeDefined();
  });

  it('key rotation fires webhook admin event', async () => {
    // Create a key
    const createRes = await httpRequest({
      port, method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'rotate-webhook', credits: 200 }),
    });
    const { key } = JSON.parse(createRes.body);

    server.gate.webhook?.flush();
    await new Promise(r => setTimeout(r, 200));
    const beforeCount = receiver.requests.length;

    // Rotate
    await httpRequest({
      port, method: 'POST', path: '/keys/rotate',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ key }),
    });

    server.gate.webhook?.flush();
    await new Promise(r => setTimeout(r, 300));

    expect(receiver.requests.length).toBeGreaterThan(beforeCount);
    const req = receiver.requests[receiver.requests.length - 1];
    const payload = JSON.parse(req.body);

    expect(payload.adminEvents).toBeDefined();
    const keyRotated = payload.adminEvents.find((e: any) => e.type === 'key.rotated');
    expect(keyRotated).toBeDefined();
  });

  it('key topup fires webhook admin event', async () => {
    // Create a key
    const createRes = await httpRequest({
      port, method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'topup-webhook', credits: 50 }),
    });
    const { key } = JSON.parse(createRes.body);

    server.gate.webhook?.flush();
    await new Promise(r => setTimeout(r, 200));
    const beforeCount = receiver.requests.length;

    // Top up
    await httpRequest({
      port, method: 'POST', path: '/topup',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ key, credits: 100 }),
    });

    server.gate.webhook?.flush();
    await new Promise(r => setTimeout(r, 300));

    expect(receiver.requests.length).toBeGreaterThan(beforeCount);
    const req = receiver.requests[receiver.requests.length - 1];
    const payload = JSON.parse(req.body);

    expect(payload.adminEvents).toBeDefined();
    const keyTopup = payload.adminEvents.find((e: any) => e.type === 'key.topup');
    expect(keyTopup).toBeDefined();
  });

  it('webhook signature is verifiable with configured secret', async () => {
    await httpRequest({
      port, method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'verify-sig', credits: 10 }),
    });

    server.gate.webhook?.flush();
    await new Promise(r => setTimeout(r, 300));

    const req = receiver.requests[receiver.requests.length - 1];
    const sigHeader = req.headers['x-paygate-signature'] as string;

    const [tPart, v1Part] = sigHeader.split(',');
    const timestamp = tPart.split('=')[1];
    const signature = v1Part.split('=')[1];

    const signaturePayload = `${timestamp}.${req.body}`;
    expect(WebhookEmitter.verify(signaturePayload, signature, 'srv_webhook_secret_123')).toBe(true);
    // Wrong secret should fail
    expect(WebhookEmitter.verify(signaturePayload, signature, 'wrong_secret')).toBe(false);
  });
});
