/**
 * Webhook — Fire-and-forget HTTP POST of events to an external URL.
 *
 * Events are batched (max 10, flush every 5s) to reduce overhead.
 * Failed deliveries are retried once, then dropped (no queue bloat).
 *
 * Supports:
 *   - Usage events (tool calls, denials)
 *   - Admin lifecycle events (key.created, key.revoked, key.rotated, key.topup)
 *   - HMAC-SHA256 signatures for payload verification (X-PayGate-Signature header)
 */

import { createHmac } from 'crypto';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { UsageEvent } from './types';

// ─── Admin Lifecycle Events ─────────────────────────────────────────────────

export interface WebhookAdminEvent {
  type: 'key.created' | 'key.revoked' | 'key.rotated' | 'key.topup' | 'key.expired' | 'alert.fired';
  timestamp: string;
  actor: string;
  metadata: Record<string, unknown>;
}

export type WebhookEvent = UsageEvent | WebhookAdminEvent;

function isAdminEvent(event: WebhookEvent): event is WebhookAdminEvent {
  return 'type' in event && typeof (event as WebhookAdminEvent).type === 'string';
}

// ─── WebhookEmitter Class ───────────────────────────────────────────────────

export class WebhookEmitter {
  private readonly url: string;
  private readonly secret: string | null;
  private readonly isHttps: boolean;
  private buffer: WebhookEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;

  constructor(url: string, options?: {
    secret?: string | null;
    batchSize?: number;
    flushIntervalMs?: number;
  }) {
    this.url = url;
    this.secret = options?.secret || null;
    this.isHttps = url.startsWith('https://');
    this.batchSize = options?.batchSize || 10;
    this.flushIntervalMs = options?.flushIntervalMs || 5000;

    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    if (this.timer.unref) this.timer.unref(); // Don't block process exit
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
    this.send(batch, 1);
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

  private send(events: WebhookEvent[], retriesLeft: number): void {
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
      // Invalid URL — drop silently (don't crash the server)
      return;
    }

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
      if (res.statusCode && res.statusCode >= 400 && retriesLeft > 0) {
        setTimeout(() => this.send(events, retriesLeft - 1), 2000);
      }
    });

    req.on('error', () => {
      if (retriesLeft > 0) {
        setTimeout(() => this.send(events, retriesLeft - 1), 2000);
      }
    });

    req.on('timeout', () => {
      req.destroy();
    });

    req.write(body);
    req.end();
  }

  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush(); // Send remaining events
  }
}
