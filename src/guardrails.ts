/**
 * Content Guardrails — PII detection and content policy enforcement.
 *
 * Pattern-based scanning of tool call inputs and outputs to detect sensitive
 * data (credit cards, SSNs, emails, phone numbers) and enforce content policies.
 *
 * Actions:
 *   - log:    Record the violation but allow the call
 *   - warn:   Record + add warning header, allow the call
 *   - block:  Deny the call with -32406 error
 *   - redact: Replace matched content with [REDACTED] and allow
 *
 * Zero dependencies. All patterns are built-in regex.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type GuardrailAction = 'log' | 'warn' | 'block' | 'redact';

export interface GuardrailRule {
  /** Unique rule ID. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Regex pattern to match (string form, compiled at runtime). */
  pattern: string;
  /** Regex flags (default: 'gi'). */
  flags?: string;
  /** Action to take on match. */
  action: GuardrailAction;
  /** Whether this rule is active. Default: true. */
  active: boolean;
  /** Apply to tool inputs, outputs, or both. Default: 'both'. */
  scope: 'input' | 'output' | 'both';
  /** Only apply to these tools. Empty = all tools. */
  tools: string[];
  /** Replacement text for redact action. Default: '[REDACTED]'. */
  redactWith?: string;
  /** Description of what this rule detects. */
  description?: string;
}

export interface GuardrailViolation {
  /** ISO timestamp. */
  timestamp: string;
  /** Rule that was triggered. */
  ruleId: string;
  /** Rule name. */
  ruleName: string;
  /** Action taken. */
  action: GuardrailAction;
  /** Tool name. */
  tool: string;
  /** Whether this was on input or output. */
  scope: 'input' | 'output';
  /** API key prefix (first 10 chars). */
  keyPrefix: string;
  /** Number of matches found. */
  matchCount: number;
  /** Truncated context around the match (no actual PII). */
  context?: string;
}

export interface GuardrailConfig {
  /** Whether guardrails are enabled. Default: false. */
  enabled: boolean;
  /** Built-in rules to enable. Default: all built-in rules active. */
  rules: GuardrailRule[];
  /** Max violations to retain in memory. Default: 10000. */
  maxViolations?: number;
  /** Whether to include match context in violations (truncated, partially masked). Default: false. */
  includeContext?: boolean;
}

export interface GuardrailCheckResult {
  /** Whether any blocking rule was triggered. */
  blocked: boolean;
  /** Violations found. */
  violations: GuardrailViolation[];
  /** If action is 'redact', the redacted content. */
  redactedContent?: string;
  /** Warning messages (for 'warn' action). */
  warnings: string[];
}

export interface GuardrailStats {
  /** Total violations detected. */
  totalViolations: number;
  /** Violations by rule ID. */
  byRule: Record<string, number>;
  /** Violations by action. */
  byAction: Record<string, number>;
  /** Violations by tool. */
  byTool: Record<string, number>;
  /** Number of blocked calls. */
  totalBlocked: number;
  /** Number of redacted calls. */
  totalRedacted: number;
}

// ─── Built-in Patterns ──────────────────────────────────────────────────────

/** Credit card number patterns (Visa, MC, Amex, Discover). */
const CREDIT_CARD_PATTERN = '\\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\\b';

/** SSN pattern (XXX-XX-XXXX or XXXXXXXXX). */
const SSN_PATTERN = '\\b(?!000|666|9\\d{2})\\d{3}[-\\s]?(?!00)\\d{2}[-\\s]?(?!0000)\\d{4}\\b';

/** Email address pattern. */
const EMAIL_PATTERN = '[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}';

/** Phone number patterns (US/international). */
const PHONE_PATTERN = '(?:\\+?1[-\\s.]?)?(?:\\(?\\d{3}\\)?[-\\s.]?)\\d{3}[-\\s.]?\\d{4}';

/** AWS access key pattern. */
const AWS_KEY_PATTERN = '(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}';

/** Generic API key / secret pattern (long hex or base64 strings). */
const API_SECRET_PATTERN = '(?:api[_-]?key|api[_-]?secret|access[_-]?token|secret[_-]?key)\\s*[=:]\\s*["\']?[A-Za-z0-9+/=_\\-]{20,}["\']?';

/** IBAN pattern. */
const IBAN_PATTERN = '\\b[A-Z]{2}\\d{2}[A-Z0-9]{4}\\d{7}(?:[A-Z0-9]{0,18})\\b';

/** Passport number pattern (generic). */
const PASSPORT_PATTERN = '\\b[A-Z]{1,2}\\d{6,9}\\b';

export const BUILT_IN_RULES: GuardrailRule[] = [
  {
    id: 'pii_credit_card',
    name: 'Credit Card Number',
    pattern: CREDIT_CARD_PATTERN,
    action: 'block',
    active: true,
    scope: 'both',
    tools: [],
    description: 'Detects Visa, Mastercard, Amex, and Discover card numbers',
  },
  {
    id: 'pii_ssn',
    name: 'Social Security Number',
    pattern: SSN_PATTERN,
    action: 'block',
    active: true,
    scope: 'both',
    tools: [],
    description: 'Detects US Social Security Numbers (XXX-XX-XXXX format)',
  },
  {
    id: 'pii_email',
    name: 'Email Address',
    pattern: EMAIL_PATTERN,
    action: 'log',
    active: true,
    scope: 'both',
    tools: [],
    description: 'Detects email addresses',
  },
  {
    id: 'pii_phone',
    name: 'Phone Number',
    pattern: PHONE_PATTERN,
    action: 'log',
    active: true,
    scope: 'both',
    tools: [],
    description: 'Detects US and international phone numbers',
  },
  {
    id: 'secret_aws_key',
    name: 'AWS Access Key',
    pattern: AWS_KEY_PATTERN,
    action: 'block',
    active: true,
    scope: 'both',
    tools: [],
    description: 'Detects AWS access key IDs (AKIA/ABIA/ACCA/ASIA prefix)',
  },
  {
    id: 'secret_api_key',
    name: 'API Key / Secret',
    pattern: API_SECRET_PATTERN,
    flags: 'gi',
    action: 'warn',
    active: true,
    scope: 'both',
    tools: [],
    description: 'Detects common API key/secret patterns in key=value format',
  },
  {
    id: 'pii_iban',
    name: 'IBAN',
    pattern: IBAN_PATTERN,
    action: 'block',
    active: true,
    scope: 'both',
    tools: [],
    description: 'Detects International Bank Account Numbers',
  },
  {
    id: 'pii_passport',
    name: 'Passport Number',
    pattern: PASSPORT_PATTERN,
    action: 'log',
    active: false,
    scope: 'both',
    tools: [],
    description: 'Detects passport numbers (generic pattern — may produce false positives)',
  },
];

// ─── Guardrail Engine ────────────────────────────────────────────────────────

export class ContentGuardrails {
  private rules: GuardrailRule[];
  private compiledPatterns: Map<string, RegExp> = new Map();
  private violations: GuardrailViolation[] = [];
  private maxViolations: number;
  private includeContext: boolean;
  private enabled: boolean;

  // Stats counters
  private statsBlocked = 0;
  private statsRedacted = 0;

  constructor(config?: Partial<GuardrailConfig>) {
    this.enabled = config?.enabled ?? false;
    this.rules = config?.rules ?? [...BUILT_IN_RULES];
    this.maxViolations = config?.maxViolations ?? 10_000;
    this.includeContext = config?.includeContext ?? false;

    // Pre-compile regex patterns
    for (const rule of this.rules) {
      try {
        this.compiledPatterns.set(rule.id, new RegExp(rule.pattern, rule.flags ?? 'gi'));
      } catch {
        // Invalid regex — skip rule
      }
    }
  }

  /** Whether guardrails are enabled. */
  get isEnabled(): boolean { return this.enabled; }

  /** Enable or disable guardrails at runtime. */
  setEnabled(enabled: boolean): void { this.enabled = enabled; }

  /** Get all configured rules. */
  getRules(): GuardrailRule[] { return [...this.rules]; }

  /** Add or update a rule. Returns the rule. */
  upsertRule(rule: GuardrailRule): GuardrailRule {
    const idx = this.rules.findIndex(r => r.id === rule.id);
    if (idx >= 0) {
      this.rules[idx] = rule;
    } else {
      this.rules.push(rule);
    }
    // Recompile pattern
    try {
      this.compiledPatterns.set(rule.id, new RegExp(rule.pattern, rule.flags ?? 'gi'));
    } catch {
      this.compiledPatterns.delete(rule.id);
    }
    return rule;
  }

  /** Remove a rule by ID. Returns true if removed. */
  removeRule(id: string): boolean {
    const idx = this.rules.findIndex(r => r.id === id);
    if (idx < 0) return false;
    this.rules.splice(idx, 1);
    this.compiledPatterns.delete(id);
    return true;
  }

  /**
   * Check content against guardrail rules.
   * @param content - The text content to scan (serialized tool arguments or response)
   * @param tool - Tool name for tool-specific filtering
   * @param scope - Whether this is input or output content
   * @param keyPrefix - API key prefix for violation logging
   */
  check(content: string, tool: string, scope: 'input' | 'output', keyPrefix: string): GuardrailCheckResult {
    const result: GuardrailCheckResult = {
      blocked: false,
      violations: [],
      warnings: [],
    };

    if (!this.enabled || !content || content.length === 0) return result;

    let redactedContent = content;
    let needsRedaction = false;

    for (const rule of this.rules) {
      if (!rule.active) continue;
      if (rule.scope !== 'both' && rule.scope !== scope) continue;
      if (rule.tools.length > 0 && !rule.tools.includes(tool)) continue;

      const pattern = this.compiledPatterns.get(rule.id);
      if (!pattern) continue;

      // Reset regex state (global flag)
      pattern.lastIndex = 0;

      const matches = content.match(pattern);
      if (!matches || matches.length === 0) continue;

      const violation: GuardrailViolation = {
        timestamp: new Date().toISOString(),
        ruleId: rule.id,
        ruleName: rule.name,
        action: rule.action,
        tool,
        scope,
        keyPrefix,
        matchCount: matches.length,
      };

      if (this.includeContext) {
        // Provide masked context — show first match position with surrounding text
        const firstIdx = content.search(pattern);
        if (firstIdx >= 0) {
          const start = Math.max(0, firstIdx - 10);
          const end = Math.min(content.length, firstIdx + 20);
          const ctx = content.slice(start, end);
          // Mask the actual match
          violation.context = ctx.replace(pattern, '***');
        }
      }

      result.violations.push(violation);
      this.recordViolation(violation);

      switch (rule.action) {
        case 'block':
          result.blocked = true;
          this.statsBlocked++;
          break;
        case 'warn':
          result.warnings.push(`Guardrail "${rule.name}" detected ${matches.length} match(es) in ${scope}`);
          break;
        case 'redact': {
          const replacement = rule.redactWith ?? '[REDACTED]';
          pattern.lastIndex = 0;
          redactedContent = redactedContent.replace(pattern, replacement);
          needsRedaction = true;
          this.statsRedacted++;
          break;
        }
        case 'log':
          // Just recorded the violation above
          break;
      }
    }

    if (needsRedaction) {
      result.redactedContent = redactedContent;
    }

    return result;
  }

  /** Get recent violations (newest first). */
  getViolations(limit = 100, offset = 0): { violations: GuardrailViolation[]; total: number } {
    const sorted = [...this.violations].reverse();
    return {
      violations: sorted.slice(offset, offset + limit),
      total: this.violations.length,
    };
  }

  /** Get violations filtered by rule, tool, key, or time range. */
  queryViolations(opts: {
    ruleId?: string;
    tool?: string;
    keyPrefix?: string;
    since?: string;
    until?: string;
    action?: GuardrailAction;
    limit?: number;
    offset?: number;
  }): { violations: GuardrailViolation[]; total: number } {
    let filtered = [...this.violations];

    if (opts.ruleId) filtered = filtered.filter(v => v.ruleId === opts.ruleId);
    if (opts.tool) filtered = filtered.filter(v => v.tool === opts.tool);
    if (opts.keyPrefix) filtered = filtered.filter(v => v.keyPrefix === opts.keyPrefix);
    if (opts.action) filtered = filtered.filter(v => v.action === opts.action);
    if (opts.since) filtered = filtered.filter(v => v.timestamp >= opts.since!);
    if (opts.until) filtered = filtered.filter(v => v.timestamp <= opts.until!);

    const total = filtered.length;
    const sorted = filtered.reverse();
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;

    return {
      violations: sorted.slice(offset, offset + limit),
      total,
    };
  }

  /** Clear all violations. Returns count cleared. */
  clearViolations(): number {
    const count = this.violations.length;
    this.violations = [];
    return count;
  }

  /** Get summary statistics. */
  getStats(): GuardrailStats {
    const byRule: Record<string, number> = {};
    const byAction: Record<string, number> = {};
    const byTool: Record<string, number> = {};

    for (const v of this.violations) {
      byRule[v.ruleId] = (byRule[v.ruleId] || 0) + 1;
      byAction[v.action] = (byAction[v.action] || 0) + 1;
      byTool[v.tool] = (byTool[v.tool] || 0) + 1;
    }

    return {
      totalViolations: this.violations.length,
      byRule,
      byAction,
      byTool,
      totalBlocked: this.statsBlocked,
      totalRedacted: this.statsRedacted,
    };
  }

  /** Serialize rules for export. */
  exportRules(): GuardrailRule[] {
    return JSON.parse(JSON.stringify(this.rules));
  }

  /** Import rules (merge or replace). */
  importRules(rules: GuardrailRule[], mode: 'merge' | 'replace' = 'merge'): number {
    if (mode === 'replace') {
      this.rules = [];
      this.compiledPatterns.clear();
    }

    let imported = 0;
    for (const rule of rules) {
      this.upsertRule(rule);
      imported++;
    }
    return imported;
  }

  /** Record a violation (with eviction). */
  private recordViolation(violation: GuardrailViolation): void {
    this.violations.push(violation);
    if (this.violations.length > this.maxViolations) {
      this.violations = this.violations.slice(-this.maxViolations);
    }
  }

  /** Destroy and release resources. */
  destroy(): void {
    this.violations = [];
    this.compiledPatterns.clear();
    this.rules = [];
  }
}
