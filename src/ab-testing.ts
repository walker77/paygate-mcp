/**
 * ABTestingManager — Experiment management with traffic splitting and metric tracking.
 *
 * Create experiments with variant groups, deterministically assign keys to variants,
 * record metrics per variant, and compute basic statistical results.
 *
 * @example
 * ```ts
 * const mgr = new ABTestingManager();
 *
 * mgr.createExperiment({
 *   name: 'pricing_test',
 *   variants: [
 *     { name: 'control', weight: 50, config: { priceMultiplier: 1.0 } },
 *     { name: 'higher_price', weight: 50, config: { priceMultiplier: 1.5 } },
 *   ],
 * });
 *
 * const variant = mgr.assignVariant('pricing_test', 'key_abc');
 * mgr.recordMetric('pricing_test', 'key_abc', 'revenue', 10);
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface Variant {
  name: string;
  weight: number; // relative weight for traffic splitting
  config: Record<string, unknown>;
}

export interface Experiment {
  id: string;
  name: string;
  description: string;
  variants: Variant[];
  status: 'draft' | 'running' | 'paused' | 'completed';
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
}

export interface ExperimentCreateParams {
  name: string;
  description?: string;
  variants: Variant[];
  autoStart?: boolean;
}

export interface VariantAssignment {
  experimentName: string;
  key: string;
  variant: string;
  assignedAt: number;
}

export interface MetricRecord {
  experimentName: string;
  key: string;
  variant: string;
  metric: string;
  value: number;
  timestamp: number;
}

export interface VariantMetrics {
  variant: string;
  sampleSize: number;
  metrics: Map<string, { count: number; sum: number; avg: number; min: number; max: number }>;
}

export interface ExperimentResults {
  name: string;
  status: string;
  totalAssignments: number;
  variants: VariantMetrics[];
}

export interface ABTestingConfig {
  /** Max experiments. Default 100. */
  maxExperiments?: number;
  /** Max assignments per experiment. Default 100000. */
  maxAssignments?: number;
}

export interface ABTestingStats {
  totalExperiments: number;
  runningExperiments: number;
  completedExperiments: number;
  totalAssignments: number;
  totalMetrics: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class ABTestingManager {
  private experiments = new Map<string, Experiment>();
  private assignments = new Map<string, Map<string, VariantAssignment>>(); // expName → key → assignment
  private metrics: MetricRecord[] = [];
  private nextId = 1;

  private maxExperiments: number;
  private maxAssignments: number;

  constructor(config: ABTestingConfig = {}) {
    this.maxExperiments = config.maxExperiments ?? 100;
    this.maxAssignments = config.maxAssignments ?? 100_000;
  }

  // ── Experiment Management ──────────────────────────────────────

  /** Create an experiment. */
  createExperiment(params: ExperimentCreateParams): Experiment {
    if (!params.name) throw new Error('Experiment name is required');
    if (this.getExperimentByName(params.name)) {
      throw new Error(`Experiment '${params.name}' already exists`);
    }
    if (!params.variants || params.variants.length < 2) {
      throw new Error('At least 2 variants are required');
    }
    if (this.experiments.size >= this.maxExperiments) {
      throw new Error(`Maximum ${this.maxExperiments} experiments reached`);
    }

    const totalWeight = params.variants.reduce((s, v) => s + v.weight, 0);
    if (totalWeight <= 0) throw new Error('Total variant weight must be positive');

    const experiment: Experiment = {
      id: `exp_${this.nextId++}`,
      name: params.name,
      description: params.description ?? '',
      variants: params.variants.map(v => ({ ...v })),
      status: params.autoStart ? 'running' : 'draft',
      startedAt: params.autoStart ? Date.now() : null,
      completedAt: null,
      createdAt: Date.now(),
    };

    this.experiments.set(experiment.id, experiment);
    this.assignments.set(experiment.name, new Map());
    return experiment;
  }

  /** Get experiment by name. */
  getExperimentByName(name: string): Experiment | null {
    for (const exp of this.experiments.values()) {
      if (exp.name === name) return exp;
    }
    return null;
  }

  /** Get experiment by ID. */
  getExperiment(id: string): Experiment | null {
    return this.experiments.get(id) ?? null;
  }

  /** List all experiments. */
  listExperiments(): Experiment[] {
    return [...this.experiments.values()];
  }

  /** Start an experiment. */
  startExperiment(name: string): void {
    const exp = this.getExperimentByName(name);
    if (!exp) throw new Error(`Experiment '${name}' not found`);
    if (exp.status === 'running') return;
    if (exp.status === 'completed') throw new Error('Cannot restart completed experiment');
    exp.status = 'running';
    exp.startedAt = exp.startedAt ?? Date.now();
  }

  /** Pause an experiment. */
  pauseExperiment(name: string): void {
    const exp = this.getExperimentByName(name);
    if (!exp) throw new Error(`Experiment '${name}' not found`);
    exp.status = 'paused';
  }

  /** Complete an experiment. */
  completeExperiment(name: string): void {
    const exp = this.getExperimentByName(name);
    if (!exp) throw new Error(`Experiment '${name}' not found`);
    exp.status = 'completed';
    exp.completedAt = Date.now();
  }

  /** Remove an experiment. */
  removeExperiment(name: string): boolean {
    const exp = this.getExperimentByName(name);
    if (!exp) return false;
    this.experiments.delete(exp.id);
    this.assignments.delete(name);
    this.metrics = this.metrics.filter(m => m.experimentName !== name);
    return true;
  }

  // ── Variant Assignment ─────────────────────────────────────────

  /** Assign a key to a variant (deterministic). */
  assignVariant(experimentName: string, key: string): VariantAssignment {
    const exp = this.getExperimentByName(experimentName);
    if (!exp) throw new Error(`Experiment '${experimentName}' not found`);
    if (exp.status !== 'running') throw new Error(`Experiment '${experimentName}' is not running`);

    const expAssignments = this.assignments.get(experimentName)!;

    // Return existing assignment if already assigned
    const existing = expAssignments.get(key);
    if (existing) return existing;

    // Deterministic bucket assignment
    const hash = this.hashKey(`${experimentName}:${key}`);
    const totalWeight = exp.variants.reduce((s, v) => s + v.weight, 0);
    const bucket = hash % totalWeight;

    let cumulative = 0;
    let assignedVariant = exp.variants[0].name;
    for (const variant of exp.variants) {
      cumulative += variant.weight;
      if (bucket < cumulative) {
        assignedVariant = variant.name;
        break;
      }
    }

    const assignment: VariantAssignment = {
      experimentName,
      key,
      variant: assignedVariant,
      assignedAt: Date.now(),
    };

    if (expAssignments.size >= this.maxAssignments) {
      throw new Error(`Maximum ${this.maxAssignments} assignments reached for experiment`);
    }

    expAssignments.set(key, assignment);
    return assignment;
  }

  /** Get the variant assignment for a key. */
  getAssignment(experimentName: string, key: string): VariantAssignment | null {
    return this.assignments.get(experimentName)?.get(key) ?? null;
  }

  /** Get variant config for an assigned key. */
  getVariantConfig(experimentName: string, key: string): Record<string, unknown> | null {
    const assignment = this.getAssignment(experimentName, key);
    if (!assignment) return null;
    const exp = this.getExperimentByName(experimentName);
    if (!exp) return null;
    const variant = exp.variants.find(v => v.name === assignment.variant);
    return variant?.config ?? null;
  }

  /** Get all assignments for an experiment. */
  getAssignments(experimentName: string): VariantAssignment[] {
    const m = this.assignments.get(experimentName);
    return m ? [...m.values()] : [];
  }

  // ── Metrics ────────────────────────────────────────────────────

  /** Record a metric for a key in an experiment. */
  recordMetric(experimentName: string, key: string, metric: string, value: number): MetricRecord {
    const assignment = this.getAssignment(experimentName, key);
    if (!assignment) throw new Error(`Key '${key}' not assigned to experiment '${experimentName}'`);

    const record: MetricRecord = {
      experimentName,
      key,
      variant: assignment.variant,
      metric,
      value,
      timestamp: Date.now(),
    };

    this.metrics.push(record);
    return record;
  }

  /** Get experiment results with per-variant metrics. */
  getResults(experimentName: string): ExperimentResults {
    const exp = this.getExperimentByName(experimentName);
    if (!exp) throw new Error(`Experiment '${experimentName}' not found`);

    const expAssignments = this.assignments.get(experimentName)!;
    const expMetrics = this.metrics.filter(m => m.experimentName === experimentName);

    // Group metrics by variant
    const variantData = new Map<string, { keys: Set<string>; metrics: Map<string, number[]> }>();
    for (const v of exp.variants) {
      variantData.set(v.name, { keys: new Set(), metrics: new Map() });
    }

    // Count assignments per variant
    for (const a of expAssignments.values()) {
      const vd = variantData.get(a.variant);
      if (vd) vd.keys.add(a.key);
    }

    // Aggregate metrics
    for (const m of expMetrics) {
      const vd = variantData.get(m.variant);
      if (!vd) continue;
      if (!vd.metrics.has(m.metric)) vd.metrics.set(m.metric, []);
      vd.metrics.get(m.metric)!.push(m.value);
    }

    const variants: VariantMetrics[] = [];
    for (const [variantName, data] of variantData) {
      const metricsMap = new Map<string, { count: number; sum: number; avg: number; min: number; max: number }>();
      for (const [metricName, values] of data.metrics) {
        const sum = values.reduce((s, v) => s + v, 0);
        metricsMap.set(metricName, {
          count: values.length,
          sum,
          avg: values.length > 0 ? sum / values.length : 0,
          min: values.length > 0 ? Math.min(...values) : 0,
          max: values.length > 0 ? Math.max(...values) : 0,
        });
      }
      variants.push({
        variant: variantName,
        sampleSize: data.keys.size,
        metrics: metricsMap,
      });
    }

    return {
      name: experimentName,
      status: exp.status,
      totalAssignments: expAssignments.size,
      variants,
    };
  }

  // ── Stats ───────────────────────────────────────────────────────

  getStats(): ABTestingStats {
    let running = 0;
    let completed = 0;
    let totalAssignments = 0;

    for (const exp of this.experiments.values()) {
      if (exp.status === 'running') running++;
      if (exp.status === 'completed') completed++;
    }
    for (const m of this.assignments.values()) {
      totalAssignments += m.size;
    }

    return {
      totalExperiments: this.experiments.size,
      runningExperiments: running,
      completedExperiments: completed,
      totalAssignments,
      totalMetrics: this.metrics.length,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.experiments.clear();
    this.assignments.clear();
    this.metrics = [];
  }

  // ── Private ─────────────────────────────────────────────────────

  private hashKey(input: string): number {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const chr = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return Math.abs(hash);
  }
}
