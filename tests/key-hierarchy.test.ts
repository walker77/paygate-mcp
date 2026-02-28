/**
 * Tests for Key Hierarchy — Parent/Child API Key Relationships.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { KeyHierarchyManager } from '../src/key-hierarchy';

describe('KeyHierarchyManager', () => {
  let mgr: KeyHierarchyManager;

  beforeEach(() => {
    mgr = new KeyHierarchyManager({ maxDepth: 3, maxChildren: 5 });
  });

  // ─── Relation Creation ──────────────────────────────────────────────────

  describe('createRelation', () => {
    it('creates a parent-child relation', () => {
      const ok = mgr.createRelation({ childKey: 'child1', parentKey: 'parent1' });
      expect(ok).toBe(true);
      expect(mgr.getParent('child1')).toBe('parent1');
      expect(mgr.getChildren('parent1')).toEqual(['child1']);
    });

    it('rejects self-reference', () => {
      expect(mgr.createRelation({ childKey: 'k1', parentKey: 'k1' })).toBe(false);
    });

    it('rejects duplicate child', () => {
      mgr.createRelation({ childKey: 'child1', parentKey: 'parent1' });
      expect(mgr.createRelation({ childKey: 'child1', parentKey: 'parent2' })).toBe(false);
    });

    it('rejects circular references', () => {
      mgr.createRelation({ childKey: 'B', parentKey: 'A' });
      // A → B, now trying B → A would create a cycle
      expect(mgr.createRelation({ childKey: 'A', parentKey: 'B' })).toBe(false);
    });

    it('enforces max depth', () => {
      mgr.createRelation({ childKey: 'B', parentKey: 'A' });
      mgr.createRelation({ childKey: 'C', parentKey: 'B' });
      mgr.createRelation({ childKey: 'D', parentKey: 'C' });
      // Depth is now 3 (A→B→C→D), adding another should fail
      expect(mgr.createRelation({ childKey: 'E', parentKey: 'D' })).toBe(false);
    });

    it('enforces max children', () => {
      for (let i = 0; i < 5; i++) {
        mgr.createRelation({ childKey: `child${i}`, parentKey: 'parent' });
      }
      expect(mgr.createRelation({ childKey: 'child5', parentKey: 'parent' })).toBe(false);
    });
  });

  // ─── Relation Removal ──────────────────────────────────────────────────

  describe('removeRelation', () => {
    it('removes a relation', () => {
      mgr.createRelation({ childKey: 'child1', parentKey: 'parent1' });
      expect(mgr.removeRelation('child1')).toBe(true);
      expect(mgr.getParent('child1')).toBeNull();
      expect(mgr.getChildren('parent1')).toEqual([]);
    });

    it('cascades removal to descendants', () => {
      mgr.createRelation({ childKey: 'B', parentKey: 'A' });
      mgr.createRelation({ childKey: 'C', parentKey: 'B' });
      mgr.removeRelation('B');
      expect(mgr.getParent('B')).toBeNull();
      expect(mgr.getParent('C')).toBeNull();
    });

    it('returns false for non-existent', () => {
      expect(mgr.removeRelation('nonexistent')).toBe(false);
    });
  });

  // ─── Hierarchy Queries ──────────────────────────────────────────────────

  describe('hierarchy queries', () => {
    beforeEach(() => {
      // A → B → C
      //       → D
      mgr.createRelation({ childKey: 'B', parentKey: 'A' });
      mgr.createRelation({ childKey: 'C', parentKey: 'B' });
      mgr.createRelation({ childKey: 'D', parentKey: 'B' });
    });

    it('getDescendants returns all descendants', () => {
      const desc = mgr.getDescendants('A');
      expect(desc).toContain('B');
      expect(desc).toContain('C');
      expect(desc).toContain('D');
      expect(desc).toHaveLength(3);
    });

    it('getAncestors returns ancestry chain', () => {
      expect(mgr.getAncestors('C')).toEqual(['B', 'A']);
    });

    it('getRoot returns root of chain', () => {
      expect(mgr.getRoot('C')).toBe('A');
      expect(mgr.getRoot('A')).toBe('A');
    });

    it('isDescendant checks correctly', () => {
      expect(mgr.isDescendant('C', 'A')).toBe(true);
      expect(mgr.isDescendant('A', 'C')).toBe(false);
    });

    it('isChild and isParent', () => {
      expect(mgr.isChild('B')).toBe(true);
      expect(mgr.isChild('A')).toBe(false);
      expect(mgr.isParent('A')).toBe(true);
      expect(mgr.isParent('C')).toBe(false);
    });

    it('getDepth returns correct depth', () => {
      expect(mgr.getDepth('A')).toBe(0);
      expect(mgr.getDepth('B')).toBe(1);
      expect(mgr.getDepth('C')).toBe(2);
    });
  });

  // ─── Credit Usage ──────────────────────────────────────────────────────

  describe('credit usage', () => {
    it('tracks usage against ceiling', () => {
      mgr.createRelation({ childKey: 'child', parentKey: 'parent', creditCeiling: 100 });
      expect(mgr.recordUsage('child', 50)).toBe(true);
      expect(mgr.getRemainingCeiling('child')).toBe(50);
    });

    it('rejects usage exceeding ceiling', () => {
      mgr.createRelation({ childKey: 'child', parentKey: 'parent', creditCeiling: 100 });
      mgr.recordUsage('child', 90);
      expect(mgr.recordUsage('child', 20)).toBe(false);
    });

    it('allows unlimited usage with 0 ceiling', () => {
      mgr.createRelation({ childKey: 'child', parentKey: 'parent', creditCeiling: 0 });
      expect(mgr.recordUsage('child', 1000)).toBe(true);
      expect(mgr.getRemainingCeiling('child')).toBeNull();
    });

    it('refunds usage', () => {
      mgr.createRelation({ childKey: 'child', parentKey: 'parent', creditCeiling: 100 });
      mgr.recordUsage('child', 50);
      mgr.refundUsage('child', 20);
      expect(mgr.getRemainingCeiling('child')).toBe(70);
    });

    it('updates ceiling', () => {
      mgr.createRelation({ childKey: 'child', parentKey: 'parent', creditCeiling: 100 });
      mgr.setCreditCeiling('child', 200);
      expect(mgr.getRemainingCeiling('child')).toBe(200);
    });
  });

  // ─── Hierarchy Info ─────────────────────────────────────────────────────

  describe('getInfo', () => {
    it('returns hierarchy info with credits', () => {
      mgr.createRelation({ childKey: 'child', parentKey: 'parent', creditCeiling: 50 });
      const info = mgr.getInfo('child', (key) => key === 'child' ? 100 : 0);
      expect(info.parent).toBe('parent');
      expect(info.depth).toBe(1);
      // Effective credits = min(100, 50 ceiling)
      expect(info.effectiveCredits).toBe(50);
    });
  });

  // ─── Export/Import ──────────────────────────────────────────────────────

  describe('export/import', () => {
    it('round-trips relations', () => {
      mgr.createRelation({ childKey: 'B', parentKey: 'A', creditCeiling: 100 });
      mgr.createRelation({ childKey: 'C', parentKey: 'B', creditCeiling: 50 });
      mgr.recordUsage('B', 30);

      const exported = mgr.exportRelations();
      const mgr2 = new KeyHierarchyManager();
      mgr2.importRelations(exported);

      expect(mgr2.getParent('B')).toBe('A');
      expect(mgr2.getParent('C')).toBe('B');
      expect(mgr2.getChildren('A')).toEqual(['B']);
    });
  });

  // ─── Stats ──────────────────────────────────────────────────────────────

  describe('stats', () => {
    it('tracks hierarchy stats', () => {
      mgr.createRelation({ childKey: 'B', parentKey: 'A' });
      mgr.createRelation({ childKey: 'C', parentKey: 'B' });

      const stats = mgr.getStats();
      expect(stats.totalRelations).toBe(2);
      expect(stats.parentCount).toBe(2);
      expect(stats.childCount).toBe(2);
      expect(stats.maxDepthUsed).toBe(2);
    });
  });

  // ─── Destroy ────────────────────────────────────────────────────────────

  describe('destroy', () => {
    it('releases all resources', () => {
      mgr.createRelation({ childKey: 'B', parentKey: 'A' });
      mgr.destroy();
      expect(mgr.getStats().totalRelations).toBe(0);
    });
  });
});
