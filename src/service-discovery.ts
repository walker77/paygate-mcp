/**
 * ServiceDiscovery — Auto-discover and register upstream MCP servers with health checking.
 *
 * Register services with endpoints, run periodic health checks,
 * track service status, and route to healthy instances.
 *
 * @example
 * ```ts
 * const sd = new ServiceDiscovery();
 *
 * sd.registerService({
 *   name: 'search-server',
 *   endpoint: 'http://localhost:3001',
 *   healthEndpoint: '/health',
 * });
 *
 * sd.checkHealth('search-server');
 * const healthy = sd.getHealthyServices();
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type ServiceStatus = 'unknown' | 'healthy' | 'unhealthy' | 'degraded';

export interface ServiceInstance {
  id: string;
  name: string;
  endpoint: string;
  healthEndpoint: string;
  status: ServiceStatus;
  metadata: Record<string, unknown>;
  weight: number;
  lastCheck: number | null;
  lastHealthy: number | null;
  consecutiveFailures: number;
  registeredAt: number;
}

export interface ServiceRegisterParams {
  name: string;
  endpoint: string;
  healthEndpoint?: string;
  metadata?: Record<string, unknown>;
  weight?: number;
}

export interface HealthCheckResult {
  serviceId: string;
  serviceName: string;
  status: ServiceStatus;
  latencyMs: number;
  timestamp: number;
  error?: string;
}

export interface ServiceDiscoveryConfig {
  /** Max services. Default 100. */
  maxServices?: number;
  /** Consecutive failures before marking unhealthy. Default 3. */
  unhealthyThreshold?: number;
  /** Max health check history per service. Default 100. */
  maxHistoryPerService?: number;
}

export interface ServiceDiscoveryStats {
  totalServices: number;
  healthyServices: number;
  unhealthyServices: number;
  degradedServices: number;
  totalHealthChecks: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class ServiceDiscovery {
  private services = new Map<string, ServiceInstance>();
  private healthHistory = new Map<string, HealthCheckResult[]>(); // serviceId → history
  private nextId = 1;

  private maxServices: number;
  private unhealthyThreshold: number;
  private maxHistoryPerService: number;

  // Stats
  private totalHealthChecks = 0;

  constructor(config: ServiceDiscoveryConfig = {}) {
    this.maxServices = config.maxServices ?? 100;
    this.unhealthyThreshold = config.unhealthyThreshold ?? 3;
    this.maxHistoryPerService = config.maxHistoryPerService ?? 100;
  }

  // ── Registration ───────────────────────────────────────────────

  /** Register a service. */
  registerService(params: ServiceRegisterParams): ServiceInstance {
    if (!params.name) throw new Error('Service name is required');
    if (!params.endpoint) throw new Error('Endpoint is required');
    if (this.services.size >= this.maxServices) {
      throw new Error(`Maximum ${this.maxServices} services reached`);
    }

    const service: ServiceInstance = {
      id: `svc_${this.nextId++}`,
      name: params.name,
      endpoint: params.endpoint,
      healthEndpoint: params.healthEndpoint ?? '/health',
      status: 'unknown',
      metadata: params.metadata ?? {},
      weight: params.weight ?? 1,
      lastCheck: null,
      lastHealthy: null,
      consecutiveFailures: 0,
      registeredAt: Date.now(),
    };

    this.services.set(service.id, service);
    this.healthHistory.set(service.id, []);
    return service;
  }

  /** Deregister a service. */
  deregisterService(id: string): boolean {
    this.healthHistory.delete(id);
    return this.services.delete(id);
  }

  /** Get service by ID. */
  getService(id: string): ServiceInstance | null {
    return this.services.get(id) ?? null;
  }

  /** Get services by name. */
  getServicesByName(name: string): ServiceInstance[] {
    return [...this.services.values()].filter(s => s.name === name);
  }

  /** List all services. */
  listServices(): ServiceInstance[] {
    return [...this.services.values()];
  }

  // ── Health Checking ────────────────────────────────────────────

  /**
   * Perform a health check on a service (simulated).
   * In production this would make an HTTP request; here we use a callback.
   */
  checkHealth(serviceId: string, healthy: boolean = true, latencyMs: number = 10): HealthCheckResult {
    const service = this.services.get(serviceId);
    if (!service) throw new Error(`Service '${serviceId}' not found`);

    const now = Date.now();
    const result: HealthCheckResult = {
      serviceId,
      serviceName: service.name,
      status: healthy ? 'healthy' : 'unhealthy',
      latencyMs,
      timestamp: now,
    };

    if (!healthy) {
      result.error = 'Health check failed';
      service.consecutiveFailures++;
    } else {
      service.consecutiveFailures = 0;
      service.lastHealthy = now;
    }

    service.lastCheck = now;

    // Update status based on consecutive failures
    if (service.consecutiveFailures >= this.unhealthyThreshold) {
      service.status = 'unhealthy';
    } else if (service.consecutiveFailures > 0) {
      service.status = 'degraded';
    } else {
      service.status = 'healthy';
    }

    result.status = service.status;

    // Store in history
    const history = this.healthHistory.get(serviceId)!;
    history.push(result);
    if (history.length > this.maxHistoryPerService) {
      history.splice(0, history.length - this.maxHistoryPerService);
    }

    this.totalHealthChecks++;
    return result;
  }

  /** Check all services. */
  checkAllHealth(results?: Map<string, boolean>): HealthCheckResult[] {
    const checks: HealthCheckResult[] = [];
    for (const service of this.services.values()) {
      const healthy = results?.get(service.id) ?? true;
      checks.push(this.checkHealth(service.id, healthy));
    }
    return checks;
  }

  // ── Routing ────────────────────────────────────────────────────

  /** Get healthy services for a name (for load balancing). */
  getHealthyServices(name?: string): ServiceInstance[] {
    let services = [...this.services.values()].filter(s => s.status === 'healthy');
    if (name) {
      services = services.filter(s => s.name === name);
    }
    return services.sort((a, b) => b.weight - a.weight);
  }

  /** Pick a service instance using weighted selection. */
  pickService(name: string): ServiceInstance | null {
    const healthy = this.getHealthyServices(name);
    if (healthy.length === 0) return null;

    const totalWeight = healthy.reduce((s, svc) => s + svc.weight, 0);
    let rand = Math.random() * totalWeight;

    for (const svc of healthy) {
      rand -= svc.weight;
      if (rand <= 0) return svc;
    }

    return healthy[0];
  }

  // ── History ────────────────────────────────────────────────────

  /** Get health check history for a service. */
  getHealthHistory(serviceId: string): HealthCheckResult[] {
    return this.healthHistory.get(serviceId) ?? [];
  }

  /** Get uptime percentage for a service (from history). */
  getUptime(serviceId: string): number {
    const history = this.healthHistory.get(serviceId);
    if (!history || history.length === 0) return 0;

    const healthy = history.filter(h => h.status === 'healthy').length;
    return Math.round((healthy / history.length) * 10000) / 100;
  }

  /** Get average latency for a service. */
  getAverageLatency(serviceId: string): number {
    const history = this.healthHistory.get(serviceId);
    if (!history || history.length === 0) return 0;

    const total = history.reduce((s, h) => s + h.latencyMs, 0);
    return Math.round((total / history.length) * 100) / 100;
  }

  // ── Stats ───────────────────────────────────────────────────────

  getStats(): ServiceDiscoveryStats {
    let healthy = 0, unhealthy = 0, degraded = 0;
    for (const s of this.services.values()) {
      if (s.status === 'healthy') healthy++;
      else if (s.status === 'unhealthy') unhealthy++;
      else if (s.status === 'degraded') degraded++;
    }

    return {
      totalServices: this.services.size,
      healthyServices: healthy,
      unhealthyServices: unhealthy,
      degradedServices: degraded,
      totalHealthChecks: this.totalHealthChecks,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.services.clear();
    this.healthHistory.clear();
    this.totalHealthChecks = 0;
  }
}
