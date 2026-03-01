import { ErrorClassifier } from '../src/error-classifier';

describe('ErrorClassifier', () => {
  let classifier: ErrorClassifier;

  beforeEach(() => {
    classifier = new ErrorClassifier();
  });

  // ── Pattern Registration ─────────────────────────────────────────────

  it('registers a pattern', () => {
    const p = classifier.registerPattern({
      category: 'rate_limit',
      pattern: /rate limit|429/i,
      severity: 'warning',
      retryable: true,
    });
    expect(p.id).toMatch(/^ep_/);
    expect(p.category).toBe('rate_limit');
  });

  it('rejects empty category', () => {
    expect(() => classifier.registerPattern({ category: '', pattern: /test/ })).toThrow('required');
  });

  it('enforces max patterns', () => {
    const small = new ErrorClassifier({ maxPatterns: 2 });
    small.registerPattern({ category: 'a', pattern: /a/ });
    small.registerPattern({ category: 'b', pattern: /b/ });
    expect(() => small.registerPattern({ category: 'c', pattern: /c/ })).toThrow('Maximum');
  });

  it('removes a pattern', () => {
    const p = classifier.registerPattern({ category: 'test', pattern: /test/ });
    expect(classifier.removePattern(p.id)).toBe(true);
    expect(classifier.getPattern(p.id)).toBeNull();
  });

  it('lists patterns', () => {
    classifier.registerPattern({ category: 'a', pattern: /a/ });
    classifier.registerPattern({ category: 'b', pattern: /b/ });
    expect(classifier.listPatterns()).toHaveLength(2);
  });

  // ── Classification ───────────────────────────────────────────────────

  it('classifies matching errors', () => {
    classifier.registerPattern({
      category: 'timeout',
      pattern: /timeout|timed out/i,
      severity: 'warning',
      retryable: true,
    });
    const r = classifier.classify(new Error('Request timed out'));
    expect(r.classified).toBe(true);
    expect(r.category).toBe('timeout');
    expect(r.severity).toBe('warning');
    expect(r.retryable).toBe(true);
  });

  it('classifies string errors', () => {
    classifier.registerPattern({ category: 'auth', pattern: /unauthorized|forbidden/i });
    const r = classifier.classify('Unauthorized access');
    expect(r.classified).toBe(true);
    expect(r.category).toBe('auth');
  });

  it('returns unknown for unmatched errors', () => {
    const r = classifier.classify(new Error('Something unexpected'));
    expect(r.classified).toBe(false);
    expect(r.category).toBe('unknown');
  });

  it('matches first pattern in order', () => {
    classifier.registerPattern({ category: 'specific', pattern: /rate limit exceeded/i });
    classifier.registerPattern({ category: 'general', pattern: /error/i });
    const r = classifier.classify('Rate limit exceeded error');
    expect(r.category).toBe('specific');
  });

  // ── Convenience Methods ──────────────────────────────────────────────

  it('categorize returns just the category', () => {
    classifier.registerPattern({ category: 'network', pattern: /ECONNREFUSED/i });
    expect(classifier.categorize('ECONNREFUSED')).toBe('network');
  });

  it('isRetryable checks retryability', () => {
    classifier.registerPattern({ category: 'timeout', pattern: /timeout/i, retryable: true });
    classifier.registerPattern({ category: 'auth', pattern: /auth/i, retryable: false });
    expect(classifier.isRetryable('Request timeout')).toBe(true);
    expect(classifier.isRetryable('Auth failed')).toBe(false);
  });

  // ── History ──────────────────────────────────────────────────────────

  it('tracks classification history', () => {
    classifier.registerPattern({ category: 'net', pattern: /network/i });
    classifier.classify('Network error');
    classifier.classify('Unknown error');
    const history = classifier.getHistory();
    expect(history).toHaveLength(2);
  });

  it('filters history by category', () => {
    classifier.registerPattern({ category: 'net', pattern: /network/i });
    classifier.classify('Network error');
    classifier.classify('Unknown error');
    expect(classifier.getHistory({ category: 'net' })).toHaveLength(1);
  });

  it('filters history by severity', () => {
    classifier.registerPattern({ category: 'warn', pattern: /warn/i, severity: 'warning' });
    classifier.classify('warn msg');
    classifier.classify('other msg');
    expect(classifier.getHistory({ severity: 'warning' })).toHaveLength(1);
  });

  // ── Frequency ────────────────────────────────────────────────────────

  it('tracks error frequency', () => {
    classifier.registerPattern({ category: 'net', pattern: /network/i });
    classifier.classify('Network error 1');
    classifier.classify('Network error 2');
    classifier.classify('Other error');
    const freq = classifier.getFrequency();
    expect(freq).toHaveLength(2);
    expect(freq[0].category).toBe('net');
    expect(freq[0].count).toBe(2);
  });

  it('gets frequency for specific category', () => {
    classifier.registerPattern({ category: 'net', pattern: /network/i });
    classifier.classify('Network error');
    const f = classifier.getCategoryFrequency('net');
    expect(f).not.toBeNull();
    expect(f!.count).toBe(1);
    expect(classifier.getCategoryFrequency('nope')).toBeNull();
  });

  // ── Stats ────────────────────────────────────────────────────────────

  it('tracks stats', () => {
    classifier.registerPattern({ category: 'net', pattern: /network/i });
    classifier.classify('Network error');
    classifier.classify('Unknown error');
    const stats = classifier.getStats();
    expect(stats.totalPatterns).toBe(1);
    expect(stats.totalClassified).toBe(1);
    expect(stats.totalUnclassified).toBe(1);
    expect(stats.categories).toBe(2);
  });

  // ── Destroy ──────────────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    classifier.registerPattern({ category: 'net', pattern: /network/i });
    classifier.classify('Network error');
    classifier.destroy();
    expect(classifier.getStats().totalPatterns).toBe(0);
    expect(classifier.getStats().totalClassified).toBe(0);
  });
});
