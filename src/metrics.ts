/**
 * MetricsCollector — Prometheus-compatible metrics for PayGate.
 *
 * Exposes counters and gauges in Prometheus text exposition format
 * at the /metrics endpoint. No external dependencies.
 *
 * Metric naming follows Prometheus conventions:
 *   - paygate_ prefix for all metrics
 *   - _total suffix for counters
 *   - snake_case naming
 *
 * Supported metric types:
 *   - Counter: monotonically increasing (tool calls, credits, denials)
 *   - Gauge: point-in-time value (active keys, sessions, uptime)
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MetricLabels {
  [key: string]: string;
}

interface CounterEntry {
  type: 'counter';
  help: string;
  values: Map<string, number>;
}

interface GaugeEntry {
  type: 'gauge';
  help: string;
  /** Static gauge value, OR a callback for dynamic gauges */
  values: Map<string, number>;
  /** Dynamic gauge supplier (called at scrape time) */
  supplier?: () => number;
}

type MetricEntry = CounterEntry | GaugeEntry;

/** Max label-set entries per metric (prevents unbounded cardinality explosion). */
const MAX_VALUES_PER_METRIC = 10_000;

/** Max serialized output size in bytes (5 MB). */
const MAX_SERIALIZE_BYTES = 5 * 1024 * 1024;

// ─── MetricsCollector ─────────────────────────────────────────────────────────

export class MetricsCollector {
  private metrics = new Map<string, MetricEntry>();
  private readonly startTime: number;

  constructor() {
    this.startTime = Date.now();

    // Register built-in metrics
    this.registerCounter('paygate_tool_calls_total', 'Total tool calls processed');
    this.registerCounter('paygate_credits_charged_total', 'Total credits charged');
    this.registerCounter('paygate_denials_total', 'Total tool call denials');
    this.registerCounter('paygate_http_requests_total', 'Total HTTP requests');
    this.registerCounter('paygate_rate_limit_hits_total', 'Total rate limit hits');
    this.registerCounter('paygate_refunds_total', 'Total credit refunds');
    this.registerGauge('paygate_uptime_seconds', 'Server uptime in seconds');
  }

  // ─── Registration ───────────────────────────────────────────────────────────

  registerCounter(name: string, help: string): void {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, { type: 'counter', help, values: new Map() });
    }
  }

  registerGauge(name: string, help: string, supplier?: () => number): void {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, { type: 'gauge', help, values: new Map(), supplier });
    }
  }

  // ─── Counter operations ─────────────────────────────────────────────────────

  increment(name: string, labels?: MetricLabels, amount = 1): void {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== 'counter') return;
    const key = this.serializeLabels(labels);
    // Only allow new keys if below cardinality cap (existing keys always update)
    if (!metric.values.has(key) && metric.values.size >= MAX_VALUES_PER_METRIC) return;
    metric.values.set(key, (metric.values.get(key) || 0) + amount);
  }

  // ─── Gauge operations ──────────────────────────────────────────────────────

  setGauge(name: string, value: number, labels?: MetricLabels): void {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== 'gauge') return;
    const key = this.serializeLabels(labels);
    // Only allow new keys if below cardinality cap (existing keys always update)
    if (!metric.values.has(key) && metric.values.size >= MAX_VALUES_PER_METRIC) return;
    metric.values.set(key, value);
  }

  // ─── Convenience methods for common events ──────────────────────────────────

  /**
   * Record a tool call (allowed or denied).
   */
  recordToolCall(tool: string, allowed: boolean, creditsCharged: number, denyReason?: string): void {
    const status = allowed ? 'allowed' : 'denied';
    this.increment('paygate_tool_calls_total', { tool, status });

    if (allowed && creditsCharged > 0) {
      this.increment('paygate_credits_charged_total', { tool }, creditsCharged);
    }

    if (!allowed && denyReason) {
      this.increment('paygate_denials_total', { reason: denyReason });
    }
  }

  /**
   * Record an HTTP request.
   */
  recordHttpRequest(method: string, path: string, statusCode: number): void {
    this.increment('paygate_http_requests_total', {
      method,
      path: this.normalizePath(path),
      status: String(statusCode),
    });
  }

  /**
   * Record a rate limit hit.
   */
  recordRateLimitHit(tool: string): void {
    this.increment('paygate_rate_limit_hits_total', { tool });
  }

  /**
   * Record a refund.
   */
  recordRefund(tool: string, credits: number): void {
    this.increment('paygate_refunds_total', { tool }, credits);
  }

  // ─── Scrape / Export ────────────────────────────────────────────────────────

  /**
   * Return all metrics in Prometheus text exposition format.
   */
  serialize(): string {
    const lines: string[] = [];
    let byteEstimate = 0;

    for (const [name, metric] of this.metrics) {
      // Handle built-in uptime gauge
      if (name === 'paygate_uptime_seconds') {
        const l1 = `# HELP ${name} ${metric.help}`;
        const l2 = `# TYPE ${name} gauge`;
        const l3 = `${name} ${Math.floor((Date.now() - this.startTime) / 1000)}`;
        byteEstimate += l1.length + l2.length + l3.length + 3;
        if (byteEstimate > MAX_SERIALIZE_BYTES) break;
        lines.push(l1, l2, l3);
        continue;
      }

      // Handle supplier-based gauges
      if (metric.type === 'gauge' && (metric as GaugeEntry).supplier) {
        const l1 = `# HELP ${name} ${metric.help}`;
        const l2 = `# TYPE ${name} gauge`;
        const l3 = `${name} ${(metric as GaugeEntry).supplier!()}`;
        byteEstimate += l1.length + l2.length + l3.length + 3;
        if (byteEstimate > MAX_SERIALIZE_BYTES) break;
        lines.push(l1, l2, l3);
        continue;
      }

      // Skip metrics with no data
      if (metric.values.size === 0) continue;

      const header1 = `# HELP ${name} ${metric.help}`;
      const header2 = `# TYPE ${name} ${metric.type}`;
      byteEstimate += header1.length + header2.length + 2;
      if (byteEstimate > MAX_SERIALIZE_BYTES) break;
      lines.push(header1, header2);

      for (const [labelKey, value] of metric.values) {
        const line = labelKey === ''
          ? `${name} ${value}`
          : `${name}{${labelKey}} ${value}`;
        byteEstimate += line.length + 1;
        if (byteEstimate > MAX_SERIALIZE_BYTES) break;
        lines.push(line);
      }
      if (byteEstimate > MAX_SERIALIZE_BYTES) break;
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Get a counter value (for testing).
   */
  getCounter(name: string, labels?: MetricLabels): number {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== 'counter') return 0;
    return metric.values.get(this.serializeLabels(labels)) || 0;
  }

  /**
   * Get a gauge value (for testing).
   */
  getGauge(name: string, labels?: MetricLabels): number {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== 'gauge') return 0;
    if ((metric as GaugeEntry).supplier && !labels) {
      return (metric as GaugeEntry).supplier!();
    }
    return metric.values.get(this.serializeLabels(labels)) || 0;
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private serializeLabels(labels?: MetricLabels): string {
    if (!labels || Object.keys(labels).length === 0) return '';
    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${this.escapeLabel(v)}"`)
      .join(',');
  }

  private escapeLabel(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }

  private normalizePath(path: string): string {
    // Strip query string and normalize
    const clean = (path.split('?')[0] || '/').toLowerCase();
    // Group dynamic paths
    if (clean.startsWith('/oauth')) return '/oauth/*';
    if (clean.startsWith('/keys')) return '/keys/*';
    if (clean.startsWith('/audit')) return '/audit/*';
    return clean;
  }
}
