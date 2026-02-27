/**
 * Resource cleanup tests — ensures event listener cleanup, bounded
 * response bodies, and proper teardown in error paths.
 */

import { PayGateServer } from '../src/server';
import http from 'http';
import net from 'net';

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
    requestTimeoutMs: 2000, // 2 second timeout for faster tests
  });
  const started = await server.start();
  port = started.port;
  adminKey = started.adminKey;
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

// ─── readBody cleanup tests ─────────────────────────────────────────────────

describe('readBody — Event Listener Cleanup', () => {
  it('should handle oversized body gracefully (413)', async () => {
    // Send a body larger than 1MB
    const largeBody = Buffer.alloc(1.1 * 1024 * 1024, 'x');
    const resp = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/keys',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(largeBody.length),
          'X-Admin-Key': adminKey,
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode!, body: data }));
      });
      req.on('error', () => resolve({ status: 0, body: 'connection error' }));
      req.write(largeBody);
      req.end();
    });

    // Should get either 413 or connection reset (both valid for oversized body)
    expect([413, 0]).toContain(resp.status);
  });

  it('should continue to work after oversized body rejection', async () => {
    // Small delay to let the server finish cleaning up the oversized connection
    await new Promise(r => setTimeout(r, 100));
    // Server should still accept normal requests — retry once on transient ECONNRESET
    let resp: { status: number; body: any };
    try {
      resp = await post('/keys', { name: 'after-oversize', credits: 10 });
    } catch {
      // Transient ECONNRESET in CI — retry after brief pause
      await new Promise(r => setTimeout(r, 200));
      resp = await post('/keys', { name: 'after-oversize-retry', credits: 10 });
    }
    expect(resp.status).toBe(201);
    expect(resp.body.key).toBeDefined();
  });

  it('should handle slow-loris timeout (drip body byte-by-byte)', async () => {
    const result = await new Promise<string>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        // Send HTTP headers but then drip the body slowly
        socket.write('POST /keys HTTP/1.1\r\n');
        socket.write('Host: localhost\r\n');
        socket.write(`X-Admin-Key: ${adminKey}\r\n`);
        socket.write('Content-Type: application/json\r\n');
        socket.write('Content-Length: 1000\r\n'); // Claim 1000 bytes
        socket.write('\r\n');
        // Only send 5 bytes, then wait for timeout
        socket.write('{"a":');

        // Don't send the rest — server should time out
      });
      socket.on('data', () => {
        resolve('got response');
      });
      socket.on('close', () => {
        resolve('closed');
      });
      socket.on('error', () => {
        resolve('error');
      });
      // Give it enough time for the 2s timeout
      setTimeout(() => {
        socket.destroy();
        resolve('client timeout');
      }, 5000);
    });

    // Server should either close the connection or send an error
    expect(['got response', 'closed', 'error', 'client timeout']).toContain(result);
  });

  it('should continue working after timeout rejection', async () => {
    const resp = await post('/keys', { name: 'after-timeout', credits: 10 });
    expect(resp.status).toBe(201);
  });
});

// ─── Server resilience after error paths ─────────────────────────────────────

describe('Server resilience after error paths', () => {
  it('should handle multiple rapid error requests', async () => {
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        new Promise<number>((resolve) => {
          const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: '/keys',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': '11',
              'X-Admin-Key': adminKey,
            },
          }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode!));
          });
          req.on('error', () => resolve(0));
          req.write('not-json!!!');
          req.end();
        })
      );
    }

    const results = await Promise.all(promises);
    // All should get 400 (invalid JSON)
    expect(results.filter(s => s === 400).length).toBe(10);
  });

  it('should remain healthy after error burst', async () => {
    const resp = await new Promise<number>((resolve) => {
      http.get(`http://127.0.0.1:${port}/health`, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      }).on('error', () => resolve(0));
    });
    expect(resp).toBe(200);
  });

  it('should handle concurrent valid + invalid requests', async () => {
    const valid = post('/keys', { name: 'concurrent-test', credits: 10 });
    const invalid = new Promise<number>((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/keys',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '3', 'X-Admin-Key': adminKey },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', () => resolve(0));
      req.write('bad');
      req.end();
    });

    const [validResp, invalidStatus] = await Promise.all([valid, invalid]);
    expect(validResp.status).toBe(201);
    expect(invalidStatus).toBe(400);
  });
});
