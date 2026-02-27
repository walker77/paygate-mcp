/**
 * Admin query parameter hardening tests — ensures pagination, sort,
 * and order parameters are validated against allowlists and bounds.
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
  });
  const started = await server.start();
  port = started.port;
  adminKey = started.adminKey;

  // Create some test keys to query
  for (let i = 0; i < 5; i++) {
    await post(`/keys`, { name: `qp-test-${i}`, credits: 100 });
  }
});

afterAll(async () => {
  await server.gracefulStop(1000);
});

function post(path: string, body: any, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
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

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, {
      headers: { 'X-Admin-Key': adminKey, ...headers },
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
    }).on('error', reject);
  });
}

// ─── sortBy Validation ──────────────────────────────────────────────────────

describe('Query Parameter Hardening — sortBy', () => {
  it('should accept valid sortBy fields', async () => {
    const validFields = ['name', 'credits', 'totalSpent', 'totalCalls', 'lastUsedAt', 'createdAt'];
    for (const field of validFields) {
      const resp = await get(`/keys?sortBy=${field}&limit=1`);
      expect(resp.status).toBe(200);
    }
  });

  it('should reject invalid sortBy field', async () => {
    const resp = await get('/keys?sortBy=__proto__&limit=1');
    expect(resp.status).toBe(400);
    expect(resp.body.error).toContain('Invalid sortBy');
  });

  it('should reject sortBy=constructor', async () => {
    const resp = await get('/keys?sortBy=constructor&limit=1');
    expect(resp.status).toBe(400);
    expect(resp.body.error).toContain('Invalid sortBy');
  });

  it('should reject sortBy with arbitrary string', async () => {
    const resp = await get('/keys?sortBy=nonexistentField&limit=1');
    expect(resp.status).toBe(400);
    expect(resp.body.error).toContain('Must be one of');
  });

  it('should include valid fields in error message', async () => {
    const resp = await get('/keys?sortBy=bad&limit=1');
    expect(resp.status).toBe(400);
    expect(resp.body.error).toContain('name');
    expect(resp.body.error).toContain('credits');
    expect(resp.body.error).toContain('createdAt');
  });
});

// ─── order Validation ───────────────────────────────────────────────────────

describe('Query Parameter Hardening — order', () => {
  it('should accept order=asc', async () => {
    const resp = await get('/keys?order=asc&limit=1');
    expect(resp.status).toBe(200);
  });

  it('should accept order=desc', async () => {
    const resp = await get('/keys?order=desc&limit=1');
    expect(resp.status).toBe(200);
  });

  it('should reject invalid order', async () => {
    const resp = await get('/keys?order=invalid&limit=1');
    expect(resp.status).toBe(400);
    expect(resp.body.error).toContain('Invalid order');
  });

  it('should reject order=random', async () => {
    const resp = await get('/keys?order=random&limit=1');
    expect(resp.status).toBe(400);
  });
});

// ─── limit/offset Bounds ────────────────────────────────────────────────────

describe('Query Parameter Hardening — limit/offset', () => {
  it('should clamp negative limit to 1', async () => {
    const resp = await get('/keys?limit=-5');
    expect(resp.status).toBe(200);
    expect(resp.body.limit).toBeGreaterThanOrEqual(1);
  });

  it('should clamp excessively large limit', async () => {
    const resp = await get('/keys?limit=999999');
    expect(resp.status).toBe(200);
    expect(resp.body.limit).toBeLessThanOrEqual(500);
  });

  it('should clamp negative offset to 0', async () => {
    const resp = await get('/keys?offset=-10&limit=1');
    expect(resp.status).toBe(200);
    expect(resp.body.offset).toBe(0);
  });

  it('should handle NaN limit gracefully', async () => {
    const resp = await get('/keys?limit=abc');
    expect(resp.status).toBe(200);
    // Should use default, not crash
    expect(resp.body.keys).toBeDefined();
  });

  it('should handle NaN offset gracefully', async () => {
    const resp = await get('/keys?offset=xyz&limit=1');
    expect(resp.status).toBe(200);
    expect(resp.body.offset).toBe(0);
  });

  it('should accept normal pagination', async () => {
    const resp = await get('/keys?limit=2&offset=0');
    expect(resp.status).toBe(200);
    expect(resp.body.keys.length).toBeLessThanOrEqual(2);
    expect(resp.body.limit).toBe(2);
    expect(resp.body.offset).toBe(0);
  });
});

// ─── Audit endpoint limit/offset ────────────────────────────────────────────

describe('Query Parameter Hardening — Audit', () => {
  it('should clamp audit limit to 1000', async () => {
    const resp = await get('/audit?limit=5000');
    expect(resp.status).toBe(200);
    expect(resp.body.limit).toBeLessThanOrEqual(1000);
  });

  it('should clamp audit offset to 0 for negative', async () => {
    const resp = await get('/audit?offset=-1');
    expect(resp.status).toBe(200);
    expect(resp.body.offset).toBe(0);
  });

  it('should handle NaN audit limit gracefully', async () => {
    const resp = await get('/audit?limit=bad');
    expect(resp.status).toBe(200);
    // Should not crash
    expect(resp.body.events).toBeDefined();
  });
});

// ─── Request log limit/offset ───────────────────────────────────────────────

describe('Query Parameter Hardening — Request Log', () => {
  it('should clamp request log limit to 1000', async () => {
    const resp = await get('/requests?limit=5000');
    expect(resp.status).toBe(200);
    expect(resp.body.limit).toBeLessThanOrEqual(1000);
  });

  it('should clamp request log offset to 0 for negative', async () => {
    const resp = await get('/requests?offset=-1');
    expect(resp.status).toBe(200);
    expect(resp.body.offset).toBe(0);
  });
});
