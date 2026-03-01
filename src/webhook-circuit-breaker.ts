/**
 * WebhookCircuitBreaker — Per-URL circuit breaker for webhook delivery.
 *
 * Protect webhook endpoints from cascading failures using circuit
 * breaker pattern with open/half-open/closed states.
 *
 * @example
 * ```ts
 * const cb = new WebhookCircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30000 });
 *
 * if (cb.canSend('https://example.com/hook')) {
 *   try {
 *     await deliver(payload);
 *     cb.recordSuccess('https://example.com/hook');
 *   } catch {
 *     cb.recordFailure('https://example.com/hook');
 *   }
 * }
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitStatus {
  url: string;
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  openedAt: number | null;
  halfOpenAt: number | null;
}

export interface WebhookCircuitBreakerConfig {
  /** Failures before opening circuit. Default 5. */
  failureThreshold?: number;
  /** Time in ms before trying half-open. Default 30000. */
  resetTimeoutMs?: number;
  /** Successes in half-open to close circuit. Default 2. */
  halfOpenSuccesses?: number;
  /** Max tracked URLs. Default 1000. */
  maxUrls?: number;
}

export interface WebhookCircuitBreakerStats {
  trackedUrls: number;
  closedCircuits: number;
  openCircuits: number;
  halfOpenCircuits: number;
  totalFailures: number;
  totalSuccesses: number;
}

// ── Implementation ───────────────────────────────────────────────────

interface CircuitEntry {
  state: CircuitState;
  failures: number;
  successes: number;
  consecutiveFailures: number;
  halfOpenSuccesses: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  openedAt: number | null;
}

export class WebhookCircuitBreaker {
  private circuits = new Map<string, CircuitEntry>();
  private failureThreshold: number;
  private resetTimeoutMs: number;
  private halfOpenSuccessThreshold: number;
  private maxUrls: number;

  // Stats
  private totalFailures = 0;
  private totalSuccesses = 0;

  constructor(config: WebhookCircuitBreakerConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? 5;
    this.resetTimeoutMs = config.resetTimeoutMs ?? 30_000;
    this.halfOpenSuccessThreshold = config.halfOpenSuccesses ?? 2;
    this.maxUrls = config.maxUrls ?? 1000;
  }

  // ── Core Operations ─────────────────────────────────────────────

  /** Check if a URL's circuit allows sending. */
  canSend(url: string): boolean {
    const entry = this.circuits.get(url);
    if (!entry) return true; // No circuit = closed = allow

    this.maybeTransitionToHalfOpen(entry);

    return entry.state !== 'open';
  }

  /** Record a successful delivery. */
  recordSuccess(url: string): void {
    const entry = this.getOrCreate(url);
    this.totalSuccesses++;
    entry.successes++;
    entry.lastSuccessAt = Date.now();
    entry.consecutiveFailures = 0;

    if (entry.state === 'half_open') {
      entry.halfOpenSuccesses++;
      if (entry.halfOpenSuccesses >= this.halfOpenSuccessThreshold) {
        entry.state = 'closed';
        entry.openedAt = null;
        entry.halfOpenSuccesses = 0;
      }
    }
  }

  /** Record a failed delivery. */
  recordFailure(url: string): void {
    const entry = this.getOrCreate(url);
    this.totalFailures++;
    entry.failures++;
    entry.consecutiveFailures++;
    entry.lastFailureAt = Date.now();

    if (entry.state === 'half_open') {
      // Failed during half-open — reopen
      entry.state = 'open';
      entry.openedAt = Date.now();
      entry.halfOpenSuccesses = 0;
    } else if (entry.state === 'closed' && entry.consecutiveFailures >= this.failureThreshold) {
      entry.state = 'open';
      entry.openedAt = Date.now();
    }
  }

  // ── Query ───────────────────────────────────────────────────────

  /** Get circuit status for a URL. */
  getStatus(url: string): CircuitStatus {
    const entry = this.circuits.get(url);
    if (!entry) {
      return {
        url, state: 'closed', failures: 0, successes: 0,
        lastFailureAt: null, lastSuccessAt: null, openedAt: null, halfOpenAt: null,
      };
    }

    this.maybeTransitionToHalfOpen(entry);

    return {
      url,
      state: entry.state,
      failures: entry.failures,
      successes: entry.successes,
      lastFailureAt: entry.lastFailureAt,
      lastSuccessAt: entry.lastSuccessAt,
      openedAt: entry.openedAt,
      halfOpenAt: entry.state === 'half_open' ? entry.openedAt : null,
    };
  }

  /** Get all open circuits. */
  getOpenCircuits(): CircuitStatus[] {
    const results: CircuitStatus[] = [];
    for (const [url, entry] of this.circuits) {
      this.maybeTransitionToHalfOpen(entry);
      if (entry.state === 'open' || entry.state === 'half_open') {
        results.push(this.getStatus(url));
      }
    }
    return results;
  }

  /** Reset a URL's circuit to closed. */
  reset(url: string): boolean {
    const entry = this.circuits.get(url);
    if (!entry) return false;
    entry.state = 'closed';
    entry.consecutiveFailures = 0;
    entry.halfOpenSuccesses = 0;
    entry.openedAt = null;
    return true;
  }

  /** Remove a URL's circuit. */
  remove(url: string): boolean {
    return this.circuits.delete(url);
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): WebhookCircuitBreakerStats {
    let closed = 0, open = 0, halfOpen = 0;
    for (const entry of this.circuits.values()) {
      this.maybeTransitionToHalfOpen(entry);
      if (entry.state === 'closed') closed++;
      else if (entry.state === 'open') open++;
      else halfOpen++;
    }

    return {
      trackedUrls: this.circuits.size,
      closedCircuits: closed,
      openCircuits: open,
      halfOpenCircuits: halfOpen,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.circuits.clear();
    this.totalFailures = 0;
    this.totalSuccesses = 0;
  }

  // ── Private ───────────────────────────────────────────────────

  private getOrCreate(url: string): CircuitEntry {
    let entry = this.circuits.get(url);
    if (!entry) {
      if (this.circuits.size >= this.maxUrls) {
        // Evict oldest opened circuit
        let oldestUrl: string | null = null;
        let oldestTime = Infinity;
        for (const [u, e] of this.circuits) {
          const t = e.lastSuccessAt ?? e.lastFailureAt ?? 0;
          if (t < oldestTime) { oldestTime = t; oldestUrl = u; }
        }
        if (oldestUrl) this.circuits.delete(oldestUrl);
      }
      entry = {
        state: 'closed', failures: 0, successes: 0,
        consecutiveFailures: 0, halfOpenSuccesses: 0,
        lastFailureAt: null, lastSuccessAt: null, openedAt: null,
      };
      this.circuits.set(url, entry);
    }
    return entry;
  }

  private maybeTransitionToHalfOpen(entry: CircuitEntry): void {
    if (entry.state === 'open' && entry.openedAt) {
      if (Date.now() - entry.openedAt >= this.resetTimeoutMs) {
        entry.state = 'half_open';
        entry.halfOpenSuccesses = 0;
      }
    }
  }
}
