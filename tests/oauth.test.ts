/**
 * Tests for OAuth 2.1 authorization server.
 */

import { OAuthProvider } from '../src/oauth';
import { PayGateServer } from '../src/server';
import { PayGateConfig } from '../src/types';
import * as http from 'http';
import * as path from 'path';
import { createHash } from 'crypto';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MOCK_SERVER = path.join(__dirname, 'e2e', 'mock-mcp-server.js');

let server: PayGateServer;
let port: number;
let adminKey: string;

function httpRequest(
  targetPort: number,
  urlPath: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown; followRedirect?: boolean } = {},
): Promise<{ status: number; headers: Record<string, string>; body: any }> {
  return new Promise((resolve, reject) => {
    const method = options.method || (options.body ? 'POST' : 'GET');
    const bodyStr = options.body ? JSON.stringify(options.body) : undefined;

    const req = http.request(
      { hostname: 'localhost', port: targetPort, path: urlPath, method, headers: { 'Content-Type': 'application/json', ...options.headers } },
      (res) => {
        // Handle redirects
        if ((res.statusCode === 301 || res.statusCode === 302) && !options.followRedirect) {
          resolve({
            status: res.statusCode!,
            headers: res.headers as Record<string, string>,
            body: { location: res.headers.location },
          });
          res.resume();
          return;
        }

        let data = '';
        res.on('data', (chunk) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, headers: res.headers as Record<string, string>, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, headers: res.headers as Record<string, string>, body: data });
          }
        });
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function startOAuthServer(overrides: Partial<PayGateConfig> = {}) {
  server = new PayGateServer({
    serverCommand: 'node',
    serverArgs: [MOCK_SERVER],
    port: 0,
    defaultCreditsPerCall: 1,
    oauth: { issuer: 'http://localhost' },
    ...overrides,
  } as PayGateConfig & { serverCommand: string });

  const info = await server.start();
  port = info.port;
  adminKey = info.adminKey;
}

/** Generate PKCE code_verifier and code_challenge */
function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = 'test_verifier_' + Math.random().toString(36).slice(2);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

afterEach(async () => {
  if (server) await server.gracefulStop(5_000);
}, 30_000);

// ─── OAuthProvider Unit Tests ────────────────────────────────────────────────

describe('OAuthProvider unit tests', () => {
  let oauth: OAuthProvider;

  beforeEach(() => {
    oauth = new OAuthProvider({ issuer: 'http://test.local' });
  });

  afterEach(() => {
    oauth.destroy();
  });

  it('should register a client', () => {
    const client = oauth.registerClient({
      clientName: 'Test App',
      redirectUris: ['http://localhost/callback'],
    });

    expect(client.clientId).toMatch(/^pg_client_/);
    expect(client.clientSecret).toMatch(/^pg_secret_/);
    expect(client.clientName).toBe('Test App');
    expect(client.redirectUris).toEqual(['http://localhost/callback']);
    expect(client.grantTypes).toEqual(['authorization_code', 'refresh_token']);
  });

  it('should reject registration with missing fields', () => {
    expect(() => oauth.registerClient({
      clientName: '',
      redirectUris: ['http://localhost/callback'],
    })).toThrow();

    expect(() => oauth.registerClient({
      clientName: 'App',
      redirectUris: [],
    })).toThrow();
  });

  it('should reject registration with invalid redirect URI', () => {
    expect(() => oauth.registerClient({
      clientName: 'App',
      redirectUris: ['not-a-url'],
    })).toThrow('Invalid redirect URI');
  });

  it('should create and exchange auth code with PKCE', () => {
    const client = oauth.registerClient({
      clientName: 'Test App',
      redirectUris: ['http://localhost/callback'],
      apiKeyRef: 'pg_test_key_123',
    });

    const { verifier, challenge } = generatePKCE();

    const code = oauth.createAuthCode({
      clientId: client.clientId,
      redirectUri: 'http://localhost/callback',
      codeChallenge: challenge,
      scope: 'tools:*',
    });

    expect(code).toBeTruthy();
    expect(code.length).toBeGreaterThan(32);

    // Exchange code for tokens
    const result = oauth.exchangeCode({
      code,
      clientId: client.clientId,
      redirectUri: 'http://localhost/callback',
      codeVerifier: verifier,
    });

    expect(result.accessToken).toMatch(/^pg_at_/);
    expect(result.refreshToken).toMatch(/^pg_rt_/);
    expect(result.tokenType).toBe('Bearer');
    expect(result.expiresIn).toBe(3600);
    expect(result.scope).toBe('tools:*');
  });

  it('should reject code exchange with wrong PKCE verifier', () => {
    const client = oauth.registerClient({
      clientName: 'Test App',
      redirectUris: ['http://localhost/callback'],
      apiKeyRef: 'pg_test_key_123',
    });

    const { challenge } = generatePKCE();

    const code = oauth.createAuthCode({
      clientId: client.clientId,
      redirectUri: 'http://localhost/callback',
      codeChallenge: challenge,
    });

    expect(() => oauth.exchangeCode({
      code,
      clientId: client.clientId,
      redirectUri: 'http://localhost/callback',
      codeVerifier: 'wrong_verifier',
    })).toThrow('PKCE verification failed');
  });

  it('should reject auth code without PKCE', () => {
    const client = oauth.registerClient({
      clientName: 'Test App',
      redirectUris: ['http://localhost/callback'],
      apiKeyRef: 'pg_test_key_123',
    });

    expect(() => oauth.createAuthCode({
      clientId: client.clientId,
      redirectUri: 'http://localhost/callback',
      codeChallenge: '',
    })).toThrow('code_challenge is required');
  });

  it('should reject code exchange with wrong redirect_uri', () => {
    const client = oauth.registerClient({
      clientName: 'Test App',
      redirectUris: ['http://localhost/callback'],
      apiKeyRef: 'pg_test_key_123',
    });

    const { verifier, challenge } = generatePKCE();

    const code = oauth.createAuthCode({
      clientId: client.clientId,
      redirectUri: 'http://localhost/callback',
      codeChallenge: challenge,
    });

    expect(() => oauth.exchangeCode({
      code,
      clientId: client.clientId,
      redirectUri: 'http://localhost/other',
      codeVerifier: verifier,
    })).toThrow('redirect_uri mismatch');
  });

  it('should not reuse auth codes (single-use)', () => {
    const client = oauth.registerClient({
      clientName: 'Test App',
      redirectUris: ['http://localhost/callback'],
      apiKeyRef: 'pg_test_key_123',
    });

    const { verifier, challenge } = generatePKCE();

    const code = oauth.createAuthCode({
      clientId: client.clientId,
      redirectUri: 'http://localhost/callback',
      codeChallenge: challenge,
    });

    // First exchange succeeds
    oauth.exchangeCode({
      code,
      clientId: client.clientId,
      redirectUri: 'http://localhost/callback',
      codeVerifier: verifier,
    });

    // Second exchange fails (code already used)
    expect(() => oauth.exchangeCode({
      code,
      clientId: client.clientId,
      redirectUri: 'http://localhost/callback',
      codeVerifier: verifier,
    })).toThrow('Unknown or expired code');
  });

  it('should validate access tokens', () => {
    const client = oauth.registerClient({
      clientName: 'Test App',
      redirectUris: ['http://localhost/callback'],
      apiKeyRef: 'pg_test_key_123',
    });

    const { verifier, challenge } = generatePKCE();

    const code = oauth.createAuthCode({
      clientId: client.clientId,
      redirectUri: 'http://localhost/callback',
      codeChallenge: challenge,
    });

    const result = oauth.exchangeCode({
      code,
      clientId: client.clientId,
      redirectUri: 'http://localhost/callback',
      codeVerifier: verifier,
    });

    // Validate access token
    const tokenInfo = oauth.validateToken(result.accessToken);
    expect(tokenInfo).not.toBeNull();
    expect(tokenInfo!.apiKey).toBe('pg_test_key_123');
    expect(tokenInfo!.scope).toBe('tools:*');
    expect(tokenInfo!.clientId).toBe(client.clientId);

    // Refresh token should not validate as access token
    expect(oauth.validateToken(result.refreshToken)).toBeNull();

    // Random string should not validate
    expect(oauth.validateToken('random_string')).toBeNull();
  });

  it('should refresh access tokens', () => {
    const client = oauth.registerClient({
      clientName: 'Test App',
      redirectUris: ['http://localhost/callback'],
      apiKeyRef: 'pg_test_key_123',
    });

    const { verifier, challenge } = generatePKCE();

    const code = oauth.createAuthCode({
      clientId: client.clientId,
      redirectUri: 'http://localhost/callback',
      codeChallenge: challenge,
    });

    const tokens = oauth.exchangeCode({
      code,
      clientId: client.clientId,
      redirectUri: 'http://localhost/callback',
      codeVerifier: verifier,
    });

    // Refresh
    const refreshed = oauth.refreshAccessToken({
      refreshToken: tokens.refreshToken,
      clientId: client.clientId,
    });

    expect(refreshed.accessToken).toMatch(/^pg_at_/);
    expect(refreshed.accessToken).not.toBe(tokens.accessToken); // New token
    expect(refreshed.tokenType).toBe('Bearer');

    // New token should validate
    const tokenInfo = oauth.validateToken(refreshed.accessToken);
    expect(tokenInfo).not.toBeNull();
    expect(tokenInfo!.apiKey).toBe('pg_test_key_123');
  });

  it('should revoke tokens (entire family)', () => {
    const client = oauth.registerClient({
      clientName: 'Test App',
      redirectUris: ['http://localhost/callback'],
      apiKeyRef: 'pg_test_key_123',
    });

    const { verifier, challenge } = generatePKCE();

    const code = oauth.createAuthCode({
      clientId: client.clientId,
      redirectUri: 'http://localhost/callback',
      codeChallenge: challenge,
    });

    const tokens = oauth.exchangeCode({
      code,
      clientId: client.clientId,
      redirectUri: 'http://localhost/callback',
      codeVerifier: verifier,
    });

    // Revoke the access token
    const revoked = oauth.revokeToken(tokens.accessToken);
    expect(revoked).toBe(true);

    // Both access and refresh tokens should be invalid now (family revocation)
    expect(oauth.validateToken(tokens.accessToken)).toBeNull();
    // Refresh should also fail
    expect(() => oauth.refreshAccessToken({
      refreshToken: tokens.refreshToken,
      clientId: client.clientId,
    })).toThrow();
  });

  it('should require API key linked to client', () => {
    const client = oauth.registerClient({
      clientName: 'Test App',
      redirectUris: ['http://localhost/callback'],
      // No apiKeyRef
    });

    const { challenge } = generatePKCE();

    expect(() => oauth.createAuthCode({
      clientId: client.clientId,
      redirectUri: 'http://localhost/callback',
      codeChallenge: challenge,
    })).toThrow('No API key linked');
  });

  it('should return server metadata', () => {
    const metadata = oauth.getMetadata();
    expect(metadata.issuer).toBe('http://test.local');
    expect(metadata.authorization_endpoint).toBe('http://test.local/oauth/authorize');
    expect(metadata.token_endpoint).toBe('http://test.local/oauth/token');
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(metadata.grant_types_supported).toContain('authorization_code');
    expect(metadata.grant_types_supported).toContain('refresh_token');
  });

  it('should list clients with masked secrets', () => {
    oauth.registerClient({
      clientName: 'App 1',
      redirectUris: ['http://localhost/cb1'],
    });
    oauth.registerClient({
      clientName: 'App 2',
      redirectUris: ['http://localhost/cb2'],
    });

    const clients = oauth.listClients();
    expect(clients.length).toBe(2);
    expect(clients[0].clientName).toBe('App 1');
    expect(clients[0].clientSecretPrefix).toContain('...');
    expect((clients[0] as any).clientSecret).toBeUndefined();
  });

  it('should link client to API key', () => {
    const client = oauth.registerClient({
      clientName: 'Test App',
      redirectUris: ['http://localhost/callback'],
    });

    expect(client.apiKeyRef).toBeNull();

    const linked = oauth.linkClientToApiKey(client.clientId, 'pg_my_key');
    expect(linked).toBe(true);

    const updated = oauth.getClient(client.clientId);
    expect(updated!.apiKeyRef).toBe('pg_my_key');
  });
});

// ─── E2E OAuth Flow Tests ────────────────────────────────────────────────────

describe('OAuth 2.1 E2E', () => {
  describe('Server metadata', () => {
    it('should serve OAuth metadata when OAuth is enabled', async () => {
      await startOAuthServer();

      const res = await httpRequest(port, '/.well-known/oauth-authorization-server');
      expect(res.status).toBe(200);
      expect(res.body.authorization_endpoint).toContain('/oauth/authorize');
      expect(res.body.token_endpoint).toContain('/oauth/token');
      expect(res.body.code_challenge_methods_supported).toEqual(['S256']);
    });

    it('should return 404 for OAuth endpoints when OAuth is not enabled', async () => {
      server = new PayGateServer({
        serverCommand: 'node',
        serverArgs: [MOCK_SERVER],
        port: 0,
        // No oauth config
      } as PayGateConfig & { serverCommand: string });

      const info = await server.start();
      port = info.port;
      adminKey = info.adminKey;

      const res = await httpRequest(port, '/.well-known/oauth-authorization-server');
      expect(res.status).toBe(404);
    });
  });

  describe('Dynamic Client Registration', () => {
    it('should register a client via /oauth/register', async () => {
      await startOAuthServer();

      const res = await httpRequest(port, '/oauth/register', {
        method: 'POST',
        body: {
          client_name: 'My MCP Client',
          redirect_uris: ['http://localhost:8080/callback'],
          scope: 'tools:*',
        },
      });

      expect(res.status).toBe(201);
      expect(res.body.client_id).toMatch(/^pg_client_/);
      expect(res.body.client_secret).toMatch(/^pg_secret_/);
      expect(res.body.client_name).toBe('My MCP Client');
    });

    it('should reject registration with missing redirect_uris', async () => {
      await startOAuthServer();

      const res = await httpRequest(port, '/oauth/register', {
        method: 'POST',
        body: {
          client_name: 'Bad Client',
        },
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_client_metadata');
    });
  });

  describe('Full OAuth flow: register → authorize → token → use', () => {
    it('should complete the full OAuth 2.1 flow with PKCE', async () => {
      await startOAuthServer();

      // Step 1: Create an API key (admin)
      const keyRes = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'oauth-test-key', credits: 100 },
      });
      const apiKey = keyRes.body.key;

      // Step 2: Register OAuth client with API key linked
      const regRes = await httpRequest(port, '/oauth/register', {
        method: 'POST',
        body: {
          client_name: 'Test MCP Client',
          redirect_uris: ['http://localhost:9999/callback'],
          api_key: apiKey,
        },
      });
      expect(regRes.status).toBe(201);
      const clientId = regRes.body.client_id;

      // Step 3: Generate PKCE challenge
      const { verifier, challenge } = generatePKCE();

      // Step 4: Authorize (GET with query params)
      const authRes = await httpRequest(port,
        `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('http://localhost:9999/callback')}&code_challenge=${challenge}&code_challenge_method=S256&state=test_state`,
      );
      expect(authRes.status).toBe(302);
      const location = new URL(authRes.body.location);
      expect(location.searchParams.get('code')).toBeTruthy();
      expect(location.searchParams.get('state')).toBe('test_state');
      const authCode = location.searchParams.get('code')!;

      // Step 5: Exchange code for tokens
      const tokenRes = await httpRequest(port, '/oauth/token', {
        method: 'POST',
        body: {
          grant_type: 'authorization_code',
          code: authCode,
          client_id: clientId,
          redirect_uri: 'http://localhost:9999/callback',
          code_verifier: verifier,
        },
      });
      expect(tokenRes.status).toBe(200);
      expect(tokenRes.body.access_token).toMatch(/^pg_at_/);
      expect(tokenRes.body.refresh_token).toMatch(/^pg_rt_/);
      expect(tokenRes.body.token_type).toBe('Bearer');
      expect(tokenRes.body.expires_in).toBe(3600);

      const accessToken = tokenRes.body.access_token;
      const refreshToken = tokenRes.body.refresh_token;

      // Step 6: Use access token on /mcp endpoint (Bearer auth)
      const mcpRes = await httpRequest(port, '/mcp', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}` },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'test' } } },
      });
      expect(mcpRes.status).toBe(200);
      expect(mcpRes.body.result).toBeDefined();

      // Step 7: Check balance was deducted
      const balanceRes = await httpRequest(port, '/balance', {
        headers: { 'X-API-Key': apiKey },
      });
      expect(balanceRes.body.credits).toBe(99);

      // Step 8: Refresh token
      const refreshRes = await httpRequest(port, '/oauth/token', {
        method: 'POST',
        body: {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
        },
      });
      expect(refreshRes.status).toBe(200);
      expect(refreshRes.body.access_token).toMatch(/^pg_at_/);
      expect(refreshRes.body.access_token).not.toBe(accessToken);

      // Step 9: Revoke token
      const revokeRes = await httpRequest(port, '/oauth/revoke', {
        method: 'POST',
        body: { token: refreshRes.body.access_token },
      });
      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.revoked).toBe(true);
    });
  });

  describe('Token endpoint error handling', () => {
    it('should reject unsupported grant type', async () => {
      await startOAuthServer();

      const res = await httpRequest(port, '/oauth/token', {
        method: 'POST',
        body: { grant_type: 'password', username: 'test', password: 'test' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('unsupported_grant_type');
    });

    it('should reject invalid auth code', async () => {
      await startOAuthServer();

      const res = await httpRequest(port, '/oauth/token', {
        method: 'POST',
        body: {
          grant_type: 'authorization_code',
          code: 'invalid_code',
          client_id: 'pg_client_fake',
          redirect_uri: 'http://localhost/cb',
          code_verifier: 'test',
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    });
  });

  describe('Bearer token auth on /mcp', () => {
    it('should deny access with invalid bearer token', async () => {
      await startOAuthServer();

      const res = await httpRequest(port, '/mcp', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer invalid_token' },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'test' } } },
      });
      expect(res.status).toBe(200); // JSON-RPC always returns 200
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe(-32402);
    });

    it('should prefer X-API-Key over Bearer token', async () => {
      await startOAuthServer();

      // Create a key directly
      const keyRes = await httpRequest(port, '/keys', {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey },
        body: { name: 'direct-key', credits: 50 },
      });
      const apiKey = keyRes.body.key;

      // Use X-API-Key (ignores Bearer)
      const res = await httpRequest(port, '/mcp', {
        method: 'POST',
        headers: {
          'X-API-Key': apiKey,
          'Authorization': 'Bearer some_invalid_token',
        },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'test' } } },
      });
      expect(res.status).toBe(200);
      expect(res.body.result).toBeDefined(); // Should succeed with X-API-Key
    });
  });

  describe('OAuth admin endpoints', () => {
    it('should list clients via /oauth/clients', async () => {
      await startOAuthServer();

      // Register a client
      await httpRequest(port, '/oauth/register', {
        method: 'POST',
        body: {
          client_name: 'Listed Client',
          redirect_uris: ['http://localhost/cb'],
        },
      });

      // List clients (admin)
      const res = await httpRequest(port, '/oauth/clients', {
        headers: { 'X-Admin-Key': adminKey },
      });
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].clientName).toBe('Listed Client');
      expect(res.body[0].clientSecret).toBeUndefined(); // Masked
      expect(res.body[0].clientSecretPrefix).toContain('...');
    });

    it('should require admin key for /oauth/clients', async () => {
      await startOAuthServer();

      const res = await httpRequest(port, '/oauth/clients', {
        headers: { 'X-Admin-Key': 'wrong_key' },
      });
      expect(res.status).toBe(401);
    });

    it('should show oauth in root endpoint info', async () => {
      await startOAuthServer();

      const res = await httpRequest(port, '/');
      expect(res.status).toBe(200);
      expect(res.body.oauth).toBe(true);
      expect(res.body.endpoints.oauthMetadata).toBeDefined();
    });
  });
});
