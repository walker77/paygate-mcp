/**
 * Approval Workflows — Pre-execution approval gates for tool calls.
 *
 * Define rules that require explicit admin approval before high-cost
 * or sensitive tool calls are executed. Pending requests are held
 * until approved or denied (or they expire).
 *
 * @example
 * ```ts
 * const approvals = new ApprovalWorkflowManager();
 * approvals.configure({ enabled: true });
 *
 * // Require approval for tool calls costing more than 100 credits
 * approvals.createRule({
 *   name: 'high-cost-gate',
 *   condition: 'cost_threshold',
 *   threshold: 100,
 * });
 * ```
 */

import * as crypto from 'crypto';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ApprovalCondition = 'cost_threshold' | 'tool_match' | 'key_match';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalRule {
  id: string;
  name: string;
  condition: ApprovalCondition;
  /** For cost_threshold: minimum credits to trigger */
  threshold?: number;
  /** For tool_match: tool name pattern (exact or glob with *) */
  toolPattern?: string;
  /** For key_match: specific API key prefix */
  keyPrefix?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  triggerCount: number;
}

export interface ApprovalRuleCreateParams {
  name: string;
  condition: ApprovalCondition;
  threshold?: number;
  toolPattern?: string;
  keyPrefix?: string;
  enabled?: boolean;
}

export interface ApprovalRequest {
  id: string;
  ruleId: string;
  ruleName: string;
  apiKey: string;
  tool: string;
  creditCost: number;
  status: ApprovalStatus;
  reason?: string;
  decidedBy?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface ApprovalCheckResult {
  requiresApproval: boolean;
  matchedRules: string[];
  requestId?: string;
}

export interface ApprovalDecision {
  requestId: string;
  status: 'approved' | 'denied';
  reason?: string;
  decidedBy?: string;
}

export interface ApprovalWorkflowStats {
  totalRules: number;
  enabledRules: number;
  totalRequests: number;
  pendingRequests: number;
  approvedRequests: number;
  deniedRequests: number;
  expiredRequests: number;
  byCondition: Record<ApprovalCondition, number>;
}

export interface ApprovalWorkflowConfig {
  enabled: boolean;
  maxRules: number;
  maxPendingRequests: number;
  defaultExpiryMs: number;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeRuleId(): string {
  return 'ar_' + crypto.randomBytes(8).toString('hex');
}

function makeRequestId(): string {
  return 'areq_' + crypto.randomBytes(8).toString('hex');
}

function matchesGlob(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === value;
  const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
  return regex.test(value);
}

/* ------------------------------------------------------------------ */
/*  Manager                                                            */
/* ------------------------------------------------------------------ */

export class ApprovalWorkflowManager {
  private rules = new Map<string, ApprovalRule>();
  private requests = new Map<string, ApprovalRequest>();
  private config: ApprovalWorkflowConfig = {
    enabled: false,
    maxRules: 100,
    maxPendingRequests: 5000,
    defaultExpiryMs: 3600_000, // 1 hour
  };

  /* ── Rule CRUD ─────────────────────────────────────────────────── */

  createRule(params: ApprovalRuleCreateParams): ApprovalRule {
    if (!this.config.enabled) throw new Error('Approval workflows are disabled');
    if (this.rules.size >= this.config.maxRules) {
      throw new Error(`Maximum rules reached (${this.config.maxRules})`);
    }
    if (!params.name || !params.condition) {
      throw new Error('name and condition are required');
    }

    const VALID_CONDITIONS: ApprovalCondition[] = ['cost_threshold', 'tool_match', 'key_match'];
    if (!VALID_CONDITIONS.includes(params.condition)) {
      throw new Error(`Invalid condition: ${params.condition}`);
    }

    if (params.condition === 'cost_threshold' && (params.threshold === undefined || params.threshold <= 0)) {
      throw new Error('threshold must be > 0 for cost_threshold condition');
    }
    if (params.condition === 'tool_match' && !params.toolPattern) {
      throw new Error('toolPattern is required for tool_match condition');
    }
    if (params.condition === 'key_match' && !params.keyPrefix) {
      throw new Error('keyPrefix is required for key_match condition');
    }

    // Check duplicate name
    for (const r of this.rules.values()) {
      if (r.name === params.name) throw new Error(`Rule name '${params.name}' already exists`);
    }

    const now = new Date().toISOString();
    const rule: ApprovalRule = {
      id: makeRuleId(),
      name: params.name,
      condition: params.condition,
      threshold: params.threshold,
      toolPattern: params.toolPattern,
      keyPrefix: params.keyPrefix,
      enabled: params.enabled !== false,
      createdAt: now,
      updatedAt: now,
      triggerCount: 0,
    };

    this.rules.set(rule.id, rule);
    return rule;
  }

  getRule(id: string): ApprovalRule | undefined {
    return this.rules.get(id);
  }

  listRules(filter?: { condition?: ApprovalCondition; enabled?: boolean }): ApprovalRule[] {
    let result = Array.from(this.rules.values());
    if (filter?.condition) result = result.filter(r => r.condition === filter.condition);
    if (filter?.enabled !== undefined) result = result.filter(r => r.enabled === filter.enabled);
    return result;
  }

  updateRule(id: string, updates: Partial<Pick<ApprovalRule, 'name' | 'threshold' | 'toolPattern' | 'keyPrefix' | 'enabled'>>): ApprovalRule {
    const rule = this.rules.get(id);
    if (!rule) throw new Error(`Rule not found: ${id}`);

    if (updates.name !== undefined) {
      for (const r of this.rules.values()) {
        if (r.id !== id && r.name === updates.name) {
          throw new Error(`Rule name '${updates.name}' already exists`);
        }
      }
      rule.name = updates.name;
    }
    if (updates.threshold !== undefined) rule.threshold = updates.threshold;
    if (updates.toolPattern !== undefined) rule.toolPattern = updates.toolPattern;
    if (updates.keyPrefix !== undefined) rule.keyPrefix = updates.keyPrefix;
    if (updates.enabled !== undefined) rule.enabled = updates.enabled;

    rule.updatedAt = new Date().toISOString();
    return rule;
  }

  deleteRule(id: string): boolean {
    return this.rules.delete(id);
  }

  /* ── Check & Request ───────────────────────────────────────────── */

  check(apiKey: string, tool: string, creditCost: number): ApprovalCheckResult {
    if (!this.config.enabled) return { requiresApproval: false, matchedRules: [] };

    const matched: string[] = [];

    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;

      let matches = false;
      switch (rule.condition) {
        case 'cost_threshold':
          matches = creditCost >= (rule.threshold ?? Infinity);
          break;
        case 'tool_match':
          matches = rule.toolPattern ? matchesGlob(rule.toolPattern, tool) : false;
          break;
        case 'key_match':
          matches = rule.keyPrefix ? apiKey.startsWith(rule.keyPrefix) : false;
          break;
      }

      if (matches) {
        matched.push(rule.id);
        rule.triggerCount++;
      }
    }

    if (matched.length === 0) return { requiresApproval: false, matchedRules: [] };

    // Create a pending request
    const pendingCount = Array.from(this.requests.values()).filter(r => r.status === 'pending').length;
    if (pendingCount >= this.config.maxPendingRequests) {
      throw new Error('Maximum pending approval requests reached');
    }

    const firstRule = this.rules.get(matched[0])!;
    const now = new Date();
    const request: ApprovalRequest = {
      id: makeRequestId(),
      ruleId: firstRule.id,
      ruleName: firstRule.name,
      apiKey,
      tool,
      creditCost,
      status: 'pending',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.config.defaultExpiryMs).toISOString(),
    };

    this.requests.set(request.id, request);

    return {
      requiresApproval: true,
      matchedRules: matched,
      requestId: request.id,
    };
  }

  /* ── Decision ──────────────────────────────────────────────────── */

  decide(decision: ApprovalDecision): ApprovalRequest {
    const request = this.requests.get(decision.requestId);
    if (!request) throw new Error(`Request not found: ${decision.requestId}`);
    if (request.status !== 'pending') {
      throw new Error(`Request is not pending (current: ${request.status})`);
    }

    // Check expiry
    if (new Date(request.expiresAt) < new Date()) {
      request.status = 'expired';
      request.updatedAt = new Date().toISOString();
      throw new Error('Request has expired');
    }

    request.status = decision.status;
    request.reason = decision.reason;
    request.decidedBy = decision.decidedBy;
    request.updatedAt = new Date().toISOString();

    return request;
  }

  /* ── Request Queries ───────────────────────────────────────────── */

  getRequest(id: string): ApprovalRequest | undefined {
    return this.requests.get(id);
  }

  listRequests(filter?: { status?: ApprovalStatus; apiKey?: string; tool?: string }): ApprovalRequest[] {
    let result = Array.from(this.requests.values());
    if (filter?.status) result = result.filter(r => r.status === filter.status);
    if (filter?.apiKey) result = result.filter(r => r.apiKey === filter.apiKey);
    if (filter?.tool) result = result.filter(r => r.tool === filter.tool);
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  expirePending(): number {
    const now = new Date();
    let count = 0;
    for (const req of this.requests.values()) {
      if (req.status === 'pending' && new Date(req.expiresAt) < now) {
        req.status = 'expired';
        req.updatedAt = now.toISOString();
        count++;
      }
    }
    return count;
  }

  /* ── Config & Stats ────────────────────────────────────────────── */

  configure(updates: Partial<ApprovalWorkflowConfig>): ApprovalWorkflowConfig {
    if (updates.enabled !== undefined) this.config.enabled = updates.enabled;
    if (updates.maxRules !== undefined && updates.maxRules > 0) this.config.maxRules = updates.maxRules;
    if (updates.maxPendingRequests !== undefined && updates.maxPendingRequests > 0) this.config.maxPendingRequests = updates.maxPendingRequests;
    if (updates.defaultExpiryMs !== undefined && updates.defaultExpiryMs > 0) this.config.defaultExpiryMs = updates.defaultExpiryMs;
    return { ...this.config };
  }

  stats(): ApprovalWorkflowStats {
    const rules = Array.from(this.rules.values());
    const requests = Array.from(this.requests.values());
    const byCondition: Record<ApprovalCondition, number> = { cost_threshold: 0, tool_match: 0, key_match: 0 };

    for (const r of rules) byCondition[r.condition]++;

    return {
      totalRules: rules.length,
      enabledRules: rules.filter(r => r.enabled).length,
      totalRequests: requests.length,
      pendingRequests: requests.filter(r => r.status === 'pending').length,
      approvedRequests: requests.filter(r => r.status === 'approved').length,
      deniedRequests: requests.filter(r => r.status === 'denied').length,
      expiredRequests: requests.filter(r => r.status === 'expired').length,
      byCondition,
    };
  }

  clear(): void {
    this.rules.clear();
    this.requests.clear();
  }
}
