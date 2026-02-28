/**
 * CapacityPlanner — Resource forecasting based on historical usage patterns.
 *
 * Track resource utilization samples, compute trends, forecast future capacity needs,
 * and generate capacity alerts when thresholds are projected to be reached.
 *
 * @example
 * ```ts
 * const planner = new CapacityPlanner();
 *
 * planner.addResource({ name: 'api_calls', capacity: 10000, unit: 'calls/day' });
 *
 * planner.recordSample('api_calls', 5000);
 * planner.recordSample('api_calls', 5500);
 * planner.recordSample('api_calls', 6200);
 *
 * const forecast = planner.forecast('api_calls', 30); // 30 periods ahead
 * const alerts = planner.getAlerts();
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface Resource {
  id: string;
  name: string;
  capacity: number;
  unit: string;
  warningThreshold: number; // 0-1, default 0.8
  criticalThreshold: number; // 0-1, default 0.95
  createdAt: number;
}

export interface ResourceCreateParams {
  name: string;
  capacity: number;
  unit?: string;
  warningThreshold?: number;
  criticalThreshold?: number;
}

export interface CapacitySample {
  resourceName: string;
  value: number;
  timestamp: number;
}

export interface ForecastPoint {
  period: number;
  predictedValue: number;
  utilizationPercent: number;
  confidence: number; // 0-1, decreases with distance
}

export interface ForecastResult {
  resourceName: string;
  currentValue: number;
  currentUtilization: number;
  trend: 'growing' | 'declining' | 'stable';
  growthRate: number; // per period
  forecast: ForecastPoint[];
  periodsUntilWarning: number | null;
  periodsUntilCritical: number | null;
  periodsUntilCapacity: number | null;
}

export type AlertSeverity = 'warning' | 'critical' | 'capacity_reached';

export interface CapacityAlert {
  id: string;
  resourceName: string;
  severity: AlertSeverity;
  currentValue: number;
  capacity: number;
  utilization: number;
  message: string;
  timestamp: number;
}

export interface CapacityPlannerConfig {
  /** Min samples for forecasting. Default 3. */
  minSamples?: number;
  /** Max samples per resource. Default 10000. */
  maxSamples?: number;
  /** Max resources. Default 100. */
  maxResources?: number;
}

export interface CapacityPlannerStats {
  totalResources: number;
  totalSamples: number;
  totalAlerts: number;
  resourcesAtWarning: number;
  resourcesAtCritical: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class CapacityPlanner {
  private resources = new Map<string, Resource>();
  private samples = new Map<string, CapacitySample[]>(); // resourceName → samples
  private alerts: CapacityAlert[] = [];
  private nextResourceId = 1;
  private nextAlertId = 1;

  private minSamples: number;
  private maxSamples: number;
  private maxResources: number;

  constructor(config: CapacityPlannerConfig = {}) {
    this.minSamples = config.minSamples ?? 3;
    this.maxSamples = config.maxSamples ?? 10_000;
    this.maxResources = config.maxResources ?? 100;
  }

  // ── Resource Management ────────────────────────────────────────

  /** Add a resource to track. */
  addResource(params: ResourceCreateParams): Resource {
    if (!params.name) throw new Error('Resource name is required');
    if (params.capacity <= 0) throw new Error('Capacity must be positive');
    if (this.getResourceByName(params.name)) {
      throw new Error(`Resource '${params.name}' already exists`);
    }
    if (this.resources.size >= this.maxResources) {
      throw new Error(`Maximum ${this.maxResources} resources reached`);
    }

    const resource: Resource = {
      id: `res_${this.nextResourceId++}`,
      name: params.name,
      capacity: params.capacity,
      unit: params.unit ?? 'units',
      warningThreshold: Math.min(1, Math.max(0, params.warningThreshold ?? 0.8)),
      criticalThreshold: Math.min(1, Math.max(0, params.criticalThreshold ?? 0.95)),
      createdAt: Date.now(),
    };

    this.resources.set(resource.id, resource);
    this.samples.set(resource.name, []);
    return resource;
  }

  /** Get resource by name. */
  getResourceByName(name: string): Resource | null {
    for (const r of this.resources.values()) {
      if (r.name === name) return r;
    }
    return null;
  }

  /** Get resource by ID. */
  getResource(id: string): Resource | null {
    return this.resources.get(id) ?? null;
  }

  /** List all resources. */
  listResources(): Resource[] {
    return [...this.resources.values()];
  }

  /** Remove a resource. */
  removeResource(name: string): boolean {
    const r = this.getResourceByName(name);
    if (!r) return false;
    this.resources.delete(r.id);
    this.samples.delete(name);
    return true;
  }

  /** Update resource capacity. */
  setCapacity(name: string, capacity: number): void {
    if (capacity <= 0) throw new Error('Capacity must be positive');
    const r = this.getResourceByName(name);
    if (!r) throw new Error(`Resource '${name}' not found`);
    r.capacity = capacity;
  }

  // ── Sampling ───────────────────────────────────────────────────

  /** Record a utilization sample. */
  recordSample(resourceName: string, value: number): CapacitySample {
    const resource = this.getResourceByName(resourceName);
    if (!resource) throw new Error(`Resource '${resourceName}' not found`);

    const sampleList = this.samples.get(resourceName)!;
    const sample: CapacitySample = {
      resourceName,
      value,
      timestamp: Date.now(),
    };

    sampleList.push(sample);

    // Evict oldest if over limit
    if (sampleList.length > this.maxSamples) {
      sampleList.splice(0, sampleList.length - this.maxSamples);
    }

    // Check for alerts
    this.checkAlerts(resource, value);

    return sample;
  }

  /** Get samples for a resource. */
  getSamples(resourceName: string): CapacitySample[] {
    return this.samples.get(resourceName) ?? [];
  }

  // ── Forecasting ────────────────────────────────────────────────

  /** Forecast future capacity needs. */
  forecast(resourceName: string, periods: number = 30): ForecastResult {
    const resource = this.getResourceByName(resourceName);
    if (!resource) throw new Error(`Resource '${resourceName}' not found`);

    const sampleList = this.samples.get(resourceName)!;
    const values = sampleList.map(s => s.value);

    if (values.length === 0) {
      return {
        resourceName,
        currentValue: 0,
        currentUtilization: 0,
        trend: 'stable',
        growthRate: 0,
        forecast: [],
        periodsUntilWarning: null,
        periodsUntilCritical: null,
        periodsUntilCapacity: null,
      };
    }

    const currentValue = values[values.length - 1];
    const currentUtilization = currentValue / resource.capacity;

    // Linear regression for trend
    const { slope, intercept } = this.linearRegression(values);
    const growthRate = slope;

    // Determine trend
    let trend: 'growing' | 'declining' | 'stable' = 'stable';
    const avgValue = values.reduce((s, v) => s + v, 0) / values.length;
    if (avgValue > 0) {
      const relativeGrowth = Math.abs(slope) / avgValue;
      if (relativeGrowth > 0.01) {
        trend = slope > 0 ? 'growing' : 'declining';
      }
    }

    // Generate forecast points
    const forecast: ForecastPoint[] = [];
    const n = values.length;

    for (let p = 1; p <= periods; p++) {
      const predicted = intercept + slope * (n + p - 1);
      const clampedPredicted = Math.max(0, predicted);
      const confidence = Math.max(0, 1 - (p / (periods * 2)));

      forecast.push({
        period: p,
        predictedValue: Math.round(clampedPredicted * 100) / 100,
        utilizationPercent: Math.round((clampedPredicted / resource.capacity) * 10000) / 100,
        confidence: Math.round(confidence * 100) / 100,
      });
    }

    // Calculate periods until thresholds
    const warningValue = resource.capacity * resource.warningThreshold;
    const criticalValue = resource.capacity * resource.criticalThreshold;

    const periodsUntilWarning = this.periodsUntil(currentValue, slope, warningValue);
    const periodsUntilCritical = this.periodsUntil(currentValue, slope, criticalValue);
    const periodsUntilCapacity = this.periodsUntil(currentValue, slope, resource.capacity);

    return {
      resourceName,
      currentValue,
      currentUtilization: Math.round(currentUtilization * 10000) / 100,
      trend,
      growthRate: Math.round(growthRate * 100) / 100,
      forecast,
      periodsUntilWarning: currentValue >= warningValue ? 0 : periodsUntilWarning,
      periodsUntilCritical: currentValue >= criticalValue ? 0 : periodsUntilCritical,
      periodsUntilCapacity: currentValue >= resource.capacity ? 0 : periodsUntilCapacity,
    };
  }

  // ── Alerts ─────────────────────────────────────────────────────

  /** Get all active alerts. */
  getAlerts(): CapacityAlert[] {
    return [...this.alerts].sort((a, b) => b.timestamp - a.timestamp);
  }

  /** Get alerts for a specific resource. */
  getResourceAlerts(resourceName: string): CapacityAlert[] {
    return this.alerts.filter(a => a.resourceName === resourceName);
  }

  /** Clear alerts. */
  clearAlerts(): void {
    this.alerts = [];
  }

  // ── Stats ───────────────────────────────────────────────────────

  getStats(): CapacityPlannerStats {
    let totalSamples = 0;
    let atWarning = 0;
    let atCritical = 0;

    for (const [name, sampleList] of this.samples) {
      totalSamples += sampleList.length;
      const resource = this.getResourceByName(name);
      if (resource && sampleList.length > 0) {
        const lastValue = sampleList[sampleList.length - 1].value;
        const util = lastValue / resource.capacity;
        if (util >= resource.criticalThreshold) atCritical++;
        else if (util >= resource.warningThreshold) atWarning++;
      }
    }

    return {
      totalResources: this.resources.size,
      totalSamples,
      totalAlerts: this.alerts.length,
      resourcesAtWarning: atWarning,
      resourcesAtCritical: atCritical,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.resources.clear();
    this.samples.clear();
    this.alerts = [];
  }

  // ── Private ─────────────────────────────────────────────────────

  private linearRegression(values: number[]): { slope: number; intercept: number } {
    const n = values.length;
    if (n < 2) return { slope: 0, intercept: values[0] ?? 0 };

    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += values[i];
      sumXY += i * values[i];
      sumX2 += i * i;
    }

    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) return { slope: 0, intercept: sumY / n };

    const slope = (n * sumXY - sumX * sumY) / denominator;
    const intercept = (sumY - slope * sumX) / n;

    return { slope, intercept };
  }

  private periodsUntil(current: number, rate: number, target: number): number | null {
    if (rate <= 0) return null; // Not growing, won't reach target
    if (current >= target) return 0;
    return Math.ceil((target - current) / rate);
  }

  private checkAlerts(resource: Resource, value: number): void {
    const utilization = value / resource.capacity;

    if (utilization >= 1) {
      this.alerts.push({
        id: `alert_${this.nextAlertId++}`,
        resourceName: resource.name,
        severity: 'capacity_reached',
        currentValue: value,
        capacity: resource.capacity,
        utilization: Math.round(utilization * 10000) / 100,
        message: `${resource.name} has reached capacity: ${value}/${resource.capacity} ${resource.unit}`,
        timestamp: Date.now(),
      });
    } else if (utilization >= resource.criticalThreshold) {
      this.alerts.push({
        id: `alert_${this.nextAlertId++}`,
        resourceName: resource.name,
        severity: 'critical',
        currentValue: value,
        capacity: resource.capacity,
        utilization: Math.round(utilization * 10000) / 100,
        message: `${resource.name} at critical utilization: ${Math.round(utilization * 100)}%`,
        timestamp: Date.now(),
      });
    } else if (utilization >= resource.warningThreshold) {
      this.alerts.push({
        id: `alert_${this.nextAlertId++}`,
        resourceName: resource.name,
        severity: 'warning',
        currentValue: value,
        capacity: resource.capacity,
        utilization: Math.round(utilization * 10000) / 100,
        message: `${resource.name} at warning utilization: ${Math.round(utilization * 100)}%`,
        timestamp: Date.now(),
      });
    }
  }
}
