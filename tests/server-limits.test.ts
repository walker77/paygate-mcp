/**
 * Server limits tests — request timeout, headers timeout, keep-alive, max requests per socket.
 */

import { PayGateServer } from '../src/server';
import http from 'http';

// Suppress logger output in tests
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

describe('Server Limits', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    if (server) {
      await server.gracefulStop(1000);
    }
  });

  // ─── Default Limits ─────────────────────────────────────────────────────────

  it('should apply default timeouts when not configured', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    // Check defaults are applied to the underlying Node.js server
    const httpServer = (server as any).server as http.Server;
    expect(httpServer.requestTimeout).toBe(30_000);
    expect(httpServer.headersTimeout).toBe(10_000);
    expect(httpServer.keepAliveTimeout).toBe(65_000);
  });

  it('should apply custom request timeout', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      requestTimeoutMs: 60_000,
    });
    const started = await server.start();
    port = started.port;

    const httpServer = (server as any).server as http.Server;
    expect(httpServer.requestTimeout).toBe(60_000);
  });

  it('should apply custom headers timeout', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      headersTimeoutMs: 5_000,
    });
    const started = await server.start();
    port = started.port;

    const httpServer = (server as any).server as http.Server;
    expect(httpServer.headersTimeout).toBe(5_000);
  });

  it('should apply custom keep-alive timeout', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      keepAliveTimeoutMs: 120_000,
    });
    const started = await server.start();
    port = started.port;

    const httpServer = (server as any).server as http.Server;
    expect(httpServer.keepAliveTimeout).toBe(120_000);
  });

  it('should apply max requests per socket when configured', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      maxRequestsPerSocket: 100,
    });
    const started = await server.start();
    port = started.port;

    const httpServer = (server as any).server as http.Server;
    expect(httpServer.maxRequestsPerSocket).toBe(100);
  });

  it('should not set maxRequestsPerSocket when not configured (default unlimited)', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const started = await server.start();
    port = started.port;

    const httpServer = (server as any).server as http.Server;
    // Node.js default is 0 (unlimited)
    expect(httpServer.maxRequestsPerSocket).toBe(0);
  });

  it('should allow disabling request timeout with 0', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      requestTimeoutMs: 0,
    });
    const started = await server.start();
    port = started.port;

    const httpServer = (server as any).server as http.Server;
    expect(httpServer.requestTimeout).toBe(0);
  });

  // ─── /info Endpoint ─────────────────────────────────────────────────────────

  it('should expose server limits in /info endpoint', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      requestTimeoutMs: 45_000,
      headersTimeoutMs: 8_000,
      keepAliveTimeoutMs: 90_000,
      maxRequestsPerSocket: 200,
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const info = await new Promise<any>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/info`, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });

    expect(info.serverLimits).toBeDefined();
    expect(info.serverLimits.requestTimeoutMs).toBe(45_000);
    expect(info.serverLimits.headersTimeoutMs).toBe(8_000);
    expect(info.serverLimits.keepAliveTimeoutMs).toBe(90_000);
    expect(info.serverLimits.maxRequestsPerSocket).toBe(200);
  });

  it('should show default limits in /info when not configured', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const info = await new Promise<any>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/info`, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });

    expect(info.serverLimits).toBeDefined();
    expect(info.serverLimits.requestTimeoutMs).toBe(30_000);
    expect(info.serverLimits.headersTimeoutMs).toBe(10_000);
    expect(info.serverLimits.keepAliveTimeoutMs).toBe(65_000);
    expect(info.serverLimits.maxRequestsPerSocket).toBe(0);
  });

  // ─── Root Listing ───────────────────────────────────────────────────────────

  it('root listing shows /info endpoint', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;

    const root = await new Promise<any>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });

    expect(root.endpoints).toBeDefined();
    // /info should be listed — endpoints is an array of {path, method, description}
    const endpoints = Array.isArray(root.endpoints) ? root.endpoints : Object.values(root.endpoints);
    const paths = endpoints.map((e: any) => typeof e === 'string' ? e : e.path);
    expect(paths.some((p: string) => p && p.includes('/info'))).toBe(true);
  });

  // ─── Combined config ────────────────────────────────────────────────────────

  it('should combine timeout config with other config fields', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      requestTimeoutMs: 15_000,
      logLevel: 'silent',
    });
    const started = await server.start();
    port = started.port;

    const httpServer = (server as any).server as http.Server;
    expect(httpServer.requestTimeout).toBe(15_000);
    // Defaults still applied for non-configured timeouts
    expect(httpServer.headersTimeout).toBe(10_000);
    expect(httpServer.keepAliveTimeout).toBe(65_000);
  });
});
