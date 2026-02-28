/**
 * UsagePlanManager — Tiered key policies (free/pro/enterprise plans).
 *
 * Bundles rate limits, quotas, pricing overrides, and tool ACL into a
 * named, reusable template. Keys assigned to a plan inherit its defaults;
 * key-level overrides always win on conflict.
 *
 * Modeled after AWS API Gateway Usage Plans / Kong tiers.
 * Zero external dependencies.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UsagePlan {
  /** Unique plan name (slug). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Rate limit override (calls/min). 0 = use global default. */
  rateLimitPerMin: number;
  /** Max calls per day. 0 = unlimited. */
  dailyCallLimit: number;
  /** Max calls per month. 0 = unlimited. */
  monthlyCallLimit: number;
  /** Max credits per day. 0 = unlimited. */
  dailyCreditLimit: number;
  /** Max credits per month. 0 = unlimited. */
  monthlyCreditLimit: number;
  /** Credit multiplier (1.0 = normal, 0.5 = half price, 2.0 = double). */
  creditMultiplier: number;
  /** Tool whitelist (plan-level). Empty = all tools. */
  allowedTools: string[];
  /** Tool blacklist (plan-level). Empty = none denied. */
  deniedTools: string[];
  /** Max concurrent requests (plan-level). 0 = unlimited. */
  maxConcurrent: number;
  /** When this plan was created. */
  createdAt: string;
  /** When this plan was last updated. */
  updatedAt: string;
}

export interface UsagePlanCreateParams {
  name: string;
  description?: string;
  rateLimitPerMin?: number;
  dailyCallLimit?: number;
  monthlyCallLimit?: number;
  dailyCreditLimit?: number;
  monthlyCreditLimit?: number;
  creditMultiplier?: number;
  allowedTools?: string[];
  deniedTools?: string[];
  maxConcurrent?: number;
}

export interface UsagePlanInfo extends UsagePlan {
  /** Number of keys currently assigned to this plan. */
  assignedKeys: number;
}

export interface PlanStats {
  totalPlans: number;
  plans: UsagePlanInfo[];
}

// ─── Plan Name Validation ───────────────────────────────────────────────────

const PLAN_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// ─── UsagePlanManager Class ─────────────────────────────────────────────────

export class UsagePlanManager {
  private readonly plans = new Map<string, UsagePlan>();
  private readonly keyAssignments = new Map<string, string>(); // apiKey → planName
  private readonly maxPlans = 100;

  /**
   * Create a new usage plan.
   */
  createPlan(params: UsagePlanCreateParams): UsagePlan {
    if (!params.name || !PLAN_NAME_RE.test(params.name)) {
      throw new Error(`Invalid plan name: "${params.name}". Must match ${PLAN_NAME_RE.source}`);
    }
    if (this.plans.has(params.name)) {
      throw new Error(`Plan "${params.name}" already exists. Use updatePlan() to modify.`);
    }
    if (this.plans.size >= this.maxPlans) {
      throw new Error(`Maximum ${this.maxPlans} plans reached`);
    }

    const now = new Date().toISOString();
    const plan: UsagePlan = {
      name: params.name,
      description: (params.description || '').slice(0, 500),
      rateLimitPerMin: params.rateLimitPerMin ?? 0,
      dailyCallLimit: params.dailyCallLimit ?? 0,
      monthlyCallLimit: params.monthlyCallLimit ?? 0,
      dailyCreditLimit: params.dailyCreditLimit ?? 0,
      monthlyCreditLimit: params.monthlyCreditLimit ?? 0,
      creditMultiplier: Math.max(0, params.creditMultiplier ?? 1.0),
      allowedTools: params.allowedTools ?? [],
      deniedTools: params.deniedTools ?? [],
      maxConcurrent: params.maxConcurrent ?? 0,
      createdAt: now,
      updatedAt: now,
    };

    this.plans.set(params.name, plan);
    return plan;
  }

  /**
   * Update an existing plan (partial update).
   */
  updatePlan(name: string, updates: Partial<Omit<UsagePlanCreateParams, 'name'>>): UsagePlan {
    const plan = this.plans.get(name);
    if (!plan) throw new Error(`Plan "${name}" not found`);

    if (updates.description !== undefined) plan.description = updates.description.slice(0, 500);
    if (updates.rateLimitPerMin !== undefined) plan.rateLimitPerMin = updates.rateLimitPerMin;
    if (updates.dailyCallLimit !== undefined) plan.dailyCallLimit = updates.dailyCallLimit;
    if (updates.monthlyCallLimit !== undefined) plan.monthlyCallLimit = updates.monthlyCallLimit;
    if (updates.dailyCreditLimit !== undefined) plan.dailyCreditLimit = updates.dailyCreditLimit;
    if (updates.monthlyCreditLimit !== undefined) plan.monthlyCreditLimit = updates.monthlyCreditLimit;
    if (updates.creditMultiplier !== undefined) plan.creditMultiplier = Math.max(0, updates.creditMultiplier);
    if (updates.allowedTools !== undefined) plan.allowedTools = updates.allowedTools;
    if (updates.deniedTools !== undefined) plan.deniedTools = updates.deniedTools;
    if (updates.maxConcurrent !== undefined) plan.maxConcurrent = updates.maxConcurrent;

    plan.updatedAt = new Date().toISOString();
    return plan;
  }

  /**
   * Delete a plan. Fails if keys are still assigned.
   */
  deletePlan(name: string): boolean {
    if (!this.plans.has(name)) return false;

    // Check for assigned keys
    const assignedCount = this.getAssignedKeyCount(name);
    if (assignedCount > 0) {
      throw new Error(`Cannot delete plan "${name}": ${assignedCount} key(s) still assigned. Unassign them first.`);
    }

    this.plans.delete(name);
    return true;
  }

  /**
   * Get a plan by name.
   */
  getPlan(name: string): UsagePlan | null {
    return this.plans.get(name) || null;
  }

  /**
   * Assign a key to a plan.
   */
  assignKey(apiKey: string, planName: string | null): void {
    if (planName === null) {
      this.keyAssignments.delete(apiKey);
      return;
    }
    if (!this.plans.has(planName)) {
      throw new Error(`Plan "${planName}" not found`);
    }
    this.keyAssignments.set(apiKey, planName);
  }

  /**
   * Get the plan assigned to a key, if any.
   */
  getKeyPlan(apiKey: string): UsagePlan | null {
    const planName = this.keyAssignments.get(apiKey);
    if (!planName) return null;
    return this.plans.get(planName) || null;
  }

  /**
   * Get the plan name for a key.
   */
  getKeyPlanName(apiKey: string): string | null {
    return this.keyAssignments.get(apiKey) || null;
  }

  /**
   * Resolve the effective credit multiplier for a key.
   * Returns 1.0 if no plan is assigned.
   */
  getCreditMultiplier(apiKey: string): number {
    const plan = this.getKeyPlan(apiKey);
    return plan?.creditMultiplier ?? 1.0;
  }

  /**
   * Check if a tool is allowed by the key's plan.
   * Returns true if no plan, or if the plan allows the tool.
   */
  isToolAllowedByPlan(apiKey: string, toolName: string): { allowed: boolean; reason?: string } {
    const plan = this.getKeyPlan(apiKey);
    if (!plan) return { allowed: true };

    // Denied tools take precedence
    if (plan.deniedTools.length > 0 && plan.deniedTools.includes(toolName)) {
      return { allowed: false, reason: `Tool "${toolName}" denied by plan "${plan.name}"` };
    }

    // Allowed tools filter
    if (plan.allowedTools.length > 0 && !plan.allowedTools.includes(toolName)) {
      return { allowed: false, reason: `Tool "${toolName}" not in plan "${plan.name}" allowed list` };
    }

    return { allowed: true };
  }

  /**
   * Get count of keys assigned to a plan.
   */
  private getAssignedKeyCount(planName: string): number {
    let count = 0;
    for (const pn of this.keyAssignments.values()) {
      if (pn === planName) count++;
    }
    return count;
  }

  /**
   * List all plans with assigned key counts.
   */
  stats(): PlanStats {
    const plans: UsagePlanInfo[] = [];
    for (const plan of this.plans.values()) {
      plans.push({
        ...plan,
        assignedKeys: this.getAssignedKeyCount(plan.name),
      });
    }
    return { totalPlans: this.plans.size, plans };
  }

  /**
   * Export plans for backup.
   */
  exportPlans(): { plans: UsagePlan[]; assignments: Record<string, string> } {
    const assignments: Record<string, string> = {};
    for (const [key, plan] of this.keyAssignments) {
      assignments[key] = plan;
    }
    return {
      plans: Array.from(this.plans.values()),
      assignments,
    };
  }

  /**
   * Import plans from backup.
   */
  importPlans(data: { plans: UsagePlanCreateParams[]; assignments?: Record<string, string> }): number {
    let imported = 0;
    for (const p of data.plans) {
      try {
        if (this.plans.has(p.name)) {
          this.updatePlan(p.name, p);
        } else {
          this.createPlan(p);
        }
        imported++;
      } catch { /* skip invalid */ }
    }
    if (data.assignments) {
      for (const [key, planName] of Object.entries(data.assignments)) {
        try {
          this.assignKey(key, planName);
        } catch { /* skip invalid */ }
      }
    }
    return imported;
  }

  /** Number of plans. */
  get size(): number {
    return this.plans.size;
  }
}
