import { RateLimiter } from '../src/rate-limiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter?.destroy();
  });

  describe('with limit', () => {
    beforeEach(() => {
      limiter = new RateLimiter(5); // 5 calls/min
    });

    it('should allow calls under the limit', () => {
      const result = limiter.check('key1');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4); // 5 - 0 - 1
    });

    it('should deny after limit exceeded', () => {
      for (let i = 0; i < 5; i++) {
        limiter.check('key1');
        limiter.record('key1');
      }

      const result = limiter.check('key1');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('rate_limited');
      expect(result.remaining).toBe(0);
    });

    it('should track keys independently', () => {
      for (let i = 0; i < 5; i++) {
        limiter.check('key1');
        limiter.record('key1');
      }

      // key1 is rate limited
      expect(limiter.check('key1').allowed).toBe(false);

      // key2 should still be fine
      expect(limiter.check('key2').allowed).toBe(true);
    });
  });

  describe('unlimited (0)', () => {
    beforeEach(() => {
      limiter = new RateLimiter(0);
    });

    it('should always allow when limit is 0', () => {
      for (let i = 0; i < 1000; i++) {
        limiter.record('key1');
      }
      const result = limiter.check('key1');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(Infinity);
    });
  });
});
