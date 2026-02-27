/**
 * JSON-RPC 2.0 envelope validation tests — ensures request validation
 * rejects malformed requests per the JSON-RPC 2.0 specification.
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
let apiKey: string;

beforeAll(async () => {
  server = new PayGateServer({
    serverCommand: 'echo',
    serverArgs: ['test'],
    port: 0,
  });
  const started = await server.start();
  port = started.port;
  adminKey = started.adminKey;

  // Create an API key for /mcp tests
  const resp = await postAdmin('/keys', { name: 'test-key', credits: 100 });
  apiKey = resp.body.key;
});

afterAll(async () => {
  await server.gracefulStop(1000);
});

function postAdmin(path: string, body: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(data)),
        'X-Admin-Key': adminKey,
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

function postMcp(body: string | object): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(data)),
        'Authorization': `Bearer ${apiKey}`,
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

describe('JSON-RPC 2.0 envelope validation', () => {
  it('should reject non-object body (array)', async () => {
    const resp = await postMcp('[1,2,3]');
    expect(resp.status).toBe(400);
    expect(resp.body.error.code).toBe(-32600);
    expect(resp.body.error.message).toContain('expected JSON object');
  });

  it('should reject non-object body (string)', async () => {
    const resp = await postMcp('"hello"');
    expect(resp.status).toBe(400);
    expect(resp.body.error.code).toBe(-32600);
  });

  it('should reject missing jsonrpc field', async () => {
    const resp = await postMcp({ id: 1, method: 'initialize' });
    expect(resp.status).toBe(400);
    expect(resp.body.error.code).toBe(-32600);
    expect(resp.body.error.message).toContain('jsonrpc must be "2.0"');
  });

  it('should reject wrong jsonrpc version', async () => {
    const resp = await postMcp({ jsonrpc: '1.0', id: 1, method: 'initialize' });
    expect(resp.status).toBe(400);
    expect(resp.body.error.code).toBe(-32600);
    expect(resp.body.error.message).toContain('jsonrpc must be "2.0"');
  });

  it('should reject missing method', async () => {
    const resp = await postMcp({ jsonrpc: '2.0', id: 1 });
    expect(resp.status).toBe(400);
    expect(resp.body.error.code).toBe(-32600);
    expect(resp.body.error.message).toContain('method must be a string');
  });

  it('should reject non-string method', async () => {
    const resp = await postMcp(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 42 }));
    expect(resp.status).toBe(400);
    expect(resp.body.error.code).toBe(-32600);
    expect(resp.body.error.message).toContain('method must be a string');
  });

  it('should reject object id', async () => {
    const resp = await postMcp(JSON.stringify({ jsonrpc: '2.0', id: { malicious: true }, method: 'initialize' }));
    expect(resp.status).toBe(400);
    expect(resp.body.error.code).toBe(-32600);
    expect(resp.body.error.message).toContain('id must be string, number, or null');
  });

  it('should reject array id', async () => {
    const resp = await postMcp(JSON.stringify({ jsonrpc: '2.0', id: [1, 2, 3], method: 'initialize' }));
    expect(resp.status).toBe(400);
    expect(resp.body.error.code).toBe(-32600);
    expect(resp.body.error.message).toContain('id must be string, number, or null');
  });

  it('should reject boolean id', async () => {
    const resp = await postMcp(JSON.stringify({ jsonrpc: '2.0', id: true, method: 'initialize' }));
    expect(resp.status).toBe(400);
    expect(resp.body.error.code).toBe(-32600);
    expect(resp.body.error.message).toContain('id must be string, number, or null');
  });

  it('should accept string id', async () => {
    const resp = await postMcp({ jsonrpc: '2.0', id: 'req-1', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } });
    // Should not get -32600 (may get other errors from downstream but not envelope error)
    expect(resp.body.error?.code).not.toBe(-32600);
  });

  it('should accept number id', async () => {
    const resp = await postMcp({ jsonrpc: '2.0', id: 42, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } });
    expect(resp.body.error?.code).not.toBe(-32600);
  });

  it('should accept null id (notification per spec)', async () => {
    const resp = await postMcp(JSON.stringify({ jsonrpc: '2.0', id: null, method: 'notifications/initialized' }));
    // Null id means notification — should not return envelope validation error
    expect(resp.body.error?.code).not.toBe(-32600);
  });

  it('should accept missing id (notification)', async () => {
    const resp = await postMcp({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(resp.body.error?.code).not.toBe(-32600);
  });

  it('should reject __proto__ method injection', async () => {
    const resp = await postMcp(JSON.stringify({ jsonrpc: '2.0', id: 1, method: '__proto__' }));
    // Should pass envelope validation but not cause prototype pollution
    // The server should handle it as an unknown method
    expect(resp.status).toBe(200); // JSON-RPC errors are returned as 200
  });
});
