/**
 * WebhookFilterExpression — Expression-based webhook event filtering.
 *
 * Define filter expressions to control which webhook events
 * are delivered to which endpoints based on event properties.
 *
 * @example
 * ```ts
 * const filter = new WebhookFilterExpression();
 *
 * filter.addRule({
 *   name: 'high-value-only',
 *   url: 'https://alerts.example.com/hook',
 *   conditions: [
 *     { field: 'event', op: 'eq', value: 'key.usage' },
 *     { field: 'credits', op: 'gt', value: 100 },
 *   ],
 *   matchMode: 'all',
 * });
 *
 * const matches = filter.evaluate({ event: 'key.usage', credits: 150, key: 'k1' });
 * // Returns ['https://alerts.example.com/hook']
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'starts_with' | 'ends_with' | 'regex' | 'in' | 'not_in' | 'exists';

export interface FilterCondition {
  field: string;
  op: FilterOp;
  value: unknown;
}

export type FilterMatchMode = 'all' | 'any';

export interface FilterRule {
  id: string;
  name: string;
  url: string;
  conditions: FilterCondition[];
  matchMode: FilterMatchMode;
  enabled: boolean;
  createdAt: number;
  matchCount: number;
}

export interface FilterRuleCreateParams {
  name: string;
  url: string;
  conditions: FilterCondition[];
  matchMode?: FilterMatchMode;
}

export interface FilterEvalResult {
  matchedUrls: string[];
  matchedRules: string[];
  evaluatedRules: number;
  timestamp: number;
}

export interface WebhookFilterConfig {
  /** Max filter rules. Default 500. */
  maxRules?: number;
}

export interface WebhookFilterStats {
  totalRules: number;
  enabledRules: number;
  totalEvaluations: number;
  totalMatches: number;
  topRules: { id: string; name: string; matchCount: number }[];
}

// ── Implementation ───────────────────────────────────────────────────

export class WebhookFilterExpression {
  private rules = new Map<string, FilterRule>();
  private nextId = 1;
  private maxRules: number;

  // Stats
  private totalEvaluations = 0;
  private totalMatches = 0;

  constructor(config: WebhookFilterConfig = {}) {
    this.maxRules = config.maxRules ?? 500;
  }

  // ── Rule Management ────────────────────────────────────────────

  /** Add a filter rule. */
  addRule(params: FilterRuleCreateParams): FilterRule {
    if (!params.name) throw new Error('Rule name is required');
    if (!params.url) throw new Error('URL is required');
    if (!params.conditions.length) throw new Error('At least one condition is required');
    if (this.rules.size >= this.maxRules) {
      throw new Error(`Maximum ${this.maxRules} rules reached`);
    }

    const rule: FilterRule = {
      id: `fr_${this.nextId++}`,
      name: params.name,
      url: params.url,
      conditions: [...params.conditions],
      matchMode: params.matchMode ?? 'all',
      enabled: true,
      createdAt: Date.now(),
      matchCount: 0,
    };

    this.rules.set(rule.id, rule);
    return rule;
  }

  /** Remove a filter rule. */
  removeRule(id: string): boolean {
    return this.rules.delete(id);
  }

  /** Get a rule by ID. */
  getRule(id: string): FilterRule | null {
    return this.rules.get(id) ?? null;
  }

  /** Enable a rule. */
  enableRule(id: string): boolean {
    const rule = this.rules.get(id);
    if (!rule) return false;
    rule.enabled = true;
    return true;
  }

  /** Disable a rule. */
  disableRule(id: string): boolean {
    const rule = this.rules.get(id);
    if (!rule) return false;
    rule.enabled = false;
    return true;
  }

  /** List all rules. */
  listRules(url?: string): FilterRule[] {
    const all = [...this.rules.values()];
    return url ? all.filter(r => r.url === url) : all;
  }

  // ── Evaluation ─────────────────────────────────────────────────

  /** Evaluate an event against all enabled rules. */
  evaluate(event: Record<string, unknown>): FilterEvalResult {
    this.totalEvaluations++;
    const matchedUrls = new Set<string>();
    const matchedRules: string[] = [];
    let evaluated = 0;

    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;
      evaluated++;

      const matches = this.evaluateRule(rule, event);
      if (matches) {
        matchedUrls.add(rule.url);
        matchedRules.push(rule.id);
        rule.matchCount++;
        this.totalMatches++;
      }
    }

    return {
      matchedUrls: [...matchedUrls],
      matchedRules,
      evaluatedRules: evaluated,
      timestamp: Date.now(),
    };
  }

  /** Check if an event matches a specific rule. */
  testRule(ruleId: string, event: Record<string, unknown>): boolean {
    const rule = this.rules.get(ruleId);
    if (!rule) return false;
    return this.evaluateRule(rule, event);
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): WebhookFilterStats {
    const topRules = [...this.rules.values()]
      .filter(r => r.matchCount > 0)
      .sort((a, b) => b.matchCount - a.matchCount)
      .slice(0, 5)
      .map(r => ({ id: r.id, name: r.name, matchCount: r.matchCount }));

    return {
      totalRules: this.rules.size,
      enabledRules: [...this.rules.values()].filter(r => r.enabled).length,
      totalEvaluations: this.totalEvaluations,
      totalMatches: this.totalMatches,
      topRules,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.rules.clear();
    this.totalEvaluations = 0;
    this.totalMatches = 0;
  }

  // ── Private ───────────────────────────────────────────────────

  private evaluateRule(rule: FilterRule, event: Record<string, unknown>): boolean {
    if (rule.matchMode === 'all') {
      return rule.conditions.every(c => this.evaluateCondition(c, event));
    }
    return rule.conditions.some(c => this.evaluateCondition(c, event));
  }

  private evaluateCondition(cond: FilterCondition, event: Record<string, unknown>): boolean {
    const fieldValue = this.getNestedField(event, cond.field);

    switch (cond.op) {
      case 'exists':
        return fieldValue !== undefined;
      case 'eq':
        return fieldValue === cond.value;
      case 'neq':
        return fieldValue !== cond.value;
      case 'gt':
        return typeof fieldValue === 'number' && typeof cond.value === 'number' && fieldValue > cond.value;
      case 'gte':
        return typeof fieldValue === 'number' && typeof cond.value === 'number' && fieldValue >= cond.value;
      case 'lt':
        return typeof fieldValue === 'number' && typeof cond.value === 'number' && fieldValue < cond.value;
      case 'lte':
        return typeof fieldValue === 'number' && typeof cond.value === 'number' && fieldValue <= cond.value;
      case 'contains':
        return typeof fieldValue === 'string' && typeof cond.value === 'string' && fieldValue.includes(cond.value);
      case 'starts_with':
        return typeof fieldValue === 'string' && typeof cond.value === 'string' && fieldValue.startsWith(cond.value);
      case 'ends_with':
        return typeof fieldValue === 'string' && typeof cond.value === 'string' && fieldValue.endsWith(cond.value);
      case 'regex':
        return typeof fieldValue === 'string' && typeof cond.value === 'string' && new RegExp(cond.value).test(fieldValue);
      case 'in':
        return Array.isArray(cond.value) && cond.value.includes(fieldValue);
      case 'not_in':
        return Array.isArray(cond.value) && !cond.value.includes(fieldValue);
      default:
        return false;
    }
  }

  private getNestedField(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
}
