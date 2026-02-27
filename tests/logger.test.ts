/**
 * Logger tests — structured logging with levels, formats, and child loggers.
 */

import { Logger, parseLogLevel, parseLogFormat, VALID_LOG_LEVELS, VALID_LOG_FORMATS } from '../src/logger';
import type { LogLevel, LogFormat } from '../src/logger';

describe('Logger', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // ─── Construction & Defaults ─────────────────────────────────────────────

  it('should create with defaults (info level, text format, paygate component)', () => {
    const logger = new Logger();
    expect(logger.component).toBe('paygate');
  });

  it('should accept custom options', () => {
    const logger = new Logger({ level: 'debug', format: 'json', component: 'myapp' });
    expect(logger.component).toBe('myapp');
  });

  // ─── Text Format ─────────────────────────────────────────────────────────

  describe('text format', () => {
    it('should output [component] message for info', () => {
      const logger = new Logger({ level: 'info', format: 'text', component: 'paygate' });
      logger.info('Server started');
      expect(logSpy).toHaveBeenCalledWith('[paygate] Server started');
    });

    it('should output [component] message with context', () => {
      const logger = new Logger({ level: 'info', format: 'text', component: 'paygate' });
      logger.info('Connected', { host: 'localhost', port: 6379 });
      expect(logSpy).toHaveBeenCalledWith('[paygate] Connected', { host: 'localhost', port: 6379 });
    });

    it('should use console.warn for warn level', () => {
      const logger = new Logger({ level: 'warn', format: 'text' });
      logger.warn('Something fishy');
      expect(warnSpy).toHaveBeenCalledWith('[paygate] Something fishy');
    });

    it('should use console.error for error level', () => {
      const logger = new Logger({ level: 'error', format: 'text' });
      logger.error('Something broke');
      expect(errorSpy).toHaveBeenCalledWith('[paygate] Something broke');
    });

    it('should use console.log for debug level', () => {
      const logger = new Logger({ level: 'debug', format: 'text' });
      logger.debug('Verbose detail');
      expect(logSpy).toHaveBeenCalledWith('[paygate] Verbose detail');
    });
  });

  // ─── JSON Format ─────────────────────────────────────────────────────────

  describe('json format', () => {
    it('should output structured JSON for info', () => {
      const logger = new Logger({ level: 'info', format: 'json', component: 'paygate' });
      logger.info('Server started');

      expect(logSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(logSpy.mock.calls[0][0]);
      expect(parsed.level).toBe('info');
      expect(parsed.component).toBe('paygate');
      expect(parsed.msg).toBe('Server started');
      expect(parsed.ts).toBeDefined();
      // Validate ISO date format
      expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts);
    });

    it('should include context fields in JSON', () => {
      const logger = new Logger({ level: 'info', format: 'json' });
      logger.info('Connected', { host: 'localhost', port: 6379 });

      const parsed = JSON.parse(logSpy.mock.calls[0][0]);
      expect(parsed.host).toBe('localhost');
      expect(parsed.port).toBe(6379);
    });

    it('should use console.error for error level in JSON mode', () => {
      const logger = new Logger({ level: 'error', format: 'json' });
      logger.error('Crash');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(errorSpy.mock.calls[0][0]);
      expect(parsed.level).toBe('error');
      expect(parsed.msg).toBe('Crash');
    });

    it('should use console.warn for warn level in JSON mode', () => {
      const logger = new Logger({ level: 'warn', format: 'json' });
      logger.warn('Warning');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(warnSpy.mock.calls[0][0]);
      expect(parsed.level).toBe('warn');
    });
  });

  // ─── Level Filtering ─────────────────────────────────────────────────────

  describe('level filtering', () => {
    it('should suppress debug when level is info', () => {
      const logger = new Logger({ level: 'info' });
      logger.debug('hidden');
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('should allow info when level is info', () => {
      const logger = new Logger({ level: 'info' });
      logger.info('visible');
      expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it('should allow warn when level is info', () => {
      const logger = new Logger({ level: 'info' });
      logger.warn('visible');
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('should suppress info when level is warn', () => {
      const logger = new Logger({ level: 'warn' });
      logger.info('hidden');
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('should suppress info and warn when level is error', () => {
      const logger = new Logger({ level: 'error' });
      logger.info('hidden');
      logger.warn('also hidden');
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should allow error when level is error', () => {
      const logger = new Logger({ level: 'error' });
      logger.error('visible');
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('should suppress all when level is silent', () => {
      const logger = new Logger({ level: 'silent' });
      logger.debug('hidden');
      logger.info('hidden');
      logger.warn('hidden');
      logger.error('hidden');
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('should allow all when level is debug', () => {
      const logger = new Logger({ level: 'debug' });
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      expect(logSpy).toHaveBeenCalledTimes(2); // debug + info
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ─── isLevelEnabled ──────────────────────────────────────────────────────

  describe('isLevelEnabled', () => {
    it('should return true for enabled levels', () => {
      const logger = new Logger({ level: 'warn' });
      expect(logger.isLevelEnabled('warn')).toBe(true);
      expect(logger.isLevelEnabled('error')).toBe(true);
    });

    it('should return false for suppressed levels', () => {
      const logger = new Logger({ level: 'warn' });
      expect(logger.isLevelEnabled('debug')).toBe(false);
      expect(logger.isLevelEnabled('info')).toBe(false);
    });

    it('should return false for all levels when silent', () => {
      const logger = new Logger({ level: 'silent' });
      expect(logger.isLevelEnabled('debug')).toBe(false);
      expect(logger.isLevelEnabled('info')).toBe(false);
      expect(logger.isLevelEnabled('warn')).toBe(false);
      expect(logger.isLevelEnabled('error')).toBe(false);
    });
  });

  // ─── Child Loggers ───────────────────────────────────────────────────────

  describe('child loggers', () => {
    it('should create child with combined component name', () => {
      const parent = new Logger({ level: 'info', format: 'text', component: 'paygate' });
      const child = parent.child('redis');
      expect(child.component).toBe('paygate:redis');
    });

    it('should inherit level from parent', () => {
      const parent = new Logger({ level: 'warn', format: 'text' });
      const child = parent.child('redis');
      child.info('should be hidden');
      child.warn('should be visible');
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith('[paygate:redis] should be visible');
    });

    it('should inherit format from parent', () => {
      const parent = new Logger({ level: 'info', format: 'json', component: 'app' });
      const child = parent.child('db');
      child.info('connected');

      const parsed = JSON.parse(logSpy.mock.calls[0][0]);
      expect(parsed.component).toBe('app:db');
    });

    it('should create nested children', () => {
      const root = new Logger({ level: 'info', format: 'text', component: 'paygate' });
      const child = root.child('redis');
      const grandchild = child.child('pubsub');
      expect(grandchild.component).toBe('paygate:redis:pubsub');
    });
  });

  // ─── Empty Context ───────────────────────────────────────────────────────

  describe('empty context', () => {
    it('should not pass empty object as second arg in text mode', () => {
      const logger = new Logger({ level: 'info', format: 'text' });
      logger.info('message', {});
      // Should be called with just the message (no second arg)
      expect(logSpy).toHaveBeenCalledWith('[paygate] message');
    });

    it('should not include extra fields in JSON when context is empty', () => {
      const logger = new Logger({ level: 'info', format: 'json' });
      logger.info('message', {});

      const parsed = JSON.parse(logSpy.mock.calls[0][0]);
      expect(Object.keys(parsed)).toEqual(['ts', 'level', 'component', 'msg']);
    });

    it('should handle undefined context', () => {
      const logger = new Logger({ level: 'info', format: 'text' });
      logger.info('message');
      expect(logSpy).toHaveBeenCalledWith('[paygate] message');
    });
  });
});

// ─── parseLogLevel ───────────────────────────────────────────────────────────

describe('parseLogLevel', () => {
  it('should parse valid levels', () => {
    expect(parseLogLevel('debug')).toBe('debug');
    expect(parseLogLevel('info')).toBe('info');
    expect(parseLogLevel('warn')).toBe('warn');
    expect(parseLogLevel('error')).toBe('error');
    expect(parseLogLevel('silent')).toBe('silent');
  });

  it('should be case-insensitive', () => {
    expect(parseLogLevel('DEBUG')).toBe('debug');
    expect(parseLogLevel('INFO')).toBe('info');
    expect(parseLogLevel('WARN')).toBe('warn');
  });

  it('should return default for invalid values', () => {
    expect(parseLogLevel('invalid')).toBe('info');
    expect(parseLogLevel('verbose')).toBe('info');
    expect(parseLogLevel('')).toBe('info');
  });

  it('should return default for undefined', () => {
    expect(parseLogLevel(undefined)).toBe('info');
  });

  it('should use custom default', () => {
    expect(parseLogLevel(undefined, 'warn')).toBe('warn');
    expect(parseLogLevel('invalid', 'error')).toBe('error');
  });
});

// ─── parseLogFormat ──────────────────────────────────────────────────────────

describe('parseLogFormat', () => {
  it('should parse valid formats', () => {
    expect(parseLogFormat('text')).toBe('text');
    expect(parseLogFormat('json')).toBe('json');
  });

  it('should be case-insensitive', () => {
    expect(parseLogFormat('TEXT')).toBe('text');
    expect(parseLogFormat('JSON')).toBe('json');
  });

  it('should return default for invalid values', () => {
    expect(parseLogFormat('xml')).toBe('text');
    expect(parseLogFormat('csv')).toBe('text');
  });

  it('should return default for undefined', () => {
    expect(parseLogFormat(undefined)).toBe('text');
  });

  it('should use custom default', () => {
    expect(parseLogFormat(undefined, 'json')).toBe('json');
    expect(parseLogFormat('invalid', 'json')).toBe('json');
  });
});

// ─── Constants ───────────────────────────────────────────────────────────────

describe('constants', () => {
  it('should export valid log levels', () => {
    expect(VALID_LOG_LEVELS).toEqual(['debug', 'info', 'warn', 'error', 'silent']);
  });

  it('should export valid log formats', () => {
    expect(VALID_LOG_FORMATS).toEqual(['text', 'json']);
  });
});

// ─── Integration: Server logger wiring ───────────────────────────────────────

describe('Logger integration with PayGateServer', () => {
  it('should wire logger with logLevel and logFormat config', async () => {
    const { PayGateServer } = require('../src/server');
    const server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      logLevel: 'warn',
      logFormat: 'json',
    });
    expect(server.logger).toBeDefined();
    expect(server.logger.component).toBe('paygate');
    // Should suppress info-level messages
    expect(server.logger.isLevelEnabled('info')).toBe(false);
    expect(server.logger.isLevelEnabled('warn')).toBe(true);
  });

  it('should default to info/text when not specified', async () => {
    const { PayGateServer } = require('../src/server');
    const server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
    });
    expect(server.logger.isLevelEnabled('info')).toBe(true);
    expect(server.logger.isLevelEnabled('debug')).toBe(false);
  });

  it('should propagate logger to gate.store', async () => {
    const { PayGateServer } = require('../src/server');
    const server = new PayGateServer({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      logLevel: 'error',
    });
    // Store should have the same logger (set by server)
    expect(server.gate.store.logger).toBe(server.logger);
  });
});
