/**
 * TransformPipeline — Declarative request/response transform rules.
 *
 * Rewrites MCP tool call arguments before forwarding to the backend
 * and transforms responses before returning to clients.
 *
 * Operations:
 *   set    — Set a value at a dotted path.
 *   remove — Remove a key at a dotted path.
 *   rename — Rename a key (from → to dotted paths).
 *   template — Set a value using {{variable}} interpolation.
 *
 * Zero external dependencies.
 */

import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export type TransformDirection = 'request' | 'response';
export type TransformOp = 'set' | 'remove' | 'rename' | 'template';

export interface TransformOperation {
  op: TransformOp;
  path: string;
  /** Value for 'set' and 'template' ops. */
  value?: unknown;
  /** Source path for 'rename' op. */
  from?: string;
  /** Destination path for 'rename' op (alias for path). */
  to?: string;
}

export interface TransformRule {
  id: string;
  /** Tool name pattern (exact match or '*' for all). */
  tool: string;
  /** Which phase: request or response. */
  direction: TransformDirection;
  /** Ordered list of operations. */
  operations: TransformOperation[];
  /** Lower = earlier. Default 0. */
  priority: number;
  /** Human description. */
  description: string;
  /** Whether the rule is active. */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TransformRuleCreateParams {
  tool: string;
  direction: TransformDirection;
  operations: TransformOperation[];
  priority?: number;
  description?: string;
  enabled?: boolean;
}

export interface TransformStats {
  totalRules: number;
  activeRules: number;
  requestRules: number;
  responseRules: number;
  totalApplied: number;
  totalErrors: number;
  rules: Array<{ id: string; tool: string; direction: string; priority: number; enabled: boolean }>;
}

export interface TransformContext {
  /** API key of the caller. */
  apiKey?: string;
  /** Tool name being called. */
  toolName?: string;
  /** Any extra context for template interpolation. */
  [key: string]: unknown;
}

// ─── TransformPipeline Class ────────────────────────────────────────────────

export class TransformPipeline {
  private readonly rules = new Map<string, TransformRule>();
  private readonly maxRules = 200;
  private totalApplied = 0;
  private totalErrors = 0;

  /**
   * Create a new transform rule.
   */
  createRule(params: TransformRuleCreateParams): TransformRule {
    if (!params.tool || typeof params.tool !== 'string') {
      throw new Error('Transform rule requires a "tool" pattern (tool name or "*")');
    }
    if (!['request', 'response'].includes(params.direction)) {
      throw new Error('Transform direction must be "request" or "response"');
    }
    if (!Array.isArray(params.operations) || params.operations.length === 0) {
      throw new Error('Transform rule requires at least one operation');
    }
    if (this.rules.size >= this.maxRules) {
      throw new Error(`Maximum ${this.maxRules} transform rules reached`);
    }

    // Validate operations
    for (const op of params.operations) {
      if (!['set', 'remove', 'rename', 'template'].includes(op.op)) {
        throw new Error(`Invalid operation: "${op.op}". Must be set|remove|rename|template.`);
      }
      if (op.op === 'rename' && !op.from) {
        throw new Error('Rename operation requires "from" path');
      }
      if ((op.op === 'set' || op.op === 'template') && op.value === undefined) {
        throw new Error(`${op.op} operation requires "value"`);
      }
    }

    const now = new Date().toISOString();
    const id = crypto.randomBytes(8).toString('hex');
    const rule: TransformRule = {
      id,
      tool: params.tool,
      direction: params.direction,
      operations: params.operations,
      priority: params.priority ?? 0,
      description: (params.description || '').slice(0, 500),
      enabled: params.enabled !== false,
      createdAt: now,
      updatedAt: now,
    };

    this.rules.set(id, rule);
    return rule;
  }

  /**
   * Remove a rule by ID.
   */
  removeRule(id: string): boolean {
    return this.rules.delete(id);
  }

  /**
   * Get a rule by ID.
   */
  getRule(id: string): TransformRule | null {
    return this.rules.get(id) || null;
  }

  /**
   * Update a rule's priority or enabled status.
   */
  updateRule(id: string, updates: { priority?: number; enabled?: boolean; description?: string }): TransformRule {
    const rule = this.rules.get(id);
    if (!rule) throw new Error(`Transform rule "${id}" not found`);

    if (updates.priority !== undefined) rule.priority = updates.priority;
    if (updates.enabled !== undefined) rule.enabled = updates.enabled;
    if (updates.description !== undefined) rule.description = updates.description.slice(0, 500);
    rule.updatedAt = new Date().toISOString();
    return rule;
  }

  /**
   * Apply matching transform rules to a data object.
   * Returns a new object with transforms applied (does not mutate input).
   */
  apply(toolName: string, direction: TransformDirection, data: Record<string, unknown>, context?: TransformContext): Record<string, unknown> {
    // Find matching rules, sorted by priority (lower first)
    const matchingRules = Array.from(this.rules.values())
      .filter(r => r.enabled && r.direction === direction && (r.tool === '*' || r.tool === toolName))
      .sort((a, b) => a.priority - b.priority);

    if (matchingRules.length === 0) return data;

    // Deep clone to avoid mutation
    let result = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;

    for (const rule of matchingRules) {
      for (const op of rule.operations) {
        try {
          result = this.applyOperation(result, op, context);
          this.totalApplied++;
        } catch {
          this.totalErrors++;
        }
      }
    }

    return result;
  }

  private applyOperation(data: Record<string, unknown>, op: TransformOperation, context?: TransformContext): Record<string, unknown> {
    switch (op.op) {
      case 'set':
        this.setAtPath(data, op.path, op.value);
        break;

      case 'remove':
        this.removeAtPath(data, op.path);
        break;

      case 'rename': {
        const fromPath = op.from || '';
        const toPath = op.to || op.path;
        const val = this.getAtPath(data, fromPath);
        if (val !== undefined) {
          this.removeAtPath(data, fromPath);
          this.setAtPath(data, toPath, val);
        }
        break;
      }

      case 'template': {
        const templateStr = String(op.value || '');
        const resolved = this.resolveTemplate(templateStr, context);
        this.setAtPath(data, op.path, resolved);
        break;
      }
    }
    return data;
  }

  private getAtPath(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  private setAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path.split('.');
    let current: Record<string, unknown> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (typeof current[part] !== 'object' || current[part] === null) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
  }

  private removeAtPath(obj: Record<string, unknown>, path: string): void {
    const parts = path.split('.');
    let current: Record<string, unknown> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (typeof current[part] !== 'object' || current[part] === null) return;
      current = current[part] as Record<string, unknown>;
    }
    delete current[parts[parts.length - 1]];
  }

  private resolveTemplate(template: string, context?: TransformContext): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
      if (context && key in context) return String(context[key]);
      return '';
    });
  }

  /**
   * Get statistics.
   */
  stats(): TransformStats {
    const rules = Array.from(this.rules.values());
    return {
      totalRules: rules.length,
      activeRules: rules.filter(r => r.enabled).length,
      requestRules: rules.filter(r => r.direction === 'request').length,
      responseRules: rules.filter(r => r.direction === 'response').length,
      totalApplied: this.totalApplied,
      totalErrors: this.totalErrors,
      rules: rules.map(r => ({
        id: r.id,
        tool: r.tool,
        direction: r.direction,
        priority: r.priority,
        enabled: r.enabled,
      })),
    };
  }

  /**
   * Export rules for backup.
   */
  exportRules(): TransformRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Import rules from backup.
   */
  importRules(rules: TransformRuleCreateParams[]): number {
    let imported = 0;
    for (const r of rules) {
      try {
        this.createRule(r);
        imported++;
      } catch { /* skip invalid */ }
    }
    return imported;
  }

  /** Number of rules. */
  get size(): number {
    return this.rules.size;
  }
}
