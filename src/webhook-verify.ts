/**
 * Webhook Signature Verification — Inbound Webhook Validation.
 *
 * Verify incoming webhook signatures from external services (Stripe, GitHub, etc.).
 * Supports multiple signature schemes (HMAC-SHA256, Stripe v1, GitHub SHA-256),
 * with replay protection via timestamp validation.
 *
 * Use cases:
 *   - Validate Stripe webhook events before processing
 *   - Verify GitHub webhook deliveries
 *   - Authenticate custom webhook sources with HMAC signatures
 *
 * Zero external dependencies.
 */

import { createHmac, timingSafeEqual } from 'crypto';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WebhookVerifierConfig {
  /** Maximum allowed age of webhook timestamp (seconds). Default: 300 (5 min). */
  maxTimestampAge?: number;
  /** Whether to enforce timestamp validation. Default: true. */
  enforceTimestamp?: boolean;
  /** Maximum secrets to store. Default: 100. */
  maxSecrets?: number;
}

export interface WebhookSecret {
  /** Unique ID for this secret (e.g., 'stripe-main', 'github-repo'). */
  id: string;
  /** The shared secret for HMAC computation. */
  secret: string;
  /** Signature scheme: how to extract and verify the signature. */
  scheme: 'hmac-sha256' | 'stripe-v1' | 'github-sha256' | 'custom';
  /** Header name containing the signature. */
  signatureHeader: string;
  /** Header name containing the timestamp (optional). */
  timestampHeader?: string;
  /** Whether this secret is active. */
  active: boolean;
  /** When this secret was created (ISO). */
  createdAt: string;
  /** Description. */
  description?: string;
}

export interface VerifyResult {
  /** Whether the signature is valid. */
  valid: boolean;
  /** Which secret ID matched. */
  matchedSecretId?: string;
  /** Reason for failure. */
  reason?: string;
  /** Timestamp from the webhook (if present). */
  timestamp?: number;
  /** Age of the webhook in seconds (if timestamp present). */
  ageSeconds?: number;
}

export interface WebhookVerifyStats {
  /** Total verification attempts. */
  totalVerifications: number;
  /** Successful verifications. */
  successCount: number;
  /** Failed verifications. */
  failureCount: number;
  /** Failures by reason. */
  failuresByReason: Record<string, number>;
  /** Verifications by secret ID. */
  bySecretId: Record<string, number>;
  /** Total secrets configured. */
  totalSecrets: number;
}

// ─── Webhook Verifier ───────────────────────────────────────────────────────

export class WebhookVerifier {
  private secrets = new Map<string, WebhookSecret>();
  private maxTimestampAge: number;
  private enforceTimestamp: boolean;
  private maxSecrets: number;

  // Stats
  private totalVerifications = 0;
  private successCount = 0;
  private failureCount = 0;
  private failuresByReason: Record<string, number> = {};
  private bySecretId: Record<string, number> = {};

  constructor(config: WebhookVerifierConfig = {}) {
    this.maxTimestampAge = config.maxTimestampAge ?? 300;
    this.enforceTimestamp = config.enforceTimestamp ?? true;
    this.maxSecrets = config.maxSecrets ?? 100;
  }

  /** Add or update a webhook secret. */
  upsertSecret(secret: Omit<WebhookSecret, 'createdAt'> & { createdAt?: string }): boolean {
    if (this.secrets.size >= this.maxSecrets && !this.secrets.has(secret.id)) {
      return false;
    }

    this.secrets.set(secret.id, {
      ...secret,
      createdAt: secret.createdAt ?? new Date().toISOString(),
    });
    return true;
  }

  /** Remove a secret. */
  removeSecret(id: string): boolean {
    return this.secrets.delete(id);
  }

  /** Get a secret. */
  getSecret(id: string): WebhookSecret | null {
    const s = this.secrets.get(id);
    if (!s) return null;
    // Return without exposing the actual secret value
    return { ...s, secret: '***' };
  }

  /** List all secrets (without secret values). */
  getSecrets(): WebhookSecret[] {
    return [...this.secrets.values()].map(s => ({ ...s, secret: '***' }));
  }

  /**
   * Verify a webhook request.
   *
   * @param body - Raw request body (string or Buffer)
   * @param headers - Request headers (case-insensitive lookup)
   * @param secretId - Optional specific secret to verify against. If omitted, tries all active secrets.
   */
  verify(body: string | Buffer, headers: Record<string, string | undefined>, secretId?: string): VerifyResult {
    this.totalVerifications++;

    const bodyStr = typeof body === 'string' ? body : body.toString('utf-8');

    // If specific secret requested
    if (secretId) {
      const secret = this.secrets.get(secretId);
      if (!secret) {
        return this.fail('secret_not_found');
      }
      if (!secret.active) {
        return this.fail('secret_inactive');
      }
      return this.verifyWithSecret(bodyStr, headers, secret);
    }

    // Try all active secrets
    for (const secret of this.secrets.values()) {
      if (!secret.active) continue;

      const sigHeader = this.getHeader(headers, secret.signatureHeader);
      if (!sigHeader) continue; // Skip secrets whose header isn't present

      const result = this.verifyWithSecret(bodyStr, headers, secret);
      if (result.valid) return result;
    }

    return this.fail('no_matching_secret');
  }

  /**
   * Compute the expected signature for a payload.
   * Useful for testing or generating outbound webhook signatures.
   */
  sign(body: string, secretId: string): string | null {
    const secret = this.secrets.get(secretId);
    if (!secret) return null;

    const hmac = createHmac('sha256', secret.secret);
    hmac.update(body);
    return hmac.digest('hex');
  }

  /**
   * Compute a Stripe-style signature (timestamp + payload).
   */
  signStripe(body: string, secretId: string, timestamp?: number): string | null {
    const secret = this.secrets.get(secretId);
    if (!secret) return null;

    const ts = timestamp ?? Math.floor(Date.now() / 1000);
    const signedPayload = `${ts}.${body}`;
    const hmac = createHmac('sha256', secret.secret);
    hmac.update(signedPayload);
    return `t=${ts},v1=${hmac.digest('hex')}`;
  }

  /** Get stats. */
  getStats(): WebhookVerifyStats {
    return {
      totalVerifications: this.totalVerifications,
      successCount: this.successCount,
      failureCount: this.failureCount,
      failuresByReason: { ...this.failuresByReason },
      bySecretId: { ...this.bySecretId },
      totalSecrets: this.secrets.size,
    };
  }

  /** Reset stats. */
  resetStats(): void {
    this.totalVerifications = 0;
    this.successCount = 0;
    this.failureCount = 0;
    this.failuresByReason = {};
    this.bySecretId = {};
  }

  /** Destroy and release resources. */
  destroy(): void {
    this.secrets.clear();
    this.resetStats();
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private verifyWithSecret(body: string, headers: Record<string, string | undefined>, secret: WebhookSecret): VerifyResult {
    const sigHeader = this.getHeader(headers, secret.signatureHeader);
    if (!sigHeader) {
      return this.fail('missing_signature_header');
    }

    switch (secret.scheme) {
      case 'hmac-sha256':
        return this.verifyHmacSha256(body, sigHeader, headers, secret);
      case 'stripe-v1':
        return this.verifyStripeV1(body, sigHeader, secret);
      case 'github-sha256':
        return this.verifyGitHubSha256(body, sigHeader, secret);
      case 'custom':
        return this.verifyHmacSha256(body, sigHeader, headers, secret);
      default:
        return this.fail('unknown_scheme');
    }
  }

  private verifyHmacSha256(body: string, signature: string, headers: Record<string, string | undefined>, secret: WebhookSecret): VerifyResult {
    // Check timestamp if configured
    let timestamp: number | undefined;
    let ageSeconds: number | undefined;

    if (secret.timestampHeader) {
      const tsHeader = this.getHeader(headers, secret.timestampHeader);
      if (tsHeader) {
        timestamp = parseInt(tsHeader, 10);
        if (isNaN(timestamp)) {
          return this.fail('invalid_timestamp');
        }
        ageSeconds = Math.floor(Date.now() / 1000) - timestamp;
        if (this.enforceTimestamp && ageSeconds > this.maxTimestampAge) {
          return this.fail('timestamp_too_old');
        }
      } else if (this.enforceTimestamp) {
        return this.fail('missing_timestamp');
      }
    }

    const expected = createHmac('sha256', secret.secret).update(body).digest('hex');
    const sig = signature.startsWith('sha256=') ? signature.slice(7) : signature;

    if (!this.safeCompare(sig, expected)) {
      return this.fail('signature_mismatch');
    }

    return this.succeed(secret.id, timestamp, ageSeconds);
  }

  private verifyStripeV1(body: string, signatureHeader: string, secret: WebhookSecret): VerifyResult {
    // Parse Stripe signature: t=timestamp,v1=signature
    const parts: Record<string, string> = {};
    for (const item of signatureHeader.split(',')) {
      const [key, ...rest] = item.split('=');
      parts[key.trim()] = rest.join('=');
    }

    const timestamp = parseInt(parts['t'], 10);
    if (isNaN(timestamp)) {
      return this.fail('invalid_timestamp');
    }

    const ageSeconds = Math.floor(Date.now() / 1000) - timestamp;
    if (this.enforceTimestamp && ageSeconds > this.maxTimestampAge) {
      return this.fail('timestamp_too_old');
    }

    const sig = parts['v1'];
    if (!sig) {
      return this.fail('missing_v1_signature');
    }

    const signedPayload = `${timestamp}.${body}`;
    const expected = createHmac('sha256', secret.secret).update(signedPayload).digest('hex');

    if (!this.safeCompare(sig, expected)) {
      return this.fail('signature_mismatch');
    }

    return this.succeed(secret.id, timestamp, ageSeconds);
  }

  private verifyGitHubSha256(body: string, signatureHeader: string, secret: WebhookSecret): VerifyResult {
    // GitHub: sha256=<hex>
    const sig = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader;
    const expected = createHmac('sha256', secret.secret).update(body).digest('hex');

    if (!this.safeCompare(sig, expected)) {
      return this.fail('signature_mismatch');
    }

    return this.succeed(secret.id);
  }

  private safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
    } catch {
      return false;
    }
  }

  private getHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
    // Case-insensitive header lookup
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === lower) return value;
    }
    return undefined;
  }

  private fail(reason: string): VerifyResult {
    this.failureCount++;
    this.failuresByReason[reason] = (this.failuresByReason[reason] ?? 0) + 1;
    return { valid: false, reason };
  }

  private succeed(secretId: string, timestamp?: number, ageSeconds?: number): VerifyResult {
    this.successCount++;
    this.bySecretId[secretId] = (this.bySecretId[secretId] ?? 0) + 1;
    return { valid: true, matchedSecretId: secretId, timestamp, ageSeconds };
  }
}
