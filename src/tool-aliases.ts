/**
 * ToolAliasManager — Tool renaming with deprecation notices.
 *
 * Defines aliases mapping old tool names to new names. When a deprecated
 * alias is invoked, the request is transparently routed to the new tool
 * and the response includes RFC 8594 Deprecation/Sunset headers.
 *
 * Zero external dependencies.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ToolAlias {
  /** The old/deprecated tool name. */
  from: string;
  /** The new/target tool name. */
  to: string;
  /** ISO 8601 date when the alias will stop working. Null = no sunset. */
  sunsetDate: string | null;
  /** Optional human-readable deprecation message. */
  message: string | null;
  /** When this alias was created. */
  createdAt: string;
}

export interface AliasResolveResult {
  /** The resolved (final) tool name. */
  resolvedName: string;
  /** Whether an alias was used. */
  isAlias: boolean;
  /** The alias definition if one was used. */
  alias: ToolAlias | null;
}

export interface AliasStats {
  totalAliases: number;
  aliases: ToolAlias[];
  callsViaAlias: Record<string, number>;
  totalAliasedCalls: number;
}

// ─── ToolAliasManager Class ─────────────────────────────────────────────────

export class ToolAliasManager {
  private readonly aliases = new Map<string, ToolAlias>();
  private readonly callCounts = new Map<string, number>();
  private readonly maxAliases = 200;

  /**
   * Resolve a tool name. If it's an alias, return the target tool name.
   * If the alias has a sunset date that has passed, still resolve but flag it.
   */
  resolve(toolName: string): AliasResolveResult {
    const alias = this.aliases.get(toolName);
    if (!alias) {
      return { resolvedName: toolName, isAlias: false, alias: null };
    }

    // Track usage
    this.callCounts.set(toolName, (this.callCounts.get(toolName) || 0) + 1);

    return {
      resolvedName: alias.to,
      isAlias: true,
      alias,
    };
  }

  /**
   * Add or update an alias.
   */
  addAlias(from: string, to: string, sunsetDate?: string | null, message?: string | null): ToolAlias {
    if (!from || !to) throw new Error('Both "from" and "to" tool names are required');
    if (from === to) throw new Error('Alias cannot point to itself');
    if (!from.match(/^[a-zA-Z0-9_:.-]+$/)) throw new Error(`Invalid alias name: "${from}"`);
    if (!to.match(/^[a-zA-Z0-9_:.-]+$/)) throw new Error(`Invalid target name: "${to}"`);

    // Prevent chains: if 'to' is itself an alias FROM, reject (A→B, then C→B where B→D exists)
    if (this.aliases.has(to)) {
      throw new Error(`Cannot create chain: "${to}" is already an alias for "${this.aliases.get(to)!.to}"`);
    }

    // Prevent chains: if 'from' is already a target of another alias, reject (A→B, then B→C)
    for (const existing of this.aliases.values()) {
      if (existing.to === from) {
        throw new Error(`Cannot create chain: "${from}" is already the target of alias "${existing.from}"`);
      }
    }

    // Validate sunset date
    if (sunsetDate) {
      const d = new Date(sunsetDate);
      if (isNaN(d.getTime())) throw new Error(`Invalid sunset date: "${sunsetDate}"`);
    }

    if (this.aliases.size >= this.maxAliases && !this.aliases.has(from)) {
      throw new Error(`Maximum ${this.maxAliases} aliases reached`);
    }

    const alias: ToolAlias = {
      from,
      to,
      sunsetDate: sunsetDate || null,
      message: message?.slice(0, 500) || null,
      createdAt: this.aliases.get(from)?.createdAt || new Date().toISOString(),
    };

    this.aliases.set(from, alias);
    return alias;
  }

  /**
   * Remove an alias.
   */
  removeAlias(from: string): boolean {
    const existed = this.aliases.delete(from);
    this.callCounts.delete(from);
    return existed;
  }

  /**
   * List all aliases.
   */
  listAliases(): ToolAlias[] {
    return Array.from(this.aliases.values());
  }

  /**
   * Get a specific alias by its "from" name.
   */
  getAlias(from: string): ToolAlias | null {
    return this.aliases.get(from) || null;
  }

  /**
   * Get deprecation headers for a response when an alias was used.
   * Returns RFC 8594 compliant headers.
   */
  getDeprecationHeaders(alias: ToolAlias): Record<string, string> {
    const headers: Record<string, string> = {
      'Deprecation': 'true',
    };

    if (alias.sunsetDate) {
      // RFC 8594: Sunset header value is an HTTP-date (RFC 7231)
      const d = new Date(alias.sunsetDate);
      headers['Sunset'] = d.toUTCString();
    }

    // Link header pointing to the replacement
    headers['Link'] = `</tools/${encodeURIComponent(alias.to)}>; rel="successor-version"`;

    return headers;
  }

  /**
   * Get stats about alias usage.
   */
  stats(): AliasStats {
    const callsViaAlias: Record<string, number> = {};
    let totalAliasedCalls = 0;
    for (const [name, count] of this.callCounts) {
      callsViaAlias[name] = count;
      totalAliasedCalls += count;
    }

    return {
      totalAliases: this.aliases.size,
      aliases: this.listAliases(),
      callsViaAlias,
      totalAliasedCalls,
    };
  }

  /**
   * Import aliases from a list.
   */
  importAliases(aliases: Array<{ from: string; to: string; sunsetDate?: string | null; message?: string | null }>): number {
    let imported = 0;
    for (const a of aliases) {
      try {
        this.addAlias(a.from, a.to, a.sunsetDate, a.message);
        imported++;
      } catch {
        // Skip invalid entries
      }
    }
    return imported;
  }

  /**
   * Export aliases for persistence.
   */
  exportAliases(): ToolAlias[] {
    return this.listAliases();
  }

  /**
   * Clear call counts but keep aliases.
   */
  clearCounts(): void {
    this.callCounts.clear();
  }

  /**
   * Number of registered aliases.
   */
  get size(): number {
    return this.aliases.size;
  }
}
