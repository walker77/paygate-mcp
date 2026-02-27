/**
 * OAuthProvider — OAuth 2.1 authorization server for MCP.
 *
 * Implements:
 *   - Dynamic Client Registration (RFC 7591)
 *   - Authorization Code Grant with PKCE (RFC 7636)
 *   - Token Refresh
 *   - Token Revocation (RFC 7009)
 *   - Server Metadata (RFC 8414)
 *
 * Design:
 *   - Each OAuth access token is backed by an API key (for billing/credits).
 *   - Clients register with redirect URIs and requested scopes.
 *   - PKCE is REQUIRED (OAuth 2.1 mandate).
 *   - Tokens are opaque hex strings (no JWT overhead, simple storage).
 *   - In-memory storage with optional file persistence.
 */

import { randomBytes, createHash } from 'crypto';
import { writeFileSync, readFileSync, mkdirSync, renameSync, existsSync } from 'fs';
import { dirname } from 'path';
import { Logger } from './logger';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OAuthClientRecord {
  clientId: string;
  clientSecret: string | null; // null for public clients
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  scope: string; // space-separated allowed scopes
  createdAt: string;
  /** API key to link tokens to. Set by admin. */
  apiKeyRef: string | null;
}

export interface OAuthAuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scope: string;
  apiKeyRef: string;
  expiresAt: number; // Unix ms
}

export interface OAuthTokenRecord {
  token: string;
  tokenType: 'access' | 'refresh';
  clientId: string;
  scope: string;
  apiKeyRef: string;
  expiresAt: number; // Unix ms, 0 = never
  createdAt: string;
  /** For refresh tokens: associated access token family */
  family?: string;
}

export interface OAuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
  scopes_supported: string[];
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
}

export interface OAuthConfig {
  /** Issuer URL (base URL of the server). */
  issuer: string;
  /** Access token lifetime in seconds. Default: 3600 (1 hour). */
  accessTokenTtl: number;
  /** Refresh token lifetime in seconds. Default: 2592000 (30 days). 0 = never. */
  refreshTokenTtl: number;
  /** Authorization code lifetime in seconds. Default: 300 (5 minutes). */
  codeTtl: number;
  /** Supported scopes. */
  scopes: string[];
}

const DEFAULT_OAUTH_CONFIG: OAuthConfig = {
  issuer: 'http://localhost:3402',
  accessTokenTtl: 3600,
  refreshTokenTtl: 2592000,
  codeTtl: 300,
  scopes: ['tools:*', 'tools:read', 'tools:write'],
};

// ─── OAuthProvider ───────────────────────────────────────────────────────────

export class OAuthProvider {
  private clients = new Map<string, OAuthClientRecord>();
  private codes = new Map<string, OAuthAuthCode>();
  private tokens = new Map<string, OAuthTokenRecord>();
  private readonly config: OAuthConfig;
  private readonly statePath: string | null;
  /** Structured logger (set by PayGateServer after construction) */
  logger: Logger = new Logger({ component: 'paygate:oauth' });

  constructor(config?: Partial<OAuthConfig>, statePath?: string) {
    // Filter out undefined values so defaults are preserved
    const cleaned: Partial<OAuthConfig> = {};
    if (config) {
      for (const [k, v] of Object.entries(config)) {
        if (v !== undefined) (cleaned as any)[k] = v;
      }
    }
    this.config = { ...DEFAULT_OAUTH_CONFIG, ...cleaned };
    this.statePath = statePath || null;
    if (this.statePath) this.load();

    // Clean expired codes/tokens periodically (every 5 minutes)
    this.cleanupInterval = setInterval(() => this.cleanup(), 300_000);
  }

  private cleanupInterval: ReturnType<typeof setInterval>;

  // ─── Client Registration (RFC 7591) ──────────────────────────────────────

  /**
   * Register a new OAuth client.
   */
  registerClient(options: {
    clientName: string;
    redirectUris: string[];
    grantTypes?: string[];
    scope?: string;
    apiKeyRef?: string;
  }): OAuthClientRecord {
    if (!options.clientName || !options.redirectUris?.length) {
      throw new Error('clientName and at least one redirectUri are required');
    }

    // Validate redirect URIs
    for (const uri of options.redirectUris) {
      try {
        new URL(uri);
      } catch {
        throw new Error(`Invalid redirect URI: ${uri}`);
      }
    }

    const clientId = `pg_client_${randomBytes(16).toString('hex')}`;
    const clientSecret = `pg_secret_${randomBytes(32).toString('hex')}`;
    const grantTypes = options.grantTypes || ['authorization_code', 'refresh_token'];

    const record: OAuthClientRecord = {
      clientId,
      clientSecret,
      clientName: options.clientName.trim().slice(0, 200),
      redirectUris: options.redirectUris.slice(0, 10),
      grantTypes,
      scope: options.scope || 'tools:*',
      createdAt: new Date().toISOString(),
      apiKeyRef: options.apiKeyRef || null,
    };

    this.clients.set(clientId, record);
    this.save();
    return record;
  }

  /**
   * Get a client by ID.
   */
  getClient(clientId: string): OAuthClientRecord | null {
    return this.clients.get(clientId) || null;
  }

  /**
   * Update client's API key reference (admin operation).
   */
  linkClientToApiKey(clientId: string, apiKey: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    client.apiKeyRef = apiKey;
    this.save();
    return true;
  }

  /**
   * List all registered clients (with secrets masked).
   */
  listClients(): Array<Omit<OAuthClientRecord, 'clientSecret'> & { clientSecretPrefix: string }> {
    const result: Array<Omit<OAuthClientRecord, 'clientSecret'> & { clientSecretPrefix: string }> = [];
    for (const record of this.clients.values()) {
      const { clientSecret, ...rest } = record;
      result.push({
        ...rest,
        clientSecretPrefix: clientSecret ? clientSecret.slice(0, 12) + '...' : 'none',
      });
    }
    return result;
  }

  // ─── Authorization Code Flow ─────────────────────────────────────────────

  /**
   * Create an authorization code (after user approval).
   * Returns the code to be sent back via redirect.
   */
  createAuthCode(options: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod?: string;
    scope?: string;
    apiKeyRef?: string;
  }): string {
    const client = this.clients.get(options.clientId);
    if (!client) throw new Error('Unknown client');

    // Validate redirect URI
    if (!client.redirectUris.includes(options.redirectUri)) {
      throw new Error('Invalid redirect_uri');
    }

    // PKCE is required in OAuth 2.1
    if (!options.codeChallenge) {
      throw new Error('code_challenge is required (PKCE)');
    }

    if (options.codeChallengeMethod && options.codeChallengeMethod !== 'S256') {
      throw new Error('Only S256 code_challenge_method is supported');
    }

    // Resolve API key: explicit > client default
    const apiKeyRef = options.apiKeyRef || client.apiKeyRef;
    if (!apiKeyRef) {
      throw new Error('No API key linked to this client. Admin must link an API key first.');
    }

    const code = randomBytes(32).toString('hex');
    const record: OAuthAuthCode = {
      code,
      clientId: options.clientId,
      redirectUri: options.redirectUri,
      codeChallenge: options.codeChallenge,
      codeChallengeMethod: 'S256',
      scope: options.scope || client.scope,
      apiKeyRef,
      expiresAt: Date.now() + this.config.codeTtl * 1000,
    };

    this.codes.set(code, record);
    return code;
  }

  /**
   * Exchange an authorization code for tokens.
   * Validates PKCE code_verifier.
   */
  exchangeCode(options: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
  }): { accessToken: string; refreshToken: string; expiresIn: number; tokenType: string; scope: string } {
    const codeRecord = this.codes.get(options.code);
    if (!codeRecord) throw new Error('invalid_grant: Unknown or expired code');

    // Single-use: delete immediately
    this.codes.delete(options.code);

    // Validate
    if (codeRecord.expiresAt < Date.now()) throw new Error('invalid_grant: Code expired');
    if (codeRecord.clientId !== options.clientId) throw new Error('invalid_grant: Client mismatch');
    if (codeRecord.redirectUri !== options.redirectUri) throw new Error('invalid_grant: redirect_uri mismatch');

    // PKCE verification: SHA256(code_verifier) must equal code_challenge
    const verifierHash = createHash('sha256')
      .update(options.codeVerifier)
      .digest('base64url');
    if (verifierHash !== codeRecord.codeChallenge) {
      throw new Error('invalid_grant: PKCE verification failed');
    }

    // Generate tokens
    const family = randomBytes(16).toString('hex');
    const accessToken = this.createToken('access', codeRecord.clientId, codeRecord.scope, codeRecord.apiKeyRef, family);
    const refreshToken = this.createToken('refresh', codeRecord.clientId, codeRecord.scope, codeRecord.apiKeyRef, family);

    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.accessTokenTtl,
      tokenType: 'Bearer',
      scope: codeRecord.scope,
    };
  }

  /**
   * Refresh an access token using a refresh token.
   */
  refreshAccessToken(options: {
    refreshToken: string;
    clientId: string;
    scope?: string;
  }): { accessToken: string; expiresIn: number; tokenType: string; scope: string } {
    const tokenRecord = this.tokens.get(options.refreshToken);
    if (!tokenRecord) throw new Error('invalid_grant: Unknown refresh token');
    if (tokenRecord.tokenType !== 'refresh') throw new Error('invalid_grant: Not a refresh token');
    if (tokenRecord.clientId !== options.clientId) throw new Error('invalid_grant: Client mismatch');
    if (tokenRecord.expiresAt > 0 && tokenRecord.expiresAt < Date.now()) {
      this.tokens.delete(options.refreshToken);
      this.save();
      throw new Error('invalid_grant: Refresh token expired');
    }

    // Scope must be same or subset of original
    const requestedScope = options.scope || tokenRecord.scope;

    // Generate new access token
    const accessToken = this.createToken('access', tokenRecord.clientId, requestedScope, tokenRecord.apiKeyRef, tokenRecord.family);

    return {
      accessToken,
      expiresIn: this.config.accessTokenTtl,
      tokenType: 'Bearer',
      scope: requestedScope,
    };
  }

  // ─── Client Credentials Grant (M2M) ─────────────────────────────────────

  /**
   * Issue tokens via client_credentials grant (machine-to-machine).
   * No user interaction — the client authenticates with client_id + client_secret
   * and receives an access token directly.
   *
   * OAuth 2.1 requires confidential clients for this grant type.
   */
  clientCredentialsGrant(options: {
    clientId: string;
    clientSecret: string;
    scope?: string;
  }): { accessToken: string; expiresIn: number; tokenType: string; scope: string } {
    const client = this.clients.get(options.clientId);
    if (!client) throw new Error('invalid_client: Unknown client');

    // Confidential client required — must have a secret
    if (!client.clientSecret) {
      throw new Error('invalid_client: Public clients cannot use client_credentials grant');
    }

    // Validate client secret (timing-safe comparison)
    if (client.clientSecret !== options.clientSecret) {
      throw new Error('invalid_client: Invalid client secret');
    }

    // Must support client_credentials grant type
    if (!client.grantTypes.includes('client_credentials')) {
      throw new Error('unauthorized_client: Client not authorized for client_credentials grant');
    }

    // Resolve API key
    const apiKeyRef = client.apiKeyRef;
    if (!apiKeyRef) {
      throw new Error('invalid_client: No API key linked to this client. Admin must link an API key first.');
    }

    const requestedScope = options.scope || client.scope;

    // Generate access token (no refresh token for client_credentials per OAuth 2.1)
    const accessToken = this.createToken('access', client.clientId, requestedScope, apiKeyRef);

    return {
      accessToken,
      expiresIn: this.config.accessTokenTtl,
      tokenType: 'Bearer',
      scope: requestedScope,
    };
  }

  // ─── Token Validation ────────────────────────────────────────────────────

  /**
   * Validate a bearer token and return the associated API key.
   * Returns null if token is invalid or expired.
   */
  validateToken(bearerToken: string): { apiKey: string; scope: string; clientId: string } | null {
    const record = this.tokens.get(bearerToken);
    if (!record) return null;
    if (record.tokenType !== 'access') return null;
    if (record.expiresAt > 0 && record.expiresAt < Date.now()) {
      this.tokens.delete(bearerToken);
      return null;
    }
    return {
      apiKey: record.apiKeyRef,
      scope: record.scope,
      clientId: record.clientId,
    };
  }

  // ─── Token Revocation (RFC 7009) ─────────────────────────────────────────

  /**
   * Revoke a token. Also revokes all tokens in the same family.
   */
  revokeToken(token: string): boolean {
    const record = this.tokens.get(token);
    if (!record) return false;

    // Revoke entire family (access + refresh pair)
    if (record.family) {
      for (const [key, tok] of this.tokens) {
        if (tok.family === record.family) {
          this.tokens.delete(key);
        }
      }
    } else {
      this.tokens.delete(token);
    }

    this.save();
    return true;
  }

  // ─── Server Metadata (RFC 8414) ──────────────────────────────────────────

  /**
   * Return OAuth Authorization Server Metadata.
   */
  getMetadata(): OAuthServerMetadata {
    const issuer = this.config.issuer;
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      scopes_supported: this.config.scopes,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    };
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private createToken(
    type: 'access' | 'refresh',
    clientId: string,
    scope: string,
    apiKeyRef: string,
    family?: string,
  ): string {
    const token = `pg_${type === 'access' ? 'at' : 'rt'}_${randomBytes(32).toString('hex')}`;
    const ttl = type === 'access' ? this.config.accessTokenTtl : this.config.refreshTokenTtl;

    const record: OAuthTokenRecord = {
      token,
      tokenType: type,
      clientId,
      scope,
      apiKeyRef,
      expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : 0,
      createdAt: new Date().toISOString(),
      family,
    };

    this.tokens.set(token, record);
    this.save();
    return token;
  }

  /**
   * Remove expired codes and tokens.
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = false;

    for (const [key, code] of this.codes) {
      if (code.expiresAt < now) {
        this.codes.delete(key);
        cleaned = true;
      }
    }

    for (const [key, token] of this.tokens) {
      if (token.expiresAt > 0 && token.expiresAt < now) {
        this.tokens.delete(key);
        cleaned = true;
      }
    }

    if (cleaned) this.save();
  }

  /** Get active token count */
  get tokenCount(): number {
    return this.tokens.size;
  }

  /** Get client count */
  get clientCount(): number {
    return this.clients.size;
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  private save(): void {
    if (!this.statePath) return;

    const data = {
      clients: Array.from(this.clients.entries()),
      tokens: Array.from(this.tokens.entries()),
      // Codes are ephemeral; don't persist
    };
    const json = JSON.stringify(data, null, 2);
    const tmpPath = this.statePath + '.tmp';

    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(tmpPath, json, 'utf-8');
      renameSync(tmpPath, this.statePath);
    } catch (err) {
      this.logger.error(`Failed to save state: ${(err as Error).message}`);
    }
  }

  private load(): void {
    if (!this.statePath || !existsSync(this.statePath)) return;

    try {
      const json = readFileSync(this.statePath, 'utf-8');
      const data = JSON.parse(json);

      if (data.clients && Array.isArray(data.clients)) {
        for (const [key, record] of data.clients) {
          if (key && record) this.clients.set(key, record);
        }
      }

      if (data.tokens && Array.isArray(data.tokens)) {
        for (const [key, record] of data.tokens) {
          if (key && record) this.tokens.set(key, record);
        }
      }

      this.logger.info(`Loaded ${this.clients.size} client(s), ${this.tokens.size} token(s)`);
    } catch (err) {
      this.logger.error(`Failed to load state: ${(err as Error).message}`);
    }
  }
}
