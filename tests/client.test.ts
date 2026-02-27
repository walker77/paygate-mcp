/**
 * Client SDK tests: PayGateClient with auto-retry, balance tracking, etc.
 * Uses a real PayGateServer instance with mock MCP backend.
 */

import { PayGateServer } from '../src/server';
import { PayGateClient, PayGateError } from '../src/client';
import * as http from 'http';
import * as path from 'path';

const MOCK_SERVER = path.join(__dirname, 'e2e', 'mock-mcp-server.js');

function httpRequest(port: number, reqPath: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
} = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port,
      path: reqPath,
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...options.headers },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode!, body: data });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

describe('PayGateClient SDK', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    port = 3600 + Math.floor(Math.random() * 100);
    server = new PayGateServer({
      serverCommand: 'node',
      serverArgs: [MOCK_SERVER],
      port,
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 100,
      name: 'Client SDK Test',
      toolPricing: {
        premium_analyze: { creditsPerCall: 5 },
      },
    });

    const result = await server.start();
    port = result.port;
    adminKey = result.adminKey;
    await new Promise(r => setTimeout(r, 500));
  }, 15000);

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  async function createApiKey(credits: number, opts?: Record<string, unknown>): Promise<string> {
    const res = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'sdk-test', credits, ...opts },
    });
    return res.body.key;
  }

  async function topUp(key: string, credits: number): Promise<void> {
    await httpRequest(port, '/topup', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { key, credits },
    });
  }

  // ─── Basic Operations ────────────────────────────────────────────────────

  it('should list tools', async () => {
    const apiKey = await createApiKey(100);
    const client = new PayGateClient({ url: `http://localhost:${port}`, apiKey });

    const tools = await client.listTools();
    expect(tools.length).toBe(3);
    expect(tools.map(t => t.name)).toContain('search');
    expect(tools.map(t => t.name)).toContain('generate');
    expect(tools.map(t => t.name)).toContain('premium_analyze');
  });

  it('should call a tool successfully', async () => {
    const apiKey = await createApiKey(100);
    const client = new PayGateClient({ url: `http://localhost:${port}`, apiKey });

    const result = await client.callTool('search', { query: 'test' });
    expect(result.content).toBeDefined();
    expect(result.content[0].text).toContain('search');
    expect(result.content[0].text).toContain('test');
  });

  it('should get balance', async () => {
    const apiKey = await createApiKey(50);
    const client = new PayGateClient({ url: `http://localhost:${port}`, apiKey });

    const balance = await client.getBalance();
    expect(balance.credits).toBe(50);
    expect(balance.name).toBe('sdk-test');
    expect(balance.totalSpent).toBe(0);
  });

  it('should track lastKnownBalance', async () => {
    const apiKey = await createApiKey(25);
    const client = new PayGateClient({ url: `http://localhost:${port}`, apiKey });

    expect(client.lastKnownBalance).toBeNull();

    await client.getBalance();
    expect(client.lastKnownBalance).toBe(25);

    await client.callTool('search', { query: 'x' });
    // lastKnownBalance is only updated by getBalance()
    expect(client.lastKnownBalance).toBe(25);

    await client.getBalance();
    expect(client.lastKnownBalance).toBe(24);
  });

  it('should ping server', async () => {
    const apiKey = await createApiKey(10);
    const client = new PayGateClient({ url: `http://localhost:${port}`, apiKey });

    const ok = await client.ping();
    expect(ok).toBe(true);
  });

  it('should initialize MCP session', async () => {
    const apiKey = await createApiKey(10);
    const client = new PayGateClient({ url: `http://localhost:${port}`, apiKey });

    const result = await client.initialize();
    expect(result).toBeDefined();
    expect((result as any).serverInfo).toBeDefined();
  });

  // ─── Error Handling ──────────────────────────────────────────────────────

  it('should throw PayGateError on insufficient credits', async () => {
    const apiKey = await createApiKey(1);
    const client = new PayGateClient({ url: `http://localhost:${port}`, apiKey });

    // Use 1 credit
    await client.callTool('search', { query: 'x' });

    // Now 0 credits — should throw
    try {
      await client.callTool('search', { query: 'y' });
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PayGateError);
      const e = err as PayGateError;
      expect(e.code).toBe(-32402);
      expect(e.isPaymentRequired).toBe(true);
      expect(e.message).toContain('insufficient_credits');
    }
  });

  it('should throw PayGateError on invalid API key', async () => {
    const client = new PayGateClient({ url: `http://localhost:${port}`, apiKey: 'pg_invalid' });

    try {
      await client.callTool('search', { query: 'x' });
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PayGateError);
      const e = err as PayGateError;
      expect(e.isPaymentRequired).toBe(true);
    }
  });

  // ─── Auto-Retry on 402 ──────────────────────────────────────────────────

  it('should auto-retry on 402 when onCreditsNeeded adds credits', async () => {
    const apiKey = await createApiKey(1);
    const retryLog: string[] = [];

    const client = new PayGateClient({
      url: `http://localhost:${port}`,
      apiKey,
      autoRetry: true,
      onCreditsNeeded: async (info) => {
        retryLog.push(`need ${info.creditsRequired} for ${info.tool}`);
        // Add credits via admin API
        await topUp(apiKey, 10);
        return true;
      },
    });

    // Use 1 credit
    await client.callTool('search', { query: 'first' });

    // Now at 0 credits — should trigger auto-retry
    const result = await client.callTool('search', { query: 'retry-me' });
    expect(result.content[0].text).toContain('retry-me');

    // Verify the callback was called
    expect(retryLog.length).toBe(1);
    expect(retryLog[0]).toContain('search');
  });

  it('should NOT auto-retry when autoRetry is false', async () => {
    const apiKey = await createApiKey(1);
    const client = new PayGateClient({
      url: `http://localhost:${port}`,
      apiKey,
      autoRetry: false,
    });

    // Spend the 1 credit
    await client.callTool('search', { query: 'deplete' });

    // Now at 0 credits — should throw
    try {
      await client.callTool('search', { query: 'x' });
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PayGateError);
      expect((err as PayGateError).code).toBe(-32402);
    }
  });

  it('should stop retrying when onCreditsNeeded returns false', async () => {
    const apiKey = await createApiKey(1);
    const client = new PayGateClient({
      url: `http://localhost:${port}`,
      apiKey,
      autoRetry: true,
      onCreditsNeeded: async () => false, // Refuse to add credits
    });

    // Spend the 1 credit
    await client.callTool('search', { query: 'deplete' });

    // Now at 0 credits — should trigger onCreditsNeeded, which returns false
    try {
      await client.callTool('search', { query: 'x' });
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PayGateError);
      expect((err as PayGateError).code).toBe(-32402);
    }
  });

  it('should respect maxRetries limit', async () => {
    const apiKey = await createApiKey(1);
    let callCount = 0;

    const client = new PayGateClient({
      url: `http://localhost:${port}`,
      apiKey,
      autoRetry: true,
      maxRetries: 2,
      onCreditsNeeded: async () => {
        callCount++;
        // Always says "retry" but never actually adds credits → infinite retry without maxRetries
        return true;
      },
    });

    // Spend the 1 credit
    await client.callTool('search', { query: 'deplete' });

    // Now at 0 credits — should retry twice then give up
    try {
      await client.callTool('search', { query: 'x' });
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PayGateError);
      expect(callCount).toBe(2); // Called exactly maxRetries times
    }
  });

  // ─── PayGateError helpers ────────────────────────────────────────────────

  it('PayGateError should expose helper properties', () => {
    const err = new PayGateError(-32402, 'Payment required: insufficient_credits');
    expect(err.isPaymentRequired).toBe(true);
    expect(err.isRateLimited).toBe(false);
    expect(err.isExpired).toBe(false);
    expect(err.name).toBe('PayGateError');

    const rateErr = new PayGateError(-32402, 'Payment required: rate_limited');
    expect(rateErr.isRateLimited).toBe(true);

    const expErr = new PayGateError(-32402, 'Payment required: api_key_expired');
    expect(expErr.isExpired).toBe(true);
  });
});
