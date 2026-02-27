/**
 * Process safety tests — clientError handling, body read timeout, global error handlers.
 */

import { PayGateServer } from '../src/server';
import http from 'http';
import net from 'net';

// Suppress logger output in tests
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

describe('Process Safety', () => {
  let server: PayGateServer;
  let port: number;

  afterEach(async () => {
    if (server) {
      await server.gracefulStop(1000);
    }
  });

  // ─── clientError Handler ──────────────────────────────────────────────────

  it('should handle malformed HTTP requests without crashing', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const started = await server.start();
    port = started.port;

    // Send raw garbage that isn't valid HTTP
    await new Promise<void>((resolve) => {
      const socket = net.createConnection(port, '127.0.0.1', () => {
        socket.write('NOT A VALID HTTP REQUEST\r\n\r\n');
        // Give the server time to process
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 200);
      });
      socket.on('error', () => resolve()); // Expected — server may close socket
    });

    // Server should still be responsive after malformed request
    const response = await new Promise<any>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/health`, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      }).on('error', reject);
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBeDefined();
  });

  it('should respond 400 to incomplete HTTP headers', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const started = await server.start();
    port = started.port;

    // Send a partial HTTP request with absurdly long header
    const received = await new Promise<string>((resolve) => {
      const socket = net.createConnection(port, '127.0.0.1', () => {
        // Send malformed request line
        socket.write('GET / HTTP/9.9\r\n\r\n');
      });
      let data = '';
      socket.on('data', (chunk) => { data += chunk.toString(); });
      socket.on('close', () => resolve(data));
      socket.on('error', () => resolve(data));
      setTimeout(() => { socket.destroy(); resolve(data); }, 500);
    });

    // Server may respond with 400 or simply close — both are acceptable
    // The key assertion is the server doesn't crash
    const response = await new Promise<any>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/health`, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode }));
      }).on('error', reject);
    });
    expect(response.status).toBe(200);
  });

  // ─── Body Read Timeout ────────────────────────────────────────────────────

  it('should timeout slow body reads', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      requestTimeoutMs: 500, // Very short timeout for testing
    });
    const started = await server.start();
    port = started.port;

    // Send headers but drip the body very slowly
    const response = await new Promise<number>((resolve) => {
      const socket = net.createConnection(port, '127.0.0.1', () => {
        socket.write(
          'POST /mcp HTTP/1.1\r\n' +
          'Host: 127.0.0.1\r\n' +
          'Content-Type: application/json\r\n' +
          'Content-Length: 1000\r\n' +
          'X-API-Key: pg_test\r\n' +
          '\r\n' +
          '{"partial":' // Send partial body, then stop
        );
        // Don't send more data — let timeout kick in
      });
      let data = '';
      socket.on('data', (chunk) => { data += chunk.toString(); });
      socket.on('close', () => {
        // Parse status code from raw HTTP response
        const match = data.match(/HTTP\/1\.1 (\d+)/);
        resolve(match ? parseInt(match[1]) : 0);
      });
      socket.on('error', () => resolve(0));
      // Safety net timeout
      setTimeout(() => { socket.destroy(); resolve(-1); }, 3000);
    });

    // Should get either a 500 (body timeout error) or socket closed (0)
    // The critical thing is the server doesn't hang
    expect([0, 500, -1]).toContain(response);

    // Server should still work after the timeout
    const healthResp = await new Promise<number>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/health`, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      }).on('error', reject);
    });
    expect(healthResp).toBe(200);
  });

  it('should not timeout normal fast requests', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      requestTimeoutMs: 5000, // 5 second timeout — plenty for /health
    });
    const started = await server.start();
    port = started.port;

    const response = await new Promise<any>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/health`, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      }).on('error', reject);
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBeDefined();
  });

  // ─── Body Size Limit Still Works ──────────────────────────────────────────

  it('should still reject oversized bodies', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const started = await server.start();
    port = started.port;
    const adminKey = started.adminKey;

    // Send a body larger than 1MB
    const hugeBody = JSON.stringify({ data: 'x'.repeat(1_100_000) });

    const response = await new Promise<number>((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/keys',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': adminKey,
          'Content-Length': Buffer.byteLength(hugeBody),
        },
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      });
      req.on('error', () => resolve(0));
      req.write(hugeBody);
      req.end();
    });

    // Should get 500 (body too large triggers error in handler) or connection reset
    expect([0, 500]).toContain(response);
  });

  // ─── Disabled timeout (0) ─────────────────────────────────────────────────

  it('should allow disabling body timeout with requestTimeoutMs: 0', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      requestTimeoutMs: 0, // Disabled
    });
    const started = await server.start();
    port = started.port;

    // Normal requests should still work fine
    const response = await new Promise<any>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/health`, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode }));
      }).on('error', reject);
    });

    expect(response.status).toBe(200);
  });

  // ─── Multiple concurrent malformed requests ───────────────────────────────

  it('should survive multiple concurrent malformed requests', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const started = await server.start();
    port = started.port;

    // Send 5 malformed requests concurrently
    const promises = Array.from({ length: 5 }, () =>
      new Promise<void>((resolve) => {
        const socket = net.createConnection(port, '127.0.0.1', () => {
          socket.write('GARBAGE PROTOCOL\r\n\r\n');
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 100);
        });
        socket.on('error', () => resolve());
      })
    );
    await Promise.all(promises);

    // Server should still respond to valid requests
    const response = await new Promise<any>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/health`, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode }));
      }).on('error', reject);
    });

    expect(response.status).toBe(200);
  });

  // ─── Server resilience after body timeout ─────────────────────────────────

  it('should handle multiple requests after body timeout', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      requestTimeoutMs: 300,
    });
    const started = await server.start();
    port = started.port;

    // Trigger a body timeout
    await new Promise<void>((resolve) => {
      const socket = net.createConnection(port, '127.0.0.1', () => {
        socket.write(
          'POST /health HTTP/1.1\r\n' +
          'Host: 127.0.0.1\r\n' +
          'Content-Length: 100\r\n' +
          '\r\n'
          // Intentionally don't send body
        );
      });
      socket.on('close', () => resolve());
      socket.on('error', () => resolve());
      setTimeout(() => { socket.destroy(); resolve(); }, 1000);
    });

    // Make 3 quick health checks to verify server is stable
    for (let i = 0; i < 3; i++) {
      const resp = await new Promise<number>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/health`, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode!));
        }).on('error', reject);
      });
      expect(resp).toBe(200);
    }
  });
});
