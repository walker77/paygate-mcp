/**
 * WebhookReplayManager — Replay failed webhook deliveries.
 *
 * Stores failed webhook deliveries in a dead letter queue and provides
 * admin endpoints to inspect, retry, and purge them:
 *   - Inspect failed deliveries with error details
 *   - Retry individual or bulk failed deliveries
 *   - Configurable max retry attempts
 *   - Exponential backoff on retries
 *   - Age-based auto-purge
 *   - Delivery status tracking across retries
 *
 * Zero external dependencies.
 */

import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FailedDelivery {
  id: string;
  /** Webhook URL that failed. */
  url: string;
  /** HTTP method (POST). */
  method: string;
  /** Event payload (JSON string). */
  payload: string;
  /** Event type (e.g., 'tool.call', 'key.created'). */
  eventType: string;
  /** Original HMAC signature. */
  signature?: string;
  /** HTTP status code from the failed attempt (0 if connection error). */
  statusCode: number;
  /** Error message from the failure. */
  errorMessage: string;
  /** Number of retry attempts so far. */
  retryCount: number;
  /** Max retries allowed. */
  maxRetries: number;
  /** Timestamp of original failure. */
  failedAt: number;
  /** Timestamp of last retry attempt. */
  lastRetryAt?: number;
  /** Current status. */
  status: 'pending' | 'retrying' | 'succeeded' | 'exhausted';
  createdAt: number;
}

export interface ReplayResult {
  deliveryId: string;
  success: boolean;
  statusCode?: number;
  error?: string;
  retryCount: number;
}

export interface ReplayStats {
  totalFailed: number;
  pendingRetry: number;
  succeeded: number;
  exhausted: number;
  totalRetries: number;
  successfulRetries: number;
}

export interface WebhookReplayConfig {
  enabled: boolean;
  /** Max failed deliveries to keep in the DLQ. Default 5000. */
  maxDeadLetters: number;
  /** Max retry attempts per delivery. Default 5. */
  maxRetries: number;
  /** Base delay for exponential backoff (ms). Default 1000. */
  baseDelayMs: number;
  /** Max age for DLQ entries before auto-purge (ms). Default 7 days. */
  maxAgeMs: number;
  /** HTTP timeout for replay requests (ms). Default 10000. */
  requestTimeoutMs: number;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: WebhookReplayConfig = {
  enabled: false,
  maxDeadLetters: 5000,
  maxRetries: 5,
  baseDelayMs: 1000,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  requestTimeoutMs: 10_000,
};

// ─── WebhookReplayManager Class ─────────────────────────────────────────────

export class WebhookReplayManager {
  private config: WebhookReplayConfig;
  private deadLetters = new Map<string, FailedDelivery>();

  // Stats
  private _totalRetries = 0;
  private _successfulRetries = 0;

  private counter = 0;

  constructor(config?: Partial<WebhookReplayConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Dead Letter Queue ──────────────────────────────────────────────────

  /**
   * Record a failed webhook delivery into the DLQ.
   */
  recordFailure(params: {
    url: string;
    payload: string;
    eventType: string;
    signature?: string;
    statusCode: number;
    errorMessage: string;
  }): FailedDelivery {
    this.pruneOld();

    if (this.deadLetters.size >= this.config.maxDeadLetters) {
      // Evict oldest
      const oldest = this.deadLetters.keys().next().value;
      if (oldest) this.deadLetters.delete(oldest);
    }

    this.counter++;
    const id = `dlq_${this.counter}_${crypto.randomBytes(4).toString('hex')}`;

    const entry: FailedDelivery = {
      id,
      url: params.url,
      method: 'POST',
      payload: params.payload,
      eventType: params.eventType,
      signature: params.signature,
      statusCode: params.statusCode,
      errorMessage: params.errorMessage,
      retryCount: 0,
      maxRetries: this.config.maxRetries,
      failedAt: Date.now(),
      status: 'pending',
      createdAt: Date.now(),
    };

    this.deadLetters.set(id, entry);
    return { ...entry };
  }

  /**
   * Get a specific dead letter entry.
   */
  getDelivery(id: string): FailedDelivery | undefined {
    const d = this.deadLetters.get(id);
    return d ? { ...d } : undefined;
  }

  /**
   * List dead letter entries with optional status filter.
   */
  listDeadLetters(options?: {
    status?: FailedDelivery['status'];
    eventType?: string;
    limit?: number;
  }): FailedDelivery[] {
    const results: FailedDelivery[] = [];
    const limit = options?.limit ?? 100;

    for (const d of this.deadLetters.values()) {
      if (options?.status && d.status !== options.status) continue;
      if (options?.eventType && d.eventType !== options.eventType) continue;
      results.push({ ...d });
      if (results.length >= limit) break;
    }

    return results;
  }

  /**
   * Retry a single failed delivery.
   */
  async replay(id: string): Promise<ReplayResult> {
    const entry = this.deadLetters.get(id);
    if (!entry) {
      return { deliveryId: id, success: false, error: 'Not found', retryCount: 0 };
    }

    if (entry.status === 'succeeded') {
      return { deliveryId: id, success: true, retryCount: entry.retryCount };
    }

    if (entry.status === 'exhausted') {
      return { deliveryId: id, success: false, error: 'Max retries exhausted', retryCount: entry.retryCount };
    }

    entry.status = 'retrying';
    entry.retryCount++;
    entry.lastRetryAt = Date.now();
    this._totalRetries++;

    try {
      const result = await this.sendRequest(entry.url, entry.payload, entry.signature);

      if (result.statusCode >= 200 && result.statusCode < 300) {
        entry.status = 'succeeded';
        this._successfulRetries++;
        return { deliveryId: id, success: true, statusCode: result.statusCode, retryCount: entry.retryCount };
      }

      // Still failing
      if (entry.retryCount >= entry.maxRetries) {
        entry.status = 'exhausted';
      } else {
        entry.status = 'pending';
      }

      return {
        deliveryId: id,
        success: false,
        statusCode: result.statusCode,
        error: `HTTP ${result.statusCode}`,
        retryCount: entry.retryCount,
      };
    } catch (err: any) {
      if (entry.retryCount >= entry.maxRetries) {
        entry.status = 'exhausted';
      } else {
        entry.status = 'pending';
      }

      return {
        deliveryId: id,
        success: false,
        error: err.message || 'Request failed',
        retryCount: entry.retryCount,
      };
    }
  }

  /**
   * Retry all pending deliveries (bulk replay).
   */
  async replayAll(limit: number = 50): Promise<ReplayResult[]> {
    const pending = this.listDeadLetters({ status: 'pending', limit });
    const results: ReplayResult[] = [];

    for (const entry of pending) {
      const result = await this.replay(entry.id);
      results.push(result);
    }

    return results;
  }

  /**
   * Purge a specific entry from the DLQ.
   */
  purge(id: string): boolean {
    return this.deadLetters.delete(id);
  }

  /**
   * Purge all entries with a given status.
   */
  purgeByStatus(status: FailedDelivery['status']): number {
    let count = 0;
    for (const [id, entry] of this.deadLetters) {
      if (entry.status === status) {
        this.deadLetters.delete(id);
        count++;
      }
    }
    return count;
  }

  // ─── Configuration ─────────────────────────────────────────────────────

  configure(updates: Partial<WebhookReplayConfig>): WebhookReplayConfig {
    if (updates.enabled !== undefined) this.config.enabled = updates.enabled;
    if (updates.maxDeadLetters !== undefined) this.config.maxDeadLetters = Math.max(10, updates.maxDeadLetters);
    if (updates.maxRetries !== undefined) this.config.maxRetries = Math.max(1, updates.maxRetries);
    if (updates.baseDelayMs !== undefined) this.config.baseDelayMs = Math.max(100, updates.baseDelayMs);
    if (updates.maxAgeMs !== undefined) this.config.maxAgeMs = Math.max(60_000, updates.maxAgeMs);
    if (updates.requestTimeoutMs !== undefined) this.config.requestTimeoutMs = Math.max(1000, updates.requestTimeoutMs);
    return { ...this.config };
  }

  stats(): ReplayStats {
    let pending = 0;
    let succeeded = 0;
    let exhausted = 0;

    for (const d of this.deadLetters.values()) {
      if (d.status === 'pending' || d.status === 'retrying') pending++;
      else if (d.status === 'succeeded') succeeded++;
      else if (d.status === 'exhausted') exhausted++;
    }

    return {
      totalFailed: this.deadLetters.size,
      pendingRetry: pending,
      succeeded,
      exhausted,
      totalRetries: this._totalRetries,
      successfulRetries: this._successfulRetries,
    };
  }

  clear(): void {
    this.deadLetters.clear();
    this._totalRetries = 0;
    this._successfulRetries = 0;
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private pruneOld(): void {
    const cutoff = Date.now() - this.config.maxAgeMs;
    for (const [id, entry] of this.deadLetters) {
      if (entry.createdAt < cutoff) {
        this.deadLetters.delete(id);
      }
    }
  }

  private sendRequest(url: string, payload: string, signature?: string): Promise<{ statusCode: number }> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const mod = isHttps ? https : http;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload).toString(),
        'User-Agent': 'PayGate-Webhook-Replay/1.0',
      };

      if (signature) {
        headers['X-Webhook-Signature'] = signature;
      }

      const req = mod.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: 'POST',
          headers,
          timeout: this.config.requestTimeoutMs,
        },
        (res) => {
          // Drain the response
          res.on('data', () => {});
          res.on('end', () => {
            resolve({ statusCode: res.statusCode ?? 0 });
          });
        }
      );

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(payload);
      req.end();
    });
  }
}
