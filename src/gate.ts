/**
 * Gate — The core decision engine.
 *
 * Evaluates whether a tool call should be allowed based on:
 *   1. API key validity
 *   2. Credit balance
 *   3. Rate limit
 *   4. Spending limit
 *
 * Fail-closed: any check failure => DENY.
 * Shadow mode: log but don't enforce (always ALLOW).
 */

import { PayGateConfig, GateDecision, UsageEvent, ToolCallParams, ApiKeyRecord, QuotaConfig, BatchToolCall, BatchGateResult } from './types';
import { KeyStore } from './store';
import { RateLimiter } from './rate-limiter';
import { UsageMeter } from './meter';
import { WebhookEmitter } from './webhook';
import { QuotaTracker } from './quota';
import { PluginManager, PluginGateContext } from './plugin';
import { KeyGroupManager } from './groups';

export class Gate {
  readonly store: KeyStore;
  readonly rateLimiter: RateLimiter;
  readonly meter: UsageMeter;
  readonly webhook: WebhookEmitter | null;
  readonly quotaTracker: QuotaTracker;
  private readonly config: PayGateConfig;
  /** Optional plugin manager for extensible hooks. */
  pluginManager?: PluginManager;
  /** Optional group manager for key group policy resolution. */
  groupManager?: KeyGroupManager;
  /** Optional team-level budget/quota checker injected by server. */
  teamChecker?: (apiKey: string, credits: number) => { allowed: boolean; reason?: string };
  /** Optional team usage recorder injected by server. */
  teamRecorder?: (apiKey: string, credits: number) => void;
  /** Optional hook called after every usage event is recorded (for Redis sync). */
  onUsageEvent?: (event: UsageEvent) => void;
  /** Optional hook called after credits are deducted (for Redis sync). */
  onCreditsDeducted?: (apiKey: string, amount: number) => void;
  /** Optional hook called when auto-topup is triggered (for audit/webhook). */
  onAutoTopup?: (apiKey: string, amount: number, newBalance: number) => void;

  constructor(config: PayGateConfig, statePath?: string) {
    this.config = config;
    this.store = new KeyStore(statePath);
    this.rateLimiter = new RateLimiter(config.globalRateLimitPerMin);
    this.meter = new UsageMeter();
    this.webhook = config.webhookUrl ? new WebhookEmitter(config.webhookUrl, {
      secret: config.webhookSecret || null,
      maxRetries: config.webhookMaxRetries ?? 5,
    }) : null;
    this.quotaTracker = new QuotaTracker();
  }

  /**
   * Evaluate a tool call request.
   */
  evaluate(apiKey: string | null, toolCall: ToolCallParams, clientIp?: string, scopedTokenTools?: string[]): GateDecision {
    const toolName = toolCall.name;
    const creditsRequired = this.getToolPrice(toolName, toolCall.arguments, apiKey || undefined);

    // Plugin: beforeGate — short-circuit if any plugin returns a decision
    if (this.pluginManager && this.pluginManager.count > 0) {
      const keyRecord = apiKey ? this.store.getKey(apiKey) : undefined;
      const pluginCtx: PluginGateContext = { apiKey, toolName, toolArgs: toolCall.arguments, clientIp, keyRecord: keyRecord || undefined };
      const override = this.pluginManager.executeBeforeGate(pluginCtx);
      if (override) {
        const decision: GateDecision = {
          allowed: override.allowed,
          reason: override.reason || (override.allowed ? undefined : 'plugin_denied'),
          creditsCharged: override.creditsCharged ?? 0,
          remainingCredits: keyRecord?.credits ?? 0,
        };
        if (!decision.allowed) {
          this.pluginManager.executeOnDeny(pluginCtx, decision.reason || 'plugin_denied');
          this.recordEvent(apiKey || 'none', keyRecord?.name || '', toolName, 0, false, decision.reason);
        }
        return this.pluginManager.executeAfterGate(pluginCtx, decision);
      }
    }

    // Step 1: API key present?
    if (!apiKey) {
      this.recordEvent(apiKey || 'none', '', toolName, 0, false, 'missing_api_key');
      if (this.config.shadowMode) {
        return { allowed: true, reason: 'shadow:missing_api_key', creditsCharged: 0, remainingCredits: 0 };
      }
      return { allowed: false, reason: 'missing_api_key', creditsCharged: 0, remainingCredits: 0 };
    }

    // Step 2: Valid key? (also checks expiry)
    const keyRecord = this.store.getKey(apiKey);
    if (!keyRecord) {
      // Distinguish expired vs invalid for better error messages
      const isExpired = this.store.isExpired(apiKey);
      const reason = isExpired ? 'api_key_expired' : 'invalid_api_key';
      this.recordEvent(apiKey, 'unknown', toolName, 0, false, reason);
      if (this.config.shadowMode) {
        return { allowed: true, reason: `shadow:${reason}`, creditsCharged: 0, remainingCredits: 0 };
      }
      return { allowed: false, reason, creditsCharged: 0, remainingCredits: 0 };
    }

    // Resolve group policy (if key belongs to a group)
    const groupPolicy = this.groupManager ? this.groupManager.resolvePolicy(apiKey, keyRecord) : null;

    // Step 3a: IP allowlist check (merge group + key allowlists)
    const effectiveIpAllowlist = groupPolicy ? groupPolicy.ipAllowlist : keyRecord.ipAllowlist;
    if (clientIp && effectiveIpAllowlist.length > 0) {
      const ipAllowed = this.checkIpAllowlist(clientIp, effectiveIpAllowlist);
      if (!ipAllowed) {
        const reason = `ip_not_allowed: ${clientIp} not in allowlist`;
        this.recordEvent(apiKey, keyRecord.name, toolName, 0, false, reason, keyRecord.namespace);
        if (this.config.shadowMode) {
          return { allowed: true, reason: `shadow:${reason}`, creditsCharged: 0, remainingCredits: keyRecord.credits };
        }
        return { allowed: false, reason, creditsCharged: 0, remainingCredits: keyRecord.credits };
      }
    }

    // Step 3: Tool ACL check (with group policy applied)
    const effectiveRecord = groupPolicy ? {
      ...keyRecord,
      allowedTools: groupPolicy.allowedTools,
      deniedTools: groupPolicy.deniedTools,
    } : keyRecord;
    const aclResult = this.checkToolAcl(effectiveRecord, toolName);
    if (!aclResult.allowed) {
      this.recordEvent(apiKey, keyRecord.name, toolName, 0, false, aclResult.reason, keyRecord.namespace);
      if (this.config.shadowMode) {
        return { allowed: true, reason: `shadow:${aclResult.reason}`, creditsCharged: 0, remainingCredits: keyRecord.credits };
      }
      return { allowed: false, reason: aclResult.reason, creditsCharged: 0, remainingCredits: keyRecord.credits };
    }

    // Step 3b: Scoped token ACL narrowing — token may restrict to a subset of parent key's tools
    if (scopedTokenTools && scopedTokenTools.length > 0 && !scopedTokenTools.includes(toolName)) {
      const reason = `token_tool_not_allowed: ${toolName} not in scoped token allowedTools`;
      this.recordEvent(apiKey, keyRecord.name, toolName, 0, false, reason, keyRecord.namespace);
      if (this.config.shadowMode) {
        return { allowed: true, reason: `shadow:${reason}`, creditsCharged: 0, remainingCredits: keyRecord.credits };
      }
      return { allowed: false, reason, creditsCharged: 0, remainingCredits: keyRecord.credits };
    }

    // Step 4: Global rate limit?
    const rateResult = this.rateLimiter.check(apiKey);
    if (!rateResult.allowed) {
      this.recordEvent(apiKey, keyRecord.name, toolName, 0, false, rateResult.reason, keyRecord.namespace);
      if (this.config.shadowMode) {
        return { allowed: true, reason: `shadow:${rateResult.reason}`, creditsCharged: 0, remainingCredits: keyRecord.credits };
      }
      return { allowed: false, reason: rateResult.reason, creditsCharged: 0, remainingCredits: keyRecord.credits };
    }

    // Step 5: Per-tool rate limit?
    const toolPricing = this.config.toolPricing[toolName];
    if (toolPricing?.rateLimitPerMin && toolPricing.rateLimitPerMin > 0) {
      const compositeKey = `${apiKey}:tool:${toolName}`;
      const toolRateResult = this.rateLimiter.checkCustom(compositeKey, toolPricing.rateLimitPerMin);
      if (!toolRateResult.allowed) {
        const reason = `tool_rate_limited: ${toolName} limited to ${toolPricing.rateLimitPerMin} calls/min`;
        this.recordEvent(apiKey, keyRecord.name, toolName, 0, false, reason, keyRecord.namespace);
        if (this.config.shadowMode) {
          return { allowed: true, reason: `shadow:${reason}`, creditsCharged: 0, remainingCredits: keyRecord.credits };
        }
        return { allowed: false, reason, creditsCharged: 0, remainingCredits: keyRecord.credits };
      }
    }

    // Step 6: Sufficient credits?
    if (!this.store.hasCredits(apiKey, creditsRequired)) {
      this.recordEvent(apiKey, keyRecord.name, toolName, 0, false, 'insufficient_credits', keyRecord.namespace);
      if (this.config.shadowMode) {
        return { allowed: true, reason: 'shadow:insufficient_credits', creditsCharged: 0, remainingCredits: keyRecord.credits };
      }
      return {
        allowed: false,
        reason: `insufficient_credits: need ${creditsRequired}, have ${keyRecord.credits}`,
        creditsCharged: 0,
        remainingCredits: keyRecord.credits,
      };
    }

    // Step 7: Spending limit?
    if (keyRecord.spendingLimit > 0) {
      const wouldSpend = keyRecord.totalSpent + creditsRequired;
      if (wouldSpend > keyRecord.spendingLimit) {
        this.recordEvent(apiKey, keyRecord.name, toolName, 0, false, 'spending_limit_exceeded', keyRecord.namespace);
        if (this.config.shadowMode) {
          return { allowed: true, reason: 'shadow:spending_limit_exceeded', creditsCharged: 0, remainingCredits: keyRecord.credits };
        }
        return {
          allowed: false,
          reason: `spending_limit_exceeded: limit ${keyRecord.spendingLimit}, spent ${keyRecord.totalSpent}, need ${creditsRequired}`,
          creditsCharged: 0,
          remainingCredits: keyRecord.credits,
        };
      }
    }

    // Step 8: Usage quota check (daily/monthly limits)
    const quotaResult = this.quotaTracker.check(keyRecord, creditsRequired, this.config.globalQuota);
    if (!quotaResult.allowed) {
      this.recordEvent(apiKey, keyRecord.name, toolName, 0, false, quotaResult.reason, keyRecord.namespace);
      if (this.config.shadowMode) {
        return { allowed: true, reason: `shadow:${quotaResult.reason}`, creditsCharged: 0, remainingCredits: keyRecord.credits };
      }
      return { allowed: false, reason: quotaResult.reason!, creditsCharged: 0, remainingCredits: keyRecord.credits };
    }

    // Step 8b: Team budget/quota check (if key belongs to a team)
    if (this.teamChecker) {
      const teamResult = this.teamChecker(apiKey, creditsRequired);
      if (!teamResult.allowed) {
        this.recordEvent(apiKey, keyRecord.name, toolName, 0, false, teamResult.reason, keyRecord.namespace);
        if (this.config.shadowMode) {
          return { allowed: true, reason: `shadow:${teamResult.reason}`, creditsCharged: 0, remainingCredits: keyRecord.credits };
        }
        return { allowed: false, reason: teamResult.reason!, creditsCharged: 0, remainingCredits: keyRecord.credits };
      }
    }

    // Step 9: ALLOW — deduct credits, record usage, and update quotas
    this.store.deductCredits(apiKey, creditsRequired);
    this.onCreditsDeducted?.(apiKey, creditsRequired);
    this.rateLimiter.record(apiKey);
    // Record per-tool rate limit usage
    if (toolPricing?.rateLimitPerMin && toolPricing.rateLimitPerMin > 0) {
      this.rateLimiter.recordCustom(`${apiKey}:tool:${toolName}`);
    }
    // Update quota counters
    this.quotaTracker.record(keyRecord, creditsRequired);
    // Record team usage
    if (this.teamRecorder) {
      this.teamRecorder(apiKey, creditsRequired);
    }
    this.store.save();

    // Auto-topup: if credits dropped below threshold, add credits
    this.checkAutoTopup(apiKey);

    const remaining = this.store.getKey(apiKey)?.credits ?? 0;
    this.recordEvent(apiKey, keyRecord.name, toolName, creditsRequired, true, undefined, keyRecord.namespace);

    let decision: GateDecision = { allowed: true, creditsCharged: creditsRequired, remainingCredits: remaining };

    // Plugin: afterGate — let plugins modify the final decision
    if (this.pluginManager && this.pluginManager.count > 0) {
      const pluginCtx: PluginGateContext = { apiKey, toolName, toolArgs: toolCall.arguments, clientIp, keyRecord };
      decision = this.pluginManager.executeAfterGate(pluginCtx, decision);
    }

    return decision;
  }

  /**
   * Evaluate a batch of tool calls atomically (all-or-nothing).
   *
   * Pre-validates all calls (auth, ACL, rate limits, credits, quotas, spending limits)
   * before executing any. If any call would be denied, the entire batch is rejected
   * and no credits are deducted.
   *
   * On success, deducts credits for all calls at once.
   */
  evaluateBatch(apiKey: string | null, calls: BatchToolCall[], clientIp?: string, scopedTokenTools?: string[]): BatchGateResult {
    if (calls.length === 0) {
      return { allAllowed: true, totalCredits: 0, decisions: [], remainingCredits: 0, failedIndex: -1 };
    }

    // Step 1: API key present?
    if (!apiKey) {
      if (this.config.shadowMode) {
        return this.shadowBatchResult(calls, 'shadow:missing_api_key');
      }
      return {
        allAllowed: false,
        totalCredits: 0,
        decisions: calls.map(() => ({ allowed: false, reason: 'missing_api_key', creditsCharged: 0, remainingCredits: 0 })),
        remainingCredits: 0,
        reason: 'missing_api_key',
        failedIndex: 0,
      };
    }

    // Step 2: Valid key?
    const keyRecord = this.store.getKey(apiKey);
    if (!keyRecord) {
      const isExpired = this.store.isExpired(apiKey);
      const reason = isExpired ? 'api_key_expired' : 'invalid_api_key';
      if (this.config.shadowMode) {
        return this.shadowBatchResult(calls, `shadow:${reason}`);
      }
      return {
        allAllowed: false,
        totalCredits: 0,
        decisions: calls.map(() => ({ allowed: false, reason, creditsCharged: 0, remainingCredits: 0 })),
        remainingCredits: 0,
        reason,
        failedIndex: 0,
      };
    }

    // Step 3: IP allowlist check
    if (clientIp && keyRecord.ipAllowlist.length > 0) {
      if (!this.store.checkIp(apiKey, clientIp)) {
        const reason = `ip_not_allowed: ${clientIp} not in allowlist`;
        if (this.config.shadowMode) {
          return this.shadowBatchResult(calls, `shadow:${reason}`);
        }
        return {
          allAllowed: false,
          totalCredits: 0,
          decisions: calls.map(() => ({ allowed: false, reason, creditsCharged: 0, remainingCredits: keyRecord.credits })),
          remainingCredits: keyRecord.credits,
          reason,
          failedIndex: 0,
        };
      }
    }

    // Step 4: Per-call pre-validation (ACL, per-tool rate limits) + aggregate credits
    let totalCreditsNeeded = 0;
    const perCallCredits: number[] = [];
    // Track per-tool occurrence counts within the batch for rate limit checking
    const batchToolCounts = new Map<string, number>();

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];

      // ACL check
      const aclResult = this.checkToolAcl(keyRecord, call.name);
      if (!aclResult.allowed) {
        if (this.config.shadowMode) {
          perCallCredits.push(this.getToolPrice(call.name, call.arguments));
          continue;
        }
        return {
          allAllowed: false,
          totalCredits: 0,
          decisions: calls.map((_, j) => ({
            allowed: false,
            reason: j === i ? aclResult.reason : 'batch_rejected',
            creditsCharged: 0,
            remainingCredits: keyRecord.credits,
          })),
          remainingCredits: keyRecord.credits,
          reason: aclResult.reason,
          failedIndex: i,
        };
      }

      // Scoped token ACL narrowing for batch
      if (scopedTokenTools && scopedTokenTools.length > 0 && !scopedTokenTools.includes(call.name)) {
        const reason = `token_tool_not_allowed: ${call.name} not in scoped token allowedTools`;
        if (this.config.shadowMode) {
          perCallCredits.push(this.getToolPrice(call.name, call.arguments));
          continue;
        }
        return {
          allAllowed: false,
          totalCredits: 0,
          decisions: calls.map((_, j) => ({
            allowed: false,
            reason: j === i ? reason : 'batch_rejected',
            creditsCharged: 0,
            remainingCredits: keyRecord.credits,
          })),
          remainingCredits: keyRecord.credits,
          reason,
          failedIndex: i,
        };
      }

      // Per-tool rate limit check (batch-aware: count occurrences in batch)
      const toolPricing = this.config.toolPricing[call.name];
      if (toolPricing?.rateLimitPerMin && toolPricing.rateLimitPerMin > 0) {
        const compositeKey = `${apiKey}:tool:${call.name}`;
        const batchCount = (batchToolCounts.get(call.name) || 0) + 1;
        batchToolCounts.set(call.name, batchCount);
        // Check existing window usage + batch occurrences
        const existingCount = this.rateLimiter.getCurrentCount(compositeKey);
        if (existingCount + batchCount > toolPricing.rateLimitPerMin) {
          const reason = `tool_rate_limited: ${call.name} limited to ${toolPricing.rateLimitPerMin} calls/min`;
          if (this.config.shadowMode) {
            perCallCredits.push(this.getToolPrice(call.name, call.arguments));
            continue;
          }
          return {
            allAllowed: false,
            totalCredits: 0,
            decisions: calls.map((_, j) => ({
              allowed: false,
              reason: j === i ? reason : 'batch_rejected',
              creditsCharged: 0,
              remainingCredits: keyRecord.credits,
            })),
            remainingCredits: keyRecord.credits,
            reason,
            failedIndex: i,
          };
        }
      }

      const price = this.getToolPrice(call.name, call.arguments);
      perCallCredits.push(price);
      totalCreditsNeeded += price;
    }

    // Step 5: Global rate limit — check once for the batch
    const rateResult = this.rateLimiter.check(apiKey);
    if (!rateResult.allowed) {
      if (!this.config.shadowMode) {
        return {
          allAllowed: false,
          totalCredits: 0,
          decisions: calls.map(() => ({ allowed: false, reason: rateResult.reason, creditsCharged: 0, remainingCredits: keyRecord.credits })),
          remainingCredits: keyRecord.credits,
          reason: rateResult.reason,
          failedIndex: 0,
        };
      }
    }

    // Step 6: Aggregate credit check
    if (!this.store.hasCredits(apiKey, totalCreditsNeeded)) {
      if (!this.config.shadowMode) {
        return {
          allAllowed: false,
          totalCredits: 0,
          decisions: calls.map(() => ({
            allowed: false,
            reason: `insufficient_credits: need ${totalCreditsNeeded}, have ${keyRecord.credits}`,
            creditsCharged: 0,
            remainingCredits: keyRecord.credits,
          })),
          remainingCredits: keyRecord.credits,
          reason: `insufficient_credits: need ${totalCreditsNeeded}, have ${keyRecord.credits}`,
          failedIndex: 0,
        };
      }
    }

    // Step 7: Spending limit check (aggregate)
    if (keyRecord.spendingLimit > 0) {
      const wouldSpend = keyRecord.totalSpent + totalCreditsNeeded;
      if (wouldSpend > keyRecord.spendingLimit) {
        if (!this.config.shadowMode) {
          return {
            allAllowed: false,
            totalCredits: 0,
            decisions: calls.map(() => ({
              allowed: false,
              reason: `spending_limit_exceeded: limit ${keyRecord.spendingLimit}, spent ${keyRecord.totalSpent}, need ${totalCreditsNeeded}`,
              creditsCharged: 0,
              remainingCredits: keyRecord.credits,
            })),
            remainingCredits: keyRecord.credits,
            reason: `spending_limit_exceeded: limit ${keyRecord.spendingLimit}, spent ${keyRecord.totalSpent}, need ${totalCreditsNeeded}`,
            failedIndex: 0,
          };
        }
      }
    }

    // Step 8: Quota check (aggregate, batch-aware)
    const quotaResult = this.quotaTracker.checkBatch(keyRecord, calls.length, totalCreditsNeeded, this.config.globalQuota);
    if (!quotaResult.allowed) {
      if (!this.config.shadowMode) {
        return {
          allAllowed: false,
          totalCredits: 0,
          decisions: calls.map(() => ({
            allowed: false,
            reason: quotaResult.reason!,
            creditsCharged: 0,
            remainingCredits: keyRecord.credits,
          })),
          remainingCredits: keyRecord.credits,
          reason: quotaResult.reason,
          failedIndex: 0,
        };
      }
    }

    // Step 9: Team budget check (aggregate)
    if (this.teamChecker) {
      const teamResult = this.teamChecker(apiKey, totalCreditsNeeded);
      if (!teamResult.allowed) {
        if (!this.config.shadowMode) {
          return {
            allAllowed: false,
            totalCredits: 0,
            decisions: calls.map(() => ({
              allowed: false,
              reason: teamResult.reason!,
              creditsCharged: 0,
              remainingCredits: keyRecord.credits,
            })),
            remainingCredits: keyRecord.credits,
            reason: teamResult.reason,
            failedIndex: 0,
          };
        }
      }
    }

    // Step 10: ALL ALLOWED — deduct credits atomically
    this.store.deductCredits(apiKey, totalCreditsNeeded);
    this.onCreditsDeducted?.(apiKey, totalCreditsNeeded);

    // Record rate limits and quota for each call
    this.rateLimiter.record(apiKey);
    for (const call of calls) {
      const toolPricing = this.config.toolPricing[call.name];
      if (toolPricing?.rateLimitPerMin && toolPricing.rateLimitPerMin > 0) {
        this.rateLimiter.recordCustom(`${apiKey}:tool:${call.name}`);
      }
    }
    this.quotaTracker.recordBatch(keyRecord, calls.length, totalCreditsNeeded);
    if (this.teamRecorder) {
      this.teamRecorder(apiKey, totalCreditsNeeded);
    }
    this.store.save();

    // Auto-topup: if credits dropped below threshold, add credits
    this.checkAutoTopup(apiKey);

    const remaining = this.store.getKey(apiKey)?.credits ?? 0;

    // Record usage events for each call
    for (let i = 0; i < calls.length; i++) {
      this.recordEvent(apiKey, keyRecord.name, calls[i].name, perCallCredits[i], true, undefined, keyRecord.namespace);
    }

    return {
      allAllowed: true,
      totalCredits: totalCreditsNeeded,
      decisions: calls.map((_, i) => ({
        allowed: true,
        creditsCharged: perCallCredits[i],
        remainingCredits: remaining,
      })),
      remainingCredits: remaining,
      failedIndex: -1,
    };
  }

  /** Build a shadow-mode batch result (all allowed, zero charges). */
  private shadowBatchResult(calls: BatchToolCall[], reason: string): BatchGateResult {
    return {
      allAllowed: true,
      totalCredits: 0,
      decisions: calls.map(() => ({ allowed: true, reason, creditsCharged: 0, remainingCredits: 0 })),
      remainingCredits: 0,
      failedIndex: -1,
    };
  }

  /**
   * Check if a tool call is allowed by the key's ACL.
   */
  private checkToolAcl(keyRecord: ApiKeyRecord, toolName: string): { allowed: boolean; reason?: string } {
    // Check whitelist first: if allowedTools is non-empty, tool must be in it
    if (keyRecord.allowedTools.length > 0) {
      if (!keyRecord.allowedTools.includes(toolName)) {
        return { allowed: false, reason: `tool_not_allowed: ${toolName} not in allowedTools` };
      }
    }
    // Check blacklist: if deniedTools contains the tool, deny
    if (keyRecord.deniedTools.length > 0) {
      if (keyRecord.deniedTools.includes(toolName)) {
        return { allowed: false, reason: `tool_denied: ${toolName} is in deniedTools` };
      }
    }
    return { allowed: true };
  }

  /**
   * Check if a client IP is in an allowlist (supports CIDR and exact match).
   * Used for group-resolved allowlists that may merge multiple sources.
   */
  private checkIpAllowlist(clientIp: string, allowlist: string[]): boolean {
    if (allowlist.length === 0) return true;
    const ip = clientIp.trim();
    for (const allowed of allowlist) {
      if (allowed.includes('/')) {
        // Delegate CIDR to store's matchCidr
        if (this.store.checkIpInList(ip, [allowed])) return true;
      } else if (allowed === ip) {
        return true;
      }
    }
    return false;
  }

  /**
   * Filter a tools list based on a key's ACL. Used by proxies for tools/list filtering.
   * Returns null if no filtering needed (no API key or no ACL configured).
   */
  filterToolsForKey(apiKey: string | null, tools: Array<{ name: string; [k: string]: unknown }>, scopedTokenTools?: string[]): Array<{ name: string; [k: string]: unknown }> | null {
    if (!apiKey) return null;
    const keyRecord = this.store.getKey(apiKey);
    if (!keyRecord) return null;

    // Resolve group policy for effective ACL
    const groupPolicy = this.groupManager ? this.groupManager.resolvePolicy(apiKey, keyRecord) : null;
    const effectiveAllowed = groupPolicy ? groupPolicy.allowedTools : keyRecord.allowedTools;
    const effectiveDenied = groupPolicy ? groupPolicy.deniedTools : keyRecord.deniedTools;

    const hasKeyAcl = effectiveAllowed.length > 0 || effectiveDenied.length > 0;
    const hasTokenAcl = scopedTokenTools && scopedTokenTools.length > 0;
    if (!hasKeyAcl && !hasTokenAcl) return null;

    return tools.filter(tool => {
      // Whitelist: if set, tool must be in it
      if (effectiveAllowed.length > 0 && !effectiveAllowed.includes(tool.name)) {
        return false;
      }
      // Blacklist: if set, tool must not be in it
      if (effectiveDenied.length > 0 && effectiveDenied.includes(tool.name)) {
        return false;
      }
      // Scoped token narrowing: if token restricts tools, tool must be in token's list
      if (hasTokenAcl && !scopedTokenTools!.includes(tool.name)) {
        return false;
      }
      return true;
    });
  }

  /**
   * Check if a method is free (no auth required).
   */
  isFreeMethod(method: string): boolean {
    return this.config.freeMethods.includes(method);
  }

  /**
   * Get price for a tool in credits.
   * With dynamic pricing: base price + per-KB surcharge for large inputs.
   */
  getToolPrice(toolName: string, args?: Record<string, unknown>, apiKey?: string): number {
    // Check group pricing first (group overrides take priority over global config)
    let override = this.config.toolPricing[toolName];
    if (apiKey && this.groupManager) {
      const group = this.groupManager.getKeyGroup(apiKey);
      if (group && group.toolPricing[toolName]) {
        override = group.toolPricing[toolName];
      }
    }

    let price = override ? override.creditsPerCall : this.config.defaultCreditsPerCall;

    // Dynamic pricing: add per-KB surcharge for input size
    if (override?.creditsPerKbInput && override.creditsPerKbInput > 0 && args) {
      const inputBytes = Buffer.byteLength(JSON.stringify(args), 'utf-8');
      const inputKb = inputBytes / 1024;
      const surcharge = Math.ceil(inputKb * override.creditsPerKbInput);
      price = price + surcharge;
    }

    // Plugin: transformPrice — let plugins override the final price
    if (this.pluginManager && this.pluginManager.count > 0) {
      price = this.pluginManager.executeTransformPrice(toolName, price, args);
    }

    return price;
  }

  /**
   * Get full status for dashboard.
   */
  getStatus(namespace?: string) {
    return {
      name: this.config.name,
      shadowMode: this.config.shadowMode,
      activeKeys: this.store.activeKeyCount,
      keys: this.store.listKeys(namespace),
      usage: this.meter.getSummary(undefined, namespace),
      eventCount: this.meter.eventCount,
      namespaces: this.store.listNamespaces(),
      ...(namespace ? { filteredNamespace: namespace } : {}),
      config: {
        defaultCreditsPerCall: this.config.defaultCreditsPerCall,
        globalRateLimitPerMin: this.config.globalRateLimitPerMin,
        toolPricing: this.config.toolPricing,
        refundOnFailure: this.config.refundOnFailure,
        webhookUrl: this.config.webhookUrl ? '***' : null,
      },
    };
  }

  /**
   * Refund credits for a failed tool call.
   * Only used when refundOnFailure is enabled.
   */
  refund(apiKey: string, toolName: string, credits: number): void {
    this.store.addCredits(apiKey, credits);
    const keyRecord = this.store.getKey(apiKey);
    if (keyRecord) {
      keyRecord.totalSpent = Math.max(0, keyRecord.totalSpent - credits);
      keyRecord.totalCalls = Math.max(0, keyRecord.totalCalls - 1);
      // Undo quota tracking
      this.quotaTracker.unrecord(keyRecord, credits);
      this.store.save();
    }
    this.recordEvent(apiKey, keyRecord?.name || 'unknown', toolName, -credits, true, 'refund', keyRecord?.namespace);
  }

  /** Whether refund-on-failure is enabled */
  get refundOnFailure(): boolean {
    return this.config.refundOnFailure;
  }

  /**
   * Check if auto-topup should be triggered for a key.
   * Called after credit deduction. If credits are below the threshold
   * and daily limits allow, credits are added automatically.
   */
  checkAutoTopup(apiKey: string): boolean {
    const record = this.store.getKey(apiKey);
    if (!record || !record.autoTopup) return false;

    const { threshold, amount, maxDaily } = record.autoTopup;
    if (record.credits >= threshold) return false;

    // Reset daily counter if needed (UTC date boundary)
    const today = new Date().toISOString().slice(0, 10);
    if (record.autoTopupLastResetDay !== today) {
      record.autoTopupTodayCount = 0;
      record.autoTopupLastResetDay = today;
    }

    // Check daily limit (0 = unlimited)
    if (maxDaily > 0 && record.autoTopupTodayCount >= maxDaily) return false;

    // Perform auto-topup
    record.credits += amount;
    record.autoTopupTodayCount++;
    this.store.save();

    // Notify listeners
    this.onAutoTopup?.(apiKey, amount, record.credits);

    return true;
  }

  destroy(): void {
    this.rateLimiter.destroy();
    this.webhook?.destroy();
  }

  private recordEvent(
    apiKey: string, keyName: string, tool: string,
    creditsCharged: number, allowed: boolean, denyReason?: string,
    namespace?: string,
  ): void {
    const event: UsageEvent = {
      timestamp: new Date().toISOString(),
      apiKey: apiKey.slice(0, 10),
      keyName,
      tool,
      creditsCharged,
      allowed,
      denyReason,
      namespace,
    };
    this.meter.record(event);
    this.webhook?.emit(event);
    this.onUsageEvent?.(event);
  }
}
