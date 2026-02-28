/**
 * Sandbox Mode — Try-Before-Buy for MCP Tools.
 *
 * Allows keys to make trial calls that don't deduct credits.
 * Configurable per key, per tool, with call limits and time windows.
 * Sandbox calls are logged separately and can return real or mock responses.
 *
 * Use cases:
 *   - Free trial tiers
 *   - Tool previews before purchasing credits
 *   - Developer testing with zero cost
 *
 * Zero external dependencies.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SandboxPolicy {
  /** Unique policy ID. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Maximum sandbox calls per key. 0 = unlimited. */
  maxCalls: number;
  /** Time window in seconds. 0 = lifetime (no reset). */
  windowSeconds: number;
  /** Tools eligible for sandbox. Empty = all tools. */
  allowedTools: string[];
  /** Tools excluded from sandbox. */
  deniedTools: string[];
  /** Whether sandbox responses are real (proxied) or mocked. Default: true (real). */
  realResponses: boolean;
  /** Mock response template (used when realResponses=false). */
  mockResponse?: Record<string, unknown>;
  /** Whether this policy is active. */
  active: boolean;
  /** When this policy was created (ISO). */
  createdAt: string;
}

export interface SandboxUsage {
  /** Key ID. */
  key: string;
  /** Policy ID governing this key. */
  policyId: string;
  /** Total sandbox calls made. */
  totalCalls: number;
  /** Calls in current window. */
  windowCalls: number;
  /** Window start time (epoch ms). */
  windowStart: number;
  /** Per-tool call counts. */
  toolCalls: Record<string, number>;
}

export interface SandboxCheckResult {
  /** Whether the call is allowed as a sandbox call. */
  allowed: boolean;
  /** Whether this is a sandbox call (key has sandbox policy). */
  isSandbox: boolean;
  /** Whether the response should be real or mocked. */
  realResponse: boolean;
  /** Denial reason if not allowed. */
  reason?: string;
  /** Remaining sandbox calls in window. */
  remaining?: number;
}

export interface SandboxConfig {
  /** Whether sandbox mode is globally enabled. Default: true. */
  enabled?: boolean;
  /** Default policy for keys without explicit assignment. Null = no sandbox. */
  defaultPolicyId?: string;
  /** Maximum policies. Default: 100. */
  maxPolicies?: number;
}

export interface SandboxStats {
  /** Total sandbox policies. */
  totalPolicies: number;
  /** Active policies. */
  activePolicies: number;
  /** Total keys with sandbox usage. */
  totalKeys: number;
  /** Total sandbox calls made. */
  totalSandboxCalls: number;
  /** Sandbox calls denied (limit exceeded). */
  totalDenied: number;
  /** Calls by tool in sandbox. */
  callsByTool: Record<string, number>;
}

// ─── Sandbox Manager ────────────────────────────────────────────────────────

export class SandboxManager {
  private policies = new Map<string, SandboxPolicy>();
  private usage = new Map<string, SandboxUsage>(); // key → usage
  private keyPolicies = new Map<string, string>(); // key → policyId
  private enabled: boolean;
  private defaultPolicyId: string | null;
  private maxPolicies: number;

  // Stats
  private totalSandboxCalls = 0;
  private totalDenied = 0;
  private callsByTool: Record<string, number> = {};

  constructor(config: SandboxConfig = {}) {
    this.enabled = config.enabled ?? true;
    this.defaultPolicyId = config.defaultPolicyId ?? null;
    this.maxPolicies = config.maxPolicies ?? 100;
  }

  /** Create or update a sandbox policy. */
  upsertPolicy(policy: Omit<SandboxPolicy, 'createdAt'> & { createdAt?: string }): boolean {
    if (this.policies.size >= this.maxPolicies && !this.policies.has(policy.id)) {
      return false;
    }

    this.policies.set(policy.id, {
      ...policy,
      createdAt: policy.createdAt ?? new Date().toISOString(),
    });
    return true;
  }

  /** Remove a policy. */
  removePolicy(id: string): boolean {
    if (!this.policies.has(id)) return false;
    this.policies.delete(id);
    // Remove key assignments to this policy
    for (const [key, policyId] of this.keyPolicies) {
      if (policyId === id) {
        this.keyPolicies.delete(key);
      }
    }
    return true;
  }

  /** Get a policy by ID. */
  getPolicy(id: string): SandboxPolicy | null {
    return this.policies.get(id) ?? null;
  }

  /** Get all policies. */
  getPolicies(): SandboxPolicy[] {
    return [...this.policies.values()];
  }

  /** Assign a sandbox policy to a key. */
  assignPolicy(key: string, policyId: string): boolean {
    if (!this.policies.has(policyId)) return false;
    this.keyPolicies.set(key, policyId);
    return true;
  }

  /** Remove sandbox policy from a key. */
  unassignPolicy(key: string): void {
    this.keyPolicies.delete(key);
    this.usage.delete(key);
  }

  /** Get the policy assigned to a key (including default). */
  getKeyPolicy(key: string): SandboxPolicy | null {
    const policyId = this.keyPolicies.get(key) ?? this.defaultPolicyId;
    if (!policyId) return null;
    return this.policies.get(policyId) ?? null;
  }

  /**
   * Check if a tool call should be handled as a sandbox call.
   * Returns sandbox status and whether it's allowed.
   */
  check(key: string, tool: string): SandboxCheckResult {
    if (!this.enabled) {
      return { allowed: false, isSandbox: false, realResponse: true };
    }

    const policy = this.getKeyPolicy(key);
    if (!policy || !policy.active) {
      return { allowed: false, isSandbox: false, realResponse: true };
    }

    // Check tool eligibility
    if (policy.allowedTools.length > 0 && !policy.allowedTools.includes(tool)) {
      return { allowed: false, isSandbox: true, realResponse: policy.realResponses, reason: 'tool_not_in_sandbox' };
    }
    if (policy.deniedTools.includes(tool)) {
      return { allowed: false, isSandbox: true, realResponse: policy.realResponses, reason: 'tool_denied_in_sandbox' };
    }

    // Get/create usage
    let usageRec = this.usage.get(key);
    if (!usageRec) {
      usageRec = {
        key,
        policyId: policy.id,
        totalCalls: 0,
        windowCalls: 0,
        windowStart: Date.now(),
        toolCalls: {},
      };
      this.usage.set(key, usageRec);
    }

    // Check window reset
    if (policy.windowSeconds > 0) {
      const windowMs = policy.windowSeconds * 1000;
      if (Date.now() - usageRec.windowStart >= windowMs) {
        usageRec.windowCalls = 0;
        usageRec.windowStart = Date.now();
      }
    }

    // Check call limit
    const callCount = policy.windowSeconds > 0 ? usageRec.windowCalls : usageRec.totalCalls;
    if (policy.maxCalls > 0 && callCount >= policy.maxCalls) {
      this.totalDenied++;
      const remaining = 0;
      return { allowed: false, isSandbox: true, realResponse: policy.realResponses, reason: 'sandbox_limit_exceeded', remaining };
    }

    const remaining = policy.maxCalls > 0 ? policy.maxCalls - callCount - 1 : undefined;
    return { allowed: true, isSandbox: true, realResponse: policy.realResponses, remaining };
  }

  /**
   * Record a sandbox call (call after check returns allowed=true).
   */
  record(key: string, tool: string): void {
    const usageRec = this.usage.get(key);
    if (!usageRec) return;

    usageRec.totalCalls++;
    usageRec.windowCalls++;
    usageRec.toolCalls[tool] = (usageRec.toolCalls[tool] ?? 0) + 1;

    this.totalSandboxCalls++;
    this.callsByTool[tool] = (this.callsByTool[tool] ?? 0) + 1;
  }

  /** Get usage for a key. */
  getUsage(key: string): SandboxUsage | null {
    return this.usage.get(key) ?? null;
  }

  /** Reset usage for a key. */
  resetUsage(key: string): void {
    this.usage.delete(key);
  }

  /** Set enabled state. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Check if globally enabled. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Get mock response for a policy. */
  getMockResponse(policyId: string): Record<string, unknown> | null {
    const policy = this.policies.get(policyId);
    if (!policy || policy.realResponses) return null;
    return policy.mockResponse ?? { content: [{ type: 'text', text: '[Sandbox Mode] This is a preview response.' }] };
  }

  /** Get stats. */
  getStats(): SandboxStats {
    return {
      totalPolicies: this.policies.size,
      activePolicies: [...this.policies.values()].filter(p => p.active).length,
      totalKeys: this.usage.size,
      totalSandboxCalls: this.totalSandboxCalls,
      totalDenied: this.totalDenied,
      callsByTool: { ...this.callsByTool },
    };
  }

  /** Reset stats. */
  resetStats(): void {
    this.totalSandboxCalls = 0;
    this.totalDenied = 0;
    this.callsByTool = {};
  }

  /** Export for persistence. */
  exportState(): { policies: SandboxPolicy[]; keyPolicies: Record<string, string>; usage: SandboxUsage[] } {
    return {
      policies: [...this.policies.values()],
      keyPolicies: Object.fromEntries(this.keyPolicies),
      usage: [...this.usage.values()],
    };
  }

  /** Import state (replaces existing). */
  importState(state: { policies: SandboxPolicy[]; keyPolicies: Record<string, string>; usage: SandboxUsage[] }): void {
    this.policies.clear();
    this.keyPolicies.clear();
    this.usage.clear();

    for (const p of state.policies) {
      this.policies.set(p.id, p);
    }
    for (const [key, policyId] of Object.entries(state.keyPolicies)) {
      this.keyPolicies.set(key, policyId);
    }
    for (const u of state.usage) {
      this.usage.set(u.key, u);
    }
  }

  /** Destroy and release resources. */
  destroy(): void {
    this.policies.clear();
    this.keyPolicies.clear();
    this.usage.clear();
    this.callsByTool = {};
  }
}
