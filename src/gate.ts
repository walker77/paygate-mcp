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

import { PayGateConfig, GateDecision, UsageEvent, ToolCallParams, ApiKeyRecord, QuotaConfig } from './types';
import { KeyStore } from './store';
import { RateLimiter } from './rate-limiter';
import { UsageMeter } from './meter';
import { WebhookEmitter } from './webhook';
import { QuotaTracker } from './quota';

export class Gate {
  readonly store: KeyStore;
  readonly rateLimiter: RateLimiter;
  readonly meter: UsageMeter;
  readonly webhook: WebhookEmitter | null;
  readonly quotaTracker: QuotaTracker;
  private readonly config: PayGateConfig;

  constructor(config: PayGateConfig, statePath?: string) {
    this.config = config;
    this.store = new KeyStore(statePath);
    this.rateLimiter = new RateLimiter(config.globalRateLimitPerMin);
    this.meter = new UsageMeter();
    this.webhook = config.webhookUrl ? new WebhookEmitter(config.webhookUrl, {
      secret: config.webhookSecret || null,
    }) : null;
    this.quotaTracker = new QuotaTracker();
  }

  /**
   * Evaluate a tool call request.
   */
  evaluate(apiKey: string | null, toolCall: ToolCallParams, clientIp?: string): GateDecision {
    const toolName = toolCall.name;
    const creditsRequired = this.getToolPrice(toolName, toolCall.arguments);

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

    // Step 3a: IP allowlist check
    if (clientIp && keyRecord.ipAllowlist.length > 0) {
      if (!this.store.checkIp(apiKey, clientIp)) {
        const reason = `ip_not_allowed: ${clientIp} not in allowlist`;
        this.recordEvent(apiKey, keyRecord.name, toolName, 0, false, reason);
        if (this.config.shadowMode) {
          return { allowed: true, reason: `shadow:${reason}`, creditsCharged: 0, remainingCredits: keyRecord.credits };
        }
        return { allowed: false, reason, creditsCharged: 0, remainingCredits: keyRecord.credits };
      }
    }

    // Step 3: Tool ACL check
    const aclResult = this.checkToolAcl(keyRecord, toolName);
    if (!aclResult.allowed) {
      this.recordEvent(apiKey, keyRecord.name, toolName, 0, false, aclResult.reason);
      if (this.config.shadowMode) {
        return { allowed: true, reason: `shadow:${aclResult.reason}`, creditsCharged: 0, remainingCredits: keyRecord.credits };
      }
      return { allowed: false, reason: aclResult.reason, creditsCharged: 0, remainingCredits: keyRecord.credits };
    }

    // Step 4: Global rate limit?
    const rateResult = this.rateLimiter.check(apiKey);
    if (!rateResult.allowed) {
      this.recordEvent(apiKey, keyRecord.name, toolName, 0, false, rateResult.reason);
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
        this.recordEvent(apiKey, keyRecord.name, toolName, 0, false, reason);
        if (this.config.shadowMode) {
          return { allowed: true, reason: `shadow:${reason}`, creditsCharged: 0, remainingCredits: keyRecord.credits };
        }
        return { allowed: false, reason, creditsCharged: 0, remainingCredits: keyRecord.credits };
      }
    }

    // Step 6: Sufficient credits?
    if (!this.store.hasCredits(apiKey, creditsRequired)) {
      this.recordEvent(apiKey, keyRecord.name, toolName, 0, false, 'insufficient_credits');
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
        this.recordEvent(apiKey, keyRecord.name, toolName, 0, false, 'spending_limit_exceeded');
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
      this.recordEvent(apiKey, keyRecord.name, toolName, 0, false, quotaResult.reason);
      if (this.config.shadowMode) {
        return { allowed: true, reason: `shadow:${quotaResult.reason}`, creditsCharged: 0, remainingCredits: keyRecord.credits };
      }
      return { allowed: false, reason: quotaResult.reason!, creditsCharged: 0, remainingCredits: keyRecord.credits };
    }

    // Step 9: ALLOW — deduct credits, record usage, and update quotas
    this.store.deductCredits(apiKey, creditsRequired);
    this.rateLimiter.record(apiKey);
    // Record per-tool rate limit usage
    if (toolPricing?.rateLimitPerMin && toolPricing.rateLimitPerMin > 0) {
      this.rateLimiter.recordCustom(`${apiKey}:tool:${toolName}`);
    }
    // Update quota counters
    this.quotaTracker.record(keyRecord, creditsRequired);
    this.store.save();

    const remaining = this.store.getKey(apiKey)?.credits ?? 0;
    this.recordEvent(apiKey, keyRecord.name, toolName, creditsRequired, true);

    return { allowed: true, creditsCharged: creditsRequired, remainingCredits: remaining };
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
   * Filter a tools list based on a key's ACL. Used by proxies for tools/list filtering.
   * Returns null if no filtering needed (no API key or no ACL configured).
   */
  filterToolsForKey(apiKey: string | null, tools: Array<{ name: string; [k: string]: unknown }>): Array<{ name: string; [k: string]: unknown }> | null {
    if (!apiKey) return null;
    const keyRecord = this.store.getKey(apiKey);
    if (!keyRecord) return null;
    if (keyRecord.allowedTools.length === 0 && keyRecord.deniedTools.length === 0) return null;

    return tools.filter(tool => {
      // Whitelist: if set, tool must be in it
      if (keyRecord.allowedTools.length > 0 && !keyRecord.allowedTools.includes(tool.name)) {
        return false;
      }
      // Blacklist: if set, tool must not be in it
      if (keyRecord.deniedTools.length > 0 && keyRecord.deniedTools.includes(tool.name)) {
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
  getToolPrice(toolName: string, args?: Record<string, unknown>): number {
    const override = this.config.toolPricing[toolName];
    const basePrice = override ? override.creditsPerCall : this.config.defaultCreditsPerCall;

    // Dynamic pricing: add per-KB surcharge for input size
    if (override?.creditsPerKbInput && override.creditsPerKbInput > 0 && args) {
      const inputBytes = Buffer.byteLength(JSON.stringify(args), 'utf-8');
      const inputKb = inputBytes / 1024;
      const surcharge = Math.ceil(inputKb * override.creditsPerKbInput);
      return basePrice + surcharge;
    }

    return basePrice;
  }

  /**
   * Get full status for dashboard.
   */
  getStatus() {
    return {
      name: this.config.name,
      shadowMode: this.config.shadowMode,
      activeKeys: this.store.activeKeyCount,
      keys: this.store.listKeys(),
      usage: this.meter.getSummary(),
      eventCount: this.meter.eventCount,
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
    this.recordEvent(apiKey, keyRecord?.name || 'unknown', toolName, -credits, true, 'refund');
  }

  /** Whether refund-on-failure is enabled */
  get refundOnFailure(): boolean {
    return this.config.refundOnFailure;
  }

  destroy(): void {
    this.rateLimiter.destroy();
    this.webhook?.destroy();
  }

  private recordEvent(
    apiKey: string, keyName: string, tool: string,
    creditsCharged: number, allowed: boolean, denyReason?: string,
  ): void {
    const event: UsageEvent = {
      timestamp: new Date().toISOString(),
      apiKey: apiKey.slice(0, 10),
      keyName,
      tool,
      creditsCharged,
      allowed,
      denyReason,
    };
    this.meter.record(event);
    this.webhook?.emit(event);
  }
}
