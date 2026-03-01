import { RateLimitSlidingWindow } from '../src/sliding-window';

describe('RateLimitSlidingWindow', () => {
  let limiter: RateLimitSlidingWindow;

  beforeEach(() => {
    limiter = new RateLimitSlidingWindow({ windowMs: 1000, maxRequests: 5, subWindows: 5 });
  });

  afterEach(() => {
    limiter.destroy();
  });

  // ── Basic Checks ─────────────────────────────────────────────────────

  it('allows requests within limit', () => {
    const r = limiter.check('key1');
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4);
    expect(r.limit).toBe(5);
    expect(r.currentCount).toBe(1);
  });

  it('denies requests over limit', () => {
    for (let i = 0; i < 5; i++) {
      expect(limiter.check('key1').allowed).toBe(true);
    }
    const r = limiter.check('key1');
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.retryAfterMs).toBeGreaterThanOrEqual(0);
  });

  it('tracks per-key limits independently', () => {
    for (let i = 0; i < 5; i++) limiter.check('key1');
    expect(limiter.check('key1').allowed).toBe(false);
    expect(limiter.check('key2').allowed).toBe(true);
  });

  it('decrements remaining correctly', () => {
    expect(limiter.check('k').remaining).toBe(4);
    expect(limiter.check('k').remaining).toBe(3);
    expect(limiter.check('k').remaining).toBe(2);
    expect(limiter.check('k').remaining).toBe(1);
    expect(limiter.check('k').remaining).toBe(0);
  });

  // ── Peek ─────────────────────────────────────────────────────────────

  it('peeks without consuming a token', () => {
    const p1 = limiter.peek('key1');
    expect(p1.allowed).toBe(true);
    expect(p1.remaining).toBe(5);

    limiter.check('key1');
    const p2 = limiter.peek('key1');
    expect(p2.remaining).toBe(4);
  });

  it('peeks unknown key as fully available', () => {
    const p = limiter.peek('unknown');
    expect(p.allowed).toBe(true);
    expect(p.remaining).toBe(5);
  });

  // ── Reset ────────────────────────────────────────────────────────────

  it('resets a key', () => {
    for (let i = 0; i < 5; i++) limiter.check('key1');
    expect(limiter.check('key1').allowed).toBe(false);
    limiter.resetKey('key1');
    expect(limiter.check('key1').allowed).toBe(true);
  });

  // ── Key Usage ────────────────────────────────────────────────────────

  it('returns key usage', () => {
    limiter.check('k');
    limiter.check('k');
    const usage = limiter.getKeyUsage('k');
    expect(usage).not.toBeNull();
    expect(usage!.count).toBe(2);
    expect(usage!.remaining).toBe(3);
  });

  it('returns null for unknown key', () => {
    expect(limiter.getKeyUsage('nope')).toBeNull();
  });

  // ── Window Sliding ───────────────────────────────────────────────────

  it('allows requests after window expires', async () => {
    const fast = new RateLimitSlidingWindow({ windowMs: 50, maxRequests: 2, subWindows: 2 });
    fast.check('k');
    fast.check('k');
    expect(fast.check('k').allowed).toBe(false);

    // Wait for window to expire
    await new Promise(r => setTimeout(r, 60));
    expect(fast.check('k').allowed).toBe(true);
    fast.destroy();
  });

  // ── Eviction ─────────────────────────────────────────────────────────

  it('evicts oldest key when max keys reached', () => {
    const small = new RateLimitSlidingWindow({ maxKeys: 2, windowMs: 1000, maxRequests: 10 });
    small.check('key1');
    small.check('key2');
    small.check('key3'); // Should evict key1
    expect(small.getKeyUsage('key1')).toBeNull();
    expect(small.getKeyUsage('key3')).not.toBeNull();
    small.destroy();
  });

  // ── Stats ────────────────────────────────────────────────────────────

  it('tracks stats', () => {
    limiter.check('k');
    limiter.check('k');
    for (let i = 0; i < 3; i++) limiter.check('k');
    limiter.check('k'); // denied
    const stats = limiter.getStats();
    expect(stats.totalChecks).toBe(6);
    expect(stats.totalAllowed).toBe(5);
    expect(stats.totalDenied).toBe(1);
    expect(stats.trackedKeys).toBe(1);
    expect(stats.hitRate).toBeGreaterThan(0);
  });

  // ── Destroy ──────────────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    limiter.check('k');
    limiter.destroy();
    expect(limiter.getStats().totalChecks).toBe(0);
    expect(limiter.getStats().trackedKeys).toBe(0);
  });
});
