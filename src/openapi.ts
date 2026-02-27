/**
 * OpenAPI 3.1 Specification Generator for PayGate MCP.
 *
 * Generates the complete OpenAPI spec for all public endpoints.
 * Served at GET /openapi.json.
 *
 * Zero dependencies — pure JSON object construction.
 */

export function generateOpenApiSpec(serverName: string, version: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: serverName,
      version,
      description:
        'PayGate MCP — Pay-per-tool-call gating proxy for MCP servers. ' +
        'Adds API key auth, credit billing, rate limiting, usage analytics, and 130+ production endpoints to any MCP server. ' +
        'Zero config. No code changes. No dependencies.',
      license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
      contact: { name: 'PayGate MCP', url: 'https://paygated.dev' },
    },
    externalDocs: {
      description: 'Full documentation on GitHub',
      url: 'https://github.com/walker77/paygate-mcp',
    },
    servers: [{ url: '/', description: 'Current server' }],
    tags: [
      { name: 'Core', description: 'MCP JSON-RPC gateway and server info' },
      { name: 'Keys', description: 'API key lifecycle management' },
      { name: 'Billing', description: 'Credit top-ups, Stripe integration, transfers' },
      { name: 'Discovery', description: 'Pricing, payment metadata, OpenAPI spec' },
      { name: 'OAuth', description: 'OAuth 2.1 authorization (PKCE + client_credentials)' },
      { name: 'Webhooks', description: 'Event webhooks with retry, filtering, dead-letter' },
      { name: 'Analytics', description: '40+ analytics endpoints for usage, revenue, costs, forecasting' },
      { name: 'Teams', description: 'Team management with shared budgets' },
      { name: 'Tokens', description: 'Scoped short-lived tokens' },
      { name: 'Groups', description: 'Key group policy templates' },
      { name: 'Admin', description: 'Admin key management, system dashboard, notifications' },
      { name: 'Operations', description: 'Health, metrics, maintenance, config' },
      { name: 'Audit', description: 'Audit logging and export' },
    ],
    paths: {
      ...corePaths(),
      ...keyPaths(),
      ...billingPaths(),
      ...discoveryPaths(),
      ...oauthPaths(),
      ...webhookPaths(),
      ...analyticsPaths(),
      ...teamPaths(),
      ...tokenPaths(),
      ...groupPaths(),
      ...adminPaths(),
      ...operationsPaths(),
      ...auditPaths(),
    },
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'API key for client tool calls (/mcp, /balance)',
        },
        AdminKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Admin-Key',
          description: 'Admin key for management endpoints',
        },
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'OAuth 2.1 Bearer token',
        },
      },
      schemas: {
        JsonRpcRequest: {
          type: 'object',
          required: ['jsonrpc', 'method'],
          properties: {
            jsonrpc: { type: 'string', const: '2.0' },
            id: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
            method: { type: 'string', description: 'MCP method (e.g., tools/call, tools/list)' },
            params: { type: 'object', description: 'Method-specific parameters' },
          },
        },
        JsonRpcResponse: {
          type: 'object',
          properties: {
            jsonrpc: { type: 'string', const: '2.0' },
            id: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
            result: { description: 'Successful result' },
            error: { $ref: '#/components/schemas/JsonRpcError' },
          },
        },
        JsonRpcError: {
          type: 'object',
          properties: {
            code: { type: 'integer', description: 'Error code (-32402 = payment required)' },
            message: { type: 'string' },
            data: { type: 'object', description: 'Additional error data (may include x402 block)' },
          },
        },
        ApiKey: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Full API key (only shown on creation)' },
            name: { type: 'string' },
            credits: { type: 'number' },
            totalSpent: { type: 'number' },
            totalCalls: { type: 'integer' },
            createdAt: { type: 'string', format: 'date-time' },
            lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
            active: { type: 'boolean' },
            namespace: { type: 'string', default: 'default' },
            spendingLimit: { type: 'number', default: 0, description: '0 = unlimited' },
            allowedTools: { type: 'array', items: { type: 'string' }, description: 'Whitelist (empty = all)' },
            deniedTools: { type: 'array', items: { type: 'string' }, description: 'Blacklist' },
            expiresAt: { type: 'string', format: 'date-time', nullable: true },
            tags: { type: 'object', additionalProperties: { type: 'string' } },
            ipAllowlist: { type: 'array', items: { type: 'string' }, description: 'CIDR or IP' },
          },
        },
        ToolPricing: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            creditsPerCall: { type: 'number' },
            creditsPerKbInput: { type: 'number', default: 0 },
            isFree: { type: 'boolean' },
            rateLimitPerMin: { type: 'integer', default: 0, description: '0 = use global' },
          },
        },
        PaymentMetadata: {
          type: 'object',
          description: 'SEP-2007 aligned payment metadata',
          properties: {
            name: { type: 'string' },
            version: { type: 'string' },
            paymentRequired: { type: 'boolean' },
            currency: { type: 'string', const: 'credits' },
            defaultCreditsPerCall: { type: 'number' },
            toolCount: { type: 'integer' },
            freeToolCount: { type: 'integer' },
            x402Compatible: { type: 'boolean' },
            endpoints: { type: 'object' },
          },
        },
        x402Block: {
          type: 'object',
          description: 'x402 V2 compatible payment recovery data',
          properties: {
            version: { type: 'string' },
            scheme: { type: 'string', const: 'credits' },
            creditsRequired: { type: 'number' },
            creditsAvailable: { type: 'number' },
            topUpUrl: { type: 'string' },
            pricingUrl: { type: 'string' },
            accepts: { type: 'array', items: { type: 'string' } },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  };
}

// ─── Helper: standard responses ───────────────────────────────────────────

function adminSecurity() {
  return [{ AdminKeyAuth: [] }];
}

function apiKeySecurity() {
  return [{ ApiKeyAuth: [] }, { BearerAuth: [] }];
}

function jsonResponse(description: string, schema?: Record<string, unknown>) {
  return {
    description,
    content: schema ? { 'application/json': { schema } } : { 'application/json': {} },
  };
}

function errorResponse(code: number, description: string) {
  return { [code]: jsonResponse(description, { $ref: '#/components/schemas/Error' }) };
}

// ─── Core paths ───────────────────────────────────────────────────────────

function corePaths() {
  return {
    '/mcp': {
      post: {
        tags: ['Core'],
        summary: 'JSON-RPC gateway (MCP Streamable HTTP)',
        description: 'Send MCP JSON-RPC requests. Requires API key or Bearer token. Free methods (initialize, tools/list, ping) pass without auth.',
        security: apiKeySecurity(),
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/JsonRpcRequest' } } },
        },
        responses: {
          200: jsonResponse('JSON-RPC response', { $ref: '#/components/schemas/JsonRpcResponse' }),
          ...errorResponse(401, 'Missing or invalid API key'),
          ...errorResponse(429, 'Rate limit exceeded'),
        },
      },
      get: {
        tags: ['Core'],
        summary: 'Open SSE stream for server notifications',
        description: 'Server-Sent Events stream for MCP server-to-client notifications.',
        security: apiKeySecurity(),
        responses: { 200: { description: 'SSE event stream', content: { 'text/event-stream': {} } } },
      },
    },
    '/balance': {
      get: {
        tags: ['Core'],
        summary: 'Check API key balance',
        description: 'Client-facing endpoint. Returns remaining credits, spending limit, and quota status.',
        security: apiKeySecurity(),
        responses: {
          200: jsonResponse('Balance info', {
            type: 'object',
            properties: {
              credits: { type: 'number' },
              totalSpent: { type: 'number' },
              totalCalls: { type: 'integer' },
              spendingLimit: { type: 'number' },
              active: { type: 'boolean' },
            },
          }),
          ...errorResponse(401, 'Invalid API key'),
        },
      },
    },
    '/info': {
      get: {
        tags: ['Core'],
        summary: 'Server capabilities and features',
        description: 'Returns server version, features, endpoint list, and configuration summary.',
        responses: { 200: jsonResponse('Server info') },
      },
    },
  };
}

// ─── Key management paths ─────────────────────────────────────────────────

function keyPaths() {
  return {
    '/keys': {
      post: {
        tags: ['Keys'],
        summary: 'Create API key',
        security: adminSecurity(),
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'credits'],
                properties: {
                  name: { type: 'string', maxLength: 500 },
                  credits: { type: 'number', minimum: 1, maximum: 1_000_000_000 },
                  namespace: { type: 'string', default: 'default' },
                  spendingLimit: { type: 'number', default: 0 },
                  allowedTools: { type: 'array', items: { type: 'string' }, maxItems: 1000 },
                  deniedTools: { type: 'array', items: { type: 'string' }, maxItems: 1000 },
                  expiresAt: { type: 'string', format: 'date-time' },
                  tags: { type: 'object', additionalProperties: { type: 'string' } },
                  ipAllowlist: { type: 'array', items: { type: 'string' }, maxItems: 200 },
                  group: { type: 'string' },
                  alias: { type: 'string' },
                  template: { type: 'string', description: 'Template name to apply defaults from' },
                  autoTopup: {
                    type: 'object',
                    properties: {
                      threshold: { type: 'number' },
                      amount: { type: 'number' },
                      maxDaily: { type: 'integer' },
                    },
                  },
                  quota: {
                    type: 'object',
                    properties: {
                      dailyCallLimit: { type: 'integer' },
                      monthlyCallLimit: { type: 'integer' },
                      dailyCreditLimit: { type: 'integer' },
                      monthlyCreditLimit: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          201: jsonResponse('Created API key', { $ref: '#/components/schemas/ApiKey' }),
          ...errorResponse(400, 'Invalid parameters'),
          ...errorResponse(401, 'Invalid admin key'),
        },
      },
      get: {
        tags: ['Keys'],
        summary: 'List API keys (paginated)',
        security: adminSecurity(),
        parameters: [
          { name: 'namespace', in: 'query', schema: { type: 'string' } },
          { name: 'group', in: 'query', schema: { type: 'string' } },
          { name: 'active', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
          { name: 'suspended', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
          { name: 'sortBy', in: 'query', schema: { type: 'string', enum: ['createdAt', 'name', 'credits', 'lastUsedAt', 'totalSpent', 'totalCalls'] } },
          { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 500 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: {
          200: jsonResponse('Paginated key list', {
            type: 'object',
            properties: {
              keys: { type: 'array', items: { type: 'object' } },
              total: { type: 'integer' },
              hasMore: { type: 'boolean' },
            },
          }),
        },
      },
    },
    '/keys/revoke': {
      post: {
        tags: ['Keys'], summary: 'Revoke an API key (permanent)', security: adminSecurity(),
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['key'], properties: { key: { type: 'string' } } } } } },
        responses: { 200: jsonResponse('Key revoked'), ...errorResponse(404, 'Key not found') },
      },
    },
    '/keys/suspend': {
      post: {
        tags: ['Keys'], summary: 'Suspend an API key (temporary)', security: adminSecurity(),
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['key'], properties: { key: { type: 'string' } } } } } },
        responses: { 200: jsonResponse('Key suspended') },
      },
    },
    '/keys/resume': {
      post: {
        tags: ['Keys'], summary: 'Resume a suspended API key', security: adminSecurity(),
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['key'], properties: { key: { type: 'string' } } } } } },
        responses: { 200: jsonResponse('Key resumed') },
      },
    },
    '/keys/clone': {
      post: {
        tags: ['Keys'], summary: 'Clone a key (fresh key, same config)', security: adminSecurity(),
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['key'], properties: { key: { type: 'string' }, name: { type: 'string' }, credits: { type: 'number' } } } } } },
        responses: { 201: jsonResponse('Cloned key', { $ref: '#/components/schemas/ApiKey' }) },
      },
    },
    '/keys/rotate': {
      post: {
        tags: ['Keys'], summary: 'Rotate key (new key, same credits/ACLs)', security: adminSecurity(),
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['key'], properties: { key: { type: 'string' } } } } } },
        responses: { 200: jsonResponse('Rotated key with new secret') },
      },
    },
    '/keys/transfer': {
      post: {
        tags: ['Keys'], summary: 'Transfer credits between keys', security: adminSecurity(),
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['from', 'to', 'credits'], properties: { from: { type: 'string' }, to: { type: 'string' }, credits: { type: 'number', minimum: 1 } } } } } },
        responses: { 200: jsonResponse('Transfer complete') },
      },
    },
    '/keys/bulk': {
      post: {
        tags: ['Keys'], summary: 'Bulk key operations', security: adminSecurity(),
        description: 'Perform operations on multiple keys: create, revoke, suspend, resume, topup.',
        responses: { 200: jsonResponse('Bulk operation results') },
      },
    },
    '/keys/export': {
      get: {
        tags: ['Keys'], summary: 'Export all keys (backup)', security: adminSecurity(),
        responses: { 200: jsonResponse('Key export data') },
      },
    },
    '/keys/import': {
      post: {
        tags: ['Keys'], summary: 'Import keys (restore)', security: adminSecurity(),
        responses: { 200: jsonResponse('Import results') },
      },
    },
    '/keys/search': {
      get: {
        tags: ['Keys'], summary: 'Search keys by tag', security: adminSecurity(),
        parameters: [
          { name: 'tag', in: 'query', required: true, schema: { type: 'string' }, description: 'Tag key to search' },
          { name: 'value', in: 'query', schema: { type: 'string' }, description: 'Tag value to match' },
        ],
        responses: { 200: jsonResponse('Matching keys') },
      },
    },
    '/keys/compare': {
      get: {
        tags: ['Keys'], summary: 'Compare 2-10 keys side-by-side', security: adminSecurity(),
        parameters: [{ name: 'keys', in: 'query', required: true, schema: { type: 'string' }, description: 'Comma-separated key prefixes' }],
        responses: { 200: jsonResponse('Key comparison') },
      },
    },
    '/keys/health': {
      get: {
        tags: ['Keys'], summary: 'Key health score (0-100)', security: adminSecurity(),
        parameters: [{ name: 'key', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: jsonResponse('Health score and breakdown') },
      },
    },
    '/keys/dashboard': {
      get: {
        tags: ['Keys'], summary: 'Single-key overview dashboard', security: adminSecurity(),
        parameters: [{ name: 'key', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: jsonResponse('Key dashboard data') },
      },
    },
    '/keys/stats': {
      get: {
        tags: ['Keys'], summary: 'Aggregate stats across all keys', security: adminSecurity(),
        responses: { 200: jsonResponse('Key statistics') },
      },
    },
    '/keys/usage': {
      get: {
        tags: ['Keys'], summary: 'Detailed per-key usage stats', security: adminSecurity(),
        parameters: [{ name: 'key', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: jsonResponse('Key usage data') },
      },
    },
    '/keys/templates': {
      get: {
        tags: ['Keys'], summary: 'List key templates', security: adminSecurity(),
        responses: { 200: jsonResponse('Template list') },
      },
      post: {
        tags: ['Keys'], summary: 'Create key template', security: adminSecurity(),
        responses: { 201: jsonResponse('Template created') },
      },
    },
    '/keys/reserve': {
      post: {
        tags: ['Keys'], summary: 'Reserve credits (hold)', security: adminSecurity(),
        description: 'Atomic credit reservation. Hold credits then commit or release.',
        responses: { 200: jsonResponse('Reservation created') },
      },
      get: {
        tags: ['Keys'], summary: 'List active reservations', security: adminSecurity(),
        responses: { 200: jsonResponse('Reservation list') },
      },
    },
    '/keys/reserve/commit': {
      post: {
        tags: ['Keys'], summary: 'Commit a reservation (deduct credits)', security: adminSecurity(),
        responses: { 200: jsonResponse('Reservation committed') },
      },
    },
    '/keys/reserve/release': {
      post: {
        tags: ['Keys'], summary: 'Release a reservation (refund hold)', security: adminSecurity(),
        responses: { 200: jsonResponse('Reservation released') },
      },
    },
    '/keys/schedule': {
      post: {
        tags: ['Keys'], summary: 'Schedule future action (topup/revoke/suspend)', security: adminSecurity(),
        responses: { 201: jsonResponse('Action scheduled') },
      },
      get: {
        tags: ['Keys'], summary: 'List scheduled actions', security: adminSecurity(),
        responses: { 200: jsonResponse('Scheduled actions') },
      },
    },
    '/keys/activity': {
      get: {
        tags: ['Keys'], summary: 'Unified key activity timeline', security: adminSecurity(),
        parameters: [{ name: 'key', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: jsonResponse('Activity events') },
      },
    },
  };
}

// ─── Billing paths ────────────────────────────────────────────────────────

function billingPaths() {
  return {
    '/topup': {
      post: {
        tags: ['Billing'], summary: 'Add credits to an API key', security: adminSecurity(),
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object', required: ['key', 'credits'],
                properties: {
                  key: { type: 'string' },
                  credits: { type: 'number', minimum: 1, maximum: 1_000_000_000 },
                },
              },
            },
          },
        },
        responses: { 200: jsonResponse('Credits added'), ...errorResponse(404, 'Key not found') },
      },
    },
    '/stripe/webhook': {
      post: {
        tags: ['Billing'], summary: 'Stripe webhook handler',
        description: 'Receives Stripe events (checkout.session.completed, invoice.payment_succeeded) and auto-tops-up credits. Requires Stripe-Signature header.',
        parameters: [{ name: 'Stripe-Signature', in: 'header', required: true, schema: { type: 'string' } }],
        responses: { 200: jsonResponse('Webhook processed'), ...errorResponse(400, 'Invalid signature') },
      },
    },
  };
}

// ─── Discovery paths ──────────────────────────────────────────────────────

function discoveryPaths() {
  return {
    '/.well-known/mcp-payment': {
      get: {
        tags: ['Discovery'], summary: 'SEP-2007 payment metadata',
        description: 'Machine-readable payment metadata. Includes pricing model, free tool count, x402 compatibility.',
        responses: { 200: jsonResponse('Payment metadata', { $ref: '#/components/schemas/PaymentMetadata' }) },
      },
    },
    '/pricing': {
      get: {
        tags: ['Discovery'], summary: 'Full pricing breakdown per tool',
        description: 'Returns per-tool pricing including isFree flag, creditsPerCall, creditsPerKbInput, rate limits.',
        responses: {
          200: jsonResponse('Pricing info', {
            type: 'object',
            properties: {
              defaultCreditsPerCall: { type: 'number' },
              tools: { type: 'array', items: { $ref: '#/components/schemas/ToolPricing' } },
            },
          }),
        },
      },
    },
    '/openapi.json': {
      get: {
        tags: ['Discovery'], summary: 'OpenAPI 3.1 specification',
        description: 'This specification document. Enables SDK generation and API exploration.',
        responses: { 200: jsonResponse('OpenAPI spec') },
      },
    },
    '/docs': {
      get: {
        tags: ['Discovery'], summary: 'Interactive API documentation',
        description: 'Swagger UI page for exploring the API.',
        responses: { 200: { description: 'HTML page', content: { 'text/html': {} } } },
      },
    },
    '/.well-known/mcp.json': {
      get: {
        tags: ['Discovery'], summary: 'MCP Server Identity card',
        description: 'Server identity and capability metadata for MCP Registry and agent discovery.',
        responses: { 200: jsonResponse('Server identity') },
      },
    },
    '/robots.txt': {
      get: {
        tags: ['Discovery'], summary: 'Crawler directives',
        description: 'Standard robots.txt — allows public discovery endpoints, disallows admin/key paths.',
        responses: { 200: { description: 'Robots.txt', content: { 'text/plain': {} } } },
      },
    },
  };
}

// ─── OAuth paths ──────────────────────────────────────────────────────────

function oauthPaths() {
  return {
    '/.well-known/oauth-authorization-server': {
      get: {
        tags: ['OAuth'], summary: 'OAuth 2.1 server metadata (RFC 8414)',
        responses: { 200: jsonResponse('OAuth metadata') },
      },
    },
    '/oauth/register': {
      post: {
        tags: ['OAuth'], summary: 'Register OAuth client (Dynamic Client Registration)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object', required: ['client_name', 'redirect_uris'],
                properties: {
                  client_name: { type: 'string' },
                  redirect_uris: { type: 'array', items: { type: 'string', format: 'uri' } },
                  grant_types: { type: 'array', items: { type: 'string', enum: ['authorization_code', 'refresh_token', 'client_credentials'] } },
                  scope: { type: 'string' },
                  api_key: { type: 'string', description: 'Link an API key for client_credentials M2M auth' },
                },
              },
            },
          },
        },
        responses: { 201: jsonResponse('Registered client') },
      },
    },
    '/oauth/authorize': {
      get: {
        tags: ['OAuth'], summary: 'Authorization endpoint (PKCE required)',
        parameters: [
          { name: 'response_type', in: 'query', required: true, schema: { type: 'string', const: 'code' } },
          { name: 'client_id', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'redirect_uri', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'code_challenge', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'code_challenge_method', in: 'query', required: true, schema: { type: 'string', const: 'S256' } },
          { name: 'scope', in: 'query', schema: { type: 'string' } },
          { name: 'state', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 302: { description: 'Redirect with authorization code' } },
      },
    },
    '/oauth/token': {
      post: {
        tags: ['OAuth'], summary: 'Token endpoint',
        description: 'Exchange authorization code, refresh token, or client credentials for access token.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object', required: ['grant_type'],
                properties: {
                  grant_type: { type: 'string', enum: ['authorization_code', 'refresh_token', 'client_credentials'] },
                  code: { type: 'string', description: 'For authorization_code grant' },
                  redirect_uri: { type: 'string', description: 'For authorization_code grant' },
                  code_verifier: { type: 'string', description: 'PKCE code verifier' },
                  refresh_token: { type: 'string', description: 'For refresh_token grant' },
                  client_id: { type: 'string' },
                  client_secret: { type: 'string', description: 'For client_credentials grant' },
                  scope: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: jsonResponse('Token response', {
            type: 'object',
            properties: {
              access_token: { type: 'string' },
              token_type: { type: 'string', const: 'Bearer' },
              expires_in: { type: 'integer' },
              refresh_token: { type: 'string', description: 'Only for authorization_code grant' },
              scope: { type: 'string' },
            },
          }),
          ...errorResponse(400, 'Invalid grant'),
        },
      },
    },
    '/oauth/revoke': {
      post: {
        tags: ['OAuth'], summary: 'Revoke an OAuth token',
        responses: { 200: jsonResponse('Token revoked') },
      },
    },
    '/oauth/clients': {
      get: {
        tags: ['OAuth'], summary: 'List registered OAuth clients', security: adminSecurity(),
        responses: { 200: jsonResponse('Client list') },
      },
    },
  };
}

// ─── Webhook paths ────────────────────────────────────────────────────────

function webhookPaths() {
  return {
    '/webhooks/stats': {
      get: {
        tags: ['Webhooks'], summary: 'Webhook delivery statistics', security: adminSecurity(),
        responses: { 200: jsonResponse('Delivery stats') },
      },
    },
    '/webhooks/log': {
      get: {
        tags: ['Webhooks'], summary: 'Webhook delivery attempt log', security: adminSecurity(),
        responses: { 200: jsonResponse('Delivery log') },
      },
    },
    '/webhooks/test': {
      post: {
        tags: ['Webhooks'], summary: 'Send test webhook event', security: adminSecurity(),
        responses: { 200: jsonResponse('Test webhook sent') },
      },
    },
    '/webhooks/pause': {
      post: {
        tags: ['Webhooks'], summary: 'Pause webhook delivery', security: adminSecurity(),
        responses: { 200: jsonResponse('Webhooks paused') },
      },
    },
    '/webhooks/resume': {
      post: {
        tags: ['Webhooks'], summary: 'Resume webhook delivery', security: adminSecurity(),
        responses: { 200: jsonResponse('Webhooks resumed') },
      },
    },
    '/webhooks/dead-letter': {
      get: {
        tags: ['Webhooks'], summary: 'View failed deliveries', security: adminSecurity(),
        responses: { 200: jsonResponse('Dead letter queue') },
      },
      delete: {
        tags: ['Webhooks'], summary: 'Clear dead letter queue', security: adminSecurity(),
        responses: { 200: jsonResponse('Queue cleared') },
      },
    },
    '/webhooks/replay': {
      post: {
        tags: ['Webhooks'], summary: 'Replay failed webhook events', security: adminSecurity(),
        responses: { 200: jsonResponse('Events replayed') },
      },
    },
    '/webhooks/filters': {
      get: {
        tags: ['Webhooks'], summary: 'List webhook filter rules', security: adminSecurity(),
        responses: { 200: jsonResponse('Filter rules') },
      },
      post: {
        tags: ['Webhooks'], summary: 'Create webhook filter rule', security: adminSecurity(),
        description: 'Route specific event types to different webhook URLs.',
        responses: { 201: jsonResponse('Filter created') },
      },
    },
  };
}

// ─── Analytics paths ──────────────────────────────────────────────────────

function analyticsPaths() {
  const analyticsEndpoints: Record<string, string> = {
    '/admin/costs': 'Per-tool and per-namespace cost breakdown',
    '/admin/revenue': 'Revenue metrics, trends, and projections',
    '/admin/traffic': 'Request volume analysis by time period',
    '/admin/denials': 'Denial breakdown by reason, tool, and key',
    '/admin/rate-limits': 'Rate limit utilization across keys',
    '/admin/quotas': 'Quota utilization analysis',
    '/admin/security': 'Security posture analysis',
    '/admin/forecast': 'Usage and revenue forecasting',
    '/admin/anomalies': 'Unusual pattern detection',
    '/admin/compliance': 'Governance and compliance report',
    '/admin/sla': 'Service level agreement monitoring',
    '/admin/capacity': 'System capacity planning',
    '/admin/latency': 'Per-tool response time metrics (avg/p95/min/max)',
    '/admin/error-trends': 'Error rate trends over time',
    '/admin/credit-flow': 'Credit movement analysis (topups, charges, refunds)',
    '/admin/key-age': 'Key age distribution analysis',
    '/admin/namespace-usage': 'Per-namespace usage breakdown',
    '/admin/audit-summary': 'Audit event summary',
    '/admin/group-performance': 'Key group performance comparison',
    '/admin/request-trends': 'Request volume trends',
    '/admin/key-status': 'Key status distribution (active/suspended/expired/revoked)',
    '/admin/webhook-health': 'Webhook delivery health metrics',
    '/admin/consumer-insights': 'Top consumer analysis',
    '/admin/system-health': 'System health composite score',
    '/admin/tool-adoption': 'Tool usage adoption trends',
    '/admin/credit-efficiency': 'Credit usage efficiency analysis',
    '/admin/access-heatmap': 'Hourly access pattern heatmap',
    '/admin/key-churn': 'Key creation/revocation churn analysis',
    '/admin/tool-correlation': 'Tool co-usage correlation matrix',
    '/admin/consumer-segmentation': 'Consumer behavior segmentation',
    '/admin/credit-distribution': 'Credit allocation distribution bands',
    '/admin/response-time-distribution': 'Response time percentile distribution',
    '/admin/consumer-lifetime-value': 'Consumer lifetime value analysis',
    '/admin/tool-revenue': 'Revenue attribution per tool',
    '/admin/consumer-retention': 'Consumer retention cohort analysis',
    '/admin/error-breakdown': 'Error type breakdown analysis',
    '/admin/credit-utilization': 'Credit utilization bands across keys',
    '/admin/namespace-revenue': 'Revenue breakdown by namespace',
    '/admin/group-revenue': 'Revenue breakdown by key group',
    '/admin/peak-usage': 'Peak usage time identification',
    '/admin/consumer-activity': 'Individual consumer activity timeline',
    '/admin/tool-popularity': 'Tool popularity ranking',
    '/admin/credit-allocation': 'Credit allocation vs. usage analysis',
    '/admin/daily-summary': 'Daily operational summary',
    '/admin/key-ranking': 'Key ranking by spend, calls, or efficiency',
    '/admin/hourly-traffic': 'Hourly traffic volume breakdown',
    '/admin/tool-error-rate': 'Per-tool error rate analysis',
    '/admin/consumer-spend-velocity': 'Consumer spending velocity trends',
    '/admin/namespace-activity': 'Namespace activity timeline',
    '/admin/credit-burn-rate': 'Credit burn rate forecasting',
    '/admin/consumer-risk-score': 'Consumer risk scoring (abuse potential)',
    '/admin/revenue-forecast': 'Revenue projection models',
    '/admin/group-activity': 'Group-level activity summary',
    '/admin/credit-waste': 'Unused credit identification (waste analysis)',
    '/admin/tool-profitability': 'Tool profitability ranking',
    '/admin/consumer-growth': 'New consumer acquisition trends',
    '/admin/namespace-comparison': 'Cross-namespace comparison dashboard',
    '/admin/key-health-overview': 'All-keys health score overview',
    '/admin/system-overview': 'System-wide operational overview',
  };

  const paths: Record<string, unknown> = {};
  for (const [path, desc] of Object.entries(analyticsEndpoints)) {
    paths[path] = {
      get: {
        tags: ['Analytics'],
        summary: desc,
        security: adminSecurity(),
        responses: { 200: jsonResponse(desc), ...errorResponse(401, 'Invalid admin key') },
      },
    };
  }
  return paths;
}

// ─── Team paths ───────────────────────────────────────────────────────────

function teamPaths() {
  return {
    '/teams': {
      get: { tags: ['Teams'], summary: 'List teams', security: adminSecurity(), responses: { 200: jsonResponse('Team list') } },
      post: {
        tags: ['Teams'], summary: 'Create team with shared budget', security: adminSecurity(),
        responses: { 201: jsonResponse('Team created') },
      },
    },
    '/teams/assign': {
      post: { tags: ['Teams'], summary: 'Assign key to team', security: adminSecurity(), responses: { 200: jsonResponse('Key assigned') } },
    },
    '/teams/remove': {
      post: { tags: ['Teams'], summary: 'Remove key from team', security: adminSecurity(), responses: { 200: jsonResponse('Key removed') } },
    },
    '/teams/usage': {
      get: { tags: ['Teams'], summary: 'Team usage stats', security: adminSecurity(), responses: { 200: jsonResponse('Team usage') } },
    },
    '/namespaces': {
      get: { tags: ['Teams'], summary: 'List namespaces with stats', security: adminSecurity(), responses: { 200: jsonResponse('Namespace list') } },
    },
  };
}

// ─── Token paths ──────────────────────────────────────────────────────────

function tokenPaths() {
  return {
    '/tokens': {
      post: {
        tags: ['Tokens'], summary: 'Issue scoped short-lived token', security: adminSecurity(),
        description: 'Create a token with specific tool permissions and max 24h TTL. HMAC-signed, zero server state.',
        responses: { 201: jsonResponse('Token issued') },
      },
    },
    '/tokens/revoke': {
      post: { tags: ['Tokens'], summary: 'Revoke token before expiry', security: adminSecurity(), responses: { 200: jsonResponse('Token revoked') } },
    },
    '/tokens/revoked': {
      get: { tags: ['Tokens'], summary: 'List revoked tokens', security: adminSecurity(), responses: { 200: jsonResponse('Revoked token list') } },
    },
  };
}

// ─── Group paths ──────────────────────────────────────────────────────────

function groupPaths() {
  return {
    '/groups': {
      get: { tags: ['Groups'], summary: 'List key groups', security: adminSecurity(), responses: { 200: jsonResponse('Group list') } },
      post: {
        tags: ['Groups'], summary: 'Create key group with policies', security: adminSecurity(),
        description: 'Groups define shared ACLs, rate limits, and quotas inherited by member keys.',
        responses: { 201: jsonResponse('Group created') },
      },
    },
    '/groups/assign': {
      post: { tags: ['Groups'], summary: 'Assign key to group', security: adminSecurity(), responses: { 200: jsonResponse('Key assigned to group') } },
    },
    '/groups/remove': {
      post: { tags: ['Groups'], summary: 'Remove key from group', security: adminSecurity(), responses: { 200: jsonResponse('Key removed from group') } },
    },
  };
}

// ─── Admin management paths ───────────────────────────────────────────────

function adminPaths() {
  return {
    '/admin/keys': {
      post: {
        tags: ['Admin'], summary: 'Create admin key (role-based)', security: adminSecurity(),
        description: 'Roles: super_admin, admin, viewer. Role hierarchy enforced.',
        responses: { 201: jsonResponse('Admin key created') },
      },
      get: { tags: ['Admin'], summary: 'List admin keys', security: adminSecurity(), responses: { 200: jsonResponse('Admin key list') } },
    },
    '/admin/keys/revoke': {
      post: { tags: ['Admin'], summary: 'Revoke admin key', security: adminSecurity(), responses: { 200: jsonResponse('Admin key revoked') } },
    },
    '/admin/keys/rotate-bootstrap': {
      post: { tags: ['Admin'], summary: 'Rotate bootstrap admin key', security: adminSecurity(), responses: { 200: jsonResponse('Bootstrap key rotated') } },
    },
    '/admin/dashboard': {
      get: { tags: ['Admin'], summary: 'System-wide operational dashboard', security: adminSecurity(), responses: { 200: jsonResponse('System dashboard') } },
    },
    '/admin/notifications': {
      get: {
        tags: ['Admin'], summary: 'Actionable admin notifications', security: adminSecurity(),
        description: 'Returns expiring keys, low-credit keys, rate limit spikes, and other issues requiring attention.',
        responses: { 200: jsonResponse('Notification list') },
      },
    },
    '/admin/events': {
      get: {
        tags: ['Admin'], summary: 'Real-time admin event stream (SSE)', security: adminSecurity(),
        description: 'Server-Sent Events stream of audit events, alerts, and key lifecycle events.',
        responses: { 200: { description: 'SSE event stream', content: { 'text/event-stream': {} } } },
      },
    },
    '/admin/lifecycle': {
      get: { tags: ['Admin'], summary: 'Key lifecycle analysis report', security: adminSecurity(), responses: { 200: jsonResponse('Lifecycle report') } },
    },
    '/admin/key-portfolio': {
      get: { tags: ['Admin'], summary: 'Key portfolio analysis', security: adminSecurity(), responses: { 200: jsonResponse('Portfolio analysis') } },
    },
  };
}

// ─── Operations paths ─────────────────────────────────────────────────────

function operationsPaths() {
  return {
    '/health': {
      get: {
        tags: ['Operations'], summary: 'Health check',
        description: 'Returns server health with uptime, version, and in-flight request count. Use as readiness/liveness probe.',
        responses: {
          200: jsonResponse('Healthy', {
            type: 'object',
            properties: {
              status: { type: 'string', const: 'ok' },
              version: { type: 'string' },
              uptime: { type: 'number' },
              inflight: { type: 'integer' },
            },
          }),
        },
      },
    },
    '/metrics': {
      get: {
        tags: ['Operations'], summary: 'Prometheus metrics',
        description: '50+ metrics in Prometheus text format. Cardinality-capped at 10,000 entries per metric.',
        responses: { 200: { description: 'Prometheus text metrics', content: { 'text/plain': {} } } },
      },
    },
    '/maintenance': {
      get: { tags: ['Operations'], summary: 'Check maintenance mode status', security: adminSecurity(), responses: { 200: jsonResponse('Maintenance status') } },
      post: {
        tags: ['Operations'], summary: 'Toggle maintenance mode', security: adminSecurity(),
        description: 'When enabled, /mcp returns 503 but admin endpoints stay available.',
        responses: { 200: jsonResponse('Maintenance mode updated') },
      },
    },
    '/config': {
      get: {
        tags: ['Operations'], summary: 'Export running configuration (secrets masked)', security: adminSecurity(),
        responses: { 200: jsonResponse('Masked config') },
      },
    },
    '/config/reload': {
      post: {
        tags: ['Operations'], summary: 'Reload config from file (zero-downtime)', security: adminSecurity(),
        responses: { 200: jsonResponse('Config reloaded') },
      },
    },
    '/dashboard': {
      get: {
        tags: ['Operations'], summary: 'Admin dashboard (HTML)',
        description: 'Embedded HTML dashboard with key management, usage charts, and activity feed.',
        responses: { 200: { description: 'HTML page', content: { 'text/html': {} } } },
      },
    },
    '/plugins': {
      get: { tags: ['Operations'], summary: 'List loaded plugins', security: adminSecurity(), responses: { 200: jsonResponse('Plugin list') } },
    },
  };
}

// ─── Audit paths ──────────────────────────────────────────────────────────

function auditPaths() {
  return {
    '/audit': {
      get: {
        tags: ['Audit'], summary: 'Query audit log', security: adminSecurity(),
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          { name: 'event', in: 'query', schema: { type: 'string' }, description: 'Filter by event type' },
        ],
        responses: { 200: jsonResponse('Audit entries') },
      },
    },
    '/audit/export': {
      get: {
        tags: ['Audit'], summary: 'Export audit log (JSON/CSV)', security: adminSecurity(),
        parameters: [{ name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'csv'] } }],
        responses: { 200: jsonResponse('Audit export') },
      },
    },
    '/audit/stats': {
      get: { tags: ['Audit'], summary: 'Audit event statistics', security: adminSecurity(), responses: { 200: jsonResponse('Audit stats') } },
    },
    '/requests': {
      get: {
        tags: ['Audit'], summary: 'Query request log', security: adminSecurity(),
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } },
          { name: 'tool', in: 'query', schema: { type: 'string' } },
          { name: 'key', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: jsonResponse('Request log entries') },
      },
    },
    '/requests/export': {
      get: {
        tags: ['Audit'], summary: 'Export request log', security: adminSecurity(),
        parameters: [{ name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'csv'] } }],
        responses: { 200: jsonResponse('Request log export') },
      },
    },
    '/requests/dry-run': {
      post: {
        tags: ['Audit'], summary: 'Dry-run a tool call (simulate without execution)', security: adminSecurity(),
        description: 'Simulate gating: check auth, credits, rate limits, ACLs without actually calling the tool.',
        responses: { 200: jsonResponse('Dry-run result') },
      },
    },
    '/requests/dry-run/batch': {
      post: {
        tags: ['Audit'], summary: 'Dry-run batch tool calls', security: adminSecurity(),
        responses: { 200: jsonResponse('Batch dry-run results') },
      },
    },
    '/tools/stats': {
      get: { tags: ['Audit'], summary: 'Per-tool usage statistics', security: adminSecurity(), responses: { 200: jsonResponse('Tool stats') } },
    },
    '/tools/available': {
      get: {
        tags: ['Audit'], summary: 'Tool availability check for a key', security: adminSecurity(),
        description: 'Returns per-tool pricing, affordability, ACL status, and rate limit status for a specific key.',
        parameters: [{ name: 'key', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: jsonResponse('Tool availability') },
      },
    },
  };
}
