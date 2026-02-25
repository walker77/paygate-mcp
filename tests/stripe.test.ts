/**
 * Tests for StripeWebhookHandler — Stripe integration for auto credit top-up.
 *
 * Uses HMAC-SHA256 to generate valid Stripe webhook signatures for testing.
 * No Stripe SDK required — verifies our zero-dependency implementation.
 */

import { createHmac } from 'crypto';
import { StripeWebhookHandler } from '../src/stripe';
import { KeyStore } from '../src/store';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

const WEBHOOK_SECRET = 'whsec_test_secret_12345';

function makeSignature(payload: string, secret: string, timestamp?: number): string {
  const ts = timestamp || Math.floor(Date.now() / 1000);
  const signedPayload = `${ts}.${payload}`;
  const sig = createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  return `t=${ts},v1=${sig}`;
}

function checkoutEvent(metadata: Record<string, string>, paymentStatus = 'paid'): string {
  return JSON.stringify({
    id: 'evt_test_checkout',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_123',
        payment_status: paymentStatus,
        metadata,
      },
    },
  });
}

function invoiceEvent(metadata: Record<string, string>): string {
  return JSON.stringify({
    id: 'evt_test_invoice',
    type: 'invoice.payment_succeeded',
    data: {
      object: {
        id: 'in_test_123',
        subscription_details: { metadata },
      },
    },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('StripeWebhookHandler', () => {
  let store: KeyStore;
  let handler: StripeWebhookHandler;

  beforeEach(() => {
    store = new KeyStore();
    handler = new StripeWebhookHandler(store, WEBHOOK_SECRET);
  });

  // ─── Signature Verification ─────────────────────────────────────────────────

  describe('Signature Verification', () => {
    test('should verify valid signature', () => {
      const body = checkoutEvent({ paygate_api_key: 'pg_test', paygate_credits: '100' });
      const sig = makeSignature(body, WEBHOOK_SECRET);
      expect(handler.verifySignature(body, sig)).toBe(true);
    });

    test('should reject invalid signature', () => {
      const body = checkoutEvent({ paygate_api_key: 'pg_test', paygate_credits: '100' });
      const sig = makeSignature(body, 'wrong_secret');
      expect(handler.verifySignature(body, sig)).toBe(false);
    });

    test('should reject tampered body', () => {
      const body = checkoutEvent({ paygate_api_key: 'pg_test', paygate_credits: '100' });
      const sig = makeSignature(body, WEBHOOK_SECRET);
      const tampered = body.replace('100', '999999');
      expect(handler.verifySignature(tampered, sig)).toBe(false);
    });

    test('should reject expired timestamp (>5 min old)', () => {
      const body = checkoutEvent({ paygate_api_key: 'pg_test', paygate_credits: '100' });
      const oldTimestamp = Math.floor(Date.now() / 1000) - 400; // 6.6 min ago
      const sig = makeSignature(body, WEBHOOK_SECRET, oldTimestamp);
      expect(handler.verifySignature(body, sig)).toBe(false);
    });

    test('should accept timestamp within tolerance', () => {
      const body = checkoutEvent({ paygate_api_key: 'pg_test', paygate_credits: '100' });
      const recentTimestamp = Math.floor(Date.now() / 1000) - 60; // 1 min ago
      const sig = makeSignature(body, WEBHOOK_SECRET, recentTimestamp);
      expect(handler.verifySignature(body, sig)).toBe(true);
    });

    test('should reject empty signature header', () => {
      expect(handler.verifySignature('body', '')).toBe(false);
    });

    test('should reject missing v1 component', () => {
      const ts = Math.floor(Date.now() / 1000);
      expect(handler.verifySignature('body', `t=${ts}`)).toBe(false);
    });

    test('should reject missing timestamp', () => {
      expect(handler.verifySignature('body', 'v1=abc123')).toBe(false);
    });
  });

  // ─── Checkout Session Completed ─────────────────────────────────────────────

  describe('checkout.session.completed', () => {
    test('should top up credits on successful checkout', () => {
      const record = store.createKey('stripe-test', 50);
      const body = checkoutEvent({
        paygate_api_key: record.key,
        paygate_credits: '200',
      });
      const sig = makeSignature(body, WEBHOOK_SECRET);

      const result = handler.handleWebhook(body, sig);

      expect(result.success).toBe(true);
      expect(result.event).toBe('checkout.session.completed');
      expect(result.creditsAdded).toBe(200);
      expect(store.getKey(record.key)!.credits).toBe(250); // 50 + 200
    });

    test('should ignore checkout without paygate metadata', () => {
      const body = checkoutEvent({ some_other_key: 'value' });
      const sig = makeSignature(body, WEBHOOK_SECRET);

      const result = handler.handleWebhook(body, sig);

      expect(result.success).toBe(true);
      expect(result.creditsAdded).toBeUndefined();
    });

    test('should reject checkout with unpaid status', () => {
      const record = store.createKey('stripe-test', 50);
      const body = checkoutEvent({
        paygate_api_key: record.key,
        paygate_credits: '200',
      }, 'unpaid');
      const sig = makeSignature(body, WEBHOOK_SECRET);

      const result = handler.handleWebhook(body, sig);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Payment not completed');
      expect(store.getKey(record.key)!.credits).toBe(50); // unchanged
    });

    test('should fail for nonexistent API key', () => {
      const body = checkoutEvent({
        paygate_api_key: 'pg_nonexistent_key_000000',
        paygate_credits: '100',
      });
      const sig = makeSignature(body, WEBHOOK_SECRET);

      const result = handler.handleWebhook(body, sig);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('should reject invalid credits value', () => {
      const record = store.createKey('stripe-test', 50);
      const body = checkoutEvent({
        paygate_api_key: record.key,
        paygate_credits: 'abc',
      });
      const sig = makeSignature(body, WEBHOOK_SECRET);

      const result = handler.handleWebhook(body, sig);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid credits');
    });

    test('should reject zero credits', () => {
      const record = store.createKey('stripe-test', 50);
      const body = checkoutEvent({
        paygate_api_key: record.key,
        paygate_credits: '0',
      });
      const sig = makeSignature(body, WEBHOOK_SECRET);

      const result = handler.handleWebhook(body, sig);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid credits');
    });

    test('should reject negative credits', () => {
      const record = store.createKey('stripe-test', 50);
      const body = checkoutEvent({
        paygate_api_key: record.key,
        paygate_credits: '-100',
      });
      const sig = makeSignature(body, WEBHOOK_SECRET);

      const result = handler.handleWebhook(body, sig);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid credits');
    });

    test('should floor float credits to integer', () => {
      const record = store.createKey('stripe-test', 50);
      const body = checkoutEvent({
        paygate_api_key: record.key,
        paygate_credits: '99.9',
      });
      const sig = makeSignature(body, WEBHOOK_SECRET);

      const result = handler.handleWebhook(body, sig);

      expect(result.success).toBe(true);
      expect(result.creditsAdded).toBe(99);
      expect(store.getKey(record.key)!.credits).toBe(149); // 50 + 99
    });
  });

  // ─── Invoice Payment Succeeded ──────────────────────────────────────────────

  describe('invoice.payment_succeeded', () => {
    test('should top up credits on subscription renewal', () => {
      const record = store.createKey('sub-test', 10);
      const body = invoiceEvent({
        paygate_api_key: record.key,
        paygate_credits: '500',
      });
      const sig = makeSignature(body, WEBHOOK_SECRET);

      const result = handler.handleWebhook(body, sig);

      expect(result.success).toBe(true);
      expect(result.event).toBe('invoice.payment_succeeded');
      expect(result.creditsAdded).toBe(500);
      expect(store.getKey(record.key)!.credits).toBe(510); // 10 + 500
    });

    test('should ignore invoice without paygate metadata', () => {
      const body = invoiceEvent({});
      const sig = makeSignature(body, WEBHOOK_SECRET);

      const result = handler.handleWebhook(body, sig);

      expect(result.success).toBe(true);
      expect(result.creditsAdded).toBeUndefined();
    });
  });

  // ─── Unknown Events ─────────────────────────────────────────────────────────

  describe('Unknown Events', () => {
    test('should acknowledge unknown event types', () => {
      const body = JSON.stringify({
        id: 'evt_unknown',
        type: 'customer.created',
        data: { object: { id: 'cus_123' } },
      });
      const sig = makeSignature(body, WEBHOOK_SECRET);

      const result = handler.handleWebhook(body, sig);

      expect(result.success).toBe(true);
      expect(result.event).toBe('customer.created');
    });
  });

  // ─── Error Handling ─────────────────────────────────────────────────────────

  describe('Error Handling', () => {
    test('should reject invalid signature', () => {
      const body = checkoutEvent({ paygate_api_key: 'pg_test', paygate_credits: '100' });
      const result = handler.handleWebhook(body, 'invalid_signature');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid signature');
    });

    test('should reject invalid JSON body with valid signature', () => {
      const badBody = 'not json at all';
      const sig = makeSignature(badBody, WEBHOOK_SECRET);

      // Signature will be valid, but body can't be parsed
      // Actually verifySignature will pass, then JSON.parse will fail
      const result = handler.handleWebhook(badBody, sig);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid JSON');
    });

    test('should reject malformed event (no type)', () => {
      const body = JSON.stringify({ id: 'evt_test' });
      const sig = makeSignature(body, WEBHOOK_SECRET);

      const result = handler.handleWebhook(body, sig);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Malformed');
    });

    test('should not expose full API key in error messages', () => {
      const body = checkoutEvent({
        paygate_api_key: 'pg_verylongapikey1234567890abcdef',
        paygate_credits: '100',
      });
      const sig = makeSignature(body, WEBHOOK_SECRET);

      const result = handler.handleWebhook(body, sig);

      expect(result.success).toBe(false);
      // Error should only show truncated key
      if (result.error) {
        expect(result.error).not.toContain('pg_verylongapikey1234567890abcdef');
        expect(result.error).toContain('...');
      }
    });
  });
});
