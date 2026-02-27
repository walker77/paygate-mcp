/**
 * Config Validator — Validates PayGate config files and CLI flags before starting.
 *
 * Returns a list of diagnostic messages (errors and warnings) so operators can
 * catch misconfigurations before the server starts.
 */

import { checkSsrf } from './webhook';

export interface ConfigDiagnostic {
  level: 'error' | 'warning';
  field: string;
  message: string;
}

export interface ValidatableConfig {
  serverCommand?: string;
  serverArgs?: string[];
  remoteUrl?: string;
  port?: number;
  defaultCreditsPerCall?: number;
  toolPricing?: Record<string, { creditsPerCall?: number; rateLimitPerMin?: number; creditsPerKbInput?: number }>;
  globalRateLimitPerMin?: number;
  globalQuota?: { dailyCallLimit?: number; monthlyCallLimit?: number; dailyCreditLimit?: number; monthlyCreditLimit?: number };
  shadowMode?: boolean;
  adminKey?: string;
  stateFile?: string;
  stripeWebhookSecret?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookMaxRetries?: number;
  refundOnFailure?: boolean;
  importKeys?: Record<string, number>;
  servers?: Array<{
    prefix?: string;
    serverCommand?: string;
    serverArgs?: string[];
    remoteUrl?: string;
  }>;
  oauth?: {
    issuer?: string;
    accessTokenTtl?: number;
    refreshTokenTtl?: number;
    scopes?: string[];
  };
  redisUrl?: string;
}

/**
 * Validate a PayGate config object. Returns an array of diagnostics.
 * Empty array = valid config.
 */
export function validateConfig(config: ValidatableConfig): ConfigDiagnostic[] {
  const diags: ConfigDiagnostic[] = [];

  // ─── Backend source validation ──────────────────────────────────────────
  const hasServer = !!(config.serverCommand);
  const hasRemote = !!(config.remoteUrl);
  const hasMulti = !!(config.servers && config.servers.length > 0);

  if (!hasServer && !hasRemote && !hasMulti) {
    diags.push({
      level: 'error',
      field: 'serverCommand | remoteUrl | servers',
      message: 'No backend configured. Provide serverCommand, remoteUrl, or servers[].',
    });
  }

  if (hasMulti && (hasServer || hasRemote)) {
    diags.push({
      level: 'error',
      field: 'servers',
      message: 'Cannot combine servers[] with serverCommand or remoteUrl. Use one or the other.',
    });
  }

  if (hasServer && hasRemote) {
    diags.push({
      level: 'error',
      field: 'serverCommand | remoteUrl',
      message: 'Cannot specify both serverCommand and remoteUrl. Use one or the other.',
    });
  }

  // ─── Multi-server validation ────────────────────────────────────────────
  if (hasMulti && config.servers) {
    const prefixes = new Set<string>();
    for (let i = 0; i < config.servers.length; i++) {
      const s = config.servers[i];
      if (!s.prefix) {
        diags.push({
          level: 'error',
          field: `servers[${i}].prefix`,
          message: `Server at index ${i} is missing required "prefix" field.`,
        });
      } else {
        if (prefixes.has(s.prefix)) {
          diags.push({
            level: 'error',
            field: `servers[${i}].prefix`,
            message: `Duplicate prefix "${s.prefix}". Each server must have a unique prefix.`,
          });
        }
        prefixes.add(s.prefix);

        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s.prefix)) {
          diags.push({
            level: 'warning',
            field: `servers[${i}].prefix`,
            message: `Prefix "${s.prefix}" contains special characters. Recommended: alphanumeric, hyphens, underscores.`,
          });
        }
      }

      if (!s.serverCommand && !s.remoteUrl) {
        diags.push({
          level: 'error',
          field: `servers[${i}]`,
          message: `Server "${s.prefix || i}" has no serverCommand or remoteUrl.`,
        });
      }
      if (s.serverCommand && s.remoteUrl) {
        diags.push({
          level: 'error',
          field: `servers[${i}]`,
          message: `Server "${s.prefix || i}" has both serverCommand and remoteUrl. Use one.`,
        });
      }
    }
  }

  // ─── Port validation ────────────────────────────────────────────────────
  if (config.port !== undefined) {
    if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
      diags.push({
        level: 'error',
        field: 'port',
        message: `Invalid port ${config.port}. Must be 0–65535.`,
      });
    }
  }

  // ─── Numeric field validation ──────────────────────────────────────────
  if (config.defaultCreditsPerCall !== undefined) {
    if (!Number.isFinite(config.defaultCreditsPerCall) || config.defaultCreditsPerCall < 0) {
      diags.push({
        level: 'error',
        field: 'defaultCreditsPerCall',
        message: `Invalid defaultCreditsPerCall: ${config.defaultCreditsPerCall}. Must be >= 0.`,
      });
    }
  }

  if (config.globalRateLimitPerMin !== undefined) {
    if (!Number.isFinite(config.globalRateLimitPerMin) || config.globalRateLimitPerMin < 0) {
      diags.push({
        level: 'error',
        field: 'globalRateLimitPerMin',
        message: `Invalid globalRateLimitPerMin: ${config.globalRateLimitPerMin}. Must be >= 0.`,
      });
    }
  }

  if (config.webhookMaxRetries !== undefined) {
    if (!Number.isInteger(config.webhookMaxRetries) || config.webhookMaxRetries < 0) {
      diags.push({
        level: 'error',
        field: 'webhookMaxRetries',
        message: `Invalid webhookMaxRetries: ${config.webhookMaxRetries}. Must be a non-negative integer.`,
      });
    }
  }

  // ─── Webhook validation ────────────────────────────────────────────────
  if (config.webhookSecret && !config.webhookUrl) {
    diags.push({
      level: 'warning',
      field: 'webhookSecret',
      message: 'webhookSecret is set but webhookUrl is not. Secret will be ignored.',
    });
  }

  if (config.webhookUrl) {
    try {
      new URL(config.webhookUrl);
      // SSRF protection: warn if webhook URL targets private/internal network
      const ssrfError = checkSsrf(config.webhookUrl);
      if (ssrfError) {
        diags.push({
          level: 'warning',
          field: 'webhookUrl',
          message: `webhookUrl targets a private/internal address (${ssrfError}). Webhook delivery will be blocked by SSRF protection.`,
        });
      }
    } catch {
      diags.push({
        level: 'error',
        field: 'webhookUrl',
        message: `Invalid webhookUrl: "${config.webhookUrl}". Must be a valid URL.`,
      });
    }
  }

  // ─── Redis URL validation ──────────────────────────────────────────────
  if (config.redisUrl) {
    try {
      const url = new URL(config.redisUrl);
      if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
        diags.push({
          level: 'error',
          field: 'redisUrl',
          message: `Invalid redisUrl protocol "${url.protocol}". Expected "redis://" or "rediss://".`,
        });
      }
    } catch {
      diags.push({
        level: 'error',
        field: 'redisUrl',
        message: `Invalid redisUrl: "${config.redisUrl}". Must be a valid redis:// URL.`,
      });
    }
  }

  // ─── Tool pricing validation ───────────────────────────────────────────
  if (config.toolPricing) {
    for (const [tool, pricing] of Object.entries(config.toolPricing)) {
      if (pricing.creditsPerCall !== undefined && (!Number.isFinite(pricing.creditsPerCall) || pricing.creditsPerCall < 0)) {
        diags.push({
          level: 'error',
          field: `toolPricing.${tool}.creditsPerCall`,
          message: `Invalid creditsPerCall for "${tool}": ${pricing.creditsPerCall}. Must be >= 0.`,
        });
      }
      if (pricing.rateLimitPerMin !== undefined && (!Number.isFinite(pricing.rateLimitPerMin) || pricing.rateLimitPerMin < 0)) {
        diags.push({
          level: 'error',
          field: `toolPricing.${tool}.rateLimitPerMin`,
          message: `Invalid rateLimitPerMin for "${tool}": ${pricing.rateLimitPerMin}. Must be >= 0.`,
        });
      }
    }
  }

  // ─── Quota validation ──────────────────────────────────────────────────
  if (config.globalQuota) {
    const q = config.globalQuota;
    for (const field of ['dailyCallLimit', 'monthlyCallLimit', 'dailyCreditLimit', 'monthlyCreditLimit'] as const) {
      const val = q[field];
      if (val !== undefined && (!Number.isFinite(val) || val < 0)) {
        diags.push({
          level: 'error',
          field: `globalQuota.${field}`,
          message: `Invalid ${field}: ${val}. Must be >= 0.`,
        });
      }
    }
  }

  // ─── Import keys validation ────────────────────────────────────────────
  if (config.importKeys) {
    for (const [key, credits] of Object.entries(config.importKeys)) {
      if (!Number.isFinite(credits) || credits < 0) {
        diags.push({
          level: 'error',
          field: `importKeys.${key}`,
          message: `Invalid credits for imported key "${key}": ${credits}. Must be >= 0.`,
        });
      }
    }
  }

  // ─── OAuth validation ─────────────────────────────────────────────────
  if (config.oauth) {
    if (config.oauth.accessTokenTtl !== undefined) {
      if (!Number.isFinite(config.oauth.accessTokenTtl) || config.oauth.accessTokenTtl <= 0) {
        diags.push({
          level: 'error',
          field: 'oauth.accessTokenTtl',
          message: `Invalid accessTokenTtl: ${config.oauth.accessTokenTtl}. Must be > 0.`,
        });
      }
    }
    if (config.oauth.refreshTokenTtl !== undefined) {
      if (!Number.isFinite(config.oauth.refreshTokenTtl) || config.oauth.refreshTokenTtl <= 0) {
        diags.push({
          level: 'error',
          field: 'oauth.refreshTokenTtl',
          message: `Invalid refreshTokenTtl: ${config.oauth.refreshTokenTtl}. Must be > 0.`,
        });
      }
    }
  }

  // ─── Warnings ──────────────────────────────────────────────────────────
  if (config.shadowMode) {
    diags.push({
      level: 'warning',
      field: 'shadowMode',
      message: 'Shadow mode is enabled. Payment will not be enforced.',
    });
  }

  if (config.stateFile && config.redisUrl) {
    diags.push({
      level: 'warning',
      field: 'stateFile + redisUrl',
      message: 'Both stateFile and redisUrl are configured. Redis is the source of truth; stateFile is redundant.',
    });
  }

  if (config.remoteUrl) {
    try {
      const url = new URL(config.remoteUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        diags.push({
          level: 'error',
          field: 'remoteUrl',
          message: `Invalid remoteUrl protocol "${url.protocol}". Expected "http://" or "https://".`,
        });
      }
    } catch {
      diags.push({
        level: 'error',
        field: 'remoteUrl',
        message: `Invalid remoteUrl: "${config.remoteUrl}". Must be a valid URL.`,
        });
    }
  }

  return diags;
}

/**
 * Format diagnostics for human-readable console output.
 */
export function formatDiagnostics(diags: ConfigDiagnostic[]): string {
  if (diags.length === 0) return '✓ Config is valid.';

  const errors = diags.filter(d => d.level === 'error');
  const warnings = diags.filter(d => d.level === 'warning');
  const lines: string[] = [];

  if (errors.length > 0) {
    lines.push(`✗ ${errors.length} error(s):`);
    for (const e of errors) {
      lines.push(`  ERROR  [${e.field}] ${e.message}`);
    }
  }
  if (warnings.length > 0) {
    lines.push(`⚠ ${warnings.length} warning(s):`);
    for (const w of warnings) {
      lines.push(`  WARN   [${w.field}] ${w.message}`);
    }
  }

  return lines.join('\n');
}
