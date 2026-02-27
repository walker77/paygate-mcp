/**
 * CircuitBreaker — Detects failing backends and fails fast.
 *
 * States:
 *   CLOSED  — Normal operation. Requests pass through.
 *   OPEN    — Backend is failing. Requests rejected immediately (503).
 *   HALF_OPEN — After cooldown, one probe request allowed through.
 *
 * Transitions:
 *   CLOSED → OPEN: After N consecutive failures (threshold).
 *   OPEN → HALF_OPEN: After cooldown period expires.
 *   HALF_OPEN → CLOSED: If probe succeeds.
 *   HALF_OPEN → OPEN: If probe fails (reset cooldown timer).
 */

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  /** Consecutive failures before opening circuit. */
  threshold: number;
  /** Cooldown period in seconds before attempting recovery. */
  cooldownSeconds: number;
}

export interface CircuitStatus {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  openedAt: string | null;
  totalFailures: number;
  totalSuccesses: number;
  totalRejections: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private lastFailureAt: number | null = null;
  private openedAt: number | null = null;
  private totalFailures = 0;
  private totalSuccesses = 0;
  private totalRejections = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(config: CircuitBreakerConfig) {
    this.threshold = Math.max(1, config.threshold);
    this.cooldownMs = Math.max(1000, config.cooldownSeconds * 1000);
  }

  /**
   * Check if a request should be allowed through.
   * Returns true if allowed, false if circuit is open.
   */
  allowRequest(): boolean {
    if (this.state === 'closed') return true;

    if (this.state === 'open') {
      // Check if cooldown has expired → transition to half_open
      const now = Date.now();
      if (this.openedAt && now - this.openedAt >= this.cooldownMs) {
        this.state = 'half_open';
        return true; // Allow one probe request
      }
      this.totalRejections++;
      return false;
    }

    // half_open — allow the probe request (only one at a time)
    // In a simple implementation, we allow all requests in half_open
    // The first success/failure determines the next state.
    return true;
  }

  /**
   * Record a successful response from the backend.
   */
  recordSuccess(): void {
    this.totalSuccesses++;
    if (this.state === 'half_open') {
      // Probe succeeded → close circuit
      this.state = 'closed';
      this.consecutiveFailures = 0;
      this.openedAt = null;
    } else if (this.state === 'closed') {
      this.consecutiveFailures = 0;
    }
  }

  /**
   * Record a failed response from the backend.
   */
  recordFailure(): void {
    this.totalFailures++;
    this.consecutiveFailures++;
    this.lastFailureAt = Date.now();

    if (this.state === 'half_open') {
      // Probe failed → re-open circuit
      this.state = 'open';
      this.openedAt = Date.now();
    } else if (this.state === 'closed' && this.consecutiveFailures >= this.threshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }

  /**
   * Get current circuit status.
   */
  status(): CircuitStatus {
    // Re-check if cooldown has expired (for accurate state reporting)
    if (this.state === 'open' && this.openedAt && Date.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'half_open';
    }
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureAt: this.lastFailureAt ? new Date(this.lastFailureAt).toISOString() : null,
      openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      totalRejections: this.totalRejections,
    };
  }

  /**
   * Reset the circuit breaker to closed state.
   */
  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }
}
