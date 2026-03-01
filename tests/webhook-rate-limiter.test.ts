import { WebhookRateLimiter } from '../src/webhook-rate-limiter';

describe('WebhookRateLimiter', () => {
  let limiter: WebhookRateLimiter;

  beforeEach(() => {
    limiter = new WebhookRateLimiter({ maxPerMinute: 5 });
  });

  afterEach(() => {
    limiter.destroy();
  });

  // ── Core Operations ────────────────────────────────────────────────

  describe('canDeliver', () => {
    it('allows delivery under limit', () => {
      expect(limiter.canDeliver('https://a.com/hook')).toBe(true);
    });

    it('blocks delivery at limit', () => {
      const url = 'https://a.com/hook';
      for (let i = 0; i < 5; i++) limiter.recordDelivery(url);
      expect(limiter.canDeliver(url)).toBe(false);
    });
  });

  describe('recordDelivery', () => {
    it('records successful delivery', () => {
      expect(limiter.recordDelivery('https://a.com')).toBe(true);
      expect(limiter.getStatus('https://a.com').currentCount).toBe(1);
    });

    it('rejects at limit', () => {
      const url = 'https://b.com';
      for (let i = 0; i < 5; i++) limiter.recordDelivery(url);
      expect(limiter.recordDelivery(url)).toBe(false);
    });

    it('tracks URLs independently', () => {
      for (let i = 0; i < 5; i++) limiter.recordDelivery('https://a.com');
      expect(limiter.recordDelivery('https://b.com')).toBe(true);
    });
  });

  describe('getRetryAfter', () => {
    it('returns 0 when not blocked', () => {
      expect(limiter.getRetryAfter('https://a.com')).toBe(0);
    });

    it('returns positive when blocked', () => {
      const url = 'https://a.com';
      for (let i = 0; i < 5; i++) limiter.recordDelivery(url);
      const retryAfter = limiter.getRetryAfter(url);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60000);
    });
  });

  // ── Overrides ──────────────────────────────────────────────────────

  describe('overrides', () => {
    it('sets per-URL override', () => {
      limiter.setOverride('https://vip.com', 100);
      const status = limiter.getStatus('https://vip.com');
      expect(status.maxPerMinute).toBe(100);
    });

    it('rejects non-positive override', () => {
      expect(() => limiter.setOverride('https://a.com', 0)).toThrow();
    });

    it('removes an override', () => {
      limiter.setOverride('https://a.com', 100);
      expect(limiter.removeOverride('https://a.com')).toBe(true);
      expect(limiter.removeOverride('https://unknown.com')).toBe(false);
    });

    it('lists overrides', () => {
      limiter.setOverride('https://a.com', 10);
      limiter.setOverride('https://b.com', 20);
      expect(limiter.getOverrides()).toHaveLength(2);
    });

    it('uses override limit instead of default', () => {
      limiter.setOverride('https://limited.com', 2);
      limiter.recordDelivery('https://limited.com');
      limiter.recordDelivery('https://limited.com');
      expect(limiter.canDeliver('https://limited.com')).toBe(false);
    });
  });

  // ── Query ──────────────────────────────────────────────────────────

  describe('query', () => {
    it('gets status for unknown URL', () => {
      const status = limiter.getStatus('https://unknown.com');
      expect(status.currentCount).toBe(0);
      expect(status.blocked).toBe(false);
    });

    it('resets URL window', () => {
      const url = 'https://a.com';
      for (let i = 0; i < 5; i++) limiter.recordDelivery(url);
      expect(limiter.resetUrl(url)).toBe(true);
      expect(limiter.canDeliver(url)).toBe(true);
    });

    it('returns false for unknown URL reset', () => {
      expect(limiter.resetUrl('https://unknown.com')).toBe(false);
    });

    it('removes a URL', () => {
      limiter.recordDelivery('https://a.com');
      expect(limiter.removeUrl('https://a.com')).toBe(true);
      expect(limiter.removeUrl('https://a.com')).toBe(false);
    });

    it('gets blocked URLs', () => {
      const url = 'https://blocked.com';
      for (let i = 0; i < 5; i++) limiter.recordDelivery(url);
      limiter.recordDelivery('https://ok.com');
      const blocked = limiter.getBlockedUrls();
      expect(blocked).toHaveLength(1);
      expect(blocked[0].url).toBe(url);
    });
  });

  // ── Stats & Destroy ────────────────────────────────────────────────

  describe('stats and destroy', () => {
    it('tracks comprehensive stats', () => {
      limiter.recordDelivery('https://a.com');
      limiter.recordDelivery('https://a.com');
      for (let i = 0; i < 5; i++) limiter.recordDelivery('https://b.com');
      limiter.recordDelivery('https://b.com'); // blocked

      const stats = limiter.getStats();
      expect(stats.trackedUrls).toBe(2);
      expect(stats.totalDeliveries).toBe(7);
      expect(stats.totalBlocked).toBe(1);
    });

    it('tracks overrides in stats', () => {
      limiter.setOverride('https://a.com', 10);
      expect(limiter.getStats().overrideCount).toBe(1);
    });

    it('destroy resets everything', () => {
      limiter.recordDelivery('https://a.com');
      limiter.destroy();
      expect(limiter.getStats().trackedUrls).toBe(0);
      expect(limiter.getStats().totalDeliveries).toBe(0);
    });
  });
});
