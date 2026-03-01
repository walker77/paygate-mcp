/**
 * WebhookPayloadTransform — Transform webhook payloads before delivery.
 *
 * Define named transform rules that modify, filter, or enrich
 * webhook payloads per URL or event type.
 *
 * @example
 * ```ts
 * const transforms = new WebhookPayloadTransform();
 *
 * transforms.addRule({
 *   name: 'strip-internal',
 *   type: 'remove_fields',
 *   fields: ['internal_id', 'debug_info'],
 * });
 *
 * const result = transforms.apply(payload, ['strip-internal']);
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type TransformType = 'remove_fields' | 'rename_fields' | 'add_fields' | 'mask_fields' | 'filter_fields';

export interface TransformRule {
  id: string;
  name: string;
  type: TransformType;
  enabled: boolean;
  /** Fields to remove (for remove_fields). */
  fields?: string[];
  /** Field rename mapping (for rename_fields). */
  renames?: Record<string, string>;
  /** Fields to add with values (for add_fields). */
  additions?: Record<string, unknown>;
  /** Fields to mask (for mask_fields). */
  maskFields?: string[];
  /** Fields to keep, remove all others (for filter_fields). */
  keepFields?: string[];
  createdAt: number;
}

export interface TransformRuleCreateParams {
  name: string;
  type: TransformType;
  fields?: string[];
  renames?: Record<string, string>;
  additions?: Record<string, unknown>;
  maskFields?: string[];
  keepFields?: string[];
}

export interface TransformResult {
  original: Record<string, unknown>;
  transformed: Record<string, unknown>;
  rulesApplied: string[];
}

export interface WebhookPayloadTransformConfig {
  /** Max rules. Default 200. */
  maxRules?: number;
  /** Mask replacement string. Default '***'. */
  maskValue?: string;
}

export interface WebhookPayloadTransformStats {
  totalRules: number;
  enabledRules: number;
  disabledRules: number;
  totalApplied: number;
  ruleUsage: { name: string; count: number }[];
}

// ── Implementation ───────────────────────────────────────────────────

export class WebhookPayloadTransform {
  private rules = new Map<string, TransformRule>();
  private nextId = 1;
  private maxRules: number;
  private maskValue: string;
  private ruleUsage = new Map<string, number>();
  private totalApplied = 0;

  constructor(config: WebhookPayloadTransformConfig = {}) {
    this.maxRules = config.maxRules ?? 200;
    this.maskValue = config.maskValue ?? '***';
  }

  // ── Rule Management ────────────────────────────────────────────

  /** Add a transform rule. */
  addRule(params: TransformRuleCreateParams): TransformRule {
    if (!params.name) throw new Error('Rule name is required');
    if (this.rules.size >= this.maxRules) throw new Error(`Maximum ${this.maxRules} rules reached`);

    // Check duplicate names
    for (const r of this.rules.values()) {
      if (r.name === params.name) throw new Error(`Rule '${params.name}' already exists`);
    }

    const rule: TransformRule = {
      id: `tr_${this.nextId++}`,
      name: params.name,
      type: params.type,
      enabled: true,
      fields: params.fields,
      renames: params.renames,
      additions: params.additions,
      maskFields: params.maskFields,
      keepFields: params.keepFields,
      createdAt: Date.now(),
    };

    this.rules.set(rule.id, rule);
    this.ruleUsage.set(rule.id, 0);
    return rule;
  }

  /** Get a rule by ID. */
  getRule(id: string): TransformRule | null {
    return this.rules.get(id) ?? null;
  }

  /** Remove a rule. */
  removeRule(id: string): boolean {
    this.ruleUsage.delete(id);
    return this.rules.delete(id);
  }

  /** Enable/disable a rule. */
  setEnabled(id: string, enabled: boolean): boolean {
    const rule = this.rules.get(id);
    if (!rule) return false;
    rule.enabled = enabled;
    return true;
  }

  /** List all rules. */
  listRules(): TransformRule[] {
    return [...this.rules.values()];
  }

  /** Find rule by name. */
  findByName(name: string): TransformRule | null {
    for (const r of this.rules.values()) {
      if (r.name === name) return r;
    }
    return null;
  }

  // ── Transform Operations ───────────────────────────────────────

  /** Apply transform rules to a payload. */
  apply(payload: Record<string, unknown>, ruleNames: string[]): TransformResult {
    const original = { ...payload };
    let result = { ...payload };
    const rulesApplied: string[] = [];

    for (const name of ruleNames) {
      const rule = this.findByName(name);
      if (!rule || !rule.enabled) continue;

      result = this.applyRule(result, rule);
      rulesApplied.push(rule.name);
      this.ruleUsage.set(rule.id, (this.ruleUsage.get(rule.id) ?? 0) + 1);
      this.totalApplied++;
    }

    return { original, transformed: result, rulesApplied };
  }

  /** Apply all enabled rules to a payload. */
  applyAll(payload: Record<string, unknown>): TransformResult {
    const names = [...this.rules.values()]
      .filter(r => r.enabled)
      .map(r => r.name);
    return this.apply(payload, names);
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): WebhookPayloadTransformStats {
    let enabled = 0, disabled = 0;
    const ruleUsage: { name: string; count: number }[] = [];

    for (const rule of this.rules.values()) {
      if (rule.enabled) enabled++;
      else disabled++;
      ruleUsage.push({ name: rule.name, count: this.ruleUsage.get(rule.id) ?? 0 });
    }

    ruleUsage.sort((a, b) => b.count - a.count);

    return {
      totalRules: this.rules.size,
      enabledRules: enabled,
      disabledRules: disabled,
      totalApplied: this.totalApplied,
      ruleUsage: ruleUsage.slice(0, 10),
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.rules.clear();
    this.ruleUsage.clear();
    this.totalApplied = 0;
  }

  // ── Private ────────────────────────────────────────────────────

  private applyRule(data: Record<string, unknown>, rule: TransformRule): Record<string, unknown> {
    const result = { ...data };

    switch (rule.type) {
      case 'remove_fields':
        if (rule.fields) {
          for (const field of rule.fields) delete result[field];
        }
        break;

      case 'rename_fields':
        if (rule.renames) {
          for (const [from, to] of Object.entries(rule.renames)) {
            if (from in result) {
              result[to] = result[from];
              delete result[from];
            }
          }
        }
        break;

      case 'add_fields':
        if (rule.additions) {
          for (const [key, value] of Object.entries(rule.additions)) {
            result[key] = value;
          }
        }
        break;

      case 'mask_fields':
        if (rule.maskFields) {
          for (const field of rule.maskFields) {
            if (field in result) result[field] = this.maskValue;
          }
        }
        break;

      case 'filter_fields':
        if (rule.keepFields) {
          const kept: Record<string, unknown> = {};
          for (const field of rule.keepFields) {
            if (field in result) kept[field] = result[field];
          }
          return kept;
        }
        break;
    }

    return result;
  }
}
