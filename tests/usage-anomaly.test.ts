import { UsageAnomalyDetector } from '../src/usage-anomaly';

describe('UsageAnomalyDetector', () => {
  let detector: UsageAnomalyDetector;

  beforeEach(() => {
    detector = new UsageAnomalyDetector({ windowSize: 10, zScoreThreshold: 2.0 });
  });

  afterEach(() => {
    detector.destroy();
  });

  // ── Recording ───────────────────────────────────────────────────

  describe('recording', () => {
    it('records usage and returns result', () => {
      const result = detector.recordUsage('k1', 100);
      expect(result.key).toBe('k1');
      expect(result.value).toBe(100);
      expect(result.anomaly).toBe(false);
      expect(result.threshold).toBe(2.0);
    });

    it('does not flag anomaly with insufficient data', () => {
      detector.recordUsage('k1', 100);
      detector.recordUsage('k1', 100);
      const result = detector.recordUsage('k1', 500);
      // Only 2 points in history, need >= 3
      expect(result.anomaly).toBe(false);
    });

    it('detects anomaly on spike after baseline', () => {
      // Build baseline with slight variation (stdDev must be > 0)
      const base = [98, 102, 99, 101, 100, 103, 97, 101, 99, 100];
      for (const v of base) {
        detector.recordUsage('k1', v);
      }

      // Large spike
      const result = detector.recordUsage('k1', 1000);
      expect(result.anomaly).toBe(true);
      expect(result.zScore).toBeGreaterThan(2.0);
    });

    it('does not flag normal variation', () => {
      for (let i = 0; i < 10; i++) {
        detector.recordUsage('k1', 95 + Math.random() * 10);
      }
      const result = detector.recordUsage('k1', 105);
      expect(result.anomaly).toBe(false);
    });

    it('tracks per-key independently', () => {
      const base1 = [98, 102, 99, 101, 100, 103, 97, 101, 99, 100];
      const base2 = [480, 520, 490, 510, 500, 530, 470, 510, 490, 500];
      for (let i = 0; i < 10; i++) {
        detector.recordUsage('k1', base1[i]);
        detector.recordUsage('k2', base2[i]);
      }

      const r1 = detector.recordUsage('k1', 1000);  // huge spike on tight baseline
      const r2 = detector.recordUsage('k2', 510);    // within normal range of wide baseline

      expect(r1.anomaly).toBe(true);
      expect(r2.anomaly).toBe(false);
    });
  });

  // ── Eviction ────────────────────────────────────────────────────

  describe('key eviction', () => {
    it('evicts oldest key when max reached', () => {
      const small = new UsageAnomalyDetector({ maxKeys: 3 });
      small.recordUsage('k1', 10);
      small.recordUsage('k2', 20);
      small.recordUsage('k3', 30);
      small.recordUsage('k4', 40);

      // k1 should have been evicted
      expect(small.getKeyBaseline('k1')).toBeNull();
      expect(small.getKeyBaseline('k4')).not.toBeNull();
      small.destroy();
    });
  });

  // ── Events ──────────────────────────────────────────────────────

  describe('anomaly events', () => {
    it('creates event on anomaly detection', () => {
      const base = [98, 102, 99, 101, 100, 103, 97, 101, 99, 100];
      for (const v of base) detector.recordUsage('k1', v);
      detector.recordUsage('k1', 1000);

      const events = detector.getEvents();
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].key).toBe('k1');
      expect(events[0].acknowledged).toBe(false);
    });

    it('filters events by key', () => {
      const base = [98, 102, 99, 101, 100, 103, 97, 101, 99, 100];
      for (const v of base) {
        detector.recordUsage('k1', v);
        detector.recordUsage('k2', v);
      }
      detector.recordUsage('k1', 1000);
      detector.recordUsage('k2', 1000);

      const k1Events = detector.getEvents({ key: 'k1' });
      expect(k1Events.every(e => e.key === 'k1')).toBe(true);
    });

    it('filters unacknowledged only', () => {
      const base = [98, 102, 99, 101, 100, 103, 97, 101, 99, 100];
      for (const v of base) detector.recordUsage('k1', v);
      detector.recordUsage('k1', 1000);

      const events = detector.getEvents();
      detector.acknowledgeEvent(events[0].id);

      const unacked = detector.getEvents({ unacknowledgedOnly: true });
      expect(unacked).toHaveLength(0);
    });

    it('acknowledges single event', () => {
      const base = [98, 102, 99, 101, 100, 103, 97, 101, 99, 100];
      for (const v of base) detector.recordUsage('k1', v);
      detector.recordUsage('k1', 1000);

      const events = detector.getEvents();
      expect(detector.acknowledgeEvent(events[0].id)).toBe(true);
      expect(detector.acknowledgeEvent('anom_999')).toBe(false);
    });

    it('acknowledges all events for key', () => {
      const base = [98, 102, 99, 101, 100, 103, 97, 101, 99, 100];
      for (const v of base) detector.recordUsage('k1', v);
      detector.recordUsage('k1', 1000);
      detector.recordUsage('k1', 2000);

      const count = detector.acknowledgeAllForKey('k1');
      expect(count).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Baseline ────────────────────────────────────────────────────

  describe('baseline', () => {
    it('returns baseline stats for key', () => {
      const base = [98, 102, 99, 101, 100];
      for (const v of base) detector.recordUsage('k1', v);

      const baseline = detector.getKeyBaseline('k1');
      expect(baseline).not.toBeNull();
      expect(baseline!.mean).toBe(100);
      expect(baseline!.stdDev).toBeGreaterThanOrEqual(0);
      expect(baseline!.dataPoints).toBe(5);
    });

    it('returns null for unknown key', () => {
      expect(detector.getKeyBaseline('unknown')).toBeNull();
    });

    it('resets key baseline', () => {
      detector.recordUsage('k1', 100);
      expect(detector.resetKey('k1')).toBe(true);
      expect(detector.getKeyBaseline('k1')).toBeNull();
    });
  });

  // ── Stats & Destroy ─────────────────────────────────────────────

  describe('stats and destroy', () => {
    it('tracks comprehensive stats', () => {
      const base = [98, 102, 99, 101, 100, 103, 97, 101, 99, 100];
      for (const v of base) detector.recordUsage('k1', v);
      detector.recordUsage('k1', 1000);

      const stats = detector.getStats();
      expect(stats.trackedKeys).toBe(1);
      expect(stats.totalDataPoints).toBe(11);
      expect(stats.totalAnomalies).toBeGreaterThan(0);
      expect(stats.topAnomalyKeys.length).toBeGreaterThan(0);
    });

    it('destroy resets everything', () => {
      detector.recordUsage('k1', 100);
      detector.destroy();

      const stats = detector.getStats();
      expect(stats.trackedKeys).toBe(0);
      expect(stats.totalDataPoints).toBe(0);
    });
  });
});
