import { KeyScopeManager } from '../src/key-scoping';

describe('KeyScopeManager', () => {
  let mgr: KeyScopeManager;

  beforeEach(() => {
    mgr = new KeyScopeManager();
  });

  // ── Scope Definitions ──────────────────────────────────────────

  it('defines a scope', () => {
    const scope = mgr.defineScope({ name: 'read', description: 'Read-only' });
    expect(scope.name).toBe('read');
    expect(scope.includes).toEqual([]);
  });

  it('rejects duplicate scope names', () => {
    mgr.defineScope({ name: 'read' });
    expect(() => mgr.defineScope({ name: 'read' })).toThrow('already exists');
  });

  it('lists all scopes', () => {
    mgr.defineScope({ name: 'read' });
    mgr.defineScope({ name: 'write' });
    expect(mgr.listScopes()).toHaveLength(2);
  });

  it('removes a scope and cleans up references', () => {
    mgr.defineScope({ name: 'read' });
    mgr.setToolScopes('search', ['read']);
    mgr.grantScopes('key_a', ['read']);
    mgr.removeScope('read');
    expect(mgr.getScope('read')).toBeNull();
    expect(mgr.getToolScopes('search')).toEqual([]);
    expect(mgr.getKeyScopes('key_a')).toEqual([]);
  });

  // ── Scope Inheritance ──────────────────────────────────────────

  it('resolves inherited scopes', () => {
    mgr.defineScope({ name: 'read' });
    mgr.defineScope({ name: 'write', includes: ['read'] });
    mgr.defineScope({ name: 'admin', includes: ['write'] });

    const resolved = mgr.resolveScope('admin');
    expect(resolved).toContain('admin');
    expect(resolved).toContain('write');
    expect(resolved).toContain('read');
  });

  it('handles circular scope references', () => {
    mgr.defineScope({ name: 'a', includes: ['b'] });
    mgr.defineScope({ name: 'b', includes: ['a'] });
    const resolved = mgr.resolveScope('a');
    // Should not infinite loop — just returns what it finds
    expect(resolved).toContain('a');
    expect(resolved).toContain('b');
  });

  // ── Tool Scope Mapping ────────────────────────────────────────

  it('sets and gets tool scopes', () => {
    mgr.setToolScopes('search', ['read']);
    mgr.setToolScopes('delete', ['write']);
    expect(mgr.getToolScopes('search')).toEqual(['read']);
    expect(mgr.getToolScopes('delete')).toEqual(['write']);
  });

  it('lists scoped tools', () => {
    mgr.setToolScopes('search', ['read']);
    mgr.setToolScopes('delete', ['write']);
    expect(mgr.listScopedTools()).toEqual(expect.arrayContaining(['search', 'delete']));
  });

  it('removes tool scopes', () => {
    mgr.setToolScopes('search', ['read']);
    mgr.removeToolScopes('search');
    expect(mgr.getToolScopes('search')).toEqual([]);
  });

  // ── Key Scope Grants ──────────────────────────────────────────

  it('grants scopes to a key', () => {
    mgr.grantScopes('key_a', ['read', 'write']);
    expect(mgr.getKeyScopes('key_a')).toEqual(expect.arrayContaining(['read', 'write']));
  });

  it('revokes scopes from a key', () => {
    mgr.grantScopes('key_a', ['read', 'write']);
    mgr.revokeScopes('key_a', ['write']);
    expect(mgr.getKeyScopes('key_a')).toEqual(['read']);
  });

  it('removes a key entirely', () => {
    mgr.grantScopes('key_a', ['read']);
    mgr.removeKey('key_a');
    expect(mgr.getKeyScopes('key_a')).toEqual([]);
  });

  it('lists all keys', () => {
    mgr.grantScopes('key_a', ['read']);
    mgr.grantScopes('key_b', ['write']);
    expect(mgr.listKeys()).toEqual(expect.arrayContaining(['key_a', 'key_b']));
  });

  // ── Temporary Grants ──────────────────────────────────────────

  it('grants temporary scopes', () => {
    const grant = mgr.grantTemporary('key_a', 'admin', 3600);
    expect(grant.scope).toBe('admin');
    expect(grant.expiresAt).toBeGreaterThan(Date.now());
    expect(mgr.getKeyScopes('key_a')).toContain('admin');
  });

  it('expires temporary grants', () => {
    mgr.grantTemporary('key_a', 'admin', 0); // Expires immediately
    // Wait a tick for expiration
    const scopes = mgr.getKeyScopes('key_a');
    expect(scopes).not.toContain('admin');
  });

  // ── Effective Scopes ──────────────────────────────────────────

  it('resolves effective scopes with inheritance', () => {
    mgr.defineScope({ name: 'read' });
    mgr.defineScope({ name: 'write', includes: ['read'] });
    mgr.grantScopes('key_a', ['write']);
    const effective = mgr.getEffectiveScopes('key_a');
    expect(effective).toContain('write');
    expect(effective).toContain('read');
  });

  // ── Access Control ────────────────────────────────────────────

  it('allows access when key has required scope', () => {
    mgr.defineScope({ name: 'read' });
    mgr.setToolScopes('search', ['read']);
    mgr.grantScopes('key_a', ['read']);
    expect(mgr.canAccess('key_a', 'search')).toBe(true);
  });

  it('denies access when key lacks required scope', () => {
    mgr.defineScope({ name: 'read' });
    mgr.defineScope({ name: 'write' });
    mgr.setToolScopes('delete', ['write']);
    mgr.grantScopes('key_a', ['read']);
    expect(mgr.canAccess('key_a', 'delete')).toBe(false);
  });

  it('allows access through inherited scopes', () => {
    mgr.defineScope({ name: 'read' });
    mgr.defineScope({ name: 'admin', includes: ['read'] });
    mgr.setToolScopes('search', ['read']);
    mgr.grantScopes('key_a', ['admin']);
    expect(mgr.canAccess('key_a', 'search')).toBe(true);
  });

  it('allows unscoped tools by default', () => {
    mgr.grantScopes('key_a', ['read']);
    // 'search' has no scope requirements
    expect(mgr.canAccess('key_a', 'search')).toBe(true);
  });

  it('denies unscoped tools when configured', () => {
    const strict = new KeyScopeManager({ allowUnscopedTools: false });
    strict.grantScopes('key_a', ['read']);
    expect(strict.canAccess('key_a', 'search')).toBe(false);
    strict.destroy();
  });

  it('denies keys without any scopes', () => {
    mgr.defineScope({ name: 'read' });
    mgr.setToolScopes('search', ['read']);
    expect(mgr.canAccess('key_no_scopes', 'search')).toBe(false);
  });

  // ── Detailed Access Check ─────────────────────────────────────

  it('returns detailed access check result', () => {
    mgr.defineScope({ name: 'read' });
    mgr.defineScope({ name: 'write' });
    mgr.setToolScopes('delete', ['write']);
    mgr.grantScopes('key_a', ['read']);

    const result = mgr.checkAccess('key_a', 'delete');
    expect(result.allowed).toBe(false);
    expect(result.requiredScopes).toEqual(['write']);
    expect(result.reason).toContain('do not match');
  });

  it('includes matched scopes in result', () => {
    mgr.defineScope({ name: 'read' });
    mgr.setToolScopes('search', ['read']);
    mgr.grantScopes('key_a', ['read']);

    const result = mgr.checkAccess('key_a', 'search');
    expect(result.allowed).toBe(true);
    expect(result.matchedScopes).toContain('read');
  });

  // ── Wildcard Scope ────────────────────────────────────────────

  it('allows access with wildcard scope', () => {
    mgr.defineScope({ name: 'admin' });
    mgr.setToolScopes('anything', ['admin']);
    mgr.grantScopes('key_super', ['*']);
    expect(mgr.canAccess('key_super', 'anything')).toBe(true);
  });

  // ── Stats ─────────────────────────────────────────────────────

  it('tracks stats', () => {
    mgr.defineScope({ name: 'read' });
    mgr.setToolScopes('search', ['read']);
    mgr.grantScopes('key_a', ['read']);
    mgr.grantTemporary('key_a', 'temp', 3600);
    mgr.canAccess('key_a', 'search'); // allowed
    mgr.canAccess('key_b', 'search'); // denied

    const stats = mgr.getStats();
    expect(stats.totalScopes).toBe(1);
    // key_b is never granted scopes, so totalKeys is 1
    expect(stats.totalKeys).toBe(1);
    expect(stats.totalToolMappings).toBe(1);
    expect(stats.totalTemporaryGrants).toBe(1);
    expect(stats.totalAccessChecks).toBe(2);
    expect(stats.totalAllowed).toBe(1);
    expect(stats.totalDenied).toBe(1);
  });

  // ── Destroy ───────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    mgr.defineScope({ name: 'read' });
    mgr.setToolScopes('search', ['read']);
    mgr.grantScopes('key_a', ['read']);
    mgr.destroy();
    expect(mgr.getStats().totalScopes).toBe(0);
    expect(mgr.getStats().totalKeys).toBe(0);
  });
});
