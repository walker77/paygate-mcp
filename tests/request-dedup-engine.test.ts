import { RequestDeduplicator } from '../src/request-dedup-engine';

describe('RequestDeduplicator', () => {
  let dedup: RequestDeduplicator;

  beforeEach(() => {
    dedup = new RequestDeduplicator({ ttlMs: 200 });
  });

  afterEach(() => {
    dedup.destroy();
  });

  // ── Fingerprinting ─────────────────────────────────────────────────

  describe('fingerprinting', () => {
    it('generates consistent fingerprints', () => {
      const fp1 = dedup.fingerprint({ method: 'search', query: 'hello' });
      const fp2 = dedup.fingerprint({ method: 'search', query: 'hello' });
      expect(fp1).toBe(fp2);
    });

    it('generates different fingerprints for different payloads', () => {
      const fp1 = dedup.fingerprint({ method: 'search', query: 'hello' });
      const fp2 = dedup.fingerprint({ method: 'search', query: 'world' });
      expect(fp1).not.toBe(fp2);
    });

    it('generates fingerprints regardless of key order', () => {
      const fp1 = dedup.fingerprint({ a: 1, b: 2 });
      const fp2 = dedup.fingerprint({ b: 2, a: 1 });
      expect(fp1).toBe(fp2);
    });

    it('supports detailed hash algorithm', () => {
      const detailed = new RequestDeduplicator({ hashAlgorithm: 'detailed' });
      const fp = detailed.fingerprint({ method: 'test' });
      expect(fp).toMatch(/^fpd_/);
      detailed.destroy();
    });
  });

  // ── Deduplication ──────────────────────────────────────────────────

  describe('deduplication', () => {
    it('records and detects duplicate', () => {
      const fp = dedup.fingerprint({ method: 'test' });
      dedup.record(fp, 'key_1');
      expect(dedup.isDuplicate(fp)).toBe(true);
    });

    it('allows non-duplicates', () => {
      const fp = dedup.fingerprint({ method: 'test' });
      expect(dedup.isDuplicate(fp)).toBe(false);
    });

    it('check returns detailed result', () => {
      const fp = dedup.fingerprint({ method: 'test' });
      dedup.record(fp, 'key_1');
      const result = dedup.check(fp);
      expect(result.isDuplicate).toBe(true);
      expect(result.previousCount).toBe(1);
      expect(result.firstSeenAt).not.toBeNull();
    });

    it('check returns non-duplicate result', () => {
      const fp = dedup.fingerprint({ method: 'new' });
      const result = dedup.check(fp);
      expect(result.isDuplicate).toBe(false);
      expect(result.previousCount).toBe(0);
    });

    it('increments count on re-record', () => {
      const fp = dedup.fingerprint({ method: 'test' });
      dedup.record(fp, 'key_1');
      const rec = dedup.record(fp, 'key_1');
      expect(rec.count).toBe(2);
    });

    it('expires after TTL', async () => {
      const fp = dedup.fingerprint({ method: 'test' });
      dedup.record(fp, 'key_1');
      expect(dedup.isDuplicate(fp)).toBe(true);

      await new Promise(r => setTimeout(r, 250));
      expect(dedup.isDuplicate(fp)).toBe(false);
    });
  });

  // ── Query ──────────────────────────────────────────────────────────

  describe('query', () => {
    it('gets record by fingerprint', () => {
      const fp = dedup.fingerprint({ method: 'test' });
      dedup.record(fp, 'key_1');
      expect(dedup.getRecord(fp)).not.toBeNull();
    });

    it('returns null for unknown fingerprint', () => {
      expect(dedup.getRecord('fp_unknown')).toBeNull();
    });

    it('gets records for a key', () => {
      dedup.record(dedup.fingerprint({ a: 1 }), 'key_1');
      dedup.record(dedup.fingerprint({ b: 2 }), 'key_1');
      dedup.record(dedup.fingerprint({ c: 3 }), 'key_2');
      expect(dedup.getKeyRecords('key_1')).toHaveLength(2);
    });

    it('clears records for a key', () => {
      dedup.record(dedup.fingerprint({ a: 1 }), 'key_1');
      dedup.record(dedup.fingerprint({ b: 2 }), 'key_1');
      expect(dedup.clearKey('key_1')).toBe(2);
    });

    it('force expires a fingerprint', () => {
      const fp = dedup.fingerprint({ method: 'test' });
      dedup.record(fp, 'key_1');
      expect(dedup.expire(fp)).toBe(true);
      expect(dedup.isDuplicate(fp)).toBe(false);
    });
  });

  // ── Eviction ───────────────────────────────────────────────────────

  describe('eviction', () => {
    it('evicts oldest at capacity', () => {
      const small = new RequestDeduplicator({ maxEntries: 2, ttlMs: 10000 });
      small.record('fp_1', 'k1');
      small.record('fp_2', 'k2');
      small.record('fp_3', 'k3'); // evicts fp_1
      expect(small.getRecord('fp_1')).toBeNull();
      expect(small.getRecord('fp_3')).not.toBeNull();
      small.destroy();
    });
  });

  // ── Stats & Destroy ────────────────────────────────────────────────

  describe('stats and destroy', () => {
    it('tracks comprehensive stats', () => {
      const fp = dedup.fingerprint({ method: 'test' });
      dedup.record(fp, 'key_1');
      dedup.isDuplicate(fp);
      dedup.isDuplicate(dedup.fingerprint({ new: true }));

      const stats = dedup.getStats();
      expect(stats.trackedFingerprints).toBe(1);
      expect(stats.totalChecks).toBe(2);
      expect(stats.totalDuplicates).toBe(1);
      expect(stats.deduplicationRate).toBe(50);
    });

    it('destroy resets everything', () => {
      dedup.record(dedup.fingerprint({ a: 1 }), 'k1');
      dedup.destroy();
      expect(dedup.getStats().trackedFingerprints).toBe(0);
      expect(dedup.getStats().totalChecks).toBe(0);
    });
  });
});
