import { MultiCurrencyManager } from '../src/multi-currency';

describe('MultiCurrencyManager', () => {
  let manager: MultiCurrencyManager;

  beforeEach(() => {
    manager = new MultiCurrencyManager({ baseCurrency: 'USD' });
  });

  afterEach(() => {
    manager.destroy();
  });

  // ─── Currency Management ────────────────────────────────────────

  test('default USD currency is preset', () => {
    const usd = manager.getCurrency('USD');
    expect(usd).toBeTruthy();
    expect(usd!.code).toBe('USD');
    expect(usd!.creditsPerUnit).toBe(100);
    expect(usd!.symbol).toBe('$');
  });

  test('upsert new currency', () => {
    const ok = manager.upsertCurrency({
      code: 'EUR',
      name: 'Euro',
      symbol: '\u20AC',
      creditsPerUnit: 110,
      decimals: 2,
      symbolBefore: true,
      active: true,
    });
    expect(ok).toBe(true);

    const eur = manager.getCurrency('EUR');
    expect(eur).toBeTruthy();
    expect(eur!.creditsPerUnit).toBe(110);
  });

  test('reject invalid creditsPerUnit', () => {
    const ok = manager.upsertCurrency({
      code: 'BAD',
      name: 'Bad',
      symbol: '!',
      creditsPerUnit: 0,
      decimals: 2,
      symbolBefore: true,
      active: true,
    });
    expect(ok).toBe(false);
  });

  test('enforce max currencies', () => {
    const small = new MultiCurrencyManager({ maxCurrencies: 2 });
    // USD already preset = 1
    small.upsertCurrency({ code: 'EUR', name: 'Euro', symbol: '\u20AC', creditsPerUnit: 110, decimals: 2, symbolBefore: true, active: true });
    const ok = small.upsertCurrency({ code: 'GBP', name: 'Pound', symbol: '\u00A3', creditsPerUnit: 125, decimals: 2, symbolBefore: true, active: true });
    expect(ok).toBe(false);
    small.destroy();
  });

  test('remove a currency', () => {
    manager.upsertCurrency({ code: 'JPY', name: 'Yen', symbol: '\u00A5', creditsPerUnit: 0.7, decimals: 0, symbolBefore: true, active: true });
    expect(manager.removeCurrency('JPY')).toBe(true);
    expect(manager.getCurrency('JPY')).toBeNull();
  });

  test('cannot remove base currency', () => {
    expect(manager.removeCurrency('USD')).toBe(false);
  });

  test('get all currencies', () => {
    manager.upsertCurrency({ code: 'GBP', name: 'Pound', symbol: '\u00A3', creditsPerUnit: 125, decimals: 2, symbolBefore: true, active: true });
    const all = manager.getCurrencies();
    expect(all.length).toBe(2);
  });

  test('get active currencies only', () => {
    manager.upsertCurrency({ code: 'GBP', name: 'Pound', symbol: '\u00A3', creditsPerUnit: 125, decimals: 2, symbolBefore: true, active: true });
    manager.upsertCurrency({ code: 'AUD', name: 'AUD', symbol: 'A$', creditsPerUnit: 65, decimals: 2, symbolBefore: true, active: false });
    const active = manager.getActiveCurrencies();
    expect(active.length).toBe(2); // USD + GBP
    expect(active.every(c => c.active)).toBe(true);
  });

  test('update exchange rate', () => {
    expect(manager.updateRate('USD', 150)).toBe(true);
    expect(manager.getCurrency('USD')!.creditsPerUnit).toBe(150);
  });

  test('reject invalid rate update', () => {
    expect(manager.updateRate('USD', -1)).toBe(false);
    expect(manager.updateRate('NOPE', 100)).toBe(false);
  });

  // ─── Credits to Money ───────────────────────────────────────────

  test('convert credits to USD', () => {
    const result = manager.creditsToMoney(250, 'USD');
    expect(result).toBeTruthy();
    expect(result!.credits).toBe(250);
    expect(result!.currency).toBe('USD');
    expect(result!.amount).toBe(2.50);
    expect(result!.formatted).toBe('$2.50');
    expect(result!.rate).toBe(100);
  });

  test('convert credits to EUR', () => {
    manager.upsertCurrency({ code: 'EUR', name: 'Euro', symbol: '\u20AC', creditsPerUnit: 110, decimals: 2, symbolBefore: true, active: true });
    const result = manager.creditsToMoney(550, 'EUR');
    expect(result).toBeTruthy();
    expect(result!.amount).toBe(5.00);
    expect(result!.formatted).toBe('\u20AC5.00');
  });

  test('convert credits to currency with symbol after', () => {
    manager.upsertCurrency({ code: 'SEK', name: 'Swedish Krona', symbol: ' kr', creditsPerUnit: 10, decimals: 2, symbolBefore: false, active: true });
    const result = manager.creditsToMoney(100, 'SEK');
    expect(result).toBeTruthy();
    expect(result!.amount).toBe(10.00);
    expect(result!.formatted).toBe('10.00 kr');
  });

  test('credits to money returns null for inactive currency', () => {
    manager.upsertCurrency({ code: 'INR', name: 'Rupee', symbol: '\u20B9', creditsPerUnit: 1.2, decimals: 2, symbolBefore: true, active: false });
    expect(manager.creditsToMoney(100, 'INR')).toBeNull();
  });

  test('credits to money returns null for unknown currency', () => {
    expect(manager.creditsToMoney(100, 'XYZ')).toBeNull();
  });

  // ─── Money to Credits ───────────────────────────────────────────

  test('convert USD to credits', () => {
    const result = manager.moneyToCredits(5.00, 'USD');
    expect(result).toBeTruthy();
    expect(result!.credits).toBe(500);
    expect(result!.amount).toBe(5.00);
    expect(result!.currency).toBe('USD');
  });

  test('convert EUR to credits', () => {
    manager.upsertCurrency({ code: 'EUR', name: 'Euro', symbol: '\u20AC', creditsPerUnit: 110, decimals: 2, symbolBefore: true, active: true });
    const result = manager.moneyToCredits(10, 'EUR');
    expect(result).toBeTruthy();
    expect(result!.credits).toBe(1100);
  });

  test('money to credits uses floor', () => {
    const result = manager.moneyToCredits(1.999, 'USD');
    expect(result).toBeTruthy();
    expect(result!.credits).toBe(199); // floor(1.999 * 100) = 199
  });

  // ─── Tool Pricing ───────────────────────────────────────────────

  test('get tool pricing across currencies', () => {
    manager.upsertCurrency({ code: 'EUR', name: 'Euro', symbol: '\u20AC', creditsPerUnit: 110, decimals: 2, symbolBefore: true, active: true });

    const pricing = manager.getToolPricing('generate_text', 50);
    expect(pricing.tool).toBe('generate_text');
    expect(pricing.credits).toBe(50);
    expect(pricing.prices['USD']).toBeTruthy();
    expect(pricing.prices['USD'].amount).toBe(0.50);
    expect(pricing.prices['EUR']).toBeTruthy();
    expect(pricing.prices['EUR'].amount).toBeCloseTo(0.45, 2);
  });

  test('tool pricing excludes inactive currencies', () => {
    manager.upsertCurrency({ code: 'GBP', name: 'Pound', symbol: '\u00A3', creditsPerUnit: 125, decimals: 2, symbolBefore: true, active: false });
    const pricing = manager.getToolPricing('tool', 100);
    expect(pricing.prices['GBP']).toBeUndefined();
  });

  // ─── Cross-Currency Conversion ──────────────────────────────────

  test('convert between two currencies', () => {
    manager.upsertCurrency({ code: 'EUR', name: 'Euro', symbol: '\u20AC', creditsPerUnit: 110, decimals: 2, symbolBefore: true, active: true });
    // $10 USD → EUR: 10 * 100 credits / 110 credits per EUR = ~9.09 EUR
    const result = manager.convertBetween(10, 'USD', 'EUR');
    expect(result).toBeTruthy();
    expect(result!.amount).toBeCloseTo(9.09, 2);
    expect(result!.formatted).toContain('\u20AC');
  });

  test('convert between returns null for inactive currency', () => {
    manager.upsertCurrency({ code: 'GBP', name: 'Pound', symbol: '\u00A3', creditsPerUnit: 125, decimals: 2, symbolBefore: true, active: false });
    expect(manager.convertBetween(10, 'USD', 'GBP')).toBeNull();
  });

  test('convert between returns null for unknown currency', () => {
    expect(manager.convertBetween(10, 'USD', 'XYZ')).toBeNull();
  });

  // ─── Base Currency ──────────────────────────────────────────────

  test('get and set base currency', () => {
    manager.upsertCurrency({ code: 'EUR', name: 'Euro', symbol: '\u20AC', creditsPerUnit: 110, decimals: 2, symbolBefore: true, active: true });
    expect(manager.getBaseCurrency()).toBe('USD');
    expect(manager.setBaseCurrency('EUR')).toBe(true);
    expect(manager.getBaseCurrency()).toBe('EUR');
  });

  test('cannot set base to unknown currency', () => {
    expect(manager.setBaseCurrency('XYZ')).toBe(false);
  });

  // ─── Stats ──────────────────────────────────────────────────────

  test('stats track conversions', () => {
    manager.creditsToMoney(100, 'USD');
    manager.moneyToCredits(5, 'USD');
    manager.creditsToMoney(200, 'USD');

    const stats = manager.getStats();
    expect(stats.totalCurrencies).toBe(1);
    expect(stats.activeCurrencies).toBe(1);
    expect(stats.totalConversions).toBe(3);
    expect(stats.conversionsByCurrency['USD']).toBe(3);
  });

  test('resetStats clears counters', () => {
    manager.creditsToMoney(100, 'USD');
    manager.resetStats();
    expect(manager.getStats().totalConversions).toBe(0);
  });

  test('destroy clears everything', () => {
    manager.upsertCurrency({ code: 'EUR', name: 'Euro', symbol: '\u20AC', creditsPerUnit: 110, decimals: 2, symbolBefore: true, active: true });
    manager.creditsToMoney(100, 'USD');
    manager.destroy();

    expect(manager.getCurrencies().length).toBe(0);
    expect(manager.getStats().totalConversions).toBe(0);
  });

  // ─── Zero Decimal Currencies ────────────────────────────────────

  test('handle zero-decimal currency (JPY)', () => {
    manager.upsertCurrency({ code: 'JPY', name: 'Yen', symbol: '\u00A5', creditsPerUnit: 0.67, decimals: 0, symbolBefore: true, active: true });
    const result = manager.creditsToMoney(100, 'JPY');
    expect(result).toBeTruthy();
    expect(result!.amount).toBe(Math.round(100 / 0.67));
    expect(result!.formatted).toMatch(/^\u00A5\d+$/);
  });
});
