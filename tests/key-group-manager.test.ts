import { KeyGroupManager } from '../src/key-group-manager';

describe('KeyGroupManager', () => {
  let mgr: KeyGroupManager;

  beforeEach(() => {
    mgr = new KeyGroupManager();
  });

  afterEach(() => {
    mgr.destroy();
  });

  // ── Group Management ───────────────────────────────────────────────

  describe('group management', () => {
    it('creates a group', () => {
      const g = mgr.createGroup({ name: 'team-alpha', description: 'Alpha team' });
      expect(g.id).toMatch(/^grp_/);
      expect(g.name).toBe('team-alpha');
      expect(g.description).toBe('Alpha team');
      expect(g.members).toEqual([]);
    });

    it('rejects empty group name', () => {
      expect(() => mgr.createGroup({ name: '' })).toThrow();
    });

    it('rejects duplicate group names', () => {
      mgr.createGroup({ name: 'team-a' });
      expect(() => mgr.createGroup({ name: 'team-a' })).toThrow(/already exists/);
    });

    it('gets group by ID', () => {
      const g = mgr.createGroup({ name: 'test' });
      expect(mgr.getGroup(g.id)).not.toBeNull();
      expect(mgr.getGroup('grp_999')).toBeNull();
    });

    it('deletes a group', () => {
      const g = mgr.createGroup({ name: 'to-delete' });
      expect(mgr.deleteGroup(g.id)).toBe(true);
      expect(mgr.getGroup(g.id)).toBeNull();
      expect(mgr.deleteGroup(g.id)).toBe(false);
    });

    it('updates a group', () => {
      const g = mgr.createGroup({ name: 'old', description: 'old desc' });
      const updated = mgr.updateGroup(g.id, { name: 'new', description: 'new desc' });
      expect(updated!.name).toBe('new');
      expect(updated!.description).toBe('new desc');
    });

    it('returns null for unknown group update', () => {
      expect(mgr.updateGroup('grp_999', { name: 'x' })).toBeNull();
    });

    it('stores metadata', () => {
      const g = mgr.createGroup({ name: 'meta', metadata: { tier: 'premium' } });
      expect(g.metadata.tier).toBe('premium');
    });
  });

  // ── Membership ─────────────────────────────────────────────────────

  describe('membership', () => {
    let groupId: string;

    beforeEach(() => {
      const g = mgr.createGroup({ name: 'team' });
      groupId = g.id;
    });

    it('adds a key to a group', () => {
      expect(mgr.addKeyToGroup(groupId, 'key_1')).toBe(true);
      expect(mgr.getGroupMembers(groupId)).toEqual(['key_1']);
    });

    it('rejects duplicate key addition', () => {
      mgr.addKeyToGroup(groupId, 'key_1');
      expect(mgr.addKeyToGroup(groupId, 'key_1')).toBe(false);
    });

    it('throws for unknown group', () => {
      expect(() => mgr.addKeyToGroup('grp_999', 'key_1')).toThrow(/not found/);
    });

    it('removes a key from a group', () => {
      mgr.addKeyToGroup(groupId, 'key_1');
      expect(mgr.removeKeyFromGroup(groupId, 'key_1')).toBe(true);
      expect(mgr.getGroupMembers(groupId)).toEqual([]);
    });

    it('returns false for unknown key removal', () => {
      expect(mgr.removeKeyFromGroup(groupId, 'key_999')).toBe(false);
    });

    it('returns false for unknown group removal', () => {
      expect(mgr.removeKeyFromGroup('grp_999', 'key_1')).toBe(false);
    });

    it('checks if key is in group', () => {
      mgr.addKeyToGroup(groupId, 'key_1');
      expect(mgr.isKeyInGroup(groupId, 'key_1')).toBe(true);
      expect(mgr.isKeyInGroup(groupId, 'key_2')).toBe(false);
      expect(mgr.isKeyInGroup('grp_999', 'key_1')).toBe(false);
    });

    it('gets groups a key belongs to', () => {
      const g2 = mgr.createGroup({ name: 'team-2' });
      mgr.addKeyToGroup(groupId, 'key_1');
      mgr.addKeyToGroup(g2.id, 'key_1');
      expect(mgr.getKeyGroups('key_1')).toHaveLength(2);
      expect(mgr.getKeyGroups('key_999')).toEqual([]);
    });

    it('cleans up key-to-group mapping on group delete', () => {
      mgr.addKeyToGroup(groupId, 'key_1');
      mgr.deleteGroup(groupId);
      expect(mgr.getKeyGroups('key_1')).toEqual([]);
    });

    it('returns empty members for unknown group', () => {
      expect(mgr.getGroupMembers('grp_999')).toEqual([]);
    });
  });

  // ── Query ──────────────────────────────────────────────────────────

  describe('query', () => {
    beforeEach(() => {
      const g1 = mgr.createGroup({ name: 'alpha-team' });
      const g2 = mgr.createGroup({ name: 'beta-team' });
      mgr.addKeyToGroup(g1.id, 'key_1');
      mgr.addKeyToGroup(g2.id, 'key_2');
      mgr.addKeyToGroup(g2.id, 'key_1');
    });

    it('lists all groups', () => {
      expect(mgr.listGroups()).toHaveLength(2);
    });

    it('filters by name', () => {
      expect(mgr.listGroups({ name: 'alpha' })).toHaveLength(1);
    });

    it('filters by member key', () => {
      expect(mgr.listGroups({ memberKey: 'key_1' })).toHaveLength(2);
      expect(mgr.listGroups({ memberKey: 'key_2' })).toHaveLength(1);
    });

    it('respects limit', () => {
      expect(mgr.listGroups({ limit: 1 })).toHaveLength(1);
    });
  });

  // ── Max Groups ─────────────────────────────────────────────────────

  describe('max groups', () => {
    it('rejects when max groups reached', () => {
      const small = new KeyGroupManager({ maxGroups: 2 });
      small.createGroup({ name: 'a' });
      small.createGroup({ name: 'b' });
      expect(() => small.createGroup({ name: 'c' })).toThrow(/Maximum/);
      small.destroy();
    });

    it('rejects when max members per group reached', () => {
      const small = new KeyGroupManager({ maxMembersPerGroup: 2 });
      const g = small.createGroup({ name: 'limited' });
      small.addKeyToGroup(g.id, 'k1');
      small.addKeyToGroup(g.id, 'k2');
      expect(() => small.addKeyToGroup(g.id, 'k3')).toThrow(/Maximum/);
      small.destroy();
    });
  });

  // ── Stats & Destroy ────────────────────────────────────────────────

  describe('stats and destroy', () => {
    it('tracks comprehensive stats', () => {
      const g1 = mgr.createGroup({ name: 'a' });
      const g2 = mgr.createGroup({ name: 'b' });
      mgr.addKeyToGroup(g1.id, 'k1');
      mgr.addKeyToGroup(g1.id, 'k2');
      mgr.addKeyToGroup(g1.id, 'k3');
      mgr.addKeyToGroup(g2.id, 'k1');

      const stats = mgr.getStats();
      expect(stats.totalGroups).toBe(2);
      expect(stats.totalMemberships).toBe(4);
      expect(stats.avgMembersPerGroup).toBe(2);
      expect(stats.largestGroup).not.toBeNull();
      expect(stats.largestGroup!.name).toBe('a');
      expect(stats.largestGroup!.size).toBe(3);
    });

    it('destroy resets everything', () => {
      mgr.createGroup({ name: 'x' });
      mgr.destroy();
      expect(mgr.getStats().totalGroups).toBe(0);
    });
  });
});
