/**
 * RetryPolicy — Configurable automatic retry with exponential backoff and jitter.
 *
 * Wraps downstream MCP tool call forwarding to retry transient failures.
 * Prevents credits being charged for errors that would succeed on retry.
 *
 * Features:
 *   - Exponential backoff with optional jitter
 *   - Retry budget (max % of traffic as retries to prevent retry storms)
 *   - Configurable retryable error patterns
 *   - Per-tool override support
 *   - Stats tracking (attempts, successes, exhausted)
 *
 * Zero external dependencies.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RetryConfig {
  /** Max retry attempts (0 = disabled). Default 3. */
  maxRetries: number;
  /** Base backoff in ms. Default 200. */
  backoffBaseMs: number;
  /** Max backoff cap in ms. Default 5000. */
  backoffMaxMs: number;
  /** Add random jitter to backoff. Default true. */
  jitter: boolean;
  /** Error codes/patterns that trigger retries. Default: internal error, timeout. */
  retryableErrors: Array<string | number>;
  /**
   * Max percentage of recent traffic that can be retries (0-100).
   * Prevents retry storms. Default 20.
   */
  retryBudgetPercent: number;
}

export interface RetryStats {
  enabled: boolean;
  config: RetryConfig;
  totalAttempts: number;
  totalSuccessAfterRetry: number;
  totalExhausted: number;
  recentTraffic: number;
  recentRetries: number;
  budgetUtilization: number;
  perTool: Record<string, { attempts: number; successes: number; exhausted: number }>;
}

export interface RetryResult<T> {
  result: T;
  attempts: number;
  retriedFrom?: string;
}

// ─── Default config ─────────────────────────────────────────────────────────

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  backoffBaseMs: 200,
  backoffMaxMs: 5000,
  jitter: true,
  retryableErrors: [-32603, -32004, 'ETIMEDOUT', 'ECONNRESET', 'INTERNAL_ERROR'],
  retryBudgetPercent: 20,
};

// ─── RetryPolicy Class ─────────────────────────────────────────────────────

export class RetryPolicy {
  private config: RetryConfig;
  private enabled: boolean;

  // Stats
  private totalAttempts = 0;
  private totalSuccessAfterRetry = 0;
  private totalExhausted = 0;
  private perToolStats = new Map<string, { attempts: number; successes: number; exhausted: number }>();

  // Sliding window for budget tracking (last 60 seconds)
  private trafficWindow: number[] = [];
  private retryWindow: number[] = [];
  private readonly windowDurationMs = 60_000;

  constructor(config?: Partial<RetryConfig>) {
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
    this.enabled = this.config.maxRetries > 0;
  }

  /**
   * Update retry configuration at runtime.
   */
  configure(updates: Partial<RetryConfig>): RetryConfig {
    if (updates.maxRetries !== undefined) this.config.maxRetries = Math.max(0, updates.maxRetries);
    if (updates.backoffBaseMs !== undefined) this.config.backoffBaseMs = Math.max(10, updates.backoffBaseMs);
    if (updates.backoffMaxMs !== undefined) this.config.backoffMaxMs = Math.max(100, updates.backoffMaxMs);
    if (updates.jitter !== undefined) this.config.jitter = updates.jitter;
    if (updates.retryableErrors !== undefined) this.config.retryableErrors = updates.retryableErrors;
    if (updates.retryBudgetPercent !== undefined) this.config.retryBudgetPercent = Math.min(100, Math.max(0, updates.retryBudgetPercent));
    this.enabled = this.config.maxRetries > 0;
    return { ...this.config };
  }

  /**
   * Execute a function with retry policy.
   * The function should throw on retryable errors.
   */
  async execute<T>(
    toolName: string,
    fn: () => Promise<T>,
    isRetryable?: (error: unknown) => boolean,
  ): Promise<RetryResult<T>> {
    this.recordTraffic();

    if (!this.enabled) {
      const result = await fn();
      return { result, attempts: 1 };
    }

    const checker = isRetryable || ((err: unknown) => this.isRetryableError(err));
    let lastError: unknown;
    let attempts = 0;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      attempts = attempt + 1;

      try {
        const result = await fn();

        // If this was a retry that succeeded, record it
        if (attempt > 0) {
          this.totalSuccessAfterRetry++;
          this.getToolStats(toolName).successes++;
        }

        return {
          result,
          attempts,
          retriedFrom: attempt > 0 ? String(lastError) : undefined,
        };
      } catch (err) {
        lastError = err;

        // Don't retry if this isn't a retryable error
        if (!checker(err)) {
          throw err;
        }

        // Don't retry if we've exhausted attempts
        if (attempt >= this.config.maxRetries) {
          break;
        }

        // Check retry budget
        if (!this.withinBudget()) {
          break;
        }

        // Record retry attempt
        this.totalAttempts++;
        this.getToolStats(toolName).attempts++;
        this.recordRetry();

        // Wait with exponential backoff
        const delay = this.calculateBackoff(attempt);
        await this.sleep(delay);
      }
    }

    // All retries exhausted
    this.totalExhausted++;
    this.getToolStats(toolName).exhausted++;
    throw lastError;
  }

  /**
   * Check if an error is retryable based on config.
   */
  isRetryableError(error: unknown): boolean {
    if (!error) return false;

    const errObj = error as Record<string, unknown>;
    const errCode = errObj.code;
    const errMessage = String(errObj.message || errObj || '');

    for (const pattern of this.config.retryableErrors) {
      if (typeof pattern === 'number' && errCode === pattern) return true;
      if (typeof pattern === 'string') {
        if (errCode === pattern) return true;
        if (errMessage.includes(pattern)) return true;
      }
    }

    return false;
  }

  /**
   * Calculate backoff delay with optional jitter.
   */
  private calculateBackoff(attempt: number): number {
    const base = this.config.backoffBaseMs * Math.pow(2, attempt);
    const capped = Math.min(base, this.config.backoffMaxMs);

    if (this.config.jitter) {
      // Full jitter: random between 0 and capped
      return Math.floor(Math.random() * capped);
    }

    return capped;
  }

  /**
   * Check if we're within the retry budget.
   */
  private withinBudget(): boolean {
    if (this.config.retryBudgetPercent >= 100) return true;

    this.pruneWindows();
    const traffic = this.trafficWindow.length;
    const retries = this.retryWindow.length;

    // Need a meaningful sample before enforcing budget (avoid blocking
    // retries on first few requests during cold start).
    if (traffic < 10) return true;

    const currentPercent = (retries / traffic) * 100;
    return currentPercent < this.config.retryBudgetPercent;
  }

  private recordTraffic(): void {
    this.trafficWindow.push(Date.now());
  }

  private recordRetry(): void {
    this.retryWindow.push(Date.now());
  }

  private pruneWindows(): void {
    const cutoff = Date.now() - this.windowDurationMs;
    this.trafficWindow = this.trafficWindow.filter(t => t > cutoff);
    this.retryWindow = this.retryWindow.filter(t => t > cutoff);
  }

  private getToolStats(toolName: string) {
    let s = this.perToolStats.get(toolName);
    if (!s) {
      s = { attempts: 0, successes: 0, exhausted: 0 };
      this.perToolStats.set(toolName, s);
    }
    return s;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get retry statistics.
   */
  stats(): RetryStats {
    this.pruneWindows();
    const traffic = this.trafficWindow.length;
    const retries = this.retryWindow.length;

    const perTool: Record<string, { attempts: number; successes: number; exhausted: number }> = {};
    for (const [tool, s] of this.perToolStats) {
      perTool[tool] = { ...s };
    }

    return {
      enabled: this.enabled,
      config: { ...this.config },
      totalAttempts: this.totalAttempts,
      totalSuccessAfterRetry: this.totalSuccessAfterRetry,
      totalExhausted: this.totalExhausted,
      recentTraffic: traffic,
      recentRetries: retries,
      budgetUtilization: traffic > 0 ? Math.round((retries / traffic) * 100) : 0,
      perTool,
    };
  }

  /** Is retry policy enabled? */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Current config. */
  get currentConfig(): RetryConfig {
    return { ...this.config };
  }
}
