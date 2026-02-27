/**
 * Error response consistency tests — ensures all error responses include
 * requestId from X-Request-Id header via sendError().
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

function request(
  method: string,
  path: string,
  body: any,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': String(Buffer.byteLength(data)) } : {}),
        'X-Admin-Key': adminKey,
        'X-Request-Id': 'test-req-id-123',
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
    if (data) req.write(data);
    req.end();
  });
}

describe('sendError consistency — requestId in all error responses', () => {
  it('should include requestId in transfer insufficient credits error', async () => {
    // Create keys first and verify
    const k1 = await request('POST', '/keys', { name: 'src-xfer', credits: 5 });
    expect(k1.status).toBe(201);
    expect(k1.body.key).toBeDefined();

    const k2 = await request('POST', '/keys', { name: 'dst-xfer', credits: 1 });
    expect(k2.status).toBe(201);
    expect(k2.body.key).toBeDefined();

    // Try to transfer 100 (more than available)
    const resp = await request('POST', '/keys/transfer', {
      from: k1.body.key,
      to: k2.body.key,
      credits: 100,
    });
    expect(resp.status).toBe(400);
    expect(resp.body.error).toContain('Insufficient credits');
    expect(resp.body.requestId).toBe('test-req-id-123');
  });

  it('should include requestId in template not found error', async () => {
    const resp = await request('POST', '/keys', { name: 'tpl-test', credits: 10, template: 'nonexistent' });
    expect(resp.status).toBe(400);
    expect(resp.body.error).toContain('Template');
    expect(resp.body.requestId).toBe('test-req-id-123');
  });

  it('should include requestId in scheduled action invalid action error', async () => {
    const k = await request('POST', '/keys', { name: 'sched-test', credits: 10 });
    expect(k.status).toBe(201);
    const resp = await request('POST', '/keys/schedule', {
      key: k.body.key,
      action: 'invalid_action',
      executeAt: new Date(Date.now() + 60000).toISOString(),
    });
    expect(resp.status).toBe(400);
    expect(resp.body.error).toContain('Must be one of');
    expect(resp.body.requestId).toBe('test-req-id-123');
  });

  it('should include requestId in RBAC insufficient permissions error', async () => {
    // Create a read-only admin key
    const createResp = await request('POST', '/admin/keys', { name: 'readonly', role: 'viewer' });
    expect(createResp.status).toBe(201);
    const viewerKey = createResp.body.key;

    // Try to create a key with viewer permissions (needs admin role)
    const resp = await request('POST', '/admin/keys', { name: 'test', role: 'admin' }, {
      'X-Admin-Key': viewerKey,
    });
    expect(resp.status).toBe(403);
    expect(resp.body.error).toContain('Insufficient permissions');
    expect(resp.body.requiredRole).toBeDefined();
    expect(resp.body.currentRole).toBe('viewer');
    expect(resp.body.requestId).toBe('test-req-id-123');
  });

  it('should include requestId in group create error (duplicate name)', async () => {
    // Create a group — endpoint is POST /groups
    await request('POST', '/groups', { name: 'dup-group-consistency' });
    // Try to create duplicate
    const resp = await request('POST', '/groups', { name: 'dup-group-consistency' });
    expect(resp.status).toBe(400);
    expect(resp.body.requestId).toBe('test-req-id-123');
  });

  it('should include requestId in template delete not found error', async () => {
    const resp = await request('POST', '/keys/templates/delete', { name: 'nonexistent-template' });
    expect(resp.status).toBe(404);
    expect(resp.body.error).toMatch(/not found/i);
    expect(resp.body.requestId).toBe('test-req-id-123');
  });

  it('should include requestId in config reload without config path', async () => {
    const resp = await request('POST', '/config/reload', {});
    expect(resp.status).toBe(400);
    expect(resp.body.error).toContain('config');
    expect(resp.body.requestId).toBe('test-req-id-123');
  });

  it('should include requestId in note index out of range error', async () => {
    const k = await request('POST', '/keys', { name: 'note-test', credits: 10 });
    expect(k.status).toBe(201);
    const resp = await request('DELETE', `/keys/notes?key=${k.body.key}&index=999`, null);
    expect(resp.status).toBe(400);
    expect(resp.body.error).toContain('Invalid index');
    expect(resp.body.requestId).toBe('test-req-id-123');
  });

  it('should preserve extra data fields in sendError with data param', async () => {
    // Test reservation insufficient credits (has extra data: available, held, total, requested)
    const k = await request('POST', '/keys', { name: 'reserve-test', credits: 5 });
    expect(k.status).toBe(201);
    const resp = await request('POST', '/keys/reserve', {
      key: k.body.key,
      credits: 100,
    });
    expect(resp.status).toBe(400);
    expect(resp.body.error).toContain('Insufficient');
    expect(resp.body.requestId).toBe('test-req-id-123');
    // Extra data fields should be preserved
    expect(resp.body.available).toBeDefined();
    expect(resp.body.total).toBeDefined();
    expect(resp.body.requested).toBe(100);
  });

  it('should include requestId in admin key revoke error', async () => {
    // Try to revoke a non-existent admin key
    const resp = await request('POST', '/admin/keys/revoke', { key: 'nonexistent-key' });
    expect(resp.status).toBe(400);
    expect(resp.body.requestId).toBe('test-req-id-123');
  });
});
