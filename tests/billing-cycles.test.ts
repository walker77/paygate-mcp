import { BillingCycleManager } from '../src/billing-cycles';

describe('BillingCycleManager', () => {
  let billing: BillingCycleManager;

  beforeEach(() => {
    billing = new BillingCycleManager();
  });

  afterEach(() => {
    billing.destroy();
  });

  // ─── Subscription ─────────────────────────────────────────────────

  test('create subscription', () => {
    const sub = billing.createSubscription({ key: 'k1', frequency: 'monthly', startDate: '2026-02-01' });
    expect(sub.key).toBe('k1');
    expect(sub.frequency).toBe('monthly');
    expect(sub.active).toBe(true);
    expect(sub.currentCycleStart).toBeTruthy();
    expect(sub.currentCycleEnd).toBeGreaterThan(sub.currentCycleStart);
  });

  test('create subscription with default start date', () => {
    const sub = billing.createSubscription({ key: 'k1', frequency: 'daily' });
    expect(sub.startDate).toBeTruthy();
    expect(sub.active).toBe(true);
  });

  test('get subscription', () => {
    billing.createSubscription({ key: 'k1', frequency: 'weekly' });
    expect(billing.getSubscription('k1')?.frequency).toBe('weekly');
    expect(billing.getSubscription('unknown')).toBeNull();
  });

  test('pause and resume subscription', () => {
    billing.createSubscription({ key: 'k1', frequency: 'monthly' });
    expect(billing.pauseSubscription('k1')).toBe(true);
    expect(billing.getSubscription('k1')?.active).toBe(false);
    expect(billing.resumeSubscription('k1')).toBe(true);
    expect(billing.getSubscription('k1')?.active).toBe(true);
  });

  test('cancel subscription', () => {
    billing.createSubscription({ key: 'k1', frequency: 'monthly' });
    expect(billing.cancelSubscription('k1')).toBe(true);
    expect(billing.getSubscription('k1')).toBeNull();
    expect(billing.cancelSubscription('nonexistent')).toBe(false);
  });

  test('list subscriptions', () => {
    billing.createSubscription({ key: 'k1', frequency: 'monthly' });
    billing.createSubscription({ key: 'k2', frequency: 'weekly' });
    expect(billing.listSubscriptions().length).toBe(2);
  });

  // ─── Usage Recording ──────────────────────────────────────────────

  test('record and get usage', () => {
    billing.recordUsage('k1', { tool: 'search', credits: 5 });
    billing.recordUsage('k1', { tool: 'generate', credits: 10 });
    const usage = billing.getUsage('k1');
    expect(usage.length).toBe(2);
    expect(usage[0].tool).toBe('search');
    expect(usage[0].credits).toBe(5);
  });

  test('usage respects time range', () => {
    const now = Date.now();
    billing.recordUsage('k1', { tool: 't', credits: 5 });
    const usage = billing.getUsage('k1', now - 1000, now + 1000);
    expect(usage.length).toBe(1);

    const futureUsage = billing.getUsage('k1', now + 5000);
    expect(futureUsage.length).toBe(0);
  });

  // ─── Invoice Generation ────────────────────────────────────────────

  test('generate invoice with usage', () => {
    billing.createSubscription({ key: 'k1', frequency: 'monthly', startDate: '2026-02-01' });
    billing.recordUsage('k1', { tool: 'search', credits: 5 });
    billing.recordUsage('k1', { tool: 'search', credits: 3 });
    billing.recordUsage('k1', { tool: 'generate', credits: 10 });

    const invoice = billing.generateInvoice('k1')!;
    expect(invoice.id).toMatch(/^inv_/);
    expect(invoice.key).toBe('k1');
    expect(invoice.status).toBe('draft');
    expect(invoice.totalCredits).toBe(18);
    expect(invoice.totalCalls).toBe(3);
    expect(invoice.lineItems.length).toBe(2);

    // Line items sorted by credits descending
    expect(invoice.lineItems[0].tool).toBe('generate');
    expect(invoice.lineItems[0].totalCredits).toBe(10);
    expect(invoice.lineItems[1].tool).toBe('search');
    expect(invoice.lineItems[1].callCount).toBe(2);
  });

  test('generate invoice without subscription returns null', () => {
    expect(billing.generateInvoice('unknown')).toBeNull();
  });

  test('generate empty invoice (no usage)', () => {
    billing.createSubscription({ key: 'k1', frequency: 'daily', startDate: '2026-02-28' });
    const invoice = billing.generateInvoice('k1')!;
    expect(invoice.totalCredits).toBe(0);
    expect(invoice.lineItems.length).toBe(0);
  });

  // ─── Invoice Lifecycle ─────────────────────────────────────────────

  test('finalize invoice', () => {
    billing.createSubscription({ key: 'k1', frequency: 'monthly', startDate: '2026-02-01' });
    billing.recordUsage('k1', { tool: 't', credits: 10 });
    const invoice = billing.generateInvoice('k1')!;

    expect(billing.finalizeInvoice(invoice.id)).toBe(true);
    expect(billing.getInvoice(invoice.id)?.status).toBe('finalized');
    expect(billing.getInvoice(invoice.id)?.finalizedAt).toBeTruthy();
  });

  test('mark invoice as paid', () => {
    billing.createSubscription({ key: 'k1', frequency: 'monthly', startDate: '2026-02-01' });
    billing.recordUsage('k1', { tool: 't', credits: 10 });
    const invoice = billing.generateInvoice('k1')!;
    billing.finalizeInvoice(invoice.id);

    expect(billing.markPaid(invoice.id)).toBe(true);
    expect(billing.getInvoice(invoice.id)?.status).toBe('paid');
  });

  test('cannot mark draft invoice as paid', () => {
    billing.createSubscription({ key: 'k1', frequency: 'monthly', startDate: '2026-02-01' });
    const invoice = billing.generateInvoice('k1')!;
    expect(billing.markPaid(invoice.id)).toBe(false);
  });

  test('void invoice', () => {
    billing.createSubscription({ key: 'k1', frequency: 'monthly', startDate: '2026-02-01' });
    const invoice = billing.generateInvoice('k1')!;
    expect(billing.voidInvoice(invoice.id)).toBe(true);
    expect(billing.getInvoice(invoice.id)?.status).toBe('voided');
  });

  test('cannot void paid invoice', () => {
    billing.createSubscription({ key: 'k1', frequency: 'monthly', startDate: '2026-02-01' });
    billing.recordUsage('k1', { tool: 't', credits: 5 });
    const invoice = billing.generateInvoice('k1')!;
    billing.finalizeInvoice(invoice.id);
    billing.markPaid(invoice.id);
    expect(billing.voidInvoice(invoice.id)).toBe(false);
  });

  // ─── Invoice Query ────────────────────────────────────────────────

  test('get key invoices', () => {
    billing.createSubscription({ key: 'k1', frequency: 'monthly', startDate: '2026-02-01' });
    billing.generateInvoice('k1');
    billing.generateInvoice('k1');
    expect(billing.getKeyInvoices('k1').length).toBe(2);
  });

  test('get key invoices with limit', () => {
    billing.createSubscription({ key: 'k1', frequency: 'monthly', startDate: '2026-02-01' });
    for (let i = 0; i < 5; i++) billing.generateInvoice('k1');
    expect(billing.getKeyInvoices('k1', 2).length).toBe(2);
  });

  test('get invoice by id', () => {
    billing.createSubscription({ key: 'k1', frequency: 'monthly', startDate: '2026-02-01' });
    const invoice = billing.generateInvoice('k1')!;
    expect(billing.getInvoice(invoice.id)?.key).toBe('k1');
    expect(billing.getInvoice('nonexistent')).toBeNull();
  });

  // ─── Billing Frequencies ──────────────────────────────────────────

  test('daily cycle end is 1 day later', () => {
    const sub = billing.createSubscription({ key: 'k1', frequency: 'daily', startDate: '2026-03-01' });
    const diff = sub.currentCycleEnd - sub.currentCycleStart;
    expect(diff).toBe(24 * 3600 * 1000);
  });

  test('weekly cycle end is 7 days later', () => {
    const sub = billing.createSubscription({ key: 'k1', frequency: 'weekly', startDate: '2026-03-01' });
    const diff = sub.currentCycleEnd - sub.currentCycleStart;
    expect(diff).toBe(7 * 24 * 3600 * 1000);
  });

  test('monthly cycle advances by 1 month', () => {
    const sub = billing.createSubscription({ key: 'k1', frequency: 'monthly', startDate: '2026-01-15' });
    const start = new Date(sub.currentCycleStart);
    const end = new Date(sub.currentCycleEnd);
    expect(end.getUTCMonth()).toBe(start.getUTCMonth() + 1);
  });

  // ─── Stats ────────────────────────────────────────────────────────

  test('stats track subscriptions and invoices', () => {
    billing.createSubscription({ key: 'k1', frequency: 'monthly', startDate: '2026-02-01' });
    billing.createSubscription({ key: 'k2', frequency: 'weekly' });
    billing.pauseSubscription('k2');
    billing.recordUsage('k1', { tool: 't', credits: 10 });
    const inv = billing.generateInvoice('k1')!;
    billing.finalizeInvoice(inv.id);

    const stats = billing.getStats();
    expect(stats.totalSubscriptions).toBe(2);
    expect(stats.activeSubscriptions).toBe(1);
    expect(stats.totalInvoices).toBe(1);
    expect(stats.totalUsageRecords).toBe(1);
    expect(stats.totalCreditsInvoiced).toBe(10);
  });

  test('destroy clears everything', () => {
    billing.createSubscription({ key: 'k1', frequency: 'monthly' });
    billing.recordUsage('k1', { tool: 't', credits: 10 });
    billing.generateInvoice('k1');
    billing.destroy();
    expect(billing.getStats().totalSubscriptions).toBe(0);
    expect(billing.getStats().totalInvoices).toBe(0);
  });
});
