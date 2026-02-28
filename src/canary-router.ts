/**
 * CanaryRouter — Weighted traffic splitting between primary and canary backends.
 *
 * Enables zero-downtime MCP server upgrades by splitting tool-call traffic
 * between a primary and canary MCP server process. The canary weight (0-100%)
 * determines the percentage of requests routed to the canary.
 *
 * Uses crypto.randomInt for unbiased routing decisions.
 * Tracks per-backend call counts and error rates.
 *
 * Zero external dependencies.
 */

import * as crypto from 'crypto';
import { EventEmitter } from 'events';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CanaryConfig {
  /** Command to spawn the canary MCP server. */
  serverCommand: string;
  /** Args for the canary server command. */
  serverArgs: string[];
  /** Percentage of traffic to route to canary (0-100). */
  weight: number;
}

export interface CanaryStats {
  enabled: boolean;
  weight: number;
  canaryCommand: string | null;
  primaryCalls: number;
  canaryCalls: number;
  primaryErrors: number;
  canaryErrors: number;
  createdAt: string | null;
}

export type CanaryBackend = 'primary' | 'canary';

export interface CanaryDecision {
  backend: CanaryBackend;
  weight: number;
}

// ─── CanaryRouter Class ─────────────────────────────────────────────────────

export class CanaryRouter extends EventEmitter {
  private config: CanaryConfig | null = null;
  private primaryCalls = 0;
  private canaryCalls = 0;
  private primaryErrors = 0;
  private canaryErrors = 0;
  private createdAt: string | null = null;

  constructor() {
    super();
  }

  /**
   * Enable canary routing with the given config.
   * The actual canary process spawning is handled by the server — this class
   * only manages the routing decision and stats.
   */
  enable(config: CanaryConfig): void {
    if (!config.serverCommand) {
      throw new Error('Canary server command is required');
    }
    this.config = {
      serverCommand: config.serverCommand,
      serverArgs: config.serverArgs || [],
      weight: Math.min(100, Math.max(0, config.weight)),
    };
    this.primaryCalls = 0;
    this.canaryCalls = 0;
    this.primaryErrors = 0;
    this.canaryErrors = 0;
    this.createdAt = new Date().toISOString();
    this.emit('enabled', this.config);
  }

  /**
   * Disable canary routing.
   */
  disable(): void {
    this.config = null;
    this.emit('disabled');
  }

  /**
   * Update canary weight without restart.
   */
  setWeight(weight: number): void {
    if (!this.config) throw new Error('Canary not enabled');
    this.config.weight = Math.min(100, Math.max(0, weight));
    this.emit('weight-changed', this.config.weight);
  }

  /**
   * Route a request to primary or canary based on weight.
   * Uses crypto.randomInt for unbiased routing.
   */
  route(): CanaryDecision {
    if (!this.config || this.config.weight === 0) {
      this.primaryCalls++;
      return { backend: 'primary', weight: 0 };
    }

    if (this.config.weight >= 100) {
      this.canaryCalls++;
      return { backend: 'canary', weight: 100 };
    }

    // crypto.randomInt(100) returns [0, 100)
    const roll = crypto.randomInt(100);
    if (roll < this.config.weight) {
      this.canaryCalls++;
      return { backend: 'canary', weight: this.config.weight };
    }

    this.primaryCalls++;
    return { backend: 'primary', weight: this.config.weight };
  }

  /**
   * Record an error for a backend.
   */
  recordError(backend: CanaryBackend): void {
    if (backend === 'primary') {
      this.primaryErrors++;
    } else {
      this.canaryErrors++;
    }
  }

  /**
   * Get canary statistics.
   */
  stats(): CanaryStats {
    return {
      enabled: this.config !== null,
      weight: this.config?.weight ?? 0,
      canaryCommand: this.config
        ? `${this.config.serverCommand} ${this.config.serverArgs.join(' ')}`.trim()
        : null,
      primaryCalls: this.primaryCalls,
      canaryCalls: this.canaryCalls,
      primaryErrors: this.primaryErrors,
      canaryErrors: this.canaryErrors,
      createdAt: this.createdAt,
    };
  }

  /**
   * Check if canary routing is enabled.
   */
  get enabled(): boolean {
    return this.config !== null;
  }

  /**
   * Get current weight.
   */
  get weight(): number {
    return this.config?.weight ?? 0;
  }

  /**
   * Get canary config (if enabled).
   */
  get canaryConfig(): CanaryConfig | null {
    return this.config ? { ...this.config } : null;
  }
}
