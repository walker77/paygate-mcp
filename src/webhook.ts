/**
 * Webhook — Fire-and-forget HTTP POST of usage events to an external URL.
 *
 * Events are batched (max 10, flush every 5s) to reduce overhead.
 * Failed deliveries are retried once, then dropped (no queue bloat).
 */

import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { UsageEvent } from './types';

export class WebhookEmitter {
  private readonly url: string;
  private readonly isHttps: boolean;
  private buffer: UsageEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;

  constructor(url: string, batchSize = 10, flushIntervalMs = 5000) {
    this.url = url;
    this.isHttps = url.startsWith('https://');
    this.batchSize = batchSize;
    this.flushIntervalMs = flushIntervalMs;

    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    if (this.timer.unref) this.timer.unref(); // Don't block process exit
  }

  emit(event: UsageEvent): void {
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

  private send(events: UsageEvent[], retriesLeft: number): void {
    const body = JSON.stringify({ events, sentAt: new Date().toISOString() });
    let parsed: URL;
    try {
      parsed = new URL(this.url);
    } catch {
      // Invalid URL — drop silently (don't crash the server)
      return;
    }
    const reqFn = this.isHttps ? httpsRequest : httpRequest;

    const req = reqFn({
      hostname: parsed.hostname,
      port: parsed.port || (this.isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'paygate-mcp-webhook/1.0',
      },
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
