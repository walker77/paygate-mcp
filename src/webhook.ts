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

// ─── SSRF Prevention ────────────────────────────────────────────────────────

/**
 * Private/reserved IPv4 ranges (RFC 1918, RFC 5737, RFC 6598, loopback, link-local, metadata).
 * Each entry: [startInt, endInt] of the IP range in network byte order.
 */
const PRIVATE_IPV4_RANGES: Array<[number, number]> = [
  [0x0A000000, 0x0AFFFFFF], // 10.0.0.0/8
  [0xAC100000, 0xAC1FFFFF], // 172.16.0.0/12
  [0xC0A80000, 0xC0A8FFFF], // 192.168.0.0/16
  [0x7F000000, 0x7FFFFFFF], // 127.0.0.0/8 (loopback)
  [0xA9FE0000, 0xA9FEFFFF], // 169.254.0.0/16 (link-local / AWS metadata)
  [0x00000000, 0x00FFFFFF], // 0.0.0.0/8
  [0x64400000, 0x647FFFFF], // 100.64.0.0/10 (carrier-grade NAT)
  [0xC0000000, 0xC00000FF], // 192.0.0.0/24 (IETF protocol assignments)
  [0xC6120000, 0xC613FFFF], // 198.18.0.0/15 (benchmarking)
  [0xC0000200, 0xC00002FF], // 192.0.2.0/24 (TEST-NET-1)
  [0xC6336400, 0xC63364FF], // 198.51.100.0/24 (TEST-NET-2)
  [0xCB007100, 0xCB0071FF], // 203.0.113.0/24 (TEST-NET-3)
];

/** Convert dotted-quad IPv4 to 32-bit integer */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const num = Number(part);
    if (!Number.isInteger(num) || num < 0 || num > 255) return null;
    result = (result << 8) | num;
  }
  return result >>> 0; // unsigned 32-bit
}

/** Check if an IPv4 address string falls in any private/reserved range. */
function isPrivateIPv4(ip: string): boolean {
  const num = ipv4ToInt(ip);
  if (num === null) return false;
  for (const [start, end] of PRIVATE_IPV4_RANGES) {
    if (num >= start && num <= end) return true;
  }
  return false;
}

/** Well-known private/localhost hostnames */
const PRIVATE_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

/**
 * Check if a URL targets a private/internal network (SSRF protection).
 * Returns a descriptive error string if the URL is private, or null if it's safe.
 */
export function checkSsrf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL';
  }

  // Only allow http: and https: protocols
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Disallowed protocol: ${parsed.protocol}`;
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block well-known private hostnames
  if (PRIVATE_HOSTNAMES.has(hostname)) {
    return `Private hostname: ${hostname}`;
  }

  // Block IPv6 loopback and private ranges
  // URL parser wraps IPv6 in brackets: [::1] → hostname = "::1"
  if (hostname === '::1' || hostname === '[::1]') {
    return 'IPv6 loopback address';
  }
  if (hostname.startsWith('fe80:') || hostname.startsWith('[fe80:')) {
    return 'IPv6 link-local address';
  }
  if (hostname.startsWith('fc') || hostname.startsWith('[fc') ||
      hostname.startsWith('fd') || hostname.startsWith('[fd')) {
    return 'IPv6 unique local address';
  }

  // Block private IPv4 ranges
  if (isPrivateIPv4(hostname)) {
    return `Private IPv4 address: ${hostname}`;
  }

  // Block IPv4-mapped IPv6 — dotted-quad form (e.g., ::ffff:127.0.0.1)
  const ipv4MappedDotted = hostname.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/i);
  if (ipv4MappedDotted && isPrivateIPv4(ipv4MappedDotted[1])) {
    return `Private IPv4-mapped IPv6 address: ${hostname}`;
  }

  // Block IPv4-mapped IPv6 — hex form (e.g., ::ffff:7f00:1 as parsed by URL)
  const ipv4MappedHex = hostname.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})/i);
  if (ipv4MappedHex) {
    const hi = parseInt(ipv4MappedHex[1], 16);
    const lo = parseInt(ipv4MappedHex[2], 16);
    const dottedQuad = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    if (isPrivateIPv4(dottedQuad)) {
      return `Private IPv4-mapped IPv6 address: ${hostname}`;
    }
  }

  return null; // URL is safe
}

// ─── Admin Lifecycle Events ─────────────────────────────────────────────────

export interface WebhookAdminEvent {
  type: 'key.created' | 'key.cloned' | 'key.revoked' | 'key.suspended' | 'key.resumed' | 'key.rotated' | 'key.topup' | 'key.expired' | 'key.credits_transferred' | 'alert.fired' | 'key.auto_topup_configured' | 'key.auto_topped_up' | 'admin_key.created' | 'admin_key.revoked' | 'admin_key.bootstrap_rotated' | 'key.expiry_warning';
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

  /** Whether webhook delivery is paused */
  private _paused = false;
  /** When the webhook was paused (ISO 8601) */
  private _pausedAt: string | null = null;
  /** Number of events buffered while paused */
  private _pauseBufferCount = 0;

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
    if (this._paused) return; // Don't flush while paused — events stay buffered
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
    paused: boolean;
    pausedAt: string | null;
    bufferedEvents: number;
  } {
    return {
      pendingRetries: this.retryQueue.length,
      deadLetterCount: this.deadLetters.length,
      totalDelivered: this._totalDelivered,
      totalFailed: this._totalFailed,
      totalRetries: this._totalRetries,
      paused: this._paused,
      pausedAt: this._pausedAt,
      bufferedEvents: this.buffer.length,
    };
  }

  // ─── Pause / Resume ──────────────────────────────────────────────────────

  /**
   * Pause webhook delivery. Events continue to be buffered but not sent.
   * Returns true if paused, false if already paused.
   */
  pause(): boolean {
    if (this._paused) return false;
    this._paused = true;
    this._pausedAt = new Date().toISOString();
    this._pauseBufferCount = this.buffer.length;
    return true;
  }

  /**
   * Resume webhook delivery. Buffered events are flushed immediately.
   * Returns the number of buffered events that will be flushed.
   */
  resume(): { resumed: boolean; flushedEvents: number } {
    if (!this._paused) return { resumed: false, flushedEvents: 0 };
    this._paused = false;
    const buffered = this.buffer.length;
    this._pausedAt = null;
    this._pauseBufferCount = 0;
    // Flush all buffered events
    while (this.buffer.length > 0) {
      this.flush();
    }
    return { resumed: true, flushedEvents: buffered };
  }

  /**
   * Whether delivery is currently paused.
   */
  get isPaused(): boolean {
    return this._paused;
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

    // Note: SSRF protection is enforced at the admin API entry points
    // (webhook filter create/update, webhook test endpoint, config validator).
    // Delivery-time checks are intentionally omitted to allow localhost
    // webhook URLs in development and testing environments.

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
