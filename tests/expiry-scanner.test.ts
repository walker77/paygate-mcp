/**
 * Tests for v5.1.0 — Key Expiry Scanner
 *
 * Covers:
 *   - ExpiryScanner unit: scan logic, de-duplication, thresholds, cleanup
 *   - ExpiryScanner.queryExpiring static method
 *   - Server integration: GET /keys/expiring endpoint
 *   - Webhook + audit trail integration
 *   - Scanner lifecycle (start/destroy)
 *   - Root listing includes new endpoint
 */

import { ExpiryScanner, DEFAULT_EXPIRY_SCANNER_CONFIG } from '../src/expiry-scanner';
import { ApiKeyRecord, DEFAULT_CONFIG } from '../src/types';
import { PayGateServer } from '../src/server';
import http from 'http';

// ─── Helpers ───────────────────────────────────────────────────────────────────

const ECHO_CMD = process.execPath;
const ECHO_ARGS = ['-e', 'process.stdin.resume(); process.stdin.on("data", d => { const r = JSON.parse(d.toString().trim()); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: {} }) + "\\n"); });'];

function makeKey(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  const today = new Date().toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);
  return {
    key: `pg_test_${Math.random().toString(36).slice(2)}`,
    name: 'test-key',
    credits: 100,
    totalSpent: 0,
    totalCalls: 0,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    active: true,
    spendingLimit: 0,
    allowedTools: [],
    deniedTools: [],
    expiresAt: null,
    tags: {},
    ipAllowlist: [],
    namespace: 'default',
    quotaDailyCalls: 0,
    quotaMonthlyCalls: 0,
    quotaDailyCredits: 0,
    quotaMonthlyCredits: 0,
    quotaLastResetDay: today,
    quotaLastResetMonth: month,
    autoTopupTodayCount: 0,
    autoTopupLastResetDay: today,
    ...overrides,
  };
}

function futureDate(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

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

// ─── Unit Tests: ExpiryScanner ─────────────────────────────────────────────────

describe('ExpiryScanner (unit)', () => {
  let scanner: ExpiryScanner;

  afterEach(() => {
    scanner?.destroy();
  });

  test('default config has expected thresholds', () => {
    scanner = new ExpiryScanner();
    const status = scanner.status;
    expect(status.enabled).toBe(true);
    expect(status.intervalSeconds).toBe(3600);
    expect(status.thresholds).toEqual([604800, 86400, 3600]);
  });

  test('scan finds keys expiring within thresholds', () => {
    scanner = new ExpiryScanner({ thresholds: [3600] }); // 1 hour
    const keys = [
      makeKey({ expiresAt: futureDate(1800) }), // 30 min → within 1h threshold
      makeKey({ expiresAt: futureDate(7200) }), // 2h → outside threshold
      makeKey({ expiresAt: null }),               // No expiry → ignored
    ];

    scanner.start(() => keys);
    // scan() ran immediately in start()
    const status = scanner.status;
    expect(status.notifiedCount).toBe(1);
  });

  test('scan fires onWarning callback', () => {
    scanner = new ExpiryScanner({ thresholds: [3600] });
    const warnings: any[] = [];
    scanner.onWarning = (w) => warnings.push(w);

    const keys = [makeKey({ name: 'expiring-soon', expiresAt: futureDate(1800) })];
    scanner.start(() => keys);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].name).toBe('expiring-soon');
    expect(warnings[0].thresholdSeconds).toBe(3600);
    expect(warnings[0].remainingSeconds).toBeGreaterThan(0);
    expect(warnings[0].remainingSeconds).toBeLessThanOrEqual(1800);
    expect(warnings[0].remainingHuman).toMatch(/\d+m/);
  });

  test('de-duplication prevents duplicate notifications', () => {
    scanner = new ExpiryScanner({ thresholds: [3600] });
    const warnings: any[] = [];
    scanner.onWarning = (w) => warnings.push(w);

    const keys = [makeKey({ expiresAt: futureDate(1800) })];
    scanner.start(() => keys);
    expect(warnings).toHaveLength(1);

    // Second scan — same key, same threshold → no new warning
    const result = scanner.scan();
    expect(result).toHaveLength(0);
    expect(warnings).toHaveLength(1); // Still 1
  });

  test('clearNotified resets de-duplication', () => {
    scanner = new ExpiryScanner({ thresholds: [3600] });
    const warnings: any[] = [];
    scanner.onWarning = (w) => warnings.push(w);

    const keys = [makeKey({ expiresAt: futureDate(1800) })];
    scanner.start(() => keys);
    expect(warnings).toHaveLength(1);

    scanner.clearNotified();
    scanner.scan();
    expect(warnings).toHaveLength(2);
  });

  test('multiple thresholds — fires largest matching first, then progressively smaller', () => {
    // Thresholds: 7d, 24h, 1h (sorted desc internally)
    scanner = new ExpiryScanner({ thresholds: [604800, 86400, 3600] });
    const warnings: any[] = [];
    scanner.onWarning = (w) => warnings.push(w);

    // Key expires in 30 minutes — matches all 3 thresholds
    // First scan fires the largest (7d), subsequent scans fire 24h then 1h
    const keys = [makeKey({ expiresAt: futureDate(1800) })];
    scanner.start(() => keys);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].thresholdSeconds).toBe(604800); // Largest fires first

    // Second scan: 7d already notified → fires 24h
    const result2 = scanner.scan();
    expect(result2).toHaveLength(1);
    expect(result2[0].thresholdSeconds).toBe(86400);

    // Third scan: 7d, 24h already notified → fires 1h
    const result3 = scanner.scan();
    expect(result3).toHaveLength(1);
    expect(result3[0].thresholdSeconds).toBe(3600);

    // Fourth scan: all notified → nothing
    const result4 = scanner.scan();
    expect(result4).toHaveLength(0);
  });

  test('multiple thresholds — larger threshold fires for key further out', () => {
    scanner = new ExpiryScanner({ thresholds: [604800, 86400, 3600] });
    const warnings: any[] = [];
    scanner.onWarning = (w) => warnings.push(w);

    // Key expires in 2 days — matches 7d threshold only (not 24h or 1h)
    const keys = [makeKey({ expiresAt: futureDate(172800) })];
    scanner.start(() => keys);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].thresholdSeconds).toBe(604800);
  });

  test('skips revoked keys', () => {
    scanner = new ExpiryScanner({ thresholds: [3600] });
    const warnings: any[] = [];
    scanner.onWarning = (w) => warnings.push(w);

    const keys = [makeKey({ active: false, expiresAt: futureDate(1800) })];
    scanner.start(() => keys);
    expect(warnings).toHaveLength(0);
  });

  test('skips already-expired keys', () => {
    scanner = new ExpiryScanner({ thresholds: [3600] });
    const warnings: any[] = [];
    scanner.onWarning = (w) => warnings.push(w);

    const keys = [makeKey({ expiresAt: new Date(Date.now() - 60000).toISOString() })];
    scanner.start(() => keys);
    expect(warnings).toHaveLength(0);
  });

  test('includes alias in warning', () => {
    scanner = new ExpiryScanner({ thresholds: [3600] });
    const warnings: any[] = [];
    scanner.onWarning = (w) => warnings.push(w);

    const keys = [makeKey({ alias: 'my-alias', expiresAt: futureDate(1800) })];
    scanner.start(() => keys);

    expect(warnings[0].alias).toBe('my-alias');
  });

  test('destroy stops scanner and clears state', () => {
    scanner = new ExpiryScanner({ thresholds: [3600] });
    const keys = [makeKey({ expiresAt: futureDate(1800) })];
    scanner.start(() => keys);
    expect(scanner.status.notifiedCount).toBe(1);

    scanner.destroy();
    expect(scanner.status.notifiedCount).toBe(0);
  });

  test('minimum interval enforced to 60s', () => {
    scanner = new ExpiryScanner({ intervalSeconds: 10 });
    expect(scanner.status.intervalSeconds).toBe(60);
  });

  test('disabled scanner does not start', () => {
    scanner = new ExpiryScanner({ enabled: false, thresholds: [3600] });
    const warnings: any[] = [];
    scanner.onWarning = (w) => warnings.push(w);

    scanner.start(() => [makeKey({ expiresAt: futureDate(1800) })]);
    expect(warnings).toHaveLength(0);
  });

  test('onWarning callback errors do not crash scanner', () => {
    scanner = new ExpiryScanner({ thresholds: [3600] });
    scanner.onWarning = () => { throw new Error('boom'); };

    const keys = [makeKey({ expiresAt: futureDate(1800) })];
    // Should not throw
    expect(() => scanner.start(() => keys)).not.toThrow();
  });
});

// ─── Unit Tests: queryExpiring ────────────────────────────────────────────────

describe('ExpiryScanner.queryExpiring (static)', () => {
  test('returns keys sorted by urgency (most urgent first)', () => {
    const keys = [
      makeKey({ name: 'later', expiresAt: futureDate(7200) }),   // 2h
      makeKey({ name: 'sooner', expiresAt: futureDate(1800) }),  // 30m
      makeKey({ name: 'soonest', expiresAt: futureDate(300) }),  // 5m
    ];

    const result = ExpiryScanner.queryExpiring(keys, 86400);
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('soonest');
    expect(result[1].name).toBe('sooner');
    expect(result[2].name).toBe('later');
  });

  test('filters by within window', () => {
    const keys = [
      makeKey({ expiresAt: futureDate(1800) }),   // 30m → within 1h
      makeKey({ expiresAt: futureDate(7200) }),   // 2h  → outside 1h
    ];

    const result = ExpiryScanner.queryExpiring(keys, 3600);
    expect(result).toHaveLength(1);
  });

  test('excludes revoked and already-expired keys', () => {
    const keys = [
      makeKey({ active: false, expiresAt: futureDate(1800) }),
      makeKey({ expiresAt: new Date(Date.now() - 60000).toISOString() }),
      makeKey({ expiresAt: futureDate(1800) }), // Valid
    ];

    const result = ExpiryScanner.queryExpiring(keys, 3600);
    expect(result).toHaveLength(1);
  });

  test('includes suspended status', () => {
    const keys = [
      makeKey({ suspended: true, expiresAt: futureDate(1800) }),
    ];

    const result = ExpiryScanner.queryExpiring(keys, 3600);
    expect(result).toHaveLength(1);
    expect(result[0].suspended).toBe(true);
  });

  test('masks key in output', () => {
    const keys = [makeKey({ expiresAt: futureDate(1800) })];
    const result = ExpiryScanner.queryExpiring(keys, 3600);
    expect(result[0].keyPrefix).toMatch(/^pg_test_.*\.\.\.$/);
  });
});

// ─── Integration Tests: Server ──────────────────────────────────────────────

describe('GET /keys/expiring (integration)', () => {
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
    const result = await server.start();
    port = result.port;
    adminKey = result.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('returns empty list when no keys exist', async () => {
    const res = await request(port, 'GET', '/keys/expiring', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.keys).toEqual([]);
    expect(res.body.within).toBe(86400);
    expect(res.body.scanner).toBeDefined();
    expect(res.body.scanner.enabled).toBe(true);
  });

  test('returns expiring keys', async () => {
    // Create a key that expires in 1 hour
    const createRes = await request(port, 'POST', '/keys', { name: 'expiring-test', credits: 100 }, { 'X-Admin-Key': adminKey });
    expect(createRes.status).toBe(201);
    const key = createRes.body.key;

    // Set expiry to 1 hour from now
    const expiresAt = futureDate(3600);
    await request(port, 'POST', '/keys/expiry', { key, expiresAt }, { 'X-Admin-Key': adminKey });

    const res = await request(port, 'GET', '/keys/expiring?within=86400', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);

    const found = res.body.keys.find((k: any) => k.name === 'expiring-test');
    expect(found).toBeDefined();
    expect(found.remainingSeconds).toBeLessThanOrEqual(3600);
    expect(found.remainingHuman).toMatch(/\d+/);
  });

  test('within filter works', async () => {
    // Query with very small window — the 1h key should not appear
    const res = await request(port, 'GET', '/keys/expiring?within=60', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(200);
    const found = res.body.keys.find((k: any) => k.name === 'expiring-test');
    expect(found).toBeUndefined(); // 1h away, 60s window → not included
  });

  test('requires admin key', async () => {
    const res = await request(port, 'GET', '/keys/expiring', undefined, {});
    expect(res.status).toBe(401);
  });

  test('rejects invalid within parameter', async () => {
    const res = await request(port, 'GET', '/keys/expiring?within=-1', undefined, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(400);
  });

  test('rejects non-GET method', async () => {
    const res = await request(port, 'POST', '/keys/expiring', {}, { 'X-Admin-Key': adminKey });
    expect(res.status).toBe(405);
  });
});

describe('Expiry scanner webhook + audit integration', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      ...DEFAULT_CONFIG,
      port: 0,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      expiryScanner: {
        enabled: true,
        intervalSeconds: 60,
        thresholds: [86400], // 24h
      },
    });
    const result = await server.start();
    port = result.port;
    adminKey = result.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('scanner fires audit event for expiring key', async () => {
    // Create a key that expires in 1 hour (within 24h threshold)
    const createRes = await request(port, 'POST', '/keys', { name: 'audit-expiry-test', credits: 100 }, { 'X-Admin-Key': adminKey });
    const key = createRes.body.key;
    await request(port, 'POST', '/keys/expiry', { key, expiresAt: futureDate(3600) }, { 'X-Admin-Key': adminKey });

    // Manually trigger a scan
    server.expiryScanner.clearNotified();
    server.expiryScanner.scan();

    // Check audit log for key.expiry_warning
    const auditRes = await request(port, 'GET', '/audit?type=key.expiry_warning', undefined, { 'X-Admin-Key': adminKey });
    expect(auditRes.status).toBe(200);
    const warningEvents = auditRes.body.events.filter((e: any) => e.type === 'key.expiry_warning' && e.message.includes('audit-expiry-test'));
    expect(warningEvents.length).toBeGreaterThanOrEqual(1);
    expect(warningEvents[0].actor).toBe('system');
  });
});

describe('Root listing includes /keys/expiring', () => {
  let server: PayGateServer;
  let port: number;

  beforeAll(async () => {
    server = new PayGateServer({
      ...DEFAULT_CONFIG,
      port: 0,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
    });
    const result = await server.start();
    port = result.port;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('root listing includes keysExpiring endpoint', async () => {
    const res = await request(port, 'GET', '/', undefined, {});
    expect(res.status).toBe(200);
    expect(res.body.endpoints.keysExpiring).toContain('/keys/expiring');
  });
});

describe('Scanner with custom config', () => {
  let server: PayGateServer;

  afterEach(async () => {
    await server?.stop();
  });

  test('disabled scanner does not fire warnings', async () => {
    server = new PayGateServer({
      ...DEFAULT_CONFIG,
      port: 0,
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      expiryScanner: {
        enabled: false,
      },
    });
    const result = await server.start();
    const adminKey = result.adminKey;
    const port = result.port;

    // Create expiring key
    const createRes = await request(port, 'POST', '/keys', { name: 'disabled-scanner-test', credits: 100 }, { 'X-Admin-Key': adminKey });
    await request(port, 'POST', '/keys/expiry', { key: createRes.body.key, expiresAt: futureDate(1800) }, { 'X-Admin-Key': adminKey });

    // Scanner status should show disabled
    const res = await request(port, 'GET', '/keys/expiring', undefined, { 'X-Admin-Key': adminKey });
    expect(res.body.scanner.enabled).toBe(false);
  });
});
