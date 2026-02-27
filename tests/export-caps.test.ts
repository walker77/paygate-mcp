/**
 * Export endpoint response cap tests — verifies that all export endpoints
 * enforce pagination limits to prevent memory exhaustion DoS attacks.
 *
 * v8.88.0: Export endpoints (/audit/export, /keys/export, /requests/export)
 * previously returned unbounded response data. Now capped with limit/offset.
 */

import { PayGateServer } from '../src/server';
import http from 'http';

// Suppress logger output in tests
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

let server: PayGateServer;
let port: number;
let adminKey: string;

beforeAll(async () => {
  server = new PayGateServer({
    serverCommand: 'echo',
    serverArgs: ['test'],
    port: 0,
    requestTimeoutMs: 3000,
  });
  const started = await server.start();
  port = started.port;
  adminKey = started.adminKey;

  // Create some keys to export
  for (let i = 0; i < 10; i++) {
    await postJson('/keys', { credits: 100, name: `cap-test-key-${i}` });
  }
});

afterAll(async () => {
  await server.gracefulStop(1000);
});

function getJson(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: {
        'X-Admin-Key': adminKey,
        ...headers,
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (chunk) => chunks += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(chunks) });
        } catch {
          resolve({ status: res.statusCode!, body: chunks });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function postJson(path: string, body: any, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'X-Admin-Key': adminKey,
        ...headers,
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (chunk) => chunks += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(chunks) });
        } catch {
          resolve({ status: res.statusCode!, body: chunks });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('Export endpoint response caps', () => {
  // ── /keys/export ──────────────────────────────────────────────
  test('/keys/export returns pagination metadata', async () => {
    const res = await getJson('/keys/export');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBeDefined();
    expect(res.body.offset).toBeDefined();
    expect(res.body.total).toBeDefined();
    expect(typeof res.body.limit).toBe('number');
    expect(typeof res.body.offset).toBe('number');
    expect(typeof res.body.total).toBe('number');
  });

  test('/keys/export default limit is 1000', async () => {
    const res = await getJson('/keys/export');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(1000);
    expect(res.body.offset).toBe(0);
  });

  test('/keys/export respects custom limit', async () => {
    const res = await getJson('/keys/export?limit=3');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(3);
    expect(res.body.keys.length).toBeLessThanOrEqual(3);
  });

  test('/keys/export respects offset', async () => {
    const res = await getJson('/keys/export?limit=5&offset=2');
    expect(res.status).toBe(200);
    expect(res.body.offset).toBe(2);
    expect(res.body.limit).toBe(5);
  });

  test('/keys/export clamps limit to max 5000', async () => {
    const res = await getJson('/keys/export?limit=99999');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(5000);
  });

  test('/keys/export clamps negative limit to 1', async () => {
    const res = await getJson('/keys/export?limit=-5');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(1);
  });

  // ── /audit/export ─────────────────────────────────────────────
  test('/audit/export returns pagination metadata', async () => {
    const res = await getJson('/audit/export');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBeDefined();
    expect(res.body.offset).toBeDefined();
    expect(res.body.total).toBeDefined();
  });

  test('/audit/export default limit is 1000', async () => {
    const res = await getJson('/audit/export');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(1000);
    expect(res.body.offset).toBe(0);
  });

  test('/audit/export respects custom limit', async () => {
    const res = await getJson('/audit/export?limit=5');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(5);
    expect(res.body.events.length).toBeLessThanOrEqual(5);
  });

  test('/audit/export clamps limit to max 5000', async () => {
    const res = await getJson('/audit/export?limit=99999');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(5000);
  });

  // ── /requests/export ──────────────────────────────────────────
  test('/requests/export returns pagination metadata', async () => {
    const res = await getJson('/requests/export');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBeDefined();
    expect(res.body.offset).toBeDefined();
    expect(res.body.total).toBeDefined();
  });

  test('/requests/export default limit is 1000', async () => {
    const res = await getJson('/requests/export');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(1000);
    expect(res.body.offset).toBe(0);
  });

  test('/requests/export respects custom limit', async () => {
    const res = await getJson('/requests/export?limit=2');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(2);
    expect(res.body.requests.length).toBeLessThanOrEqual(2);
  });

  test('/requests/export clamps limit to max 5000', async () => {
    const res = await getJson('/requests/export?limit=99999');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(5000);
  });

  // ── /keys legacy (no pagination params) ───────────────────────
  test('/keys legacy listing is capped', async () => {
    const res = await getJson('/keys');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeLessThanOrEqual(500);
  });

  // ── CSV export also respects caps ─────────────────────────────
  test('/keys/export CSV respects limit', async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/keys/export?format=csv&limit=3',
        method: 'GET',
        headers: { 'X-Admin-Key': adminKey },
      }, (response) => {
        let data = '';
        response.on('data', (chunk) => data += chunk);
        response.on('end', () => resolve({ status: response.statusCode!, body: data }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(200);
    const lines = res.body.trim().split('\n');
    // First line is header, rest are data rows
    expect(lines.length).toBeLessThanOrEqual(4); // header + max 3 rows
  });

  test('/audit/export CSV respects limit', async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/audit/export?format=csv&limit=3',
        method: 'GET',
        headers: { 'X-Admin-Key': adminKey },
      }, (response) => {
        let data = '';
        response.on('data', (chunk) => data += chunk);
        response.on('end', () => resolve({ status: response.statusCode!, body: data }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(200);
    const lines = res.body.trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(4); // header + max 3 rows
  });
});
