/**
 * Audit Log Tests.
 *
 * Tests:
 *   - AuditLogger unit tests (log, query, retention, stats, export)
 *   - E2E: /audit endpoint returns audit events
 *   - E2E: /audit/export returns CSV or JSON
 *   - E2E: /audit/stats returns statistics
 *   - E2E: Audit events emitted for key management operations
 *   - E2E: Audit events emitted for gate decisions
 *   - E2E: Audit events emitted for admin auth failures
 */

import * as http from 'http';
import { AuditLogger, maskKeyForAudit } from '../src/audit';
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

// ─── Unit Tests: AuditLogger ────────────────────────────────────────────────

describe('AuditLogger', () => {
  let logger: AuditLogger;

  beforeEach(() => {
    logger = new AuditLogger({ cleanupIntervalMs: 0 }); // Disable timer for tests
  });

  afterEach(() => {
    logger.destroy();
  });

  it('should log events with monotonic IDs', () => {
    const e1 = logger.log('key.created', 'admin', 'Key created');
    const e2 = logger.log('key.revoked', 'admin', 'Key revoked');
    expect(e1.id).toBe(1);
    expect(e2.id).toBe(2);
    expect(e1.type).toBe('key.created');
    expect(e2.type).toBe('key.revoked');
    expect(logger.size).toBe(2);
  });

  it('should store metadata on events', () => {
    const event = logger.log('key.topup', 'admin', 'Credits added', { credits: 100, key: 'test' });
    expect(event.metadata).toEqual({ credits: 100, key: 'test' });
  });

  it('should enforce maxEvents (ring buffer)', () => {
    const small = new AuditLogger({ maxEvents: 3, maxAgeHours: 0, cleanupIntervalMs: 0 });
    small.log('key.created', 'admin', 'Event 1');
    small.log('key.created', 'admin', 'Event 2');
    small.log('key.created', 'admin', 'Event 3');
    small.log('key.created', 'admin', 'Event 4');
    expect(small.size).toBe(3);
    // Oldest should be evicted
    const events = small.exportAll();
    expect(events[0].message).toBe('Event 2');
    small.destroy();
  });

  it('should enforce maxAgeHours retention', () => {
    // Use a logger with short retention (24 hours)
    const shortRetention = new AuditLogger({ maxAgeHours: 24, cleanupIntervalMs: 0 });
    const event = shortRetention.log('key.created', 'admin', 'Old event');
    // Override timestamp to be 48 hours ago (older than 24h retention)
    (event as any).timestamp = new Date(Date.now() - 48 * 3_600_000).toISOString();

    shortRetention.log('key.created', 'admin', 'Recent event');

    const removed = shortRetention.enforceRetention();
    expect(removed).toBe(1);
    expect(shortRetention.size).toBe(1);
    shortRetention.destroy();
  });

  it('should query by event type', () => {
    logger.log('key.created', 'admin', 'Create');
    logger.log('key.revoked', 'admin', 'Revoke');
    logger.log('gate.allow', 'user1', 'Allow');

    const result = logger.query({ types: ['key.created', 'key.revoked'] });
    expect(result.total).toBe(2);
    expect(result.events.map(e => e.type)).toEqual(['key.revoked', 'key.created']); // reverse chronological
  });

  it('should query by actor (partial match, case-insensitive)', () => {
    logger.log('key.created', 'admin', 'Create');
    logger.log('gate.allow', 'pg_abc1...xyz', 'Allow');

    const result = logger.query({ actor: 'abc1' });
    expect(result.total).toBe(1);
    expect(result.events[0].actor).toBe('pg_abc1...xyz');
  });

  it('should query by time range', () => {
    const e1 = logger.log('key.created', 'admin', 'Old');
    (e1 as any).timestamp = '2024-01-01T00:00:00.000Z';
    const e2 = logger.log('key.created', 'admin', 'New');
    (e2 as any).timestamp = '2026-01-15T00:00:00.000Z';

    const result = logger.query({ since: '2025-01-01T00:00:00.000Z' });
    expect(result.total).toBe(1);
    expect(result.events[0].message).toBe('New');
  });

  it('should paginate results', () => {
    for (let i = 0; i < 10; i++) {
      logger.log('key.created', 'admin', `Event ${i}`);
    }

    const page1 = logger.query({ limit: 3, offset: 0 });
    expect(page1.total).toBe(10);
    expect(page1.events.length).toBe(3);
    expect(page1.events[0].message).toBe('Event 9'); // newest first

    const page2 = logger.query({ limit: 3, offset: 3 });
    expect(page2.events[0].message).toBe('Event 6');
  });

  it('should compute stats correctly', () => {
    logger.log('key.created', 'admin', 'Create 1');
    logger.log('key.created', 'admin', 'Create 2');
    logger.log('gate.allow', 'user', 'Allow');
    logger.log('gate.deny', 'user', 'Deny');

    const stats = logger.stats();
    expect(stats.totalEvents).toBe(4);
    expect(stats.eventsByType['key.created']).toBe(2);
    expect(stats.eventsByType['gate.allow']).toBe(1);
    expect(stats.eventsByType['gate.deny']).toBe(1);
    expect(stats.eventsLastHour).toBe(4);
    expect(stats.eventsLast24h).toBe(4);
  });

  it('should export as CSV', () => {
    logger.log('key.created', 'admin', 'Key created');
    const csv = logger.exportCsv();
    expect(csv).toContain('id,timestamp,type,actor,message');
    expect(csv).toContain('key.created');
    expect(csv).toContain('"admin"');
  });

  it('should clear all events', () => {
    logger.log('key.created', 'admin', 'Event');
    expect(logger.size).toBe(1);
    logger.clear();
    expect(logger.size).toBe(0);
  });
});

describe('maskKeyForAudit', () => {
  it('should mask API keys', () => {
    expect(maskKeyForAudit('pg_abcdefghijklmnopqrstuvwxyz')).toBe('pg_abcd...wxyz');
  });

  it('should handle short keys', () => {
    expect(maskKeyForAudit('short')).toBe('***');
  });

  it('should handle empty/null keys', () => {
    expect(maskKeyForAudit('')).toBe('***');
  });
});

// ─── E2E Tests: Audit API Endpoints ─────────────────────────────────────────

describe('Audit Log E2E', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: [],
      port: 0,
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  it('GET /audit requires admin auth', async () => {
    const res = await httpRequest({ port, method: 'GET', path: '/audit' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /audit returns audit events', async () => {
    // Create a key to generate an audit event
    await httpRequest({
      port, method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'audit-test', credits: 50 }),
    });

    const res = await httpRequest({
      port, method: 'GET', path: '/audit',
      headers: { 'X-Admin-Key': adminKey },
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.total).toBeGreaterThanOrEqual(1);
    expect(data.events.length).toBeGreaterThanOrEqual(1);
    // Should contain key.created event
    const keyCreated = data.events.find((e: any) => e.type === 'key.created');
    expect(keyCreated).toBeDefined();
    expect(keyCreated.message).toContain('audit-test');
  });

  it('GET /audit supports type filtering', async () => {
    const res = await httpRequest({
      port, method: 'GET', path: '/audit?types=key.created',
      headers: { 'X-Admin-Key': adminKey },
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    for (const event of data.events) {
      expect(event.type).toBe('key.created');
    }
  });

  it('GET /audit supports pagination', async () => {
    const res = await httpRequest({
      port, method: 'GET', path: '/audit?limit=1&offset=0',
      headers: { 'X-Admin-Key': adminKey },
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.limit).toBe(1);
    expect(data.offset).toBe(0);
    expect(data.events.length).toBeLessThanOrEqual(1);
  });

  it('GET /audit/stats returns statistics', async () => {
    const res = await httpRequest({
      port, method: 'GET', path: '/audit/stats',
      headers: { 'X-Admin-Key': adminKey },
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.totalEvents).toBeGreaterThanOrEqual(1);
    expect(data.eventsByType).toBeDefined();
    expect(typeof data.eventsLastHour).toBe('number');
    expect(typeof data.eventsLast24h).toBe('number');
  });

  it('GET /audit/export returns JSON by default', async () => {
    const res = await httpRequest({
      port, method: 'GET', path: '/audit/export',
      headers: { 'X-Admin-Key': adminKey },
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.count).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(data.events)).toBe(true);
  });

  it('GET /audit/export?format=csv returns CSV', async () => {
    const res = await httpRequest({
      port, method: 'GET', path: '/audit/export?format=csv',
      headers: { 'X-Admin-Key': adminKey },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body).toContain('id,timestamp,type,actor,message');
  });

  it('key revocation is audited', async () => {
    // Create a key to revoke
    const createRes = await httpRequest({
      port, method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'revoke-me', credits: 10 }),
    });
    const key = JSON.parse(createRes.body).key;

    await httpRequest({
      port, method: 'POST', path: '/keys/revoke',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ key }),
    });

    const res = await httpRequest({
      port, method: 'GET', path: '/audit?types=key.revoked',
      headers: { 'X-Admin-Key': adminKey },
    });
    const data = JSON.parse(res.body);
    expect(data.events.some((e: any) => e.type === 'key.revoked')).toBe(true);
  });

  it('credit top-up is audited', async () => {
    const createRes = await httpRequest({
      port, method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'topup-test', credits: 10 }),
    });
    const key = JSON.parse(createRes.body).key;

    await httpRequest({
      port, method: 'POST', path: '/topup',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ key, credits: 50 }),
    });

    const res = await httpRequest({
      port, method: 'GET', path: '/audit?types=key.topup',
      headers: { 'X-Admin-Key': adminKey },
    });
    const data = JSON.parse(res.body);
    const topup = data.events.find((e: any) => e.type === 'key.topup');
    expect(topup).toBeDefined();
    expect(topup.metadata.creditsAdded).toBe(50);
  });

  it('admin auth failure is audited', async () => {
    await httpRequest({
      port, method: 'GET', path: '/audit',
      headers: { 'X-Admin-Key': 'wrong-key' },
    });

    // Use the real admin key to check if auth failure was logged
    const res = await httpRequest({
      port, method: 'GET', path: '/audit?types=admin.auth_failed',
      headers: { 'X-Admin-Key': adminKey },
    });
    const data = JSON.parse(res.body);
    expect(data.events.some((e: any) => e.type === 'admin.auth_failed')).toBe(true);
  });

  it('gate decision (deny) is audited for tools/call without key', async () => {
    // Call /mcp without API key (should deny)
    await httpRequest({
      port, method: 'POST', path: '/mcp',
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'tools/call',
        params: { name: 'test_tool', arguments: {} },
      }),
    });

    const res = await httpRequest({
      port, method: 'GET', path: '/audit?types=gate.deny',
      headers: { 'X-Admin-Key': adminKey },
    });
    const data = JSON.parse(res.body);
    expect(data.events.some((e: any) => e.type === 'gate.deny')).toBe(true);
  });

  it('session creation is audited on /mcp POST', async () => {
    // Create a key for the call
    const createRes = await httpRequest({
      port, method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'session-test', credits: 100 }),
    });
    const key = JSON.parse(createRes.body).key;

    await httpRequest({
      port, method: 'POST', path: '/mcp',
      headers: { 'X-API-Key': key },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'initialize',
        params: {},
      }),
    });

    const res = await httpRequest({
      port, method: 'GET', path: '/audit?types=session.created',
      headers: { 'X-Admin-Key': adminKey },
    });
    const data = JSON.parse(res.body);
    expect(data.events.some((e: any) => e.type === 'session.created')).toBe(true);
  });

  it('audit log accessible in root endpoint listing', async () => {
    const res = await httpRequest({ port, method: 'GET', path: '/' });
    const data = JSON.parse(res.body);
    expect(data.endpoints.audit).toBeDefined();
    expect(data.endpoints.auditExport).toBeDefined();
    expect(data.endpoints.auditStats).toBeDefined();
  });
});
