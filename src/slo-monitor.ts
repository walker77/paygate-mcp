/**
 * SloMonitor — Service Level Objective tracking with error budgets.
 *
 * Define latency and availability SLOs for tools, track compliance,
 * compute error budget burn rates, and alert on budget exhaustion.
 *
 * @example
 * ```ts
 * const slo = new SloMonitor();
 *
 * slo.defineSlo({
 *   id: 'search-latency',
 *   name: 'Search P99 Latency',
 *   type: 'latency',
 *   target: 0.99,
 *   thresholdMs: 500,
 *   windowSeconds: 86400,
 *   tools: ['search'],
 * });
 *
 * slo.recordEvent({ tool: 'search', latencyMs: 120, success: true });
 *
 * const status = slo.getStatus('search-latency');
 * // { compliant: true, budgetRemaining: 0.98, burnRate: 0.02, ... }
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type SloType = 'latency' | 'availability' | 'error_rate';

export interface SloDefinition {
  id: string;
  name: string;
  type: SloType;
  /** Target (0-1). E.g., 0.999 = 99.9% availability. */
  target: number;
  /** For latency SLOs: threshold in ms. Requests under this count as "good". */
  thresholdMs?: number;
  /** Rolling window in seconds. Default 86400 (24h). */
  windowSeconds?: number;
  /** Tools this SLO applies to. Empty = all tools. */
  tools?: string[];
  /** Keys this SLO applies to. Empty = all keys. */
  keys?: string[];
}

export interface SloEvent {
  tool: string;
  key?: string;
  latencyMs: number;
  success: boolean;
  timestamp?: number;
}

export interface SloStatus {
  id: string;
  name: string;
  type: SloType;
  target: number;
  current: number;
  compliant: boolean;
  totalEvents: number;
  goodEvents: number;
  badEvents: number;
  budgetTotal: number;
  budgetConsumed: number;
  budgetRemaining: number;
  burnRate: number; // consumed / elapsed fraction of window
  windowStart: number;
  windowEnd: number;
}

export interface SloAlert {
  id: string;
  sloId: string;
  type: 'budget_warning' | 'budget_exhausted' | 'burn_rate_high';
  message: string;
  timestamp: number;
  budgetRemaining: number;
  burnRate: number;
}

export interface SloMonitorConfig {
  maxEvents?: number;
  budgetWarningThreshold?: number; // alert when remaining drops below this (default 0.2)
  burnRateAlertMultiplier?: number; // alert when burn rate exceeds this * normal (default 5)
}

export interface SloMonitorStats {
  totalSlos: number;
  totalEvents: number;
  totalAlerts: number;
  compliantSlos: number;
  violatedSlos: number;
}

// ── Internal Types ──────────────────────────────────────────────────

interface StoredEvent {
  tool: string;
  key?: string;
  latencyMs: number;
  success: boolean;
  timestamp: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class SloMonitor {
  private slos = new Map<string, SloDefinition>();
  private events: StoredEvent[] = [];
  private alerts: SloAlert[] = [];
  private maxEvents: number;
  private budgetWarningThreshold: number;
  private burnRateAlertMultiplier: number;
  private alertIdCounter = 0;

  // Stats
  private totalEventsRecorded = 0;

  constructor(config: SloMonitorConfig = {}) {
    this.maxEvents = config.maxEvents ?? 100_000;
    this.budgetWarningThreshold = config.budgetWarningThreshold ?? 0.2;
    this.burnRateAlertMultiplier = config.burnRateAlertMultiplier ?? 5;
  }

  // ── SLO Definition ──────────────────────────────────────────────────

  /** Define or update an SLO. */
  defineSlo(def: SloDefinition): void {
    if (def.target <= 0 || def.target > 1) throw new Error('SLO target must be between 0 and 1');
    if (def.type === 'latency' && (!def.thresholdMs || def.thresholdMs <= 0)) {
      throw new Error('Latency SLO requires positive thresholdMs');
    }
    this.slos.set(def.id, { ...def, windowSeconds: def.windowSeconds ?? 86400 });
  }

  /** Remove an SLO. */
  removeSlo(id: string): boolean {
    return this.slos.delete(id);
  }

  /** Get an SLO definition. */
  getSlo(id: string): SloDefinition | null {
    return this.slos.get(id) ?? null;
  }

  /** List all SLO definitions. */
  listSlos(): SloDefinition[] {
    return [...this.slos.values()];
  }

  // ── Event Recording ──────────────────────────────────────────────────

  /** Record a request event for SLO tracking. */
  recordEvent(event: SloEvent): void {
    const stored: StoredEvent = {
      tool: event.tool,
      key: event.key,
      latencyMs: event.latencyMs,
      success: event.success,
      timestamp: event.timestamp ?? Date.now(),
    };

    this.events.push(stored);
    this.totalEventsRecorded++;

    // Evict old events
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }

    // Check for alerts
    this.checkAlerts();
  }

  // ── Status ───────────────────────────────────────────────────────────

  /** Get current status of an SLO. */
  getStatus(sloId: string): SloStatus | null {
    const slo = this.slos.get(sloId);
    if (!slo) return null;
    return this.computeStatus(slo);
  }

  /** Get status of all SLOs. */
  getAllStatuses(): SloStatus[] {
    return [...this.slos.values()].map(slo => this.computeStatus(slo));
  }

  /** Get only violated SLOs. */
  getViolations(): SloStatus[] {
    return this.getAllStatuses().filter(s => !s.compliant);
  }

  // ── Alerts ──────────────────────────────────────────────────────────

  /** Get all alerts. */
  getAlerts(limit?: number): SloAlert[] {
    const sorted = [...this.alerts].sort((a, b) => b.timestamp - a.timestamp);
    return limit ? sorted.slice(0, limit) : sorted;
  }

  /** Clear all alerts. */
  clearAlerts(): void {
    this.alerts = [];
  }

  // ── Stats ───────────────────────────────────────────────────────────

  getStats(): SloMonitorStats {
    const statuses = this.getAllStatuses();
    return {
      totalSlos: this.slos.size,
      totalEvents: this.totalEventsRecorded,
      totalAlerts: this.alerts.length,
      compliantSlos: statuses.filter(s => s.compliant).length,
      violatedSlos: statuses.filter(s => !s.compliant).length,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.slos.clear();
    this.events = [];
    this.alerts = [];
    this.totalEventsRecorded = 0;
    this.alertIdCounter = 0;
  }

  // ── Private ─────────────────────────────────────────────────────────

  private computeStatus(slo: SloDefinition): SloStatus {
    const now = Date.now();
    const windowMs = (slo.windowSeconds ?? 86400) * 1000;
    const windowStart = now - windowMs;
    const windowEnd = now;

    // Filter events in window
    let events = this.events.filter(e => e.timestamp >= windowStart && e.timestamp <= windowEnd);

    // Filter by tools/keys if specified
    if (slo.tools && slo.tools.length > 0) {
      events = events.filter(e => slo.tools!.includes(e.tool));
    }
    if (slo.keys && slo.keys.length > 0) {
      events = events.filter(e => e.key !== undefined && slo.keys!.includes(e.key));
    }

    const totalEvents = events.length;
    let goodEvents = 0;

    switch (slo.type) {
      case 'latency':
        goodEvents = events.filter(e => e.latencyMs <= (slo.thresholdMs ?? Infinity)).length;
        break;
      case 'availability':
        goodEvents = events.filter(e => e.success).length;
        break;
      case 'error_rate':
        // For error_rate SLO: target is max error rate. "good" = successful requests.
        goodEvents = events.filter(e => e.success).length;
        break;
    }

    const badEvents = totalEvents - goodEvents;
    const current = totalEvents > 0 ? goodEvents / totalEvents : 1;
    const compliant = current >= slo.target;

    // Error budget
    const budgetTotal = 1 - slo.target; // e.g., 0.001 for 99.9%
    const budgetConsumed = totalEvents > 0 ? badEvents / totalEvents : 0;
    const budgetRemaining = Math.max(0, budgetTotal - budgetConsumed);

    // Burn rate: how fast we're consuming budget relative to window elapsed
    // Normal burn rate = 1.0 (consuming budget at expected rate)
    const elapsedFraction = Math.min(1, (now - windowStart) / windowMs);
    const expectedBudgetConsumed = budgetTotal * elapsedFraction;
    const burnRate = expectedBudgetConsumed > 0 ? budgetConsumed / expectedBudgetConsumed : 0;

    return {
      id: slo.id,
      name: slo.name,
      type: slo.type,
      target: slo.target,
      current: Math.round(current * 10000) / 10000,
      compliant,
      totalEvents,
      goodEvents,
      badEvents,
      budgetTotal: Math.round(budgetTotal * 10000) / 10000,
      budgetConsumed: Math.round(budgetConsumed * 10000) / 10000,
      budgetRemaining: Math.round(budgetRemaining * 10000) / 10000,
      burnRate: Math.round(burnRate * 100) / 100,
      windowStart,
      windowEnd,
    };
  }

  private checkAlerts(): void {
    for (const slo of this.slos.values()) {
      const status = this.computeStatus(slo);
      if (status.totalEvents === 0) continue;

      // Budget exhausted
      if (status.budgetRemaining <= 0) {
        this.emitAlert(slo.id, 'budget_exhausted',
          `SLO "${slo.name}" error budget exhausted (${status.current} vs target ${slo.target})`,
          status.budgetRemaining, status.burnRate);
      }
      // Budget warning
      else if (status.budgetRemaining < this.budgetWarningThreshold * status.budgetTotal && status.budgetTotal > 0) {
        this.emitAlert(slo.id, 'budget_warning',
          `SLO "${slo.name}" error budget low (${Math.round(status.budgetRemaining * 10000) / 100}% remaining)`,
          status.budgetRemaining, status.burnRate);
      }

      // High burn rate
      if (status.burnRate > this.burnRateAlertMultiplier) {
        this.emitAlert(slo.id, 'burn_rate_high',
          `SLO "${slo.name}" burn rate ${status.burnRate}x normal`,
          status.budgetRemaining, status.burnRate);
      }
    }
  }

  private emitAlert(sloId: string, type: SloAlert['type'], message: string, budgetRemaining: number, burnRate: number): void {
    // Deduplicate: don't emit same alert type for same SLO within 60s
    const recent = this.alerts.find(a =>
      a.sloId === sloId && a.type === type && Date.now() - a.timestamp < 60_000
    );
    if (recent) return;

    this.alerts.push({
      id: `slo_alert_${++this.alertIdCounter}`,
      sloId,
      type,
      message,
      timestamp: Date.now(),
      budgetRemaining,
      burnRate,
    });
  }
}
