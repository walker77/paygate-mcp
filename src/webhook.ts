/**
 * Webhook — Fire-and-forget HTTP POST of events to an external URL.
 *
 * Events are batched (max 10, flush every 5s) to reduce overhead.
 * Failed deliveries are retried with exponential backoff (1s, 2s, 4s, 8s, 16s).
 * After maxRetries exhausted, events move to a dead-letter queue for inspection.
 *
 * Supports:
 *   - Usage events (tool calls, denials)
 *   - Admin lifecycle events (key.created, key.revoked, key.rotated, key.topup)
 *   - HMAC-SHA256 signatures for payload verification (X-PayGate-Signature header)
 *   - Exponential backoff retry queue with configurable max retries
 *   - Dead-letter queue for permanently failed deliveries (max 1000 entries)
 */

import { createHmac } from 'crypto';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { UsageEvent } from './types';

// ─── Admin Lifecycle Events ─────────────────────────────────────────────────

export interface WebhookAdminEvent {
  type: 'key.created' | 'key.cloned' | 'key.revoked' | 'key.suspended' | 'key.resumed' | 'key.rotated' | 'key.topup' | 'key.expired' | 'key.credits_transferred' | 'alert.fired' | 'key.auto_topup_configured' | 'key.auto_topped_up' | 'admin_key.created' | 'admin_key.revoked';
  timestamp: string;
  actor: string;
  metadata: Record<string, unknown>;
}

export type WebhookEvent = UsageEvent | WebhookAdminEvent;

function isAdminEvent(event: WebhookEvent): event is WebhookAdminEvent {
  return 'type' in event && typeof (event as WebhookAdminEvent).type === 'string';
}

// ─── Dead Letter Entry ──────────────────────────────────────────────────────

export interface DeadLetterEntry {
  /** Events that permanently failed */
  events: WebhookEvent[];
  /** Number of attempts made */
  attempts: number;
  /** Last error message or HTTP status */
  lastError: string;
  /** When the first attempt was made */
  firstAttempt: string;
  /** When the last attempt was made */
  lastAttempt: string;
  /** Target webhook URL */
  url: string;
}

// ─── Delivery Log Entry ──────────────────────────────────────────────────────

export interface DeliveryLogEntry {
  /** Auto-incrementing ID */
  id: number;
  /** When the delivery attempt was made */
  timestamp: string;
  /** Target webhook URL (credentials masked) */
  url: string;
  /** HTTP status code (0 for connection errors) */
  statusCode: number;
  /** Whether the delivery was successful (2xx) */
  success: boolean;
  /** Round-trip time in milliseconds */
  responseTime: number;
  /** Retry attempt number (0 = first attempt) */
  attempt: number;
  /** Error message (only on failure) */
  error?: string;
  /** Number of events in the batch */
  eventCount: number;
  /** Distinct event types in the batch */
  eventTypes: string[];
}

// ─── Retry Queue Entry ─────────────────────────────────────────────────────

interface RetryEntry {
  events: WebhookEvent[];
  attempt: number;
  nextRetryAt: number;
  firstAttempt: string;
  lastError: string;
}

// ─── WebhookEmitter Class ───────────────────────────────────────────────────

export class WebhookEmitter {
  private readonly url: string;
  private readonly secret: string | null;
  private readonly isHttps: boolean;
  private buffer: WebhookEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  readonly maxRetries: number;
  private readonly baseDelayMs: number;

  /** Entries waiting for retry with exponential backoff */
  private retryQueue: RetryEntry[] = [];

  /** Permanently failed deliveries (capped at maxDeadLetters) */
  private deadLetters: DeadLetterEntry[] = [];
  private readonly maxDeadLetters: number;

  /** Counts for monitoring */
  private _totalDelivered = 0;
  private _totalFailed = 0;
  private _totalRetries = 0;

  /** Delivery log (capped at maxDeliveryLog entries, newest last) */
  private deliveryLog: DeliveryLogEntry[] = [];
  private readonly maxDeliveryLog: number;
  private _deliveryLogSeq = 0;

  constructor(url: string, options?: {
    secret?: string | null;
    batchSize?: number;
    flushIntervalMs?: number;
    maxRetries?: number;
    baseDelayMs?: number;
    maxDeadLetters?: number;
    maxDeliveryLog?: number;
  }) {
    this.url = url;
    this.secret = options?.secret || null;
    this.isHttps = url.startsWith('https://');
    this.batchSize = options?.batchSize || 10;
    this.flushIntervalMs = options?.flushIntervalMs || 5000;
    this.maxRetries = options?.maxRetries ?? 5;
    this.baseDelayMs = options?.baseDelayMs ?? 1000;
    this.maxDeadLetters = options?.maxDeadLetters ?? 1000;
    this.maxDeliveryLog = options?.maxDeliveryLog ?? 500;

    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    if (this.timer.unref) this.timer.unref();

    // Process retry queue every second
    this.retryTimer = setInterval(() => this.processRetryQueue(), 1000);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }

  /**
   * Emit a usage event (tool call / denial).
   */
  emit(event: UsageEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= this.batchSize) {
      this.flush();
    }
  }

  /**
   * Emit an admin lifecycle event (key.created, key.revoked, etc.).
   */
  emitAdmin(type: WebhookAdminEvent['type'], actor: string, metadata: Record<string, unknown> = {}): void {
    const event: WebhookAdminEvent = {
      type,
      timestamp: new Date().toISOString(),
      actor,
      metadata,
    };
    this.buffer.push(event);
    if (this.buffer.length >= this.batchSize) {
      this.flush();
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.batchSize);
    this.send(batch, 0, new Date().toISOString());
  }

  /**
   * Compute HMAC-SHA256 signature for a payload.
   */
  static sign(payload: string, secret: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex');
  }

  /**
   * Verify an HMAC-SHA256 signature.
   */
  static verify(payload: string, signature: string, secret: string): boolean {
    const expected = WebhookEmitter.sign(payload, secret);
    // Constant-time comparison
    if (expected.length !== signature.length) return false;
    let result = 0;
    for (let i = 0; i < expected.length; i++) {
      result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return result === 0;
  }

  // ─── Retry Queue ────────────────────────────────────────────────────────────

  /**
   * Process the retry queue: send any entries whose nextRetryAt has passed.
   */
  private processRetryQueue(): void {
    const now = Date.now();
    const ready: RetryEntry[] = [];
    const remaining: RetryEntry[] = [];

    for (const entry of this.retryQueue) {
      if (entry.nextRetryAt <= now) {
        ready.push(entry);
      } else {
        remaining.push(entry);
      }
    }

    this.retryQueue = remaining;

    for (const entry of ready) {
      this._totalRetries++;
      this.send(entry.events, entry.attempt, entry.firstAttempt, entry.lastError);
    }
  }

  /**
   * Schedule a batch for retry with exponential backoff.
   */
  private scheduleRetry(events: WebhookEvent[], attempt: number, firstAttempt: string, lastError: string): void {
    if (attempt >= this.maxRetries) {
      // Exhausted retries — move to dead letter queue
      this.addDeadLetter(events, attempt, lastError, firstAttempt);
      return;
    }

    const delayMs = this.baseDelayMs * Math.pow(2, attempt);
    this.retryQueue.push({
      events,
      attempt: attempt + 1,
      nextRetryAt: Date.now() + delayMs,
      firstAttempt,
      lastError,
    });
  }

  /**
   * Add a permanently failed delivery to the dead letter queue.
   */
  private addDeadLetter(events: WebhookEvent[], attempts: number, lastError: string, firstAttempt: string): void {
    this._totalFailed++;

    const entry: DeadLetterEntry = {
      events,
      attempts,
      lastError,
      firstAttempt,
      lastAttempt: new Date().toISOString(),
      url: this.url,
    };

    this.deadLetters.push(entry);

    // Cap the dead letter queue size
    if (this.deadLetters.length > this.maxDeadLetters) {
      this.deadLetters = this.deadLetters.slice(-this.maxDeadLetters);
    }
  }

  // ─── Dead Letter API ────────────────────────────────────────────────────────

  /**
   * Get all dead letter entries.
   */
  getDeadLetters(): DeadLetterEntry[] {
    return [...this.deadLetters];
  }

  /**
   * Clear dead letter queue. Returns number of entries cleared.
   */
  clearDeadLetters(): number {
    const count = this.deadLetters.length;
    this.deadLetters = [];
    return count;
  }

  /**
   * Replay dead letter entries by re-queuing them for delivery.
   * Removes replayed entries from the dead letter queue.
   * @param indices - Specific indices to replay. If empty, replay all.
   * @returns Number of entries replayed.
   */
  replayDeadLetters(indices?: number[]): number {
    if (this.deadLetters.length === 0) return 0;

    let toReplay: DeadLetterEntry[];
    if (indices && indices.length > 0) {
      // Deduplicate and validate indices
      const validIndices = [...new Set(indices)].filter(i => i >= 0 && i < this.deadLetters.length);
      toReplay = validIndices.map(i => this.deadLetters[i]);
      // Remove replayed entries (reverse order to preserve indices)
      const sortedIndices = [...validIndices].sort((a, b) => b - a);
      for (const i of sortedIndices) {
        this.deadLetters.splice(i, 1);
      }
    } else {
      // Replay all
      toReplay = [...this.deadLetters];
      this.deadLetters = [];
    }

    // Re-queue each entry for immediate delivery (attempt 0 = fresh start)
    for (const entry of toReplay) {
      this.send(entry.events, 0, new Date().toISOString());
    }

    return toReplay.length;
  }

  /**
   * Get retry queue stats.
   */
  getRetryStats(): {
    pendingRetries: number;
    deadLetterCount: number;
    totalDelivered: number;
    totalFailed: number;
    totalRetries: number;
  } {
    return {
      pendingRetries: this.retryQueue.length,
      deadLetterCount: this.deadLetters.length,
      totalDelivered: this._totalDelivered,
      totalFailed: this._totalFailed,
      totalRetries: this._totalRetries,
    };
  }

  // ─── Delivery Log ──────────────────────────────────────────────────────────

  /**
   * Record a delivery attempt in the log.
   */
  private recordDelivery(entry: Omit<DeliveryLogEntry, 'id'>): void {
    this.deliveryLog.push({
      ...entry,
      id: ++this._deliveryLogSeq,
    });
    // Cap the log size
    if (this.deliveryLog.length > this.maxDeliveryLog) {
      this.deliveryLog = this.deliveryLog.slice(-this.maxDeliveryLog);
    }
  }

  /**
   * Get delivery log entries, newest first.
   * @param options - Filter options
   */
  getDeliveryLog(options?: {
    limit?: number;
    since?: string;
    success?: boolean;
  }): DeliveryLogEntry[] {
    let entries = [...this.deliveryLog];

    // Filter by time
    if (options?.since) {
      entries = entries.filter(e => e.timestamp >= options.since!);
    }

    // Filter by success/failure
    if (options?.success !== undefined) {
      entries = entries.filter(e => e.success === options.success);
    }

    // Newest first
    entries.reverse();

    // Limit
    const limit = Math.min(options?.limit ?? 50, 200);
    return entries.slice(0, limit);
  }

  // ─── Send ──────────────────────────────────────────────────────────────────

  /**
   * Mask credentials in a URL for logging.
   */
  private static maskUrl(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.password) parsed.password = '***';
      if (parsed.username && parsed.username.length > 4) {
        parsed.username = parsed.username.slice(0, 4) + '***';
      }
      return parsed.toString();
    } catch {
      return url;
    }
  }

  /**
   * Extract distinct event types from a batch.
   */
  private static eventTypes(events: WebhookEvent[]): string[] {
    const types = new Set<string>();
    for (const e of events) {
      if (isAdminEvent(e)) {
        types.add(e.type);
      } else {
        types.add('usage');
      }
    }
    return [...types];
  }

  private send(events: WebhookEvent[], attempt: number, firstAttempt: string, previousError?: string): void {
    // Separate events by type for the payload
    const usageEvents: UsageEvent[] = [];
    const adminEvents: WebhookAdminEvent[] = [];
    for (const e of events) {
      if (isAdminEvent(e)) {
        adminEvents.push(e);
      } else {
        usageEvents.push(e);
      }
    }

    const payload: Record<string, unknown> = {
      sentAt: new Date().toISOString(),
    };
    if (usageEvents.length > 0) payload.events = usageEvents;
    if (adminEvents.length > 0) payload.adminEvents = adminEvents;

    const body = JSON.stringify(payload);

    let parsed: URL;
    try {
      parsed = new URL(this.url);
    } catch {
      // Invalid URL — send to dead letter and log
      this.addDeadLetter(events, attempt, 'Invalid webhook URL', firstAttempt);
      this.recordDelivery({
        timestamp: new Date().toISOString(),
        url: WebhookEmitter.maskUrl(this.url),
        statusCode: 0,
        success: false,
        responseTime: 0,
        attempt,
        error: 'Invalid webhook URL',
        eventCount: events.length,
        eventTypes: WebhookEmitter.eventTypes(events),
      });
      return;
    }

    const maskedUrl = WebhookEmitter.maskUrl(this.url);
    const startTime = Date.now();
    const eventTypesArr = WebhookEmitter.eventTypes(events);

    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': 'paygate-mcp-webhook/1.0',
    };

    // Sign the payload if a secret is configured
    if (this.secret) {
      const timestamp = Math.floor(Date.now() / 1000);
      const signaturePayload = `${timestamp}.${body}`;
      const signature = WebhookEmitter.sign(signaturePayload, this.secret);
      headers['X-PayGate-Signature'] = `t=${timestamp},v1=${signature}`;
    }

    // Add retry attempt header for observability
    if (attempt > 0) {
      headers['X-PayGate-Retry'] = attempt;
    }

    const reqFn = this.isHttps ? httpsRequest : httpRequest;

    const req = reqFn({
      hostname: parsed.hostname,
      port: parsed.port || (this.isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers,
      timeout: 10_000,
    }, (res) => {
      // Drain response to free socket
      res.resume();
      const responseTime = Date.now() - startTime;
      if (res.statusCode && res.statusCode >= 400) {
        const errorMsg = `HTTP ${res.statusCode}`;
        this.scheduleRetry(events, attempt, firstAttempt, errorMsg);
        this.recordDelivery({
          timestamp: new Date().toISOString(),
          url: maskedUrl,
          statusCode: res.statusCode,
          success: false,
          responseTime,
          attempt,
          error: errorMsg,
          eventCount: events.length,
          eventTypes: eventTypesArr,
        });
      } else {
        this._totalDelivered++;
        this.recordDelivery({
          timestamp: new Date().toISOString(),
          url: maskedUrl,
          statusCode: res.statusCode || 200,
          success: true,
          responseTime,
          attempt,
          eventCount: events.length,
          eventTypes: eventTypesArr,
        });
      }
    });

    req.on('error', (err: Error) => {
      const errorMsg = err.message || 'Connection error';
      const responseTime = Date.now() - startTime;
      this.scheduleRetry(events, attempt, firstAttempt, errorMsg);
      this.recordDelivery({
        timestamp: new Date().toISOString(),
        url: maskedUrl,
        statusCode: 0,
        success: false,
        responseTime,
        attempt,
        error: errorMsg,
        eventCount: events.length,
        eventTypes: eventTypesArr,
      });
    });

    req.on('timeout', () => {
      req.destroy();
      const responseTime = Date.now() - startTime;
      this.scheduleRetry(events, attempt, firstAttempt, 'Timeout (10s)');
      this.recordDelivery({
        timestamp: new Date().toISOString(),
        url: maskedUrl,
        statusCode: 0,
        success: false,
        responseTime,
        attempt,
        error: 'Timeout (10s)',
        eventCount: events.length,
        eventTypes: eventTypesArr,
      });
    });

    req.write(body);
    req.end();
  }

  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    this.flush(); // Send remaining events
  }
}
