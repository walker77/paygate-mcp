/**
 * Tests for v5.6.0 — Configurable CORS
 *
 * Covers:
 *   - Default CORS (wildcard *)
 *   - Single origin restriction
 *   - Multiple origins
 *   - Credentials header
 *   - Max-Age on preflight
 *   - Vary header when origin is not *
 *   - Rejected origins return empty
 *   - CORS via env var (PAYGATE_CORS_ORIGIN)
 *   - ENV_VAR_MAP includes PAYGATE_CORS_ORIGIN
 *   - /info features.corsRestricted flag
 */

import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';
import { ENV_VAR_MAP } from '../src/cli';
import http from 'http';

// ─── Helpers ───────────────────────────────────────────────────────────────────

const ECHO_CMD = process.execPath;
const ECHO_ARGS = ['-e', 'process.stdin.resume(); process.stdin.on("data", d => { const r = JSON.parse(d.toString().trim()); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: {} }) + "\\n"); });'];

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(data), headers: res.headers }); }
        catch { resolve({ status: res.statusCode!, body: data, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Default CORS (wildcard) ─────────────────────────────────────────────────

describe('CORS — Default (wildcard)', () => {
  let server: PayGateServer;
  let port: number;

  beforeAll(async () => {
    server = new PayGateServer(
      { ...DEFAULT_CONFIG, port: 0, serverCommand: ECHO_CMD, serverArgs: ECHO_ARGS },
      undefined,
    );
    const info = await server.start();
    port = info.port;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('default CORS returns Access-Control-Allow-Origin: *', async () => {
    const res = await request(port, 'GET', '/health');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  test('no Vary header when origin is *', async () => {
    const res = await request(port, 'GET', '/health');
    expect(res.headers['vary']).toBeUndefined();
  });

  test('no credentials header by default', async () => {
    const res = await request(port, 'GET', '/health');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

// ─── Single origin restriction ───────────────────────────────────────────────

describe('CORS — Single Origin', () => {
  let server: PayGateServer;
  let port: number;

  beforeAll(async () => {
    server = new PayGateServer(
      {
        ...DEFAULT_CONFIG,
        port: 0,
        serverCommand: ECHO_CMD,
        serverArgs: ECHO_ARGS,
        cors: { origin: 'https://app.example.com' },
      },
      undefined,
    );
    const info = await server.start();
    port = info.port;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('returns origin when request matches', async () => {
    const res = await request(port, 'GET', '/health', undefined, { Origin: 'https://app.example.com' });
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
  });

  test('returns empty when request origin does not match', async () => {
    const res = await request(port, 'GET', '/health', undefined, { Origin: 'https://evil.com' });
    expect(res.headers['access-control-allow-origin']).toBe('');
  });

  test('returns empty when no Origin header', async () => {
    const res = await request(port, 'GET', '/health');
    expect(res.headers['access-control-allow-origin']).toBe('');
  });

  test('includes Vary: Origin header', async () => {
    const res = await request(port, 'GET', '/health', undefined, { Origin: 'https://app.example.com' });
    expect(res.headers['vary']).toBe('Origin');
  });
});

// ─── Multiple origins ────────────────────────────────────────────────────────

describe('CORS — Multiple Origins', () => {
  let server: PayGateServer;
  let port: number;

  beforeAll(async () => {
    server = new PayGateServer(
      {
        ...DEFAULT_CONFIG,
        port: 0,
        serverCommand: ECHO_CMD,
        serverArgs: ECHO_ARGS,
        cors: { origin: ['https://app1.example.com', 'https://app2.example.com'] },
      },
      undefined,
    );
    const info = await server.start();
    port = info.port;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('returns origin when first origin matches', async () => {
    const res = await request(port, 'GET', '/health', undefined, { Origin: 'https://app1.example.com' });
    expect(res.headers['access-control-allow-origin']).toBe('https://app1.example.com');
  });

  test('returns origin when second origin matches', async () => {
    const res = await request(port, 'GET', '/health', undefined, { Origin: 'https://app2.example.com' });
    expect(res.headers['access-control-allow-origin']).toBe('https://app2.example.com');
  });

  test('returns empty for non-matching origin', async () => {
    const res = await request(port, 'GET', '/health', undefined, { Origin: 'https://evil.com' });
    expect(res.headers['access-control-allow-origin']).toBe('');
  });

  test('array with * returns wildcard', async () => {
    const server2 = new PayGateServer(
      {
        ...DEFAULT_CONFIG,
        port: 0,
        serverCommand: ECHO_CMD,
        serverArgs: ECHO_ARGS,
        cors: { origin: ['*'] },
      },
      undefined,
    );
    const info = await server2.start();
    try {
      const res = await request(info.port, 'GET', '/health');
      expect(res.headers['access-control-allow-origin']).toBe('*');
    } finally {
      await server2.stop();
    }
  });
});

// ─── Credentials & Max-Age ───────────────────────────────────────────────────

describe('CORS — Credentials & Max-Age', () => {
  let server: PayGateServer;
  let port: number;

  beforeAll(async () => {
    server = new PayGateServer(
      {
        ...DEFAULT_CONFIG,
        port: 0,
        serverCommand: ECHO_CMD,
        serverArgs: ECHO_ARGS,
        cors: {
          origin: 'https://app.example.com',
          credentials: true,
          maxAge: 3600,
        },
      },
      undefined,
    );
    const info = await server.start();
    port = info.port;
  });

  afterAll(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  test('includes Access-Control-Allow-Credentials: true', async () => {
    const res = await request(port, 'GET', '/health', undefined, { Origin: 'https://app.example.com' });
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  test('preflight includes Access-Control-Max-Age', async () => {
    const res = await request(port, 'OPTIONS', '/mcp', undefined, { Origin: 'https://app.example.com' });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-max-age']).toBe('3600');
  });

  test('default max-age is 86400', async () => {
    const server2 = new PayGateServer(
      {
        ...DEFAULT_CONFIG,
        port: 0,
        serverCommand: ECHO_CMD,
        serverArgs: ECHO_ARGS,
        cors: { origin: '*' },
      },
      undefined,
    );
    const info = await server2.start();
    try {
      const res = await request(info.port, 'OPTIONS', '/mcp');
      expect(res.headers['access-control-max-age']).toBe('86400');
    } finally {
      await server2.stop();
    }
  });
});

// ─── /info shows corsRestricted ──────────────────────────────────────────────

describe('CORS — Info Endpoint Flag', () => {
  test('corsRestricted is false when cors is not set', async () => {
    const server = new PayGateServer(
      { ...DEFAULT_CONFIG, port: 0, serverCommand: ECHO_CMD, serverArgs: ECHO_ARGS },
      undefined,
    );
    const info = await server.start();
    try {
      const res = await request(info.port, 'GET', '/info');
      expect(res.body.features.corsRestricted).toBe(false);
    } finally {
      await server.stop();
    }
  });

  test('corsRestricted is true when origin is restricted', async () => {
    const server = new PayGateServer(
      {
        ...DEFAULT_CONFIG,
        port: 0,
        serverCommand: ECHO_CMD,
        serverArgs: ECHO_ARGS,
        cors: { origin: 'https://myapp.com' },
      },
      undefined,
    );
    const info = await server.start();
    try {
      const res = await request(info.port, 'GET', '/info');
      expect(res.body.features.corsRestricted).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

// ─── ENV_VAR_MAP includes CORS ───────────────────────────────────────────────

describe('CORS — ENV_VAR_MAP', () => {
  test('PAYGATE_CORS_ORIGIN is in ENV_VAR_MAP', () => {
    expect(ENV_VAR_MAP).toHaveProperty('PAYGATE_CORS_ORIGIN');
  });

  test('maps to --cors-origin flag', () => {
    expect(ENV_VAR_MAP.PAYGATE_CORS_ORIGIN).toContain('--cors-origin');
  });
});
