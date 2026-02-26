/**
 * Tests for v6.5.0 — Spending Velocity & Depletion Forecast.
 *
 * Tests CreditLedger.getSpendingVelocity() (unit) and
 * GET /keys/spending-velocity?key=... endpoint (HTTP integration).
 */

import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';
import { CreditLedger } from '../src/credit-ledger';
import http from 'http';

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

async function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
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

async function httpPost(port: number, path: string, body: object, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode!, body: buf }); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── Unit tests for CreditLedger.getSpendingVelocity ───
describe('CreditLedger.getSpendingVelocity (unit)', () => {
  test('returns zero velocity with no entries', () => {
    const ledger = new CreditLedger();
    const v = ledger.getSpendingVelocity('key1', 500, 24);
    expect(v.creditsPerHour).toBe(0);
    expect(v.creditsPerDay).toBe(0);
    expect(v.callsPerHour).toBe(0);
    expect(v.callsPerDay).toBe(0);
    expect(v.estimatedDepletionDate).toBeNull();
    expect(v.estimatedHoursRemaining).toBeNull();
    expect(v.windowHours).toBe(24);
    expect(v.dataPoints).toBe(0);
  });

  test('returns zero velocity with only credit entries (no debits)', () => {
    const ledger = new CreditLedger();
    ledger.record('key1', { type: 'initial', amount: 100, balanceBefore: 0, balanceAfter: 100 });
    ledger.record('key1', { type: 'topup', amount: 50, balanceBefore: 100, balanceAfter: 150 });
    const v = ledger.getSpendingVelocity('key1', 150, 24);
    expect(v.creditsPerHour).toBe(0);
    expect(v.creditsPerDay).toBe(0);
    expect(v.dataPoints).toBe(0);
    expect(v.estimatedDepletionDate).toBeNull();
  });

  test('calculates velocity from deduction entries', () => {
    const ledger = new CreditLedger();
    ledger.record('key1', { type: 'initial', amount: 1000, balanceBefore: 0, balanceAfter: 1000 });
    // Simulate deductions
    ledger.record('key1', { type: 'deduction', amount: 10, balanceBefore: 1000, balanceAfter: 990 });
    ledger.record('key1', { type: 'deduction', amount: 20, balanceBefore: 990, balanceAfter: 970 });
    ledger.record('key1', { type: 'deduction', amount: 30, balanceBefore: 970, balanceAfter: 940 });

    const v = ledger.getSpendingVelocity('key1', 940, 24);
    expect(v.dataPoints).toBe(3);
    // Total debited = 60
    expect(v.creditsPerHour).toBeGreaterThan(0);
    expect(v.creditsPerDay).toBeGreaterThan(0);
    expect(v.callsPerHour).toBeGreaterThan(0);
    expect(v.callsPerDay).toBeGreaterThan(0);
  });

  test('includes transfer_out as debit', () => {
    const ledger = new CreditLedger();
    ledger.record('key1', { type: 'transfer_out', amount: 50, balanceBefore: 200, balanceAfter: 150 });
    const v = ledger.getSpendingVelocity('key1', 150, 24);
    expect(v.dataPoints).toBe(1);
    expect(v.creditsPerHour).toBeGreaterThan(0);
  });

  test('computes depletion estimate', () => {
    const ledger = new CreditLedger();
    ledger.record('key1', { type: 'deduction', amount: 100, balanceBefore: 500, balanceAfter: 400 });
    const v = ledger.getSpendingVelocity('key1', 400, 24);
    expect(v.estimatedDepletionDate).toBeTruthy();
    expect(v.estimatedHoursRemaining).toBeGreaterThan(0);
    // Should be an ISO date string
    expect(v.estimatedDepletionDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('zero balance returns immediate depletion', () => {
    const ledger = new CreditLedger();
    ledger.record('key1', { type: 'deduction', amount: 100, balanceBefore: 100, balanceAfter: 0 });
    const v = ledger.getSpendingVelocity('key1', 0, 24);
    expect(v.estimatedHoursRemaining).toBe(0);
    expect(v.estimatedDepletionDate).toBeTruthy();
  });

  test('respects window parameter', () => {
    const ledger = new CreditLedger();
    ledger.record('key1', { type: 'deduction', amount: 10, balanceBefore: 100, balanceAfter: 90 });
    const v1 = ledger.getSpendingVelocity('key1', 90, 1);
    const v24 = ledger.getSpendingVelocity('key1', 90, 24);
    // Both should find the deduction since it was just recorded
    expect(v1.dataPoints).toBe(1);
    expect(v24.dataPoints).toBe(1);
    expect(v1.windowHours).toBe(1);
    expect(v24.windowHours).toBe(24);
  });

  test('SpendingVelocity interface has all required fields', () => {
    const ledger = new CreditLedger();
    const v = ledger.getSpendingVelocity('key1', 0, 24);
    expect(v).toHaveProperty('creditsPerHour');
    expect(v).toHaveProperty('creditsPerDay');
    expect(v).toHaveProperty('callsPerHour');
    expect(v).toHaveProperty('callsPerDay');
    expect(v).toHaveProperty('estimatedDepletionDate');
    expect(v).toHaveProperty('estimatedHoursRemaining');
    expect(v).toHaveProperty('windowHours');
    expect(v).toHaveProperty('dataPoints');
  });
});

// ─── HTTP integration tests ───
describe('GET /keys/spending-velocity (HTTP)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let testKey: string;

  beforeAll(async () => {
    server = makeServer();
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    const res = await httpPost(port, '/keys', { name: 'velocity-key', credits: 1000 }, { 'x-admin-key': adminKey });
    testKey = res.body.key;
  });

  afterAll(async () => {
    if (server) await server.stop();
  });

  test('returns velocity for a key with no spending', async () => {
    const res = await httpGet(port, `/keys/spending-velocity?key=${testKey}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('velocity-key');
    expect(res.body.currentBalance).toBe(1000);
    expect(res.body.velocity.creditsPerHour).toBe(0);
    expect(res.body.velocity.creditsPerDay).toBe(0);
    expect(res.body.velocity.dataPoints).toBe(0);
    expect(res.body.velocity.estimatedDepletionDate).toBeNull();
    expect(res.body.topTools).toEqual([]);
  });

  test('key is masked in response', async () => {
    const res = await httpGet(port, `/keys/spending-velocity?key=${testKey}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.key).toContain('...');
  });

  test('accepts custom window parameter', async () => {
    const res = await httpGet(port, `/keys/spending-velocity?key=${testKey}&window=48`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.velocity.windowHours).toBe(48);
  });

  test('clamps window to valid range', async () => {
    // Below min (1h)
    const resLow = await httpGet(port, `/keys/spending-velocity?key=${testKey}&window=0`, { 'x-admin-key': adminKey });
    expect(resLow.status).toBe(200);
    expect(resLow.body.velocity.windowHours).toBe(1);

    // Above max (720h = 30 days)
    const resHigh = await httpGet(port, `/keys/spending-velocity?key=${testKey}&window=9999`, { 'x-admin-key': adminKey });
    expect(resHigh.status).toBe(200);
    expect(resHigh.body.velocity.windowHours).toBe(720);
  });

  test('requires admin auth', async () => {
    const res = await httpGet(port, `/keys/spending-velocity?key=${testKey}`);
    expect(res.status).toBe(401);
  });

  test('requires key parameter', async () => {
    const res = await httpGet(port, '/keys/spending-velocity', { 'x-admin-key': adminKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('key');
  });

  test('returns 404 for nonexistent key', async () => {
    const res = await httpGet(port, '/keys/spending-velocity?key=pg_nonexistent', { 'x-admin-key': adminKey });
    expect(res.status).toBe(404);
  });

  test('POST returns 405', async () => {
    const res = await httpPost(port, `/keys/spending-velocity?key=${testKey}`, {}, { 'x-admin-key': adminKey });
    expect(res.status).toBe(405);
  });

  test('root listing includes spending-velocity', async () => {
    const res = await httpGet(port, '/', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    const str = JSON.stringify(res.body);
    expect(str).toContain('/keys/spending-velocity');
  });

  test('SDK exports SpendingVelocity type', () => {
    const sdk = require('../src/index');
    // SpendingVelocity is a type export, so we check CreditLedger has getSpendingVelocity
    expect(typeof sdk.CreditLedger.prototype.getSpendingVelocity).toBe('function');
  });

  test('velocity response shape is correct', async () => {
    const res = await httpGet(port, `/keys/spending-velocity?key=${testKey}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('key');
    expect(res.body).toHaveProperty('name');
    expect(res.body).toHaveProperty('currentBalance');
    expect(res.body).toHaveProperty('velocity');
    expect(res.body).toHaveProperty('topTools');
    expect(res.body.velocity).toHaveProperty('creditsPerHour');
    expect(res.body.velocity).toHaveProperty('creditsPerDay');
    expect(res.body.velocity).toHaveProperty('callsPerHour');
    expect(res.body.velocity).toHaveProperty('callsPerDay');
    expect(res.body.velocity).toHaveProperty('estimatedDepletionDate');
    expect(res.body.velocity).toHaveProperty('estimatedHoursRemaining');
    expect(res.body.velocity).toHaveProperty('windowHours');
    expect(res.body.velocity).toHaveProperty('dataPoints');
    expect(Array.isArray(res.body.topTools)).toBe(true);
  });
});
