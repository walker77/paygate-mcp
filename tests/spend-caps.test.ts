/**
 * Tests for SpendCapManager — server-wide and per-key spend caps with auto-suspend.
 */

import { SpendCapManager } from '../src/spend-caps';
import { SpendCapConfig } from '../src/types';

function makeConfig(overrides?: Partial<SpendCapConfig>): SpendCapConfig {
  return {
    breachAction: 'deny',
    serverDailyCreditCap: 0,
    serverDailyCallCap: 0,
    autoResumeAfterSeconds: 0,
    ...overrides,
  };
}

describe('SpendCapManager', () => {
  describe('constructor', () => {
    it('should create with default config', () => {
      const mgr = new SpendCapManager(makeConfig());
      expect(mgr.currentConfig.breachAction).toBe('deny');
      expect(mgr.suspendedCount).toBe(0);
    });

    it('should accept custom config', () => {
      const mgr = new SpendCapManager(makeConfig({
        breachAction: 'suspend',
        serverDailyCreditCap: 1000,
        serverDailyCallCap: 500,
        autoResumeAfterSeconds: 300,
      }));
      const config = mgr.currentConfig;
      expect(config.breachAction).toBe('suspend');
      expect(config.serverDailyCreditCap).toBe(1000);
      expect(config.serverDailyCallCap).toBe(500);
      expect(config.autoResumeAfterSeconds).toBe(300);
    });
  });

  describe('updateConfig', () => {
    it('should update config at runtime', () => {
      const mgr = new SpendCapManager(makeConfig());
      mgr.updateConfig(makeConfig({ serverDailyCreditCap: 2000 }));
      expect(mgr.currentConfig.serverDailyCreditCap).toBe(2000);
    });
  });

  describe('checkServerCap — credit cap', () => {
    it('should allow when no cap set (0)', () => {
      const mgr = new SpendCapManager(makeConfig({ serverDailyCreditCap: 0 }));
      const result = mgr.checkServerCap(1000);
      expect(result.allowed).toBe(true);
    });

    it('should allow when under cap', () => {
      const mgr = new SpendCapManager(makeConfig({ serverDailyCreditCap: 100 }));
      const result = mgr.checkServerCap(50);
      expect(result.allowed).toBe(true);
    });

    it('should deny when over cap', () => {
      const mgr = new SpendCapManager(makeConfig({ serverDailyCreditCap: 100 }));
      mgr.record('key1', 80);
      const result = mgr.checkServerCap(30);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('server_daily_credit_cap');
    });

    it('should deny exactly at cap boundary', () => {
      const mgr = new SpendCapManager(makeConfig({ serverDailyCreditCap: 100 }));
      mgr.record('key1', 100);
      const result = mgr.checkServerCap(1);
      expect(result.allowed).toBe(false);
    });
  });

  describe('checkServerCap — call cap', () => {
    it('should allow when no call cap set', () => {
      const mgr = new SpendCapManager(makeConfig({ serverDailyCallCap: 0 }));
      const result = mgr.checkServerCap(0);
      expect(result.allowed).toBe(true);
    });

    it('should allow when under call cap', () => {
      const mgr = new SpendCapManager(makeConfig({ serverDailyCallCap: 10 }));
      const result = mgr.checkServerCap(0);
      expect(result.allowed).toBe(true);
    });

    it('should deny when over call cap', () => {
      const mgr = new SpendCapManager(makeConfig({ serverDailyCallCap: 3 }));
      mgr.record('key1', 0);
      mgr.record('key1', 0);
      mgr.record('key1', 0);
      const result = mgr.checkServerCap(0);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('server_daily_call_cap');
    });
  });

  describe('checkHourlyCap', () => {
    it('should allow when no quota provided', () => {
      const mgr = new SpendCapManager(makeConfig());
      const result = mgr.checkHourlyCap('key1', 10, undefined);
      expect(result.allowed).toBe(true);
    });

    it('should allow when hourly limits are 0', () => {
      const mgr = new SpendCapManager(makeConfig());
      const result = mgr.checkHourlyCap('key1', 10, {
        dailyCallLimit: 100, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 0,
        hourlyCallLimit: 0, hourlyCreditLimit: 0,
      });
      expect(result.allowed).toBe(true);
    });

    it('should deny when hourly call limit exceeded', () => {
      const mgr = new SpendCapManager(makeConfig());
      // Record 5 calls
      for (let i = 0; i < 5; i++) mgr.record('key1', 1);
      const result = mgr.checkHourlyCap('key1', 1, {
        dailyCallLimit: 0, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 0,
        hourlyCallLimit: 5, hourlyCreditLimit: 0,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('hourly_call_cap');
    });

    it('should deny when hourly credit limit exceeded', () => {
      const mgr = new SpendCapManager(makeConfig());
      mgr.record('key1', 90);
      const result = mgr.checkHourlyCap('key1', 20, {
        dailyCallLimit: 0, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 0,
        hourlyCallLimit: 0, hourlyCreditLimit: 100,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('hourly_credit_cap');
    });

    it('should set shouldSuspend when breachAction is suspend', () => {
      const mgr = new SpendCapManager(makeConfig({ breachAction: 'suspend' }));
      for (let i = 0; i < 5; i++) mgr.record('key1', 1);
      const result = mgr.checkHourlyCap('key1', 1, {
        dailyCallLimit: 0, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 0,
        hourlyCallLimit: 5, hourlyCreditLimit: 0,
      });
      expect(result.allowed).toBe(false);
      expect(result.shouldSuspend).toBe(true);
    });

    it('should NOT set shouldSuspend when breachAction is deny', () => {
      const mgr = new SpendCapManager(makeConfig({ breachAction: 'deny' }));
      for (let i = 0; i < 5; i++) mgr.record('key1', 1);
      const result = mgr.checkHourlyCap('key1', 1, {
        dailyCallLimit: 0, monthlyCallLimit: 0, dailyCreditLimit: 0, monthlyCreditLimit: 0,
        hourlyCallLimit: 5, hourlyCreditLimit: 0,
      });
      expect(result.allowed).toBe(false);
      expect(result.shouldSuspend).toBeFalsy();
    });
  });

  describe('auto-suspend / auto-resume', () => {
    it('should auto-suspend a key', () => {
      const mgr = new SpendCapManager(makeConfig({ breachAction: 'suspend' }));
      const onSuspend = jest.fn();
      mgr.onAutoSuspend = onSuspend;

      mgr.autoSuspendKey('key1', 'test reason');
      expect(mgr.isAutoSuspended('key1')).toBe(true);
      expect(mgr.suspendedCount).toBe(1);
      expect(onSuspend).toHaveBeenCalledWith('key1', 'test reason');
    });

    it('should report non-suspended key correctly', () => {
      const mgr = new SpendCapManager(makeConfig());
      expect(mgr.isAutoSuspended('key1')).toBe(false);
    });

    it('should auto-resume after cooldown', () => {
      const mgr = new SpendCapManager(makeConfig({ autoResumeAfterSeconds: 1 }));
      const onResume = jest.fn();
      mgr.onAutoResume = onResume;

      // Manually set suspend time in the past
      (mgr as any).suspendedAt.set('key1', Date.now() - 2000);

      expect(mgr.isAutoSuspended('key1')).toBe(false);
      expect(onResume).toHaveBeenCalledWith('key1');
      expect(mgr.suspendedCount).toBe(0);
    });

    it('should stay suspended before cooldown expires', () => {
      const mgr = new SpendCapManager(makeConfig({ autoResumeAfterSeconds: 60 }));
      mgr.autoSuspendKey('key1', 'test');
      expect(mgr.isAutoSuspended('key1')).toBe(true);
    });

    it('should stay suspended indefinitely when autoResume is 0', () => {
      const mgr = new SpendCapManager(makeConfig({ autoResumeAfterSeconds: 0 }));
      mgr.autoSuspendKey('key1', 'test');
      expect(mgr.isAutoSuspended('key1')).toBe(true);
    });

    it('should clear auto-suspend manually', () => {
      const mgr = new SpendCapManager(makeConfig());
      mgr.autoSuspendKey('key1', 'test');
      expect(mgr.isAutoSuspended('key1')).toBe(true);
      const cleared = mgr.clearAutoSuspend('key1');
      expect(cleared).toBe(true);
      expect(mgr.isAutoSuspended('key1')).toBe(false);
    });

    it('should return false when clearing non-existent suspend', () => {
      const mgr = new SpendCapManager(makeConfig());
      const cleared = mgr.clearAutoSuspend('nonexistent');
      expect(cleared).toBe(false);
    });
  });

  describe('getAutoSuspendStatus', () => {
    it('should return not suspended for clean key', () => {
      const mgr = new SpendCapManager(makeConfig());
      const status = mgr.getAutoSuspendStatus('key1');
      expect(status.suspended).toBe(false);
      expect(status.suspendedAt).toBeUndefined();
    });

    it('should return suspended with autoResumeIn', () => {
      const mgr = new SpendCapManager(makeConfig({ autoResumeAfterSeconds: 60 }));
      mgr.autoSuspendKey('key1', 'test');
      const status = mgr.getAutoSuspendStatus('key1');
      expect(status.suspended).toBe(true);
      expect(status.suspendedAt).toBeDefined();
      expect(status.autoResumeIn).toBeDefined();
      expect(status.autoResumeIn!).toBeGreaterThan(0);
      expect(status.autoResumeIn!).toBeLessThanOrEqual(60);
    });

    it('should not include autoResumeIn when manual-only', () => {
      const mgr = new SpendCapManager(makeConfig({ autoResumeAfterSeconds: 0 }));
      mgr.autoSuspendKey('key1', 'test');
      const status = mgr.getAutoSuspendStatus('key1');
      expect(status.suspended).toBe(true);
      expect(status.autoResumeIn).toBeUndefined();
    });
  });

  describe('record', () => {
    it('should track server-wide daily stats', () => {
      const mgr = new SpendCapManager(makeConfig());
      mgr.record('key1', 10);
      mgr.record('key2', 20);
      const stats = mgr.getServerStats();
      expect(stats.dailyCalls).toBe(2);
      expect(stats.dailyCredits).toBe(30);
    });

    it('should track per-key hourly stats', () => {
      const mgr = new SpendCapManager(makeConfig());
      mgr.record('key1', 10);
      mgr.record('key1', 5);
      const stats = mgr.getKeyHourlyStats('key1');
      expect(stats.hourlyCalls).toBe(2);
      expect(stats.hourlyCredits).toBe(15);
      expect(stats.hour).toBeTruthy();
    });

    it('should keep keys separate', () => {
      const mgr = new SpendCapManager(makeConfig());
      mgr.record('key1', 10);
      mgr.record('key2', 20);
      expect(mgr.getKeyHourlyStats('key1').hourlyCredits).toBe(10);
      expect(mgr.getKeyHourlyStats('key2').hourlyCredits).toBe(20);
    });
  });

  describe('recordBatch', () => {
    it('should record batch calls and credits', () => {
      const mgr = new SpendCapManager(makeConfig());
      mgr.recordBatch('key1', 5, 100);
      const server = mgr.getServerStats();
      expect(server.dailyCalls).toBe(5);
      expect(server.dailyCredits).toBe(100);
      const hourly = mgr.getKeyHourlyStats('key1');
      expect(hourly.hourlyCalls).toBe(5);
      expect(hourly.hourlyCredits).toBe(100);
    });
  });

  describe('getServerStats', () => {
    it('should return current server stats', () => {
      const mgr = new SpendCapManager(makeConfig({
        serverDailyCreditCap: 1000,
        serverDailyCallCap: 500,
      }));
      const stats = mgr.getServerStats();
      expect(stats.dailyCalls).toBe(0);
      expect(stats.dailyCredits).toBe(0);
      expect(stats.resetDay).toBeTruthy();
    });
  });

  describe('currentConfig', () => {
    it('should return a copy of config', () => {
      const mgr = new SpendCapManager(makeConfig({ serverDailyCreditCap: 999 }));
      const config = mgr.currentConfig;
      config.serverDailyCreditCap = 0; // mutate the copy
      expect(mgr.currentConfig.serverDailyCreditCap).toBe(999); // original unchanged
    });
  });

  describe('multiple keys and server cap interaction', () => {
    it('should aggregate across keys for server cap', () => {
      const mgr = new SpendCapManager(makeConfig({ serverDailyCreditCap: 100 }));
      mgr.record('key1', 40);
      mgr.record('key2', 40);
      mgr.record('key3', 15);

      // Should deny next call that would exceed 100
      const result = mgr.checkServerCap(10);
      expect(result.allowed).toBe(false);
    });

    it('should allow if within cap across multiple keys', () => {
      const mgr = new SpendCapManager(makeConfig({ serverDailyCreditCap: 100 }));
      mgr.record('key1', 30);
      mgr.record('key2', 30);
      const result = mgr.checkServerCap(30);
      expect(result.allowed).toBe(true);
    });
  });
});
