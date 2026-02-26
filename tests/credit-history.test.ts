/**
 * Tests for v6.4.0 — Credit History Endpoint.
 *
 * Tests CreditLedger class (unit) and GET /keys/credit-history?key=...
 * endpoint (HTTP integration) with type/limit/since filters,
 * initial allocation, topup, transfer, auto-topup recording.
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

// ─── Unit tests for CreditLedger ───
describe('CreditLedger (unit)', () => {
  test('records and retrieves entries', () => {
    const ledger = new CreditLedger();
    ledger.record('key1', { type: 'initial', amount: 100, balanceBefore: 0, balanceAfter: 100 });
    ledger.record('key1', { type: 'topup', amount: 50, balanceBefore: 100, balanceAfter: 150 });

    const history = ledger.getHistory('key1');
    expect(history.length).toBe(2);
    // Newest first
    expect(history[0].type).toBe('topup');
    expect(history[1].type).toBe('initial');
    // Timestamps are ISO strings
    expect(history[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('returns empty array for unknown key', () => {
    const ledger = new CreditLedger();
    expect(ledger.getHistory('nonexistent')).toEqual([]);
  });

  test('caps entries at maxEntriesPerKey', () => {
    const ledger = new CreditLedger(5);
    for (let i = 0; i < 10; i++) {
      ledger.record('key1', { type: 'topup', amount: i, balanceBefore: i * 10, balanceAfter: (i + 1) * 10 });
    }
    expect(ledger.count('key1')).toBe(5);
    // Should keep the most recent 5
    const history = ledger.getHistory('key1');
    expect(history[0].amount).toBe(9); // newest
    expect(history[4].amount).toBe(5); // oldest remaining
  });

  test('filter by type', () => {
    const ledger = new CreditLedger();
    ledger.record('key1', { type: 'initial', amount: 100, balanceBefore: 0, balanceAfter: 100 });
    ledger.record('key1', { type: 'topup', amount: 50, balanceBefore: 100, balanceAfter: 150 });
    ledger.record('key1', { type: 'topup', amount: 25, balanceBefore: 150, balanceAfter: 175 });

    const topups = ledger.getHistory('key1', { type: 'topup' });
    expect(topups.length).toBe(2);
    expect(topups.every(e => e.type === 'topup')).toBe(true);
  });

  test('limit results', () => {
    const ledger = new CreditLedger();
    for (let i = 0; i < 10; i++) {
      ledger.record('key1', { type: 'topup', amount: i, balanceBefore: 0, balanceAfter: i });
    }
    const limited = ledger.getHistory('key1', { limit: 3 });
    expect(limited.length).toBe(3);
    expect(limited[0].amount).toBe(9); // newest
  });

  test('since filter', () => {
    const ledger = new CreditLedger();
    const now = new Date().toISOString();
    ledger.record('key1', { type: 'initial', amount: 100, balanceBefore: 0, balanceAfter: 100 });

    const sinceNow = ledger.getHistory('key1', { since: now });
    expect(sinceNow.length).toBe(1);

    const sinceFuture = ledger.getHistory('key1', { since: '2099-01-01T00:00:00Z' });
    expect(sinceFuture.length).toBe(0);
  });

  test('count returns entry count', () => {
    const ledger = new CreditLedger();
    expect(ledger.count('key1')).toBe(0);
    ledger.record('key1', { type: 'initial', amount: 100, balanceBefore: 0, balanceAfter: 100 });
    expect(ledger.count('key1')).toBe(1);
  });

  test('clear removes entries', () => {
    const ledger = new CreditLedger();
    ledger.record('key1', { type: 'initial', amount: 100, balanceBefore: 0, balanceAfter: 100 });
    ledger.clear('key1');
    expect(ledger.count('key1')).toBe(0);
    expect(ledger.getHistory('key1')).toEqual([]);
  });

  test('preserves memo field', () => {
    const ledger = new CreditLedger();
    ledger.record('key1', { type: 'transfer_in', amount: 50, balanceBefore: 0, balanceAfter: 50, memo: 'Monthly top-up' });
    const history = ledger.getHistory('key1');
    expect(history[0].memo).toBe('Monthly top-up');
  });
});

// ─── HTTP integration tests ───
describe('GET /keys/credit-history (HTTP)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let key1: string;
  let key2: string;

  beforeAll(async () => {
    server = makeServer();
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    // Create two keys
    const res1 = await httpPost(port, '/keys', { name: 'history-key-1', credits: 500 }, { 'x-admin-key': adminKey });
    key1 = res1.body.key;

    const res2 = await httpPost(port, '/keys', { name: 'history-key-2', credits: 300 }, { 'x-admin-key': adminKey });
    key2 = res2.body.key;
  });

  afterAll(async () => {
    if (server) await server.stop();
  });

  test('initial allocation is recorded on key creation', async () => {
    const res = await httpGet(port, `/keys/credit-history?key=${key1}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(1);
    expect(res.body.entries[0].type).toBe('initial');
    expect(res.body.entries[0].amount).toBe(500);
    expect(res.body.entries[0].balanceBefore).toBe(0);
    expect(res.body.entries[0].balanceAfter).toBe(500);
    expect(res.body.currentBalance).toBe(500);
    expect(res.body.name).toBe('history-key-1');
  });

  test('topup is recorded', async () => {
    await httpPost(port, '/topup', { key: key1, credits: 200 }, { 'x-admin-key': adminKey });
    const res = await httpGet(port, `/keys/credit-history?key=${key1}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(2);
    expect(res.body.entries[0].type).toBe('topup');
    expect(res.body.entries[0].amount).toBe(200);
    expect(res.body.entries[0].balanceBefore).toBe(500);
    expect(res.body.entries[0].balanceAfter).toBe(700);
    expect(res.body.currentBalance).toBe(700);
  });

  test('transfer records on both source and destination', async () => {
    await httpPost(port, '/keys/transfer', {
      from: key1, to: key2, credits: 100, memo: 'test transfer',
    }, { 'x-admin-key': adminKey });

    // Source (key1) should have transfer_out
    const res1 = await httpGet(port, `/keys/credit-history?key=${key1}`, { 'x-admin-key': adminKey });
    expect(res1.body.entries[0].type).toBe('transfer_out');
    expect(res1.body.entries[0].amount).toBe(100);
    expect(res1.body.entries[0].balanceBefore).toBe(700);
    expect(res1.body.entries[0].balanceAfter).toBe(600);
    expect(res1.body.entries[0].memo).toBe('test transfer');

    // Destination (key2) should have transfer_in
    const res2 = await httpGet(port, `/keys/credit-history?key=${key2}`, { 'x-admin-key': adminKey });
    expect(res2.body.entries[0].type).toBe('transfer_in');
    expect(res2.body.entries[0].amount).toBe(100);
    expect(res2.body.entries[0].balanceBefore).toBe(300);
    expect(res2.body.entries[0].balanceAfter).toBe(400);
  });

  test('filter by type', async () => {
    const res = await httpGet(port, `/keys/credit-history?key=${key1}&type=topup`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.entries.every((e: any) => e.type === 'topup')).toBe(true);
  });

  test('limit results', async () => {
    const res = await httpGet(port, `/keys/credit-history?key=${key1}&limit=1`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(1);
    expect(res.body.totalEntries).toBeGreaterThan(1);
  });

  test('key is masked in response', async () => {
    const res = await httpGet(port, `/keys/credit-history?key=${key1}`, { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.key).toContain('...');
  });

  test('requires admin auth', async () => {
    const res = await httpGet(port, `/keys/credit-history?key=${key1}`);
    expect(res.status).toBe(401);
  });

  test('requires key parameter', async () => {
    const res = await httpGet(port, '/keys/credit-history', { 'x-admin-key': adminKey });
    expect(res.status).toBe(400);
  });

  test('returns 404 for nonexistent key', async () => {
    const res = await httpGet(port, '/keys/credit-history?key=pg_nonexistent', { 'x-admin-key': adminKey });
    expect(res.status).toBe(404);
  });

  test('POST returns 405', async () => {
    const res = await httpPost(port, `/keys/credit-history?key=${key1}`, {}, { 'x-admin-key': adminKey });
    expect(res.status).toBe(405);
  });

  test('root listing includes credit-history', async () => {
    const res = await httpGet(port, '/', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    const str = JSON.stringify(res.body);
    expect(str).toContain('/keys/credit-history');
  });

  test('SDK exports CreditLedger and CreditEntry', () => {
    const sdk = require('../src/index');
    expect(sdk.CreditLedger).toBeDefined();
  });
});
