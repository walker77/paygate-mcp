/**
 * MaintenanceWindowManager — Scheduled maintenance windows with traffic blocking.
 *
 * Schedule maintenance windows, check if the system is in maintenance,
 * and track maintenance history.
 *
 * @example
 * ```ts
 * const mgr = new MaintenanceWindowManager();
 *
 * mgr.scheduleWindow({
 *   name: 'DB Migration',
 *   startsAt: Date.now() + 3600000,
 *   durationMs: 1800000,
 *   message: 'Database maintenance in progress',
 * });
 *
 * const status = mgr.getStatus();
 * if (!status.operational) {
 *   // Block traffic, show maintenance message
 * }
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type WindowStatus = 'scheduled' | 'active' | 'completed' | 'cancelled';

export interface MaintenanceWindow {
  id: string;
  name: string;
  description: string;
  status: WindowStatus;
  message: string;
  startsAt: number;
  endsAt: number;
  durationMs: number;
  blockTraffic: boolean;
  affectedServices: string[];
  createdAt: number;
  completedAt: number | null;
}

export interface WindowScheduleParams {
  name: string;
  description?: string;
  startsAt: number;
  durationMs: number;
  message?: string;
  blockTraffic?: boolean;
  affectedServices?: string[];
}

export interface MaintenanceStatus {
  operational: boolean;
  activeWindows: MaintenanceWindow[];
  nextWindow: MaintenanceWindow | null;
  message: string | null;
}

export interface MaintenanceWindowConfig {
  /** Max windows to track. Default 500. */
  maxWindows?: number;
  /** Auto-complete windows when their end time passes. Default true. */
  autoComplete?: boolean;
}

export interface MaintenanceWindowStats {
  totalWindows: number;
  scheduledWindows: number;
  activeWindows: number;
  completedWindows: number;
  cancelledWindows: number;
  totalDowntimeMs: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class MaintenanceWindowManager {
  private windows = new Map<string, MaintenanceWindow>();
  private nextId = 1;

  private maxWindows: number;
  private autoComplete: boolean;

  constructor(config: MaintenanceWindowConfig = {}) {
    this.maxWindows = config.maxWindows ?? 500;
    this.autoComplete = config.autoComplete ?? true;
  }

  // ── Window Management ─────────────────────────────────────────

  /** Schedule a maintenance window. */
  scheduleWindow(params: WindowScheduleParams): MaintenanceWindow {
    if (!params.name) throw new Error('Window name is required');
    if (params.durationMs <= 0) throw new Error('Duration must be positive');
    if (this.windows.size >= this.maxWindows) {
      throw new Error(`Maximum ${this.maxWindows} windows reached`);
    }

    const window: MaintenanceWindow = {
      id: `mw_${this.nextId++}`,
      name: params.name,
      description: params.description ?? '',
      status: 'scheduled',
      message: params.message ?? 'System maintenance in progress',
      startsAt: params.startsAt,
      endsAt: params.startsAt + params.durationMs,
      durationMs: params.durationMs,
      blockTraffic: params.blockTraffic ?? true,
      affectedServices: params.affectedServices ?? [],
      createdAt: Date.now(),
      completedAt: null,
    };

    // Check if it should already be active
    const now = Date.now();
    if (now >= window.startsAt && now < window.endsAt) {
      window.status = 'active';
    }

    this.windows.set(window.id, window);
    return window;
  }

  /** Start a maintenance window immediately. */
  startNow(params: Omit<WindowScheduleParams, 'startsAt'>): MaintenanceWindow {
    return this.scheduleWindow({ ...params, startsAt: Date.now() });
  }

  /** Cancel a scheduled window. */
  cancelWindow(id: string): MaintenanceWindow {
    const w = this.windows.get(id);
    if (!w) throw new Error(`Window '${id}' not found`);
    if (w.status === 'completed' || w.status === 'cancelled') {
      throw new Error(`Window '${id}' is already ${w.status}`);
    }
    w.status = 'cancelled';
    w.completedAt = Date.now();
    return w;
  }

  /** Complete a window early. */
  completeWindow(id: string): MaintenanceWindow {
    const w = this.windows.get(id);
    if (!w) throw new Error(`Window '${id}' not found`);
    if (w.status === 'completed' || w.status === 'cancelled') {
      throw new Error(`Window '${id}' is already ${w.status}`);
    }
    w.status = 'completed';
    w.completedAt = Date.now();
    return w;
  }

  /** Get a window by ID. */
  getWindow(id: string): MaintenanceWindow | null {
    const w = this.windows.get(id) ?? null;
    if (w) this.updateWindowStatus(w);
    return w;
  }

  /** List all windows. */
  listWindows(options?: { status?: WindowStatus }): MaintenanceWindow[] {
    const all = [...this.windows.values()];
    for (const w of all) this.updateWindowStatus(w);

    if (options?.status) {
      return all.filter(w => w.status === options.status);
    }
    return all;
  }

  // ── Status ────────────────────────────────────────────────────

  /** Get current maintenance status. */
  getStatus(): MaintenanceStatus {
    const now = Date.now();
    const activeWindows: MaintenanceWindow[] = [];
    let nextWindow: MaintenanceWindow | null = null;
    let message: string | null = null;
    let operational = true;

    for (const w of this.windows.values()) {
      this.updateWindowStatus(w);

      if (w.status === 'active') {
        activeWindows.push(w);
        if (w.blockTraffic) {
          operational = false;
          message = w.message;
        }
      } else if (w.status === 'scheduled' && w.startsAt > now) {
        if (!nextWindow || w.startsAt < nextWindow.startsAt) {
          nextWindow = w;
        }
      }
    }

    return { operational, activeWindows, nextWindow, message };
  }

  /** Check if traffic should be blocked. */
  isBlocked(): boolean {
    return !this.getStatus().operational;
  }

  /** Check if a specific service is affected. */
  isServiceAffected(service: string): boolean {
    for (const w of this.windows.values()) {
      this.updateWindowStatus(w);
      if (w.status === 'active' && w.affectedServices.includes(service)) {
        return true;
      }
    }
    return false;
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): MaintenanceWindowStats {
    let scheduled = 0, active = 0, completed = 0, cancelled = 0, totalDowntime = 0;

    for (const w of this.windows.values()) {
      this.updateWindowStatus(w);

      switch (w.status) {
        case 'scheduled': scheduled++; break;
        case 'active': active++; totalDowntime += Date.now() - w.startsAt; break;
        case 'completed': completed++; totalDowntime += (w.completedAt ?? w.endsAt) - w.startsAt; break;
        case 'cancelled': cancelled++; break;
      }
    }

    return {
      totalWindows: this.windows.size,
      scheduledWindows: scheduled,
      activeWindows: active,
      completedWindows: completed,
      cancelledWindows: cancelled,
      totalDowntimeMs: totalDowntime,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.windows.clear();
  }

  // ── Private ───────────────────────────────────────────────────

  private updateWindowStatus(w: MaintenanceWindow): void {
    if (w.status !== 'scheduled' && w.status !== 'active') return;

    const now = Date.now();
    if (w.status === 'scheduled' && now >= w.startsAt && now < w.endsAt) {
      w.status = 'active';
    } else if (this.autoComplete && (w.status === 'active' || w.status === 'scheduled') && now >= w.endsAt) {
      w.status = 'completed';
      w.completedAt = w.endsAt;
    }
  }
}
