/**
 * Billable Metric Expressions — Config-driven pricing formulas.
 *
 * Instead of flat per-call pricing, define expressions that compute
 * cost based on request/response attributes:
 *
 *   cost = input_tokens * 0.001 + output_tokens * 0.003
 *   cost = max(1, file_size_kb * 0.5)
 *   cost = base_cost + (duration_ms / 1000) * 2
 *
 * SECURITY: Expressions are parsed with a safe recursive descent parser.
 * NO JavaScript eval(), NO Function constructor. The parser only
 * supports arithmetic (+, -, *, /, %), built-in math functions
 * (min, max, ceil, floor, round, abs, sqrt, log, pow),
 * numeric literals, and named variables.
 *
 * Features:
 *   - Safe expression parsing (AST-based, no code execution)
 *   - Built-in math functions: min, max, ceil, floor, round, abs
 *   - Variable binding from tool args and response fields
 *   - Per-tool metric definitions
 *   - Fallback to flat pricing if expression errors
 *   - Statistics and audit trail
 *
 * Zero external dependencies.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BillableMetric {
  /** Unique metric ID. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Expression string (e.g., 'input_tokens * 0.001 + output_tokens * 0.003'). */
  expression: string;
  /** Tools this metric applies to. Empty = all. */
  tools: string[];
  /** Minimum cost (floor). Default: 0. */
  minCost?: number;
  /** Maximum cost (ceiling). Default: Infinity. */
  maxCost?: number;
  /** Whether this metric is active. Default: true. */
  active: boolean;
  /** Description. */
  description?: string;
  /** Fallback flat cost if expression fails. Default: 1. */
  fallbackCost?: number;
}

export interface MetricContext {
  /** Tool name. */
  tool: string;
  /** Input arguments (flattened key-value). */
  inputArgs: Record<string, unknown>;
  /** Response content (if post-call). */
  responseContent?: string;
  /** Response size in bytes. */
  responseSizeBytes?: number;
  /** Call duration in ms. */
  durationMs?: number;
  /** Input size in bytes. */
  inputSizeBytes?: number;
  /** Custom variables injected by caller. */
  customVars?: Record<string, number>;
}

export interface MetricResult {
  /** Computed cost in credits. */
  cost: number;
  /** Metric ID used. */
  metricId: string;
  /** Whether fallback was used. */
  usedFallback: boolean;
  /** Error if expression failed. */
  error?: string;
  /** Variables resolved for the expression. */
  resolvedVars: Record<string, number>;
}

export interface BillableMetricStats {
  /** Total evaluations. */
  totalEvaluations: number;
  /** Successful expression evaluations. */
  successfulEvals: number;
  /** Fallback evaluations (expression error). */
  fallbackEvals: number;
  /** Total credits computed. */
  totalCreditsComputed: number;
  /** Evaluations by metric ID. */
  byMetric: Record<string, number>;
  /** Evaluations by tool. */
  byTool: Record<string, number>;
}

// ─── Safe Expression Parser (No eval/Function — Recursive Descent) ──────────

/** Token types for the expression parser. */
type TokenType = 'number' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma' | 'eof';

interface Token {
  type: TokenType;
  value: string;
  numValue?: number;
}

/** Tokenize an expression string into a list of tokens. */
function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    const ch = expr[i];

    // Skip whitespace
    if (/\s/.test(ch)) { i++; continue; }

    // Number literal
    if (/[0-9.]/.test(ch)) {
      let num = '';
      while (i < expr.length && /[0-9.]/.test(expr[i])) {
        num += expr[i++];
      }
      tokens.push({ type: 'number', value: num, numValue: parseFloat(num) });
      continue;
    }

    // Identifier (variable name or function name)
    if (/[a-zA-Z_]/.test(ch)) {
      let ident = '';
      while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) {
        ident += expr[i++];
      }
      tokens.push({ type: 'ident', value: ident });
      continue;
    }

    // Arithmetic operators
    if ('+-*/%'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }

    // Parentheses and comma
    if (ch === '(') { tokens.push({ type: 'lparen', value: '(' }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'rparen', value: ')' }); i++; continue; }
    if (ch === ',') { tokens.push({ type: 'comma', value: ',' }); i++; continue; }

    throw new Error(`Unexpected character: ${ch} at position ${i}`);
  }

  tokens.push({ type: 'eof', value: '' });
  return tokens;
}

/**
 * Recursive descent parser for arithmetic expressions.
 * Grammar:
 *   expr     = addSub
 *   addSub   = mulDiv (('+' | '-') mulDiv)*
 *   mulDiv   = unary (('*' | '/' | '%') unary)*
 *   unary    = ('-' | '+')? primary
 *   primary  = NUMBER | IDENT | IDENT '(' args ')' | '(' expr ')'
 *   args     = expr (',' expr)*
 */
class ExprParser {
  private tokens: Token[];
  private pos = 0;
  private vars: Record<string, number>;
  private funcs: Record<string, (...args: number[]) => number>;

  constructor(tokens: Token[], vars: Record<string, number>) {
    this.tokens = tokens;
    this.vars = vars;
    this.funcs = {
      min: Math.min,
      max: Math.max,
      ceil: Math.ceil,
      floor: Math.floor,
      round: Math.round,
      abs: Math.abs,
      sqrt: Math.sqrt,
      log: Math.log,
      log10: Math.log10,
      pow: Math.pow,
    };
  }

  parse(): number {
    const result = this.parseAddSub();
    if (this.tokens[this.pos].type !== 'eof') {
      throw new Error(`Unexpected token: ${this.tokens[this.pos].value}`);
    }
    return result;
  }

  private parseAddSub(): number {
    let left = this.parseMulDiv();
    while (this.pos < this.tokens.length && this.tokens[this.pos].type === 'op' && '+-'.includes(this.tokens[this.pos].value)) {
      const op = this.tokens[this.pos++].value;
      const right = this.parseMulDiv();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  private parseMulDiv(): number {
    let left = this.parseUnary();
    while (this.pos < this.tokens.length && this.tokens[this.pos].type === 'op' && '*/%'.includes(this.tokens[this.pos].value)) {
      const op = this.tokens[this.pos++].value;
      const right = this.parseUnary();
      if (op === '*') left *= right;
      else if (op === '/') left = right !== 0 ? left / right : 0;
      else left = right !== 0 ? left % right : 0;
    }
    return left;
  }

  private parseUnary(): number {
    if (this.tokens[this.pos].type === 'op' && this.tokens[this.pos].value === '-') {
      this.pos++;
      return -this.parsePrimary();
    }
    if (this.tokens[this.pos].type === 'op' && this.tokens[this.pos].value === '+') {
      this.pos++;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const token = this.tokens[this.pos];

    // Number literal
    if (token.type === 'number') {
      this.pos++;
      return token.numValue!;
    }

    // Identifier (variable or function call)
    if (token.type === 'ident') {
      this.pos++;

      // Check if it's a function call: IDENT '(' args ')'
      if (this.pos < this.tokens.length && this.tokens[this.pos].type === 'lparen') {
        const func = this.funcs[token.value];
        if (!func) throw new Error(`Unknown function: ${token.value}`);
        this.pos++; // skip (

        const args: number[] = [];
        if (this.tokens[this.pos].type !== 'rparen') {
          args.push(this.parseAddSub());
          while (this.tokens[this.pos].type === 'comma') {
            this.pos++; // skip ,
            args.push(this.parseAddSub());
          }
        }

        if (this.tokens[this.pos].type !== 'rparen') {
          throw new Error('Expected closing parenthesis');
        }
        this.pos++; // skip )

        return func(...args);
      }

      // Variable lookup
      const val = this.vars[token.value];
      if (val === undefined) {
        throw new Error(`Unknown variable: ${token.value}`);
      }
      return val;
    }

    // Parenthesized expression
    if (token.type === 'lparen') {
      this.pos++; // skip (
      const result = this.parseAddSub();
      if (this.tokens[this.pos].type !== 'rparen') {
        throw new Error('Expected closing parenthesis');
      }
      this.pos++; // skip )
      return result;
    }

    throw new Error(`Unexpected token: ${token.value}`);
  }
}

/**
 * Safely compute a math expression with named variables.
 *
 * Uses a recursive descent parser. No JavaScript code execution.
 * Only supports: numbers, variables, +, -, *, /, %, parentheses,
 * and built-in math functions (min, max, ceil, floor, round, abs, sqrt, log, pow).
 */
export function computeExpression(expression: string, vars: Record<string, number>): number {
  const tokens = tokenize(expression);
  const parser = new ExprParser(tokens, vars);
  return parser.parse();
}

// ─── Billable Metrics Engine ─────────────────────────────────────────────────

export class BillableMetricEngine {
  private metrics: BillableMetric[] = [];
  private stats: BillableMetricStats = {
    totalEvaluations: 0,
    successfulEvals: 0,
    fallbackEvals: 0,
    totalCreditsComputed: 0,
    byMetric: {},
    byTool: {},
  };

  constructor(metrics?: BillableMetric[]) {
    if (metrics) this.metrics = [...metrics];
  }

  /** Get all metrics. */
  getMetrics(): BillableMetric[] { return [...this.metrics]; }

  /** Add or update a metric. */
  upsertMetric(metric: BillableMetric): BillableMetric {
    // Validate expression syntax by tokenizing
    try {
      tokenize(metric.expression);
    } catch (err) {
      throw new Error(`Invalid expression: ${err}`);
    }

    const idx = this.metrics.findIndex(m => m.id === metric.id);
    if (idx >= 0) {
      this.metrics[idx] = metric;
    } else {
      this.metrics.push(metric);
    }
    return metric;
  }

  /** Remove a metric by ID. */
  removeMetric(id: string): boolean {
    const idx = this.metrics.findIndex(m => m.id === id);
    if (idx < 0) return false;
    this.metrics.splice(idx, 1);
    return true;
  }

  /**
   * Find the matching metric for a tool.
   * Returns the first active metric whose tool list matches.
   */
  findMetric(tool: string): BillableMetric | null {
    for (const metric of this.metrics) {
      if (!metric.active) continue;
      if (metric.tools.length === 0 || metric.tools.includes(tool)) {
        return metric;
      }
    }
    return null;
  }

  /**
   * Compute cost for a tool call using billable metric expressions.
   *
   * @param context - Context with args, response, timing data
   * @returns Result with computed cost, or null if no metric matches
   */
  computeCost(context: MetricContext): MetricResult | null {
    const metric = this.findMetric(context.tool);
    if (!metric) return null;

    this.stats.totalEvaluations++;
    this.stats.byMetric[metric.id] = (this.stats.byMetric[metric.id] ?? 0) + 1;
    this.stats.byTool[context.tool] = (this.stats.byTool[context.tool] ?? 0) + 1;

    // Build variable map from context
    const vars: Record<string, number> = {
      // Built-in variables
      input_size_bytes: context.inputSizeBytes ?? 0,
      input_size_kb: (context.inputSizeBytes ?? 0) / 1024,
      response_size_bytes: context.responseSizeBytes ?? 0,
      response_size_kb: (context.responseSizeBytes ?? 0) / 1024,
      duration_ms: context.durationMs ?? 0,
      duration_s: (context.durationMs ?? 0) / 1000,
      // Inject custom variables
      ...(context.customVars ?? {}),
    };

    // Extract numeric values from input args (flatten one level)
    if (context.inputArgs) {
      for (const [key, value] of Object.entries(context.inputArgs)) {
        if (typeof value === 'number') {
          vars[key] = value;
        } else if (typeof value === 'string') {
          vars[`${key}_length`] = value.length;
        } else if (typeof value === 'boolean') {
          vars[key] = value ? 1 : 0;
        }
      }
    }

    try {
      let cost = computeExpression(metric.expression, vars);

      // Apply floor/ceiling
      if (metric.minCost !== undefined) cost = Math.max(metric.minCost, cost);
      if (metric.maxCost !== undefined) cost = Math.min(metric.maxCost, cost);

      // Round to nearest integer (credits are whole numbers)
      cost = Math.round(cost);
      if (cost < 0) cost = 0;

      this.stats.successfulEvals++;
      this.stats.totalCreditsComputed += cost;

      return {
        cost,
        metricId: metric.id,
        usedFallback: false,
        resolvedVars: vars,
      };
    } catch (err) {
      // Expression failed — use fallback
      const fallback = metric.fallbackCost ?? 1;
      this.stats.fallbackEvals++;
      this.stats.totalCreditsComputed += fallback;

      return {
        cost: fallback,
        metricId: metric.id,
        usedFallback: true,
        error: String(err),
        resolvedVars: vars,
      };
    }
  }

  /** Get statistics. */
  getStats(): BillableMetricStats {
    return { ...this.stats };
  }

  /** Reset stats. */
  resetStats(): void {
    this.stats = {
      totalEvaluations: 0,
      successfulEvals: 0,
      fallbackEvals: 0,
      totalCreditsComputed: 0,
      byMetric: {},
      byTool: {},
    };
  }

  /** Export metrics for backup/serialization. */
  exportMetrics(): BillableMetric[] {
    return JSON.parse(JSON.stringify(this.metrics));
  }

  /** Import metrics. */
  importMetrics(metrics: BillableMetric[], mode: 'merge' | 'replace' = 'merge'): number {
    if (mode === 'replace') {
      this.metrics = [];
    }
    let imported = 0;
    for (const m of metrics) {
      this.upsertMetric(m);
      imported++;
    }
    return imported;
  }

  /** Destroy. */
  destroy(): void {
    this.metrics = [];
  }
}
