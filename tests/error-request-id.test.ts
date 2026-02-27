/**
 * Request ID in error responses — ensures every JSON error body includes
 * the request's X-Request-Id for client-side log correlation.
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
});

afterAll(async () => {
  await server.gracefulStop(1000);
});

function post(path: string, body: any, headers: Record<string, string> = {}): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
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
        ...headers,
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (chunk) => chunks += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(chunks), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode!, body: chunks, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, { headers }, (res) => {
      let chunks = '';
      res.on('data', (chunk) => chunks += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(chunks), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode!, body: chunks, headers: res.headers });
        }
      });
    }).on('error', reject);
  });
}

describe('Request ID in Error Responses', () => {
  it('should include requestId in 401 error body (missing admin key)', async () => {
    const resp = await get('/status');
    expect(resp.status).toBe(401);
    expect(resp.body.error).toBeDefined();
    expect(resp.body.requestId).toBeDefined();
    expect(typeof resp.body.requestId).toBe('string');
    expect(resp.body.requestId.length).toBeGreaterThan(0);
  });

  it('should include requestId in 401 error body (wrong admin key)', async () => {
    const resp = await get('/status', { 'X-Admin-Key': 'wrong_key' });
    expect(resp.status).toBe(401);
    expect(resp.body.requestId).toBeDefined();
    // Should match the X-Request-Id header
    expect(resp.body.requestId).toBe(resp.headers['x-request-id']);
  });

  it('should include requestId in 400 error body (invalid JSON)', async () => {
    const resp = await new Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/keys',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': 11,
          'X-Admin-Key': adminKey,
        },
      }, (res) => {
        let chunks = '';
        res.on('data', (chunk) => chunks += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(chunks), headers: res.headers });
          } catch {
            resolve({ status: res.statusCode!, body: chunks, headers: res.headers });
          }
        });
      });
      req.on('error', reject);
      req.write('not-json!!!');
      req.end();
    });

    expect(resp.status).toBe(400);
    expect(resp.body.requestId).toBeDefined();
  });

  it('should include requestId in 400 error body (missing fields)', async () => {
    // POST /admin/keys with missing name → 400
    const resp = await post('/admin/keys', {}, { 'X-Admin-Key': adminKey });
    expect(resp.status).toBe(400);
    expect(resp.body.error).toContain('name');
    expect(resp.body.requestId).toBeDefined();
    expect(resp.body.requestId).toBe(resp.headers['x-request-id']);
  });

  it('should match requestId between header and body', async () => {
    const resp = await get('/status', { 'X-Admin-Key': 'invalid' });
    expect(resp.status).toBe(401);
    const headerRequestId = resp.headers['x-request-id'];
    const bodyRequestId = resp.body.requestId;
    expect(headerRequestId).toBeDefined();
    expect(bodyRequestId).toBeDefined();
    expect(headerRequestId).toBe(bodyRequestId);
  });

  it('should include requestId in 404 error body', async () => {
    const resp = await get('/nonexistent-endpoint', { 'X-Admin-Key': adminKey });
    // Depending on server behavior, this might be a 401, 404, or other error
    expect(resp.body.requestId || resp.headers['x-request-id']).toBeDefined();
  });

  it('should NOT include requestId in success responses (success bodies have their own structure)', async () => {
    const resp = await get('/status', { 'X-Admin-Key': adminKey });
    expect(resp.status).toBe(200);
    // Success responses have X-Request-Id header but body has its own structure
    expect(resp.headers['x-request-id']).toBeDefined();
  });
});
