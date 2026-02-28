/**
 * DynamicPricingEngine — Adjust tool pricing based on demand, time, and usage.
 *
 * Supports time-of-day multipliers, demand-based surge pricing,
 * volume discounts, and per-key custom pricing. All pricing rules
 * are composable and evaluated in priority order.
 *
 * @example
 * ```ts
 * const engine = new DynamicPricingEngine();
 *
 * engine.setBasePrice('search', 10);
 *
 * engine.addRule({
 *   tool: 'search',
 *   type: 'time_of_day',
 *   config: { peakHours: [9,10,11,12,13,14,15,16,17], multiplier: 1.5 },
 * });
 *
 * const price = engine.getPrice('search');
 * // 15 during peak hours, 10 otherwise
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type PricingRuleType =
  | 'time_of_day'
  | 'demand'
  | 'volume_discount'
  | 'key_override'
  | 'custom';

export interface TimeOfDayConfig {
  /** Hours (0-23) considered peak. */
  peakHours: number[];
  /** Multiplier during peak hours. */
  multiplier: number;
}

export interface DemandConfig {
  /** Calls in the window that trigger surge. */
  threshold: number;
  /** Time window in seconds. */
  windowSeconds: number;
  /** Max multiplier at full surge. */
  maxMultiplier: number;
}

export interface VolumeDiscountConfig {
  /** Tiers: [{ minCalls, discount }] — discount is 0-1 (e.g., 0.2 = 20% off). */
  tiers: { minCalls: number; discount: number }[];
}

export interface KeyOverrideConfig {
  /** Key → fixed price. */
  keyPrices: Map<string, number>;
}

export interface CustomRuleConfig {
  /** Custom function: (basePrice, context) => adjustedPrice. */
  fn: (basePrice: number, context: PricingContext) => number;
}

export type PricingRuleConfig =
  | TimeOfDayConfig
  | DemandConfig
  | VolumeDiscountConfig
  | KeyOverrideConfig
  | CustomRuleConfig;

export interface PricingRule {
  id: string;
  tool: string;
  type: PricingRuleType;
  config: PricingRuleConfig;
  /** Higher priority rules evaluated first. Default 0. */
  priority: number;
  enabled: boolean;
  createdAt: number;
}

export interface PricingRuleRegistration {
  tool: string;
  type: PricingRuleType;
  config: PricingRuleConfig;
  priority?: number;
}

export interface PricingContext {
  tool: string;
  key?: string;
  timestamp: number;
  recentCalls: number;
  totalCalls: number;
}

export interface PriceResult {
  tool: string;
  basePrice: number;
  finalPrice: number;
  appliedRules: string[];
  multiplier: number;
}

export interface DynamicPricingConfig {
  /** Default base price for tools without explicit pricing. */
  defaultBasePrice?: number;
  /** Window for demand tracking in seconds. Default 300 (5 min). */
  demandWindowSeconds?: number;
}

export interface DynamicPricingStats {
  totalTools: number;
  totalRules: number;
  enabledRules: number;
  totalPriceCalculations: number;
  totalCallsTracked: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class DynamicPricingEngine {
  // tool → base price
  private basePrices = new Map<string, number>();
  // ruleId → PricingRule
  private rules = new Map<string, PricingRule>();
  private ruleCounter = 0;
  private defaultBasePrice: number;
  private demandWindowSeconds: number;

  // Demand tracking: tool → timestamps of recent calls
  private callTimestamps = new Map<string, number[]>();
  // Volume tracking: key:tool → total calls
  private volumeTracker = new Map<string, number>();

  // Stats
  private totalCalculations = 0;
  private totalCallsTracked = 0;

  constructor(config: DynamicPricingConfig = {}) {
    this.defaultBasePrice = config.defaultBasePrice ?? 1;
    this.demandWindowSeconds = config.demandWindowSeconds ?? 300;
  }

  // ── Base Prices ───────────────────────────────────────────────────

  /** Set the base credit price for a tool. */
  setBasePrice(tool: string, price: number): void {
    if (price < 0) throw new Error('Base price cannot be negative');
    this.basePrices.set(tool, price);
  }

  /** Get the base price for a tool. */
  getBasePrice(tool: string): number {
    return this.basePrices.get(tool) ?? this.defaultBasePrice;
  }

  /** Remove base price (falls back to default). */
  removeBasePrice(tool: string): boolean {
    return this.basePrices.delete(tool);
  }

  // ── Rules ─────────────────────────────────────────────────────────

  /** Add a pricing rule. Returns the rule ID. */
  addRule(reg: PricingRuleRegistration): string {
    const id = `rule_${++this.ruleCounter}`;
    const rule: PricingRule = {
      id,
      tool: reg.tool,
      type: reg.type,
      config: reg.config,
      priority: reg.priority ?? 0,
      enabled: true,
      createdAt: Date.now(),
    };
    this.rules.set(id, rule);
    return id;
  }

  /** Remove a pricing rule. */
  removeRule(id: string): boolean {
    return this.rules.delete(id);
  }

  /** Enable or disable a rule. */
  setRuleEnabled(id: string, enabled: boolean): boolean {
    const rule = this.rules.get(id);
    if (!rule) return false;
    rule.enabled = enabled;
    return true;
  }

  /** Get a specific rule. */
  getRule(id: string): PricingRule | null {
    return this.rules.get(id) ?? null;
  }

  /** List all rules for a tool. */
  getToolRules(tool: string): PricingRule[] {
    return [...this.rules.values()]
      .filter(r => r.tool === tool)
      .sort((a, b) => b.priority - a.priority);
  }

  // ── Demand Tracking ────────────────────────────────────────────────

  /** Record a tool call for demand tracking. */
  recordCall(tool: string, key?: string): void {
    // Track timestamps for demand pricing
    if (!this.callTimestamps.has(tool)) {
      this.callTimestamps.set(tool, []);
    }
    this.callTimestamps.get(tool)!.push(Date.now());
    this.totalCallsTracked++;

    // Track volume per key
    if (key) {
      const volumeKey = `${key}:${tool}`;
      this.volumeTracker.set(volumeKey, (this.volumeTracker.get(volumeKey) ?? 0) + 1);
    }

    // Prune old timestamps
    this.pruneTimestamps(tool);
  }

  /** Get recent call count for a tool. */
  getRecentCallCount(tool: string): number {
    this.pruneTimestamps(tool);
    return this.callTimestamps.get(tool)?.length ?? 0;
  }

  /** Get total calls for a key+tool combo. */
  getKeyToolVolume(key: string, tool: string): number {
    return this.volumeTracker.get(`${key}:${tool}`) ?? 0;
  }

  // ── Price Calculation ─────────────────────────────────────────────

  /** Calculate the current price for a tool call. */
  getPrice(tool: string, key?: string): PriceResult {
    this.totalCalculations++;

    const basePrice = this.getBasePrice(tool);
    const context: PricingContext = {
      tool,
      key,
      timestamp: Date.now(),
      recentCalls: this.getRecentCallCount(tool),
      totalCalls: key ? this.getKeyToolVolume(key, tool) : 0,
    };

    // Get enabled rules for this tool, sorted by priority (highest first)
    const rules = [...this.rules.values()]
      .filter(r => r.tool === tool && r.enabled)
      .sort((a, b) => b.priority - a.priority);

    let price = basePrice;
    const appliedRules: string[] = [];

    for (const rule of rules) {
      const newPrice = this.applyRule(rule, price, context);
      if (newPrice !== price) {
        price = newPrice;
        appliedRules.push(rule.id);
      }
    }

    // Ensure price is non-negative
    price = Math.max(0, Math.round(price));

    return {
      tool,
      basePrice,
      finalPrice: price,
      appliedRules,
      multiplier: basePrice > 0 ? price / basePrice : 1,
    };
  }

  // ── Stats ─────────────────────────────────────────────────────────

  getStats(): DynamicPricingStats {
    const enabledRules = [...this.rules.values()].filter(r => r.enabled).length;
    return {
      totalTools: this.basePrices.size,
      totalRules: this.rules.size,
      enabledRules,
      totalPriceCalculations: this.totalCalculations,
      totalCallsTracked: this.totalCallsTracked,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.basePrices.clear();
    this.rules.clear();
    this.callTimestamps.clear();
    this.volumeTracker.clear();
    this.totalCalculations = 0;
    this.totalCallsTracked = 0;
    this.ruleCounter = 0;
  }

  // ── Private ───────────────────────────────────────────────────────

  private applyRule(rule: PricingRule, currentPrice: number, ctx: PricingContext): number {
    switch (rule.type) {
      case 'time_of_day':
        return this.applyTimeOfDay(rule.config as TimeOfDayConfig, currentPrice, ctx);
      case 'demand':
        return this.applyDemand(rule.config as DemandConfig, currentPrice, ctx);
      case 'volume_discount':
        return this.applyVolumeDiscount(rule.config as VolumeDiscountConfig, currentPrice, ctx);
      case 'key_override':
        return this.applyKeyOverride(rule.config as KeyOverrideConfig, currentPrice, ctx);
      case 'custom':
        return this.applyCustom(rule.config as CustomRuleConfig, currentPrice, ctx);
      default:
        return currentPrice;
    }
  }

  private applyTimeOfDay(config: TimeOfDayConfig, price: number, ctx: PricingContext): number {
    const hour = new Date(ctx.timestamp).getHours();
    if (config.peakHours.includes(hour)) {
      return price * config.multiplier;
    }
    return price;
  }

  private applyDemand(config: DemandConfig, price: number, ctx: PricingContext): number {
    if (ctx.recentCalls < config.threshold) return price;

    // Linear surge: 1x at threshold, maxMultiplier at 2x threshold
    const ratio = Math.min((ctx.recentCalls - config.threshold) / config.threshold, 1);
    const multiplier = 1 + ratio * (config.maxMultiplier - 1);
    return price * multiplier;
  }

  private applyVolumeDiscount(config: VolumeDiscountConfig, price: number, ctx: PricingContext): number {
    if (!ctx.key) return price;

    // Sort tiers descending by minCalls, find the highest qualifying tier
    const sorted = [...config.tiers].sort((a, b) => b.minCalls - a.minCalls);
    for (const tier of sorted) {
      if (ctx.totalCalls >= tier.minCalls) {
        return price * (1 - tier.discount);
      }
    }
    return price;
  }

  private applyKeyOverride(config: KeyOverrideConfig, _price: number, ctx: PricingContext): number {
    if (!ctx.key) return _price;
    const override = config.keyPrices.get(ctx.key);
    return override !== undefined ? override : _price;
  }

  private applyCustom(config: CustomRuleConfig, price: number, ctx: PricingContext): number {
    try {
      return config.fn(price, ctx);
    } catch {
      return price; // Fail-safe: return original price
    }
  }

  private pruneTimestamps(tool: string): void {
    const timestamps = this.callTimestamps.get(tool);
    if (!timestamps) return;
    const cutoff = Date.now() - this.demandWindowSeconds * 1000;
    const pruned = timestamps.filter(t => t >= cutoff);
    this.callTimestamps.set(tool, pruned);
  }
}
