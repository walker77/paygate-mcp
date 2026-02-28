import { ABTestingManager } from '../src/ab-testing';

describe('ABTestingManager', () => {
  let mgr: ABTestingManager;

  beforeEach(() => {
    mgr = new ABTestingManager();
  });

  // ── Experiment Creation ─────────────────────────────────────────

  it('creates an experiment', () => {
    const exp = mgr.createExperiment({
      name: 'test_1',
      variants: [
        { name: 'control', weight: 50, config: {} },
        { name: 'treatment', weight: 50, config: {} },
      ],
    });
    expect(exp.name).toBe('test_1');
    expect(exp.status).toBe('draft');
    expect(exp.variants).toHaveLength(2);
  });

  it('auto-starts experiment', () => {
    const exp = mgr.createExperiment({
      name: 'test_1',
      autoStart: true,
      variants: [
        { name: 'a', weight: 50, config: {} },
        { name: 'b', weight: 50, config: {} },
      ],
    });
    expect(exp.status).toBe('running');
    expect(exp.startedAt).toEqual(expect.any(Number));
  });

  it('rejects duplicate experiment names', () => {
    mgr.createExperiment({ name: 'x', variants: [{ name: 'a', weight: 1, config: {} }, { name: 'b', weight: 1, config: {} }] });
    expect(() => mgr.createExperiment({ name: 'x', variants: [{ name: 'a', weight: 1, config: {} }, { name: 'b', weight: 1, config: {} }] }))
      .toThrow('already exists');
  });

  it('requires at least 2 variants', () => {
    expect(() => mgr.createExperiment({ name: 'x', variants: [{ name: 'a', weight: 1, config: {} }] }))
      .toThrow('At least 2');
  });

  it('lists experiments', () => {
    mgr.createExperiment({ name: 'a', variants: [{ name: 'x', weight: 1, config: {} }, { name: 'y', weight: 1, config: {} }] });
    mgr.createExperiment({ name: 'b', variants: [{ name: 'x', weight: 1, config: {} }, { name: 'y', weight: 1, config: {} }] });
    expect(mgr.listExperiments()).toHaveLength(2);
  });

  // ── Lifecycle ───────────────────────────────────────────────────

  it('starts, pauses, and completes experiment', () => {
    mgr.createExperiment({ name: 'e', variants: [{ name: 'a', weight: 1, config: {} }, { name: 'b', weight: 1, config: {} }] });
    mgr.startExperiment('e');
    expect(mgr.getExperimentByName('e')!.status).toBe('running');

    mgr.pauseExperiment('e');
    expect(mgr.getExperimentByName('e')!.status).toBe('paused');

    mgr.startExperiment('e'); // resume from paused
    mgr.completeExperiment('e');
    expect(mgr.getExperimentByName('e')!.status).toBe('completed');
    expect(mgr.getExperimentByName('e')!.completedAt).toEqual(expect.any(Number));
  });

  it('cannot restart completed experiment', () => {
    mgr.createExperiment({ name: 'e', autoStart: true, variants: [{ name: 'a', weight: 1, config: {} }, { name: 'b', weight: 1, config: {} }] });
    mgr.completeExperiment('e');
    expect(() => mgr.startExperiment('e')).toThrow('Cannot restart');
  });

  it('removes experiment', () => {
    mgr.createExperiment({ name: 'e', variants: [{ name: 'a', weight: 1, config: {} }, { name: 'b', weight: 1, config: {} }] });
    expect(mgr.removeExperiment('e')).toBe(true);
    expect(mgr.getExperimentByName('e')).toBeNull();
  });

  // ── Variant Assignment ─────────────────────────────────────────

  it('assigns variant deterministically', () => {
    mgr.createExperiment({
      name: 'e',
      autoStart: true,
      variants: [
        { name: 'control', weight: 50, config: { price: 1 } },
        { name: 'treatment', weight: 50, config: { price: 2 } },
      ],
    });

    const a1 = mgr.assignVariant('e', 'key_abc');
    const a2 = mgr.assignVariant('e', 'key_abc');
    expect(a1.variant).toBe(a2.variant); // deterministic
  });

  it('returns existing assignment', () => {
    mgr.createExperiment({
      name: 'e',
      autoStart: true,
      variants: [{ name: 'a', weight: 1, config: {} }, { name: 'b', weight: 1, config: {} }],
    });
    const a1 = mgr.assignVariant('e', 'key_1');
    const a2 = mgr.assignVariant('e', 'key_1');
    expect(a1).toEqual(a2);
  });

  it('fails to assign in non-running experiment', () => {
    mgr.createExperiment({ name: 'e', variants: [{ name: 'a', weight: 1, config: {} }, { name: 'b', weight: 1, config: {} }] });
    expect(() => mgr.assignVariant('e', 'key_1')).toThrow('not running');
  });

  it('distributes across variants', () => {
    mgr.createExperiment({
      name: 'e',
      autoStart: true,
      variants: [
        { name: 'a', weight: 50, config: {} },
        { name: 'b', weight: 50, config: {} },
      ],
    });

    const variants = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const assignment = mgr.assignVariant('e', `key_${i}`);
      variants.add(assignment.variant);
    }
    // With 100 keys and 50/50 split, both variants should appear
    expect(variants.size).toBe(2);
  });

  it('gets variant config', () => {
    mgr.createExperiment({
      name: 'e',
      autoStart: true,
      variants: [
        { name: 'a', weight: 50, config: { price: 10 } },
        { name: 'b', weight: 50, config: { price: 20 } },
      ],
    });

    mgr.assignVariant('e', 'key_1');
    const config = mgr.getVariantConfig('e', 'key_1');
    expect(config).toBeDefined();
    expect(config).toHaveProperty('price');
  });

  // ── Metrics ────────────────────────────────────────────────────

  it('records metrics', () => {
    mgr.createExperiment({
      name: 'e',
      autoStart: true,
      variants: [{ name: 'a', weight: 1, config: {} }, { name: 'b', weight: 1, config: {} }],
    });
    mgr.assignVariant('e', 'key_1');
    const m = mgr.recordMetric('e', 'key_1', 'revenue', 50);
    expect(m.metric).toBe('revenue');
    expect(m.value).toBe(50);
  });

  it('fails to record metric for unassigned key', () => {
    mgr.createExperiment({
      name: 'e',
      autoStart: true,
      variants: [{ name: 'a', weight: 1, config: {} }, { name: 'b', weight: 1, config: {} }],
    });
    expect(() => mgr.recordMetric('e', 'key_1', 'rev', 10)).toThrow('not assigned');
  });

  // ── Results ────────────────────────────────────────────────────

  it('computes experiment results', () => {
    mgr.createExperiment({
      name: 'e',
      autoStart: true,
      variants: [
        { name: 'control', weight: 50, config: {} },
        { name: 'treatment', weight: 50, config: {} },
      ],
    });

    // Assign and record metrics for several keys
    for (let i = 0; i < 20; i++) {
      mgr.assignVariant('e', `key_${i}`);
      mgr.recordMetric('e', `key_${i}`, 'revenue', 10 + i);
    }

    const results = mgr.getResults('e');
    expect(results.name).toBe('e');
    expect(results.totalAssignments).toBe(20);
    expect(results.variants).toHaveLength(2);

    // Each variant should have metric data
    for (const v of results.variants) {
      if (v.sampleSize > 0) {
        expect(v.metrics.has('revenue')).toBe(true);
        const rev = v.metrics.get('revenue')!;
        expect(rev.count).toBeGreaterThan(0);
        expect(rev.avg).toBeGreaterThan(0);
      }
    }
  });

  // ── Stats ───────────────────────────────────────────────────────

  it('tracks stats', () => {
    mgr.createExperiment({
      name: 'e',
      autoStart: true,
      variants: [{ name: 'a', weight: 1, config: {} }, { name: 'b', weight: 1, config: {} }],
    });
    mgr.assignVariant('e', 'key_1');
    mgr.recordMetric('e', 'key_1', 'rev', 10);

    const stats = mgr.getStats();
    expect(stats.totalExperiments).toBe(1);
    expect(stats.runningExperiments).toBe(1);
    expect(stats.totalAssignments).toBe(1);
    expect(stats.totalMetrics).toBe(1);
  });

  // ── Destroy ─────────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    mgr.createExperiment({
      name: 'e',
      autoStart: true,
      variants: [{ name: 'a', weight: 1, config: {} }, { name: 'b', weight: 1, config: {} }],
    });
    mgr.destroy();
    expect(mgr.getStats().totalExperiments).toBe(0);
  });
});
