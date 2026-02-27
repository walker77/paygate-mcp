/**
 * Prometheus Metrics Tests.
 *
 * Tests:
 *   - MetricsCollector unit tests (counters, gauges, labels, serialization)
 *   - E2E: GET /metrics returns Prometheus text format
 *   - E2E: Metrics update after tool calls
 *   - E2E: /metrics is publicly accessible (no auth)
 */

import * as http from 'http';
import { MetricsCollector } from '../src/metrics';
import { PayGateServer } from '../src/server';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function httpRequest(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: options.port,
      method: options.method,
      path: options.path,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body,
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ─── Unit Tests: MetricsCollector ────────────────────────────────────────────

describe('MetricsCollector', () => {
  it('should initialize with built-in metrics', () => {
    const m = new MetricsCollector();
    const output = m.serialize();
    expect(output).toContain('paygate_uptime_seconds');
    expect(output).toContain('# TYPE paygate_uptime_seconds gauge');
  });

  it('should increment counters', () => {
    const m = new MetricsCollector();
    m.increment('paygate_tool_calls_total', { tool: 'search', status: 'allowed' });
    m.increment('paygate_tool_calls_total', { tool: 'search', status: 'allowed' });
    m.increment('paygate_tool_calls_total', { tool: 'search', status: 'denied' });

    expect(m.getCounter('paygate_tool_calls_total', { tool: 'search', status: 'allowed' })).toBe(2);
    expect(m.getCounter('paygate_tool_calls_total', { tool: 'search', status: 'denied' })).toBe(1);
  });

  it('should increment counters by custom amount', () => {
    const m = new MetricsCollector();
    m.increment('paygate_credits_charged_total', { tool: 'analyze' }, 10);
    m.increment('paygate_credits_charged_total', { tool: 'analyze' }, 5);

    expect(m.getCounter('paygate_credits_charged_total', { tool: 'analyze' })).toBe(15);
  });

  it('should set gauge values', () => {
    const m = new MetricsCollector();
    m.registerGauge('paygate_test_gauge', 'Test gauge');
    m.setGauge('paygate_test_gauge', 42);

    expect(m.getGauge('paygate_test_gauge')).toBe(42);
  });

  it('should support dynamic gauge suppliers', () => {
    const m = new MetricsCollector();
    let value = 5;
    m.registerGauge('paygate_dynamic', 'Dynamic gauge', () => value);

    expect(m.getGauge('paygate_dynamic')).toBe(5);
    value = 10;
    expect(m.getGauge('paygate_dynamic')).toBe(10);
  });

  it('should serialize to Prometheus text format', () => {
    const m = new MetricsCollector();
    m.increment('paygate_tool_calls_total', { tool: 'search', status: 'allowed' }, 3);
    m.increment('paygate_denials_total', { reason: 'insufficient_credits' });

    const output = m.serialize();

    // Should contain HELP and TYPE lines
    expect(output).toContain('# HELP paygate_tool_calls_total Total tool calls processed');
    expect(output).toContain('# TYPE paygate_tool_calls_total counter');
    expect(output).toContain('paygate_tool_calls_total{status="allowed",tool="search"} 3');
    expect(output).toContain('paygate_denials_total{reason="insufficient_credits"} 1');
  });

  it('should escape label values', () => {
    const m = new MetricsCollector();
    m.increment('paygate_tool_calls_total', { tool: 'search "quoted"', status: 'allowed' });

    const output = m.serialize();
    expect(output).toContain('tool="search \\"quoted\\""');
  });

  it('should record tool calls via convenience method', () => {
    const m = new MetricsCollector();
    m.recordToolCall('search', true, 5);
    m.recordToolCall('search', false, 0, 'insufficient_credits');

    expect(m.getCounter('paygate_tool_calls_total', { tool: 'search', status: 'allowed' })).toBe(1);
    expect(m.getCounter('paygate_tool_calls_total', { tool: 'search', status: 'denied' })).toBe(1);
    expect(m.getCounter('paygate_credits_charged_total', { tool: 'search' })).toBe(5);
    expect(m.getCounter('paygate_denials_total', { reason: 'insufficient_credits' })).toBe(1);
  });

  it('should record rate limit hits', () => {
    const m = new MetricsCollector();
    m.recordRateLimitHit('analyze');
    m.recordRateLimitHit('analyze');

    expect(m.getCounter('paygate_rate_limit_hits_total', { tool: 'analyze' })).toBe(2);
  });

  it('should record refunds', () => {
    const m = new MetricsCollector();
    m.recordRefund('search', 5);
    m.recordRefund('search', 3);

    expect(m.getCounter('paygate_refunds_total', { tool: 'search' })).toBe(8);
  });

  it('should record HTTP requests with normalized paths', () => {
    const m = new MetricsCollector();
    m.recordHttpRequest('POST', '/mcp', 200);
    m.recordHttpRequest('GET', '/keys/acl?key=abc', 200);
    m.recordHttpRequest('POST', '/oauth/token', 200);

    expect(m.getCounter('paygate_http_requests_total', { method: 'POST', path: '/mcp', status: '200' })).toBe(1);
    expect(m.getCounter('paygate_http_requests_total', { method: 'GET', path: '/keys/*', status: '200' })).toBe(1);
    expect(m.getCounter('paygate_http_requests_total', { method: 'POST', path: '/oauth/*', status: '200' })).toBe(1);
  });

  it('should track uptime', async () => {
    const m = new MetricsCollector();
    // Wait a tiny bit for uptime to be > 0
    await new Promise(r => setTimeout(r, 10));
    const output = m.serialize();
    expect(output).toMatch(/paygate_uptime_seconds \d+/);
  });

  it('should return 0 for unknown counters and gauges', () => {
    const m = new MetricsCollector();
    expect(m.getCounter('nonexistent')).toBe(0);
    expect(m.getGauge('nonexistent')).toBe(0);
  });

  it('should ignore increments on non-counter metrics', () => {
    const m = new MetricsCollector();
    // paygate_uptime_seconds is a gauge, not a counter
    m.increment('paygate_uptime_seconds', {}, 100);
    // Should not crash and uptime should remain correct
    const output = m.serialize();
    expect(output).toContain('paygate_uptime_seconds');
  });

  it('should not duplicate metrics on repeated registration', () => {
    const m = new MetricsCollector();
    m.registerCounter('paygate_tool_calls_total', 'Duplicate registration');
    m.increment('paygate_tool_calls_total', { tool: 'test', status: 'allowed' });

    // Should still work and not reset
    expect(m.getCounter('paygate_tool_calls_total', { tool: 'test', status: 'allowed' })).toBe(1);
  });
});

// ─── E2E Tests: /metrics endpoint ───────────────────────────────────────────

describe('Metrics E2E', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeAll(async () => {
    server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: [],
      port: 0,
      defaultCreditsPerCall: 2,
      toolPricing: {
        search: { creditsPerCall: 5, rateLimitPerMin: 10 },
      },
    });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  it('GET /metrics returns Prometheus text format', async () => {
    const res = await httpRequest({ port, method: 'GET', path: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('paygate_uptime_seconds');
    expect(res.body).toContain('# HELP');
    expect(res.body).toContain('# TYPE');
  });

  it('GET /metrics is publicly accessible (no auth)', async () => {
    const res = await httpRequest({ port, method: 'GET', path: '/metrics' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /metrics includes active_keys gauge', async () => {
    // Create a key first
    await httpRequest({
      port, method: 'POST', path: '/keys',
      headers: { 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'metrics-test', credits: 100 }),
    });

    const res = await httpRequest({ port, method: 'GET', path: '/metrics' });
    expect(res.body).toContain('paygate_active_keys_total');
    // Should have at least 1 active key
    const match = res.body.match(/paygate_active_keys_total (\d+)/);
    expect(match).toBeTruthy();
    expect(parseInt(match![1])).toBeGreaterThanOrEqual(1);
  });

  it('GET /metrics includes active_sessions gauge', async () => {
    const res = await httpRequest({ port, method: 'GET', path: '/metrics' });
    expect(res.body).toContain('paygate_active_sessions_total');
  });

  it('GET /metrics includes total_credits gauge', async () => {
    const res = await httpRequest({ port, method: 'GET', path: '/metrics' });
    expect(res.body).toContain('paygate_total_credits_available');
  });

  it('root endpoint lists /metrics', async () => {
    const res = await httpRequest({ port, method: 'GET', path: '/' });
    const data = JSON.parse(res.body);
    expect(data.endpoints.metrics).toBeDefined();
  });

  it('metrics collector is accessible on server instance', () => {
    expect(server.metrics).toBeDefined();
    expect(typeof server.metrics.serialize).toBe('function');
  });
});
