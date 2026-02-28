/**
 * API Key Permissions Engine — Fine-Grained Conditional Access Control.
 *
 * Go beyond simple allow/deny tool lists with conditional permissions:
 * time-of-day restrictions, IP range checks, maximum parameter sizes,
 * and custom condition expressions.
 *
 * Use cases:
 *   - Restrict test keys to business hours only
 *   - Limit keys to specific IP ranges (CIDR)
 *   - Enforce parameter size limits per key
 *   - Environment-based access (dev/staging/prod)
 *
 * Zero external dependencies.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type PermissionConditionType =
  | 'time_range'       // Allowed hours (UTC)
  | 'day_of_week'      // Allowed days (0=Sun, 6=Sat)
  | 'ip_cidr'          // Allowed IP ranges
  | 'environment'      // Allowed environments
  | 'max_payload_bytes' // Maximum request payload size
  | 'tool_pattern'     // Tool name pattern match
  | 'custom';          // Custom key-value check

export interface PermissionCondition {
  /** Condition type. */
  type: PermissionConditionType;
  /** Condition parameters. */
  params: Record<string, unknown>;
}

export interface PermissionRule {
  /** Unique rule ID. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Whether this is an allow or deny rule. */
  effect: 'allow' | 'deny';
  /** Priority (higher = evaluated first). Default: 0. */
  priority: number;
  /** Conditions that must ALL be true for this rule to match. */
  conditions: PermissionCondition[];
  /** Whether this rule is active. */
  active: boolean;
  /** When created (ISO). */
  createdAt: string;
}

export interface PermissionCheckResult {
  /** Whether the action is allowed. */
  allowed: boolean;
  /** Which rule determined the outcome. */
  matchedRuleId?: string;
  /** Reason for denial. */
  reason?: string;
  /** Conditions that failed (if denied). */
  failedConditions?: string[];
}

export interface PermissionAssignment {
  /** API key. */
  key: string;
  /** Rule IDs assigned to this key. */
  ruleIds: string[];
}

export interface KeyPermissionsConfig {
  /** Maximum rules. Default: 1000. */
  maxRules?: number;
  /** Default behavior when no rules match. Default: 'allow'. */
  defaultEffect?: 'allow' | 'deny';
}

export interface KeyPermissionsStats {
  /** Total rules. */
  totalRules: number;
  /** Active rules. */
  activeRules: number;
  /** Total keys with assignments. */
  assignedKeys: number;
  /** Total checks performed. */
  totalChecks: number;
  /** Total denials. */
  totalDenials: number;
}

export interface PermissionCheckContext {
  /** API key being checked. */
  key: string;
  /** Tool being called. */
  tool: string;
  /** Client IP address (optional). */
  ip?: string;
  /** Request payload size in bytes (optional). */
  payloadBytes?: number;
  /** Environment label (optional). */
  environment?: string;
  /** Additional context key-value pairs. */
  extra?: Record<string, string>;
}

// ─── Key Permissions Engine ──────────────────────────────────────────────────

export class KeyPermissionsEngine {
  private rules = new Map<string, PermissionRule>();
  private assignments = new Map<string, string[]>(); // key → ruleIds
  private maxRules: number;
  private defaultEffect: 'allow' | 'deny';

  // Stats
  private totalChecks = 0;
  private totalDenials = 0;

  constructor(config: KeyPermissionsConfig = {}) {
    this.maxRules = config.maxRules ?? 1000;
    this.defaultEffect = config.defaultEffect ?? 'allow';
  }

  /** Add or update a permission rule. */
  upsertRule(rule: Omit<PermissionRule, 'createdAt'> & { createdAt?: string }): boolean {
    if (this.rules.size >= this.maxRules && !this.rules.has(rule.id)) {
      return false;
    }

    this.rules.set(rule.id, {
      ...rule,
      createdAt: rule.createdAt ?? new Date().toISOString(),
    });
    return true;
  }

  /** Remove a rule. */
  removeRule(id: string): boolean {
    // Also remove from assignments
    for (const [key, ruleIds] of this.assignments.entries()) {
      const idx = ruleIds.indexOf(id);
      if (idx >= 0) ruleIds.splice(idx, 1);
      if (ruleIds.length === 0) this.assignments.delete(key);
    }
    return this.rules.delete(id);
  }

  /** Get a rule. */
  getRule(id: string): PermissionRule | null {
    return this.rules.get(id) ?? null;
  }

  /** Get all rules. */
  getRules(): PermissionRule[] {
    return [...this.rules.values()];
  }

  /** Assign rules to a key. */
  assignRules(key: string, ruleIds: string[]): boolean {
    // Verify all rules exist
    for (const id of ruleIds) {
      if (!this.rules.has(id)) return false;
    }
    this.assignments.set(key, [...ruleIds]);
    return true;
  }

  /** Get assignments for a key. */
  getAssignment(key: string): string[] {
    return this.assignments.get(key) ?? [];
  }

  /** Remove all assignments for a key. */
  removeAssignment(key: string): boolean {
    return this.assignments.delete(key);
  }

  /**
   * Check if an action is allowed for a key.
   */
  check(context: PermissionCheckContext): PermissionCheckResult {
    this.totalChecks++;

    const ruleIds = this.assignments.get(context.key);
    if (!ruleIds || ruleIds.length === 0) {
      // No rules assigned — use default
      if (this.defaultEffect === 'deny') {
        this.totalDenials++;
        return { allowed: false, reason: 'no_rules_assigned' };
      }
      return { allowed: true };
    }

    // Get rules, sorted by priority (highest first)
    const rules = ruleIds
      .map(id => this.rules.get(id))
      .filter((r): r is PermissionRule => r !== undefined && r.active)
      .sort((a, b) => b.priority - a.priority);

    if (rules.length === 0) {
      if (this.defaultEffect === 'deny') {
        this.totalDenials++;
        return { allowed: false, reason: 'no_active_rules' };
      }
      return { allowed: true };
    }

    // Evaluate rules in priority order
    for (const rule of rules) {
      const { matches, failedConditions } = this.evaluateConditions(rule.conditions, context);

      if (matches) {
        // All conditions met — apply rule effect
        if (rule.effect === 'deny') {
          this.totalDenials++;
          return {
            allowed: false,
            matchedRuleId: rule.id,
            reason: `denied_by_rule:${rule.name}`,
          };
        }
        return { allowed: true, matchedRuleId: rule.id };
      }
      // If a deny rule's conditions don't match, that's good — skip it
      // If an allow rule's conditions don't match, that's bad — it won't allow
    }

    // No rule matched — use default
    if (this.defaultEffect === 'deny') {
      this.totalDenials++;
      return { allowed: false, reason: 'no_rule_matched' };
    }
    return { allowed: true };
  }

  /** Get stats. */
  getStats(): KeyPermissionsStats {
    return {
      totalRules: this.rules.size,
      activeRules: [...this.rules.values()].filter(r => r.active).length,
      assignedKeys: this.assignments.size,
      totalChecks: this.totalChecks,
      totalDenials: this.totalDenials,
    };
  }

  /** Reset stats. */
  resetStats(): void {
    this.totalChecks = 0;
    this.totalDenials = 0;
  }

  /** Destroy and release resources. */
  destroy(): void {
    this.rules.clear();
    this.assignments.clear();
    this.resetStats();
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private evaluateConditions(
    conditions: PermissionCondition[],
    context: PermissionCheckContext,
  ): { matches: boolean; failedConditions: string[] } {
    const failed: string[] = [];

    for (const cond of conditions) {
      if (!this.evaluateCondition(cond, context)) {
        failed.push(cond.type);
      }
    }

    return { matches: failed.length === 0, failedConditions: failed };
  }

  private evaluateCondition(cond: PermissionCondition, ctx: PermissionCheckContext): boolean {
    switch (cond.type) {
      case 'time_range': {
        const startHour = (cond.params.startHour as number) ?? 0;
        const endHour = (cond.params.endHour as number) ?? 24;
        const currentHour = new Date().getUTCHours();
        if (startHour <= endHour) {
          return currentHour >= startHour && currentHour < endHour;
        }
        // Wrapping range (e.g., 22-6 = 10pm to 6am)
        return currentHour >= startHour || currentHour < endHour;
      }

      case 'day_of_week': {
        const allowedDays = (cond.params.days as number[]) ?? [1, 2, 3, 4, 5];
        const currentDay = new Date().getUTCDay();
        return allowedDays.includes(currentDay);
      }

      case 'ip_cidr': {
        if (!ctx.ip) return false;
        const ranges = (cond.params.ranges as string[]) ?? [];
        return ranges.some(range => this.matchesCidr(ctx.ip!, range));
      }

      case 'environment': {
        if (!ctx.environment) return true; // No env context → pass
        const allowed = (cond.params.allowed as string[]) ?? [];
        return allowed.includes(ctx.environment);
      }

      case 'max_payload_bytes': {
        if (ctx.payloadBytes === undefined) return true; // No size info → pass
        const max = (cond.params.maxBytes as number) ?? Infinity;
        return ctx.payloadBytes <= max;
      }

      case 'tool_pattern': {
        const patterns = (cond.params.patterns as string[]) ?? [];
        return patterns.some(p => {
          if (p === '*') return true;
          if (p.endsWith('*')) return ctx.tool.startsWith(p.slice(0, -1));
          return ctx.tool === p;
        });
      }

      case 'custom': {
        const requiredKey = cond.params.key as string;
        const requiredValue = cond.params.value as string;
        if (!ctx.extra || !requiredKey) return false;
        return ctx.extra[requiredKey] === requiredValue;
      }

      default:
        return true;
    }
  }

  private matchesCidr(ip: string, cidr: string): boolean {
    // Simple IPv4 CIDR match
    if (!cidr.includes('/')) return ip === cidr;

    const [range, bitsStr] = cidr.split('/');
    const bits = parseInt(bitsStr, 10);
    if (isNaN(bits) || bits < 0 || bits > 32) return false;

    const ipNum = this.ipToNum(ip);
    const rangeNum = this.ipToNum(range);
    if (ipNum === null || rangeNum === null) return false;

    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipNum & mask) === (rangeNum & mask);
  }

  private ipToNum(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let num = 0;
    for (const part of parts) {
      const n = parseInt(part, 10);
      if (isNaN(n) || n < 0 || n > 255) return null;
      num = (num << 8) | n;
    }
    return num >>> 0;
  }
}
