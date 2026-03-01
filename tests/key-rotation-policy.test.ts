import { APIKeyRotationPolicy } from '../src/key-rotation-policy';

describe('APIKeyRotationPolicy', () => {
  let rotator: APIKeyRotationPolicy;

  beforeEach(() => {
    rotator = new APIKeyRotationPolicy();
  });

  afterEach(() => {
    rotator.destroy();
  });

  // ── Policy Management ──────────────────────────────────────────

  describe('policy management', () => {
    it('defines a rotation policy', () => {
      const policy = rotator.definePolicy({
        name: 'standard',
        rotationIntervalMs: 90 * 24 * 60 * 60 * 1000,
      });
      expect(policy.id).toMatch(/^rp_/);
      expect(policy.name).toBe('standard');
    });

    it('validates required fields', () => {
      expect(() => rotator.definePolicy({ name: '', rotationIntervalMs: 1000 })).toThrow('name');
      expect(() => rotator.definePolicy({ name: 'x', rotationIntervalMs: 0 })).toThrow('positive');
    });

    it('prevents duplicate policy names', () => {
      rotator.definePolicy({ name: 'standard', rotationIntervalMs: 1000 });
      expect(() => rotator.definePolicy({ name: 'standard', rotationIntervalMs: 2000 })).toThrow('already exists');
    });

    it('gets a policy', () => {
      const policy = rotator.definePolicy({ name: 'test', rotationIntervalMs: 1000 });
      expect(rotator.getPolicy(policy.id)).not.toBeNull();
      expect(rotator.getPolicy('rp_999')).toBeNull();
    });

    it('lists and removes policies', () => {
      rotator.definePolicy({ name: 'p1', rotationIntervalMs: 1000 });
      const p2 = rotator.definePolicy({ name: 'p2', rotationIntervalMs: 2000 });
      expect(rotator.listPolicies()).toHaveLength(2);

      rotator.removePolicy(p2.id);
      expect(rotator.listPolicies()).toHaveLength(1);
    });
  });

  // ── Key Registration ──────────────────────────────────────────

  describe('key registration', () => {
    it('registers a key under a policy', () => {
      const policy = rotator.definePolicy({ name: 'std', rotationIntervalMs: 86400000 });
      const managed = rotator.registerKey('key_abc', policy.id);

      expect(managed.key).toBe('key_abc');
      expect(managed.policyId).toBe(policy.id);
      expect(managed.status).toBe('current');
      expect(managed.rotationCount).toBe(0);
    });

    it('rejects unknown policy', () => {
      expect(() => rotator.registerKey('key_abc', 'rp_999')).toThrow('not found');
    });

    it('unregisters a key', () => {
      const policy = rotator.definePolicy({ name: 'std', rotationIntervalMs: 86400000 });
      rotator.registerKey('key_abc', policy.id);
      expect(rotator.unregisterKey('key_abc')).toBe(true);
      expect(rotator.getKey('key_abc')).toBeNull();
    });
  });

  // ── Key Status ────────────────────────────────────────────────

  describe('key status', () => {
    it('key is current when within rotation interval', () => {
      const policy = rotator.definePolicy({ name: 'std', rotationIntervalMs: 86400000 });
      rotator.registerKey('k1', policy.id);
      const managed = rotator.getKey('k1');
      expect(managed!.status).toBe('current');
    });

    it('key is due when past rotation interval with grace period', async () => {
      const policy = rotator.definePolicy({
        name: 'fast',
        rotationIntervalMs: 50,
        gracePeriodMs: 5000,
      });
      rotator.registerKey('k1', policy.id);

      await new Promise(r => setTimeout(r, 80));

      const managed = rotator.getKey('k1');
      expect(managed!.status).toBe('due');
    });

    it('key is due when past rotation interval without grace period', async () => {
      const policy = rotator.definePolicy({
        name: 'fast',
        rotationIntervalMs: 50,
      });
      rotator.registerKey('k1', policy.id);

      await new Promise(r => setTimeout(r, 80));

      const managed = rotator.getKey('k1');
      expect(managed!.status).toBe('due');
    });
  });

  // ── Rotation Recording ────────────────────────────────────────

  describe('rotation recording', () => {
    it('records a rotation', () => {
      const policy = rotator.definePolicy({ name: 'std', rotationIntervalMs: 86400000 });
      rotator.registerKey('key_old', policy.id);

      const event = rotator.recordRotation('key_old', 'key_new');
      expect(event).not.toBeNull();
      expect(event!.oldKey).toBe('key_old');
      expect(event!.key).toBe('key_new');

      // Old key should be gone, new key should exist
      expect(rotator.getKey('key_old')).toBeNull();
      const managed = rotator.getKey('key_new');
      expect(managed!.rotationCount).toBe(1);
      expect(managed!.status).toBe('current');
    });

    it('records rotation without new key', () => {
      const policy = rotator.definePolicy({ name: 'std', rotationIntervalMs: 86400000 });
      rotator.registerKey('k1', policy.id);

      const event = rotator.recordRotation('k1');
      expect(event).not.toBeNull();
      expect(event!.key).toBe('k1');

      const managed = rotator.getKey('k1');
      expect(managed!.rotationCount).toBe(1);
    });

    it('returns null for unknown key', () => {
      expect(rotator.recordRotation('unknown')).toBeNull();
    });
  });

  // ── Due & Upcoming ────────────────────────────────────────────

  describe('due and upcoming', () => {
    it('gets keys due for rotation', async () => {
      const policy = rotator.definePolicy({ name: 'fast', rotationIntervalMs: 50 });
      rotator.registerKey('k1', policy.id);
      rotator.registerKey('k2', policy.id);

      await new Promise(r => setTimeout(r, 80));

      const due = rotator.getKeysDueForRotation();
      expect(due).toHaveLength(2);
    });

    it('gets keys with upcoming rotation', () => {
      const policy = rotator.definePolicy({
        name: 'std',
        rotationIntervalMs: 5000,
        warnBeforeMs: 10000,
      });
      rotator.registerKey('k1', policy.id);

      // Within warn period since rotationInterval < warnBefore
      const upcoming = rotator.getKeysUpcomingRotation();
      expect(upcoming).toHaveLength(1);
    });
  });

  // ── Rotation History ──────────────────────────────────────────

  describe('rotation history', () => {
    it('tracks rotation events', () => {
      const policy = rotator.definePolicy({ name: 'std', rotationIntervalMs: 86400000 });
      rotator.registerKey('k1', policy.id);
      rotator.recordRotation('k1');
      rotator.recordRotation('k1');

      const history = rotator.getRotationHistory('k1');
      expect(history).toHaveLength(2);
    });
  });

  // ── Stats & Destroy ─────────────────────────────────────────────

  describe('stats and destroy', () => {
    it('tracks comprehensive stats', () => {
      const policy = rotator.definePolicy({ name: 'std', rotationIntervalMs: 86400000 });
      rotator.registerKey('k1', policy.id);
      rotator.registerKey('k2', policy.id);
      rotator.recordRotation('k1');

      const stats = rotator.getStats();
      expect(stats.totalPolicies).toBe(1);
      expect(stats.totalManagedKeys).toBe(2);
      expect(stats.totalRotations).toBe(1);
    });

    it('destroy resets everything', () => {
      const policy = rotator.definePolicy({ name: 'std', rotationIntervalMs: 86400000 });
      rotator.registerKey('k1', policy.id);
      rotator.destroy();

      expect(rotator.getStats().totalPolicies).toBe(0);
      expect(rotator.getStats().totalManagedKeys).toBe(0);
    });
  });
});
