/**
 * Teams — Organize API keys into teams with shared budgets and quotas.
 *
 * Teams provide:
 *   - Shared credit budget (team-level spending cap)
 *   - Team-level usage quotas (daily/monthly call + credit limits)
 *   - Aggregate usage tracking across all keys in the team
 *   - Key membership management (assign/remove keys)
 *   - Team metadata for external system integration
 */

import { randomBytes } from 'crypto';
import { ApiKeyRecord, QuotaConfig } from './types';

// ─── Team Types ──────────────────────────────────────────────────────────────

export interface TeamRecord {
  /** Unique team ID (team_ prefix + 16 hex chars) */
  id: string;
  /** Human-readable team name */
  name: string;
  /** Team description */
  description: string;
  /** API key IDs belonging to this team (full key strings) */
  memberKeys: string[];
  /** Team-level credit budget. 0 = unlimited. */
  budget: number;
  /** Credits spent across all team keys. */
  totalSpent: number;
  /** Team-level usage quota overrides. Undefined = no team quota. */
  quota?: QuotaConfig;
  /** Quota tracking: calls today (UTC). */
  quotaDailyCalls: number;
  /** Quota tracking: calls this month (UTC). */
  quotaMonthlyCalls: number;
  /** Quota tracking: credits today (UTC). */
  quotaDailyCredits: number;
  /** Quota tracking: credits this month (UTC). */
  quotaMonthlyCredits: number;
  /** Last quota reset date. */
  quotaLastResetDay: string;
  /** Last monthly quota reset. */
  quotaLastResetMonth: string;
  /** Arbitrary metadata tags. */
  tags: Record<string, string>;
  /** ISO timestamp when team was created. */
  createdAt: string;
  /** Whether team is active. */
  active: boolean;
}

export interface TeamUsageSummary {
  teamId: string;
  teamName: string;
  memberCount: number;
  totalBudget: number;
  totalSpent: number;
  remainingBudget: number;
  /** Per-key breakdown */
  members: Array<{
    keyMasked: string;
    name: string;
    credits: number;
    totalSpent: number;
    totalCalls: number;
  }>;
}

// ─── TeamManager ────────────────────────────────────────────────────────────

export class TeamManager {
  private teams = new Map<string, TeamRecord>();
  /** Reverse index: key → teamId for fast lookup */
  private keyToTeam = new Map<string, string>();

  /**
   * Generate a team ID.
   */
  private generateId(): string {
    return `team_${randomBytes(8).toString('hex')}`;
  }

  /**
   * Create a new team.
   */
  createTeam(params: {
    name: string;
    description?: string;
    budget?: number;
    quota?: QuotaConfig;
    tags?: Record<string, string>;
  }): TeamRecord {
    const id = this.generateId();
    const now = new Date();

    const team: TeamRecord = {
      id,
      name: String(params.name).trim().slice(0, 200),
      description: String(params.description || '').trim().slice(0, 1000),
      memberKeys: [],
      budget: Math.max(0, Math.floor(params.budget || 0)),
      totalSpent: 0,
      quota: params.quota,
      quotaDailyCalls: 0,
      quotaMonthlyCalls: 0,
      quotaDailyCredits: 0,
      quotaMonthlyCredits: 0,
      quotaLastResetDay: now.toISOString().slice(0, 10),
      quotaLastResetMonth: now.toISOString().slice(0, 7),
      tags: this.sanitizeTags(params.tags || {}),
      createdAt: now.toISOString(),
      active: true,
    };

    this.teams.set(id, team);
    return team;
  }

  /**
   * Get a team by ID.
   */
  getTeam(teamId: string): TeamRecord | null {
    return this.teams.get(teamId) || null;
  }

  /**
   * List all active teams.
   */
  listTeams(): TeamRecord[] {
    return Array.from(this.teams.values()).filter(t => t.active);
  }

  /**
   * Update team properties.
   */
  updateTeam(teamId: string, updates: {
    name?: string;
    description?: string;
    budget?: number;
    quota?: QuotaConfig | null;
    tags?: Record<string, string | null>;
  }): boolean {
    const team = this.teams.get(teamId);
    if (!team || !team.active) return false;

    if (updates.name !== undefined) {
      team.name = String(updates.name).trim().slice(0, 200);
    }
    if (updates.description !== undefined) {
      team.description = String(updates.description).trim().slice(0, 1000);
    }
    if (updates.budget !== undefined) {
      team.budget = Math.max(0, Math.floor(updates.budget));
    }
    if (updates.quota !== undefined) {
      team.quota = updates.quota === null ? undefined : updates.quota;
    }
    if (updates.tags) {
      // Merge semantics: null values remove tags
      for (const [k, v] of Object.entries(updates.tags)) {
        if (v === null) {
          delete team.tags[k];
        } else {
          team.tags[String(k).slice(0, 100)] = String(v).slice(0, 100);
        }
      }
      // Enforce max 50 tags
      const entries = Object.entries(team.tags);
      if (entries.length > 50) {
        team.tags = Object.fromEntries(entries.slice(0, 50));
      }
    }

    return true;
  }

  /**
   * Delete (deactivate) a team. Keys are unassigned.
   */
  deleteTeam(teamId: string): boolean {
    const team = this.teams.get(teamId);
    if (!team || !team.active) return false;

    // Unassign all keys
    for (const key of team.memberKeys) {
      this.keyToTeam.delete(key);
    }
    team.memberKeys = [];
    team.active = false;

    return true;
  }

  /**
   * Assign an API key to a team. A key can only belong to one team.
   */
  assignKey(teamId: string, apiKey: string): { success: boolean; error?: string } {
    const team = this.teams.get(teamId);
    if (!team || !team.active) {
      return { success: false, error: 'team_not_found' };
    }

    // Check if key already in another team
    const existingTeam = this.keyToTeam.get(apiKey);
    if (existingTeam && existingTeam !== teamId) {
      return { success: false, error: 'key_already_in_team' };
    }

    // Already in this team
    if (team.memberKeys.includes(apiKey)) {
      return { success: true };
    }

    // Max 100 keys per team
    if (team.memberKeys.length >= 100) {
      return { success: false, error: 'team_full' };
    }

    team.memberKeys.push(apiKey);
    this.keyToTeam.set(apiKey, teamId);
    return { success: true };
  }

  /**
   * Remove an API key from its team.
   */
  removeKey(teamId: string, apiKey: string): boolean {
    const team = this.teams.get(teamId);
    if (!team) return false;

    const idx = team.memberKeys.indexOf(apiKey);
    if (idx === -1) return false;

    team.memberKeys.splice(idx, 1);
    this.keyToTeam.delete(apiKey);
    return true;
  }

  /**
   * Get the team ID for a given API key (if assigned).
   */
  getTeamForKey(apiKey: string): string | null {
    return this.keyToTeam.get(apiKey) || null;
  }

  /**
   * Check team-level budget. Returns true if team has budget remaining.
   * Returns true if key is not in a team (no team budget constraint).
   */
  checkBudget(apiKey: string, creditsNeeded: number): { allowed: boolean; reason?: string } {
    const teamId = this.keyToTeam.get(apiKey);
    if (!teamId) return { allowed: true };

    const team = this.teams.get(teamId);
    if (!team || !team.active) return { allowed: true };

    // Budget of 0 = unlimited
    if (team.budget === 0) return { allowed: true };

    if (team.totalSpent + creditsNeeded > team.budget) {
      return { allowed: false, reason: 'team_budget_exceeded' };
    }

    return { allowed: true };
  }

  /**
   * Check team-level quotas. Returns true if within quota.
   * Returns true if key is not in a team (no team quota constraint).
   */
  checkQuota(apiKey: string, credits: number): { allowed: boolean; reason?: string } {
    const teamId = this.keyToTeam.get(apiKey);
    if (!teamId) return { allowed: true };

    const team = this.teams.get(teamId);
    if (!team || !team.active || !team.quota) return { allowed: true };

    // Reset counters if needed
    this.resetQuotaCounters(team);

    const q = team.quota;

    if (q.dailyCallLimit > 0 && team.quotaDailyCalls >= q.dailyCallLimit) {
      return { allowed: false, reason: 'team_daily_call_limit' };
    }
    if (q.monthlyCallLimit > 0 && team.quotaMonthlyCalls >= q.monthlyCallLimit) {
      return { allowed: false, reason: 'team_monthly_call_limit' };
    }
    if (q.dailyCreditLimit > 0 && team.quotaDailyCredits + credits > q.dailyCreditLimit) {
      return { allowed: false, reason: 'team_daily_credit_limit' };
    }
    if (q.monthlyCreditLimit > 0 && team.quotaMonthlyCredits + credits > q.monthlyCreditLimit) {
      return { allowed: false, reason: 'team_monthly_credit_limit' };
    }

    return { allowed: true };
  }

  /**
   * Record a tool call against team counters.
   */
  recordUsage(apiKey: string, credits: number): void {
    const teamId = this.keyToTeam.get(apiKey);
    if (!teamId) return;

    const team = this.teams.get(teamId);
    if (!team || !team.active) return;

    this.resetQuotaCounters(team);

    team.totalSpent += credits;
    team.quotaDailyCalls += 1;
    team.quotaMonthlyCalls += 1;
    team.quotaDailyCredits += credits;
    team.quotaMonthlyCredits += credits;
  }

  /**
   * Get team usage summary including per-member breakdown.
   */
  getUsageSummary(teamId: string, getKey: (key: string) => ApiKeyRecord | null): TeamUsageSummary | null {
    const team = this.teams.get(teamId);
    if (!team) return null;

    const members = team.memberKeys
      .map(key => {
        const record = getKey(key);
        if (!record) return null;
        return {
          keyMasked: key.slice(0, 7) + '...' + key.slice(-4),
          name: record.name,
          credits: record.credits,
          totalSpent: record.totalSpent,
          totalCalls: record.totalCalls,
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);

    return {
      teamId: team.id,
      teamName: team.name,
      memberCount: team.memberKeys.length,
      totalBudget: team.budget,
      totalSpent: team.totalSpent,
      remainingBudget: team.budget > 0 ? Math.max(0, team.budget - team.totalSpent) : 0,
      members,
    };
  }

  /**
   * Reset quota counters if day/month has changed.
   */
  private resetQuotaCounters(team: TeamRecord): void {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const month = now.toISOString().slice(0, 7);

    if (team.quotaLastResetDay !== today) {
      team.quotaDailyCalls = 0;
      team.quotaDailyCredits = 0;
      team.quotaLastResetDay = today;
    }
    if (team.quotaLastResetMonth !== month) {
      team.quotaMonthlyCalls = 0;
      team.quotaMonthlyCredits = 0;
      team.quotaLastResetMonth = month;
    }
  }

  /**
   * Sanitize tags: max 50 entries, max 100 chars per key/value.
   */
  private sanitizeTags(tags: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    const entries = Object.entries(tags).slice(0, 50);
    for (const [k, v] of entries) {
      result[String(k).slice(0, 100)] = String(v).slice(0, 100);
    }
    return result;
  }

  // ─── Serialization (for state persistence) ───────────────────────────────

  /**
   * Export teams state for persistence.
   */
  toJSON(): Array<[string, TeamRecord]> {
    return Array.from(this.teams.entries());
  }

  /**
   * Import teams state from persistence.
   */
  fromJSON(data: Array<[string, TeamRecord]>): void {
    for (const [id, team] of data) {
      if (id && team && typeof team.id === 'string') {
        // Backfill defaults
        if (!team.tags || typeof team.tags !== 'object') team.tags = {};
        if (team.quotaDailyCalls === undefined) team.quotaDailyCalls = 0;
        if (team.quotaMonthlyCalls === undefined) team.quotaMonthlyCalls = 0;
        if (team.quotaDailyCredits === undefined) team.quotaDailyCredits = 0;
        if (team.quotaMonthlyCredits === undefined) team.quotaMonthlyCredits = 0;
        if (!team.quotaLastResetDay) team.quotaLastResetDay = new Date().toISOString().slice(0, 10);
        if (!team.quotaLastResetMonth) team.quotaLastResetMonth = new Date().toISOString().slice(0, 7);
        if (team.active === undefined) team.active = true;

        this.teams.set(id, team);

        // Rebuild reverse index
        if (Array.isArray(team.memberKeys)) {
          for (const key of team.memberKeys) {
            this.keyToTeam.set(key, id);
          }
        }
      }
    }
  }
}
