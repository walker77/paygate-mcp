import { UsageQuotaAlert } from '../src/usage-quota-alert';

describe('UsageQuotaAlert', () => {
  let alerter: UsageQuotaAlert;

  beforeEach(() => {
    alerter = new UsageQuotaAlert();
  });

  afterEach(() => {
    alerter.destroy();
  });

  // ── Threshold Management ───────────────────────────────────────────

  describe('threshold management', () => {
    it('defines a threshold', () => {
      const t = alerter.defineThreshold({ name: 'warning', percentage: 80 });
      expect(t.id).toMatch(/^qt_/);
      expect(t.name).toBe('warning');
      expect(t.percentage).toBe(80);
    });

    it('rejects empty name', () => {
      expect(() => alerter.defineThreshold({ name: '', percentage: 50 })).toThrow();
    });

    it('rejects invalid percentage', () => {
      expect(() => alerter.defineThreshold({ name: 'bad', percentage: 0 })).toThrow();
      expect(() => alerter.defineThreshold({ name: 'bad', percentage: 101 })).toThrow();
    });

    it('sorts thresholds by percentage', () => {
      alerter.defineThreshold({ name: 'critical', percentage: 95 });
      alerter.defineThreshold({ name: 'warning', percentage: 80 });
      alerter.defineThreshold({ name: 'info', percentage: 50 });
      const list = alerter.listThresholds();
      expect(list[0].name).toBe('info');
      expect(list[1].name).toBe('warning');
      expect(list[2].name).toBe('critical');
    });

    it('removes a threshold', () => {
      const t = alerter.defineThreshold({ name: 'temp', percentage: 60 });
      expect(alerter.removeThreshold(t.id)).toBe(true);
      expect(alerter.listThresholds()).toHaveLength(0);
    });

    it('returns false for unknown threshold removal', () => {
      expect(alerter.removeThreshold('qt_999')).toBe(false);
    });
  });

  // ── Quota & Usage ──────────────────────────────────────────────────

  describe('quota management', () => {
    it('sets and gets quota status', () => {
      alerter.setQuota('k1', 1000);
      const status = alerter.getKeyStatus('k1');
      expect(status).not.toBeNull();
      expect(status!.quota).toBe(1000);
      expect(status!.used).toBe(0);
      expect(status!.remaining).toBe(1000);
    });

    it('rejects non-positive quota', () => {
      expect(() => alerter.setQuota('k1', 0)).toThrow();
      expect(() => alerter.setQuota('k1', -5)).toThrow();
    });

    it('returns null for unknown key', () => {
      expect(alerter.getKeyStatus('unknown')).toBeNull();
    });

    it('records usage and updates status', () => {
      alerter.setQuota('k1', 1000);
      alerter.recordUsage('k1', 400);
      const status = alerter.getKeyStatus('k1');
      expect(status!.used).toBe(400);
      expect(status!.remaining).toBe(600);
      expect(status!.percentUsed).toBe(40);
    });

    it('returns empty for unknown key recordUsage', () => {
      expect(alerter.recordUsage('nope', 100)).toEqual([]);
    });

    it('resets usage', () => {
      alerter.setQuota('k1', 1000);
      alerter.recordUsage('k1', 500);
      expect(alerter.resetUsage('k1')).toBe(true);
      expect(alerter.getKeyStatus('k1')!.used).toBe(0);
    });

    it('returns false for unknown key reset', () => {
      expect(alerter.resetUsage('nope')).toBe(false);
    });
  });

  // ── Alert Generation ───────────────────────────────────────────────

  describe('alert generation', () => {
    it('generates alert when threshold crossed', () => {
      alerter.defineThreshold({ name: 'warning', percentage: 80 });
      alerter.setQuota('k1', 100);
      const alerts = alerter.recordUsage('k1', 85);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].thresholdName).toBe('warning');
      expect(alerts[0].key).toBe('k1');
      expect(alerts[0].acknowledged).toBe(false);
    });

    it('does not re-trigger same threshold', () => {
      alerter.defineThreshold({ name: 'warning', percentage: 80 });
      alerter.setQuota('k1', 100);
      alerter.recordUsage('k1', 85);
      const alerts2 = alerter.recordUsage('k1', 5);
      expect(alerts2).toHaveLength(0);
    });

    it('triggers multiple thresholds at once', () => {
      alerter.defineThreshold({ name: 'warning', percentage: 80 });
      alerter.defineThreshold({ name: 'critical', percentage: 95 });
      alerter.setQuota('k1', 100);
      const alerts = alerter.recordUsage('k1', 97);
      expect(alerts).toHaveLength(2);
    });

    it('re-evaluates thresholds on quota change', () => {
      alerter.defineThreshold({ name: 'warning', percentage: 80 });
      alerter.setQuota('k1', 1000);
      alerter.recordUsage('k1', 850);
      // Now lower the quota so 850/500 = 170%
      alerter.setQuota('k1', 500);
      const status = alerter.getKeyStatus('k1');
      expect(status!.crossedThresholds).toHaveLength(1);
    });
  });

  // ── Alert Management ───────────────────────────────────────────────

  describe('alert management', () => {
    beforeEach(() => {
      alerter.defineThreshold({ name: 'warning', percentage: 80 });
      alerter.setQuota('k1', 100);
      alerter.setQuota('k2', 100);
      alerter.recordUsage('k1', 85);
      alerter.recordUsage('k2', 90);
    });

    it('gets all alerts', () => {
      expect(alerter.getAlerts()).toHaveLength(2);
    });

    it('filters by key', () => {
      expect(alerter.getAlerts({ key: 'k1' })).toHaveLength(1);
    });

    it('acknowledges an alert', () => {
      const alerts = alerter.getAlerts();
      expect(alerter.acknowledgeAlert(alerts[0].id)).toBe(true);
      expect(alerter.getAlerts({ unacknowledgedOnly: true })).toHaveLength(1);
    });

    it('returns false for unknown alert acknowledgement', () => {
      expect(alerter.acknowledgeAlert('qa_999')).toBe(false);
    });

    it('acknowledges all for key', () => {
      const count = alerter.acknowledgeAllForKey('k1');
      expect(count).toBe(1);
      expect(alerter.getAlerts({ key: 'k1', unacknowledgedOnly: true })).toHaveLength(0);
    });
  });

  // ── Max Keys ───────────────────────────────────────────────────────

  describe('max keys', () => {
    it('rejects when max keys reached', () => {
      const small = new UsageQuotaAlert({ maxKeys: 2 });
      small.setQuota('k1', 100);
      small.setQuota('k2', 100);
      expect(() => small.setQuota('k3', 100)).toThrow(/Maximum/);
      small.destroy();
    });
  });

  // ── Stats & Destroy ────────────────────────────────────────────────

  describe('stats and destroy', () => {
    it('tracks comprehensive stats', () => {
      alerter.defineThreshold({ name: 'warning', percentage: 80 });
      alerter.setQuota('k1', 100);
      alerter.recordUsage('k1', 85);

      const stats = alerter.getStats();
      expect(stats.trackedKeys).toBe(1);
      expect(stats.totalThresholds).toBe(1);
      expect(stats.totalAlerts).toBe(1);
      expect(stats.unacknowledgedAlerts).toBe(1);
      expect(stats.topAlertedKeys).toHaveLength(1);
    });

    it('destroy resets everything', () => {
      alerter.defineThreshold({ name: 'x', percentage: 50 });
      alerter.setQuota('k1', 100);
      alerter.destroy();
      expect(alerter.getStats().trackedKeys).toBe(0);
      expect(alerter.getStats().totalThresholds).toBe(0);
    });
  });
});
