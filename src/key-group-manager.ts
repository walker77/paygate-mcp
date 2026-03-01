/**
 * KeyGroupManager — Group API keys for collective management.
 *
 * Create groups of API keys for shared policies, collective
 * rate limits, and batch operations.
 *
 * @example
 * ```ts
 * const mgr = new KeyGroupManager();
 *
 * mgr.createGroup({ name: 'team-alpha', description: 'Alpha team keys' });
 * mgr.addKeyToGroup('grp_1', 'key_abc');
 * mgr.addKeyToGroup('grp_1', 'key_def');
 *
 * const members = mgr.getGroupMembers('grp_1');
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface KeyGroup {
  id: string;
  name: string;
  description: string;
  members: string[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface KeyGroupCreateParams {
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface KeyGroupQuery {
  name?: string;
  memberKey?: string;
  limit?: number;
}

export interface KeyGroupManagerConfig {
  /** Max groups. Default 500. */
  maxGroups?: number;
  /** Max members per group. Default 1000. */
  maxMembersPerGroup?: number;
}

export interface KeyGroupManagerStats {
  totalGroups: number;
  totalMemberships: number;
  avgMembersPerGroup: number;
  largestGroup: { id: string; name: string; size: number } | null;
}

// ── Implementation ───────────────────────────────────────────────────

export class KeyGroupManager {
  private groups = new Map<string, KeyGroup>();
  private keyToGroups = new Map<string, Set<string>>();
  private nextId = 1;
  private maxGroups: number;
  private maxMembersPerGroup: number;

  constructor(config: KeyGroupManagerConfig = {}) {
    this.maxGroups = config.maxGroups ?? 500;
    this.maxMembersPerGroup = config.maxMembersPerGroup ?? 1000;
  }

  // ── Group Management ──────────────────────────────────────────

  /** Create a group. */
  createGroup(params: KeyGroupCreateParams): KeyGroup {
    if (!params.name) throw new Error('Group name is required');
    if (this.groups.size >= this.maxGroups) {
      throw new Error(`Maximum ${this.maxGroups} groups reached`);
    }

    // Check for duplicate names
    for (const g of this.groups.values()) {
      if (g.name === params.name) throw new Error(`Group '${params.name}' already exists`);
    }

    const now = Date.now();
    const group: KeyGroup = {
      id: `grp_${this.nextId++}`,
      name: params.name,
      description: params.description ?? '',
      members: [],
      metadata: params.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    this.groups.set(group.id, group);
    return group;
  }

  /** Get a group by ID. */
  getGroup(id: string): KeyGroup | null {
    return this.groups.get(id) ?? null;
  }

  /** Delete a group. */
  deleteGroup(id: string): boolean {
    const group = this.groups.get(id);
    if (!group) return false;

    // Remove key-to-group mappings
    for (const key of group.members) {
      const groups = this.keyToGroups.get(key);
      if (groups) {
        groups.delete(id);
        if (groups.size === 0) this.keyToGroups.delete(key);
      }
    }

    return this.groups.delete(id);
  }

  /** Update group metadata. */
  updateGroup(id: string, updates: { name?: string; description?: string; metadata?: Record<string, unknown> }): KeyGroup | null {
    const group = this.groups.get(id);
    if (!group) return null;

    if (updates.name !== undefined) group.name = updates.name;
    if (updates.description !== undefined) group.description = updates.description;
    if (updates.metadata !== undefined) group.metadata = updates.metadata;
    group.updatedAt = Date.now();

    return group;
  }

  // ── Membership ────────────────────────────────────────────────

  /** Add a key to a group. */
  addKeyToGroup(groupId: string, key: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Group '${groupId}' not found`);
    if (group.members.includes(key)) return false; // Already member
    if (group.members.length >= this.maxMembersPerGroup) {
      throw new Error(`Maximum ${this.maxMembersPerGroup} members per group reached`);
    }

    group.members.push(key);
    group.updatedAt = Date.now();

    let groups = this.keyToGroups.get(key);
    if (!groups) {
      groups = new Set();
      this.keyToGroups.set(key, groups);
    }
    groups.add(groupId);

    return true;
  }

  /** Remove a key from a group. */
  removeKeyFromGroup(groupId: string, key: string): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;

    const idx = group.members.indexOf(key);
    if (idx === -1) return false;

    group.members.splice(idx, 1);
    group.updatedAt = Date.now();

    const groups = this.keyToGroups.get(key);
    if (groups) {
      groups.delete(groupId);
      if (groups.size === 0) this.keyToGroups.delete(key);
    }

    return true;
  }

  /** Get all groups a key belongs to. */
  getKeyGroups(key: string): KeyGroup[] {
    const groupIds = this.keyToGroups.get(key);
    if (!groupIds) return [];
    return [...groupIds].map(id => this.groups.get(id)!).filter(Boolean);
  }

  /** Get group members. */
  getGroupMembers(groupId: string): string[] {
    const group = this.groups.get(groupId);
    return group ? [...group.members] : [];
  }

  /** Check if a key is in a group. */
  isKeyInGroup(groupId: string, key: string): boolean {
    const group = this.groups.get(groupId);
    return group ? group.members.includes(key) : false;
  }

  // ── Query ───────────────────────────────────────────────────────

  /** List groups. */
  listGroups(query: KeyGroupQuery = {}): KeyGroup[] {
    let results = [...this.groups.values()];

    if (query.name) results = results.filter(g => g.name.includes(query.name!));
    if (query.memberKey) results = results.filter(g => g.members.includes(query.memberKey!));

    return results.slice(0, query.limit ?? 50);
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): KeyGroupManagerStats {
    let totalMemberships = 0;
    let largest: KeyGroup | null = null;

    for (const group of this.groups.values()) {
      totalMemberships += group.members.length;
      if (!largest || group.members.length > largest.members.length) {
        largest = group;
      }
    }

    return {
      totalGroups: this.groups.size,
      totalMemberships,
      avgMembersPerGroup: this.groups.size > 0 ? Math.round((totalMemberships / this.groups.size) * 100) / 100 : 0,
      largestGroup: largest ? { id: largest.id, name: largest.name, size: largest.members.length } : null,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.groups.clear();
    this.keyToGroups.clear();
  }
}
