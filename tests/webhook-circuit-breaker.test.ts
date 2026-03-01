import { WebhookCircuitBreaker } from '../src/webhook-circuit-breaker';

describe('WebhookCircuitBreaker', () => {
  let cb: WebhookCircuitBreaker;

  beforeEach(() => {
    cb = new WebhookCircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 100, halfOpenSuccesses: 2 });
  });

  afterEach(() => {
    cb.destroy();
  });

  // ── Core Operations ────────────────────────────────────────────────

  describe('canSend', () => {
    it('allows sending for unknown URLs', () => {
      expect(cb.canSend('https://example.com/hook')).toBe(true);
    });

    it('allows sending for closed circuits', () => {
      cb.recordSuccess('https://example.com/hook');
      expect(cb.canSend('https://example.com/hook')).toBe(true);
    });

    it('blocks sending for open circuits', () => {
      const url = 'https://example.com/hook';
      cb.recordFailure(url);
      cb.recordFailure(url);
      cb.recordFailure(url);
      expect(cb.canSend(url)).toBe(false);
    });
  });

  describe('recordSuccess', () => {
    it('records success and keeps circuit closed', () => {
      const url = 'https://a.com/hook';
      cb.recordSuccess(url);
      const status = cb.getStatus(url);
      expect(status.state).toBe('closed');
      expect(status.successes).toBe(1);
    });

    it('closes circuit after enough half-open successes', async () => {
      const url = 'https://a.com/hook';
      cb.recordFailure(url);
      cb.recordFailure(url);
      cb.recordFailure(url);
      expect(cb.getStatus(url).state).toBe('open');

      // Wait for reset timeout to transition to half-open
      await new Promise(r => setTimeout(r, 120));
      expect(cb.canSend(url)).toBe(true); // triggers half-open transition
      expect(cb.getStatus(url).state).toBe('half_open');

      cb.recordSuccess(url);
      cb.recordSuccess(url);
      expect(cb.getStatus(url).state).toBe('closed');
    });
  });

  describe('recordFailure', () => {
    it('opens circuit after threshold consecutive failures', () => {
      const url = 'https://b.com/hook';
      cb.recordFailure(url);
      cb.recordFailure(url);
      expect(cb.getStatus(url).state).toBe('closed');
      cb.recordFailure(url);
      expect(cb.getStatus(url).state).toBe('open');
    });

    it('reopens circuit on half-open failure', async () => {
      const url = 'https://c.com/hook';
      cb.recordFailure(url);
      cb.recordFailure(url);
      cb.recordFailure(url);

      await new Promise(r => setTimeout(r, 120));
      cb.canSend(url); // transition to half-open

      cb.recordFailure(url);
      expect(cb.getStatus(url).state).toBe('open');
    });

    it('resets consecutive failures on success', () => {
      const url = 'https://d.com/hook';
      cb.recordFailure(url);
      cb.recordFailure(url);
      cb.recordSuccess(url); // resets consecutive
      cb.recordFailure(url);
      expect(cb.getStatus(url).state).toBe('closed'); // only 1 consecutive
    });
  });

  // ── Query ──────────────────────────────────────────────────────────

  describe('query', () => {
    it('returns default status for unknown URL', () => {
      const status = cb.getStatus('https://unknown.com');
      expect(status.state).toBe('closed');
      expect(status.failures).toBe(0);
    });

    it('gets open circuits', () => {
      cb.recordFailure('https://x.com');
      cb.recordFailure('https://x.com');
      cb.recordFailure('https://x.com');
      cb.recordSuccess('https://y.com');

      const open = cb.getOpenCircuits();
      expect(open).toHaveLength(1);
      expect(open[0].url).toBe('https://x.com');
    });

    it('resets a circuit', () => {
      const url = 'https://reset.com';
      cb.recordFailure(url);
      cb.recordFailure(url);
      cb.recordFailure(url);
      expect(cb.getStatus(url).state).toBe('open');

      cb.reset(url);
      expect(cb.getStatus(url).state).toBe('closed');
      expect(cb.canSend(url)).toBe(true);
    });

    it('returns false for resetting unknown URL', () => {
      expect(cb.reset('https://nope.com')).toBe(false);
    });

    it('removes a circuit', () => {
      cb.recordSuccess('https://rem.com');
      expect(cb.remove('https://rem.com')).toBe(true);
      expect(cb.remove('https://rem.com')).toBe(false);
    });
  });

  // ── Eviction ───────────────────────────────────────────────────────

  describe('eviction', () => {
    it('evicts oldest circuit at max capacity', () => {
      const small = new WebhookCircuitBreaker({ maxUrls: 2 });
      small.recordSuccess('https://first.com');
      small.recordSuccess('https://second.com');
      small.recordSuccess('https://third.com'); // evicts first
      expect(small.getStats().trackedUrls).toBe(2);
      small.destroy();
    });
  });

  // ── Stats & Destroy ────────────────────────────────────────────────

  describe('stats and destroy', () => {
    it('tracks comprehensive stats', () => {
      cb.recordSuccess('https://a.com');
      cb.recordSuccess('https://a.com');
      cb.recordFailure('https://b.com');
      cb.recordFailure('https://b.com');
      cb.recordFailure('https://b.com');

      const stats = cb.getStats();
      expect(stats.trackedUrls).toBe(2);
      expect(stats.totalSuccesses).toBe(2);
      expect(stats.totalFailures).toBe(3);
      expect(stats.closedCircuits).toBe(1);
      expect(stats.openCircuits).toBe(1);
    });

    it('destroy resets everything', () => {
      cb.recordSuccess('https://a.com');
      cb.destroy();
      expect(cb.getStats().trackedUrls).toBe(0);
      expect(cb.getStats().totalSuccesses).toBe(0);
    });
  });
});
