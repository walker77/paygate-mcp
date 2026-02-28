/**
 * CostAllocator — Per-request cost allocation tags with chargeback reporting.
 *
 * Allows clients to attach key-value tags to individual tool calls via
 * an `X-Cost-Tags` header. Tags flow through the metering pipeline and
 * enable aggregated chargeback reports by any dimension.
 *
 * Features:
 *   - X-Cost-Tags header parsing with validation
 *   - Tag cardinality limits to prevent memory exhaustion
 *   - Aggregated chargeback reports by any tag dimension
 *   - Cross-tabulation (group by two dimensions)
 *   - CSV export support
 *   - Per-key required tag enforcement
 *
 * Zero external dependencies.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CostTagConfig {
  /** Enable cost tags. Default true. */
  enabled: boolean;
  /** Max tags per request. Default 10. */
  maxTagsPerRequest: number;
  /** Max key length. Default 64. */
  maxKeyLength: number;
  /** Max value length. Default 64. */
  maxValueLength: number;
  /** Max unique tag keys. Default 1_000. */
  maxUniqueKeys: number;
  /** Max unique values per key. Default 10_000. */
  maxValuesPerKey: number;
}

export interface CostTagEntry {
  tags: Record<string, string>;
  apiKey: string;
  toolName: string;
  credits: number;
  timestamp: number;
}

export interface ChargebackRow {
  dimension: string;
  value: string;
  totalCredits: number;
  totalCalls: number;
  avgCreditsPerCall: number;
}

export interface CrossTabRow {
  dim1Value: string;
  dim2Value: string;
  totalCredits: number;
  totalCalls: number;
}

export interface ChargebackReport {
  dimension: string;
  rows: ChargebackRow[];
  totalCredits: number;
  totalCalls: number;
  generatedAt: string;
}

export interface CrossTabReport {
  dim1: string;
  dim2: string;
  rows: CrossTabRow[];
  totalCredits: number;
  totalCalls: number;
  generatedAt: string;
}

export interface CostTagStats {
  enabled: boolean;
  config: CostTagConfig;
  totalEntries: number;
  uniqueKeys: number;
  valuesPerKey: Record<string, number>;
  totalCreditsTracked: number;
  totalCallsTracked: number;
  requiredTagKeys: number;
}

// ─── Default config ─────────────────────────────────────────────────────────

const DEFAULT_COST_TAG_CONFIG: CostTagConfig = {
  enabled: true,
  maxTagsPerRequest: 10,
  maxKeyLength: 64,
  maxValueLength: 64,
  maxUniqueKeys: 1_000,
  maxValuesPerKey: 10_000,
};

// Valid tag key/value pattern: alphanumeric, dash, underscore, colon, dot
const TAG_PATTERN = /^[a-zA-Z0-9\-_:.]+$/;

// ─── CostAllocator Class ────────────────────────────────────────────────────

export class CostAllocator {
  private config: CostTagConfig;
  private entries: CostTagEntry[] = [];
  private readonly maxEntries = 100_000;

  // Cardinality tracking
  private knownKeys = new Set<string>();
  private knownValuesPerKey = new Map<string, Set<string>>();

  // Required tags per key
  private requiredTags = new Map<string, string[]>();

  constructor(config?: Partial<CostTagConfig>) {
    this.config = { ...DEFAULT_COST_TAG_CONFIG, ...config };
  }

  /**
   * Parse and validate tags from X-Cost-Tags header value.
   * Header format: JSON-encoded object, e.g. {"project":"acme","dept":"eng"}
   */
  parseTags(headerValue: string): Record<string, string> {
    if (!headerValue || !headerValue.trim()) return {};

    let parsed: unknown;
    try {
      parsed = JSON.parse(headerValue);
    } catch {
      throw new Error('Invalid X-Cost-Tags header: must be valid JSON object');
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Invalid X-Cost-Tags header: must be a JSON object');
    }

    const tags = parsed as Record<string, unknown>;
    const keys = Object.keys(tags);

    if (keys.length > this.config.maxTagsPerRequest) {
      throw new Error(`Too many cost tags: ${keys.length} (max ${this.config.maxTagsPerRequest})`);
    }

    const validated: Record<string, string> = {};
    for (const key of keys) {
      const value = String(tags[key]);

      if (key.length > this.config.maxKeyLength) {
        throw new Error(`Tag key "${key}" exceeds max length ${this.config.maxKeyLength}`);
      }
      if (value.length > this.config.maxValueLength) {
        throw new Error(`Tag value for "${key}" exceeds max length ${this.config.maxValueLength}`);
      }
      if (!TAG_PATTERN.test(key)) {
        throw new Error(`Invalid tag key "${key}": must match [a-zA-Z0-9\\-_:.]`);
      }
      if (!TAG_PATTERN.test(value)) {
        throw new Error(`Invalid tag value for "${key}": must match [a-zA-Z0-9\\-_:.]`);
      }

      validated[key] = value;
    }

    return validated;
  }

  /**
   * Record a tagged usage event.
   */
  record(tags: Record<string, string>, apiKey: string, toolName: string, credits: number): void {
    if (!this.config.enabled) return;
    if (Object.keys(tags).length === 0) return;

    // Check cardinality limits
    for (const [key, value] of Object.entries(tags)) {
      if (!this.knownKeys.has(key)) {
        if (this.knownKeys.size >= this.config.maxUniqueKeys) continue; // Skip new keys over limit
        this.knownKeys.add(key);
      }

      let valSet = this.knownValuesPerKey.get(key);
      if (!valSet) {
        valSet = new Set<string>();
        this.knownValuesPerKey.set(key, valSet);
      }
      if (!valSet.has(value)) {
        if (valSet.size >= this.config.maxValuesPerKey) continue; // Skip new values over limit
        valSet.add(value);
      }
    }

    // Evict oldest entries if at capacity
    if (this.entries.length >= this.maxEntries) {
      this.entries.splice(0, Math.floor(this.maxEntries * 0.1));
    }

    this.entries.push({
      tags,
      apiKey,
      toolName,
      credits,
      timestamp: Date.now(),
    });
  }

  /**
   * Check if a request has all required tags for the given API key.
   */
  validateRequired(apiKey: string, tags: Record<string, string>): string[] {
    const required = this.requiredTags.get(apiKey);
    if (!required || required.length === 0) return [];

    const missing: string[] = [];
    for (const key of required) {
      if (!tags[key]) missing.push(key);
    }
    return missing;
  }

  /**
   * Set required tags for an API key.
   */
  setRequiredTags(apiKey: string, tagKeys: string[]): void {
    if (tagKeys.length === 0) {
      this.requiredTags.delete(apiKey);
    } else {
      this.requiredTags.set(apiKey, tagKeys);
    }
  }

  /**
   * Get required tags for an API key.
   */
  getRequiredTags(apiKey: string): string[] {
    return this.requiredTags.get(apiKey) || [];
  }

  /**
   * Generate a chargeback report grouped by a single dimension.
   */
  report(dimension: string, startMs?: number, endMs?: number): ChargebackReport {
    const filtered = this.filterEntries(startMs, endMs);
    const groups = new Map<string, { credits: number; calls: number }>();

    for (const entry of filtered) {
      const value = entry.tags[dimension];
      if (value === undefined) continue;

      const group = groups.get(value) || { credits: 0, calls: 0 };
      group.credits += entry.credits;
      group.calls++;
      groups.set(value, group);
    }

    const rows: ChargebackRow[] = Array.from(groups.entries())
      .map(([value, g]) => ({
        dimension,
        value,
        totalCredits: g.credits,
        totalCalls: g.calls,
        avgCreditsPerCall: g.calls > 0 ? Math.round((g.credits / g.calls) * 100) / 100 : 0,
      }))
      .sort((a, b) => b.totalCredits - a.totalCredits);

    const totalCredits = rows.reduce((sum, r) => sum + r.totalCredits, 0);
    const totalCalls = rows.reduce((sum, r) => sum + r.totalCalls, 0);

    return {
      dimension,
      rows,
      totalCredits,
      totalCalls,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Generate a cross-tabulation report (group by two dimensions).
   */
  crossTab(dim1: string, dim2: string, startMs?: number, endMs?: number): CrossTabReport {
    const filtered = this.filterEntries(startMs, endMs);
    const groups = new Map<string, { credits: number; calls: number }>();

    for (const entry of filtered) {
      const v1 = entry.tags[dim1];
      const v2 = entry.tags[dim2];
      if (v1 === undefined || v2 === undefined) continue;

      const key = `${v1}|||${v2}`;
      const group = groups.get(key) || { credits: 0, calls: 0 };
      group.credits += entry.credits;
      group.calls++;
      groups.set(key, group);
    }

    const rows: CrossTabRow[] = Array.from(groups.entries())
      .map(([key, g]) => {
        const [v1, v2] = key.split('|||');
        return {
          dim1Value: v1,
          dim2Value: v2,
          totalCredits: g.credits,
          totalCalls: g.calls,
        };
      })
      .sort((a, b) => b.totalCredits - a.totalCredits);

    const totalCredits = rows.reduce((sum, r) => sum + r.totalCredits, 0);
    const totalCalls = rows.reduce((sum, r) => sum + r.totalCalls, 0);

    return {
      dim1,
      dim2,
      rows,
      totalCredits,
      totalCalls,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Export report as CSV string.
   */
  reportToCsv(report: ChargebackReport): string {
    const lines = ['dimension,value,totalCredits,totalCalls,avgCreditsPerCall'];
    for (const row of report.rows) {
      lines.push(`${row.dimension},${row.value},${row.totalCredits},${row.totalCalls},${row.avgCreditsPerCall}`);
    }
    return lines.join('\n');
  }

  /**
   * Update configuration at runtime.
   */
  configure(updates: Partial<CostTagConfig>): CostTagConfig {
    if (updates.enabled !== undefined) this.config.enabled = updates.enabled;
    if (updates.maxTagsPerRequest !== undefined) this.config.maxTagsPerRequest = Math.max(1, Math.min(50, updates.maxTagsPerRequest));
    if (updates.maxKeyLength !== undefined) this.config.maxKeyLength = Math.max(8, Math.min(256, updates.maxKeyLength));
    if (updates.maxValueLength !== undefined) this.config.maxValueLength = Math.max(8, Math.min(256, updates.maxValueLength));
    if (updates.maxUniqueKeys !== undefined) this.config.maxUniqueKeys = Math.max(10, Math.min(10_000, updates.maxUniqueKeys));
    if (updates.maxValuesPerKey !== undefined) this.config.maxValuesPerKey = Math.max(100, Math.min(100_000, updates.maxValuesPerKey));
    return { ...this.config };
  }

  /**
   * Clear all recorded entries.
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * Get statistics.
   */
  stats(): CostTagStats {
    const valuesPerKey: Record<string, number> = {};
    for (const [key, valSet] of this.knownValuesPerKey) {
      valuesPerKey[key] = valSet.size;
    }

    return {
      enabled: this.config.enabled,
      config: { ...this.config },
      totalEntries: this.entries.length,
      uniqueKeys: this.knownKeys.size,
      valuesPerKey,
      totalCreditsTracked: this.entries.reduce((sum, e) => sum + e.credits, 0),
      totalCallsTracked: this.entries.length,
      requiredTagKeys: this.requiredTags.size,
    };
  }

  /** Is cost allocation enabled? */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Current config (copy). */
  get currentConfig(): CostTagConfig {
    return { ...this.config };
  }

  /** Number of recorded entries. */
  get size(): number {
    return this.entries.length;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private filterEntries(startMs?: number, endMs?: number): CostTagEntry[] {
    if (!startMs && !endMs) return this.entries;
    return this.entries.filter(e => {
      if (startMs && e.timestamp < startMs) return false;
      if (endMs && e.timestamp > endMs) return false;
      return true;
    });
  }
}
