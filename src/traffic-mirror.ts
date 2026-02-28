/**
 * TrafficMirror — Duplicates tool call requests to a shadow backend.
 *
 * Fire-and-forget: mirror response is logged but never returned to the client.
 * Useful for testing new MCP server versions against real production traffic.
 *
 * Zero external dependencies. Uses Node.js built-in http/https.
 */

import * as http from 'http';
import * as https from 'https';
import { EventEmitter } from 'events';
import { JsonRpcRequest } from './types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MirrorConfig {
  /** URL of the mirror backend (Streamable HTTP). */
  url: string;
  /** Percentage of traffic to mirror (0-100). Default: 100. */
  percentage: number;
  /** Timeout for mirror requests in ms. Default: 5000. */
  timeoutMs: number;
}

export interface MirrorResult {
  tool: string;
  mirrorUrl: string;
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
  timestamp: string;
}

export interface MirrorStats {
  enabled: boolean;
  mirrorUrl: string | null;
  percentage: number;
  totalMirrored: number;
  totalSuccess: number;
  totalErrors: number;
  avgLatencyMs: number;
  recentResults: MirrorResult[];
}

// ─── TrafficMirror Class ────────────────────────────────────────────────────

export class TrafficMirror extends EventEmitter {
  private config: MirrorConfig | null = null;
  private results: MirrorResult[] = [];
  private totalMirrored = 0;
  private totalSuccess = 0;
  private totalErrors = 0;
  private totalLatency = 0;
  private readonly maxResults = 100;

  constructor(config?: Partial<MirrorConfig>) {
    super();
    if (config?.url) {
      this.config = {
        url: config.url,
        percentage: Math.min(100, Math.max(0, config.percentage ?? 100)),
        timeoutMs: config.timeoutMs ?? 5000,
      };
    }
  }

  /**
   * Mirror a tool call request to the shadow backend.
   * Fire-and-forget: never blocks the primary response path.
   */
  mirror(request: JsonRpcRequest, toolName: string): void {
    if (!this.config) return;

    // Percentage sampling
    if (this.config.percentage < 100) {
      if (Math.random() * 100 >= this.config.percentage) return;
    }

    const startTime = Date.now();
    this.totalMirrored++;

    // Fire and forget — errors are captured but never thrown
    this.sendMirrorRequest(request, toolName, startTime).catch(() => {
      // Already handled in sendMirrorRequest
    });
  }

  private async sendMirrorRequest(request: JsonRpcRequest, toolName: string, startTime: number): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        const mirrorUrl = new URL(this.config!.url);
        const payload = JSON.stringify(request);
        const isHttps = mirrorUrl.protocol === 'https:';
        const transport = isHttps ? https : http;

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': String(Buffer.byteLength(payload)),
          'X-Mirror': 'true',
        };

        const options: http.RequestOptions = {
          hostname: mirrorUrl.hostname,
          port: mirrorUrl.port || (isHttps ? 443 : 80),
          path: mirrorUrl.pathname + mirrorUrl.search,
          method: 'POST',
          headers,
          timeout: this.config!.timeoutMs,
        };

        const req = transport.request(options, (res) => {
          // Consume response body to free socket
          let bodySize = 0;
          res.on('data', (chunk: Buffer) => {
            bodySize += chunk.length;
            // Cap at 1MB to prevent memory issues
            if (bodySize > 1_048_576) {
              req.destroy();
            }
          });
          res.on('end', () => {
            const latencyMs = Date.now() - startTime;
            const result: MirrorResult = {
              tool: toolName,
              mirrorUrl: this.config!.url,
              statusCode: res.statusCode || null,
              latencyMs,
              error: null,
              timestamp: new Date().toISOString(),
            };
            this.recordResult(result, true);
            resolve();
          });
        });

        req.on('error', (err) => {
          const latencyMs = Date.now() - startTime;
          const result: MirrorResult = {
            tool: toolName,
            mirrorUrl: this.config!.url,
            statusCode: null,
            latencyMs,
            error: err.message,
            timestamp: new Date().toISOString(),
          };
          this.recordResult(result, false);
          resolve();
        });

        req.on('timeout', () => {
          req.destroy();
          const latencyMs = Date.now() - startTime;
          const result: MirrorResult = {
            tool: toolName,
            mirrorUrl: this.config!.url,
            statusCode: null,
            latencyMs,
            error: `Mirror request timed out after ${this.config!.timeoutMs}ms`,
            timestamp: new Date().toISOString(),
          };
          this.recordResult(result, false);
          resolve();
        });

        req.write(payload);
        req.end();
      } catch (err) {
        const latencyMs = Date.now() - startTime;
        const result: MirrorResult = {
          tool: toolName,
          mirrorUrl: this.config?.url || 'unknown',
          statusCode: null,
          latencyMs,
          error: err instanceof Error ? err.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        };
        this.recordResult(result, false);
        resolve();
      }
    });
  }

  private recordResult(result: MirrorResult, success: boolean): void {
    if (success) {
      this.totalSuccess++;
    } else {
      this.totalErrors++;
    }
    this.totalLatency += result.latencyMs;

    this.results.push(result);
    if (this.results.length > this.maxResults) {
      this.results = this.results.slice(-this.maxResults);
    }

    this.emit('mirror-result', result);
  }

  /**
   * Configure or update the mirror.
   */
  configure(config: Partial<MirrorConfig>): void {
    if (!config.url) {
      this.config = null;
      return;
    }
    this.config = {
      url: config.url,
      percentage: Math.min(100, Math.max(0, config.percentage ?? 100)),
      timeoutMs: config.timeoutMs ?? 5000,
    };
  }

  /**
   * Disable mirroring.
   */
  disable(): void {
    this.config = null;
  }

  /**
   * Get mirror statistics.
   */
  stats(): MirrorStats {
    return {
      enabled: this.config !== null,
      mirrorUrl: this.config?.url || null,
      percentage: this.config?.percentage || 0,
      totalMirrored: this.totalMirrored,
      totalSuccess: this.totalSuccess,
      totalErrors: this.totalErrors,
      avgLatencyMs: this.totalMirrored > 0 ? Math.round(this.totalLatency / this.totalMirrored) : 0,
      recentResults: [...this.results].reverse().slice(0, 20),
    };
  }

  /**
   * Clear stats and results.
   */
  clearStats(): void {
    this.results = [];
    this.totalMirrored = 0;
    this.totalSuccess = 0;
    this.totalErrors = 0;
    this.totalLatency = 0;
  }

  /**
   * Check if mirroring is enabled.
   */
  get enabled(): boolean {
    return this.config !== null;
  }
}
