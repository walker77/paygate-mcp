/**
 * Gate — The core decision engine.
 *
 * Evaluates whether a tool call should be allowed based on:
 *   1. API key validity
 *   2. Credit balance
 *   3. Rate limit
 *
 * Fail-closed: any check failure => DENY.
 * Shadow mode: log but don't enforce (always ALLOW).
 */

import { PayGateConfig, GateDecision, UsageEvent, ToolCallParams } from './types';
import { KeyStore } from './store';
import { RateLimiter } from './rate-limiter';
import { UsageMeter } from './meter';

export class Gate {
  readonly store: KeyStore;
  readonly rateLimiter: RateLimiter;
  readonly meter: UsageMeter;
  private readonly config: PayGateConfig;

  constructor(config: PayGateConfig, statePath?: string) {
    this.config = config;
    this.store = new KeyStore(statePath);
    this.rateLimiter = new RateLimiter(config.globalRateLimitPerMin);
    this.meter = new UsageMeter();
  }

  /**
   * Evaluate a tool call request.
   */
  evaluate(apiKey: string | null, toolCall: ToolCallParams): GateDecision {
    const toolName = toolCall.name;
    const creditsRequired = this.getToolPrice(toolName);

    // Step 1: API key present?
    if (!apiKey) {
      this.recordEvent(apiKey || 'none', '', toolName, 0, false, 'missing_api_key');
      if (this.config.shadowMode) {
        return { allowed: true, reason: 'shadow:missing_api_key', creditsCharged: 0, remainingCredits: 0 };
      }
      return { allowed: false, reason: 'missing_api_key', creditsCharged: 0, remainingCredits: 0 };
    }

    // Step 2: Valid key?
    const keyRecord = this.store.getKey(apiKey);
    if (!keyRecord) {
      this.recordEvent(apiKey, 'unknown', toolName, 0, false, 'invalid_api_key');
      if (this.config.shadowMode) {
        return { allowed: true, reason: 'shadow:invalid_api_key', creditsCharged: 0, remainingCredits: 0 };
      }
      return { allowed: false, reason: 'invalid_api_key', creditsCharged: 0, remainingCredits: 0 };
    }

    // Step 3: Rate limit?
    const rateResult = this.rateLimiter.check(apiKey);
    if (!rateResult.allowed) {
      this.recordEvent(apiKey, keyRecord.name, toolName, 0, false, rateResult.reason);
      if (this.config.shadowMode) {
        return { allowed: true, reason: `shadow:${rateResult.reason}`, creditsCharged: 0, remainingCredits: keyRecord.credits };
      }
      return { allowed: false, reason: rateResult.reason, creditsCharged: 0, remainingCredits: keyRecord.credits };
    }

    // Step 4: Sufficient credits?
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

    // Step 5: ALLOW — deduct credits and record
    this.store.deductCredits(apiKey, creditsRequired);
    this.rateLimiter.record(apiKey);
    const remaining = this.store.getKey(apiKey)?.credits ?? 0;
    this.recordEvent(apiKey, keyRecord.name, toolName, creditsRequired, true);

    return { allowed: true, creditsCharged: creditsRequired, remainingCredits: remaining };
  }

  /**
   * Check if a method is free (no auth required).
   */
  isFreeMethod(method: string): boolean {
    return this.config.freeMethods.includes(method);
  }

  /**
   * Get price for a tool in credits.
   */
  getToolPrice(toolName: string): number {
    const override = this.config.toolPricing[toolName];
    if (override) return override.creditsPerCall;
    return this.config.defaultCreditsPerCall;
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
      },
    };
  }

  destroy(): void {
    this.rateLimiter.destroy();
  }

  private recordEvent(
    apiKey: string, keyName: string, tool: string,
    creditsCharged: number, allowed: boolean, denyReason?: string,
  ): void {
    this.meter.record({
      timestamp: new Date().toISOString(),
      apiKey: apiKey.slice(0, 10),
      keyName,
      tool,
      creditsCharged,
      allowed,
      denyReason,
    });
  }
}
