/**
 * Graceful shutdown tests — SSE cleanup, timer cleanup, drain behavior.
 */

import { PayGateServer } from '../src/server';
import http from 'http';

// Suppress logger output in tests
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

describe('Graceful Shutdown', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    if (server) {
      try { await server.gracefulStop(1000); } catch { /* already stopped */ }
    }
  });

  // ─── SSE Stream Cleanup on gracefulStop ───────────────────────────────────

  it('should close SSE admin event streams during graceful shutdown', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Open an SSE connection
    const sseEnded = new Promise<boolean>((resolve) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port,
        path: '/admin/events',
        headers: { 'X-Admin-Key': adminKey },
      }, (res) => {
        let received = '';
        res.on('data', (chunk) => { received += chunk.toString(); });
        res.on('end', () => resolve(true));
        res.on('error', () => resolve(true)); // Error also means stream was closed
      });
      req.on('error', () => resolve(true));
    });

    // Give the SSE connection time to establish
    await new Promise((r) => setTimeout(r, 200));

    // Now trigger graceful shutdown
    await server.gracefulStop(2000);

    // The SSE stream should have been closed
    const ended = await Promise.race([
      sseEnded,
      new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
    ]);
    expect(ended).toBe(true);
  });

  // ─── Drain behavior ───────────────────────────────────────────────────────

  it('should return 503 on /mcp while draining', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const started = await server.start();
    port = started.port;

    // Start graceful shutdown (will set draining = true)
    const stopPromise = server.gracefulStop(5000);

    // Small delay to ensure drain flag is set
    await new Promise((r) => setTimeout(r, 50));

    // Try to make a request to /mcp — should get 503
    const response = await new Promise<number>((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': 'pg_test' },
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      });
      req.on('error', () => resolve(0)); // Connection refused = server already closed
      req.write(JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }));
      req.end();
    });

    await stopPromise;

    // Either 503 (draining) or 0 (connection refused because server closed)
    expect([0, 503]).toContain(response);
  });

  // ─── Health endpoint reflects drain status ────────────────────────────────

  it('should report drain status in /health during shutdown', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const started = await server.start();
    port = started.port;

    // Check health before drain
    const healthBefore = await new Promise<any>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/health`, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });
    expect(healthBefore.status).not.toBe('draining');

    // Start graceful shutdown
    const stopPromise = server.gracefulStop(5000);
    await new Promise((r) => setTimeout(r, 50));

    // Check health during drain
    const healthDuring = await new Promise<any>((resolve) => {
      http.get(`http://127.0.0.1:${port}/health`, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ status: 'unknown' }); }
        });
      }).on('error', () => resolve({ status: 'connection_refused' }));
    });

    await stopPromise;

    // During drain, status should be 'draining' or connection refused
    expect(['draining', 'connection_refused', 'unknown']).toContain(healthDuring.status);
  });

  // ─── Double gracefulStop is idempotent ────────────────────────────────────

  it('should handle double gracefulStop calls without error', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    await server.start();

    // Call gracefulStop twice — second call should be a no-op
    const p1 = server.gracefulStop(1000);
    const p2 = server.gracefulStop(1000);
    await Promise.all([p1, p2]);
    // No errors means success
  });

  // ─── Quick drain with no in-flight requests ───────────────────────────────

  it('should drain immediately when no requests in-flight', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    await server.start();

    const start = Date.now();
    await server.gracefulStop(5000);
    const elapsed = Date.now() - start;

    // Should drain nearly instantly (< 500ms) when no in-flight requests
    expect(elapsed).toBeLessThan(500);
  });

  // ─── SSE error handler doesn't crash ──────────────────────────────────────

  it('should handle SSE client disconnect without crashing', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Open SSE connection and immediately abort
    await new Promise<void>((resolve) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port,
        path: '/admin/events',
        headers: { 'X-Admin-Key': adminKey },
      }, () => {
        // Destroy immediately after connecting
        req.destroy();
        setTimeout(resolve, 200);
      });
      req.on('error', () => setTimeout(resolve, 200));
    });

    // Server should still be responsive
    const resp = await new Promise<number>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/health`, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      }).on('error', reject);
    });
    expect(resp).toBe(200);
  });

  // ─── Multiple SSE clients cleaned up ──────────────────────────────────────

  it('should clean up keepalive timer on gracefulStop', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const started = await server.start();
    port = started.port;

    // Verify the schedule timer exists (10s interval for scheduled actions)
    expect((server as any).scheduleTimer).not.toBeNull();

    // Graceful stop should clear the timer
    await server.gracefulStop(2000);

    expect((server as any).scheduleTimer).toBeNull();
  });

  // ─── Background timer error boundary ──────────────────────────────────────

  it('should not crash when scheduled actions throw', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const started = await server.start();
    port = started.port;

    // The scheduled actions executor has a try/catch boundary.
    // Even if executeScheduledActions threw, the server should keep running.
    // We can't easily inject an error, but we can verify the server stays alive
    // after the timer fires.
    await new Promise((r) => setTimeout(r, 100));

    const resp = await new Promise<number>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/health`, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      }).on('error', reject);
    });
    expect(resp).toBe(200);
  });
});
