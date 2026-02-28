/**
 * OpenTelemetry Trace Emitter — Zero-dependency OTEL-compatible span export.
 *
 * Emits traces in OTLP JSON format to any OpenTelemetry collector endpoint.
 * No @opentelemetry/* SDK dependency — we build the OTLP payload manually
 * for zero-dep compliance.
 *
 * Features:
 *   - OTLP/HTTP JSON export (POST to /v1/traces)
 *   - Span creation for: gate evaluation, tool call, proxy, transforms
 *   - W3C traceparent header propagation
 *   - Configurable batch export (flush interval, max batch size)
 *   - Resource attributes (service.name, service.version)
 *   - Graceful shutdown with final flush
 *   - Stats tracking
 *
 * Zero external dependencies.
 */

import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OtelConfig {
  /** Enable trace emission. Default: false. */
  enabled: boolean;
  /** OTLP collector endpoint (e.g., 'http://localhost:4318'). */
  endpoint: string;
  /** Service name for resource attributes. Default: 'paygate-mcp'. */
  serviceName?: string;
  /** Service version. Default: read from package.json. */
  serviceVersion?: string;
  /** Batch flush interval in ms. Default: 5000. */
  flushIntervalMs?: number;
  /** Max spans per batch. Default: 512. */
  maxBatchSize?: number;
  /** Max queued spans before dropping. Default: 2048. */
  maxQueueSize?: number;
  /** Additional resource attributes. */
  resourceAttributes?: Record<string, string>;
  /** Auth header for collector (e.g., 'Bearer xxx'). */
  authHeader?: string;
  /** Sample rate 0.0-1.0. Default: 1.0. */
  sampleRate?: number;
}

export interface OtelSpan {
  /** 32-char hex trace ID. */
  traceId: string;
  /** 16-char hex span ID. */
  spanId: string;
  /** Parent span ID (optional). */
  parentSpanId?: string;
  /** Operation name. */
  name: string;
  /** Span kind: 0=UNSPECIFIED, 1=INTERNAL, 2=SERVER, 3=CLIENT. */
  kind: number;
  /** Start time in nanoseconds (as string for 64-bit precision). */
  startTimeUnixNano: string;
  /** End time in nanoseconds. */
  endTimeUnixNano: string;
  /** Status: 0=UNSET, 1=OK, 2=ERROR. */
  status: { code: number; message?: string };
  /** Key-value attributes. */
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string; boolValue?: boolean; doubleValue?: number } }>;
}

export interface OtelEmitterStats {
  /** Total spans created. */
  spansCreated: number;
  /** Total spans exported. */
  spansExported: number;
  /** Total spans dropped (queue full). */
  spansDropped: number;
  /** Total export batches sent. */
  batchesSent: number;
  /** Total export errors. */
  exportErrors: number;
  /** Current queue size. */
  queueSize: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateTraceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

function generateSpanId(): string {
  return crypto.randomBytes(8).toString('hex');
}

function nowNano(): string {
  const [sec, nsec] = process.hrtime();
  // BigInt math for nanosecond precision
  const ms = BigInt(Date.now());
  const ns = ms * BigInt(1_000_000);
  return ns.toString();
}

function toNano(ms: number): string {
  return (BigInt(ms) * BigInt(1_000_000)).toString();
}

function makeAttr(key: string, value: string | number | boolean): { key: string; value: Record<string, unknown> } {
  if (typeof value === 'string') return { key, value: { stringValue: value } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (Number.isInteger(value)) return { key, value: { intValue: String(value) } };
  return { key, value: { doubleValue: value as number } };
}

// ─── OpenTelemetry Emitter ───────────────────────────────────────────────────

export class OtelEmitter {
  private enabled: boolean;
  private endpoint: string;
  private serviceName: string;
  private serviceVersion: string;
  private flushIntervalMs: number;
  private maxBatchSize: number;
  private maxQueueSize: number;
  private resourceAttributes: Record<string, string>;
  private authHeader?: string;
  private sampleRate: number;

  private queue: OtelSpan[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private stats: OtelEmitterStats = {
    spansCreated: 0,
    spansExported: 0,
    spansDropped: 0,
    batchesSent: 0,
    exportErrors: 0,
    queueSize: 0,
  };

  constructor(config: Partial<OtelConfig>) {
    this.enabled = config.enabled ?? false;
    this.endpoint = config.endpoint ?? 'http://localhost:4318';
    this.serviceName = config.serviceName ?? 'paygate-mcp';
    this.serviceVersion = config.serviceVersion ?? '0.0.0';
    this.flushIntervalMs = config.flushIntervalMs ?? 5_000;
    this.maxBatchSize = config.maxBatchSize ?? 512;
    this.maxQueueSize = config.maxQueueSize ?? 2048;
    this.resourceAttributes = config.resourceAttributes ?? {};
    this.authHeader = config.authHeader;
    this.sampleRate = config.sampleRate ?? 1.0;

    if (this.enabled) {
      this.startFlushing();
    }
  }

  /** Whether OTEL is enabled. */
  get isEnabled(): boolean { return this.enabled; }

  /** Enable/disable at runtime. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled && !this.flushTimer) {
      this.startFlushing();
    } else if (!enabled && this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Generate a new trace ID.
   */
  newTraceId(): string {
    return generateTraceId();
  }

  /**
   * Generate a new span ID.
   */
  newSpanId(): string {
    return generateSpanId();
  }

  /**
   * Parse a W3C traceparent header.
   * Format: version-traceId-parentSpanId-traceFlags
   */
  parseTraceparent(header: string): { traceId: string; parentSpanId: string; sampled: boolean } | null {
    const parts = header.split('-');
    if (parts.length !== 4) return null;
    if (parts[0] !== '00') return null;
    if (parts[1].length !== 32) return null;
    if (parts[2].length !== 16) return null;
    return {
      traceId: parts[1],
      parentSpanId: parts[2],
      sampled: (parseInt(parts[3], 16) & 0x01) === 1,
    };
  }

  /**
   * Build a W3C traceparent header.
   */
  buildTraceparent(traceId: string, spanId: string, sampled = true): string {
    return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
  }

  /**
   * Record a completed span.
   */
  recordSpan(span: OtelSpan): void {
    if (!this.enabled) return;

    // Sampling
    if (this.sampleRate < 1.0 && Math.random() > this.sampleRate) return;

    this.stats.spansCreated++;

    if (this.queue.length >= this.maxQueueSize) {
      this.stats.spansDropped++;
      return;
    }

    this.queue.push(span);
    this.stats.queueSize = this.queue.length;

    // Flush if batch is full
    if (this.queue.length >= this.maxBatchSize) {
      this.flush().catch(() => {});
    }
  }

  /**
   * Create and record a span from timing data.
   * Convenience method for the common case.
   */
  emitSpan(opts: {
    traceId: string;
    parentSpanId?: string;
    name: string;
    kind?: number;
    startMs: number;
    endMs: number;
    status?: 'ok' | 'error';
    statusMessage?: string;
    attributes?: Record<string, string | number | boolean>;
  }): string {
    const spanId = generateSpanId();

    const attrs = Object.entries(opts.attributes ?? {}).map(([k, v]) => makeAttr(k, v));

    const span: OtelSpan = {
      traceId: opts.traceId,
      spanId,
      parentSpanId: opts.parentSpanId,
      name: opts.name,
      kind: opts.kind ?? 1, // INTERNAL
      startTimeUnixNano: toNano(opts.startMs),
      endTimeUnixNano: toNano(opts.endMs),
      status: {
        code: opts.status === 'error' ? 2 : (opts.status === 'ok' ? 1 : 0),
        message: opts.statusMessage,
      },
      attributes: attrs,
    };

    this.recordSpan(span);
    return spanId;
  }

  /**
   * Flush queued spans to the collector.
   */
  async flush(): Promise<number> {
    if (this.queue.length === 0) return 0;

    const batch = this.queue.splice(0, this.maxBatchSize);
    this.stats.queueSize = this.queue.length;

    const payload = this.buildOtlpPayload(batch);

    try {
      await this.sendToCollector(payload);
      this.stats.spansExported += batch.length;
      this.stats.batchesSent++;
      return batch.length;
    } catch {
      this.stats.exportErrors++;
      // Re-queue if possible
      if (this.queue.length + batch.length <= this.maxQueueSize) {
        this.queue.unshift(...batch);
        this.stats.queueSize = this.queue.length;
      } else {
        this.stats.spansDropped += batch.length;
      }
      return 0;
    }
  }

  /** Get stats. */
  getStats(): OtelEmitterStats {
    return { ...this.stats, queueSize: this.queue.length };
  }

  /** Graceful shutdown — flush remaining spans. */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Final flush
    while (this.queue.length > 0) {
      await this.flush();
    }
  }

  /** Destroy. */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.queue = [];
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private startFlushing(): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {});
    }, this.flushIntervalMs);
    // Don't block process exit
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  private buildOtlpPayload(spans: OtelSpan[]): string {
    const resourceAttrs = [
      makeAttr('service.name', this.serviceName),
      makeAttr('service.version', this.serviceVersion),
      ...Object.entries(this.resourceAttributes).map(([k, v]) => makeAttr(k, v)),
    ];

    const payload = {
      resourceSpans: [{
        resource: {
          attributes: resourceAttrs,
        },
        scopeSpans: [{
          scope: {
            name: 'paygate-mcp',
            version: this.serviceVersion,
          },
          spans: spans.map(s => ({
            traceId: s.traceId,
            spanId: s.spanId,
            parentSpanId: s.parentSpanId || '',
            name: s.name,
            kind: s.kind,
            startTimeUnixNano: s.startTimeUnixNano,
            endTimeUnixNano: s.endTimeUnixNano,
            attributes: s.attributes,
            status: s.status,
          })),
        }],
      }],
    };

    return JSON.stringify(payload);
  }

  private sendToCollector(payload: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.endpoint}/v1/traces`);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(payload)),
      };

      if (this.authHeader) {
        headers['Authorization'] = this.authHeader;
      }

      const opts: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers,
        timeout: 10_000,
      };

      const req = transport.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`OTEL collector returned ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('timeout', () => { req.destroy(); reject(new Error('OTEL collector timeout')); });
      req.on('error', (err) => reject(err));
      req.write(payload);
      req.end();
    });
  }
}
