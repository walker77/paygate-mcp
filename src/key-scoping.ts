/**
 * KeyScopeManager — Fine-grained tool access control per API key.
 *
 * Define scopes (permissions) for API keys, restricting which tools
 * they can access. Supports scope inheritance, wildcard matching,
 * and temporary scope grants with expiration.
 *
 * @example
 * ```ts
 * const mgr = new KeyScopeManager();
 *
 * mgr.defineScope({ name: 'read', description: 'Read-only access' });
 * mgr.defineScope({ name: 'write', description: 'Write access', includes: ['read'] });
 *
 * mgr.setToolScopes('search', ['read']);
 * mgr.setToolScopes('delete_file', ['write']);
 *
 * mgr.grantScopes('key_abc', ['read']);
 *
 * mgr.canAccess('key_abc', 'search');    // true
 * mgr.canAccess('key_abc', 'delete_file'); // false
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export interface ScopeDefinition {
  name: string;
  description?: string;
  /** Scopes that this scope includes (inheritance). */
  includes: string[];
  createdAt: number;
}

export interface ScopeDefinitionParams {
  name: string;
  description?: string;
  includes?: string[];
}

export interface KeyScopes {
  key: string;
  scopes: Set<string>;
  /** Temporary grants: scope → expiration timestamp. */
  temporaryGrants: Map<string, number>;
  updatedAt: number;
}

export interface AccessCheckResult {
  allowed: boolean;
  key: string;
  tool: string;
  requiredScopes: string[];
  keyScopes: string[];
  /** Which scope(s) satisfied the requirement, if allowed. */
  matchedScopes: string[];
  /** Why access was denied, if not allowed. */
  reason?: string;
}

export interface TemporaryGrant {
  key: string;
  scope: string;
  expiresAt: number;
}

export interface KeyScopeConfig {
  /** If true, tools without explicit scopes allow all keys. Default true. */
  allowUnscopedTools?: boolean;
  /** If true, keys without explicit scopes are denied all scoped tools. Default true. */
  denyUnscopedKeys?: boolean;
}

export interface KeyScopeStats {
  totalScopes: number;
  totalKeys: number;
  totalToolMappings: number;
  totalTemporaryGrants: number;
  totalAccessChecks: number;
  totalAllowed: number;
  totalDenied: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class KeyScopeManager {
  // Scope definitions: name → ScopeDefinition
  private scopes = new Map<string, ScopeDefinition>();
  // Tool → required scopes (ANY of these grants access)
  private toolScopes = new Map<string, Set<string>>();
  // Key → KeyScopes
  private keyScopes = new Map<string, KeyScopes>();

  private allowUnscopedTools: boolean;
  private denyUnscopedKeys: boolean;

  // Stats
  private totalChecks = 0;
  private totalAllowed = 0;
  private totalDenied = 0;

  constructor(config: KeyScopeConfig = {}) {
    this.allowUnscopedTools = config.allowUnscopedTools ?? true;
    this.denyUnscopedKeys = config.denyUnscopedKeys ?? true;
  }

  // ── Scope Definitions ─────────────────────────────────────────────

  /** Define a new scope. */
  defineScope(params: ScopeDefinitionParams): ScopeDefinition {
    if (this.scopes.has(params.name)) {
      throw new Error(`Scope already exists: ${params.name}`);
    }
    const scope: ScopeDefinition = {
      name: params.name,
      description: params.description,
      includes: params.includes ?? [],
      createdAt: Date.now(),
    };
    this.scopes.set(params.name, scope);
    return scope;
  }

  /** Remove a scope definition. */
  removeScope(name: string): boolean {
    if (!this.scopes.delete(name)) return false;
    // Clean up references
    for (const [tool, scopes] of this.toolScopes.entries()) {
      scopes.delete(name);
      if (scopes.size === 0) this.toolScopes.delete(tool);
    }
    for (const ks of this.keyScopes.values()) {
      ks.scopes.delete(name);
      ks.temporaryGrants.delete(name);
    }
    return true;
  }

  /** Get a scope definition. */
  getScope(name: string): ScopeDefinition | null {
    return this.scopes.get(name) ?? null;
  }

  /** List all scope definitions. */
  listScopes(): ScopeDefinition[] {
    return [...this.scopes.values()];
  }

  /** Resolve all effective scopes (including inherited) for a scope name. */
  resolveScope(name: string, visited = new Set<string>()): Set<string> {
    const result = new Set<string>();
    if (visited.has(name)) return result; // Prevent circular
    visited.add(name);

    const scope = this.scopes.get(name);
    if (!scope) return result;

    result.add(name);
    for (const included of scope.includes) {
      for (const s of this.resolveScope(included, visited)) {
        result.add(s);
      }
    }
    return result;
  }

  // ── Tool Scope Mapping ────────────────────────────────────────────

  /** Set required scopes for a tool. Any of these scopes grants access. */
  setToolScopes(tool: string, scopes: string[]): void {
    this.toolScopes.set(tool, new Set(scopes));
  }

  /** Get required scopes for a tool. */
  getToolScopes(tool: string): string[] {
    return [...(this.toolScopes.get(tool) ?? [])];
  }

  /** Remove scope requirements from a tool. */
  removeToolScopes(tool: string): boolean {
    return this.toolScopes.delete(tool);
  }

  /** List all tools with scope requirements. */
  listScopedTools(): string[] {
    return [...this.toolScopes.keys()];
  }

  // ── Key Scope Grants ──────────────────────────────────────────────

  /** Grant permanent scopes to a key. */
  grantScopes(key: string, scopes: string[]): void {
    let ks = this.keyScopes.get(key);
    if (!ks) {
      ks = { key, scopes: new Set(), temporaryGrants: new Map(), updatedAt: Date.now() };
      this.keyScopes.set(key, ks);
    }
    for (const s of scopes) {
      ks.scopes.add(s);
    }
    ks.updatedAt = Date.now();
  }

  /** Revoke scopes from a key. */
  revokeScopes(key: string, scopes: string[]): boolean {
    const ks = this.keyScopes.get(key);
    if (!ks) return false;
    for (const s of scopes) {
      ks.scopes.delete(s);
      ks.temporaryGrants.delete(s);
    }
    ks.updatedAt = Date.now();
    return true;
  }

  /** Grant a temporary scope with expiration. */
  grantTemporary(key: string, scope: string, durationSeconds: number): TemporaryGrant {
    let ks = this.keyScopes.get(key);
    if (!ks) {
      ks = { key, scopes: new Set(), temporaryGrants: new Map(), updatedAt: Date.now() };
      this.keyScopes.set(key, ks);
    }
    const expiresAt = Date.now() + durationSeconds * 1000;
    ks.temporaryGrants.set(scope, expiresAt);
    ks.updatedAt = Date.now();
    return { key, scope, expiresAt };
  }

  /** Get all scopes for a key (permanent + valid temporary). */
  getKeyScopes(key: string): string[] {
    const ks = this.keyScopes.get(key);
    if (!ks) return [];

    const result = new Set<string>(ks.scopes);
    const now = Date.now();

    // Add valid temporary grants
    for (const [scope, expiresAt] of ks.temporaryGrants.entries()) {
      if (expiresAt > now) {
        result.add(scope);
      } else {
        ks.temporaryGrants.delete(scope); // Clean up expired
      }
    }

    return [...result];
  }

  /** Get all effective scopes for a key (including inherited). */
  getEffectiveScopes(key: string): string[] {
    const direct = this.getKeyScopes(key);
    const effective = new Set<string>();
    for (const s of direct) {
      // Always include the direct scope (even if not defined, e.g. '*')
      effective.add(s);
      for (const resolved of this.resolveScope(s)) {
        effective.add(resolved);
      }
    }
    return [...effective];
  }

  /** Remove a key entirely. */
  removeKey(key: string): boolean {
    return this.keyScopes.delete(key);
  }

  /** List all keys with scopes. */
  listKeys(): string[] {
    return [...this.keyScopes.keys()];
  }

  // ── Access Control ────────────────────────────────────────────────

  /** Check if a key can access a tool. */
  canAccess(key: string, tool: string): boolean {
    return this.checkAccess(key, tool).allowed;
  }

  /** Detailed access check with reasons. */
  checkAccess(key: string, tool: string): AccessCheckResult {
    this.totalChecks++;

    const requiredScopes = this.toolScopes.get(tool);

    // Tool has no scope requirements
    if (!requiredScopes || requiredScopes.size === 0) {
      const allowed = this.allowUnscopedTools;
      if (allowed) this.totalAllowed++; else this.totalDenied++;
      return {
        allowed,
        key,
        tool,
        requiredScopes: [],
        keyScopes: this.getKeyScopes(key),
        matchedScopes: [],
        reason: allowed ? undefined : 'Tool has no scopes and unscoped tools are denied',
      };
    }

    // Key has no scopes
    const effectiveScopes = this.getEffectiveScopes(key);
    if (effectiveScopes.length === 0) {
      this.totalDenied++;
      return {
        allowed: false,
        key,
        tool,
        requiredScopes: [...requiredScopes],
        keyScopes: [],
        matchedScopes: [],
        reason: 'Key has no scopes',
      };
    }

    // Check if any key scope matches any required scope
    const matchedScopes: string[] = [];
    for (const scope of effectiveScopes) {
      if (requiredScopes.has(scope)) {
        matchedScopes.push(scope);
      }
    }

    // Also check wildcard: if key has '*' scope
    if (effectiveScopes.includes('*')) {
      matchedScopes.push('*');
    }

    const allowed = matchedScopes.length > 0;
    if (allowed) this.totalAllowed++; else this.totalDenied++;

    return {
      allowed,
      key,
      tool,
      requiredScopes: [...requiredScopes],
      keyScopes: effectiveScopes,
      matchedScopes,
      reason: allowed ? undefined : `Key scopes [${effectiveScopes.join(', ')}] do not match required [${[...requiredScopes].join(', ')}]`,
    };
  }

  // ── Stats ─────────────────────────────────────────────────────────

  getStats(): KeyScopeStats {
    let totalTempGrants = 0;
    for (const ks of this.keyScopes.values()) {
      totalTempGrants += ks.temporaryGrants.size;
    }

    return {
      totalScopes: this.scopes.size,
      totalKeys: this.keyScopes.size,
      totalToolMappings: this.toolScopes.size,
      totalTemporaryGrants: totalTempGrants,
      totalAccessChecks: this.totalChecks,
      totalAllowed: this.totalAllowed,
      totalDenied: this.totalDenied,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.scopes.clear();
    this.toolScopes.clear();
    this.keyScopes.clear();
    this.totalChecks = 0;
    this.totalAllowed = 0;
    this.totalDenied = 0;
  }
}
