/**
 * Revenue Share Tracking — Split Billing for Marketplaces.
 *
 * Track revenue splits between platform and tool developers.
 * Supports configurable share percentages per tool, per developer,
 * with settlement tracking and payout reporting.
 *
 * Use cases:
 *   - MCP tool marketplace where developers earn per call
 *   - Internal chargeback between departments
 *   - Partner revenue sharing programs
 *
 * Zero external dependencies.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RevenueShareRule {
  /** Unique rule ID. */
  id: string;
  /** Developer/partner ID who receives the share. */
  developerId: string;
  /** Tools this rule applies to. Empty = all tools. */
  tools: string[];
  /** Developer's share percentage (0-100). Platform keeps the remainder. */
  sharePercent: number;
  /** Minimum credits per call before sharing applies. Default: 0. */
  minCreditsPerCall: number;
  /** Whether this rule is active. */
  active: boolean;
  /** When this rule was created (ISO). */
  createdAt: string;
}

export interface RevenueEntry {
  /** The tool that was called. */
  tool: string;
  /** Total credits charged. */
  totalCredits: number;
  /** Developer's share (credits). */
  developerShare: number;
  /** Platform's share (credits). */
  platformShare: number;
  /** Developer ID. */
  developerId: string;
  /** Rule ID that was applied. */
  ruleId: string;
  /** API key that made the call. */
  apiKey: string;
  /** When this entry was created (ISO). */
  createdAt: string;
}

export interface DeveloperPayout {
  /** Developer ID. */
  developerId: string;
  /** Total credits earned (unsettled). */
  totalEarned: number;
  /** Total credits already settled/paid out. */
  totalSettled: number;
  /** Net credits owed. */
  balance: number;
  /** Number of tool calls contributing. */
  callCount: number;
  /** Breakdown by tool. */
  byTool: Record<string, { credits: number; calls: number }>;
}

export interface SettlementRecord {
  /** Settlement ID. */
  id: string;
  /** Developer ID. */
  developerId: string;
  /** Credits settled in this batch. */
  credits: number;
  /** Number of entries included. */
  entryCount: number;
  /** When settlement occurred (ISO). */
  settledAt: string;
  /** External reference (e.g., Stripe transfer ID). */
  externalRef?: string;
}

export interface RevenueShareConfig {
  /** Default platform share percentage when no rule matches. Default: 100 (platform keeps all). */
  defaultPlatformPercent?: number;
  /** Maximum entries to retain. Default: 100000. */
  maxEntries?: number;
  /** Maximum rules. Default: 1000. */
  maxRules?: number;
}

export interface RevenueShareStats {
  /** Total rules configured. */
  totalRules: number;
  /** Active rules. */
  activeRules: number;
  /** Unique developers. */
  uniqueDevelopers: number;
  /** Total revenue entries. */
  totalEntries: number;
  /** Total credits processed. */
  totalCredits: number;
  /** Total developer payouts (credits). */
  totalDeveloperCredits: number;
  /** Total platform revenue (credits). */
  totalPlatformCredits: number;
  /** Total settlements completed. */
  totalSettlements: number;
}

// ─── Revenue Share Tracker ──────────────────────────────────────────────────

export class RevenueShareTracker {
  private rules = new Map<string, RevenueShareRule>();
  private entries: RevenueEntry[] = [];
  private settlements: SettlementRecord[] = [];
  private developerTotals = new Map<string, { earned: number; settled: number; calls: number; byTool: Record<string, { credits: number; calls: number }> }>();
  private defaultPlatformPercent: number;
  private maxEntries: number;
  private maxRules: number;

  // Stats
  private totalCredits = 0;
  private totalDeveloperCredits = 0;
  private totalPlatformCredits = 0;

  constructor(config: RevenueShareConfig = {}) {
    this.defaultPlatformPercent = config.defaultPlatformPercent ?? 100;
    this.maxEntries = config.maxEntries ?? 100_000;
    this.maxRules = config.maxRules ?? 1000;
  }

  /** Create or update a revenue share rule. */
  upsertRule(rule: Omit<RevenueShareRule, 'createdAt'> & { createdAt?: string }): boolean {
    if (this.rules.size >= this.maxRules && !this.rules.has(rule.id)) {
      return false;
    }

    if (rule.sharePercent < 0 || rule.sharePercent > 100) return false;

    this.rules.set(rule.id, {
      ...rule,
      createdAt: rule.createdAt ?? new Date().toISOString(),
    });
    return true;
  }

  /** Remove a rule. */
  removeRule(id: string): boolean {
    return this.rules.delete(id);
  }

  /** Get a rule. */
  getRule(id: string): RevenueShareRule | null {
    return this.rules.get(id) ?? null;
  }

  /** Get all rules. */
  getRules(): RevenueShareRule[] {
    return [...this.rules.values()];
  }

  /** Find the matching rule for a tool call. Returns the first active match. */
  findRule(tool: string): RevenueShareRule | null {
    for (const rule of this.rules.values()) {
      if (!rule.active) continue;
      if (rule.tools.length === 0 || rule.tools.includes(tool)) {
        return rule;
      }
    }
    return null;
  }

  /**
   * Record a revenue event for a tool call.
   * Calculates the split based on matching rules.
   */
  record(tool: string, totalCredits: number, apiKey: string): RevenueEntry | null {
    if (totalCredits <= 0) return null;

    const rule = this.findRule(tool);
    if (!rule) {
      // No matching rule — platform keeps everything
      this.totalCredits += totalCredits;
      this.totalPlatformCredits += totalCredits;
      return null;
    }

    if (totalCredits < rule.minCreditsPerCall) {
      this.totalCredits += totalCredits;
      this.totalPlatformCredits += totalCredits;
      return null;
    }

    const developerShare = Math.floor(totalCredits * rule.sharePercent / 100);
    const platformShare = totalCredits - developerShare;

    const entry: RevenueEntry = {
      tool,
      totalCredits,
      developerShare,
      platformShare,
      developerId: rule.developerId,
      ruleId: rule.id,
      apiKey,
      createdAt: new Date().toISOString(),
    };

    // Trim if at capacity
    if (this.entries.length >= this.maxEntries) {
      this.entries.splice(0, Math.floor(this.maxEntries * 0.1)); // Drop oldest 10%
    }
    this.entries.push(entry);

    // Update developer totals
    let devTotal = this.developerTotals.get(rule.developerId);
    if (!devTotal) {
      devTotal = { earned: 0, settled: 0, calls: 0, byTool: {} };
      this.developerTotals.set(rule.developerId, devTotal);
    }
    devTotal.earned += developerShare;
    devTotal.calls++;
    if (!devTotal.byTool[tool]) {
      devTotal.byTool[tool] = { credits: 0, calls: 0 };
    }
    devTotal.byTool[tool].credits += developerShare;
    devTotal.byTool[tool].calls++;

    // Update stats
    this.totalCredits += totalCredits;
    this.totalDeveloperCredits += developerShare;
    this.totalPlatformCredits += platformShare;

    return entry;
  }

  /** Get payout report for a developer. */
  getDeveloperPayout(developerId: string): DeveloperPayout | null {
    const totals = this.developerTotals.get(developerId);
    if (!totals) return null;

    return {
      developerId,
      totalEarned: totals.earned,
      totalSettled: totals.settled,
      balance: totals.earned - totals.settled,
      callCount: totals.calls,
      byTool: { ...totals.byTool },
    };
  }

  /** Get all developer payouts. */
  getAllPayouts(): DeveloperPayout[] {
    const result: DeveloperPayout[] = [];
    for (const [developerId, totals] of this.developerTotals) {
      result.push({
        developerId,
        totalEarned: totals.earned,
        totalSettled: totals.settled,
        balance: totals.earned - totals.settled,
        callCount: totals.calls,
        byTool: { ...totals.byTool },
      });
    }
    return result;
  }

  /**
   * Settle (mark as paid) a developer's balance.
   * Returns the settlement record.
   */
  settle(developerId: string, externalRef?: string): SettlementRecord | null {
    const totals = this.developerTotals.get(developerId);
    if (!totals) return null;

    const balance = totals.earned - totals.settled;
    if (balance <= 0) return null;

    const settlement: SettlementRecord = {
      id: `stl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      developerId,
      credits: balance,
      entryCount: totals.calls,
      settledAt: new Date().toISOString(),
      externalRef,
    };

    totals.settled = totals.earned;
    this.settlements.push(settlement);

    return settlement;
  }

  /** Get settlement history for a developer. */
  getSettlements(developerId?: string): SettlementRecord[] {
    if (developerId) {
      return this.settlements.filter(s => s.developerId === developerId);
    }
    return [...this.settlements];
  }

  /** Get recent revenue entries. */
  getEntries(limit = 100, developerId?: string): RevenueEntry[] {
    let entries = this.entries;
    if (developerId) {
      entries = entries.filter(e => e.developerId === developerId);
    }
    return entries.slice(-limit);
  }

  /** Get platform revenue summary. */
  getPlatformSummary(): { totalCredits: number; platformCredits: number; developerCredits: number; platformPercent: number } {
    return {
      totalCredits: this.totalCredits,
      platformCredits: this.totalPlatformCredits,
      developerCredits: this.totalDeveloperCredits,
      platformPercent: this.totalCredits > 0 ? Math.round(this.totalPlatformCredits / this.totalCredits * 100) : this.defaultPlatformPercent,
    };
  }

  /** Get stats. */
  getStats(): RevenueShareStats {
    return {
      totalRules: this.rules.size,
      activeRules: [...this.rules.values()].filter(r => r.active).length,
      uniqueDevelopers: this.developerTotals.size,
      totalEntries: this.entries.length,
      totalCredits: this.totalCredits,
      totalDeveloperCredits: this.totalDeveloperCredits,
      totalPlatformCredits: this.totalPlatformCredits,
      totalSettlements: this.settlements.length,
    };
  }

  /** Reset stats. */
  resetStats(): void {
    this.totalCredits = 0;
    this.totalDeveloperCredits = 0;
    this.totalPlatformCredits = 0;
  }

  /** Destroy and release resources. */
  destroy(): void {
    this.rules.clear();
    this.entries = [];
    this.settlements = [];
    this.developerTotals.clear();
  }
}
