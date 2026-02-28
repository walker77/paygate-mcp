import { ApiVersionRouter } from '../src/api-versioning';

describe('ApiVersionRouter', () => {
  let router: ApiVersionRouter;

  beforeEach(() => {
    router = new ApiVersionRouter();
  });

  afterEach(() => {
    router.destroy();
  });

  // ─── Version Registration ─────────────────────────────────────────

  test('register and get version', () => {
    const v = router.registerVersion({ tool: 'search', version: 'v1', status: 'current' });
    expect(v.tool).toBe('search');
    expect(v.version).toBe('v1');
    expect(v.status).toBe('current');
    expect(router.getVersion('search', 'v1')?.status).toBe('current');
  });

  test('register multiple versions for same tool', () => {
    router.registerVersion({ tool: 'search', version: 'v1', status: 'deprecated' });
    router.registerVersion({ tool: 'search', version: 'v2', status: 'current' });
    const versions = router.getToolVersions('search');
    expect(versions.length).toBe(2);
  });

  test('remove version', () => {
    router.registerVersion({ tool: 'search', version: 'v1' });
    expect(router.removeVersion('search', 'v1')).toBe(true);
    expect(router.getVersion('search', 'v1')).toBeNull();
    expect(router.removeVersion('search', 'nonexistent')).toBe(false);
  });

  test('list versioned tools', () => {
    router.registerVersion({ tool: 'search', version: 'v1' });
    router.registerVersion({ tool: 'generate', version: 'v1' });
    expect(router.getVersionedTools().length).toBe(2);
  });

  test('update version status', () => {
    router.registerVersion({ tool: 'search', version: 'v1', status: 'current' });
    expect(router.setVersionStatus('search', 'v1', 'deprecated')).toBe(true);
    expect(router.getVersion('search', 'v1')?.status).toBe('deprecated');
    expect(router.setVersionStatus('search', 'v99', 'sunset')).toBe(false);
  });

  // ─── Key Version Overrides ────────────────────────────────────────

  test('set and get key version', () => {
    router.registerVersion({ tool: 'search', version: 'v1' });
    router.registerVersion({ tool: 'search', version: 'v2' });
    expect(router.setKeyVersion('k1', 'search', 'v1')).toBe(true);
    expect(router.getKeyVersion('k1', 'search')).toBe('v1');
  });

  test('set key version fails for nonexistent version', () => {
    expect(router.setKeyVersion('k1', 'search', 'v99')).toBe(false);
  });

  test('remove key version', () => {
    router.registerVersion({ tool: 'search', version: 'v1' });
    router.setKeyVersion('k1', 'search', 'v1');
    expect(router.removeKeyVersion('k1', 'search')).toBe(true);
    expect(router.getKeyVersion('k1', 'search')).toBeNull();
  });

  // ─── Resolution ───────────────────────────────────────────────────

  test('resolve uses key override', () => {
    router.registerVersion({ tool: 'search', version: 'v1', status: 'deprecated' });
    router.registerVersion({ tool: 'search', version: 'v2', status: 'current' });
    router.setKeyVersion('k1', 'search', 'v1');

    const result = router.resolve('k1', 'search')!;
    expect(result.version).toBe('v1');
    expect(result.deprecated).toBe(true);
    expect(result.warning).toContain('deprecated');
  });

  test('resolve defaults to current version', () => {
    router.registerVersion({ tool: 'search', version: 'v1', status: 'deprecated' });
    router.registerVersion({ tool: 'search', version: 'v2', status: 'current' });

    const result = router.resolve('k1', 'search')!;
    expect(result.version).toBe('v2');
    expect(result.deprecated).toBe(false);
  });

  test('resolve returns null for unknown tool', () => {
    expect(router.resolve('k1', 'nonexistent')).toBeNull();
  });

  test('resolve shows deprecation warning with sunset date', () => {
    router.registerVersion({ tool: 'search', version: 'v1', status: 'deprecated', sunsetDate: '2026-06-01' });
    router.registerVersion({ tool: 'search', version: 'v2', status: 'current' });
    router.setKeyVersion('k1', 'search', 'v1');

    const result = router.resolve('k1', 'search')!;
    expect(result.warning).toContain('deprecated');
    expect(result.warning).toContain('2026-06-01');
    expect(result.warning).toContain('v2');
  });

  test('resolve with latest strategy', () => {
    const r = new ApiVersionRouter({ defaultVersionStrategy: 'latest' });
    r.registerVersion({ tool: 'search', version: 'v1', status: 'deprecated' });
    r.registerVersion({ tool: 'search', version: 'v2', status: 'preview' });

    const result = r.resolve('k1', 'search')!;
    expect(result.version).toBe('v2'); // latest registered
    r.destroy();
  });

  // ─── Auto-Sunset ──────────────────────────────────────────────────

  test('auto-sunset past sunset date', () => {
    router.registerVersion({
      tool: 'search',
      version: 'v1',
      status: 'deprecated',
      sunsetDate: '2020-01-01', // in the past
    });
    router.registerVersion({ tool: 'search', version: 'v2', status: 'current' });

    // Resolution triggers auto-sunset check
    router.resolve('k1', 'search');
    expect(router.getVersion('search', 'v1')?.status).toBe('sunset');
  });

  test('no auto-sunset when disabled', () => {
    const r = new ApiVersionRouter({ autoSunset: false });
    r.registerVersion({
      tool: 'search',
      version: 'v1',
      status: 'deprecated',
      sunsetDate: '2020-01-01',
    });
    r.registerVersion({ tool: 'search', version: 'v2', status: 'current' });

    r.resolve('k1', 'search');
    expect(r.getVersion('search', 'v1')?.status).toBe('deprecated'); // not sunset
    r.destroy();
  });

  // ─── Migration ────────────────────────────────────────────────────

  test('plan migration', () => {
    router.registerVersion({ tool: 'search', version: 'v1', status: 'deprecated' });
    router.registerVersion({ tool: 'search', version: 'v2', status: 'current' });
    router.setKeyVersion('k1', 'search', 'v1');
    router.setKeyVersion('k2', 'search', 'v1');
    router.setKeyVersion('k3', 'search', 'v2');

    const plan = router.planMigration('search', 'v1', 'v2')!;
    expect(plan.affectedKeys.length).toBe(2);
    expect(plan.affectedKeys).toContain('k1');
    expect(plan.affectedKeys).toContain('k2');
    expect(plan.fromVersion).toBe('v1');
    expect(plan.toVersion).toBe('v2');
  });

  test('execute migration', () => {
    router.registerVersion({ tool: 'search', version: 'v1', status: 'deprecated' });
    router.registerVersion({ tool: 'search', version: 'v2', status: 'current' });
    router.setKeyVersion('k1', 'search', 'v1');
    router.setKeyVersion('k2', 'search', 'v1');

    const migrated = router.executeMigration('search', 'v1', 'v2');
    expect(migrated).toBe(2);
    expect(router.getKeyVersion('k1', 'search')).toBe('v2');
    expect(router.getKeyVersion('k2', 'search')).toBe('v2');
  });

  test('plan migration returns null for missing versions', () => {
    expect(router.planMigration('search', 'v1', 'v2')).toBeNull();
  });

  // ─── Deprecation Queries ──────────────────────────────────────────

  test('get deprecated versions', () => {
    router.registerVersion({ tool: 'search', version: 'v1', status: 'deprecated' });
    router.registerVersion({ tool: 'search', version: 'v2', status: 'current' });
    router.registerVersion({ tool: 'generate', version: 'v1', status: 'deprecated' });

    const deprecated = router.getDeprecatedVersions();
    expect(deprecated.length).toBe(2);
  });

  test('get approaching sunset', () => {
    router.registerVersion({
      tool: 'search',
      version: 'v1',
      status: 'deprecated',
      sunsetDate: new Date(Date.now() + 10 * 24 * 3600_000).toISOString().split('T')[0], // 10 days from now
    });
    router.registerVersion({
      tool: 'generate',
      version: 'v1',
      status: 'deprecated',
      sunsetDate: new Date(Date.now() + 60 * 24 * 3600_000).toISOString().split('T')[0], // 60 days from now
    });

    const approaching = router.getApproachingSunset(30);
    expect(approaching.length).toBe(1);
    expect(approaching[0].tool).toBe('search');
  });

  // ─── Stats ────────────────────────────────────────────────────────

  test('stats track versions and overrides', () => {
    router.registerVersion({ tool: 'search', version: 'v1', status: 'deprecated' });
    router.registerVersion({ tool: 'search', version: 'v2', status: 'current' });
    router.registerVersion({ tool: 'generate', version: 'v1', status: 'preview' });
    router.setKeyVersion('k1', 'search', 'v1');
    router.resolve('k1', 'search');
    router.resolve('k2', 'search');

    const stats = router.getStats();
    expect(stats.totalTools).toBe(2);
    expect(stats.totalVersions).toBe(3);
    expect(stats.currentVersions).toBe(1);
    expect(stats.deprecatedVersions).toBe(1);
    expect(stats.previewVersions).toBe(1);
    expect(stats.keyOverrides).toBe(1);
    expect(stats.totalResolutions).toBe(2);
  });

  test('destroy clears everything', () => {
    router.registerVersion({ tool: 'search', version: 'v1' });
    router.setKeyVersion('k1', 'search', 'v1');
    router.resolve('k1', 'search');
    router.destroy();
    expect(router.getStats().totalTools).toBe(0);
    expect(router.getStats().totalResolutions).toBe(0);
  });

  // ─── Remove version cleans up key overrides ────────────────────────

  test('removing version cleans up key overrides', () => {
    router.registerVersion({ tool: 'search', version: 'v1' });
    router.setKeyVersion('k1', 'search', 'v1');
    router.removeVersion('search', 'v1');
    expect(router.getKeyVersion('k1', 'search')).toBeNull();
  });
});
