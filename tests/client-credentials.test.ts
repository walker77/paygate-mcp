/**
 * Tests for OAuth 2.1 client_credentials grant (M2M auth).
 *
 * Tests:
 *   - OAuthProvider.clientCredentialsGrant() unit tests
 *   - E2E: POST /oauth/token with grant_type=client_credentials
 *   - Rejection cases: missing secret, wrong secret, no API key, unauthorized grant
 *   - Token validation after client_credentials grant
 *   - No refresh token in client_credentials response (per OAuth 2.1)
 */

import { OAuthProvider } from '../src/oauth';
import { PayGateServer } from '../src/server';
import { PayGateConfig } from '../src/types';
import * as http from 'http';
import * as path from 'path';

const MOCK_SERVER = path.join(__dirname, 'e2e', 'mock-mcp-server.js');

let server: PayGateServer;
let port: number;
let adminKey: string;

function httpRequest(
  targetPort: number,
  urlPath: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; headers: Record<string, string>; body: any }> {
  return new Promise((resolve, reject) => {
    const method = options.method || (options.body ? 'POST' : 'GET');
    const bodyStr = options.body ? JSON.stringify(options.body) : undefined;

    const req = http.request(
      { hostname: 'localhost', port: targetPort, path: urlPath, method, headers: { 'Content-Type': 'application/json', ...options.headers } },
      (res) => {
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

afterEach(async () => {
  if (server) await server.stop();
});

// ─── Unit Tests ────────────────────────────────────────────────────────────

describe('OAuthProvider client_credentials unit tests', () => {
  let oauth: OAuthProvider;

  beforeEach(() => {
    oauth = new OAuthProvider({ issuer: 'http://test.local' });
  });

  afterEach(() => {
    oauth.destroy();
  });

  it('should issue access token via client_credentials grant', () => {
    const client = oauth.registerClient({
      clientName: 'M2M Service',
      redirectUris: ['http://localhost/callback'],
      grantTypes: ['authorization_code', 'refresh_token', 'client_credentials'],
      apiKeyRef: 'pg_test_key_123',
    });

    const result = oauth.clientCredentialsGrant({
      clientId: client.clientId,
      clientSecret: client.clientSecret!,
      scope: 'tools:*',
    });

    expect(result.accessToken).toMatch(/^pg_at_/);
    expect(result.tokenType).toBe('Bearer');
    expect(result.expiresIn).toBe(3600);
    expect(result.scope).toBe('tools:*');
  });

  it('should not include refresh_token in client_credentials response', () => {
    const client = oauth.registerClient({
      clientName: 'M2M Service',
      redirectUris: ['http://localhost/callback'],
      grantTypes: ['client_credentials'],
      apiKeyRef: 'pg_test_key_123',
    });

    const result = oauth.clientCredentialsGrant({
      clientId: client.clientId,
      clientSecret: client.clientSecret!,
    });

    // Client credentials should only return access token (no refresh_token per OAuth 2.1)
    expect(result.accessToken).toBeTruthy();
    expect((result as any).refreshToken).toBeUndefined();
  });

  it('should validate token issued via client_credentials', () => {
    const client = oauth.registerClient({
      clientName: 'M2M Service',
      redirectUris: ['http://localhost/callback'],
      grantTypes: ['client_credentials'],
      apiKeyRef: 'pg_test_key_abc',
    });

    const result = oauth.clientCredentialsGrant({
      clientId: client.clientId,
      clientSecret: client.clientSecret!,
    });

    const validated = oauth.validateToken(result.accessToken);
    expect(validated).not.toBeNull();
    expect(validated!.apiKey).toBe('pg_test_key_abc');
    expect(validated!.clientId).toBe(client.clientId);
  });

  it('should reject unknown client', () => {
    expect(() => oauth.clientCredentialsGrant({
      clientId: 'pg_client_nonexistent',
      clientSecret: 'pg_secret_wrong',
    })).toThrow('invalid_client');
  });

  it('should reject wrong client secret', () => {
    const client = oauth.registerClient({
      clientName: 'M2M Service',
      redirectUris: ['http://localhost/callback'],
      grantTypes: ['client_credentials'],
      apiKeyRef: 'pg_test_key_123',
    });

    expect(() => oauth.clientCredentialsGrant({
      clientId: client.clientId,
      clientSecret: 'wrong_secret',
    })).toThrow('invalid_client');
  });

  it('should reject public client (no secret)', () => {
    const client = oauth.registerClient({
      clientName: 'Public App',
      redirectUris: ['http://localhost/callback'],
      grantTypes: ['client_credentials'],
      apiKeyRef: 'pg_test_key_123',
    });

    // Simulate a public client by clearing the secret
    const record = oauth.getClient(client.clientId)!;
    record.clientSecret = null;

    expect(() => oauth.clientCredentialsGrant({
      clientId: client.clientId,
      clientSecret: 'anything',
    })).toThrow('Public clients cannot use client_credentials');
  });

  it('should reject client without client_credentials grant type', () => {
    const client = oauth.registerClient({
      clientName: 'Auth Code Only App',
      redirectUris: ['http://localhost/callback'],
      grantTypes: ['authorization_code', 'refresh_token'],
      apiKeyRef: 'pg_test_key_123',
    });

    expect(() => oauth.clientCredentialsGrant({
      clientId: client.clientId,
      clientSecret: client.clientSecret!,
    })).toThrow('unauthorized_client');
  });

  it('should reject client without linked API key', () => {
    const client = oauth.registerClient({
      clientName: 'No Key App',
      redirectUris: ['http://localhost/callback'],
      grantTypes: ['client_credentials'],
    });

    expect(() => oauth.clientCredentialsGrant({
      clientId: client.clientId,
      clientSecret: client.clientSecret!,
    })).toThrow('No API key linked');
  });

  it('should use client default scope when none requested', () => {
    const client = oauth.registerClient({
      clientName: 'M2M Service',
      redirectUris: ['http://localhost/callback'],
      grantTypes: ['client_credentials'],
      scope: 'tools:read',
      apiKeyRef: 'pg_test_key_123',
    });

    const result = oauth.clientCredentialsGrant({
      clientId: client.clientId,
      clientSecret: client.clientSecret!,
    });

    expect(result.scope).toBe('tools:read');
  });

  it('metadata should include client_credentials in grant_types_supported', () => {
    const meta = oauth.getMetadata();
    expect(meta.grant_types_supported).toContain('client_credentials');
  });
});

// ─── E2E Tests ─────────────────────────────────────────────────────────────

describe('client_credentials E2E', () => {
  beforeEach(async () => {
    server = new PayGateServer({
      serverCommand: 'node',
      serverArgs: [MOCK_SERVER],
      port: 0,
      defaultCreditsPerCall: 1,
      oauth: { issuer: 'http://localhost' },
    } as PayGateConfig & { serverCommand: string });

    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  it('POST /oauth/token with grant_type=client_credentials returns access token', async () => {
    // 1. Create an API key
    const keyRes = await httpRequest(port, '/keys', {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
      body: { name: 'M2M Key', credits: 1000 },
    });
    const apiKey = keyRes.body.key;

    // 2. Register OAuth client with client_credentials grant + linked API key
    const regRes = await httpRequest(port, '/oauth/register', {
      body: {
        client_name: 'M2M Bot',
        redirect_uris: ['http://localhost/callback'],
        grant_types: ['client_credentials'],
        api_key: apiKey,
      },
    });
    expect(regRes.status).toBe(201);
    const clientId = regRes.body.client_id;
    const clientSecret = regRes.body.client_secret;

    // 3. Exchange client credentials for access token
    const tokenRes = await httpRequest(port, '/oauth/token', {
      body: {
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'tools:*',
      },
    });

    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.access_token).toMatch(/^pg_at_/);
    expect(tokenRes.body.token_type).toBe('Bearer');
    expect(tokenRes.body.expires_in).toBeGreaterThan(0);
    expect(tokenRes.body.scope).toBe('tools:*');
    // No refresh token for client_credentials
    expect(tokenRes.body.refresh_token).toBeUndefined();
  });

  it('POST /oauth/token client_credentials rejects missing client_secret', async () => {
    const tokenRes = await httpRequest(port, '/oauth/token', {
      body: {
        grant_type: 'client_credentials',
        client_id: 'pg_client_test',
      },
    });

    expect(tokenRes.status).toBe(400);
    expect(tokenRes.body.error).toBe('invalid_request');
  });

  it('POST /oauth/token client_credentials rejects wrong secret', async () => {
    // Register a client
    const regRes = await httpRequest(port, '/oauth/register', {
      body: {
        client_name: 'Test',
        redirect_uris: ['http://localhost/callback'],
        grant_types: ['client_credentials'],
      },
    });

    const tokenRes = await httpRequest(port, '/oauth/token', {
      body: {
        grant_type: 'client_credentials',
        client_id: regRes.body.client_id,
        client_secret: 'wrong_secret_value',
      },
    });

    expect(tokenRes.status).toBe(400);
    expect(tokenRes.body.error).toBe('invalid_client');
  });

  it('metadata endpoint includes client_credentials', async () => {
    const res = await httpRequest(port, '/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body.grant_types_supported).toContain('client_credentials');
  });
});
