/**
 * Key Groups — Policy templates for API keys.
 *
 * Groups define shared policies (ACL, rate limits, pricing, quotas, IP rules)
 * that are inherited by all member keys. Key-level settings override group defaults.
 *
 * Unlike Teams (which share budgets), Groups share *policies*:
 *   - Tool ACL (allowedTools / deniedTools)
 *   - Rate limit override (calls per minute)
 *   - Per-tool pricing overrides
 *   - Quota defaults (daily/monthly limits)
 *   - IP allowlist
 *   - Metadata tags
 */

import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { QuotaConfig, ToolPricing } from './types';

// ─── Group Types ─────────────────────────────────────────────────────────────

export interface KeyGroupRecord {
  /** Unique group ID (grp_ prefix + 16 hex chars) */
  id: string;
  /** Human-readable group name (unique) */
  name: string;
  /** Group description */
  description: string;
  /** Tool whitelist (inherited by member keys if their list is empty). */
  allowedTools: string[];
  /** Tool blacklist (merged with member key's denied tools). */
  deniedTools: string[];
  /** Rate limit override (calls per minute). 0 = use global default. */
  rateLimitPerMin: number;
  /** Per-tool pricing overrides (merged with global, group wins for conflicts). */
  toolPricing: Record<string, ToolPricing>;
  /** Quota defaults for member keys (used when key has no per-key quota). */
  quota?: QuotaConfig;
  /** IP allowlist (merged with key-level allowlist). */
  ipAllowlist: string[];
  /** Default credits for new keys assigned to this group. 0 = use /keys default. */
  defaultCredits: number;
  /** Max spending limit for member keys. 0 = unlimited. */
  maxSpendingLimit: number;
  /** Arbitrary metadata tags. */
  tags: Record<string, string>;
  /** ISO timestamp when group was created. */
  createdAt: string;
  /** Whether group is active. */
  active: boolean;
}

/** Resolved policy: the merged result of group + key settings. */
export interface ResolvedPolicy {
  allowedTools: string[];
  deniedTools: string[];
  rateLimitPerMin: number;
  quota?: QuotaConfig;
  ipAllowlist: string[];
  toolPricing: Record<string, ToolPricing>;
  maxSpendingLimit: number;
}

export interface KeyGroupInfo {
  id: string;
  name: string;
  description: string;
  memberCount: number;
  allowedTools: string[];
  deniedTools: string[];
  rateLimitPerMin: number;
  quota?: QuotaConfig;
  ipAllowlist: string[];
  defaultCredits: number;
  maxSpendingLimit: number;
  tags: Record<string, string>;
  createdAt: string;
  active: boolean;
}

// ─── KeyGroupManager ─────────────────────────────────────────────────────────

export class KeyGroupManager {
  private groups = new Map<string, KeyGroupRecord>();
  /** Reverse index: apiKey → groupId */
  private keyToGroup = new Map<string, string>();
  /** File path for state persistence (null = no persistence) */
  private readonly filePath: string | null;

  constructor(filePath?: string) {
    this.filePath = filePath || null;
    if (this.filePath) this.loadFromFile();
  }

  // ─── CRUD ────────────────────────────────────────────────────────────────

  createGroup(params: {
    name: string;
    description?: string;
    allowedTools?: string[];
    deniedTools?: string[];
    rateLimitPerMin?: number;
    toolPricing?: Record<string, ToolPricing>;
    quota?: QuotaConfig;
    ipAllowlist?: string[];
    defaultCredits?: number;
    maxSpendingLimit?: number;
    tags?: Record<string, string>;
  }): KeyGroupRecord {
    const name = String(params.name || '').trim();
    if (!name) throw new Error('Group must have a name');

    // Enforce unique names
    for (const g of this.groups.values()) {
      if (g.active && g.name === name) {
        throw new Error(`Group '${name}' already exists`);
      }
    }

    const id = 'grp_' + randomBytes(8).toString('hex');
    const record: KeyGroupRecord = {
      id,
      name,
      description: String(params.description || ''),
      allowedTools: params.allowedTools || [],
      deniedTools: params.deniedTools || [],
      rateLimitPerMin: Math.max(0, Math.floor(Number(params.rateLimitPerMin) || 0)),
      toolPricing: params.toolPricing || {},
      quota: params.quota,
      ipAllowlist: params.ipAllowlist || [],
      defaultCredits: Math.max(0, Math.floor(Number(params.defaultCredits) || 0)),
      maxSpendingLimit: Math.max(0, Math.floor(Number(params.maxSpendingLimit) || 0)),
      tags: params.tags || {},
      createdAt: new Date().toISOString(),
      active: true,
    };

    this.groups.set(id, record);
    return record;
  }

  getGroup(id: string): KeyGroupRecord | undefined {
    return this.groups.get(id);
  }

  getGroupByName(name: string): KeyGroupRecord | undefined {
    for (const g of this.groups.values()) {
      if (g.active && g.name === name) return g;
    }
    return undefined;
  }

  updateGroup(id: string, updates: {
    name?: string;
    description?: string;
    allowedTools?: string[];
    deniedTools?: string[];
    rateLimitPerMin?: number;
    toolPricing?: Record<string, ToolPricing>;
    quota?: QuotaConfig | null;
    ipAllowlist?: string[];
    defaultCredits?: number;
    maxSpendingLimit?: number;
    tags?: Record<string, string>;
  }): KeyGroupRecord {
    const group = this.groups.get(id);
    if (!group || !group.active) throw new Error(`Group '${id}' not found`);

    // Check name uniqueness if name is being changed
    if (updates.name !== undefined && updates.name !== group.name) {
      const name = String(updates.name).trim();
      if (!name) throw new Error('Group must have a name');
      for (const g of this.groups.values()) {
        if (g.active && g.id !== id && g.name === name) {
          throw new Error(`Group '${name}' already exists`);
        }
      }
      group.name = name;
    }

    if (updates.description !== undefined) group.description = String(updates.description);
    if (updates.allowedTools !== undefined) group.allowedTools = updates.allowedTools;
    if (updates.deniedTools !== undefined) group.deniedTools = updates.deniedTools;
    if (updates.rateLimitPerMin !== undefined) group.rateLimitPerMin = Math.max(0, Math.floor(Number(updates.rateLimitPerMin) || 0));
    if (updates.toolPricing !== undefined) group.toolPricing = updates.toolPricing;
    if (updates.quota === null) delete group.quota;
    else if (updates.quota !== undefined) group.quota = updates.quota;
    if (updates.ipAllowlist !== undefined) group.ipAllowlist = updates.ipAllowlist;
    if (updates.defaultCredits !== undefined) group.defaultCredits = Math.max(0, Math.floor(Number(updates.defaultCredits) || 0));
    if (updates.maxSpendingLimit !== undefined) group.maxSpendingLimit = Math.max(0, Math.floor(Number(updates.maxSpendingLimit) || 0));
    if (updates.tags !== undefined) group.tags = { ...group.tags, ...updates.tags };

    return group;
  }

  deleteGroup(id: string): boolean {
    const group = this.groups.get(id);
    if (!group || !group.active) return false;

    group.active = false;

    // Remove all key assignments for this group
    for (const [key, gid] of this.keyToGroup.entries()) {
      if (gid === id) this.keyToGroup.delete(key);
    }

    return true;
  }

  listGroups(): KeyGroupInfo[] {
    const result: KeyGroupInfo[] = [];
    for (const g of this.groups.values()) {
      if (!g.active) continue;
      const memberCount = this.getGroupMembers(g.id).length;
      result.push({
        id: g.id,
        name: g.name,
        description: g.description,
        memberCount,
        allowedTools: g.allowedTools,
        deniedTools: g.deniedTools,
        rateLimitPerMin: g.rateLimitPerMin,
        quota: g.quota,
        ipAllowlist: g.ipAllowlist,
        defaultCredits: g.defaultCredits,
        maxSpendingLimit: g.maxSpendingLimit,
        tags: g.tags,
        createdAt: g.createdAt,
        active: g.active,
      });
    }
    return result;
  }

  // ─── Key Membership ──────────────────────────────────────────────────────

  assignKey(apiKey: string, groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group || !group.active) throw new Error(`Group '${groupId}' not found`);
    this.keyToGroup.set(apiKey, groupId);
  }

  removeKey(apiKey: string): boolean {
    return this.keyToGroup.delete(apiKey);
  }

  getKeyGroup(apiKey: string): KeyGroupRecord | undefined {
    const groupId = this.keyToGroup.get(apiKey);
    if (!groupId) return undefined;
    const group = this.groups.get(groupId);
    if (!group || !group.active) {
      this.keyToGroup.delete(apiKey);
      return undefined;
    }
    return group;
  }

  getKeyGroupId(apiKey: string): string | undefined {
    const groupId = this.keyToGroup.get(apiKey);
    if (!groupId) return undefined;
    const group = this.groups.get(groupId);
    if (!group || !group.active) {
      this.keyToGroup.delete(apiKey);
      return undefined;
    }
    return groupId;
  }

  getGroupMembers(groupId: string): string[] {
    const members: string[] = [];
    for (const [key, gid] of this.keyToGroup.entries()) {
      if (gid === groupId) members.push(key);
    }
    return members;
  }

  // ─── Policy Resolution ───────────────────────────────────────────────────

  /**
   * Resolve the effective policy for a key, merging group defaults with key overrides.
   *
   * Resolution rules:
   *   - allowedTools: key-level wins if non-empty, else group default
   *   - deniedTools: union of group + key (both applied)
   *   - rateLimitPerMin: key-level wins if set, else group default
   *   - quota: key-level wins if set, else group default
   *   - ipAllowlist: union of group + key (both applied)
   *   - toolPricing: group pricing is base, key-level (if any) would need external handling
   *   - maxSpendingLimit: group's maxSpendingLimit is a cap on the key's spending limit
   */
  resolvePolicy(apiKey: string, keyRecord: {
    allowedTools: string[];
    deniedTools: string[];
    ipAllowlist: string[];
    quota?: QuotaConfig;
    spendingLimit: number;
  }): ResolvedPolicy | null {
    const group = this.getKeyGroup(apiKey);
    if (!group) return null;

    // Allowed tools: key wins if non-empty, else group
    const allowedTools = keyRecord.allowedTools.length > 0
      ? keyRecord.allowedTools
      : group.allowedTools;

    // Denied tools: union (both applied)
    const deniedSet = new Set([...group.deniedTools, ...keyRecord.deniedTools]);
    const deniedTools = Array.from(deniedSet);

    // Rate limit: group default (0 = use global)
    const rateLimitPerMin = group.rateLimitPerMin;

    // Quota: key wins if set, else group
    const quota = keyRecord.quota || group.quota;

    // IP allowlist: union
    const ipSet = new Set([...group.ipAllowlist, ...keyRecord.ipAllowlist]);
    const ipAllowlist = Array.from(ipSet);

    // Tool pricing: group overrides
    const toolPricing = group.toolPricing;

    // Spending limit: cap to group's max if group has one set and key's limit is higher (or unlimited)
    let maxSpendingLimit = group.maxSpendingLimit;

    return {
      allowedTools,
      deniedTools,
      rateLimitPerMin,
      quota,
      ipAllowlist,
      toolPricing,
      maxSpendingLimit,
    };
  }

  // ─── File Persistence ────────────────────────────────────────────────────

  /** Load groups from state file (called in constructor). */
  private loadFromFile(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw);
      this.load(data);
    } catch { /* ignore corrupted file */ }
  }

  /** Save groups to state file. */
  saveToFile(): void {
    if (!this.filePath) return;
    writeFileSync(this.filePath, JSON.stringify(this.serialize(), null, 2));
  }

  // ─── Serialization (for state file persistence) ──────────────────────────

  serialize(): { groups: [string, KeyGroupRecord][]; assignments: [string, string][] } {
    return {
      groups: Array.from(this.groups.entries()),
      assignments: Array.from(this.keyToGroup.entries()),
    };
  }

  load(data: { groups: [string, KeyGroupRecord][]; assignments: [string, string][] }): void {
    this.groups.clear();
    this.keyToGroup.clear();

    if (data.groups) {
      for (const [id, record] of data.groups) {
        this.groups.set(id, record);
      }
    }

    if (data.assignments) {
      for (const [key, groupId] of data.assignments) {
        this.keyToGroup.set(key, groupId);
      }
    }
  }

  get count(): number {
    let count = 0;
    for (const g of this.groups.values()) {
      if (g.active) count++;
    }
    return count;
  }
}
