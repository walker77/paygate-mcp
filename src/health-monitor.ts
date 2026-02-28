/**
 * Health Check Monitor — Backend Health Monitoring.
 *
 * Monitor upstream MCP server health with periodic probes,
 * health history tracking, and configurable alert thresholds.
 *
 * Use cases:
 *   - Detect backend failures before users do
 *   - Track uptime SLA metrics
 *   - Auto-degrade to cached responses when backend is down
 *   - Dashboard health status display
 *
 * Zero external dependencies.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface HealthTarget {
  /** Unique target ID. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Health check interval in seconds. Default: 30. */
  intervalSeconds: number;
  /** Timeout for each check in ms. Default: 5000. */
  timeoutMs: number;
  /** Consecutive failures before unhealthy. Default: 3. */
  unhealthyThreshold: number;
  /** Consecutive successes before healthy again. Default: 2. */
  healthyThreshold: number;
  /** Whether this target is actively monitored. */
  active: boolean;
  /** Custom check function name/type. */
  checkType: 'ping' | 'tcp' | 'custom';
  /** When created (ISO). */
  createdAt: string;
}

export interface HealthCheckResult {
  /** Target ID. */
  targetId: string;
  /** Whether the check passed. */
  success: boolean;
  /** Response time in ms. */
  responseTimeMs: number;
  /** Error message (if failed). */
  error?: string;
  /** When this check was performed (ISO). */
  checkedAt: string;
}

export interface HealthSnapshot {
  /** Target ID. */
  targetId: string;
  /** Current status. */
  status: HealthStatus;
  /** Consecutive successes. */
  consecutiveSuccesses: number;
  /** Consecutive failures. */
  consecutiveFailures: number;
  /** Last check result. */
  lastCheck: HealthCheckResult | null;
  /** Average response time (last 10 checks, ms). */
  avgResponseTimeMs: number | null;
  /** Uptime percentage (last 100 checks). */
  uptimePercent: number;
  /** When status last changed (ISO). */
  lastStatusChange: string;
}

export interface HealthMonitorConfig {
  /** Maximum targets. Default: 100. */
  maxTargets?: number;
  /** Maximum history entries per target. Default: 1000. */
  maxHistory?: number;
}

export interface HealthMonitorStats {
  /** Total targets. */
  totalTargets: number;
  /** Active targets. */
  activeTargets: number;
  /** Healthy targets. */
  healthyTargets: number;
  /** Degraded targets. */
  degradedTargets: number;
  /** Unhealthy targets. */
  unhealthyTargets: number;
  /** Total checks performed. */
  totalChecks: number;
  /** Total failures detected. */
  totalFailures: number;
}

// ─── Internal State ──────────────────────────────────────────────────────────

interface TargetState {
  status: HealthStatus;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  history: HealthCheckResult[];
  lastStatusChange: string;
}

// ─── Health Monitor ──────────────────────────────────────────────────────────

export class HealthMonitor {
  private targets = new Map<string, HealthTarget>();
  private state = new Map<string, TargetState>();
  private maxTargets: number;
  private maxHistory: number;

  // Stats
  private totalChecks = 0;
  private totalFailures = 0;

  constructor(config: HealthMonitorConfig = {}) {
    this.maxTargets = config.maxTargets ?? 100;
    this.maxHistory = config.maxHistory ?? 1000;
  }

  /** Add or update a health target. */
  upsertTarget(target: Omit<HealthTarget, 'createdAt'> & { createdAt?: string }): boolean {
    if (this.targets.size >= this.maxTargets && !this.targets.has(target.id)) {
      return false;
    }

    this.targets.set(target.id, {
      ...target,
      createdAt: target.createdAt ?? new Date().toISOString(),
    });

    // Initialize state if new
    if (!this.state.has(target.id)) {
      this.state.set(target.id, {
        status: 'unknown',
        consecutiveSuccesses: 0,
        consecutiveFailures: 0,
        history: [],
        lastStatusChange: new Date().toISOString(),
      });
    }

    return true;
  }

  /** Remove a target. */
  removeTarget(id: string): boolean {
    this.state.delete(id);
    return this.targets.delete(id);
  }

  /** Get a target. */
  getTarget(id: string): HealthTarget | null {
    return this.targets.get(id) ?? null;
  }

  /** Get all targets. */
  getTargets(): HealthTarget[] {
    return [...this.targets.values()];
  }

  /**
   * Record a health check result.
   * Automatically updates status based on thresholds.
   */
  recordCheck(result: HealthCheckResult): HealthStatus {
    const target = this.targets.get(result.targetId);
    if (!target) return 'unknown';

    let state = this.state.get(result.targetId);
    if (!state) {
      state = {
        status: 'unknown',
        consecutiveSuccesses: 0,
        consecutiveFailures: 0,
        history: [],
        lastStatusChange: new Date().toISOString(),
      };
      this.state.set(result.targetId, state);
    }

    this.totalChecks++;

    // Record in history
    state.history.push(result);
    if (state.history.length > this.maxHistory) {
      state.history.splice(0, state.history.length - this.maxHistory);
    }

    // Update consecutive counts
    if (result.success) {
      state.consecutiveSuccesses++;
      state.consecutiveFailures = 0;
    } else {
      state.consecutiveFailures++;
      state.consecutiveSuccesses = 0;
      this.totalFailures++;
    }

    // Determine new status
    const oldStatus = state.status;
    if (state.consecutiveFailures >= target.unhealthyThreshold) {
      state.status = 'unhealthy';
    } else if (state.consecutiveFailures > 0 && state.consecutiveFailures < target.unhealthyThreshold) {
      state.status = 'degraded';
    } else if (state.consecutiveSuccesses >= target.healthyThreshold) {
      state.status = 'healthy';
    }

    if (state.status !== oldStatus) {
      state.lastStatusChange = result.checkedAt;
    }

    return state.status;
  }

  /** Get the current health snapshot for a target. */
  getSnapshot(targetId: string): HealthSnapshot | null {
    const target = this.targets.get(targetId);
    const state = this.state.get(targetId);
    if (!target || !state) return null;

    // Calculate average response time from last 10 checks
    const recent = state.history.slice(-10);
    const successfulRecent = recent.filter(r => r.success);
    const avgResponseTimeMs = successfulRecent.length > 0
      ? Math.round(successfulRecent.reduce((sum, r) => sum + r.responseTimeMs, 0) / successfulRecent.length)
      : null;

    // Calculate uptime from last 100 checks
    const last100 = state.history.slice(-100);
    const uptimePercent = last100.length > 0
      ? Math.round((last100.filter(r => r.success).length / last100.length) * 10000) / 100
      : 0;

    return {
      targetId,
      status: state.status,
      consecutiveSuccesses: state.consecutiveSuccesses,
      consecutiveFailures: state.consecutiveFailures,
      lastCheck: state.history.length > 0 ? state.history[state.history.length - 1] : null,
      avgResponseTimeMs,
      uptimePercent,
      lastStatusChange: state.lastStatusChange,
    };
  }

  /** Get snapshots for all targets. */
  getAllSnapshots(): HealthSnapshot[] {
    const snapshots: HealthSnapshot[] = [];
    for (const id of this.targets.keys()) {
      const snap = this.getSnapshot(id);
      if (snap) snapshots.push(snap);
    }
    return snapshots;
  }

  /** Get the overall system health. */
  getOverallHealth(): HealthStatus {
    const snapshots = this.getAllSnapshots();
    if (snapshots.length === 0) return 'unknown';

    const hasUnhealthy = snapshots.some(s => s.status === 'unhealthy');
    const hasDegraded = snapshots.some(s => s.status === 'degraded');
    const hasUnknown = snapshots.some(s => s.status === 'unknown');

    if (hasUnhealthy) return 'unhealthy';
    if (hasDegraded) return 'degraded';
    if (hasUnknown) return 'unknown';
    return 'healthy';
  }

  /** Get check history for a target. */
  getHistory(targetId: string, limit = 100): HealthCheckResult[] {
    const state = this.state.get(targetId);
    if (!state) return [];
    return state.history.slice(-limit);
  }

  /** Get targets that need checking (past their interval). */
  getDueTargets(): string[] {
    const now = Date.now();
    const due: string[] = [];

    for (const target of this.targets.values()) {
      if (!target.active) continue;

      const state = this.state.get(target.id);
      if (!state || state.history.length === 0) {
        due.push(target.id);
        continue;
      }

      const lastCheck = state.history[state.history.length - 1];
      const lastCheckTime = new Date(lastCheck.checkedAt).getTime();
      if (now - lastCheckTime >= target.intervalSeconds * 1000) {
        due.push(target.id);
      }
    }

    return due;
  }

  /** Get stats. */
  getStats(): HealthMonitorStats {
    const snapshots = this.getAllSnapshots();
    return {
      totalTargets: this.targets.size,
      activeTargets: [...this.targets.values()].filter(t => t.active).length,
      healthyTargets: snapshots.filter(s => s.status === 'healthy').length,
      degradedTargets: snapshots.filter(s => s.status === 'degraded').length,
      unhealthyTargets: snapshots.filter(s => s.status === 'unhealthy').length,
      totalChecks: this.totalChecks,
      totalFailures: this.totalFailures,
    };
  }

  /** Reset stats. */
  resetStats(): void {
    this.totalChecks = 0;
    this.totalFailures = 0;
  }

  /** Destroy and release resources. */
  destroy(): void {
    this.targets.clear();
    this.state.clear();
    this.resetStats();
  }
}
