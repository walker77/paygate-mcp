/**
 * Security headers tests — verifies hardened response headers on all endpoint types.
 */

import { PayGateServer } from '../src/server';
import http from 'http';

// Suppress logger output in tests
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

function request(port: number, path: string, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${path}`, {
      method: opts.method || 'GET',
      headers: opts.headers,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Security Headers', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      logLevel: 'silent',
    });
    const started = await server.start();
    port = started.port;
    adminKey = started.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop(1000);
  });

  // ─── Core Security Headers ──────────────────────────────────────────────────

  it('should include X-Content-Type-Options: nosniff', async () => {
    const res = await request(port, '/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('should include X-Frame-Options: DENY', async () => {
    const res = await request(port, '/health');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('should include X-XSS-Protection: 0 (disabled for modern browsers)', async () => {
    const res = await request(port, '/health');
    expect(res.headers['x-xss-protection']).toBe('0');
  });

  it('should include Referrer-Policy', async () => {
    const res = await request(port, '/health');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('should include Cache-Control: no-store for API responses', async () => {
    const res = await request(port, '/health');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('should include Content-Security-Policy for API responses', async () => {
    const res = await request(port, '/health');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it('should not include X-Powered-By header', async () => {
    const res = await request(port, '/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('should include X-Request-Id on every response', async () => {
    const res = await request(port, '/health');
    expect(res.headers['x-request-id']).toBeDefined();
    expect(typeof res.headers['x-request-id']).toBe('string');
  });

  // ─── Security Headers on Different Endpoint Types ───────────────────────────

  it('should include security headers on /info', async () => {
    const res = await request(port, '/info');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('should include security headers on admin endpoints', async () => {
    const res = await request(port, '/status', {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('should include security headers on error responses', async () => {
    const res = await request(port, '/nonexistent');
    expect(res.status).toBe(404);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('should include security headers on OPTIONS preflight', async () => {
    const res = await request(port, '/health', { method: 'OPTIONS' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('should include security headers on /metrics', async () => {
    const res = await request(port, '/metrics');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  // ─── Dashboard CSP Override ─────────────────────────────────────────────────

  it('should override CSP for /dashboard to allow inline scripts/styles', async () => {
    const res = await request(port, '/dashboard');
    expect(res.status).toBe(200);
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('dashboard should still have other security headers', async () => {
    const res = await request(port, '/dashboard');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  // ─── Custom Headers Don't Override Security ─────────────────────────────────

  it('should include both security and custom headers when configured', async () => {
    const customServer = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      logLevel: 'silent',
      customHeaders: { 'X-Custom-Header': 'test-value' },
    });
    const started = await customServer.start();
    try {
      const res = await request(started.port, '/health');
      // Security headers present
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      // Custom header also present
      expect(res.headers['x-custom-header']).toBe('test-value');
    } finally {
      await customServer.gracefulStop(1000);
    }
  });
});
