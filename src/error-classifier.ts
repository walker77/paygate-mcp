/**
 * ErrorClassifier — Classify and categorize errors for analytics and routing.
 *
 * Register error patterns, classify incoming errors by matching,
 * and track error frequency for prioritization.
 *
 * @example
 * ```ts
 * const classifier = new ErrorClassifier();
 *
 * classifier.registerPattern({
 *   category: 'rate_limit',
 *   pattern: /rate limit|too many requests|429/i,
 *   severity: 'warning',
 *   retryable: true,
 * });
 *
 * const result = classifier.classify(new Error('Rate limit exceeded'));
 * // { category: 'rate_limit', severity: 'warning', retryable: true, ... }
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface ErrorPattern {
  id: string;
  category: string;
  pattern: RegExp;
  severity: ErrorSeverity;
  retryable: boolean;
  description: string;
}

export interface PatternRegistration {
  category: string;
  pattern: RegExp;
  severity?: ErrorSeverity;
  retryable?: boolean;
  description?: string;
}

export interface ClassifyResult {
  classified: boolean;
  category: string;
  severity: ErrorSeverity;
  retryable: boolean;
  patternId: string | null;
  description: string;
  message: string;
  timestamp: number;
}

export interface ErrorFrequency {
  category: string;
  count: number;
  lastSeen: number;
  firstSeen: number;
}

export interface ErrorClassifierConfig {
  /** Max classification history. Default 10000. */
  maxHistory?: number;
  /** Max registered patterns. Default 500. */
  maxPatterns?: number;
  /** Default severity for unclassified errors. Default 'error'. */
  defaultSeverity?: ErrorSeverity;
}

export interface ErrorClassifierStats {
  totalPatterns: number;
  totalClassified: number;
  totalUnclassified: number;
  categories: number;
  topCategories: ErrorFrequency[];
}

// ── Implementation ───────────────────────────────────────────────────

export class ErrorClassifier {
  private patterns = new Map<string, ErrorPattern>();
  private history: ClassifyResult[] = [];
  private frequency = new Map<string, ErrorFrequency>();
  private nextId = 1;

  private maxHistory: number;
  private maxPatterns: number;
  private defaultSeverity: ErrorSeverity;

  // Stats
  private totalClassified = 0;
  private totalUnclassified = 0;

  constructor(config: ErrorClassifierConfig = {}) {
    this.maxHistory = config.maxHistory ?? 10_000;
    this.maxPatterns = config.maxPatterns ?? 500;
    this.defaultSeverity = config.defaultSeverity ?? 'error';
  }

  // ── Pattern Management ────────────────────────────────────────

  /** Register an error pattern. */
  registerPattern(reg: PatternRegistration): ErrorPattern {
    if (!reg.category) throw new Error('Category is required');
    if (!reg.pattern) throw new Error('Pattern is required');
    if (this.patterns.size >= this.maxPatterns) {
      throw new Error(`Maximum ${this.maxPatterns} patterns reached`);
    }

    const pattern: ErrorPattern = {
      id: `ep_${this.nextId++}`,
      category: reg.category,
      pattern: reg.pattern,
      severity: reg.severity ?? this.defaultSeverity,
      retryable: reg.retryable ?? false,
      description: reg.description ?? '',
    };

    this.patterns.set(pattern.id, pattern);
    return pattern;
  }

  /** Remove a pattern by ID. */
  removePattern(id: string): boolean {
    return this.patterns.delete(id);
  }

  /** Get a pattern by ID. */
  getPattern(id: string): ErrorPattern | null {
    return this.patterns.get(id) ?? null;
  }

  /** List all patterns. */
  listPatterns(): ErrorPattern[] {
    return [...this.patterns.values()];
  }

  // ── Classification ─────────────────────────────────────────────

  /** Classify an error. */
  classify(error: Error | string): ClassifyResult {
    const message = typeof error === 'string' ? error : error.message;
    const now = Date.now();

    // Try to match against registered patterns
    for (const pattern of this.patterns.values()) {
      if (pattern.pattern.test(message)) {
        const result: ClassifyResult = {
          classified: true,
          category: pattern.category,
          severity: pattern.severity,
          retryable: pattern.retryable,
          patternId: pattern.id,
          description: pattern.description,
          message,
          timestamp: now,
        };

        this.recordResult(result);
        this.totalClassified++;
        return result;
      }
    }

    // Unclassified
    const result: ClassifyResult = {
      classified: false,
      category: 'unknown',
      severity: this.defaultSeverity,
      retryable: false,
      patternId: null,
      description: 'No matching pattern found',
      message,
      timestamp: now,
    };

    this.recordResult(result);
    this.totalUnclassified++;
    return result;
  }

  /** Classify and return just the category name. */
  categorize(error: Error | string): string {
    return this.classify(error).category;
  }

  /** Check if an error is retryable. */
  isRetryable(error: Error | string): boolean {
    return this.classify(error).retryable;
  }

  // ── Query ──────────────────────────────────────────────────────

  /** Get classification history. */
  getHistory(options?: { category?: string; severity?: ErrorSeverity; limit?: number }): ClassifyResult[] {
    let results = [...this.history];
    if (options?.category) results = results.filter(r => r.category === options.category);
    if (options?.severity) results = results.filter(r => r.severity === options.severity);
    const limit = options?.limit ?? 50;
    return results.slice(-limit);
  }

  /** Get error frequency by category. */
  getFrequency(): ErrorFrequency[] {
    return [...this.frequency.values()].sort((a, b) => b.count - a.count);
  }

  /** Get frequency for a specific category. */
  getCategoryFrequency(category: string): ErrorFrequency | null {
    return this.frequency.get(category) ?? null;
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): ErrorClassifierStats {
    const topCategories = this.getFrequency().slice(0, 5);
    return {
      totalPatterns: this.patterns.size,
      totalClassified: this.totalClassified,
      totalUnclassified: this.totalUnclassified,
      categories: this.frequency.size,
      topCategories,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.patterns.clear();
    this.history = [];
    this.frequency.clear();
    this.totalClassified = 0;
    this.totalUnclassified = 0;
  }

  // ── Private ───────────────────────────────────────────────────

  private recordResult(result: ClassifyResult): void {
    this.history.push(result);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }

    const existing = this.frequency.get(result.category);
    if (existing) {
      existing.count++;
      existing.lastSeen = result.timestamp;
    } else {
      this.frequency.set(result.category, {
        category: result.category,
        count: 1,
        lastSeen: result.timestamp,
        firstSeen: result.timestamp,
      });
    }
  }
}
