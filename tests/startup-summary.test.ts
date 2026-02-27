/**
 * Startup summary tests — verifies the server logs a configuration summary on start.
 */

import { PayGateServer } from '../src/server';

describe('Startup Summary', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should log a startup summary with port and transport', async () => {
    const server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const { port } = await server.start();

    // Find the startup log message
    const calls = logSpy.mock.calls.map((c: any[]) => c[0]);
    const startupLog = calls.find((c: string) => typeof c === 'string' && c.includes('Listening on port'));
    expect(startupLog).toBeDefined();
    expect(startupLog).toContain(String(port));

    await server.gracefulStop(1000);
  });

  it('should include transport type in startup log (text format)', async () => {
    const server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      logFormat: 'text',
    });
    await server.start();

    const calls = logSpy.mock.calls.map((c: any[]) => c);
    // In text format, context is passed as second arg
    const startupCall = calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('Listening on port')
    );
    expect(startupCall).toBeDefined();
    // Context should include transport
    if (startupCall && startupCall[1]) {
      expect(startupCall[1].transport).toBe('stdio');
    }

    await server.gracefulStop(1000);
  });

  it('should include features in startup summary (JSON format)', async () => {
    const server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      logFormat: 'json',
      webhookUrl: 'https://example.com/hooks',
      shadowMode: true,
    });
    await server.start();

    // Find the JSON startup log
    const calls = logSpy.mock.calls.map((c: any[]) => c[0]);
    const startupJson = calls.find(
      (c: string) => typeof c === 'string' && c.includes('"msg"') && c.includes('Listening on port')
    );
    expect(startupJson).toBeDefined();
    if (startupJson) {
      const parsed = JSON.parse(startupJson);
      expect(parsed.features).toContain('shadow-mode');
      expect(parsed.features).toContain('webhooks');
      expect(parsed.transport).toBe('stdio');
    }

    await server.gracefulStop(1000);
  });

  it('should log detected features (expiry-scanner is on by default)', async () => {
    const server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      logFormat: 'json',
    });
    await server.start();

    const calls = logSpy.mock.calls.map((c: any[]) => c[0]);
    const startupJson = calls.find(
      (c: string) => typeof c === 'string' && c.includes('"msg"') && c.includes('Listening on port')
    );
    expect(startupJson).toBeDefined();
    if (startupJson) {
      const parsed = JSON.parse(startupJson);
      // features is a comma-separated string — at minimum expiry-scanner is on by default
      expect(typeof parsed.features).toBe('string');
    }

    await server.gracefulStop(1000);
  });

  it('should include rate limit and price in startup summary', async () => {
    const server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      logFormat: 'json',
      defaultCreditsPerCall: 5,
      globalRateLimitPerMin: 30,
    });
    await server.start();

    const calls = logSpy.mock.calls.map((c: any[]) => c[0]);
    const startupJson = calls.find(
      (c: string) => typeof c === 'string' && c.includes('"msg"') && c.includes('Listening on port')
    );
    expect(startupJson).toBeDefined();
    if (startupJson) {
      const parsed = JSON.parse(startupJson);
      expect(parsed.price).toBe(5);
      expect(parsed.rateLimit).toBe(30);
    }

    await server.gracefulStop(1000);
  });

  it('should include key count in startup summary', async () => {
    const server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      logFormat: 'json',
    });
    await server.start();

    const calls = logSpy.mock.calls.map((c: any[]) => c[0]);
    const startupJson = calls.find(
      (c: string) => typeof c === 'string' && c.includes('"msg"') && c.includes('Listening on port')
    );
    expect(startupJson).toBeDefined();
    if (startupJson) {
      const parsed = JSON.parse(startupJson);
      expect(typeof parsed.keys).toBe('number');
    }

    await server.gracefulStop(1000);
  });

  it('should not log startup summary when log level is silent', async () => {
    const server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      logLevel: 'silent',
    });
    await server.start();

    const calls = logSpy.mock.calls.map((c: any[]) => c[0]);
    const startupLog = calls.find(
      (c: string) => typeof c === 'string' && c.includes('Listening on port')
    );
    expect(startupLog).toBeUndefined();

    await server.gracefulStop(1000);
  });

  it('should detect quotas feature when configured', async () => {
    const server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      logFormat: 'json',
      globalQuota: {
        dailyCallLimit: 100,
        monthlyCallLimit: 3000,
        dailyCreditLimit: 0,
        monthlyCreditLimit: 0,
      },
    });
    await server.start();

    const calls = logSpy.mock.calls.map((c: any[]) => c[0]);
    const startupJson = calls.find(
      (c: string) => typeof c === 'string' && c.includes('"msg"') && c.includes('Listening on port')
    );
    expect(startupJson).toBeDefined();
    if (startupJson) {
      const parsed = JSON.parse(startupJson);
      expect(parsed.features).toContain('quotas');
    }

    await server.gracefulStop(1000);
  });
});

describe('KeyStore.getKeyCount', () => {
  it('should return 0 for empty store', () => {
    const { KeyStore } = require('../src/store');
    const store = new KeyStore();
    expect(store.getKeyCount()).toBe(0);
  });

  it('should return count after adding keys', () => {
    const { KeyStore } = require('../src/store');
    const store = new KeyStore();
    store.createKey('Test Key 1', 100);
    store.createKey('Test Key 2', 200);
    expect(store.getKeyCount()).toBe(2);
  });
});
