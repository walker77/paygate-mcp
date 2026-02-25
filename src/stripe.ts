/**
 * Stripe Webhook Handler — Auto-top-up credits on successful payments.
 *
 * Zero dependencies: uses Node.js built-in crypto for HMAC-SHA256 signature
 * verification (Stripe's v1 signature scheme).
 *
 * Supported events:
 *   - checkout.session.completed  → One-time credit purchase
 *   - invoice.payment_succeeded   → Subscription renewal top-up
 *
 * Stripe Checkout metadata convention:
 *   metadata.paygate_api_key  = "pg_abc123..."   (the API key to top up)
 *   metadata.paygate_credits  = "500"            (credits to add)
 *
 * Usage:
 *   const handler = new StripeWebhookHandler(store, webhookSecret);
 *   const result = handler.handleWebhook(rawBody, signatureHeader);
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { KeyStore } from './store';

export interface StripeWebhookResult {
  success: boolean;
  event?: string;
  apiKey?: string;
  creditsAdded?: number;
  error?: string;
}

export class StripeWebhookHandler {
  private readonly store: KeyStore;
  private readonly webhookSecret: string;
  /** Max age for webhook events: 5 minutes (Stripe's recommendation) */
  private readonly toleranceSec: number;

  constructor(store: KeyStore, webhookSecret: string, toleranceSec = 300) {
    this.store = store;
    this.webhookSecret = webhookSecret;
    this.toleranceSec = toleranceSec;
  }

  /**
   * Process an incoming Stripe webhook event.
   *
   * @param rawBody - The raw request body as a string (NOT parsed JSON)
   * @param signatureHeader - The `Stripe-Signature` header value
   */
  handleWebhook(rawBody: string, signatureHeader: string): StripeWebhookResult {
    // 1. Verify signature
    if (!this.verifySignature(rawBody, signatureHeader)) {
      return { success: false, error: 'Invalid signature' };
    }

    // 2. Parse event
    let event: StripeEvent;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return { success: false, error: 'Invalid JSON body' };
    }

    if (!event || !event.type || !event.data?.object) {
      return { success: false, error: 'Malformed Stripe event' };
    }

    // 3. Route by event type
    switch (event.type) {
      case 'checkout.session.completed':
        return this.handleCheckoutCompleted(event);
      case 'invoice.payment_succeeded':
        return this.handleInvoicePayment(event);
      default:
        // Acknowledge unknown events without error (Stripe sends many event types)
        return { success: true, event: event.type };
    }
  }

  /**
   * Handle checkout.session.completed — one-time credit purchase.
   */
  private handleCheckoutCompleted(event: StripeEvent): StripeWebhookResult {
    const session = event.data.object;
    const metadata = session.metadata || {};

    const apiKey = metadata.paygate_api_key;
    const creditsStr = metadata.paygate_credits;

    if (!apiKey || !creditsStr) {
      // Not a PayGate-related checkout — ignore silently
      return { success: true, event: event.type };
    }

    const credits = Math.floor(Number(creditsStr));
    if (!Number.isFinite(credits) || credits <= 0) {
      return { success: false, error: 'Invalid credits value in metadata' };
    }

    // Verify payment status
    if (session.payment_status !== 'paid') {
      return { success: false, error: `Payment not completed: ${session.payment_status}` };
    }

    // Top up the key
    const topped = this.store.addCredits(apiKey, credits);
    if (!topped) {
      return { success: false, error: `API key not found or inactive: ${apiKey.slice(0, 10)}...` };
    }

    return {
      success: true,
      event: event.type,
      apiKey: apiKey.slice(0, 10) + '...',
      creditsAdded: credits,
    };
  }

  /**
   * Handle invoice.payment_succeeded — subscription renewal.
   */
  private handleInvoicePayment(event: StripeEvent): StripeWebhookResult {
    const invoice = event.data.object;

    // For subscriptions, metadata lives on the subscription
    // Stripe copies subscription_details.metadata to the invoice
    const metadata = invoice.subscription_details?.metadata
      || invoice.lines?.data?.[0]?.metadata
      || {};

    const apiKey = metadata.paygate_api_key;
    const creditsStr = metadata.paygate_credits;

    if (!apiKey || !creditsStr) {
      return { success: true, event: event.type };
    }

    const credits = Math.floor(Number(creditsStr));
    if (!Number.isFinite(credits) || credits <= 0) {
      return { success: false, error: 'Invalid credits value in metadata' };
    }

    const topped = this.store.addCredits(apiKey, credits);
    if (!topped) {
      return { success: false, error: `API key not found or inactive: ${apiKey.slice(0, 10)}...` };
    }

    return {
      success: true,
      event: event.type,
      apiKey: apiKey.slice(0, 10) + '...',
      creditsAdded: credits,
    };
  }

  /**
   * Verify the Stripe webhook signature using HMAC-SHA256.
   *
   * Stripe-Signature header format:
   *   t=<timestamp>,v1=<signature>[,v0=<test_signature>]
   *
   * The signed payload is: `${timestamp}.${rawBody}`
   */
  verifySignature(rawBody: string, signatureHeader: string): boolean {
    if (!signatureHeader || !rawBody) return false;

    const elements = signatureHeader.split(',');
    let timestamp: string | null = null;
    const signatures: string[] = [];

    for (const element of elements) {
      const [key, value] = element.split('=', 2);
      if (key === 't') timestamp = value;
      if (key === 'v1') signatures.push(value);
    }

    if (!timestamp || signatures.length === 0) return false;

    // Check timestamp freshness to prevent replay attacks
    const ts = parseInt(timestamp, 10);
    if (!Number.isFinite(ts)) return false;
    const age = Math.abs(Math.floor(Date.now() / 1000) - ts);
    if (age > this.toleranceSec) return false;

    // Compute expected signature
    const signedPayload = `${timestamp}.${rawBody}`;
    const expectedSig = createHmac('sha256', this.webhookSecret)
      .update(signedPayload, 'utf8')
      .digest('hex');

    // Compare using timing-safe comparison
    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    for (const sig of signatures) {
      const sigBuf = Buffer.from(sig, 'utf8');
      if (expectedBuf.length === sigBuf.length && timingSafeEqual(expectedBuf, sigBuf)) {
        return true;
      }
    }

    return false;
  }
}

// ─── Minimal Stripe Event Types (just what we need) ─────────────────────────

interface StripeEvent {
  id: string;
  type: string;
  data: {
    object: Record<string, any>;
  };
}
