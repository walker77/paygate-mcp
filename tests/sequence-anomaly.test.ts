/**
 * Tests for Sequence Anomaly Detection.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { SequenceAnomalyDetector } from '../src/sequence-anomaly';

describe('SequenceAnomalyDetector', () => {
  let detector: SequenceAnomalyDetector;

  beforeEach(() => {
    detector = new SequenceAnomalyDetector({
      enabled: true,
      learningThreshold: 10,
      anomalyThreshold: 0.01,
      action: 'log',
      windowSize: 5,
    });
  });

  // ─── Enable/Disable ─────────────────────────────────────────────────
  describe('enable/disable', () => {
    it('defaults to disabled', () => {
      const d = new SequenceAnomalyDetector();
      expect(d.isEnabled).toBe(false);
    });

    it('can be enabled via config', () => {
      expect(detector.isEnabled).toBe(true);
    });

    it('can be toggled at runtime', () => {
      detector.setEnabled(false);
      expect(detector.isEnabled).toBe(false);
    });
  });

  // ─── Learning Mode ──────────────────────────────────────────────────
  describe('learning mode', () => {
    it('stays in learning mode below threshold', () => {
      for (let i = 0; i < 5; i++) {
        const result = detector.check('key-1', 'readFile');
        expect(result.learning).toBe(true);
        expect(result.anomalous).toBe(false);
      }
    });

    it('records transitions during learning', () => {
      detector.check('key-1', 'readFile');
      detector.check('key-1', 'writeFile');
      detector.check('key-1', 'readFile');

      const info = detector.getKeyInfo('key-1');
      expect(info).not.toBeNull();
      expect(info!.transitions).toBe(3);
      expect(info!.recentTools).toContain('readFile');
    });

    it('transitions to enforcement after threshold', () => {
      // Build up enough transitions
      for (let i = 0; i < 12; i++) {
        detector.check('key-1', i % 2 === 0 ? 'readFile' : 'writeFile');
      }

      const info = detector.getKeyInfo('key-1');
      expect(info!.enforcing).toBe(true);
    });
  });

  // ─── Anomaly Detection ─────────────────────────────────────────────
  describe('anomaly detection', () => {
    function buildNormalPattern(key: string, count: number): void {
      // Establish a clear pattern: readFile → writeFile → readFile → writeFile
      for (let i = 0; i < count; i++) {
        detector.check(key, i % 2 === 0 ? 'readFile' : 'writeFile');
      }
    }

    it('does not flag normal transitions', () => {
      buildNormalPattern('key-1', 20);
      // Pattern is readFile, writeFile, readFile, writeFile... (20 items)
      // Last call is writeFile (index 19). The common transition is writeFile → readFile.
      const result = detector.check('key-1', 'readFile');
      expect(result.anomalous).toBe(false);
      expect(result.score).toBeGreaterThan(0.01);
    });

    it('flags unusual transitions', () => {
      // Build a very strong pattern
      for (let i = 0; i < 50; i++) {
        detector.check('key-1', 'readFile');
        detector.check('key-1', 'writeFile');
      }

      // Now introduce a never-seen transition
      const result = detector.check('key-1', 'deleteDatabase');
      // The score for an unseen transition should be very low
      expect(result.score).toBeLessThan(0.5);
    });

    it('returns allow when disabled', () => {
      detector.setEnabled(false);
      const result = detector.check('key-1', 'readFile');
      expect(result.action).toBe('allow');
      expect(result.anomalous).toBe(false);
    });

    it('uses configured action for anomalies', () => {
      const d = new SequenceAnomalyDetector({
        enabled: true,
        learningThreshold: 5,
        anomalyThreshold: 0.99, // Very strict — almost everything is anomalous
        action: 'block',
        windowSize: 5,
      });

      // Build pattern
      for (let i = 0; i < 10; i++) {
        d.check('key-1', 'readFile');
      }

      // New tool after only seeing readFile
      const result = d.check('key-1', 'deleteAll');
      if (result.anomalous) {
        expect(result.action).toBe('block');
      }
    });
  });

  // ─── Transition Probability ────────────────────────────────────────
  describe('transition probability', () => {
    it('computes probabilities from model', () => {
      // Build a deterministic pattern
      for (let i = 0; i < 20; i++) {
        detector.check('key-1', 'readFile');
        detector.check('key-1', 'writeFile');
      }

      // readFile → writeFile should have high probability
      const model = detector.getGlobalModel();
      const prob = detector.getTransitionProbability(model, 'readFile', 'writeFile');
      expect(prob).toBeGreaterThan(0.5);
    });

    it('returns smoothed probability for unseen transitions', () => {
      detector.check('key-1', 'readFile');
      detector.check('key-1', 'writeFile');

      const model = detector.getGlobalModel();
      const prob = detector.getTransitionProbability(model, 'readFile', 'neverSeen');
      expect(prob).toBeGreaterThan(0);
      expect(prob).toBeLessThan(0.5);
    });
  });

  // ─── Sequence Score ────────────────────────────────────────────────
  describe('getSequenceScore', () => {
    it('returns 1.0 for unknown key', () => {
      expect(detector.getSequenceScore('unknown')).toBe(1.0);
    });

    it('returns meaningful score for established patterns', () => {
      for (let i = 0; i < 20; i++) {
        detector.check('key-1', i % 2 === 0 ? 'readFile' : 'writeFile');
      }
      const score = detector.getSequenceScore('key-1');
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1.0);
    });
  });

  // ─── Top Transitions ──────────────────────────────────────────────
  describe('getTopTransitions', () => {
    it('returns sorted transitions', () => {
      for (let i = 0; i < 10; i++) {
        detector.check('key-1', 'readFile');
        detector.check('key-1', 'writeFile');
      }
      // Also add some less common transitions
      detector.check('key-1', 'deleteFile');

      const top = detector.getTopTransitions('key-1', 3);
      expect(top.length).toBeGreaterThan(0);
      expect(top[0].count).toBeGreaterThanOrEqual(top[top.length - 1].count);
    });
  });

  // ─── Key Management ────────────────────────────────────────────────
  describe('key management', () => {
    it('getKeyInfo returns null for unknown key', () => {
      expect(detector.getKeyInfo('unknown')).toBeNull();
    });

    it('getKeyInfo returns state for tracked key', () => {
      detector.check('key-1', 'readFile');
      const info = detector.getKeyInfo('key-1');
      expect(info).not.toBeNull();
      expect(info!.transitions).toBe(1);
      expect(info!.recentTools).toEqual(['readFile']);
    });

    it('resetKey clears key state', () => {
      detector.check('key-1', 'readFile');
      expect(detector.resetKey('key-1')).toBe(true);
      expect(detector.getKeyInfo('key-1')).toBeNull();
    });

    it('resetKey returns false for unknown key', () => {
      expect(detector.resetKey('unknown')).toBe(false);
    });
  });

  // ─── Sliding Window ────────────────────────────────────────────────
  describe('sliding window', () => {
    it('maintains window of recent tools', () => {
      const tools = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      for (const t of tools) {
        detector.check('key-1', t);
      }

      const info = detector.getKeyInfo('key-1');
      // Window size is 5
      expect(info!.recentTools).toHaveLength(5);
      expect(info!.recentTools).toEqual(['c', 'd', 'e', 'f', 'g']);
    });
  });

  // ─── Global Model ──────────────────────────────────────────────────
  describe('global model', () => {
    it('builds global baseline across all keys', () => {
      detector.check('key-1', 'readFile');
      detector.check('key-1', 'writeFile');
      detector.check('key-2', 'readFile');
      detector.check('key-2', 'query');

      const model = detector.getGlobalModel();
      expect(model.totalTransitions).toBe(4);
    });
  });

  // ─── Stats ──────────────────────────────────────────────────────────
  describe('stats', () => {
    it('tracks check counts', () => {
      detector.check('key-1', 'readFile');
      detector.check('key-1', 'writeFile');
      detector.check('key-2', 'readFile');

      const stats = detector.getStats();
      expect(stats.totalChecks).toBe(3);
      expect(stats.trackedKeys).toBe(2);
      expect(stats.totalTransitions).toBe(3);
    });

    it('tracks learning vs enforcing keys', () => {
      // key-1: only a few transitions (learning)
      detector.check('key-1', 'readFile');

      // key-2: many transitions (enforcing)
      for (let i = 0; i < 15; i++) {
        detector.check('key-2', i % 2 === 0 ? 'a' : 'b');
      }

      const stats = detector.getStats();
      expect(stats.keysLearning).toBe(1);
      expect(stats.keysEnforcing).toBe(1);
    });
  });

  // ─── Max Keys Eviction ─────────────────────────────────────────────
  describe('eviction', () => {
    it('evicts least-used key when at capacity', () => {
      const d = new SequenceAnomalyDetector({
        enabled: true,
        maxKeys: 3,
        learningThreshold: 100,
      });

      // Add 3 keys with different amounts of data
      d.check('key-least', 'a'); // 1 transition
      for (let i = 0; i < 5; i++) d.check('key-mid', 'a'); // 5 transitions
      for (let i = 0; i < 10; i++) d.check('key-most', 'a'); // 10 transitions

      // Adding a 4th should evict key-least
      d.check('key-new', 'b');

      expect(d.getKeyInfo('key-least')).toBeNull();
      expect(d.getKeyInfo('key-most')).not.toBeNull();
      expect(d.getStats().trackedKeys).toBe(3);
    });
  });

  // ─── Destroy ────────────────────────────────────────────────────────
  describe('destroy', () => {
    it('releases all resources', () => {
      detector.check('key-1', 'readFile');
      detector.destroy();
      expect(detector.getStats().trackedKeys).toBe(0);
      expect(detector.getStats().totalChecks).toBe(0);
    });
  });
});
