/**
 * LoadBalancer — Distribute requests across backend instances.
 *
 * Route requests using round-robin, weighted, or least-connections
 * algorithms, track backend health, and record request metrics.
 *
 * @example
 * ```ts
 * const lb = new LoadBalancer();
 *
 * lb.addBackend({ name: 'api-1', url: 'http://localhost:3001', weight: 2 });
 * lb.addBackend({ name: 'api-2', url: 'http://localhost:3002', weight: 1 });
 *
 * const target = lb.pick(); // weighted round-robin
 * lb.recordRequest(target.name, 200, 45);
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type BalancingStrategy = 'round-robin' | 'weighted' | 'least-connections' | 'random';

export interface Backend {
  id: string;
  name: string;
  url: string;
  weight: number;
  healthy: boolean;
  activeConnections: number;
  totalRequests: number;
  totalErrors: number;
  avgLatencyMs: number;
  addedAt: number;
}

export interface BackendAddParams {
  name: string;
  url: string;
  weight?: number;
  healthy?: boolean;
}

export interface PickResult {
  backend: Backend;
  reason: string;
}

export interface LoadBalancerConfig {
  /** Balancing strategy. Default 'round-robin'. */
  strategy?: BalancingStrategy;
  /** Max backends. Default 50. */
  maxBackends?: number;
  /** Error threshold to auto-mark unhealthy. Default 5. */
  errorThreshold?: number;
}

export interface LoadBalancerStats {
  totalBackends: number;
  healthyBackends: number;
  unhealthyBackends: number;
  totalRequests: number;
  totalErrors: number;
  strategy: BalancingStrategy;
}

// ── Implementation ───────────────────────────────────────────────────

export class LoadBalancer {
  private backends = new Map<string, Backend>();
  private nextId = 1;
  private roundRobinIndex = 0;

  private strategy: BalancingStrategy;
  private maxBackends: number;
  private errorThreshold: number;

  // Stats
  private totalRequests = 0;
  private totalErrors = 0;

  constructor(config: LoadBalancerConfig = {}) {
    this.strategy = config.strategy ?? 'round-robin';
    this.maxBackends = config.maxBackends ?? 50;
    this.errorThreshold = config.errorThreshold ?? 5;
  }

  // ── Backend Management ────────────────────────────────────────

  /** Add a backend. */
  addBackend(params: BackendAddParams): Backend {
    if (!params.name) throw new Error('Backend name is required');
    if (!params.url) throw new Error('Backend URL is required');
    if (this.getBackendByName(params.name)) {
      throw new Error(`Backend '${params.name}' already exists`);
    }
    if (this.backends.size >= this.maxBackends) {
      throw new Error(`Maximum ${this.maxBackends} backends reached`);
    }

    const backend: Backend = {
      id: `be_${this.nextId++}`,
      name: params.name,
      url: params.url,
      weight: params.weight ?? 1,
      healthy: params.healthy ?? true,
      activeConnections: 0,
      totalRequests: 0,
      totalErrors: 0,
      avgLatencyMs: 0,
      addedAt: Date.now(),
    };

    this.backends.set(backend.id, backend);
    return backend;
  }

  /** Remove a backend. */
  removeBackend(name: string): boolean {
    const b = this.getBackendByName(name);
    if (!b) return false;
    return this.backends.delete(b.id);
  }

  /** Get backend by name. */
  getBackendByName(name: string): Backend | null {
    for (const b of this.backends.values()) {
      if (b.name === name) return b;
    }
    return null;
  }

  /** List all backends. */
  listBackends(): Backend[] {
    return [...this.backends.values()];
  }

  /** Set backend health. */
  setHealth(name: string, healthy: boolean): void {
    const b = this.getBackendByName(name);
    if (!b) throw new Error(`Backend '${name}' not found`);
    b.healthy = healthy;
    if (healthy) b.totalErrors = 0;
  }

  /** Set balancing strategy. */
  setStrategy(strategy: BalancingStrategy): void {
    this.strategy = strategy;
  }

  // ── Routing ───────────────────────────────────────────────────

  /** Pick a backend based on the current strategy. */
  pick(): PickResult | null {
    const healthy = [...this.backends.values()].filter(b => b.healthy);
    if (healthy.length === 0) return null;

    let selected: Backend;
    let reason: string;

    switch (this.strategy) {
      case 'round-robin': {
        this.roundRobinIndex = this.roundRobinIndex % healthy.length;
        selected = healthy[this.roundRobinIndex];
        reason = `Round-robin index ${this.roundRobinIndex}`;
        this.roundRobinIndex++;
        break;
      }
      case 'weighted': {
        const totalWeight = healthy.reduce((s, b) => s + b.weight, 0);
        let rand = Math.random() * totalWeight;
        selected = healthy[0];
        for (const b of healthy) {
          rand -= b.weight;
          if (rand <= 0) { selected = b; break; }
        }
        reason = `Weighted selection (weight ${selected.weight})`;
        break;
      }
      case 'least-connections': {
        selected = healthy.reduce((a, b) => a.activeConnections <= b.activeConnections ? a : b);
        reason = `Least connections (${selected.activeConnections} active)`;
        break;
      }
      case 'random': {
        selected = healthy[Math.floor(Math.random() * healthy.length)];
        reason = 'Random selection';
        break;
      }
      default:
        selected = healthy[0];
        reason = 'Fallback';
    }

    return { backend: selected, reason };
  }

  // ── Request Tracking ──────────────────────────────────────────

  /** Record a completed request. */
  recordRequest(name: string, statusCode: number, latencyMs: number): void {
    const b = this.getBackendByName(name);
    if (!b) throw new Error(`Backend '${name}' not found`);

    b.totalRequests++;
    this.totalRequests++;

    // Update avg latency with running average
    b.avgLatencyMs = ((b.avgLatencyMs * (b.totalRequests - 1)) + latencyMs) / b.totalRequests;

    if (statusCode >= 500) {
      b.totalErrors++;
      this.totalErrors++;

      // Auto-mark unhealthy if error threshold exceeded
      if (b.totalErrors >= this.errorThreshold) {
        b.healthy = false;
      }
    }
  }

  /** Increment active connections for a backend. */
  connect(name: string): void {
    const b = this.getBackendByName(name);
    if (!b) throw new Error(`Backend '${name}' not found`);
    b.activeConnections++;
  }

  /** Decrement active connections for a backend. */
  disconnect(name: string): void {
    const b = this.getBackendByName(name);
    if (!b) throw new Error(`Backend '${name}' not found`);
    if (b.activeConnections > 0) b.activeConnections--;
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): LoadBalancerStats {
    let healthy = 0, unhealthy = 0;
    for (const b of this.backends.values()) {
      if (b.healthy) healthy++;
      else unhealthy++;
    }

    return {
      totalBackends: this.backends.size,
      healthyBackends: healthy,
      unhealthyBackends: unhealthy,
      totalRequests: this.totalRequests,
      totalErrors: this.totalErrors,
      strategy: this.strategy,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.backends.clear();
    this.totalRequests = 0;
    this.totalErrors = 0;
    this.roundRobinIndex = 0;
  }
}
