/**
 * Tests for OpenTelemetry Trace Emitter.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as http from 'http';
import { OtelEmitter, OtelSpan, OtelConfig } from '../src/otel-emitter';

// ─── Mock OTEL Collector ─────────────────────────────────────────────────────

function createMockCollector(): { server: http.Server; receivedBatches: any[]; port: () => number } {
  const receivedBatches: any[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        receivedBatches.push(JSON.parse(body));
        res.writeHead(200);
        res.end('OK');
      } catch {
        res.writeHead(400);
        res.end('Bad Request');
      }
    });
  });

  return {
    server,
    receivedBatches,
    port: () => (server.address() as { port: number })?.port ?? 0,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('OtelEmitter', () => {
  let emitter: OtelEmitter;

  afterEach(() => {
    emitter?.destroy();
  });

  // ─── Enable/Disable ──────────────────────────────────────────────────
  describe('enable/disable', () => {
    it('defaults to disabled', () => {
      emitter = new OtelEmitter({});
      expect(emitter.isEnabled).toBe(false);
    });

    it('can be enabled via config', () => {
      emitter = new OtelEmitter({ enabled: true, endpoint: 'http://localhost:4318' });
      expect(emitter.isEnabled).toBe(true);
    });

    it('can be toggled at runtime', () => {
      emitter = new OtelEmitter({});
      emitter.setEnabled(true);
      expect(emitter.isEnabled).toBe(true);
      emitter.setEnabled(false);
      expect(emitter.isEnabled).toBe(false);
    });
  });

  // ─── Trace/Span ID Generation ────────────────────────────────────────
  describe('ID generation', () => {
    it('generates 32-char hex trace IDs', () => {
      emitter = new OtelEmitter({});
      const traceId = emitter.newTraceId();
      expect(traceId).toHaveLength(32);
      expect(/^[0-9a-f]{32}$/.test(traceId)).toBe(true);
    });

    it('generates 16-char hex span IDs', () => {
      emitter = new OtelEmitter({});
      const spanId = emitter.newSpanId();
      expect(spanId).toHaveLength(16);
      expect(/^[0-9a-f]{16}$/.test(spanId)).toBe(true);
    });

    it('generates unique IDs', () => {
      emitter = new OtelEmitter({});
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(emitter.newTraceId());
      }
      expect(ids.size).toBe(100);
    });
  });

  // ─── Traceparent Parsing ─────────────────────────────────────────────
  describe('traceparent', () => {
    it('parses valid traceparent header', () => {
      emitter = new OtelEmitter({});
      const result = emitter.parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
      expect(result).not.toBeNull();
      expect(result!.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
      expect(result!.parentSpanId).toBe('b7ad6b7169203331');
      expect(result!.sampled).toBe(true);
    });

    it('parses unsampled traceparent', () => {
      emitter = new OtelEmitter({});
      const result = emitter.parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00');
      expect(result!.sampled).toBe(false);
    });

    it('returns null for invalid format', () => {
      emitter = new OtelEmitter({});
      expect(emitter.parseTraceparent('invalid')).toBeNull();
      expect(emitter.parseTraceparent('00-short-id-01')).toBeNull();
      expect(emitter.parseTraceparent('01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01')).toBeNull();
    });

    it('builds traceparent header', () => {
      emitter = new OtelEmitter({});
      const header = emitter.buildTraceparent('0af7651916cd43dd8448eb211c80319c', 'b7ad6b7169203331', true);
      expect(header).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    });
  });

  // ─── Span Recording ──────────────────────────────────────────────────
  describe('recordSpan', () => {
    it('queues spans when enabled', () => {
      emitter = new OtelEmitter({ enabled: true, endpoint: 'http://localhost:4318' });
      const span: OtelSpan = {
        traceId: emitter.newTraceId(),
        spanId: emitter.newSpanId(),
        name: 'test.operation',
        kind: 1,
        startTimeUnixNano: '1000000000',
        endTimeUnixNano: '2000000000',
        status: { code: 1 },
        attributes: [],
      };

      emitter.recordSpan(span);
      const stats = emitter.getStats();
      expect(stats.spansCreated).toBe(1);
      expect(stats.queueSize).toBe(1);
    });

    it('does not queue when disabled', () => {
      emitter = new OtelEmitter({ enabled: false });
      const span: OtelSpan = {
        traceId: emitter.newTraceId(),
        spanId: emitter.newSpanId(),
        name: 'test.operation',
        kind: 1,
        startTimeUnixNano: '1000000000',
        endTimeUnixNano: '2000000000',
        status: { code: 1 },
        attributes: [],
      };

      emitter.recordSpan(span);
      expect(emitter.getStats().spansCreated).toBe(0);
    });

    it('drops spans when queue is full', () => {
      emitter = new OtelEmitter({ enabled: true, endpoint: 'http://localhost:4318', maxQueueSize: 2 });

      for (let i = 0; i < 5; i++) {
        emitter.recordSpan({
          traceId: emitter.newTraceId(),
          spanId: emitter.newSpanId(),
          name: `span_${i}`,
          kind: 1,
          startTimeUnixNano: '1000000000',
          endTimeUnixNano: '2000000000',
          status: { code: 1 },
          attributes: [],
        });
      }

      const stats = emitter.getStats();
      expect(stats.spansDropped).toBe(3);
    });
  });

  // ─── emitSpan convenience ────────────────────────────────────────────
  describe('emitSpan', () => {
    it('creates and records a span from timing data', () => {
      emitter = new OtelEmitter({ enabled: true, endpoint: 'http://localhost:4318' });
      const traceId = emitter.newTraceId();

      const spanId = emitter.emitSpan({
        traceId,
        name: 'gate.check',
        startMs: Date.now() - 100,
        endMs: Date.now(),
        status: 'ok',
        attributes: {
          'paygate.tool': 'readFile',
          'paygate.credits': 5,
          'paygate.allowed': true,
        },
      });

      expect(spanId).toHaveLength(16);
      expect(emitter.getStats().spansCreated).toBe(1);
    });

    it('handles error status', () => {
      emitter = new OtelEmitter({ enabled: true, endpoint: 'http://localhost:4318' });

      emitter.emitSpan({
        traceId: emitter.newTraceId(),
        name: 'gate.check',
        startMs: Date.now() - 100,
        endMs: Date.now(),
        status: 'error',
        statusMessage: 'Insufficient credits',
      });

      expect(emitter.getStats().spansCreated).toBe(1);
    });
  });

  // ─── Flush with Real Collector ───────────────────────────────────────
  describe('flush', () => {
    it('exports spans to collector', async () => {
      const collector = createMockCollector();
      await new Promise<void>((resolve) => collector.server.listen(0, '127.0.0.1', () => resolve()));

      emitter = new OtelEmitter({
        enabled: true,
        endpoint: `http://127.0.0.1:${collector.port()}`,
        serviceName: 'test-service',
        serviceVersion: '1.0.0',
        flushIntervalMs: 60_000, // Disable auto-flush
      });

      emitter.emitSpan({
        traceId: emitter.newTraceId(),
        name: 'test.span',
        startMs: Date.now() - 50,
        endMs: Date.now(),
        status: 'ok',
        attributes: { 'test.key': 'test-value' },
      });

      const flushed = await emitter.flush();
      expect(flushed).toBe(1);

      const stats = emitter.getStats();
      expect(stats.spansExported).toBe(1);
      expect(stats.batchesSent).toBe(1);
      expect(stats.queueSize).toBe(0);

      // Verify the collector received the payload
      expect(collector.receivedBatches).toHaveLength(1);
      const batch = collector.receivedBatches[0];
      expect(batch.resourceSpans).toHaveLength(1);
      expect(batch.resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);
      expect(batch.resourceSpans[0].scopeSpans[0].spans[0].name).toBe('test.span');

      // Verify resource attributes
      const resourceAttrs = batch.resourceSpans[0].resource.attributes;
      const serviceNameAttr = resourceAttrs.find((a: any) => a.key === 'service.name');
      expect(serviceNameAttr?.value?.stringValue).toBe('test-service');

      await new Promise<void>((resolve) => collector.server.close(() => resolve()));
    });

    it('handles collector error gracefully', async () => {
      emitter = new OtelEmitter({
        enabled: true,
        endpoint: 'http://127.0.0.1:1', // Unreachable
        flushIntervalMs: 60_000,
      });

      emitter.emitSpan({
        traceId: emitter.newTraceId(),
        name: 'test.span',
        startMs: Date.now(),
        endMs: Date.now(),
        status: 'ok',
      });

      const flushed = await emitter.flush();
      expect(flushed).toBe(0);
      expect(emitter.getStats().exportErrors).toBe(1);
    });

    it('returns 0 when queue is empty', async () => {
      emitter = new OtelEmitter({ enabled: true, endpoint: 'http://localhost:4318' });
      const flushed = await emitter.flush();
      expect(flushed).toBe(0);
    });
  });

  // ─── Sampling ────────────────────────────────────────────────────────
  describe('sampling', () => {
    it('drops spans below sample rate', () => {
      emitter = new OtelEmitter({ enabled: true, endpoint: 'http://localhost:4318', sampleRate: 0.0 });

      for (let i = 0; i < 10; i++) {
        emitter.recordSpan({
          traceId: emitter.newTraceId(),
          spanId: emitter.newSpanId(),
          name: 'test',
          kind: 1,
          startTimeUnixNano: '1000000000',
          endTimeUnixNano: '2000000000',
          status: { code: 1 },
          attributes: [],
        });
      }

      // With sample rate 0.0, none should be recorded
      expect(emitter.getStats().queueSize).toBe(0);
    });
  });

  // ─── Stats ───────────────────────────────────────────────────────────
  describe('stats', () => {
    it('returns accurate stats', () => {
      emitter = new OtelEmitter({ enabled: true, endpoint: 'http://localhost:4318' });
      const stats = emitter.getStats();
      expect(stats.spansCreated).toBe(0);
      expect(stats.spansExported).toBe(0);
      expect(stats.spansDropped).toBe(0);
      expect(stats.batchesSent).toBe(0);
      expect(stats.exportErrors).toBe(0);
      expect(stats.queueSize).toBe(0);
    });
  });

  // ─── Shutdown ────────────────────────────────────────────────────────
  describe('shutdown', () => {
    it('flushes remaining spans', async () => {
      const collector = createMockCollector();
      await new Promise<void>((resolve) => collector.server.listen(0, '127.0.0.1', () => resolve()));

      emitter = new OtelEmitter({
        enabled: true,
        endpoint: `http://127.0.0.1:${collector.port()}`,
        flushIntervalMs: 60_000,
      });

      emitter.emitSpan({
        traceId: emitter.newTraceId(),
        name: 'final.span',
        startMs: Date.now(),
        endMs: Date.now(),
        status: 'ok',
      });

      await emitter.shutdown();
      expect(emitter.getStats().queueSize).toBe(0);
      expect(emitter.getStats().spansExported).toBe(1);

      await new Promise<void>((resolve) => collector.server.close(() => resolve()));
    });
  });
});
