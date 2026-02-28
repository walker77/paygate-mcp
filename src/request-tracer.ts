/**
 * RequestTracer — Lightweight structured tracing for PayGate.
 *
 * Provides end-to-end visibility into request processing:
 * gate evaluation, ACL checks, rate limiting, transforms,
 * proxy calls, retries, and cache hits. No external collector
 * required — traces are stored in-memory and exported via admin API.
 *
 * Features:
 *   - Trace ID generation and propagation (X-Trace-Id header)
 *   - Span recording at key decision points
 *   - Per-trace summary with timing breakdown
 *   - Configurable retention (max traces, max age)
 *   - Export as JSON for external analysis
 *   - Stats: total traces, avg duration, slowest requests
 *
 * Zero external dependencies.
 */

import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TracerConfig {
  /** Enable tracing. Default false. */
  enabled: boolean;
  /** Max traces to retain. Default 5_000. */
  maxTraces: number;
  /** Max age in ms before pruning. Default 3_600_000 (1 hour). */
  maxAgeMs: number;
  /** Sample rate 0.0-1.0. Default 1.0 (trace everything when enabled). */
  sampleRate: number;
}

export interface TraceSpan {
  spanId: string;
  name: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  status: 'ok' | 'error';
  attributes: Record<string, unknown>;
}

export interface RequestTrace {
  traceId: string;
  requestId: string;
  apiKey?: string;
  tool?: string;
  method: string;
  path: string;
  startTime: number;
  endTime: number;
  totalDurationMs: number;
  spans: TraceSpan[];
  summary: TraceSummary;
}

export interface TraceSummary {
  gateMs: number;
  backendMs: number;
  transformMs: number;
  retryAttempts: number;
  cacheHit: boolean;
  circuitState?: string;
  creditsCost: number;
  statusCode: number;
  error?: string;
}

export interface TracerStats {
  enabled: boolean;
  config: TracerConfig;
  activeTraces: number;
  completedTraces: number;
  totalTraces: number;
  avgDurationMs: number;
  p95DurationMs: number;
  slowestTraceId?: string;
  slowestDurationMs: number;
}

// ─── Default config ─────────────────────────────────────────────────────────

const DEFAULT_TRACER_CONFIG: TracerConfig = {
  enabled: false,
  maxTraces: 5_000,
  maxAgeMs: 3_600_000,
  sampleRate: 1.0,
};

// ─── RequestTracer Class ────────────────────────────────────────────────────

export class RequestTracer {
  private config: TracerConfig;

  // Active traces (in-progress)
  private active = new Map<string, RequestTrace>();
  // Completed traces (ring buffer)
  private completed: RequestTrace[] = [];

  // Stats
  private totalTraces = 0;
  private durationSum = 0;
  private durations: number[] = [];
  private slowestTraceId?: string;
  private slowestDurationMs = 0;

  constructor(config?: Partial<TracerConfig>) {
    this.config = { ...DEFAULT_TRACER_CONFIG, ...config };
  }

  /**
   * Start a new trace. Returns traceId or null if not sampled.
   */
  startTrace(requestId: string, method: string, path: string, apiKey?: string): string | null {
    if (!this.config.enabled) return null;

    // Sample rate check
    if (this.config.sampleRate < 1.0 && Math.random() > this.config.sampleRate) {
      return null;
    }

    const traceId = 'trc_' + crypto.randomBytes(8).toString('hex');
    const trace: RequestTrace = {
      traceId,
      requestId,
      apiKey: apiKey ? apiKey.slice(0, 8) + '...' : undefined,
      method,
      path,
      startTime: Date.now(),
      endTime: 0,
      totalDurationMs: 0,
      spans: [],
      summary: {
        gateMs: 0,
        backendMs: 0,
        transformMs: 0,
        retryAttempts: 0,
        cacheHit: false,
        creditsCost: 0,
        statusCode: 0,
      },
    };

    this.active.set(traceId, trace);
    return traceId;
  }

  /**
   * Add a span to a trace.
   */
  addSpan(
    traceId: string,
    name: string,
    durationMs: number,
    status: 'ok' | 'error' = 'ok',
    attributes?: Record<string, unknown>,
  ): void {
    const trace = this.active.get(traceId);
    if (!trace) return;

    const now = Date.now();
    trace.spans.push({
      spanId: 'spn_' + crypto.randomBytes(4).toString('hex'),
      name,
      startTime: now - durationMs,
      endTime: now,
      durationMs,
      status,
      attributes: attributes ?? {},
    });
  }

  /**
   * End a trace and move to completed.
   */
  endTrace(traceId: string, summary?: Partial<TraceSummary>): RequestTrace | null {
    const trace = this.active.get(traceId);
    if (!trace) return null;

    trace.endTime = Date.now();
    trace.totalDurationMs = trace.endTime - trace.startTime;
    if (summary) {
      Object.assign(trace.summary, summary);
    }

    // Calculate summary from spans
    for (const span of trace.spans) {
      if (span.name.startsWith('gate.')) trace.summary.gateMs += span.durationMs;
      else if (span.name.startsWith('backend.')) trace.summary.backendMs += span.durationMs;
      else if (span.name.startsWith('transform.')) trace.summary.transformMs += span.durationMs;
    }

    this.active.delete(traceId);
    this.completed.push(trace);

    // Update stats
    this.totalTraces++;
    this.durationSum += trace.totalDurationMs;
    this.durations.push(trace.totalDurationMs);
    if (trace.totalDurationMs > this.slowestDurationMs) {
      this.slowestDurationMs = trace.totalDurationMs;
      this.slowestTraceId = trace.traceId;
    }

    // Enforce max traces
    while (this.completed.length > this.config.maxTraces) {
      this.completed.shift();
    }

    // Prune old
    this.pruneOld();

    return trace;
  }

  /**
   * Get a specific trace by ID.
   */
  getTrace(traceId: string): RequestTrace | undefined {
    return this.active.get(traceId) || this.completed.find(t => t.traceId === traceId);
  }

  /**
   * Get traces by request ID.
   */
  getByRequestId(requestId: string): RequestTrace[] {
    const results: RequestTrace[] = [];
    for (const t of this.active.values()) {
      if (t.requestId === requestId) results.push(t);
    }
    for (const t of this.completed) {
      if (t.requestId === requestId) results.push(t);
    }
    return results;
  }

  /**
   * Get recent traces.
   */
  getRecent(limit: number = 50, since?: number): RequestTrace[] {
    let traces = [...this.completed];
    if (since) {
      traces = traces.filter(t => t.startTime >= since);
    }
    return traces.slice(-limit);
  }

  /**
   * Get slow traces (above threshold).
   */
  getSlow(thresholdMs: number = 1000, limit: number = 20): RequestTrace[] {
    return this.completed
      .filter(t => t.totalDurationMs >= thresholdMs)
      .sort((a, b) => b.totalDurationMs - a.totalDurationMs)
      .slice(0, limit);
  }

  /**
   * Export traces as JSON (for external analysis).
   */
  exportTraces(since?: number): RequestTrace[] {
    let traces = [...this.completed];
    if (since) {
      traces = traces.filter(t => t.startTime >= since);
    }
    return traces;
  }

  /**
   * Update configuration.
   */
  configure(updates: Partial<TracerConfig>): TracerConfig {
    if (updates.enabled !== undefined) this.config.enabled = updates.enabled;
    if (updates.maxTraces !== undefined) this.config.maxTraces = Math.max(100, Math.min(50_000, updates.maxTraces));
    if (updates.maxAgeMs !== undefined) this.config.maxAgeMs = Math.max(60_000, updates.maxAgeMs);
    if (updates.sampleRate !== undefined) this.config.sampleRate = Math.max(0, Math.min(1, updates.sampleRate));
    return { ...this.config };
  }

  /**
   * Get statistics.
   */
  stats(): TracerStats {
    this.pruneOld();
    const sorted = [...this.durations].sort((a, b) => a - b);
    const p95Idx = Math.floor(sorted.length * 0.95);
    return {
      enabled: this.config.enabled,
      config: { ...this.config },
      activeTraces: this.active.size,
      completedTraces: this.completed.length,
      totalTraces: this.totalTraces,
      avgDurationMs: this.totalTraces > 0 ? Math.round(this.durationSum / this.totalTraces) : 0,
      p95DurationMs: sorted.length > 0 ? sorted[p95Idx] ?? sorted[sorted.length - 1] : 0,
      slowestTraceId: this.slowestTraceId,
      slowestDurationMs: this.slowestDurationMs,
    };
  }

  /**
   * Clear all traces.
   */
  clear(): void {
    this.active.clear();
    this.completed = [];
    this.durations = [];
    this.durationSum = 0;
    this.slowestTraceId = undefined;
    this.slowestDurationMs = 0;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private pruneOld(): void {
    const cutoff = Date.now() - this.config.maxAgeMs;
    this.completed = this.completed.filter(t => t.startTime >= cutoff);
  }
}
