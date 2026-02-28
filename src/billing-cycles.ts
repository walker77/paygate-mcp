/**
 * BillingCycleManager — Aggregate usage into billing periods.
 *
 * Creates recurring billing cycles (daily, weekly, monthly) per key,
 * tracks usage within each cycle, and generates invoices.
 *
 * @example
 * ```ts
 * const billing = new BillingCycleManager();
 *
 * billing.createSubscription({
 *   key: 'key_abc',
 *   frequency: 'monthly',
 *   startDate: '2026-02-01',
 * });
 *
 * billing.recordUsage('key_abc', { tool: 'search', credits: 5 });
 *
 * const invoice = billing.generateInvoice('key_abc');
 * // { totalCredits: 5, lineItems: [...], period: { start, end } }
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type BillingFrequency = 'daily' | 'weekly' | 'monthly';
export type InvoiceStatus = 'draft' | 'finalized' | 'paid' | 'voided';

export interface BillingSubscription {
  key: string;
  frequency: BillingFrequency;
  startDate: string; // ISO date: YYYY-MM-DD
  active: boolean;
  currentCycleStart: number; // epoch ms
  currentCycleEnd: number;   // epoch ms
  createdAt: number;
}

export interface SubscriptionCreateParams {
  key: string;
  frequency: BillingFrequency;
  startDate?: string; // default: today
}

export interface UsageRecord {
  tool: string;
  credits: number;
  timestamp: number;
  metadata?: Record<string, string>;
}

export interface InvoiceLineItem {
  tool: string;
  callCount: number;
  totalCredits: number;
}

export interface Invoice {
  id: string;
  key: string;
  status: InvoiceStatus;
  frequency: BillingFrequency;
  periodStart: number;
  periodEnd: number;
  lineItems: InvoiceLineItem[];
  totalCredits: number;
  totalCalls: number;
  createdAt: number;
  finalizedAt?: number;
}

export interface BillingCycleConfig {
  maxUsageRecords?: number;
  maxInvoices?: number;
}

export interface BillingCycleStats {
  totalSubscriptions: number;
  activeSubscriptions: number;
  totalInvoices: number;
  totalUsageRecords: number;
  totalCreditsInvoiced: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class BillingCycleManager {
  private subscriptions = new Map<string, BillingSubscription>();
  private usage = new Map<string, UsageRecord[]>(); // key → records
  private invoices: Invoice[] = [];
  private maxUsageRecords: number;
  private maxInvoices: number;
  private invoiceIdCounter = 0;

  // Stats
  private totalCreditsInvoiced = 0;

  constructor(config: BillingCycleConfig = {}) {
    this.maxUsageRecords = config.maxUsageRecords ?? 50_000;
    this.maxInvoices = config.maxInvoices ?? 10_000;
  }

  // ── Subscription Management ─────────────────────────────────────────

  /** Create a billing subscription for a key. */
  createSubscription(params: SubscriptionCreateParams): BillingSubscription {
    const { key, frequency } = params;
    const startDate = params.startDate ?? new Date().toISOString().split('T')[0];

    const cycleStart = new Date(startDate + 'T00:00:00Z').getTime();
    const cycleEnd = this.computeCycleEnd(cycleStart, frequency);

    const sub: BillingSubscription = {
      key,
      frequency,
      startDate,
      active: true,
      currentCycleStart: cycleStart,
      currentCycleEnd: cycleEnd,
      createdAt: Date.now(),
    };

    this.subscriptions.set(key, sub);
    return sub;
  }

  /** Get subscription for a key. */
  getSubscription(key: string): BillingSubscription | null {
    return this.subscriptions.get(key) ?? null;
  }

  /** Pause a subscription. */
  pauseSubscription(key: string): boolean {
    const sub = this.subscriptions.get(key);
    if (!sub) return false;
    sub.active = false;
    return true;
  }

  /** Resume a subscription. */
  resumeSubscription(key: string): boolean {
    const sub = this.subscriptions.get(key);
    if (!sub) return false;
    sub.active = true;
    return true;
  }

  /** Cancel (remove) a subscription. */
  cancelSubscription(key: string): boolean {
    return this.subscriptions.delete(key);
  }

  /** List all subscriptions. */
  listSubscriptions(): BillingSubscription[] {
    return [...this.subscriptions.values()];
  }

  // ── Usage Recording ──────────────────────────────────────────────────

  /** Record usage for a key. */
  recordUsage(key: string, record: { tool: string; credits: number; metadata?: Record<string, string> }): void {
    if (!this.usage.has(key)) this.usage.set(key, []);
    const records = this.usage.get(key)!;

    records.push({
      tool: record.tool,
      credits: record.credits,
      timestamp: Date.now(),
      metadata: record.metadata,
    });

    // Evict if over limit per key
    if (records.length > this.maxUsageRecords) {
      records.splice(0, records.length - this.maxUsageRecords);
    }
  }

  /** Get usage records for a key within a time range. */
  getUsage(key: string, startTime?: number, endTime?: number): UsageRecord[] {
    const records = this.usage.get(key) ?? [];
    let filtered = records;
    if (startTime) filtered = filtered.filter(r => r.timestamp >= startTime);
    if (endTime) filtered = filtered.filter(r => r.timestamp <= endTime);
    return filtered;
  }

  // ── Invoice Generation ──────────────────────────────────────────────

  /** Generate an invoice for the current billing cycle. */
  generateInvoice(key: string): Invoice | null {
    const sub = this.subscriptions.get(key);
    if (!sub) return null;

    // Advance cycle if past end
    this.advanceCycle(sub);

    // Get usage for current cycle
    const records = this.getUsage(key, sub.currentCycleStart, sub.currentCycleEnd);

    // Aggregate by tool
    const toolMap = new Map<string, { count: number; credits: number }>();
    for (const r of records) {
      const existing = toolMap.get(r.tool) ?? { count: 0, credits: 0 };
      existing.count++;
      existing.credits += r.credits;
      toolMap.set(r.tool, existing);
    }

    const lineItems: InvoiceLineItem[] = [...toolMap.entries()]
      .map(([tool, data]) => ({
        tool,
        callCount: data.count,
        totalCredits: data.credits,
      }))
      .sort((a, b) => b.totalCredits - a.totalCredits);

    const totalCredits = lineItems.reduce((sum, li) => sum + li.totalCredits, 0);
    const totalCalls = lineItems.reduce((sum, li) => sum + li.callCount, 0);

    const invoice: Invoice = {
      id: `inv_${++this.invoiceIdCounter}`,
      key,
      status: 'draft',
      frequency: sub.frequency,
      periodStart: sub.currentCycleStart,
      periodEnd: sub.currentCycleEnd,
      lineItems,
      totalCredits,
      totalCalls,
      createdAt: Date.now(),
    };

    this.invoices.push(invoice);

    // Evict old invoices
    if (this.invoices.length > this.maxInvoices) {
      this.invoices.splice(0, this.invoices.length - this.maxInvoices);
    }

    return invoice;
  }

  /** Finalize an invoice (mark as ready for payment). */
  finalizeInvoice(invoiceId: string): boolean {
    const invoice = this.invoices.find(i => i.id === invoiceId);
    if (!invoice || invoice.status !== 'draft') return false;
    invoice.status = 'finalized';
    invoice.finalizedAt = Date.now();
    this.totalCreditsInvoiced += invoice.totalCredits;
    return true;
  }

  /** Mark an invoice as paid. */
  markPaid(invoiceId: string): boolean {
    const invoice = this.invoices.find(i => i.id === invoiceId);
    if (!invoice || invoice.status !== 'finalized') return false;
    invoice.status = 'paid';
    return true;
  }

  /** Void an invoice. */
  voidInvoice(invoiceId: string): boolean {
    const invoice = this.invoices.find(i => i.id === invoiceId);
    if (!invoice || invoice.status === 'paid') return false;
    invoice.status = 'voided';
    return true;
  }

  /** Get an invoice by ID. */
  getInvoice(id: string): Invoice | null {
    return this.invoices.find(i => i.id === id) ?? null;
  }

  /** Get all invoices for a key. */
  getKeyInvoices(key: string, limit?: number): Invoice[] {
    const result = this.invoices
      .filter(i => i.key === key)
      .sort((a, b) => b.createdAt - a.createdAt);
    return limit ? result.slice(0, limit) : result;
  }

  /** Advance current cycle to the next period. */
  advanceCycle(sub: BillingSubscription): boolean {
    const now = Date.now();
    if (now < sub.currentCycleEnd) return false;

    // Advance until current
    while (sub.currentCycleEnd <= now) {
      sub.currentCycleStart = sub.currentCycleEnd;
      sub.currentCycleEnd = this.computeCycleEnd(sub.currentCycleStart, sub.frequency);
    }
    return true;
  }

  // ── Stats ──────────────────────────────────────────────────────────

  getStats(): BillingCycleStats {
    let totalUsageRecords = 0;
    for (const records of this.usage.values()) {
      totalUsageRecords += records.length;
    }

    return {
      totalSubscriptions: this.subscriptions.size,
      activeSubscriptions: [...this.subscriptions.values()].filter(s => s.active).length,
      totalInvoices: this.invoices.length,
      totalUsageRecords,
      totalCreditsInvoiced: this.totalCreditsInvoiced,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.subscriptions.clear();
    this.usage.clear();
    this.invoices = [];
    this.totalCreditsInvoiced = 0;
    this.invoiceIdCounter = 0;
  }

  // ── Private ─────────────────────────────────────────────────────────

  private computeCycleEnd(startMs: number, frequency: BillingFrequency): number {
    const d = new Date(startMs);
    switch (frequency) {
      case 'daily':
        d.setUTCDate(d.getUTCDate() + 1);
        break;
      case 'weekly':
        d.setUTCDate(d.getUTCDate() + 7);
        break;
      case 'monthly':
        d.setUTCMonth(d.getUTCMonth() + 1);
        break;
    }
    return d.getTime();
  }
}
