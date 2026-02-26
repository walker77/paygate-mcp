/**
 * ScopedTokenManager — Issue and validate short-lived scoped tokens
 * derived from API keys.
 *
 * Tokens are self-contained (no server-side state): the payload is
 * HMAC-SHA256 signed and base64url-encoded. Validation is a pure
 * crypto check — no DB lookup needed.
 *
 * Format: pgt_<base64url(JSON payload)>.<base64url(HMAC signature)>
 *
 * Use cases:
 *   - Browser-based agents that shouldn't hold long-lived API keys
 *   - Temporary scoped access (e.g., only allow specific tools)
 *   - Token delegation from a master key to a downstream agent
 */

import { createHmac, timingSafeEqual, createHash } from 'crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TokenPayload {
  /** The underlying API key this token delegates from */
  apiKey: string;
  /** ISO 8601 expiry time */
  expiresAt: string;
  /** Optional: restrict to these tools only. Empty = inherit from parent key. */
  allowedTools?: string[];
  /** Optional: human-readable label */
  label?: string;
  /** ISO 8601 creation time */
  issuedAt: string;
}

export interface TokenValidation {
  /** Whether the token is valid (signature + not expired) */
  valid: boolean;
  /** The payload if valid */
  payload?: TokenPayload;
  /** Reason for rejection if invalid */
  reason?: string;
}

export interface TokenCreateOptions {
  /** API key to derive the token from */
  apiKey: string;
  /** Token lifetime in seconds. Default: 3600 (1 hour). Max: 86400 (24h). */
  ttlSeconds?: number;
  /** Explicit expiry time (overrides ttlSeconds if set) */
  expiresAt?: string;
  /** Restrict token to these tools only */
  allowedTools?: string[];
  /** Human-readable label for audit */
  label?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export interface RevokedTokenEntry {
  /** SHA-256 fingerprint of the full token string */
  fingerprint: string;
  /** When the revoked token naturally expires (ISO 8601). Entry is purged after this. */
  expiresAt: string;
  /** When the token was revoked (ISO 8601) */
  revokedAt: string;
  /** Optional reason for audit */
  reason?: string;
}

const TOKEN_PREFIX = 'pgt_';
const MAX_TTL_SECONDS = 86400; // 24 hours
const DEFAULT_TTL_SECONDS = 3600; // 1 hour
const MAX_TOKEN_AGE_CHECK_MS = MAX_TTL_SECONDS * 1000;
const CLEANUP_INTERVAL_MS = 60_000; // Clean expired entries every 60s

// ─── Revocation List ──────────────────────────────────────────────────────────

/**
 * In-memory revocation list for scoped tokens.
 *
 * Stores SHA-256 fingerprints of revoked tokens with their natural expiry.
 * Entries auto-purge once the original token would have expired anyway
 * (max 24h), so the list never grows unbounded.
 *
 * O(1) lookup via Map. Periodic cleanup via timer.
 */
export class TokenRevocationList {
  private readonly entries = new Map<string, RevokedTokenEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.purgeExpired(), CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /** Compute fingerprint for a token string. */
  static fingerprint(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Revoke a token. Returns the entry created, or null if already revoked. */
  revoke(token: string, expiresAt: string, reason?: string): RevokedTokenEntry | null {
    const fp = TokenRevocationList.fingerprint(token);
    if (this.entries.has(fp)) return null; // Already revoked

    const entry: RevokedTokenEntry = {
      fingerprint: fp,
      expiresAt,
      revokedAt: new Date().toISOString(),
      ...(reason ? { reason } : {}),
    };
    this.entries.set(fp, entry);
    return entry;
  }

  /** Add a pre-built entry (e.g., from Redis sync). */
  addEntry(entry: RevokedTokenEntry): void {
    this.entries.set(entry.fingerprint, entry);
  }

  /** Check if a token is revoked. O(1). */
  isRevoked(token: string): boolean {
    return this.entries.has(TokenRevocationList.fingerprint(token));
  }

  /** Check by fingerprint directly. O(1). */
  isRevokedByFingerprint(fingerprint: string): boolean {
    return this.entries.has(fingerprint);
  }

  /** Number of active revocation entries. */
  get size(): number {
    return this.entries.size;
  }

  /** List all current revocation entries. */
  list(): RevokedTokenEntry[] {
    return Array.from(this.entries.values());
  }

  /** Remove expired entries (token has naturally expired, no need to track). */
  purgeExpired(): number {
    const now = Date.now();
    let purged = 0;
    for (const [fp, entry] of this.entries) {
      if (new Date(entry.expiresAt).getTime() <= now) {
        this.entries.delete(fp);
        purged++;
      }
    }
    return purged;
  }

  /** Destroy the cleanup timer. */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** Clear all entries. */
  clear(): void {
    this.entries.clear();
  }
}

// ─── Manager ──────────────────────────────────────────────────────────────────

export class ScopedTokenManager {
  private readonly secret: string;
  readonly revocationList: TokenRevocationList;

  /**
   * @param secret — Signing secret (the admin key is used by default)
   */
  constructor(secret: string) {
    if (!secret || secret.length < 8) {
      throw new Error('Token signing secret must be at least 8 characters');
    }
    this.secret = secret;
    this.revocationList = new TokenRevocationList();
  }

  /**
   * Issue a new scoped token.
   */
  create(options: TokenCreateOptions): string {
    const ttl = Math.min(
      Math.max(1, options.ttlSeconds || DEFAULT_TTL_SECONDS),
      MAX_TTL_SECONDS,
    );

    const expiresAt = options.expiresAt || new Date(Date.now() + ttl * 1000).toISOString();

    const payload: TokenPayload = {
      apiKey: options.apiKey,
      expiresAt,
      issuedAt: new Date().toISOString(),
      ...(options.allowedTools?.length ? { allowedTools: options.allowedTools } : {}),
      ...(options.label ? { label: options.label } : {}),
    };

    const payloadB64 = this.base64urlEncode(JSON.stringify(payload));
    const signature = this.sign(payloadB64);

    return `${TOKEN_PREFIX}${payloadB64}.${signature}`;
  }

  /**
   * Validate a scoped token. Returns the payload if valid.
   */
  validate(token: string): TokenValidation {
    if (!token.startsWith(TOKEN_PREFIX)) {
      return { valid: false, reason: 'not_a_scoped_token' };
    }

    const body = token.slice(TOKEN_PREFIX.length);
    const dotIdx = body.lastIndexOf('.');
    if (dotIdx === -1) {
      return { valid: false, reason: 'malformed_token' };
    }

    const payloadB64 = body.slice(0, dotIdx);
    const signatureB64 = body.slice(dotIdx + 1);

    // Verify HMAC
    const expectedSig = this.sign(payloadB64);
    if (!this.timingSafeCompare(signatureB64, expectedSig)) {
      return { valid: false, reason: 'invalid_signature' };
    }

    // Check revocation list (before decoding payload — O(1) hash lookup)
    if (this.revocationList.isRevoked(token)) {
      return { valid: false, reason: 'token_revoked' };
    }

    // Decode payload
    let payload: TokenPayload;
    try {
      payload = JSON.parse(this.base64urlDecode(payloadB64));
    } catch {
      return { valid: false, reason: 'malformed_payload' };
    }

    // Check required fields
    if (!payload.apiKey || !payload.expiresAt || !payload.issuedAt) {
      return { valid: false, reason: 'missing_required_fields' };
    }

    // Check expiry
    const now = Date.now();
    const expiresAtMs = new Date(payload.expiresAt).getTime();
    if (isNaN(expiresAtMs) || expiresAtMs <= now) {
      return { valid: false, reason: 'token_expired' };
    }

    // Sanity: token can't be valid for more than MAX_TTL
    const issuedAtMs = new Date(payload.issuedAt).getTime();
    if (expiresAtMs - issuedAtMs > MAX_TOKEN_AGE_CHECK_MS) {
      return { valid: false, reason: 'token_ttl_exceeded' };
    }

    return { valid: true, payload };
  }

  /**
   * Revoke a token so it can no longer be used, even before expiry.
   * Returns the revocation entry, or null if already revoked or invalid.
   */
  revokeToken(token: string, reason?: string): RevokedTokenEntry | null {
    // First validate to extract the expiresAt
    // Temporarily skip revocation check for this validation
    if (!token.startsWith(TOKEN_PREFIX)) return null;

    const body = token.slice(TOKEN_PREFIX.length);
    const dotIdx = body.lastIndexOf('.');
    if (dotIdx === -1) return null;

    const payloadB64 = body.slice(0, dotIdx);
    const signatureB64 = body.slice(dotIdx + 1);
    const expectedSig = this.sign(payloadB64);
    if (!this.timingSafeCompare(signatureB64, expectedSig)) return null;

    let payload: TokenPayload;
    try {
      payload = JSON.parse(this.base64urlDecode(payloadB64));
    } catch {
      return null;
    }

    return this.revocationList.revoke(token, payload.expiresAt, reason);
  }

  /**
   * Check if a string looks like a scoped token (prefix check only).
   */
  static isToken(value: string): boolean {
    return value.startsWith(TOKEN_PREFIX);
  }

  /** Destroy timers. Call on server shutdown. */
  destroy(): void {
    this.revocationList.destroy();
  }

  // ─── Crypto helpers ───────────────────────────────────────────────────────

  private sign(data: string): string {
    const hmac = createHmac('sha256', this.secret);
    hmac.update(data);
    return this.base64urlEncode(hmac.digest());
  }

  private timingSafeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return timingSafeEqual(bufA, bufB);
  }

  private base64urlEncode(input: string | Buffer): string {
    const buf = typeof input === 'string' ? Buffer.from(input) : input;
    return buf.toString('base64url');
  }

  private base64urlDecode(input: string): string {
    return Buffer.from(input, 'base64url').toString('utf-8');
  }
}
