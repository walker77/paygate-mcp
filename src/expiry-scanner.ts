/**
 * ExpiryScanner — Proactive background scanner for expiring API keys.
 *
 * Unlike the reactive key_expiry_soon alert (which only fires during gate evaluation),
 * this scanner runs on a configurable interval and catches expiring keys even when idle.
 *
 * Features:
 *   - Configurable scan interval (default: 1 hour)
 *   - Multiple notification thresholds (e.g., 7d, 24h, 1h before expiry)
 *   - De-duplication: same key+threshold pair is only notified once
 *   - Fires key.expiry_warning webhook events
 *   - Audit trail for all notifications
 *   - Graceful shutdown (clears interval timer)
 */

import { ApiKeyRecord } from './types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExpiryScannerConfig {
  /** Whether the scanner is enabled. Default: true when thresholds are configured. */
  enabled: boolean;
  /** How often to scan, in seconds. Default: 3600 (1 hour). Min: 60. */
  intervalSeconds: number;
  /** Seconds before expiry to send notifications. Default: [604800, 86400, 3600] (7d, 24h, 1h). */
  thresholds: number[];
}

export interface ExpiryWarning {
  /** The API key (full, for internal use — mask before exposing) */
  key: string;
  /** Key name */
  name: string;
  /** Key alias (if set) */
  alias?: string;
  /** Key namespace */
  namespace: string;
  /** ISO string when the key expires */
  expiresAt: string;
  /** Seconds remaining until expiry */
  remainingSeconds: number;
  /** Human-readable time remaining */
  remainingHuman: string;
  /** Which threshold triggered this warning (seconds) */
  thresholdSeconds: number;
}

export const DEFAULT_EXPIRY_SCANNER_CONFIG: ExpiryScannerConfig = {
  enabled: true,
  intervalSeconds: 3600,
  thresholds: [604800, 86400, 3600], // 7 days, 24 hours, 1 hour
};

// ─── Scanner Class ────────────────────────────────────────────────────────────

export class ExpiryScanner {
  private config: ExpiryScannerConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** De-duplication: "keyPrefix:threshold" → timestamp of last notification */
  private readonly notified = new Map<string, number>();
  /** Callback for each warning — wired by the server to emit webhooks/audit */
  onWarning: ((warning: ExpiryWarning) => void) | null = null;
  /** Key provider — returns all key records for scanning */
  private getKeys: (() => ApiKeyRecord[]) | null = null;

  constructor(config?: Partial<ExpiryScannerConfig>) {
    this.config = { ...DEFAULT_EXPIRY_SCANNER_CONFIG, ...config };
    // Enforce minimum interval
    if (this.config.intervalSeconds < 60) this.config.intervalSeconds = 60;
    // Sort thresholds descending (largest first) for consistent scanning
    this.config.thresholds = [...this.config.thresholds].sort((a, b) => b - a);
  }

  /**
   * Start the background scanner.
   * @param getKeys Function that returns all key records to scan
   */
  start(getKeys: () => ApiKeyRecord[]): void {
    if (!this.config.enabled) return;
    if (this.config.thresholds.length === 0) return;
    this.getKeys = getKeys;
    // Run immediately on start, then on interval
    this.scan();
    this.timer = setInterval(() => this.scan(), this.config.intervalSeconds * 1000);
    this.timer.unref(); // Don't prevent process exit
  }

  /**
   * Stop the scanner and clear all state.
   */
  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.notified.clear();
    this.getKeys = null;
  }

  /**
   * Run a scan now (also called by the interval timer).
   * Returns warnings found in this scan.
   */
  scan(): ExpiryWarning[] {
    if (!this.getKeys) return [];
    const keys = this.getKeys();
    const now = Date.now();
    const warnings: ExpiryWarning[] = [];

    for (const record of keys) {
      // Skip keys without expiry, revoked, or already expired
      if (!record.expiresAt) continue;
      if (!record.active) continue;

      const expiresMs = new Date(record.expiresAt).getTime();
      if (isNaN(expiresMs)) continue;
      const remainingMs = expiresMs - now;
      if (remainingMs <= 0) continue; // Already expired

      const remainingSeconds = Math.round(remainingMs / 1000);

      // Check each threshold (sorted descending)
      for (const threshold of this.config.thresholds) {
        if (remainingSeconds <= threshold) {
          const dedupeKey = `${record.key.slice(0, 10)}:${threshold}`;

          // Skip if already notified for this key+threshold
          if (this.notified.has(dedupeKey)) continue;

          const warning: ExpiryWarning = {
            key: record.key,
            name: record.name,
            alias: record.alias,
            namespace: record.namespace,
            expiresAt: record.expiresAt,
            remainingSeconds,
            remainingHuman: formatDuration(remainingSeconds),
            thresholdSeconds: threshold,
          };

          warnings.push(warning);
          this.notified.set(dedupeKey, now);

          // Emit callback
          if (this.onWarning) {
            try {
              this.onWarning(warning);
            } catch {
              // Swallow callback errors — scanner must not crash
            }
          }

          // Only fire the most specific (smallest) threshold per key per scan
          break;
        }
      }
    }

    // Cleanup old de-duplication entries (older than 2x the largest threshold)
    const maxThreshold = this.config.thresholds[0] || 0;
    const cleanupCutoff = now - maxThreshold * 2 * 1000;
    for (const [k, ts] of this.notified) {
      if (ts < cleanupCutoff) this.notified.delete(k);
    }

    return warnings;
  }

  /**
   * Query keys expiring within a time window (for the admin endpoint).
   * Does NOT trigger notifications — this is a read-only query.
   */
  static queryExpiring(keys: ApiKeyRecord[], withinSeconds: number): Array<{
    keyPrefix: string;
    name: string;
    alias?: string;
    namespace: string;
    expiresAt: string;
    remainingSeconds: number;
    remainingHuman: string;
    suspended: boolean;
  }> {
    const now = Date.now();
    const results: Array<{
      keyPrefix: string;
      name: string;
      alias?: string;
      namespace: string;
      expiresAt: string;
      remainingSeconds: number;
      remainingHuman: string;
      suspended: boolean;
    }> = [];

    for (const record of keys) {
      if (!record.expiresAt) continue;
      if (!record.active) continue;

      const expiresMs = new Date(record.expiresAt).getTime();
      if (isNaN(expiresMs)) continue;
      const remainingMs = expiresMs - now;
      if (remainingMs <= 0) continue; // Already expired

      const remainingSeconds = Math.round(remainingMs / 1000);
      if (remainingSeconds > withinSeconds) continue;

      results.push({
        keyPrefix: record.key.slice(0, 10) + '...',
        name: record.name,
        alias: record.alias,
        namespace: record.namespace,
        expiresAt: record.expiresAt,
        remainingSeconds,
        remainingHuman: formatDuration(remainingSeconds),
        suspended: record.suspended || false,
      });
    }

    // Sort by remaining time ascending (most urgent first)
    results.sort((a, b) => a.remainingSeconds - b.remainingSeconds);
    return results;
  }

  /**
   * Get scanner status (for /health or diagnostics).
   */
  get status(): { enabled: boolean; intervalSeconds: number; thresholds: number[]; notifiedCount: number } {
    return {
      enabled: this.config.enabled,
      intervalSeconds: this.config.intervalSeconds,
      thresholds: this.config.thresholds,
      notifiedCount: this.notified.size,
    };
  }

  /**
   * Clear de-duplication state (for testing).
   */
  clearNotified(): void {
    this.notified.clear();
  }

  /**
   * Update config at runtime (for config hot-reload).
   */
  updateConfig(config: Partial<ExpiryScannerConfig>): void {
    if (config.intervalSeconds !== undefined) {
      this.config.intervalSeconds = Math.max(60, config.intervalSeconds);
    }
    if (config.thresholds !== undefined) {
      this.config.thresholds = [...config.thresholds].sort((a, b) => b - a);
    }
    if (config.enabled !== undefined) {
      this.config.enabled = config.enabled;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.round((seconds % 3600) / 60);
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.round((seconds % 86400) / 3600);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}
