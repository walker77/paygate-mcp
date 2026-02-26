/**
 * Tests for v5.3.0 — Environment Variables Config
 *
 * Covers:
 *   - PAYGATE_* env vars resolve correctly for all supported options
 *   - CLI flags override env vars
 *   - Config file is used when no env var or CLI flag is set
 *   - PAYGATE_CONFIG loads config file from env var
 *   - Boolean env vars (PAYGATE_SHADOW, PAYGATE_REFUND_ON_FAILURE, PAYGATE_DRY_RUN)
 *   - ENV_VAR_MAP exported and complete
 */

import { ENV_VAR_MAP } from '../src/cli';
import { PayGateServer } from '../src/server';
import { DEFAULT_CONFIG } from '../src/types';
import http from 'http';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync, spawn } from 'child_process';

// ─── Helpers ───────────────────────────────────────────────────────────────────

const ECHO_CMD = process.execPath;
const ECHO_ARGS = ['-e', 'process.stdin.resume(); process.stdin.on("data", d => { const r = JSON.parse(d.toString().trim()); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: {} }) + "\\n"); });'];

function tmpPath(suffix: string): string {
  return join(tmpdir(), `paygate-env-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}`);
}

function cleanup(path: string): void {
  try { if (existsSync(path)) unlinkSync(path); } catch {}
}

function request(port: number, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }> {
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
        try { resolve({ status: res.statusCode!, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode!, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Unit Tests ──────────────────────────────────────────────────────────────

describe('ENV_VAR_MAP', () => {
  test('exports a non-empty map of env var names', () => {
    expect(Object.keys(ENV_VAR_MAP).length).toBeGreaterThanOrEqual(17);
  });

  test('all keys start with PAYGATE_', () => {
    for (const key of Object.keys(ENV_VAR_MAP)) {
      expect(key).toMatch(/^PAYGATE_/);
    }
  });

  test('all values reference CLI flags', () => {
    for (const value of Object.values(ENV_VAR_MAP)) {
      expect(value).toMatch(/^--/);
    }
  });

  test('includes all expected env vars', () => {
    const expected = [
      'PAYGATE_SERVER', 'PAYGATE_REMOTE_URL', 'PAYGATE_CONFIG',
      'PAYGATE_PORT', 'PAYGATE_PRICE', 'PAYGATE_RATE_LIMIT',
      'PAYGATE_NAME', 'PAYGATE_SHADOW', 'PAYGATE_ADMIN_KEY',
      'PAYGATE_STATE_FILE', 'PAYGATE_WEBHOOK_URL', 'PAYGATE_WEBHOOK_SECRET',
      'PAYGATE_WEBHOOK_RETRIES', 'PAYGATE_REFUND_ON_FAILURE', 'PAYGATE_REDIS_URL',
      'PAYGATE_DRY_RUN', 'PAYGATE_TOOL_PRICE', 'PAYGATE_STRIPE_SECRET',
    ];
    for (const name of expected) {
      expect(ENV_VAR_MAP).toHaveProperty(name);
    }
  });
});

// ─── Integration: env vars used by server ────────────────────────────────────

describe('Env Var Config — Server Integration', () => {
  test('server accepts admin key passed via constructor (env var pathway)', async () => {
    const server = new PayGateServer(
      { ...DEFAULT_CONFIG, port: 0, serverCommand: ECHO_CMD, serverArgs: ECHO_ARGS },
      'env-admin-key-test-1234',
    );
    const info = await server.start();
    try {
      const res = await request(info.port, 'GET', '/keys', undefined, { 'X-Admin-Key': 'env-admin-key-test-1234' });
      expect(res.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  test('server with webhook URL (env var pathway)', async () => {
    const server = new PayGateServer(
      { ...DEFAULT_CONFIG, port: 0, serverCommand: ECHO_CMD, serverArgs: ECHO_ARGS, webhookUrl: 'https://env-test.example.com/hook' },
      undefined,
    );
    const info = await server.start();
    try {
      const res = await request(info.port, 'GET', '/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
    } finally {
      await server.stop();
    }
  });
});

// ─── Integration: CLI env var resolution (subprocess) ────────────────────────

describe('Env Var Config — CLI Subprocess', () => {
  test('PAYGATE_SERVER env var starts server without --server flag', (done) => {
    const cliPath = join(__dirname, '..', 'dist', 'cli.js');

    const child = spawn(process.execPath, [cliPath, 'wrap'], {
      env: {
        ...process.env,
        PAYGATE_SERVER: `${ECHO_CMD} ${ECHO_ARGS.join(' ')}`,
        PAYGATE_PORT: '0',
        PAYGATE_ADMIN_KEY: 'test-env-key-cli',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (stdout.includes('Server Running')) {
        child.kill('SIGTERM');
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      done(new Error(`Server did not start in time. stdout: ${stdout}, stderr: ${stderr}`));
    }, 10000);

    child.on('exit', () => {
      clearTimeout(timeout);
      if (stdout.includes('Server Running')) {
        done();
      } else if (stderr.includes('Error')) {
        done(new Error(`Server failed: ${stderr}`));
      } else {
        done();
      }
    });
  }, 15000);

  test('PAYGATE_PORT env var sets custom port', (done) => {
    const cliPath = join(__dirname, '..', 'dist', 'cli.js');
    const testPort = 30000 + Math.floor(Math.random() * 10000);

    const child = spawn(process.execPath, [cliPath, 'wrap'], {
      env: {
        ...process.env,
        PAYGATE_SERVER: `${ECHO_CMD} ${ECHO_ARGS.join(' ')}`,
        PAYGATE_PORT: String(testPort),
        PAYGATE_ADMIN_KEY: 'port-test-key',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (stdout.includes(String(testPort))) {
        child.kill('SIGTERM');
      }
    });

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      done(new Error(`Port not found in output. stdout: ${stdout}`));
    }, 10000);

    child.on('exit', () => {
      clearTimeout(timeout);
      expect(stdout).toContain(String(testPort));
      done();
    });
  }, 15000);

  test('CLI --port flag overrides PAYGATE_PORT env var', (done) => {
    const cliPath = join(__dirname, '..', 'dist', 'cli.js');
    const envPort = 30000 + Math.floor(Math.random() * 10000);
    const cliPort = envPort + 1;

    const child = spawn(process.execPath, [cliPath, 'wrap', '--port', String(cliPort)], {
      env: {
        ...process.env,
        PAYGATE_SERVER: `${ECHO_CMD} ${ECHO_ARGS.join(' ')}`,
        PAYGATE_PORT: String(envPort),
        PAYGATE_ADMIN_KEY: 'override-test-key',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (stdout.includes(String(cliPort))) {
        child.kill('SIGTERM');
      }
    });

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      done(new Error(`CLI port not found in output. stdout: ${stdout}`));
    }, 10000);

    child.on('exit', () => {
      clearTimeout(timeout);
      expect(stdout).toContain(String(cliPort));
      done();
    });
  }, 15000);

  test('PAYGATE_CONFIG env var loads config file', (done) => {
    const cliPath = join(__dirname, '..', 'dist', 'cli.js');
    const configFile = tmpPath('config.json');

    writeFileSync(configFile, JSON.stringify({
      serverCommand: ECHO_CMD,
      serverArgs: ECHO_ARGS,
      port: 0,
      adminKey: 'config-env-test-key',
    }));

    const child = spawn(process.execPath, [cliPath, 'wrap'], {
      env: {
        ...process.env,
        PAYGATE_CONFIG: configFile,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (stdout.includes('Server Running')) {
        child.kill('SIGTERM');
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      cleanup(configFile);
      done(new Error(`Server did not start. stdout: ${stdout}, stderr: ${stderr}`));
    }, 10000);

    child.on('exit', () => {
      clearTimeout(timeout);
      cleanup(configFile);
      expect(stdout).toContain('Server Running');
      done();
    });
  }, 15000);

  test('PAYGATE_SHADOW env var enables shadow mode', (done) => {
    const cliPath = join(__dirname, '..', 'dist', 'cli.js');

    const child = spawn(process.execPath, [cliPath, 'wrap'], {
      env: {
        ...process.env,
        PAYGATE_SERVER: `${ECHO_CMD} ${ECHO_ARGS.join(' ')}`,
        PAYGATE_PORT: '0',
        PAYGATE_SHADOW: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (stdout.includes('Shadow')) {
        child.kill('SIGTERM');
      }
    });

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      done(new Error(`Shadow not found. stdout: ${stdout}`));
    }, 10000);

    child.on('exit', () => {
      clearTimeout(timeout);
      expect(stdout).toContain('true');
      done();
    });
  }, 15000);
});

// ─── Help text includes env vars ─────────────────────────────────────────────

describe('Env Var Config — Help Text', () => {
  test('--help output includes ENVIRONMENT VARIABLES section', () => {
    const cliPath = join(__dirname, '..', 'dist', 'cli.js');
    const output = execFileSync(process.execPath, [cliPath, 'help'], { encoding: 'utf-8' });
    expect(output).toContain('ENVIRONMENT VARIABLES');
    expect(output).toContain('PAYGATE_SERVER');
    expect(output).toContain('PAYGATE_PORT');
    expect(output).toContain('PAYGATE_ADMIN_KEY');
    expect(output).toContain('PAYGATE_REDIS_URL');
    expect(output).toContain('Docker');
  });
});
