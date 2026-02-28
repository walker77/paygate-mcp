/**
 * APIKeyTagManager — Tag-based API key organization with search and filtering.
 *
 * Assign tags to API keys, search by tags, and group keys
 * for bulk operations and reporting.
 *
 * @example
 * ```ts
 * const mgr = new APIKeyTagManager();
 *
 * mgr.setTags('key_abc', ['tier:free', 'region:us', 'team:backend']);
 * mgr.addTag('key_xyz', 'tier:pro');
 *
 * const freeKeys = mgr.findByTag('tier:free');
 * const groups = mgr.groupByPrefix('tier');
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface KeyTagEntry {
  key: string;
  tags: Set<string>;
  updatedAt: number;
}

export interface TagSearchResult {
  key: string;
  tags: string[];
  matchedTags: string[];
}

export interface TagGroup {
  prefix: string;
  values: string[];
  keyCount: number;
}

export interface KeyTagConfig {
  /** Max tags per key. Default 20. */
  maxTagsPerKey?: number;
  /** Max total keys tracked. Default 100000. */
  maxKeys?: number;
}

export interface KeyTagStats {
  totalKeys: number;
  totalTags: number;
  uniqueTags: number;
  avgTagsPerKey: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class APIKeyTagManager {
  private entries = new Map<string, KeyTagEntry>();
  private tagIndex = new Map<string, Set<string>>(); // tag → keys

  private maxTagsPerKey: number;
  private maxKeys: number;

  constructor(config: KeyTagConfig = {}) {
    this.maxTagsPerKey = config.maxTagsPerKey ?? 20;
    this.maxKeys = config.maxKeys ?? 100_000;
  }

  // ── Tag Operations ────────────────────────────────────────────

  /** Set all tags for a key (replaces existing). */
  setTags(key: string, tags: string[]): void {
    if (!key) throw new Error('Key is required');
    if (tags.length > this.maxTagsPerKey) {
      throw new Error(`Maximum ${this.maxTagsPerKey} tags per key`);
    }

    // Remove old index entries
    const existing = this.entries.get(key);
    if (existing) {
      for (const tag of existing.tags) {
        const set = this.tagIndex.get(tag);
        if (set) {
          set.delete(key);
          if (set.size === 0) this.tagIndex.delete(tag);
        }
      }
    } else if (this.entries.size >= this.maxKeys) {
      throw new Error(`Maximum ${this.maxKeys} keys reached`);
    }

    // Set new tags
    const tagSet = new Set(tags.filter(t => t.length > 0));
    this.entries.set(key, { key, tags: tagSet, updatedAt: Date.now() });

    // Update index
    for (const tag of tagSet) {
      if (!this.tagIndex.has(tag)) this.tagIndex.set(tag, new Set());
      this.tagIndex.get(tag)!.add(key);
    }
  }

  /** Add a single tag to a key. */
  addTag(key: string, tag: string): void {
    if (!tag) throw new Error('Tag is required');

    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxKeys) {
        throw new Error(`Maximum ${this.maxKeys} keys reached`);
      }
      entry = { key, tags: new Set(), updatedAt: Date.now() };
      this.entries.set(key, entry);
    }

    if (entry.tags.size >= this.maxTagsPerKey) {
      throw new Error(`Maximum ${this.maxTagsPerKey} tags per key`);
    }

    entry.tags.add(tag);
    entry.updatedAt = Date.now();

    if (!this.tagIndex.has(tag)) this.tagIndex.set(tag, new Set());
    this.tagIndex.get(tag)!.add(key);
  }

  /** Remove a tag from a key. */
  removeTag(key: string, tag: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;

    const removed = entry.tags.delete(tag);
    if (removed) {
      entry.updatedAt = Date.now();
      const set = this.tagIndex.get(tag);
      if (set) {
        set.delete(key);
        if (set.size === 0) this.tagIndex.delete(tag);
      }
    }

    return removed;
  }

  /** Get all tags for a key. */
  getTags(key: string): string[] {
    const entry = this.entries.get(key);
    return entry ? [...entry.tags] : [];
  }

  /** Check if a key has a specific tag. */
  hasTag(key: string, tag: string): boolean {
    const entry = this.entries.get(key);
    return entry ? entry.tags.has(tag) : false;
  }

  /** Remove all tags from a key. */
  clearTags(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;

    for (const tag of entry.tags) {
      const set = this.tagIndex.get(tag);
      if (set) {
        set.delete(key);
        if (set.size === 0) this.tagIndex.delete(tag);
      }
    }

    this.entries.delete(key);
  }

  // ── Search ────────────────────────────────────────────────────

  /** Find all keys with a specific tag. */
  findByTag(tag: string): string[] {
    const set = this.tagIndex.get(tag);
    return set ? [...set] : [];
  }

  /** Find keys matching ALL given tags. */
  findByAllTags(tags: string[]): string[] {
    if (tags.length === 0) return [];

    const sets = tags.map(t => this.tagIndex.get(t) ?? new Set<string>());
    // Intersect all sets
    const smallest = sets.reduce((a, b) => a.size < b.size ? a : b);
    const result: string[] = [];

    for (const key of smallest) {
      if (sets.every(s => s.has(key))) {
        result.push(key);
      }
    }

    return result;
  }

  /** Find keys matching ANY of the given tags. */
  findByAnyTag(tags: string[]): string[] {
    const keys = new Set<string>();
    for (const tag of tags) {
      const set = this.tagIndex.get(tag);
      if (set) {
        for (const key of set) keys.add(key);
      }
    }
    return [...keys];
  }

  /** Search tags by prefix (e.g., 'tier:' returns 'tier:free', 'tier:pro'). */
  searchTags(prefix: string): string[] {
    const matches: string[] = [];
    for (const tag of this.tagIndex.keys()) {
      if (tag.startsWith(prefix)) matches.push(tag);
    }
    return matches.sort();
  }

  /** List all unique tags. */
  listAllTags(): string[] {
    return [...this.tagIndex.keys()].sort();
  }

  // ── Grouping ──────────────────────────────────────────────────

  /** Group tags by prefix (colon-separated). */
  groupByPrefix(prefix: string): TagGroup {
    const values: string[] = [];
    const keys = new Set<string>();

    for (const [tag, keySet] of this.tagIndex) {
      if (tag.startsWith(prefix + ':')) {
        values.push(tag.slice(prefix.length + 1));
        for (const k of keySet) keys.add(k);
      }
    }

    return { prefix, values: values.sort(), keyCount: keys.size };
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): KeyTagStats {
    let totalTags = 0;
    for (const entry of this.entries.values()) {
      totalTags += entry.tags.size;
    }

    return {
      totalKeys: this.entries.size,
      totalTags,
      uniqueTags: this.tagIndex.size,
      avgTagsPerKey: this.entries.size > 0 ? Math.round((totalTags / this.entries.size) * 100) / 100 : 0,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.entries.clear();
    this.tagIndex.clear();
  }
}
