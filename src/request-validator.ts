/**
 * RequestValidator — JSON-RPC request validation with schema enforcement.
 *
 * Validate incoming requests against configurable rules:
 * max payload size, required fields, allowed methods, parameter validation.
 *
 * @example
 * ```ts
 * const validator = new RequestValidator({
 *   maxPayloadBytes: 1_000_000,
 *   allowedMethods: ['tools/call', 'tools/list'],
 * });
 *
 * const result = validator.validate({
 *   jsonrpc: '2.0',
 *   method: 'tools/call',
 *   id: 1,
 *   params: { name: 'search', arguments: { query: 'test' } },
 * });
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface ValidationRule {
  id: string;
  name: string;
  description: string;
  method: string | null; // null = applies to all methods
  check: (request: Record<string, unknown>) => string | null; // null = valid, string = error
  enabled: boolean;
  createdAt: number;
}

export interface RuleCreateParams {
  name: string;
  description?: string;
  method?: string | null;
  check: (request: Record<string, unknown>) => string | null;
  enabled?: boolean;
}

export interface RequestValidationResult {
  valid: boolean;
  errors: string[];
  method: string | null;
  payloadSize: number;
  checkedRules: number;
  durationMs: number;
}

export interface RequestValidatorConfig {
  /** Max payload size in bytes. Default 10MB. */
  maxPayloadBytes?: number;
  /** Require JSON-RPC 2.0 spec compliance. Default true. */
  requireJsonRpc?: boolean;
  /** Allowed methods (null = all allowed). Default null. */
  allowedMethods?: string[] | null;
  /** Max custom rules. Default 100. */
  maxRules?: number;
}

export interface RequestValidatorStats {
  totalValidations: number;
  totalValid: number;
  totalInvalid: number;
  totalRules: number;
  enabledRules: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class RequestValidator {
  private rules = new Map<string, ValidationRule>();
  private nextId = 1;

  private maxPayloadBytes: number;
  private requireJsonRpc: boolean;
  private allowedMethods: Set<string> | null;
  private maxRules: number;

  // Stats
  private totalValidations = 0;
  private totalValid = 0;
  private totalInvalid = 0;

  constructor(config: RequestValidatorConfig = {}) {
    this.maxPayloadBytes = config.maxPayloadBytes ?? 10_485_760; // 10MB
    this.requireJsonRpc = config.requireJsonRpc ?? true;
    this.allowedMethods = config.allowedMethods ? new Set(config.allowedMethods) : null;
    this.maxRules = config.maxRules ?? 100;
  }

  // ── Rule Management ───────────────────────────────────────────

  /** Add a custom validation rule. */
  addRule(params: RuleCreateParams): ValidationRule {
    if (!params.name) throw new Error('Rule name is required');
    if (this.getRuleByName(params.name)) {
      throw new Error(`Rule '${params.name}' already exists`);
    }
    if (this.rules.size >= this.maxRules) {
      throw new Error(`Maximum ${this.maxRules} rules reached`);
    }

    const rule: ValidationRule = {
      id: `rule_${this.nextId++}`,
      name: params.name,
      description: params.description ?? '',
      method: params.method ?? null,
      check: params.check,
      enabled: params.enabled ?? true,
      createdAt: Date.now(),
    };

    this.rules.set(rule.id, rule);
    return rule;
  }

  /** Get rule by name. */
  getRuleByName(name: string): ValidationRule | null {
    for (const r of this.rules.values()) {
      if (r.name === name) return r;
    }
    return null;
  }

  /** Remove a rule. */
  removeRule(name: string): boolean {
    const r = this.getRuleByName(name);
    if (!r) return false;
    return this.rules.delete(r.id);
  }

  /** List all rules. */
  listRules(): ValidationRule[] {
    return [...this.rules.values()];
  }

  /** Enable/disable a rule. */
  setRuleEnabled(name: string, enabled: boolean): void {
    const r = this.getRuleByName(name);
    if (!r) throw new Error(`Rule '${name}' not found`);
    r.enabled = enabled;
  }

  /** Update allowed methods. */
  setAllowedMethods(methods: string[] | null): void {
    this.allowedMethods = methods ? new Set(methods) : null;
  }

  // ── Validation ────────────────────────────────────────────────

  /** Validate a request. */
  validate(request: unknown, rawSize?: number): RequestValidationResult {
    const start = Date.now();
    const errors: string[] = [];
    let checkedRules = 0;

    this.totalValidations++;

    // Type check
    if (typeof request !== 'object' || request === null) {
      errors.push('Request must be a non-null object');
      this.totalInvalid++;
      return { valid: false, errors, method: null, payloadSize: 0, checkedRules: 0, durationMs: Date.now() - start };
    }

    const req = request as Record<string, unknown>;
    const method = typeof req.method === 'string' ? req.method : null;

    // Payload size
    const payloadSize = rawSize ?? JSON.stringify(request).length;
    if (payloadSize > this.maxPayloadBytes) {
      errors.push(`Payload size ${payloadSize} exceeds maximum ${this.maxPayloadBytes} bytes`);
    }

    // JSON-RPC 2.0 compliance
    if (this.requireJsonRpc) {
      if (req.jsonrpc !== '2.0') {
        errors.push('Missing or invalid jsonrpc field (must be "2.0")');
      }
      if (!method) {
        errors.push('Missing or invalid method field');
      }
    }

    // Allowed methods
    if (this.allowedMethods && method && !this.allowedMethods.has(method)) {
      errors.push(`Method '${method}' is not allowed`);
    }

    // Custom rules
    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;
      if (rule.method && method !== rule.method) continue;

      checkedRules++;
      const error = rule.check(req);
      if (error) {
        errors.push(`[${rule.name}] ${error}`);
      }
    }

    const valid = errors.length === 0;
    if (valid) this.totalValid++;
    else this.totalInvalid++;

    return {
      valid,
      errors,
      method,
      payloadSize,
      checkedRules,
      durationMs: Date.now() - start,
    };
  }

  /** Quick boolean check. */
  isValid(request: unknown, rawSize?: number): boolean {
    return this.validate(request, rawSize).valid;
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): RequestValidatorStats {
    let enabled = 0;
    for (const r of this.rules.values()) {
      if (r.enabled) enabled++;
    }

    return {
      totalValidations: this.totalValidations,
      totalValid: this.totalValid,
      totalInvalid: this.totalInvalid,
      totalRules: this.rules.size,
      enabledRules: enabled,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.rules.clear();
    this.totalValidations = 0;
    this.totalValid = 0;
    this.totalInvalid = 0;
  }
}
