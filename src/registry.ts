/**
 * ToolRegistry — Agent-discoverable pricing and payment metadata.
 *
 * Enables AI agents to programmatically discover:
 *   - What tools are available and their pricing
 *   - Payment requirements before calling tools
 *   - Server-level payment metadata (accepted methods, billing model)
 *
 * Aligns with SEP-2007 (MCP Payment Spec Draft):
 *   - Payment requirements in tools/list responses
 *   - /.well-known/mcp-payment for server metadata
 *   - Pricing details in -32402 error responses
 */

import { PayGateConfig, ToolPricing, QuotaConfig } from './types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolPricingInfo {
  /** Tool name */
  name: string;
  /** Base credits per call */
  creditsPerCall: number;
  /** Extra credits per KB of input (0 = flat rate) */
  creditsPerKbInput: number;
  /** Per-tool rate limit (calls/min). 0 = uses global limit. */
  rateLimitPerMin: number;
  /** Pricing model: "flat" or "dynamic" */
  pricingModel: 'flat' | 'dynamic';
}

export interface ServerPaymentMetadata {
  /** MCP payment spec version */
  specVersion: string;
  /** Server name */
  serverName: string;
  /** Billing model */
  billingModel: 'credits';
  /** Default price per tool call */
  defaultCreditsPerCall: number;
  /** Global rate limit (calls/min per key) */
  globalRateLimitPerMin: number;
  /** Shadow mode (billing not enforced) */
  shadowMode: boolean;
  /** Accepted authentication methods */
  authMethods: string[];
  /** OAuth 2.1 supported */
  oauthSupported: boolean;
  /** Supported payment error code */
  paymentErrorCode: number;
  /** Pricing endpoint URL path */
  pricingEndpoint: string;
  /** Global quota defaults (if any) */
  globalQuota: QuotaConfig | null;
  /** Total number of gated tools */
  toolCount: number;
}

export interface PricingResponse {
  /** Server payment metadata */
  server: ServerPaymentMetadata;
  /** Per-tool pricing breakdown */
  tools: ToolPricingInfo[];
}

// ─── ToolRegistry Class ──────────────────────────────────────────────────────

export class ToolRegistry {
  private readonly config: PayGateConfig;
  private readonly hasOAuth: boolean;
  private discoveredTools: string[] = [];

  constructor(config: PayGateConfig, hasOAuth: boolean) {
    this.config = config;
    this.hasOAuth = hasOAuth;
  }

  /**
   * Update the list of discovered tools (from backend server).
   * Called when tools/list succeeds for the first time.
   */
  setDiscoveredTools(toolNames: string[]): void {
    this.discoveredTools = toolNames;
  }

  /**
   * Get server-level payment metadata.
   * Returned at /.well-known/mcp-payment
   */
  getServerMetadata(): ServerPaymentMetadata {
    const authMethods = ['X-API-Key'];
    if (this.hasOAuth) authMethods.push('Bearer (OAuth 2.1)');

    return {
      specVersion: '2007-draft',
      serverName: this.config.name,
      billingModel: 'credits',
      defaultCreditsPerCall: this.config.defaultCreditsPerCall,
      globalRateLimitPerMin: this.config.globalRateLimitPerMin,
      shadowMode: this.config.shadowMode,
      authMethods,
      oauthSupported: this.hasOAuth,
      paymentErrorCode: -32402,
      pricingEndpoint: '/pricing',
      globalQuota: this.config.globalQuota || null,
      toolCount: this.discoveredTools.length,
    };
  }

  /**
   * Get pricing info for a specific tool.
   */
  getToolPricing(toolName: string): ToolPricingInfo {
    const override = this.config.toolPricing[toolName];
    const creditsPerCall = override?.creditsPerCall ?? this.config.defaultCreditsPerCall;
    const creditsPerKbInput = override?.creditsPerKbInput ?? 0;
    const rateLimitPerMin = override?.rateLimitPerMin ?? 0;

    return {
      name: toolName,
      creditsPerCall,
      creditsPerKbInput,
      rateLimitPerMin,
      pricingModel: creditsPerKbInput > 0 ? 'dynamic' : 'flat',
    };
  }

  /**
   * Get full pricing response for all known tools.
   * Returned at /pricing
   */
  getFullPricing(): PricingResponse {
    return {
      server: this.getServerMetadata(),
      tools: this.discoveredTools.map(name => this.getToolPricing(name)),
    };
  }

  /**
   * Inject pricing metadata into a tools/list response.
   * Adds `_pricing` field to each tool in the result.
   */
  injectPricingIntoToolsList(tools: Array<{ name: string; [k: string]: unknown }>): Array<{ name: string; _pricing: ToolPricingInfo; [k: string]: unknown }> {
    // Update discovered tools from this list
    this.setDiscoveredTools(tools.map(t => t.name));

    return tools.map(tool => ({
      ...tool,
      _pricing: this.getToolPricing(tool.name),
    }));
  }

  /**
   * Build payment requirement data for -32402 error responses.
   * Helps agents understand what they need to do to afford the tool.
   */
  buildPaymentRequired(toolName: string, creditsNeeded: number, creditsAvailable: number): Record<string, unknown> {
    const pricing = this.getToolPricing(toolName);
    return {
      tool: toolName,
      creditsNeeded,
      creditsAvailable,
      pricing,
      topUpEndpoint: '/topup',
      balanceEndpoint: '/balance',
      pricingEndpoint: '/pricing',
    };
  }
}
