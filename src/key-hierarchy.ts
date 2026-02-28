/**
 * Key Hierarchy — Parent/Child API Key Relationships.
 *
 * Allows creating sub-keys that inherit limits from parent keys.
 * Child keys deduct credits from the parent's balance, share the parent's
 * spending limit, and can optionally inherit allowed/denied tool lists.
 *
 * Use cases:
 *   - Organization keys with per-team sub-keys
 *   - Trial keys that share a pool of credits
 *   - Reseller keys with sub-allocation
 *
 * Zero external dependencies.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KeyRelation {
  /** The child key ID. */
  childKey: string;
  /** The parent key ID. */
  parentKey: string;
  /** Maximum credits this child can draw from parent. 0 = unlimited (up to parent balance). */
  creditCeiling: number;
  /** Credits already drawn from parent by this child. */
  creditsUsed: number;
  /** Whether child inherits parent's allowedTools. Default: true. */
  inheritAllowedTools: boolean;
  /** Whether child inherits parent's deniedTools. Default: true. */
  inheritDeniedTools: boolean;
  /** Whether child inherits parent's quota config. Default: false. */
  inheritQuota: boolean;
  /** When this relation was created (ISO). */
  createdAt: string;
}

export interface HierarchyInfo {
  /** The key being queried. */
  key: string;
  /** Parent key, if any. */
  parent: string | null;
  /** Direct children. */
  children: string[];
  /** Depth in hierarchy (root = 0). */
  depth: number;
  /** Total credits available (own + parent cascade). */
  effectiveCredits: number;
}

export interface KeyHierarchyConfig {
  /** Maximum depth of key hierarchy. Default: 3. */
  maxDepth?: number;
  /** Maximum children per parent. Default: 100. */
  maxChildren?: number;
  /** Whether child credit usage auto-deducts from parent. Default: true. */
  cascadeDeduction?: boolean;
}

export interface KeyHierarchyStats {
  /** Total parent-child relations. */
  totalRelations: number;
  /** Keys that are parents. */
  parentCount: number;
  /** Keys that are children. */
  childCount: number;
  /** Maximum depth in any chain. */
  maxDepthUsed: number;
  /** Total credits cascaded from parents. */
  totalCreditsCascaded: number;
}

// ─── Key Hierarchy Manager ──────────────────────────────────────────────────

export class KeyHierarchyManager {
  private relations = new Map<string, KeyRelation>(); // childKey → relation
  private childrenIndex = new Map<string, Set<string>>(); // parentKey → Set<childKey>
  private maxDepth: number;
  private maxChildren: number;
  private cascadeDeduction: boolean;

  // Stats
  private totalCreditsCascaded = 0;

  constructor(config: KeyHierarchyConfig = {}) {
    this.maxDepth = config.maxDepth ?? 3;
    this.maxChildren = config.maxChildren ?? 100;
    this.cascadeDeduction = config.cascadeDeduction ?? true;
  }

  /**
   * Create a parent-child relationship.
   * Returns false if the relation would violate constraints.
   */
  createRelation(params: {
    childKey: string;
    parentKey: string;
    creditCeiling?: number;
    inheritAllowedTools?: boolean;
    inheritDeniedTools?: boolean;
    inheritQuota?: boolean;
  }): boolean {
    const { childKey, parentKey } = params;

    // Prevent self-reference
    if (childKey === parentKey) return false;

    // Check child isn't already a child
    if (this.relations.has(childKey)) return false;

    // Check depth constraint
    const parentDepth = this.getDepth(parentKey);
    if (parentDepth + 1 > this.maxDepth) return false;

    // Check max children
    const existing = this.childrenIndex.get(parentKey);
    if (existing && existing.size >= this.maxChildren) return false;

    // Prevent circular: parent can't be a descendant of child
    if (this.isDescendant(parentKey, childKey)) return false;

    const relation: KeyRelation = {
      childKey,
      parentKey,
      creditCeiling: params.creditCeiling ?? 0,
      creditsUsed: 0,
      inheritAllowedTools: params.inheritAllowedTools ?? true,
      inheritDeniedTools: params.inheritDeniedTools ?? true,
      inheritQuota: params.inheritQuota ?? false,
      createdAt: new Date().toISOString(),
    };

    this.relations.set(childKey, relation);

    if (!this.childrenIndex.has(parentKey)) {
      this.childrenIndex.set(parentKey, new Set());
    }
    this.childrenIndex.get(parentKey)!.add(childKey);

    return true;
  }

  /** Remove a parent-child relationship. Also removes all descendants. */
  removeRelation(childKey: string): boolean {
    const relation = this.relations.get(childKey);
    if (!relation) return false;

    // Remove all descendants first
    const children = this.childrenIndex.get(childKey);
    if (children) {
      for (const grandchild of [...children]) {
        this.removeRelation(grandchild);
      }
    }

    // Remove from parent's children index
    const parentChildren = this.childrenIndex.get(relation.parentKey);
    if (parentChildren) {
      parentChildren.delete(childKey);
      if (parentChildren.size === 0) {
        this.childrenIndex.delete(relation.parentKey);
      }
    }

    this.childrenIndex.delete(childKey);
    this.relations.delete(childKey);
    return true;
  }

  /** Get the relation for a child key. */
  getRelation(childKey: string): KeyRelation | null {
    return this.relations.get(childKey) ?? null;
  }

  /** Get the parent key of a child. */
  getParent(childKey: string): string | null {
    return this.relations.get(childKey)?.parentKey ?? null;
  }

  /** Get direct children of a key. */
  getChildren(parentKey: string): string[] {
    const children = this.childrenIndex.get(parentKey);
    return children ? [...children] : [];
  }

  /** Get all descendants (children, grandchildren, etc.). */
  getDescendants(key: string): string[] {
    const result: string[] = [];
    const queue = this.getChildren(key);
    while (queue.length > 0) {
      const child = queue.shift()!;
      result.push(child);
      queue.push(...this.getChildren(child));
    }
    return result;
  }

  /** Get the ancestry chain from a key up to the root. */
  getAncestors(key: string): string[] {
    const result: string[] = [];
    let current = this.getParent(key);
    while (current) {
      result.push(current);
      current = this.getParent(current);
    }
    return result;
  }

  /** Get the root key of a hierarchy chain. */
  getRoot(key: string): string {
    let current = key;
    let parent = this.getParent(current);
    while (parent) {
      current = parent;
      parent = this.getParent(current);
    }
    return current;
  }

  /** Check if `potentialDescendant` is a descendant of `key`. */
  isDescendant(potentialDescendant: string, key: string): boolean {
    const ancestors = this.getAncestors(potentialDescendant);
    return ancestors.includes(key);
  }

  /** Check if a key is a child (has a parent). */
  isChild(key: string): boolean {
    return this.relations.has(key);
  }

  /** Check if a key is a parent (has children). */
  isParent(key: string): boolean {
    return (this.childrenIndex.get(key)?.size ?? 0) > 0;
  }

  /** Get hierarchy depth of a key (root = 0). */
  getDepth(key: string): number {
    return this.getAncestors(key).length;
  }

  /**
   * Record credit usage by a child key.
   * Returns false if the child's credit ceiling would be exceeded.
   */
  recordUsage(childKey: string, credits: number): boolean {
    const relation = this.relations.get(childKey);
    if (!relation) return true; // Not a child, no constraint

    // Check ceiling
    if (relation.creditCeiling > 0 && relation.creditsUsed + credits > relation.creditCeiling) {
      return false;
    }

    relation.creditsUsed += credits;
    this.totalCreditsCascaded += credits;
    return true;
  }

  /** Refund credits for a child key. */
  refundUsage(childKey: string, credits: number): void {
    const relation = this.relations.get(childKey);
    if (!relation) return;
    relation.creditsUsed = Math.max(0, relation.creditsUsed - credits);
  }

  /** Get remaining credits a child can use (from ceiling). */
  getRemainingCeiling(childKey: string): number | null {
    const relation = this.relations.get(childKey);
    if (!relation) return null;
    if (relation.creditCeiling === 0) return null; // Unlimited
    return Math.max(0, relation.creditCeiling - relation.creditsUsed);
  }

  /** Update the credit ceiling for a child. */
  setCreditCeiling(childKey: string, ceiling: number): boolean {
    const relation = this.relations.get(childKey);
    if (!relation) return false;
    relation.creditCeiling = Math.max(0, ceiling);
    return true;
  }

  /** Get hierarchy info for a key. */
  getInfo(key: string, getCredits?: (key: string) => number): HierarchyInfo {
    const parent = this.getParent(key);
    const children = this.getChildren(key);
    const depth = this.getDepth(key);

    let effectiveCredits = 0;
    if (getCredits) {
      effectiveCredits = getCredits(key);
      // If child, limited by ceiling
      const relation = this.relations.get(key);
      if (relation && relation.creditCeiling > 0) {
        const remaining = relation.creditCeiling - relation.creditsUsed;
        effectiveCredits = Math.min(effectiveCredits, remaining);
      }
    }

    return { key, parent, children, depth, effectiveCredits };
  }

  /** Export all relations for persistence. */
  exportRelations(): KeyRelation[] {
    return [...this.relations.values()];
  }

  /** Import relations (replaces existing). */
  importRelations(relations: KeyRelation[]): void {
    this.relations.clear();
    this.childrenIndex.clear();

    for (const r of relations) {
      this.relations.set(r.childKey, { ...r });
      if (!this.childrenIndex.has(r.parentKey)) {
        this.childrenIndex.set(r.parentKey, new Set());
      }
      this.childrenIndex.get(r.parentKey)!.add(r.childKey);
    }
  }

  /** Get stats. */
  getStats(): KeyHierarchyStats {
    const parentKeys = new Set<string>();
    const childKeys = new Set<string>();
    let maxDepthUsed = 0;

    for (const rel of this.relations.values()) {
      parentKeys.add(rel.parentKey);
      childKeys.add(rel.childKey);
      const depth = this.getDepth(rel.childKey);
      if (depth > maxDepthUsed) maxDepthUsed = depth;
    }

    return {
      totalRelations: this.relations.size,
      parentCount: parentKeys.size,
      childCount: childKeys.size,
      maxDepthUsed,
      totalCreditsCascaded: this.totalCreditsCascaded,
    };
  }

  /** Reset stats counters. */
  resetStats(): void {
    this.totalCreditsCascaded = 0;
  }

  /** Destroy and release resources. */
  destroy(): void {
    this.relations.clear();
    this.childrenIndex.clear();
    this.totalCreditsCascaded = 0;
  }
}
