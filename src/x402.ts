/**
 * x402 Payment Protocol Support — HTTP 402-based micropayments.
 *
 * Implements the x402 protocol (coinbase/x402) as an optional payment method
 * alongside Stripe. When enabled, clients can pay for tool calls using
 * stablecoins (USDC) via the standard HTTP 402 flow:
 *
 *   1. Client calls /mcp without payment → 402 + PAYMENT-REQUIRED header
 *   2. Client signs payment → retries with X-PAYMENT header
 *   3. Server verifies via Facilitator → grants access
 *
 * This module is zero-blockchain-dependency: all verification is delegated
 * to an external Facilitator service (Coinbase, QuickNode, etc.).
 *
 * Config:
 *   x402: {
 *     enabled: true,
 *     payTo: '0x1234...',        // Recipient wallet address
 *     network: 'base',           // Blockchain network
 *     asset: '0xUSDC...',        // Token contract address
 *     facilitatorUrl: 'https://x402.org/facilitator',
 *     creditsPerDollar: 100,     // How many credits $1.00 buys
 *   }
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { X402Config } from './types';

// Re-export for convenience
export type { X402Config } from './types';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PaymentRequirements {
  x402Version: number;
  accepts: Array<{
    scheme: string;
    network: string;
    maxAmountRequired: string;
    resource: string;
    description: string;
    mimeType: string;
    payTo: string;
    asset: string;
    maxTimeoutSeconds: number;
  }>;
}

export interface X402VerifyResult {
  valid: boolean;
  /** Credits to award (based on payment amount). */
  creditsAwarded: number;
  /** Payment amount in USD (as string). */
  amountUsd?: string;
  /** Transaction hash if available. */
  txHash?: string;
  /** Error message if invalid. */
  error?: string;
}

export interface X402Stats {
  paymentsReceived: number;
  creditsAwarded: number;
  totalUsdReceived: number;
  failedVerifications: number;
  facilitatorErrors: number;
}

// ─── X402 Handler ────────────────────────────────────────────────────────────

export class X402Handler {
  private config: X402Config;
  private stats: X402Stats = {
    paymentsReceived: 0,
    creditsAwarded: 0,
    totalUsdReceived: 0,
    failedVerifications: 0,
    facilitatorErrors: 0,
  };

  constructor(config: X402Config) {
    this.config = config;
  }

  /**
   * Check if a request has an X-PAYMENT header (x402 payment attempt).
   */
  hasPayment(req: http.IncomingMessage): boolean {
    return !!req.headers['x-payment'];
  }

  /**
   * Generate the PAYMENT-REQUIRED header value for a 402 response.
   * Call this when a client needs to pay and doesn't have credits/API key.
   *
   * @param creditsRequired  Number of credits needed
   * @param resource         Resource identifier (e.g., '/mcp')
   */
  generatePaymentRequired(creditsRequired: number, resource: string): string {
    const amountUsd = creditsRequired / this.config.creditsPerDollar;
    // Format as USD string with at most 6 decimal places
    const amountStr = `$${amountUsd.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;

    const requirements: PaymentRequirements = {
      x402Version: 1,
      accepts: [{
        scheme: 'exact',
        network: this.config.network,
        maxAmountRequired: amountStr,
        resource,
        description: this.config.description || 'MCP tool call payment',
        mimeType: 'application/json',
        payTo: this.config.payTo,
        asset: this.config.asset,
        maxTimeoutSeconds: this.config.maxTimeoutSeconds || 60,
      }],
    };

    return Buffer.from(JSON.stringify(requirements)).toString('base64');
  }

  /**
   * Verify an X-PAYMENT header by forwarding to the Facilitator.
   * Returns the verification result with credits to award.
   */
  async verifyPayment(paymentHeader: string, creditsRequired: number, resource: string): Promise<X402VerifyResult> {
    try {
      // Decode the payment payload
      let paymentPayload: unknown;
      try {
        paymentPayload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf-8'));
      } catch {
        this.stats.failedVerifications++;
        return { valid: false, creditsAwarded: 0, error: 'Invalid X-PAYMENT header: not valid base64 JSON' };
      }

      // Generate the expected payment requirements
      const requirementsStr = this.generatePaymentRequired(creditsRequired, resource);
      const requirements = JSON.parse(Buffer.from(requirementsStr, 'base64').toString('utf-8'));

      // POST to Facilitator /verify endpoint
      const verifyUrl = `${this.config.facilitatorUrl.replace(/\/$/, '')}/verify`;
      const verifyBody = JSON.stringify({
        paymentPayload,
        paymentRequirements: requirements,
      });

      const response = await this.httpPost(verifyUrl, verifyBody);

      if (response.status >= 200 && response.status < 300) {
        const result = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;

        if (result.valid || result.success || result.verified) {
          const amountUsd = creditsRequired / this.config.creditsPerDollar;
          const creditsAwarded = creditsRequired;

          this.stats.paymentsReceived++;
          this.stats.creditsAwarded += creditsAwarded;
          this.stats.totalUsdReceived += amountUsd;

          return {
            valid: true,
            creditsAwarded,
            amountUsd: `$${amountUsd.toFixed(6)}`,
            txHash: result.txHash || result.transactionHash,
          };
        }

        this.stats.failedVerifications++;
        return {
          valid: false,
          creditsAwarded: 0,
          error: result.error || result.message || 'Payment verification failed',
        };
      }

      this.stats.facilitatorErrors++;
      return {
        valid: false,
        creditsAwarded: 0,
        error: `Facilitator error: HTTP ${response.status}`,
      };
    } catch (err: any) {
      this.stats.facilitatorErrors++;
      return {
        valid: false,
        creditsAwarded: 0,
        error: `Facilitator request failed: ${err.message}`,
      };
    }
  }

  /**
   * Write a 402 Payment Required response with x402 headers.
   */
  write402Response(
    res: http.ServerResponse,
    creditsRequired: number,
    resource: string,
    additionalMessage?: string,
  ): void {
    const paymentRequired = this.generatePaymentRequired(creditsRequired, resource);
    res.writeHead(402, {
      'Content-Type': 'application/json',
      'Payment-Required': paymentRequired,
    });
    res.end(JSON.stringify({
      error: 'Payment Required',
      message: additionalMessage || `This resource requires payment. Include X-PAYMENT header with signed payment proof.`,
      x402Version: 1,
      creditsRequired,
      network: this.config.network,
      asset: this.config.asset,
    }));
  }

  /**
   * Get x402 payment stats.
   */
  getStats(): X402Stats {
    return { ...this.stats };
  }

  /**
   * Get the current config (safe copy without sensitive fields).
   */
  getPublicConfig(): {
    enabled: boolean;
    network: string;
    payTo: string;
    creditsPerDollar: number;
  } {
    return {
      enabled: this.config.enabled,
      network: this.config.network,
      payTo: this.config.payTo,
      creditsPerDollar: this.config.creditsPerDollar,
    };
  }

  // ─── Internal HTTP client ───────────────────────────────────────────────────

  private httpPost(url: string, body: string): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const mod = isHttps ? https : http;

      const req = mod.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'PayGate-MCP/x402',
        },
        timeout: 15_000,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Facilitator request timeout')); });
      req.write(body);
      req.end();
    });
  }
}
