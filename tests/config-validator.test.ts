/**
 * Tests for v2.7.0 — Config Validation + Dry Run.
 * Covers: validateConfig(), formatDiagnostics(), CLI validate command, --dry-run.
 */

import { validateConfig, formatDiagnostics, ValidatableConfig, ConfigDiagnostic } from '../src/config-validator';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';

const REPO_ROOT = path.join(__dirname, '..');
const MOCK_SERVER = path.join(__dirname, 'e2e', 'mock-mcp-server.js');

// ─── validateConfig() Unit Tests ─────────────────────────────────────────────

describe('v2.7.0 — validateConfig()', () => {
  test('valid minimal config — serverCommand', () => {
    const diags = validateConfig({ serverCommand: 'node server.js' });
    const errors = diags.filter(d => d.level === 'error');
    expect(errors.length).toBe(0);
  });

  test('valid minimal config — remoteUrl', () => {
    const diags = validateConfig({ remoteUrl: 'https://example.com/mcp' });
    const errors = diags.filter(d => d.level === 'error');
    expect(errors.length).toBe(0);
  });

  test('valid minimal config — servers[]', () => {
    const diags = validateConfig({
      servers: [
        { prefix: 'fs', serverCommand: 'node', serverArgs: ['server.js'] },
      ],
    });
    const errors = diags.filter(d => d.level === 'error');
    expect(errors.length).toBe(0);
  });

  test('error: no backend configured', () => {
    const diags = validateConfig({});
    expect(diags.some(d => d.level === 'error' && d.field.includes('serverCommand'))).toBe(true);
  });

  test('error: servers[] + serverCommand', () => {
    const diags = validateConfig({
      serverCommand: 'node server.js',
      servers: [{ prefix: 'a', serverCommand: 'x' }],
    });
    expect(diags.some(d => d.level === 'error' && d.message.includes('Cannot combine'))).toBe(true);
  });

  test('error: serverCommand + remoteUrl', () => {
    const diags = validateConfig({
      serverCommand: 'node server.js',
      remoteUrl: 'https://example.com/mcp',
    });
    expect(diags.some(d => d.level === 'error' && d.message.includes('Cannot specify both'))).toBe(true);
  });

  test('error: duplicate server prefixes', () => {
    const diags = validateConfig({
      servers: [
        { prefix: 'fs', serverCommand: 'a' },
        { prefix: 'fs', serverCommand: 'b' },
      ],
    });
    expect(diags.some(d => d.level === 'error' && d.message.includes('Duplicate prefix'))).toBe(true);
  });

  test('error: server without prefix', () => {
    const diags = validateConfig({
      servers: [{ serverCommand: 'x' } as any],
    });
    expect(diags.some(d => d.level === 'error' && d.message.includes('missing required "prefix"'))).toBe(true);
  });

  test('error: server without backend', () => {
    const diags = validateConfig({
      servers: [{ prefix: 'a' }],
    });
    expect(diags.some(d => d.level === 'error' && d.message.includes('no serverCommand or remoteUrl'))).toBe(true);
  });

  test('error: server with both backends', () => {
    const diags = validateConfig({
      servers: [{ prefix: 'a', serverCommand: 'x', remoteUrl: 'http://y' }],
    });
    expect(diags.some(d => d.level === 'error' && d.message.includes('both serverCommand and remoteUrl'))).toBe(true);
  });

  test('error: invalid port', () => {
    const diags = validateConfig({ serverCommand: 'x', port: 99999 });
    expect(diags.some(d => d.level === 'error' && d.field === 'port')).toBe(true);
  });

  test('error: negative port', () => {
    const diags = validateConfig({ serverCommand: 'x', port: -1 });
    expect(diags.some(d => d.level === 'error' && d.field === 'port')).toBe(true);
  });

  test('valid port 0 (random)', () => {
    const diags = validateConfig({ serverCommand: 'x', port: 0 });
    const portErrors = diags.filter(d => d.field === 'port');
    expect(portErrors.length).toBe(0);
  });

  test('error: negative defaultCreditsPerCall', () => {
    const diags = validateConfig({ serverCommand: 'x', defaultCreditsPerCall: -5 });
    expect(diags.some(d => d.level === 'error' && d.field === 'defaultCreditsPerCall')).toBe(true);
  });

  test('error: negative globalRateLimitPerMin', () => {
    const diags = validateConfig({ serverCommand: 'x', globalRateLimitPerMin: -1 });
    expect(diags.some(d => d.level === 'error' && d.field === 'globalRateLimitPerMin')).toBe(true);
  });

  test('error: negative webhookMaxRetries', () => {
    const diags = validateConfig({ serverCommand: 'x', webhookMaxRetries: -1 });
    expect(diags.some(d => d.level === 'error' && d.field === 'webhookMaxRetries')).toBe(true);
  });

  test('error: invalid webhookUrl', () => {
    const diags = validateConfig({ serverCommand: 'x', webhookUrl: 'not-a-url' });
    expect(diags.some(d => d.level === 'error' && d.field === 'webhookUrl')).toBe(true);
  });

  test('warning: webhookSecret without webhookUrl', () => {
    const diags = validateConfig({ serverCommand: 'x', webhookSecret: 'secret' });
    expect(diags.some(d => d.level === 'warning' && d.field === 'webhookSecret')).toBe(true);
  });

  test('error: invalid redisUrl protocol', () => {
    const diags = validateConfig({ serverCommand: 'x', redisUrl: 'http://localhost:6379' });
    expect(diags.some(d => d.level === 'error' && d.field === 'redisUrl')).toBe(true);
  });

  test('error: invalid redisUrl format', () => {
    const diags = validateConfig({ serverCommand: 'x', redisUrl: 'not-a-url' });
    expect(diags.some(d => d.level === 'error' && d.field === 'redisUrl')).toBe(true);
  });

  test('valid redisUrl', () => {
    const diags = validateConfig({ serverCommand: 'x', redisUrl: 'redis://localhost:6379' });
    const redisErrors = diags.filter(d => d.field === 'redisUrl' && d.level === 'error');
    expect(redisErrors.length).toBe(0);
  });

  test('error: invalid toolPricing creditsPerCall', () => {
    const diags = validateConfig({
      serverCommand: 'x',
      toolPricing: { search: { creditsPerCall: -1 } },
    });
    expect(diags.some(d => d.level === 'error' && d.field.includes('search'))).toBe(true);
  });

  test('error: invalid toolPricing rateLimitPerMin', () => {
    const diags = validateConfig({
      serverCommand: 'x',
      toolPricing: { search: { rateLimitPerMin: -1 } },
    });
    expect(diags.some(d => d.level === 'error' && d.field.includes('search'))).toBe(true);
  });

  test('error: invalid quota field', () => {
    const diags = validateConfig({
      serverCommand: 'x',
      globalQuota: { dailyCallLimit: -5 },
    });
    expect(diags.some(d => d.level === 'error' && d.field.includes('dailyCallLimit'))).toBe(true);
  });

  test('error: invalid importKeys credits', () => {
    const diags = validateConfig({
      serverCommand: 'x',
      importKeys: { 'pg_test': -100 },
    });
    expect(diags.some(d => d.level === 'error' && d.field.includes('pg_test'))).toBe(true);
  });

  test('error: invalid oauth accessTokenTtl', () => {
    const diags = validateConfig({
      serverCommand: 'x',
      oauth: { accessTokenTtl: -1 },
    });
    expect(diags.some(d => d.level === 'error' && d.field.includes('accessTokenTtl'))).toBe(true);
  });

  test('warning: shadowMode', () => {
    const diags = validateConfig({ serverCommand: 'x', shadowMode: true });
    expect(diags.some(d => d.level === 'warning' && d.field === 'shadowMode')).toBe(true);
  });

  test('warning: stateFile + redisUrl', () => {
    const diags = validateConfig({
      serverCommand: 'x',
      stateFile: '/tmp/state.json',
      redisUrl: 'redis://localhost:6379',
    });
    expect(diags.some(d => d.level === 'warning' && d.message.includes('redundant'))).toBe(true);
  });

  test('error: invalid remoteUrl', () => {
    const diags = validateConfig({ remoteUrl: 'not-a-url' });
    expect(diags.some(d => d.level === 'error' && d.field === 'remoteUrl')).toBe(true);
  });

  test('warning: special characters in prefix', () => {
    const diags = validateConfig({
      servers: [{ prefix: '@weird!', serverCommand: 'x' }],
    });
    expect(diags.some(d => d.level === 'warning' && d.message.includes('special characters'))).toBe(true);
  });
});

// ─── formatDiagnostics() ─────────────────────────────────────────────────────

describe('v2.7.0 — formatDiagnostics()', () => {
  test('empty diagnostics returns valid message', () => {
    const result = formatDiagnostics([]);
    expect(result).toContain('valid');
  });

  test('errors are formatted with ERROR prefix', () => {
    const diags: ConfigDiagnostic[] = [
      { level: 'error', field: 'port', message: 'Invalid port' },
    ];
    const result = formatDiagnostics(diags);
    expect(result).toContain('ERROR');
    expect(result).toContain('port');
    expect(result).toContain('Invalid port');
  });

  test('warnings are formatted with WARN prefix', () => {
    const diags: ConfigDiagnostic[] = [
      { level: 'warning', field: 'shadowMode', message: 'Shadow mode enabled' },
    ];
    const result = formatDiagnostics(diags);
    expect(result).toContain('WARN');
    expect(result).toContain('shadowMode');
  });

  test('mixed errors and warnings', () => {
    const diags: ConfigDiagnostic[] = [
      { level: 'error', field: 'port', message: 'Bad port' },
      { level: 'warning', field: 'shadow', message: 'Shadow mode' },
    ];
    const result = formatDiagnostics(diags);
    expect(result).toContain('1 error');
    expect(result).toContain('1 warning');
  });
});

// ─── CLI validate command integration ─────────────────────────────────────────

describe('v2.7.0 — CLI validate command', () => {
  const tmpConfig = '/tmp/paygate-test-config.json';

  afterEach(() => {
    try { unlinkSync(tmpConfig); } catch {}
  });

  test('validate valid config exits 0', () => {
    writeFileSync(tmpConfig, JSON.stringify({
      serverCommand: 'node',
      serverArgs: ['server.js'],
      port: 3402,
      defaultCreditsPerCall: 1,
    }));

    const result = spawnSync('node', ['dist/cli.js', 'validate', '--config', tmpConfig], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('valid');
  });

  test('validate invalid config exits 1', () => {
    writeFileSync(tmpConfig, JSON.stringify({
      port: -1,
    }));

    const result = spawnSync('node', ['dist/cli.js', 'validate', '--config', tmpConfig], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('ERROR');
  });

  test('validate without --config exits 1', () => {
    const result = spawnSync('node', ['dist/cli.js', 'validate'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).toBe(1);
  });

  test('validate non-existent config file exits 1', () => {
    const result = spawnSync('node', ['dist/cli.js', 'validate', '--config', '/tmp/nonexistent-paygate.json'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).toBe(1);
  });
});

// ─── Dry Run ──────────────────────────────────────────────────────────────────

describe('v2.7.0 — Dry Run (--dry-run)', () => {
  test('dry run discovers tools and exits', () => {
    const result = spawnSync(
      'node', ['dist/cli.js', 'wrap', '--server', `node ${MOCK_SERVER}`, '--port', '0', '--dry-run'],
      { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 15000 }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('DRY RUN');
    expect(result.stdout).toContain('Discovered');
    expect(result.stdout).toContain('Dry run complete');
  }, 20000);
});
