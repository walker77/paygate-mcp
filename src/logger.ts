/**
 * PayGate Structured Logger — zero-dependency, production-ready logging.
 *
 * Supports two output formats:
 *   - `text` (default): Human-readable `[component] message` format
 *   - `json`: Machine-parseable structured JSON per line (for log aggregators)
 *
 * Log levels: debug < info < warn < error < silent
 *
 * @example
 * ```ts
 * const logger = new Logger({ level: 'info', format: 'json', component: 'paygate' });
 * logger.info('Server started', { port: 3000 });
 * // {"ts":"2026-02-27T...","level":"info","component":"paygate","msg":"Server started","port":3000}
 *
 * const child = logger.child('redis');
 * child.error('Connection failed', { host: 'localhost' });
 * // {"ts":"2026-02-27T...","level":"error","component":"paygate:redis","msg":"Connection failed","host":"localhost"}
 * ```
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type LogFormat = 'text' | 'json';

/** Numeric ordering for level comparison */
const LEVEL_VALUE: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

/** Valid log level strings for validation */
export const VALID_LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent'];

/** Valid log format strings for validation */
export const VALID_LOG_FORMATS: readonly LogFormat[] = ['text', 'json'];

export interface LoggerOptions {
  /** Minimum log level. Messages below this level are suppressed. Default: 'info'. */
  level?: LogLevel;
  /** Output format. Default: 'text'. */
  format?: LogFormat;
  /** Component name for log prefixing. Default: 'paygate'. */
  component?: string;
}

export class Logger {
  private readonly minLevel: number;
  private readonly format: LogFormat;
  readonly component: string;

  constructor(opts?: LoggerOptions) {
    this.minLevel = LEVEL_VALUE[opts?.level ?? 'info'];
    this.format = opts?.format ?? 'text';
    this.component = opts?.component ?? 'paygate';
  }

  /**
   * Create a child logger with a sub-component prefix.
   * Inherits level and format from the parent.
   *
   * @example
   * ```ts
   * const redis = logger.child('redis');
   * redis.info('Connected'); // [paygate:redis] Connected
   * ```
   */
  child(component: string): Logger {
    const levelName = (Object.entries(LEVEL_VALUE).find(([_, v]) => v === this.minLevel)?.[0] ?? 'info') as LogLevel;
    return new Logger({
      level: levelName,
      format: this.format,
      component: `${this.component}:${component}`,
    });
  }

  /** Log at debug level (verbose operational details) */
  debug(msg: string, ctx?: Record<string, unknown>): void {
    this._log('debug', msg, ctx);
  }

  /** Log at info level (normal operational messages) */
  info(msg: string, ctx?: Record<string, unknown>): void {
    this._log('info', msg, ctx);
  }

  /** Log at warn level (recoverable issues) */
  warn(msg: string, ctx?: Record<string, unknown>): void {
    this._log('warn', msg, ctx);
  }

  /** Log at error level (failures requiring attention) */
  error(msg: string, ctx?: Record<string, unknown>): void {
    this._log('error', msg, ctx);
  }

  /** Check whether a given level would produce output */
  isLevelEnabled(level: LogLevel): boolean {
    return LEVEL_VALUE[level] >= this.minLevel;
  }

  private _log(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
    if (LEVEL_VALUE[level] < this.minLevel) return;

    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

    if (this.format === 'json') {
      const entry: Record<string, unknown> = {
        ts: new Date().toISOString(),
        level,
        component: this.component,
        msg,
      };
      if (ctx) {
        for (const [k, v] of Object.entries(ctx)) {
          entry[k] = v;
        }
      }
      fn(JSON.stringify(entry));
    } else {
      const tag = `[${this.component}]`;
      if (ctx && Object.keys(ctx).length > 0) {
        fn(`${tag} ${msg}`, ctx);
      } else {
        fn(`${tag} ${msg}`);
      }
    }
  }
}

/**
 * Parse a log level string (case-insensitive, with validation).
 * Returns the parsed level or the default if invalid.
 */
export function parseLogLevel(value: string | undefined, defaultLevel: LogLevel = 'info'): LogLevel {
  if (!value) return defaultLevel;
  const lower = value.toLowerCase() as LogLevel;
  return VALID_LOG_LEVELS.includes(lower) ? lower : defaultLevel;
}

/**
 * Parse a log format string (case-insensitive, with validation).
 * Returns the parsed format or the default if invalid.
 */
export function parseLogFormat(value: string | undefined, defaultFormat: LogFormat = 'text'): LogFormat {
  if (!value) return defaultFormat;
  const lower = value.toLowerCase() as LogFormat;
  return VALID_LOG_FORMATS.includes(lower) ? lower : defaultFormat;
}
