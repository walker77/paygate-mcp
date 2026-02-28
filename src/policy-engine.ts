/**
 * PolicyEngine — Declarative access control rules with condition evaluation.
 *
 * Define allow/deny policies with conditions, evaluate requests against
 * all matching policies, and track evaluation history.
 *
 * @example
 * ```ts
 * const engine = new PolicyEngine();
 *
 * engine.addPolicy({
 *   name: 'block_expensive_tools',
 *   effect: 'deny',
 *   conditions: { tool: ['expensive_search'] },
 *   priority: 10,
 * });
 *
 * engine.addPolicy({
 *   name: 'allow_vip',
 *   effect: 'allow',
 *   conditions: { key: ['key_vip'] },
 *   priority: 20,
 * });
 *
 * const result = engine.evaluate({ tool: 'expensive_search', key: 'key_vip' });
 * // result.effect === 'allow' (higher priority wins)
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type PolicyEffect = 'allow' | 'deny';

export interface PolicyConditions {
  /** Match specific tools. */
  tool?: string[];
  /** Match specific keys. */
  key?: string[];
  /** Match specific IP addresses. */
  ip?: string[];
  /** Match specific time ranges (ISO timestamps). */
  after?: string;
  before?: string;
  /** Custom condition key-value pairs. */
  [custom: string]: unknown;
}

export interface Policy {
  id: string;
  name: string;
  description: string;
  effect: PolicyEffect;
  conditions: PolicyConditions;
  priority: number;
  enabled: boolean;
  createdAt: number;
}

export interface PolicyCreateParams {
  name: string;
  description?: string;
  effect: PolicyEffect;
  conditions: PolicyConditions;
  priority?: number;
  enabled?: boolean;
}

export interface EvaluationRequest {
  tool?: string;
  key?: string;
  ip?: string;
  timestamp?: number;
  [custom: string]: unknown;
}

export interface EvaluationResult {
  effect: PolicyEffect;
  matchedPolicy: string | null;
  matchedPolicies: string[];
  reason: string;
  timestamp: number;
}

export interface PolicyEngineConfig {
  /** Default effect when no policies match. Default 'allow'. */
  defaultEffect?: PolicyEffect;
  /** Max policies. Default 500. */
  maxPolicies?: number;
  /** Max evaluation history. Default 10000. */
  maxHistory?: number;
}

export interface PolicyEngineStats {
  totalPolicies: number;
  enabledPolicies: number;
  allowPolicies: number;
  denyPolicies: number;
  totalEvaluations: number;
  totalAllowed: number;
  totalDenied: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class PolicyEngine {
  private policies = new Map<string, Policy>();
  private evaluationHistory: EvaluationResult[] = [];
  private nextId = 1;

  private defaultEffect: PolicyEffect;
  private maxPolicies: number;
  private maxHistory: number;

  // Stats
  private totalEvaluations = 0;
  private totalAllowed = 0;
  private totalDenied = 0;

  constructor(config: PolicyEngineConfig = {}) {
    this.defaultEffect = config.defaultEffect ?? 'allow';
    this.maxPolicies = config.maxPolicies ?? 500;
    this.maxHistory = config.maxHistory ?? 10_000;
  }

  // ── Policy Management ──────────────────────────────────────────

  /** Add a policy. */
  addPolicy(params: PolicyCreateParams): Policy {
    if (!params.name) throw new Error('Policy name is required');
    if (this.getPolicyByName(params.name)) {
      throw new Error(`Policy '${params.name}' already exists`);
    }
    if (this.policies.size >= this.maxPolicies) {
      throw new Error(`Maximum ${this.maxPolicies} policies reached`);
    }

    const policy: Policy = {
      id: `pol_${this.nextId++}`,
      name: params.name,
      description: params.description ?? '',
      effect: params.effect,
      conditions: { ...params.conditions },
      priority: params.priority ?? 0,
      enabled: params.enabled ?? true,
      createdAt: Date.now(),
    };

    this.policies.set(policy.id, policy);
    return policy;
  }

  /** Get policy by name. */
  getPolicyByName(name: string): Policy | null {
    for (const p of this.policies.values()) {
      if (p.name === name) return p;
    }
    return null;
  }

  /** Get policy by ID. */
  getPolicy(id: string): Policy | null {
    return this.policies.get(id) ?? null;
  }

  /** List all policies sorted by priority (highest first). */
  listPolicies(): Policy[] {
    return [...this.policies.values()].sort((a, b) => b.priority - a.priority);
  }

  /** Remove a policy. */
  removePolicy(name: string): boolean {
    const p = this.getPolicyByName(name);
    if (!p) return false;
    return this.policies.delete(p.id);
  }

  /** Enable/disable a policy. */
  setPolicyEnabled(name: string, enabled: boolean): void {
    const p = this.getPolicyByName(name);
    if (!p) throw new Error(`Policy '${name}' not found`);
    p.enabled = enabled;
  }

  // ── Evaluation ─────────────────────────────────────────────────

  /** Evaluate a request against all policies. Highest priority matching policy wins. */
  evaluate(request: EvaluationRequest): EvaluationResult {
    const sorted = this.listPolicies().filter(p => p.enabled);
    const matchedPolicies: string[] = [];
    let winningPolicy: Policy | null = null;

    for (const policy of sorted) {
      if (this.matchesConditions(policy.conditions, request)) {
        matchedPolicies.push(policy.name);
        if (!winningPolicy) {
          winningPolicy = policy; // highest priority match
        }
      }
    }

    const effect = winningPolicy ? winningPolicy.effect : this.defaultEffect;
    const result: EvaluationResult = {
      effect,
      matchedPolicy: winningPolicy?.name ?? null,
      matchedPolicies,
      reason: winningPolicy
        ? `Matched policy '${winningPolicy.name}' (priority ${winningPolicy.priority})`
        : `No matching policy, default effect: ${this.defaultEffect}`,
      timestamp: Date.now(),
    };

    this.totalEvaluations++;
    if (effect === 'allow') this.totalAllowed++;
    else this.totalDenied++;

    this.evaluationHistory.push(result);
    if (this.evaluationHistory.length > this.maxHistory) {
      this.evaluationHistory.splice(0, this.evaluationHistory.length - this.maxHistory);
    }

    return result;
  }

  /** Evaluate and return only the effect. */
  isAllowed(request: EvaluationRequest): boolean {
    return this.evaluate(request).effect === 'allow';
  }

  // ── History ────────────────────────────────────────────────────

  /** Get evaluation history. */
  getEvaluationHistory(limit?: number): EvaluationResult[] {
    const l = limit ?? 100;
    return this.evaluationHistory.slice(-l);
  }

  // ── Stats ───────────────────────────────────────────────────────

  getStats(): PolicyEngineStats {
    let enabled = 0, allow = 0, deny = 0;
    for (const p of this.policies.values()) {
      if (p.enabled) enabled++;
      if (p.effect === 'allow') allow++;
      else deny++;
    }

    return {
      totalPolicies: this.policies.size,
      enabledPolicies: enabled,
      allowPolicies: allow,
      denyPolicies: deny,
      totalEvaluations: this.totalEvaluations,
      totalAllowed: this.totalAllowed,
      totalDenied: this.totalDenied,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.policies.clear();
    this.evaluationHistory = [];
    this.totalEvaluations = 0;
    this.totalAllowed = 0;
    this.totalDenied = 0;
  }

  // ── Private ─────────────────────────────────────────────────────

  private matchesConditions(conditions: PolicyConditions, request: EvaluationRequest): boolean {
    // Tool match
    if (conditions.tool && conditions.tool.length > 0) {
      if (!request.tool || !conditions.tool.includes(request.tool)) return false;
    }

    // Key match
    if (conditions.key && conditions.key.length > 0) {
      if (!request.key || !conditions.key.includes(request.key)) return false;
    }

    // IP match
    if (conditions.ip && conditions.ip.length > 0) {
      if (!request.ip || !conditions.ip.includes(request.ip)) return false;
    }

    // Time range match
    const ts = request.timestamp ?? Date.now();
    if (conditions.after) {
      if (ts < new Date(conditions.after).getTime()) return false;
    }
    if (conditions.before) {
      if (ts > new Date(conditions.before).getTime()) return false;
    }

    return true;
  }
}
