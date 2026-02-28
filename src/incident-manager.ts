/**
 * IncidentManager — Incident lifecycle tracking with status pages.
 *
 * Create and manage incidents, track status updates,
 * and provide status page data for service health communication.
 *
 * @example
 * ```ts
 * const mgr = new IncidentManager();
 *
 * const inc = mgr.createIncident({
 *   title: 'API Latency Spike',
 *   severity: 'major',
 *   affectedServices: ['api-gateway'],
 * });
 *
 * mgr.addUpdate(inc.id, { status: 'investigating', message: 'Identified high CPU on api-1' });
 * mgr.resolveIncident(inc.id, 'Scaled up api-1 instances');
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type IncidentSeverity = 'minor' | 'major' | 'critical';
export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';

export interface Incident {
  id: string;
  title: string;
  description: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  affectedServices: string[];
  updates: IncidentUpdate[];
  createdAt: number;
  resolvedAt: number | null;
  durationMs: number | null;
}

export interface IncidentCreateParams {
  title: string;
  description?: string;
  severity: IncidentSeverity;
  affectedServices?: string[];
}

export interface IncidentUpdate {
  status: IncidentStatus;
  message: string;
  timestamp: number;
}

export interface UpdateParams {
  status: IncidentStatus;
  message: string;
}

export interface StatusPageData {
  overallStatus: 'operational' | 'degraded' | 'major_outage';
  activeIncidents: Incident[];
  recentResolved: Incident[];
  serviceStatuses: { service: string; status: 'operational' | 'affected' }[];
}

export interface IncidentManagerConfig {
  /** Max incidents to track. Default 1000. */
  maxIncidents?: number;
  /** Max resolved incidents to show on status page. Default 10. */
  recentResolvedCount?: number;
}

export interface IncidentManagerStats {
  totalIncidents: number;
  activeIncidents: number;
  resolvedIncidents: number;
  avgResolutionMs: number;
  incidentsBySeverity: { minor: number; major: number; critical: number };
}

// ── Implementation ───────────────────────────────────────────────────

export class IncidentManager {
  private incidents = new Map<string, Incident>();
  private services = new Set<string>();
  private nextId = 1;

  private maxIncidents: number;
  private recentResolvedCount: number;

  constructor(config: IncidentManagerConfig = {}) {
    this.maxIncidents = config.maxIncidents ?? 1000;
    this.recentResolvedCount = config.recentResolvedCount ?? 10;
  }

  // ── Service Registration ──────────────────────────────────────

  /** Register a service for status tracking. */
  registerService(name: string): void {
    this.services.add(name);
  }

  /** List registered services. */
  listServices(): string[] {
    return [...this.services];
  }

  // ── Incident Lifecycle ────────────────────────────────────────

  /** Create an incident. */
  createIncident(params: IncidentCreateParams): Incident {
    if (!params.title) throw new Error('Incident title is required');
    if (this.incidents.size >= this.maxIncidents) {
      throw new Error(`Maximum ${this.maxIncidents} incidents reached`);
    }

    const incident: Incident = {
      id: `inc_${this.nextId++}`,
      title: params.title,
      description: params.description ?? '',
      severity: params.severity,
      status: 'investigating',
      affectedServices: params.affectedServices ?? [],
      updates: [{
        status: 'investigating',
        message: `Incident created: ${params.title}`,
        timestamp: Date.now(),
      }],
      createdAt: Date.now(),
      resolvedAt: null,
      durationMs: null,
    };

    // Auto-register affected services
    for (const svc of incident.affectedServices) {
      this.services.add(svc);
    }

    this.incidents.set(incident.id, incident);
    return incident;
  }

  /** Add a status update to an incident. */
  addUpdate(id: string, params: UpdateParams): Incident {
    const inc = this.incidents.get(id);
    if (!inc) throw new Error(`Incident '${id}' not found`);
    if (inc.status === 'resolved') throw new Error(`Incident '${id}' is already resolved`);

    inc.status = params.status;
    inc.updates.push({
      status: params.status,
      message: params.message,
      timestamp: Date.now(),
    });

    if (params.status === 'resolved') {
      inc.resolvedAt = Date.now();
      inc.durationMs = inc.resolvedAt - inc.createdAt;
    }

    return inc;
  }

  /** Resolve an incident. */
  resolveIncident(id: string, message: string): Incident {
    return this.addUpdate(id, { status: 'resolved', message });
  }

  /** Get incident by ID. */
  getIncident(id: string): Incident | null {
    return this.incidents.get(id) ?? null;
  }

  /** List incidents with optional filters. */
  listIncidents(options?: { status?: IncidentStatus; severity?: IncidentSeverity }): Incident[] {
    let results = [...this.incidents.values()];
    if (options?.status) results = results.filter(i => i.status === options.status);
    if (options?.severity) results = results.filter(i => i.severity === options.severity);
    return results.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Get active (unresolved) incidents. */
  getActiveIncidents(): Incident[] {
    return [...this.incidents.values()]
      .filter(i => i.status !== 'resolved')
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  // ── Status Page ───────────────────────────────────────────────

  /** Get status page data. */
  getStatusPage(): StatusPageData {
    const active = this.getActiveIncidents();
    const resolved = [...this.incidents.values()]
      .filter(i => i.status === 'resolved')
      .sort((a, b) => b.resolvedAt! - a.resolvedAt!)
      .slice(0, this.recentResolvedCount);

    // Determine overall status
    let overallStatus: 'operational' | 'degraded' | 'major_outage' = 'operational';
    if (active.some(i => i.severity === 'critical')) {
      overallStatus = 'major_outage';
    } else if (active.length > 0) {
      overallStatus = 'degraded';
    }

    // Service statuses
    const affectedSet = new Set<string>();
    for (const inc of active) {
      for (const svc of inc.affectedServices) affectedSet.add(svc);
    }

    const serviceStatuses = [...this.services].map(svc => ({
      service: svc,
      status: affectedSet.has(svc) ? 'affected' as const : 'operational' as const,
    }));

    return { overallStatus, activeIncidents: active, recentResolved: resolved, serviceStatuses };
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): IncidentManagerStats {
    let active = 0, resolved = 0;
    let totalResolutionMs = 0, resolvedCount = 0;
    const bySeverity = { minor: 0, major: 0, critical: 0 };

    for (const inc of this.incidents.values()) {
      if (inc.status === 'resolved') {
        resolved++;
        if (inc.durationMs) {
          totalResolutionMs += inc.durationMs;
          resolvedCount++;
        }
      } else {
        active++;
      }
      bySeverity[inc.severity]++;
    }

    return {
      totalIncidents: this.incidents.size,
      activeIncidents: active,
      resolvedIncidents: resolved,
      avgResolutionMs: resolvedCount > 0 ? Math.round(totalResolutionMs / resolvedCount) : 0,
      incidentsBySeverity: bySeverity,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.incidents.clear();
    this.services.clear();
  }
}
