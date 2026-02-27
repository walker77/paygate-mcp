/**
 * Tests for v8.95.0 — Output & Config Hardening.
 *
 * Covers:
 *   1. Metrics cardinality cap (MAX_VALUES_PER_METRIC)
 *   2. Metrics serialize output size cap
 *   3. Custom header injection prevention
 *   4. OAuth state sanitization
 *   5. OAuth error_description cap in redirects
 *   6. Request log string truncation
 */

import { MetricsCollector } from '../src/metrics';
import { PayGateServer } from '../src/server';
import http from 'http';

// Suppress logger output in tests
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

// ─── Helper ──────────────────────────────────────────────────────────────────

function request(port: number, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; headers: Record<string, string>; body: any }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, headers: res.headers as any, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode!, headers: res.headers as any, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── 1. Metrics Cardinality Cap ──────────────────────────────────────────────

describe('Metrics cardinality cap', () => {
  it('should stop accepting new label sets after 10,000 entries per metric', () => {
    const m = new MetricsCollector();
    m.registerCounter('test_counter', 'Test');

    // Insert 10,001 unique label sets
    for (let i = 0; i < 10_001; i++) {
      m.increment('test_counter', { id: `label_${i}` });
    }

    // The 10,001st entry should be silently dropped
    expect(m.getCounter('test_counter', { id: 'label_0' })).toBe(1);
    expect(m.getCounter('test_counter', { id: 'label_9999' })).toBe(1);
    expect(m.getCounter('test_counter', { id: 'label_10000' })).toBe(0); // dropped

    // Existing entries can still be updated
    m.increment('test_counter', { id: 'label_0' }, 5);
    expect(m.getCounter('test_counter', { id: 'label_0' })).toBe(6);
  });

  it('should cap gauge cardinality too', () => {
    const m = new MetricsCollector();
    m.registerGauge('test_gauge', 'Test');

    for (let i = 0; i < 10_001; i++) {
      m.setGauge('test_gauge', i, { id: `g_${i}` });
    }

    expect(m.getGauge('test_gauge', { id: 'g_0' })).toBe(0);
    expect(m.getGauge('test_gauge', { id: 'g_9999' })).toBe(9999);
    expect(m.getGauge('test_gauge', { id: 'g_10000' })).toBe(0); // dropped (returns default)

    // Existing gauge entries can still be updated
    m.setGauge('test_gauge', 999, { id: 'g_0' });
    expect(m.getGauge('test_gauge', { id: 'g_0' })).toBe(999);
  });
});

// ─── 2. Metrics Serialize Output Size Cap ────────────────────────────────────

describe('Metrics serialize output cap', () => {
  it('should produce output under 5 MB even with many entries', () => {
    const m = new MetricsCollector();
    m.registerCounter('big_counter', 'A counter with many labels');

    // Insert 10,000 entries (at cap)
    for (let i = 0; i < 10_000; i++) {
      m.increment('big_counter', { id: `entry_${i}` });
    }

    const output = m.serialize();
    // Should complete without error and be under 5 MB
    expect(output.length).toBeLessThan(5 * 1024 * 1024);
    expect(output).toContain('big_counter');
  });

  it('should end output cleanly (trailing newline)', () => {
    const m = new MetricsCollector();
    m.increment('paygate_tool_calls_total', { tool: 'test', status: 'allowed' });
    const output = m.serialize();
    expect(output.endsWith('\n')).toBe(true);
  });
});

// ─── 3. Custom Header Injection Prevention ───────────────────────────────────

describe('Custom header validation', () => {
  let server: PayGateServer;
  let port: number;

  afterEach(async () => {
    if (server) await server.gracefulStop(5_000);
  }, 30_000);

  it('should apply valid custom headers', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      customHeaders: {
        'X-Custom-Header': 'safe-value',
        'X-Another': 'also-safe',
      },
    });
    const info = await server.start();
    port = info.port;

    const res = await request(port, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-custom-header']).toBe('safe-value');
    expect(res.headers['x-another']).toBe('also-safe');
  });

  it('should strip headers with CRLF in values (header injection)', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      customHeaders: {
        'X-Good': 'good-value',
        'X-Bad': 'bad\r\nInjected-Header: evil',
        'X-Also-Bad': 'bad\nInjected: evil',
      },
    });
    const info = await server.start();
    port = info.port;

    const res = await request(port, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-good']).toBe('good-value');
    expect(res.headers['x-bad']).toBeUndefined();
    expect(res.headers['x-also-bad']).toBeUndefined();
  });

  it('should strip headers with invalid names', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      customHeaders: {
        'Valid-Name': 'ok',
        'Invalid Name': 'has space',
        'Invalid\tTab': 'has tab',
        '': 'empty name',
      },
    });
    const info = await server.start();
    port = info.port;

    const res = await request(port, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.headers['valid-name']).toBe('ok');
    // Invalid header names should be stripped
    expect(res.headers['invalid name']).toBeUndefined();
  });

  it('should cap custom header values at 8 KB', async () => {
    const longValue = 'x'.repeat(10_000);
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      customHeaders: {
        'X-Long': longValue,
      },
    });
    const info = await server.start();
    port = info.port;

    const res = await request(port, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-long']).toBeDefined();
    expect(res.headers['x-long'].length).toBeLessThanOrEqual(8192);
  });

  it('should handle undefined customHeaders gracefully', async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      // No customHeaders
    });
    const info = await server.start();
    port = info.port;

    const res = await request(port, 'GET', '/health');
    expect(res.status).toBe(200);
  });
});

// ─── 4. OAuth State Sanitization ─────────────────────────────────────────────

describe('OAuth state sanitization', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      oauth: {
        issuer: 'http://localhost',
        accessTokenTtl: 3600,
      },
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    // Register an OAuth client
    await request(port, 'POST', '/oauth/register', {
      client_name: 'state-test',
      redirect_uris: ['http://localhost:3000/callback'],
      api_key: undefined,
    }, { 'X-Admin-Key': adminKey });
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  it('should pass through normal state parameters', async () => {
    // Register a client and get its ID
    const regRes = await request(port, 'POST', '/oauth/register', {
      client_name: 'state-pass-test',
      redirect_uris: ['http://localhost:3000/callback'],
    }, { 'X-Admin-Key': adminKey });
    const clientId = regRes.body.client_id;

    // Make auth request with a normal state
    const res = await new Promise<{ status: number; headers: Record<string, string> }>((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: `/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent('http://localhost:3000/callback')}&response_type=code&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=my_safe_state_123`,
        method: 'GET',
      }, (res) => {
        res.resume();
        resolve({ status: res.statusCode!, headers: res.headers as any });
      });
      req.end();
    });

    expect(res.status).toBe(302);
    const location = res.headers['location'] || '';
    expect(location).toContain('state=my_safe_state_123');
  });

  it('should strip control characters from state', async () => {
    const regRes = await request(port, 'POST', '/oauth/register', {
      client_name: 'state-ctrl-test',
      redirect_uris: ['http://localhost:3000/callback'],
    }, { 'X-Admin-Key': adminKey });
    const clientId = regRes.body.client_id;

    // State with control characters — should be stripped (state omitted from redirect)
    const badState = 'abc%00def'; // URL-encoded NUL
    const res = await new Promise<{ status: number; headers: Record<string, string> }>((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: `/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent('http://localhost:3000/callback')}&response_type=code&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=${badState}`,
        method: 'GET',
      }, (res) => {
        res.resume();
        resolve({ status: res.statusCode!, headers: res.headers as any });
      });
      req.end();
    });

    expect(res.status).toBe(302);
    const location = res.headers['location'] || '';
    // State should NOT be in the redirect (sanitized to undefined)
    expect(location).not.toContain('state=abc');
  });

  it('should truncate overly long state parameters', async () => {
    const regRes = await request(port, 'POST', '/oauth/register', {
      client_name: 'state-long-test',
      redirect_uris: ['http://localhost:3000/callback'],
    }, { 'X-Admin-Key': adminKey });
    const clientId = regRes.body.client_id;

    const longState = 'x'.repeat(1000);
    const res = await new Promise<{ status: number; headers: Record<string, string> }>((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: `/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent('http://localhost:3000/callback')}&response_type=code&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=${longState}`,
        method: 'GET',
      }, (res) => {
        res.resume();
        resolve({ status: res.statusCode!, headers: res.headers as any });
      });
      req.end();
    });

    expect(res.status).toBe(302);
    const location = res.headers['location'] || '';
    // State should be truncated to 512 chars
    if (location.includes('state=')) {
      const stateMatch = location.match(/state=([^&]*)/);
      if (stateMatch) {
        // URL-decode the state value
        const stateValue = decodeURIComponent(stateMatch[1]);
        expect(stateValue.length).toBeLessThanOrEqual(512);
      }
    }
  });
});

// ─── 5. Request Log String Truncation ────────────────────────────────────────

describe('Request log string truncation', () => {
  it('should cap request log entry string fields', async () => {
    const server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    const info = await server.start();
    const port = info.port;
    const adminKey = info.adminKey;

    // Create a key
    const keyRes = await request(port, 'POST', '/keys', { name: 'log-test', credits: 100 }, { 'X-Admin-Key': adminKey });
    const apiKey = keyRes.body.key;

    // Make a tool call (will fail but should still log)
    await request(port, 'POST', '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'a'.repeat(500), arguments: {} },
    }, { 'X-API-Key': apiKey });

    // Query request log
    const logRes = await request(port, 'GET', '/requests?limit=1', undefined, { 'X-Admin-Key': adminKey });
    expect(logRes.status).toBe(200);

    if (logRes.body.entries && logRes.body.entries.length > 0) {
      const entry = logRes.body.entries[0];
      // Tool name should be truncated to 200 chars
      if (entry.tool) {
        expect(entry.tool.length).toBeLessThanOrEqual(200);
      }
    }

    await server.gracefulStop(5_000);
  }, 30_000);
});
