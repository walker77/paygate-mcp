/**
 * Multi-Currency Credit Conversion — Currency-Aware Billing.
 *
 * Convert between credits and multiple fiat currencies.
 * Supports configurable exchange rates, currency-specific pricing,
 * and display formatting per locale.
 *
 * Use cases:
 *   - International billing in local currencies
 *   - Display credit costs in user's preferred currency
 *   - Multi-region pricing strategies
 *
 * Zero external dependencies.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CurrencyRate {
  /** ISO 4217 currency code (e.g., 'USD', 'EUR', 'GBP'). */
  code: string;
  /** Display name (e.g., 'US Dollar'). */
  name: string;
  /** Symbol (e.g., '$', '\u20AC', '\u00A3'). */
  symbol: string;
  /** Credits per 1 unit of this currency. E.g., 100 means $1 = 100 credits. */
  creditsPerUnit: number;
  /** Decimal places for display. Default: 2. */
  decimals: number;
  /** Whether symbol goes before amount. Default: true. */
  symbolBefore: boolean;
  /** Whether this currency is active. */
  active: boolean;
  /** When the rate was last updated (ISO). */
  updatedAt: string;
}

export interface CreditConversion {
  /** Source amount in credits. */
  credits: number;
  /** Target currency code. */
  currency: string;
  /** Converted monetary amount. */
  amount: number;
  /** Formatted display string (e.g., '$1.50'). */
  formatted: string;
  /** Rate used for conversion. */
  rate: number;
}

export interface MonetaryConversion {
  /** Source monetary amount. */
  amount: number;
  /** Source currency code. */
  currency: string;
  /** Credits equivalent. */
  credits: number;
  /** Rate used for conversion. */
  rate: number;
}

export interface CurrencyPricing {
  /** Tool name. */
  tool: string;
  /** Credit cost per call. */
  credits: number;
  /** Prices in each active currency. */
  prices: Record<string, { amount: number; formatted: string }>;
}

export interface MultiCurrencyConfig {
  /** Base currency code. Default: 'USD'. */
  baseCurrency?: string;
  /** Maximum currencies. Default: 50. */
  maxCurrencies?: number;
}

export interface MultiCurrencyStats {
  /** Total currencies configured. */
  totalCurrencies: number;
  /** Active currencies. */
  activeCurrencies: number;
  /** Total conversions performed. */
  totalConversions: number;
  /** Conversions by currency. */
  conversionsByCurrency: Record<string, number>;
}

// ─── Multi-Currency Manager ─────────────────────────────────────────────────

export class MultiCurrencyManager {
  private currencies = new Map<string, CurrencyRate>();
  private baseCurrency: string;
  private maxCurrencies: number;

  // Stats
  private totalConversions = 0;
  private conversionsByCurrency: Record<string, number> = {};

  constructor(config: MultiCurrencyConfig = {}) {
    this.baseCurrency = config.baseCurrency ?? 'USD';
    this.maxCurrencies = config.maxCurrencies ?? 50;

    // Add default USD
    this.currencies.set('USD', {
      code: 'USD',
      name: 'US Dollar',
      symbol: '$',
      creditsPerUnit: 100,
      decimals: 2,
      symbolBefore: true,
      active: true,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Add or update a currency. */
  upsertCurrency(currency: Omit<CurrencyRate, 'updatedAt'> & { updatedAt?: string }): boolean {
    if (this.currencies.size >= this.maxCurrencies && !this.currencies.has(currency.code)) {
      return false;
    }
    if (currency.creditsPerUnit <= 0) return false;

    this.currencies.set(currency.code, {
      ...currency,
      updatedAt: currency.updatedAt ?? new Date().toISOString(),
    });
    return true;
  }

  /** Remove a currency. */
  removeCurrency(code: string): boolean {
    if (code === this.baseCurrency) return false; // Can't remove base
    return this.currencies.delete(code);
  }

  /** Get a currency. */
  getCurrency(code: string): CurrencyRate | null {
    return this.currencies.get(code) ?? null;
  }

  /** Get all currencies. */
  getCurrencies(): CurrencyRate[] {
    return [...this.currencies.values()];
  }

  /** Get active currencies. */
  getActiveCurrencies(): CurrencyRate[] {
    return [...this.currencies.values()].filter(c => c.active);
  }

  /** Update the exchange rate for a currency. */
  updateRate(code: string, creditsPerUnit: number): boolean {
    const currency = this.currencies.get(code);
    if (!currency) return false;
    if (creditsPerUnit <= 0) return false;

    currency.creditsPerUnit = creditsPerUnit;
    currency.updatedAt = new Date().toISOString();
    return true;
  }

  /**
   * Convert credits to a monetary amount.
   */
  creditsToMoney(credits: number, currencyCode: string): CreditConversion | null {
    const currency = this.currencies.get(currencyCode);
    if (!currency || !currency.active) return null;

    this.totalConversions++;
    this.conversionsByCurrency[currencyCode] = (this.conversionsByCurrency[currencyCode] ?? 0) + 1;

    const amount = credits / currency.creditsPerUnit;
    const roundedAmount = Math.round(amount * Math.pow(10, currency.decimals)) / Math.pow(10, currency.decimals);

    return {
      credits,
      currency: currencyCode,
      amount: roundedAmount,
      formatted: this.formatAmount(roundedAmount, currency),
      rate: currency.creditsPerUnit,
    };
  }

  /**
   * Convert a monetary amount to credits.
   */
  moneyToCredits(amount: number, currencyCode: string): MonetaryConversion | null {
    const currency = this.currencies.get(currencyCode);
    if (!currency || !currency.active) return null;

    this.totalConversions++;
    this.conversionsByCurrency[currencyCode] = (this.conversionsByCurrency[currencyCode] ?? 0) + 1;

    const credits = Math.floor(amount * currency.creditsPerUnit);

    return {
      amount,
      currency: currencyCode,
      credits,
      rate: currency.creditsPerUnit,
    };
  }

  /**
   * Get pricing for a tool in all active currencies.
   */
  getToolPricing(tool: string, creditCost: number): CurrencyPricing {
    const prices: Record<string, { amount: number; formatted: string }> = {};

    for (const currency of this.currencies.values()) {
      if (!currency.active) continue;
      const amount = creditCost / currency.creditsPerUnit;
      const rounded = Math.round(amount * Math.pow(10, currency.decimals)) / Math.pow(10, currency.decimals);
      prices[currency.code] = {
        amount: rounded,
        formatted: this.formatAmount(rounded, currency),
      };
    }

    return { tool, credits: creditCost, prices };
  }

  /**
   * Convert between two currencies via credits.
   */
  convertBetween(amount: number, fromCurrency: string, toCurrency: string): { amount: number; formatted: string } | null {
    const from = this.currencies.get(fromCurrency);
    const to = this.currencies.get(toCurrency);
    if (!from || !to || !from.active || !to.active) return null;

    const credits = amount * from.creditsPerUnit;
    const converted = credits / to.creditsPerUnit;
    const rounded = Math.round(converted * Math.pow(10, to.decimals)) / Math.pow(10, to.decimals);

    this.totalConversions++;

    return {
      amount: rounded,
      formatted: this.formatAmount(rounded, to),
    };
  }

  /** Get the base currency code. */
  getBaseCurrency(): string {
    return this.baseCurrency;
  }

  /** Set the base currency. */
  setBaseCurrency(code: string): boolean {
    if (!this.currencies.has(code)) return false;
    this.baseCurrency = code;
    return true;
  }

  /** Get stats. */
  getStats(): MultiCurrencyStats {
    return {
      totalCurrencies: this.currencies.size,
      activeCurrencies: [...this.currencies.values()].filter(c => c.active).length,
      totalConversions: this.totalConversions,
      conversionsByCurrency: { ...this.conversionsByCurrency },
    };
  }

  /** Reset stats. */
  resetStats(): void {
    this.totalConversions = 0;
    this.conversionsByCurrency = {};
  }

  /** Destroy and release resources. */
  destroy(): void {
    this.currencies.clear();
    this.resetStats();
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private formatAmount(amount: number, currency: CurrencyRate): string {
    const fixed = amount.toFixed(currency.decimals);
    if (currency.symbolBefore) {
      return `${currency.symbol}${fixed}`;
    }
    return `${fixed}${currency.symbol}`;
  }
}
