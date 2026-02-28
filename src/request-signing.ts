/**
 * RequestSigner — HMAC-SHA256 request signing and verification.
 *
 * Provides cryptographic request authentication: clients sign their
 * requests with a shared secret, PayGate verifies the signature before
 * processing. Prevents tampering and replay attacks.
 *
 * Features:
 *   - HMAC-SHA256 signature generation and verification
 *   - Timestamp-based replay protection (configurable tolerance)
 *   - Nonce tracking to prevent exact replay within the window
 *   - Per-key signing secrets (separate from the API key itself)
 *   - Canonical request format for deterministic signing
 *   - Stats: verified, failed, replayed, expired
 *
 * Signature header format:
 *   X-Signature: t=<unix-ms>,n=<nonce>,s=<hex-signature>
 *
 * Signing payload:
 *   <timestamp>.<nonce>.<method>.<path>.<body-sha256>
 *
 * Zero external dependencies.
 */

import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SigningConfig {
  /** Enable request signing verification. Default false. */
  enabled: boolean;
  /** Timestamp tolerance in ms. Requests outside this window are rejected. Default 300_000 (5 min). */
  toleranceMs: number;
  /** Nonce dedup window in ms. Must be >= toleranceMs. Default 600_000 (10 min). */
  nonceWindowMs: number;
  /** Max nonces to track. Default 100_000. */
  maxNonces: number;
  /** Header name for the signature. Default 'x-signature'. */
  headerName: string;
}

export interface SigningSecret {
  apiKey: string;
  secret: string;
  createdAt: number;
  /** Optional label for identification. */
  label?: string;
}

export interface SignatureVerifyResult {
  valid: boolean;
  reason?: string;
  apiKey?: string;
}

export interface SigningStats {
  enabled: boolean;
  config: SigningConfig;
  registeredKeys: number;
  totalVerified: number;
  totalFailed: number;
  totalReplayed: number;
  totalExpired: number;
  noncesCached: number;
}

// ─── Default config ─────────────────────────────────────────────────────────

const DEFAULT_SIGNING_CONFIG: SigningConfig = {
  enabled: false,
  toleranceMs: 300_000,
  nonceWindowMs: 600_000,
  maxNonces: 100_000,
  headerName: 'x-signature',
};

// ─── Nonce tracker ──────────────────────────────────────────────────────────

interface NonceEntry {
  nonce: string;
  timestamp: number;
}

// ─── RequestSigner Class ────────────────────────────────────────────────────

export class RequestSigner {
  private config: SigningConfig;

  // Per-key signing secrets
  private secrets = new Map<string, SigningSecret>();

  // Nonce tracking (insertion-ordered for pruning)
  private nonces = new Map<string, number>(); // nonce → timestamp

  // Stats
  private totalVerified = 0;
  private totalFailed = 0;
  private totalReplayed = 0;
  private totalExpired = 0;

  constructor(config?: Partial<SigningConfig>) {
    this.config = { ...DEFAULT_SIGNING_CONFIG, ...config };
    if (this.config.nonceWindowMs < this.config.toleranceMs) {
      this.config.nonceWindowMs = this.config.toleranceMs * 2;
    }
  }

  /**
   * Register a signing secret for an API key.
   * Returns the generated secret if none provided.
   */
  registerKey(apiKey: string, secret?: string, label?: string): SigningSecret {
    const signingSecret: SigningSecret = {
      apiKey,
      secret: secret ?? crypto.randomBytes(32).toString('hex'),
      createdAt: Date.now(),
      label,
    };
    this.secrets.set(apiKey, signingSecret);
    return signingSecret;
  }

  /**
   * Remove signing secret for an API key.
   */
  removeKey(apiKey: string): boolean {
    return this.secrets.delete(apiKey);
  }

  /**
   * Rotate the signing secret for a key. Returns new secret.
   */
  rotateKey(apiKey: string): SigningSecret | null {
    const existing = this.secrets.get(apiKey);
    if (!existing) return null;
    return this.registerKey(apiKey, undefined, existing.label);
  }

  /**
   * Check if a key has a signing secret registered.
   */
  hasKey(apiKey: string): boolean {
    return this.secrets.has(apiKey);
  }

  /**
   * Sign a request (used by clients or for testing).
   * Returns the signature header value.
   */
  sign(
    apiKey: string,
    method: string,
    path: string,
    body: string,
    timestamp?: number,
    nonce?: string,
  ): string | null {
    const secret = this.secrets.get(apiKey);
    if (!secret) return null;

    const ts = timestamp ?? Date.now();
    const n = nonce ?? crypto.randomBytes(16).toString('hex');
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const payload = `${ts}.${n}.${method.toUpperCase()}.${path}.${bodyHash}`;
    const sig = crypto.createHmac('sha256', secret.secret).update(payload).digest('hex');

    return `t=${ts},n=${n},s=${sig}`;
  }

  /**
   * Verify a request signature.
   */
  verify(
    apiKey: string,
    method: string,
    path: string,
    body: string,
    signatureHeader: string,
  ): SignatureVerifyResult {
    if (!this.config.enabled) {
      return { valid: true, reason: 'signing-disabled' };
    }

    const secret = this.secrets.get(apiKey);
    if (!secret) {
      // If no secret registered, signing is not required for this key
      return { valid: true, reason: 'no-secret-registered' };
    }

    // Parse signature header: t=<ts>,n=<nonce>,s=<sig>
    const parsed = this.parseSignatureHeader(signatureHeader);
    if (!parsed) {
      this.totalFailed++;
      return { valid: false, reason: 'invalid-signature-format', apiKey };
    }

    const { timestamp, nonce, signature } = parsed;

    // Check timestamp tolerance
    const now = Date.now();
    const age = Math.abs(now - timestamp);
    if (age > this.config.toleranceMs) {
      this.totalExpired++;
      return { valid: false, reason: 'timestamp-expired', apiKey };
    }

    // Check nonce replay
    if (this.nonces.has(nonce)) {
      this.totalReplayed++;
      return { valid: false, reason: 'nonce-replayed', apiKey };
    }

    // Compute expected signature
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const payload = `${timestamp}.${nonce}.${method.toUpperCase()}.${path}.${bodyHash}`;
    const expected = crypto.createHmac('sha256', secret.secret).update(payload).digest('hex');

    // Timing-safe comparison
    if (!this.timingSafeEqual(signature, expected)) {
      this.totalFailed++;
      return { valid: false, reason: 'signature-mismatch', apiKey };
    }

    // Record nonce
    this.recordNonce(nonce, now);

    this.totalVerified++;
    return { valid: true, apiKey };
  }

  /**
   * Update configuration at runtime.
   */
  configure(updates: Partial<SigningConfig>): SigningConfig {
    if (updates.enabled !== undefined) this.config.enabled = updates.enabled;
    if (updates.toleranceMs !== undefined) this.config.toleranceMs = Math.max(1000, updates.toleranceMs);
    if (updates.nonceWindowMs !== undefined) this.config.nonceWindowMs = Math.max(this.config.toleranceMs, updates.nonceWindowMs);
    if (updates.maxNonces !== undefined) this.config.maxNonces = Math.max(1000, updates.maxNonces);
    if (updates.headerName !== undefined) this.config.headerName = updates.headerName.toLowerCase();
    return { ...this.config };
  }

  /**
   * Get statistics.
   */
  stats(): SigningStats {
    this.pruneNonces();
    return {
      enabled: this.config.enabled,
      config: { ...this.config },
      registeredKeys: this.secrets.size,
      totalVerified: this.totalVerified,
      totalFailed: this.totalFailed,
      totalReplayed: this.totalReplayed,
      totalExpired: this.totalExpired,
      noncesCached: this.nonces.size,
    };
  }

  /**
   * Clear all state.
   */
  clear(): void {
    this.secrets.clear();
    this.nonces.clear();
  }

  /** Get current config. */
  get currentConfig(): SigningConfig {
    return { ...this.config };
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private parseSignatureHeader(header: string): { timestamp: number; nonce: string; signature: string } | null {
    if (!header || typeof header !== 'string') return null;

    const parts: Record<string, string> = {};
    for (const segment of header.split(',')) {
      const eq = segment.indexOf('=');
      if (eq === -1) continue;
      const key = segment.slice(0, eq).trim();
      const val = segment.slice(eq + 1).trim();
      parts[key] = val;
    }

    const t = parts['t'];
    const n = parts['n'];
    const s = parts['s'];

    if (!t || !n || !s) return null;

    const timestamp = parseInt(t, 10);
    if (isNaN(timestamp)) return null;

    // Validate nonce format (hex, 16-64 chars)
    if (!/^[0-9a-f]{16,64}$/i.test(n)) return null;

    // Validate signature format (hex, 64 chars for SHA256)
    if (!/^[0-9a-f]{64}$/i.test(s)) return null;

    return { timestamp, nonce: n, signature: s };
  }

  private timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    return crypto.timingSafeEqual(bufA, bufB);
  }

  private recordNonce(nonce: string, timestamp: number): void {
    this.nonces.set(nonce, timestamp);

    // Evict if over capacity
    if (this.nonces.size > this.config.maxNonces) {
      this.pruneNonces();
      // If still over, remove oldest entries
      if (this.nonces.size > this.config.maxNonces) {
        const toRemove = this.nonces.size - this.config.maxNonces;
        let removed = 0;
        for (const key of this.nonces.keys()) {
          if (removed >= toRemove) break;
          this.nonces.delete(key);
          removed++;
        }
      }
    }
  }

  private pruneNonces(): void {
    const cutoff = Date.now() - this.config.nonceWindowMs;
    for (const [nonce, ts] of this.nonces) {
      if (ts < cutoff) this.nonces.delete(nonce);
    }
  }
}
