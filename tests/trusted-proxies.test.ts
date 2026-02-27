/**
 * Tests for v5.9.0 — Trusted Proxies.
 *
 * Tests the resolveClientIp function (unit) and HTTP integration with
 * X-Forwarded-For header extraction under various proxy configurations.
 */

import { resolveClientIp } from '../src/server';
import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';
import { ENV_VAR_MAP } from '../src/cli';
import http from 'http';

// ─── Unit Tests: resolveClientIp ─────────────────────────────────────────────

function fakeReq(forwardedFor?: string, socketIp = '127.0.0.1'): any {
  return {
    socket: { remoteAddress: socketIp },
    headers: forwardedFor !== undefined ? { 'x-forwarded-for': forwardedFor } : {},
  };
}

describe('resolveClientIp (unit)', () => {
  test('returns socket IP when no X-Forwarded-For', () => {
    expect(resolveClientIp(fakeReq(undefined, '192.168.1.1'))).toBe('192.168.1.1');
  });

  test('returns empty string when no socket IP and no forwarded-for', () => {
    const req = { socket: { remoteAddress: '' }, headers: {} } as any;
    expect(resolveClientIp(req)).toBe('');
  });

  // ─── Without trusted proxies (backward compatible) ───
  test('without trusted proxies: returns first XFF IP', () => {
    expect(resolveClientIp(fakeReq('1.2.3.4, 10.0.0.1, 10.0.0.2'))).toBe('1.2.3.4');
  });

  test('without trusted proxies: returns single XFF IP', () => {
    expect(resolveClientIp(fakeReq('8.8.8.8'))).toBe('8.8.8.8');
  });

  test('without trusted proxies: handles whitespace in XFF', () => {
    expect(resolveClientIp(fakeReq('  1.2.3.4 , 5.6.7.8 '))).toBe('1.2.3.4');
  });

  test('without trusted proxies: empty XFF returns socket IP', () => {
    expect(resolveClientIp(fakeReq('', '10.10.10.10'))).toBe('10.10.10.10');
  });

  test('without trusted proxies: empty array same as undefined', () => {
    expect(resolveClientIp(fakeReq('1.2.3.4, 10.0.0.1'), [])).toBe('1.2.3.4');
  });

  // ─── With trusted proxies (exact match) ───
  test('trusted proxies exact: skips trusted proxy at end', () => {
    expect(resolveClientIp(fakeReq('1.2.3.4, 10.0.0.1'), ['10.0.0.1'])).toBe('1.2.3.4');
  });

  test('trusted proxies exact: skips multiple trusted proxies', () => {
    expect(resolveClientIp(fakeReq('1.2.3.4, 10.0.0.1, 10.0.0.2'), ['10.0.0.1', '10.0.0.2'])).toBe('1.2.3.4');
  });

  test('trusted proxies exact: returns first non-trusted from right', () => {
    expect(resolveClientIp(fakeReq('1.1.1.1, 2.2.2.2, 10.0.0.1'), ['10.0.0.1'])).toBe('2.2.2.2');
  });

  test('trusted proxies: all IPs trusted returns socket IP', () => {
    expect(resolveClientIp(fakeReq('10.0.0.1, 10.0.0.2'), ['10.0.0.1', '10.0.0.2'])).toBe('127.0.0.1');
  });

  // ─── With trusted proxies (CIDR match) ───
  test('CIDR: /8 matches entire range', () => {
    expect(resolveClientIp(fakeReq('1.2.3.4, 10.99.88.77'), ['10.0.0.0/8'])).toBe('1.2.3.4');
  });

  test('CIDR: /16 matches subnet', () => {
    expect(resolveClientIp(fakeReq('8.8.8.8, 172.16.5.10, 10.0.0.1'), ['172.16.0.0/12', '10.0.0.0/8'])).toBe('8.8.8.8');
  });

  test('CIDR: /32 matches single IP', () => {
    expect(resolveClientIp(fakeReq('1.2.3.4, 192.168.1.100'), ['192.168.1.100/32'])).toBe('1.2.3.4');
  });

  test('CIDR: /0 matches everything', () => {
    expect(resolveClientIp(fakeReq('1.2.3.4, 5.6.7.8'), ['0.0.0.0/0'])).toBe('127.0.0.1');
  });

  test('CIDR: /24 matches 256 addresses', () => {
    expect(resolveClientIp(fakeReq('8.8.8.8, 192.168.1.55'), ['192.168.1.0/24'])).toBe('8.8.8.8');
  });

  test('CIDR: does not match outside range', () => {
    // 192.168.2.1 is NOT in 192.168.1.0/24
    expect(resolveClientIp(fakeReq('8.8.8.8, 192.168.2.1'), ['192.168.1.0/24'])).toBe('192.168.2.1');
  });

  // ─── Mixed exact + CIDR ───
  test('mixed exact + CIDR', () => {
    expect(
      resolveClientIp(fakeReq('1.2.3.4, 10.0.0.5, 192.168.1.1'), ['192.168.1.1', '10.0.0.0/8'])
    ).toBe('1.2.3.4');
  });

  // ─── Edge cases ───
  test('invalid CIDR bits ignored (no match)', () => {
    expect(resolveClientIp(fakeReq('1.2.3.4, 10.0.0.1'), ['10.0.0.0/abc'])).toBe('10.0.0.1');
  });

  test('IPv6-like address not matched by IPv4 CIDR', () => {
    // ::1 won't match a CIDR like 10.0.0.0/8 (ipToNum returns null for non-IPv4)
    expect(resolveClientIp(fakeReq('1.2.3.4, ::1'), ['10.0.0.0/8'])).toBe('::1');
  });

  test('exact IPv6 match as trusted', () => {
    // exact match works even for IPv6 addresses
    expect(resolveClientIp(fakeReq('1.2.3.4, ::1'), ['::1'])).toBe('1.2.3.4');
  });
});

// ─── Integration Tests: HTTP with trusted proxies ────────────────────────────

const ECHO_CMD = process.execPath;
const ECHO_ARGS = ['-e', `process.stdin.resume(); process.stdin.on('data', d => { const r = JSON.parse(d.toString().trim()); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: {} }) + '\\n'); });`];

function makeServer(trustedProxies?: string[]): PayGateServer {
  return new PayGateServer({
    ...DEFAULT_CONFIG,
    serverCommand: ECHO_CMD,
    serverArgs: ECHO_ARGS,
    port: 0,
    trustedProxies,
  });
}

async function httpPost(port: number, path: string, body: object, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode!, body: buf }); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode!, body: buf }); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('Trusted Proxies (HTTP integration)', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  afterEach(async () => {
    if (server) await server.gracefulStop(5_000);
  }, 30_000);

  test('/info shows trustedProxies feature as false when not configured', async () => {
    server = makeServer();
    const info = await server.start();
    port = info.port;
    const res = await httpGet(port, '/info');
    expect(res.status).toBe(200);
    expect(res.body.features.trustedProxies).toBe(false);
  });

  test('/info shows trustedProxies feature as true when configured', async () => {
    server = makeServer(['10.0.0.0/8']);
    const info = await server.start();
    port = info.port;
    const res = await httpGet(port, '/info');
    expect(res.status).toBe(200);
    expect(res.body.features.trustedProxies).toBe(true);
  });

  test('/config export includes trustedProxies', async () => {
    server = makeServer(['10.0.0.0/8', '192.168.1.1']);
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
    const res = await httpGet(port, '/config', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.config.trustedProxies).toEqual(['10.0.0.0/8', '192.168.1.1']);
  });

  test('/config export shows empty array when not configured', async () => {
    server = makeServer();
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
    const res = await httpGet(port, '/config', { 'x-admin-key': adminKey });
    expect(res.status).toBe(200);
    expect(res.body.config.trustedProxies).toEqual([]);
  });

  test('IP allowlist uses resolved client IP with trusted proxies', async () => {
    // Set up: trusted proxy 10.0.0.1, key restricted to IP 1.2.3.4
    server = makeServer(['10.0.0.1']);
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    // Create a key with IP allowlist
    const createRes = await httpPost(port, '/keys', { name: 'ip-test', credits: 100 }, { 'x-admin-key': adminKey });
    expect(createRes.status).toBe(201);
    const apiKey = createRes.body.key;

    // Set IP allowlist to only allow 1.2.3.4
    const aclRes = await httpPost(port, '/keys/acl', { key: apiKey, ipAllowlist: ['1.2.3.4'] }, { 'x-admin-key': adminKey });
    expect(aclRes.status).toBe(200);

    // Make a request with XFF showing client 1.2.3.4 through proxy 10.0.0.1
    // resolveClientIp should extract 1.2.3.4 as the real client
    const mcpRes = await httpPost(port, '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}
    }, { 'x-api-key': apiKey, 'x-forwarded-for': '1.2.3.4, 10.0.0.1' });

    // tools/list is a free method, should succeed
    expect(mcpRes.status).toBe(200);
  });
});

// ─── SDK Export Test ─────────────────────────────────────────────────────────

describe('Trusted Proxies (SDK export)', () => {
  test('resolveClientIp is exported from index', () => {
    const sdk = require('../src/index');
    expect(typeof sdk.resolveClientIp).toBe('function');
  });
});

// ─── CLI / Env Var Tests ─────────────────────────────────────────────────────

describe('Trusted Proxies (CLI)', () => {
  test('ENV_VAR_MAP includes PAYGATE_TRUSTED_PROXIES', () => {
    expect(ENV_VAR_MAP).toHaveProperty('PAYGATE_TRUSTED_PROXIES');
    expect(ENV_VAR_MAP.PAYGATE_TRUSTED_PROXIES).toContain('--trusted-proxies');
  });
});
