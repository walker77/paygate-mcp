/**
 * Tests for Billable Metric Expressions.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { BillableMetricEngine, BillableMetric, MetricContext, computeExpression } from '../src/billable-metrics';

// ─── Expression Parser Tests ─────────────────────────────────────────────────

describe('computeExpression', () => {
  it('evaluates simple arithmetic', () => {
    expect(computeExpression('2 + 3', {})).toBe(5);
    expect(computeExpression('10 - 4', {})).toBe(6);
    expect(computeExpression('3 * 7', {})).toBe(21);
    expect(computeExpression('20 / 5', {})).toBe(4);
    expect(computeExpression('10 % 3', {})).toBe(1);
  });

  it('respects operator precedence', () => {
    expect(computeExpression('2 + 3 * 4', {})).toBe(14);
    expect(computeExpression('(2 + 3) * 4', {})).toBe(20);
    expect(computeExpression('10 - 2 * 3', {})).toBe(4);
  });

  it('handles nested parentheses', () => {
    expect(computeExpression('((2 + 3) * (4 - 1))', {})).toBe(15);
  });

  it('handles unary minus', () => {
    expect(computeExpression('-5', {})).toBe(-5);
    expect(computeExpression('-5 + 10', {})).toBe(5);
    expect(computeExpression('10 + -3', {})).toBe(7);
  });

  it('resolves variables', () => {
    expect(computeExpression('x + y', { x: 10, y: 20 })).toBe(30);
    expect(computeExpression('price * quantity', { price: 5, quantity: 3 })).toBe(15);
  });

  it('handles decimal numbers', () => {
    expect(computeExpression('0.001 * 1000', {})).toBe(1);
    expect(computeExpression('2.5 + 1.5', {})).toBe(4);
  });

  it('calls built-in functions', () => {
    expect(computeExpression('max(5, 10)', {})).toBe(10);
    expect(computeExpression('min(5, 10)', {})).toBe(5);
    expect(computeExpression('ceil(4.2)', {})).toBe(5);
    expect(computeExpression('floor(4.8)', {})).toBe(4);
    expect(computeExpression('round(4.5)', {})).toBe(5);
    expect(computeExpression('abs(-7)', {})).toBe(7);
    expect(computeExpression('sqrt(16)', {})).toBe(4);
    expect(computeExpression('pow(2, 8)', {})).toBe(256);
  });

  it('handles function in expressions', () => {
    expect(computeExpression('max(1, x * 0.5)', { x: 10 })).toBe(5);
    expect(computeExpression('ceil(x / 3)', { x: 10 })).toBe(4);
  });

  it('handles division by zero', () => {
    expect(computeExpression('10 / 0', {})).toBe(0);
    expect(computeExpression('10 % 0', {})).toBe(0);
  });

  it('throws on unknown variable', () => {
    expect(() => computeExpression('x + 1', {})).toThrow('Unknown variable: x');
  });

  it('throws on unknown function', () => {
    expect(() => computeExpression('unknown(5)', {})).toThrow('Unknown function: unknown');
  });

  it('throws on invalid syntax', () => {
    expect(() => computeExpression('2 +', {})).toThrow();
    expect(() => computeExpression('(2 + 3', {})).toThrow();
    expect(() => computeExpression('2 @ 3', {})).toThrow();
  });

  // Real-world pricing expressions
  it('evaluates token-based pricing', () => {
    const cost = computeExpression(
      'input_tokens * 0.001 + output_tokens * 0.003',
      { input_tokens: 1000, output_tokens: 500 }
    );
    expect(cost).toBeCloseTo(2.5);
  });

  it('evaluates size-based pricing with minimum', () => {
    const cost = computeExpression(
      'max(1, file_size_kb * 0.5)',
      { file_size_kb: 10 }
    );
    expect(cost).toBe(5);
  });

  it('evaluates duration-based pricing', () => {
    const cost = computeExpression(
      'base_cost + duration_s * 2',
      { base_cost: 5, duration_s: 3 }
    );
    expect(cost).toBe(11);
  });
});

// ─── BillableMetricEngine Tests ──────────────────────────────────────────────

describe('BillableMetricEngine', () => {
  let engine: BillableMetricEngine;

  const TOKEN_METRIC: BillableMetric = {
    id: 'token_pricing',
    name: 'Token-based pricing',
    expression: 'input_size_kb * 2 + response_size_kb * 5',
    tools: ['llm_chat'],
    active: true,
    minCost: 1,
    maxCost: 100,
  };

  const FLAT_METRIC: BillableMetric = {
    id: 'flat_pricing',
    name: 'Flat rate',
    expression: '10',
    tools: [],
    active: true,
  };

  beforeEach(() => {
    engine = new BillableMetricEngine([TOKEN_METRIC]);
  });

  // ─── Metric Management ────────────────────────────────────────────────
  describe('metric management', () => {
    it('returns configured metrics', () => {
      const metrics = engine.getMetrics();
      expect(metrics).toHaveLength(1);
      expect(metrics[0].id).toBe('token_pricing');
    });

    it('adds new metrics', () => {
      engine.upsertMetric(FLAT_METRIC);
      expect(engine.getMetrics()).toHaveLength(2);
    });

    it('updates existing metrics', () => {
      engine.upsertMetric({ ...TOKEN_METRIC, name: 'Updated' });
      const metrics = engine.getMetrics();
      expect(metrics).toHaveLength(1);
      expect(metrics[0].name).toBe('Updated');
    });

    it('removes metrics', () => {
      expect(engine.removeMetric('token_pricing')).toBe(true);
      expect(engine.removeMetric('nonexistent')).toBe(false);
      expect(engine.getMetrics()).toHaveLength(0);
    });

    it('validates expression syntax on upsert', () => {
      expect(() => engine.upsertMetric({
        id: 'bad',
        name: 'Bad',
        expression: '2 @ 3',
        tools: [],
        active: true,
      })).toThrow('Invalid expression');
    });
  });

  // ─── Metric Finding ───────────────────────────────────────────────────
  describe('findMetric', () => {
    it('finds metric by tool match', () => {
      const metric = engine.findMetric('llm_chat');
      expect(metric).not.toBeNull();
      expect(metric!.id).toBe('token_pricing');
    });

    it('returns null for unmatched tool', () => {
      const metric = engine.findMetric('other_tool');
      expect(metric).toBeNull();
    });

    it('matches catch-all metric (empty tools array)', () => {
      engine.upsertMetric(FLAT_METRIC);
      const metric = engine.findMetric('any_tool');
      // TOKEN_METRIC has tool filter, FLAT_METRIC is catch-all
      // Since TOKEN_METRIC doesn't match, FLAT_METRIC should be returned
      expect(metric).not.toBeNull();
      expect(metric!.id).toBe('flat_pricing');
    });

    it('skips inactive metrics', () => {
      engine.upsertMetric({ ...TOKEN_METRIC, active: false });
      expect(engine.findMetric('llm_chat')).toBeNull();
    });
  });

  // ─── Cost Computation ─────────────────────────────────────────────────
  describe('computeCost', () => {
    it('computes cost from expression', () => {
      const result = engine.computeCost({
        tool: 'llm_chat',
        inputArgs: {},
        inputSizeBytes: 1024, // 1 KB
        responseSizeBytes: 2048, // 2 KB
      });

      expect(result).not.toBeNull();
      expect(result!.metricId).toBe('token_pricing');
      expect(result!.usedFallback).toBe(false);
      // 1 * 2 + 2 * 5 = 12
      expect(result!.cost).toBe(12);
    });

    it('applies minimum cost', () => {
      const result = engine.computeCost({
        tool: 'llm_chat',
        inputArgs: {},
        inputSizeBytes: 1, // tiny
        responseSizeBytes: 1,
      });

      expect(result).not.toBeNull();
      // Computed cost would be ~0, but minCost is 1
      expect(result!.cost).toBeGreaterThanOrEqual(1);
    });

    it('applies maximum cost', () => {
      const result = engine.computeCost({
        tool: 'llm_chat',
        inputArgs: {},
        inputSizeBytes: 1024 * 1024, // 1 MB
        responseSizeBytes: 1024 * 1024,
      });

      expect(result).not.toBeNull();
      expect(result!.cost).toBeLessThanOrEqual(100); // maxCost
    });

    it('returns null when no metric matches', () => {
      const result = engine.computeCost({
        tool: 'unmatched_tool',
        inputArgs: {},
      });
      expect(result).toBeNull();
    });

    it('uses fallback on expression error', () => {
      engine.upsertMetric({
        id: 'bad_vars',
        name: 'Bad vars',
        expression: 'nonexistent_var * 2',
        tools: ['badTool'],
        active: true,
        fallbackCost: 5,
      });

      const result = engine.computeCost({
        tool: 'badTool',
        inputArgs: {},
      });

      expect(result).not.toBeNull();
      expect(result!.usedFallback).toBe(true);
      expect(result!.cost).toBe(5);
      expect(result!.error).toBeDefined();
    });

    it('extracts numeric variables from input args', () => {
      engine.upsertMetric({
        id: 'arg_pricing',
        name: 'Arg-based pricing',
        expression: 'count * 2 + priority',
        tools: ['process'],
        active: true,
      });

      const result = engine.computeCost({
        tool: 'process',
        inputArgs: { count: 5, priority: 3 },
      });

      expect(result).not.toBeNull();
      expect(result!.cost).toBe(13); // 5*2 + 3
    });

    it('creates string length variables', () => {
      engine.upsertMetric({
        id: 'length_pricing',
        name: 'Length-based',
        expression: 'message_length * 0.01',
        tools: ['send'],
        active: true,
        minCost: 1,
      });

      const result = engine.computeCost({
        tool: 'send',
        inputArgs: { message: 'Hello World' },
      });

      expect(result).not.toBeNull();
      // 'Hello World' is 11 chars, 11 * 0.01 = 0.11, rounded = 0, but minCost = 1
      expect(result!.cost).toBe(1);
    });

    it('injects custom variables', () => {
      engine.upsertMetric({
        id: 'custom_var',
        name: 'Custom vars',
        expression: 'custom_multiplier * 10',
        tools: ['custom'],
        active: true,
      });

      const result = engine.computeCost({
        tool: 'custom',
        inputArgs: {},
        customVars: { custom_multiplier: 3 },
      });

      expect(result).not.toBeNull();
      expect(result!.cost).toBe(30);
    });

    it('includes duration_ms and duration_s', () => {
      engine.upsertMetric({
        id: 'duration_pricing',
        name: 'Duration-based',
        expression: 'duration_s * 5',
        tools: ['slow_tool'],
        active: true,
      });

      const result = engine.computeCost({
        tool: 'slow_tool',
        inputArgs: {},
        durationMs: 3000,
      });

      expect(result).not.toBeNull();
      expect(result!.cost).toBe(15); // 3 * 5
    });
  });

  // ─── Stats ─────────────────────────────────────────────────────────────
  describe('stats', () => {
    it('tracks evaluation counts', () => {
      engine.computeCost({ tool: 'llm_chat', inputArgs: {}, inputSizeBytes: 1024, responseSizeBytes: 1024 });
      engine.computeCost({ tool: 'llm_chat', inputArgs: {}, inputSizeBytes: 2048, responseSizeBytes: 2048 });

      const stats = engine.getStats();
      expect(stats.totalEvaluations).toBe(2);
      expect(stats.successfulEvals).toBe(2);
      expect(stats.fallbackEvals).toBe(0);
      expect(stats.byMetric.token_pricing).toBe(2);
      expect(stats.byTool.llm_chat).toBe(2);
    });

    it('resets stats', () => {
      engine.computeCost({ tool: 'llm_chat', inputArgs: {}, inputSizeBytes: 1024 });
      engine.resetStats();
      const stats = engine.getStats();
      expect(stats.totalEvaluations).toBe(0);
    });
  });

  // ─── Import/Export ─────────────────────────────────────────────────────
  describe('import/export', () => {
    it('exports metrics', () => {
      const exported = engine.exportMetrics();
      expect(exported).toHaveLength(1);
      expect(exported[0].id).toBe('token_pricing');
      // Should be a deep copy
      exported[0].name = 'Modified';
      expect(engine.getMetrics()[0].name).not.toBe('Modified');
    });

    it('imports metrics (merge)', () => {
      const count = engine.importMetrics([FLAT_METRIC], 'merge');
      expect(count).toBe(1);
      expect(engine.getMetrics()).toHaveLength(2);
    });

    it('imports metrics (replace)', () => {
      const count = engine.importMetrics([FLAT_METRIC], 'replace');
      expect(count).toBe(1);
      expect(engine.getMetrics()).toHaveLength(1);
      expect(engine.getMetrics()[0].id).toBe('flat_pricing');
    });
  });

  // ─── Destroy ──────────────────────────────────────────────────────────
  describe('destroy', () => {
    it('clears all metrics', () => {
      engine.destroy();
      expect(engine.getMetrics()).toHaveLength(0);
    });
  });
});
