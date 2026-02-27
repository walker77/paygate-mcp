/**
 * Stripe Checkout — Self-service credit purchases via Stripe Checkout Sessions.
 *
 * Zero dependencies: uses Node.js built-in https module to call Stripe's API.
 *
 * Flow:
 *   1. API key holder calls POST /stripe/checkout with desired credit package
 *   2. Server creates a Stripe Checkout Session
 *   3. Client redirects to Checkout URL
 *   4. After payment, Stripe sends webhook → StripeWebhookHandler auto-tops-up credits
 *
 * Configuration:
 *   - stripeSecretKey: Stripe secret key (sk_...)
 *   - creditPackages: Array of { id, credits, priceInCents, currency, name }
 *   - successUrl: Redirect URL after successful payment
 *   - cancelUrl: Redirect URL after cancelled payment
 *
 * @example
 * ```ts
 * const checkout = new StripeCheckout({
 *   secretKey: 'sk_live_...',
 *   packages: [
 *     { id: 'starter', credits: 100, priceInCents: 500, currency: 'usd', name: '100 Credits' },
 *     { id: 'pro', credits: 500, priceInCents: 2000, currency: 'usd', name: '500 Credits' },
 *     { id: 'enterprise', credits: 2000, priceInCents: 5000, currency: 'usd', name: '2000 Credits' },
 *   ],
 *   successUrl: 'https://example.com/portal?payment=success',
 *   cancelUrl: 'https://example.com/portal?payment=cancelled',
 * });
 * ```
 */

import * as https from 'https';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CreditPackage {
  /** Unique package identifier (e.g., 'starter', 'pro') */
  id: string;
  /** Number of credits included */
  credits: number;
  /** Price in smallest currency unit (e.g., cents for USD) */
  priceInCents: number;
  /** ISO 4217 currency code. Default: 'usd'. */
  currency: string;
  /** Human-readable package name shown in Checkout */
  name: string;
  /** Optional description shown in Checkout */
  description?: string;
}

export interface StripeCheckoutConfig {
  /** Stripe secret key (sk_live_... or sk_test_...) */
  secretKey: string;
  /** Available credit packages */
  packages: CreditPackage[];
  /** URL to redirect after successful payment. {SESSION_ID} is replaced with checkout session ID. */
  successUrl: string;
  /** URL to redirect after cancelled payment. */
  cancelUrl: string;
  /** Optional: collect customer email (if not using existing Stripe customer). Default: true. */
  collectEmail?: boolean;
}

export interface CheckoutSessionResult {
  /** Stripe Checkout Session ID */
  sessionId: string;
  /** URL to redirect the user to */
  url: string;
  /** The credit package purchased */
  packageId: string;
  /** Credits that will be added after payment */
  credits: number;
}

// ─── StripeCheckout ─────────────────────────────────────────────────────────

export class StripeCheckout {
  private readonly secretKey: string;
  private readonly packages: Map<string, CreditPackage>;
  private readonly successUrl: string;
  private readonly cancelUrl: string;
  private readonly collectEmail: boolean;

  constructor(config: StripeCheckoutConfig) {
    if (!config.secretKey) throw new Error('Stripe secret key is required');
    if (!config.packages || config.packages.length === 0) throw new Error('At least one credit package is required');
    if (!config.successUrl) throw new Error('successUrl is required');
    if (!config.cancelUrl) throw new Error('cancelUrl is required');

    this.secretKey = config.secretKey;
    this.packages = new Map(config.packages.map(p => [p.id, p]));
    this.successUrl = config.successUrl;
    this.cancelUrl = config.cancelUrl;
    this.collectEmail = config.collectEmail !== false;
  }

  /**
   * List available credit packages.
   */
  listPackages(): CreditPackage[] {
    return Array.from(this.packages.values());
  }

  /**
   * Get a specific package by ID.
   */
  getPackage(id: string): CreditPackage | undefined {
    return this.packages.get(id);
  }

  /**
   * Create a Stripe Checkout Session for purchasing credits.
   *
   * @param packageId - ID of the credit package to purchase
   * @param apiKey - The PayGate API key that will receive the credits
   * @param metadata - Optional additional metadata
   * @returns Checkout session with URL for redirect
   */
  async createSession(
    packageId: string,
    apiKey: string,
    metadata?: Record<string, string>,
  ): Promise<CheckoutSessionResult> {
    const pkg = this.packages.get(packageId);
    if (!pkg) {
      throw new Error(`Unknown package: ${packageId}`);
    }

    if (!apiKey || apiKey.length < 8) {
      throw new Error('Valid API key is required');
    }

    // Build the Stripe API request body
    const params = new URLSearchParams();
    params.set('mode', 'payment');
    params.set('success_url', this.successUrl.replace('{SESSION_ID}', '{CHECKOUT_SESSION_ID}'));
    params.set('cancel_url', this.cancelUrl);
    params.set('line_items[0][price_data][currency]', pkg.currency);
    params.set('line_items[0][price_data][unit_amount]', String(pkg.priceInCents));
    params.set('line_items[0][price_data][product_data][name]', pkg.name);
    if (pkg.description) {
      params.set('line_items[0][price_data][product_data][description]', pkg.description);
    }
    params.set('line_items[0][quantity]', '1');
    // PayGate metadata — used by StripeWebhookHandler to auto-top-up credits
    params.set('metadata[paygate_api_key]', apiKey);
    params.set('metadata[paygate_credits]', String(pkg.credits));
    params.set('metadata[paygate_package]', pkg.id);
    if (metadata) {
      for (const [k, v] of Object.entries(metadata)) {
        // Prevent overwriting PayGate metadata
        if (!k.startsWith('paygate_')) {
          params.set(`metadata[${k}]`, v);
        }
      }
    }
    if (this.collectEmail) {
      params.set('customer_creation', 'if_required');
    }

    const body = params.toString();

    // Call Stripe API
    const response = await this.stripeRequest('/v1/checkout/sessions', body);

    if (response.error) {
      throw new Error(`Stripe API error: ${response.error.message || JSON.stringify(response.error)}`);
    }

    return {
      sessionId: response.id,
      url: response.url,
      packageId: pkg.id,
      credits: pkg.credits,
    };
  }

  /**
   * Retrieve a Checkout Session (to verify status).
   */
  async getSession(sessionId: string): Promise<Record<string, unknown>> {
    if (!sessionId || sessionId.length < 10) {
      throw new Error('Invalid session ID');
    }
    return this.stripeRequest(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, null, 'GET');
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private stripeRequest(path: string, body: string | null, method = 'POST'): Promise<any> {
    return new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: 'api.stripe.com',
        port: 443,
        path,
        method,
        headers: {
          'Authorization': `Bearer ${this.secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Stripe-Version': '2024-12-18.acacia',
        },
        timeout: 30_000,
      };

      if (body) {
        (options.headers as Record<string, string>)['Content-Length'] = String(Buffer.byteLength(body));
      }

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid Stripe response: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Stripe API request timed out'));
      });

      if (body) req.write(body);
      req.end();
    });
  }
}
