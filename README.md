# paygate-mcp

[![CI](https://github.com/walker77/paygate-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/walker77/paygate-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/paygate-mcp.svg)](https://www.npmjs.com/package/paygate-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Monetize any MCP server with one command. Add API key auth, per-tool pricing, rate limiting, and usage metering to any Model Context Protocol server. Zero dependencies. Zero config. Zero code changes.

## Quick Start

```bash
# Wrap a local MCP server (stdio transport)
npx paygate-mcp wrap --server "npx @modelcontextprotocol/server-filesystem /tmp"

# Gate a remote MCP server (Streamable HTTP transport)
npx paygate-mcp wrap --remote-url "https://my-server.example.com/mcp" --price 5
```

That's it. Your MCP server is now gated behind API keys with credit-based billing.

## What It Does

PayGate sits between AI agents and your MCP server:

```
Agent → PayGate (auth + billing) → Your MCP Server (stdio or HTTP)
```

- **API Key Auth** — Clients need a valid `X-API-Key` to call tools
- **Credit Billing** — Each tool call costs credits (configurable per-tool)
- **Rate Limiting** — Sliding window per-key rate limits + per-tool rate limits
- **Usage Metering** — Track who called what, when, and how much they spent
- **Multi-Server Mode** — Wrap N MCP servers behind one PayGate with tool prefix routing
- **Client SDK** — `PayGateClient` with auto 402 retry, balance tracking, and typed errors
- **Two Transports** — Wrap local servers via stdio or remote servers via Streamable HTTP
- **Per-Tool ACL** — Whitelist/blacklist tools per API key (enterprise access control)
- **Per-Tool Rate Limits** — Independent rate limits per tool, not just global
- **Key Expiry (TTL)** — Auto-expire API keys after a set time
- **Spending Limits** — Cap total spend per API key to prevent runaway costs
- **Usage Quotas** — Daily/monthly call and credit limits per key (with UTC auto-reset)
- **Dynamic Pricing** — Charge extra credits based on input size (`creditsPerKbInput`)
- **OAuth 2.1** — Full authorization server with PKCE, client registration, Bearer tokens
- **SSE Streaming** — Full MCP Streamable HTTP transport (POST SSE, GET notifications, DELETE sessions)
- **Audit Log** — Structured audit trail with retention policies, query API, CSV/JSON export
- **Registry/Discovery** — Agent-discoverable pricing via `/.well-known/mcp-payment` and `/pricing`
- **Prometheus Metrics** — `/metrics` endpoint with counters, gauges, and uptime in standard text format
- **Key Rotation** — Rotate API keys without losing credits, ACLs, or quotas
- **Rate Limit Headers** — `X-RateLimit-*` and `X-Credits-Remaining` on every `/mcp` response
- **Webhook Signatures** — HMAC-SHA256 signed webhook payloads (`X-PayGate-Signature`) for tamper-proof delivery
- **Admin Lifecycle Events** — Webhook notifications for key.created, key.revoked, key.rotated, key.topup
- **IP Allowlisting** — Restrict API keys to specific IPs or CIDR ranges (IPv4)
- **Key Tags/Metadata** — Attach arbitrary key-value tags to API keys for external system integration
- **Usage Analytics** — Time-series analytics API with tool breakdown, top consumers, and trend comparison
- **Alert Webhooks** — Configurable alerts for spending thresholds, low credits, quota warnings, key expiry, rate limit spikes
- **Team Management** — Group API keys into teams with shared budgets, quotas, and usage tracking
- **Horizontal Scaling (Redis)** — Redis-backed state for multi-process deployments with atomic credit deduction, distributed rate limiting, persistent usage audit trail, real-time pub/sub notifications, and admin API sync
- **Webhook Retry Queue** — Exponential backoff retry (1s, 2s, 4s...) with dead letter queue for permanently failed deliveries, admin API for monitoring and clearing
- **Refund on Failure** — Automatically refund credits when downstream tool calls fail
- **Webhook Events** — POST batched usage events to any URL for external billing/alerting
- **Config File Mode** — Load all settings from a JSON file (`--config`)
- **Shadow Mode** — Log everything without enforcing payment (for testing)
- **Persistent Storage** — Keys and credits survive restarts with `--state-file`
- **Zero Dependencies** — No external npm packages. Uses only Node.js built-ins.

## Usage

### Wrap a Local MCP Server (stdio)

```bash
# Default: 1 credit per call, 60 calls/min, port 3402
npx paygate-mcp wrap --server "npx @modelcontextprotocol/server-filesystem /tmp"

# Custom pricing and limits
npx paygate-mcp wrap \
  --server "python my-server.py" \
  --price 2 \
  --rate-limit 30 \
  --port 8080

# Per-tool pricing
npx paygate-mcp wrap \
  --server "node server.js" \
  --tool-price "search:1,generate:5,premium_analyze:20"

# Shadow mode (observe without enforcing)
npx paygate-mcp wrap --server "node server.js" --shadow
```

### Gate a Remote MCP Server (Streamable HTTP)

Gate any remote MCP server that supports the [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) (MCP spec 2025-03-26):

```bash
npx paygate-mcp wrap --remote-url "https://my-mcp-server.example.com/mcp"

# With custom pricing
npx paygate-mcp wrap \
  --remote-url "https://api.example.com/mcp" \
  --price 5 \
  --tool-price "gpt4:20,search:2"
```

The proxy handles:
- JSON-RPC forwarding via HTTP POST
- SSE (text/event-stream) response parsing
- `Mcp-Session-Id` session management
- Graceful session cleanup (HTTP DELETE on shutdown)

When started, you'll see your admin key in the console. Save it.

### Multi-Server Mode

Wrap multiple MCP servers behind a single PayGate instance. Tools are prefixed with the server name:

```bash
npx paygate-mcp wrap --config multi-server.json
```

Example `multi-server.json`:
```json
{
  "port": 3402,
  "defaultCreditsPerCall": 1,
  "servers": [
    {
      "prefix": "fs",
      "serverCommand": "npx",
      "serverArgs": ["@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    {
      "prefix": "github",
      "remoteUrl": "https://github-mcp.example.com/mcp"
    }
  ]
}
```

Tools are exposed with prefixes: `fs:read_file`, `fs:write_file`, `github:search_repos`, etc. Pricing and ACLs work on the prefixed names:

```json
{
  "toolPricing": {
    "github:search_repos": { "creditsPerCall": 5 },
    "fs:read_file": { "creditsPerCall": 1 }
  }
}
```

Credits are shared across all backends — one API key works for all servers.

### Client SDK

Use `PayGateClient` to call tools from TypeScript/Node.js with auto 402 retry:

```typescript
import { PayGateClient, PayGateError } from 'paygate-mcp/client';

const client = new PayGateClient({
  url: 'http://localhost:3402',
  apiKey: 'pg_abc123...',
  autoRetry: true,
  onCreditsNeeded: async (info) => {
    // Called when credits run out — add credits and return true to retry
    await topUpCredits(info.creditsRequired);
    return true;
  },
});

const tools = await client.listTools();
const result = await client.callTool('search', { query: 'hello' });
const balance = await client.getBalance();
```

Features:
- **Auto 402 retry**: When a tool call returns payment-required, calls `onCreditsNeeded` and retries
- **Balance tracking**: `client.lastKnownBalance` tracks credits from `getBalance()` calls
- **Typed errors**: `PayGateError` with `.isPaymentRequired`, `.isRateLimited`, `.isExpired` helpers
- **Zero dependencies**: Uses Node.js built-in `http`/`https`

### Create API Keys

```bash
curl -X POST http://localhost:3402/keys \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"name": "my-client", "credits": 100}'
```

### Call Tools

```bash
curl -X POST http://localhost:3402/mcp \
  -H "Content-Type: application/json" \
  -H "X-API-Key: CLIENT_API_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "read_file",
      "arguments": {"path": "/tmp/test.txt"}
    }
  }'
```

### Top Up Credits

```bash
curl -X POST http://localhost:3402/topup \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"key": "CLIENT_API_KEY", "credits": 500}'
```

### Check Balance (Client Self-Service)

```bash
curl http://localhost:3402/balance \
  -H "X-API-Key: CLIENT_API_KEY"
```

Returns credits, total spent, call count, and last used timestamp. Clients can check their own balance without needing admin access.

### Export Usage Data (Admin)

```bash
# JSON export
curl http://localhost:3402/usage \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"

# CSV export (for spreadsheet/billing import)
curl "http://localhost:3402/usage?format=csv" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"

# Filter by date
curl "http://localhost:3402/usage?since=2025-01-01T00:00:00Z" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"
```

Returns per-call usage events with tool name, credits charged, and timestamps. API keys are masked in output.

### Check Status

```bash
curl http://localhost:3402/status \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"
```

Returns active keys, usage stats, per-tool breakdown, and deny reasons.

### Admin Dashboard

Open the web dashboard in your browser:

```
http://localhost:3402/dashboard
```

A real-time admin UI for managing keys, viewing usage, and monitoring tool calls. Enter your admin key to authenticate. Features auto-refresh every 30s, top tools chart, activity feed, and key creation/management.

## API Reference

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/mcp` | POST | `X-API-Key` or `Bearer` | JSON-RPC 2.0 proxy (returns JSON or SSE) |
| `/mcp` | GET | `X-API-Key` or `Bearer` | SSE notification stream (Streamable HTTP) |
| `/mcp` | DELETE | `Mcp-Session-Id` | Terminate an MCP session |
| `/balance` | GET | `X-API-Key` | Client self-service — check credits, quota, ACL, expiry |
| `/keys` | POST | `X-Admin-Key` | Create API key (with ACL, expiry, quota, credits) |
| `/keys` | GET | `X-Admin-Key` | List all keys (masked, with expiry status) |
| `/topup` | POST | `X-Admin-Key` | Add credits to an existing key |
| `/keys/revoke` | POST | `X-Admin-Key` | Revoke an API key |
| `/keys/rotate` | POST | `X-Admin-Key` | Rotate key (new key, same credits/ACL/quotas) |
| `/keys/acl` | POST | `X-Admin-Key` | Set tool ACL (whitelist/blacklist) on a key |
| `/keys/expiry` | POST | `X-Admin-Key` | Set or remove key expiry (TTL) |
| `/keys/quota` | POST | `X-Admin-Key` | Set usage quota (daily/monthly limits) |
| `/keys/tags` | POST | `X-Admin-Key` | Set key tags/metadata (merge semantics) |
| `/keys/ip` | POST | `X-Admin-Key` | Set IP allowlist (CIDR + exact match) |
| `/keys/search` | POST | `X-Admin-Key` | Search keys by tag values |
| `/limits` | POST | `X-Admin-Key` | Set spending limit on a key |
| `/usage` | GET | `X-Admin-Key` | Export usage data (JSON or CSV) |
| `/status` | GET | `X-Admin-Key` | Full dashboard with usage stats |
| `/dashboard` | GET | None (admin key in-browser) | Real-time admin web dashboard |
| `/stripe/webhook` | POST | Stripe Signature | Auto-top-up credits on payment |
| `/.well-known/oauth-authorization-server` | GET | None | OAuth 2.1 server metadata |
| `/oauth/register` | POST | None | Dynamic Client Registration (RFC 7591) |
| `/oauth/authorize` | GET | None | Authorization endpoint (PKCE required) |
| `/oauth/token` | POST | None | Token endpoint (code exchange + refresh) |
| `/oauth/revoke` | POST | None | Token revocation (RFC 7009) |
| `/oauth/clients` | GET | `X-Admin-Key` | List registered OAuth clients |
| `/.well-known/mcp-payment` | GET | None | Server payment metadata (SEP-2007) |
| `/pricing` | GET | None | Full per-tool pricing breakdown |
| `/metrics` | GET | None | Prometheus metrics (counters, gauges, uptime) |
| `/analytics` | GET | `X-Admin-Key` | Usage analytics (time-series, tool breakdown, trends) |
| `/alerts` | GET | `X-Admin-Key` | Consume pending alerts |
| `/alerts` | POST | `X-Admin-Key` | Configure alert rules |
| `/teams` | GET | `X-Admin-Key` | List all teams |
| `/teams` | POST | `X-Admin-Key` | Create a team (name, budget, quota, tags) |
| `/teams/update` | POST | `X-Admin-Key` | Update team settings |
| `/teams/delete` | POST | `X-Admin-Key` | Delete (deactivate) a team |
| `/teams/assign` | POST | `X-Admin-Key` | Assign an API key to a team |
| `/teams/remove` | POST | `X-Admin-Key` | Remove an API key from a team |
| `/teams/usage` | GET | `X-Admin-Key` | Team usage summary with member breakdown |
| `/audit` | GET | `X-Admin-Key` | Query audit log (filter by type, actor, time) |
| `/audit/export` | GET | `X-Admin-Key` | Export full audit log (JSON or CSV) |
| `/audit/stats` | GET | `X-Admin-Key` | Audit log statistics |
| `/` | GET | None | Health check |

### Free Methods

These MCP methods pass through without auth or billing:
`initialize`, `initialized`, `ping`, `tools/list`, `resources/list`, `prompts/list`

## CLI Options

```
--server <cmd>       MCP server command to wrap via stdio
--remote-url <url>   Remote MCP server URL (Streamable HTTP transport)
--port <n>           HTTP port (default: 3402)
--price <n>          Default credits per tool call (default: 1)
--rate-limit <n>     Max calls/min per key (default: 60, 0=unlimited)
--name <s>           Server display name
--shadow             Shadow mode — log without enforcing payment
--admin-key <s>      Set admin key (default: auto-generated)
--tool-price <t:n>   Per-tool price (e.g. "search:5,generate:10")
--import-key <k:c>   Import existing key with credits (e.g. "pg_abc:100")
--state-file <path>  Persist keys/credits to a JSON file (survives restarts)
--stripe-secret <s>  Stripe webhook signing secret (enables /stripe/webhook)
--webhook-url <url>  POST batched usage events to this URL
--webhook-secret <s> HMAC-SHA256 secret for signing webhook payloads
--refund-on-failure  Refund credits when downstream tool call fails
--redis-url <url>    Redis URL for distributed state (e.g. "redis://localhost:6379")
--config <path>      Load settings from a JSON config file
```

> **Note:** Use `--server` OR `--remote-url` for single-server mode. Use `servers` in a config file for multi-server mode.

### Persistent Storage

Add `--state-file` to save API keys and credits to disk. Data survives server restarts.

```bash
npx paygate-mcp wrap --server "your-mcp-server" --state-file ~/.paygate/state.json
```

### Stripe Integration

Connect Stripe to automatically top up credits when customers pay:

```bash
npx paygate-mcp wrap \
  --server "your-mcp-server" \
  --state-file ~/.paygate/state.json \
  --stripe-secret "whsec_your_stripe_webhook_secret"
```

**Setup:**
1. Create a Stripe Checkout Session with metadata:
   - `paygate_api_key` — the customer's API key (e.g. `pg_abc123...`)
   - `paygate_credits` — credits to add on payment (e.g. `500`)
2. Point your Stripe webhook to `https://your-server/stripe/webhook`
3. Subscribe to `checkout.session.completed` and `invoice.payment_succeeded` events

When a customer completes payment, credits are automatically added to their API key. Subscriptions auto-renew credits on each billing cycle.

**Security:**
- HMAC-SHA256 signature verification (Stripe's v1 scheme)
- Timing-safe comparison to prevent timing attacks
- 5-minute timestamp tolerance to prevent replay attacks
- Payment status verification (only `paid` triggers credits)
- Zero dependencies — uses Node.js built-in `crypto`

### Per-Tool ACL (Access Control)

Control which tools each API key can access:

```bash
# Create a key that can only access search and read tools
curl -X POST http://localhost:3402/keys \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"name": "limited-client", "credits": 100, "allowedTools": ["search", "read_file"]}'

# Create a key with specific tools blocked
curl -X POST http://localhost:3402/keys \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"name": "safe-client", "credits": 100, "deniedTools": ["delete_file", "admin_reset"]}'

# Update ACL on an existing key
curl -X POST http://localhost:3402/keys/acl \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"key": "CLIENT_API_KEY", "allowedTools": ["search"], "deniedTools": ["admin"]}'
```

- **allowedTools** (whitelist): Only these tools are accessible. Empty = all tools.
- **deniedTools** (blacklist): These tools are always denied. Applied after allowedTools.
- ACL also filters `tools/list` — clients only see their permitted tools.

### Per-Tool Rate Limits

Set independent rate limits per tool (on top of the global limit):

```json
{
  "toolPricing": {
    "expensive_analyze": { "creditsPerCall": 10, "rateLimitPerMin": 5 },
    "search": { "creditsPerCall": 1, "rateLimitPerMin": 30 },
    "cheap_read": { "creditsPerCall": 1 }
  }
}
```

Per-tool limits are enforced independently per API key. A key can be rate-limited on one tool while still accessing others. The global `--rate-limit` applies across all tools.

### Key Expiry (TTL)

Create API keys that auto-expire:

```bash
# Create a key that expires in 1 hour (3600 seconds)
curl -X POST http://localhost:3402/keys \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"name": "trial-user", "credits": 50, "expiresIn": 3600}'

# Create a key with a specific expiry date
curl -X POST http://localhost:3402/keys \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"name": "quarterly", "credits": 1000, "expiresAt": "2026-06-01T00:00:00Z"}'

# Set or extend expiry on an existing key
curl -X POST http://localhost:3402/keys/expiry \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"key": "CLIENT_API_KEY", "expiresIn": 86400}'

# Remove expiry (key never expires)
curl -X POST http://localhost:3402/keys/expiry \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"key": "CLIENT_API_KEY", "expiresAt": null}'
```

Expired keys return a clear `api_key_expired` error. Admins can extend or remove expiry at any time.

### Spending Limits

Cap the total credits any API key can spend:

```bash
# Set a spending limit on a key (admin only)
curl -X POST http://localhost:3402/limits \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"key": "CLIENT_API_KEY", "spendingLimit": 500}'

# Check remaining budget
curl http://localhost:3402/balance -H "X-API-Key: CLIENT_API_KEY"
# → { "spendingLimit": 500, "remainingBudget": 350, ... }
```

Set `spendingLimit` to `0` for unlimited. When a key hits its limit, tool calls are denied with a clear error.

### Refund on Failure

Automatically return credits when a downstream tool call fails:

```bash
npx paygate-mcp wrap --server "node server.js" --refund-on-failure
```

Credits are deducted before the tool call. If the wrapped server returns an error, credits are refunded and `totalSpent` / `totalCalls` are rolled back. Prevents charging users for failed operations.

### Webhook Events

POST usage events to any external URL for billing, alerting, or analytics:

```bash
npx paygate-mcp wrap --server "node server.js" --webhook-url "https://billing.example.com/events"
```

Events are batched (up to 10 per POST) and flushed every 5 seconds. Each event includes tool name, credits charged, API key, and timestamp.

#### Retry Queue & Dead Letters

Failed webhook deliveries are retried with exponential backoff (1s, 2s, 4s, 8s, 16s — configurable up to `--webhook-retries` attempts). After all retries are exhausted, events move to a dead letter queue for admin inspection.

```bash
# Custom max retries (default: 5)
npx paygate-mcp wrap --server "node server.js" \
  --webhook-url "https://billing.example.com/events" \
  --webhook-retries 10
```

**Admin endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/webhooks/stats` | GET | Delivery statistics (delivered, failed, pending retries, dead letters) |
| `/webhooks/dead-letter` | GET | List permanently failed deliveries with error details |
| `/webhooks/dead-letter` | DELETE | Clear dead letter queue |

Retry attempts include an `X-PayGate-Retry` header with the attempt number for observability.

#### Webhook Signatures (HMAC-SHA256)

Sign webhook payloads for tamper-proof delivery:

```bash
npx paygate-mcp wrap --server "node server.js" \
  --webhook-url "https://billing.example.com/events" \
  --webhook-secret "whsec_your_secret_here"
```

When `--webhook-secret` is set, every webhook POST includes an `X-PayGate-Signature` header:

```
X-PayGate-Signature: t=1709123456,v1=a1b2c3d4...
```

**Verifying signatures** (Node.js example):
```typescript
import { WebhookEmitter } from 'paygate-mcp';

const signature = req.headers['x-paygate-signature'];
const [tPart, v1Part] = signature.split(',');
const timestamp = tPart.split('=')[1];
const sig = v1Part.split('=')[1];

// Reconstruct signed payload: timestamp.body
const signedPayload = `${timestamp}.${rawBody}`;
const isValid = WebhookEmitter.verify(signedPayload, sig, 'whsec_your_secret_here');
```

The signature covers `timestamp.body` to prevent replay attacks. Use timing-safe comparison (built into `WebhookEmitter.verify`).

#### Admin Lifecycle Events

When webhooks are enabled, admin operations also fire webhook events:

| Event Type | Trigger | Metadata |
|------------|---------|----------|
| `key.created` | POST /keys | keyMasked, name, credits |
| `key.topup` | POST /topup | keyMasked, creditsAdded, newBalance |
| `key.revoked` | POST /keys/revoke | keyMasked |
| `key.rotated` | POST /keys/rotate | oldKeyMasked, newKeyMasked |
| `key.expired` | Gate evaluation | keyMasked |
| `alert.fired` | Gate evaluation | alertType, keyPrefix, message, value, threshold |
| `team.created` | POST /teams | teamId, name, budget |
| `team.updated` | POST /teams/update | teamId, changes |
| `team.deleted` | POST /teams/delete | teamId |
| `team.key_assigned` | POST /teams/assign | teamId, keyMasked |
| `team.key_removed` | POST /teams/remove | teamId, keyMasked |

Admin events appear in the `adminEvents` array of the webhook payload (separate from usage `events`). Both arrays can be present in the same batch.

### Usage Quotas

Set daily or monthly usage limits per API key:

```bash
# Create a key with 10 calls/day, 200 calls/month
curl -X POST http://localhost:3402/keys \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"name": "metered-user", "credits": 1000, "quota": {"dailyCallLimit": 10, "monthlyCallLimit": 200}}'

# Set credit-based quotas (max 50 credits/day)
curl -X POST http://localhost:3402/keys/quota \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"key": "CLIENT_API_KEY", "dailyCreditLimit": 50}'

# Remove per-key quota (fall back to global defaults)
curl -X POST http://localhost:3402/keys/quota \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"key": "CLIENT_API_KEY", "remove": true}'
```

Quota types: `dailyCallLimit`, `monthlyCallLimit`, `dailyCreditLimit`, `monthlyCreditLimit`. Set to 0 for unlimited. Counters reset at UTC midnight (daily) and UTC month boundary (monthly). Set global defaults in the config file with `globalQuota`.

### Dynamic Pricing

Charge extra credits based on input argument size:

```json
{
  "toolPricing": {
    "analyze_text": { "creditsPerCall": 2, "creditsPerKbInput": 5 },
    "search": { "creditsPerCall": 1 }
  }
}
```

For `analyze_text`, a 3 KB input would cost `2 + ceil(3 × 5) = 17` credits. Small inputs round up to at least 1 KB. Tools without `creditsPerKbInput` use the flat base price.

### OAuth 2.1

Full OAuth 2.1 authorization server for MCP clients. Implements PKCE, dynamic client registration, token refresh, and revocation.

Enable OAuth in config:
```json
{
  "oauth": {
    "accessTokenTtl": 3600,
    "refreshTokenTtl": 2592000,
    "scopes": ["tools:*", "tools:read", "tools:write"]
  }
}
```

**Full flow:**
```bash
# 1. Register an OAuth client
curl -X POST http://localhost:3402/oauth/register \
  -H "Content-Type: application/json" \
  -d '{"client_name": "My Agent", "redirect_uris": ["http://localhost:8080/callback"], "api_key": "pg_..."}'

# 2. Generate PKCE challenge (code_verifier → SHA256 → base64url)
# 3. Authorize: GET /oauth/authorize?response_type=code&client_id=...&redirect_uri=...&code_challenge=...&code_challenge_method=S256
# 4. Exchange code for tokens
curl -X POST http://localhost:3402/oauth/token \
  -H "Content-Type: application/json" \
  -d '{"grant_type": "authorization_code", "code": "...", "client_id": "...", "redirect_uri": "...", "code_verifier": "..."}'

# 5. Use Bearer token on /mcp
curl -X POST http://localhost:3402/mcp \
  -H "Authorization: Bearer pg_at_..." \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "search", "arguments": {"query": "hello"}}}'

# 6. Refresh token
curl -X POST http://localhost:3402/oauth/token \
  -d '{"grant_type": "refresh_token", "refresh_token": "pg_rt_...", "client_id": "..."}'
```

OAuth tokens are backed by API keys — each token maps to an API key for billing. The `/mcp` endpoint accepts both `X-API-Key` and `Authorization: Bearer` headers.

### SSE Streaming (MCP Streamable HTTP)

PayGate implements the full MCP Streamable HTTP transport with SSE support:

```bash
# POST /mcp with SSE response (add Accept header)
curl -N -X POST http://localhost:3402/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -H "X-API-Key: YOUR_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"analyze","arguments":{}}}'
# Response: SSE stream with event: message + data: {jsonrpc response}

# GET /mcp — Open SSE notification stream
curl -N http://localhost:3402/mcp \
  -H "Accept: text/event-stream" \
  -H "Mcp-Session-Id: mcp_sess_..."
# Receives server-initiated notifications as SSE events

# DELETE /mcp — Terminate session
curl -X DELETE http://localhost:3402/mcp \
  -H "Mcp-Session-Id: mcp_sess_..."
```

**Session Management:**
- Every POST `/mcp` response includes an `Mcp-Session-Id` header
- Clients reuse sessions by sending `Mcp-Session-Id` on subsequent requests
- GET `/mcp` opens a long-lived SSE connection for server-to-client notifications
- DELETE `/mcp` terminates a session and closes all SSE connections
- Sessions auto-expire after 30 minutes of inactivity

**Transport modes:**
- `POST /mcp` without `Accept: text/event-stream` → standard JSON response (backward compatible)
- `POST /mcp` with `Accept: text/event-stream` → SSE-wrapped JSON-RPC response
- `GET /mcp` with `Accept: text/event-stream` → long-lived notification stream

### Audit Log

Every significant operation is recorded in a structured audit trail:

```bash
# Query audit events (with filtering)
curl http://localhost:3402/audit?types=key.created,gate.deny&limit=50 \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"

# Export full audit log as CSV
curl http://localhost:3402/audit/export?format=csv \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" > audit.csv

# Get audit statistics
curl http://localhost:3402/audit/stats \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"
```

**Tracked events:** `key.created`, `key.revoked`, `key.topup`, `key.acl_updated`, `key.expiry_updated`, `key.quota_updated`, `key.limit_updated`, `key.tags_updated`, `key.ip_updated`, `gate.allow`, `gate.deny`, `session.created`, `session.destroyed`, `oauth.client_registered`, `oauth.token_issued`, `oauth.token_revoked`, `admin.auth_failed`, `admin.alerts_configured`, `billing.refund`, `team.created`, `team.updated`, `team.deleted`, `team.key_assigned`, `team.key_removed`.

**Retention:** Ring buffer (default 10,000 events), age-based cleanup (default 30 days), automatic periodic enforcement.

### Registry/Discovery (Agent-Discoverable Pricing)

AI agents can programmatically discover your server's pricing and payment requirements before calling tools. Aligns with SEP-2007 (MCP Payment Spec Draft).

```bash
# Discover server payment metadata (public, no auth)
curl http://localhost:3402/.well-known/mcp-payment
# → { "specVersion": "2007-draft", "billingModel": "credits", "defaultCreditsPerCall": 1, ... }

# Get full pricing breakdown (public, no auth)
curl http://localhost:3402/pricing
# → { "server": {...}, "tools": [{ "name": "search", "creditsPerCall": 5, "pricingModel": "dynamic" }, ...] }
```

**How it works:**
- `/.well-known/mcp-payment` — Server-level payment metadata (billing model, auth methods, error codes)
- `/pricing` — Full per-tool pricing breakdown with overrides
- `tools/list` responses include `_pricing` metadata on each tool (creditsPerCall, pricingModel, rateLimitPerMin)
- `-32402` error responses include pricing details so agents know how to afford the tool

Both discovery endpoints are **public** (no auth required) so agents can check pricing before obtaining an API key.

### Prometheus Metrics

Monitor your PayGate server with any Prometheus-compatible monitoring system:

```bash
curl http://localhost:3402/metrics
```

Returns metrics in standard Prometheus text exposition format:

```
# HELP paygate_tool_calls_total Total tool calls processed
# TYPE paygate_tool_calls_total counter
paygate_tool_calls_total{status="allowed",tool="search"} 42
paygate_tool_calls_total{status="denied",tool="premium"} 3

# HELP paygate_credits_charged_total Total credits charged
# TYPE paygate_credits_charged_total counter
paygate_credits_charged_total{tool="search"} 210

# HELP paygate_active_keys_total Number of active (non-revoked) API keys
# TYPE paygate_active_keys_total gauge
paygate_active_keys_total 5

# HELP paygate_uptime_seconds Server uptime in seconds
# TYPE paygate_uptime_seconds gauge
paygate_uptime_seconds 3600
```

**Available metrics:**
- `paygate_tool_calls_total{tool,status}` — Tool calls (allowed/denied)
- `paygate_credits_charged_total{tool}` — Credits charged per tool
- `paygate_denials_total{reason}` — Denials by reason (insufficient_credits, rate_limited, etc.)
- `paygate_rate_limit_hits_total{tool}` — Rate limit hits per tool
- `paygate_refunds_total{tool}` — Credit refunds per tool
- `paygate_http_requests_total{method,path,status}` — HTTP requests
- `paygate_active_keys_total` — Active API keys (gauge)
- `paygate_active_sessions_total` — Active MCP sessions (gauge)
- `paygate_total_credits_available` — Total credits across all keys (gauge)
- `paygate_uptime_seconds` — Server uptime (gauge)

The `/metrics` endpoint is **public** (no auth required) for easy Prometheus scraping.

### Key Rotation

Rotate an API key without losing credits, ACLs, quotas, or spending limits:

```bash
curl -X POST http://localhost:3402/keys/rotate \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"key": "pg_oldkey..."}'
# → { "message": "Key rotated", "newKey": "pg_newkey...", "name": "my-key", "credits": 500 }
```

The old key is immediately invalidated. All state (credits, totalSpent, totalCalls, ACL, quota, expiry, spending limit) transfers to the new key. Use this for periodic key rotation policies, compromised key response, or key migration.

### IP Allowlisting

Restrict API keys to specific IP addresses or CIDR ranges:

```bash
# Set IP allowlist on a key (replaces existing list)
curl -X POST http://localhost:3402/keys/ip \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"key": "pg_...", "ips": ["192.168.1.0/24", "10.0.0.5"]}'

# Clear allowlist (allow all IPs)
curl -X POST http://localhost:3402/keys/ip \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"key": "pg_...", "ips": []}'
```

You can also set the allowlist at key creation time:

```bash
curl -X POST http://localhost:3402/keys \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"name": "prod-agent", "credits": 1000, "ipAllowlist": ["10.0.0.0/8"]}'
```

Supports exact IPv4 matching and CIDR notation (`/8`, `/16`, `/24`, `/32`, etc.). When the allowlist is empty, all IPs are allowed. Client IP is extracted from `X-Forwarded-For` header (first value) or socket remote address.

### Key Tags / Metadata

Attach arbitrary key-value tags to API keys for external system integration:

```bash
# Set tags (merge semantics — existing tags preserved, new ones added/updated)
curl -X POST http://localhost:3402/keys/tags \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"key": "pg_...", "tags": {"team": "backend", "env": "production", "customer_id": "cus_123"}}'

# Remove a tag (set value to null)
curl -X POST http://localhost:3402/keys/tags \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"key": "pg_...", "tags": {"env": null}}'

# Search keys by tags
curl -X POST http://localhost:3402/keys/search \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"tags": {"team": "backend"}}'
# → { "keys": [...], "count": 3 }
```

Tags can also be set at key creation:

```bash
curl -X POST http://localhost:3402/keys \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"name": "backend-prod", "credits": 5000, "tags": {"team": "backend", "env": "production"}}'
```

Limits: max 50 tags per key, max 100 chars per key/value. Tags appear in `/balance` responses and key listings.

### Usage Analytics

Query aggregated usage data for dashboards, reports, and trend analysis:

```bash
# Get analytics for the last 24 hours (hourly buckets)
curl "http://localhost:3402/analytics?from=2026-02-25T00:00:00Z&to=2026-02-26T00:00:00Z&granularity=hourly" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"

# Daily granularity with top 5 consumers
curl "http://localhost:3402/analytics?granularity=daily&topN=5" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"
```

Returns:
- **timeSeries** — Bucketed call counts, credits charged, and denials per time window
- **toolBreakdown** — Per-tool stats (calls, credits, average cost) sorted by usage
- **topConsumers** — Top N API keys by credits spent, with each key's most-used tool
- **trend** — Current vs previous period comparison with percentage changes (calls, credits, denials)
- **summary** — Total calls, credits, unique keys, and unique tools

Query parameters: `from` (ISO date), `to` (ISO date), `granularity` (`hourly` or `daily`, default: `hourly`), `topN` (number, default: `10`).

### Alert Webhooks

Configure rules to fire alerts when usage thresholds are crossed. Alerts are delivered via webhooks as `alert.fired` admin events:

```bash
# Configure alert rules
curl -X POST http://localhost:3402/alerts \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"rules": [
    {"type": "spending_threshold", "threshold": 80},
    {"type": "credits_low", "threshold": 50},
    {"type": "quota_warning", "threshold": 90},
    {"type": "key_expiry_soon", "threshold": 86400},
    {"type": "rate_limit_spike", "threshold": 10}
  ]}'

# Consume pending alerts (returns and clears queue)
curl http://localhost:3402/alerts \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"
```

**Alert types:**

| Type | Threshold Meaning | Fires When |
|------|-------------------|------------|
| `spending_threshold` | Percentage (0–100) | Key has spent ≥ threshold% of its initial credits |
| `credits_low` | Absolute credits | Key's remaining credits drop below threshold |
| `quota_warning` | Percentage (0–100) | Key's daily call usage exceeds threshold% of quota |
| `key_expiry_soon` | Seconds | Key expires within threshold seconds |
| `rate_limit_spike` | Count | Key has ≥ threshold rate-limit denials in 5 minutes |

Each rule has an optional `cooldownSeconds` (default: 300) to prevent alert storms. Alerts are automatically checked on every gate evaluation (tool call).

When webhooks are enabled (`--webhook-url`), alerts fire as `alert.fired` events in the `adminEvents` webhook payload with full context (key, rule type, current value, threshold).

### Team Management

Group API keys into teams with shared budgets, quotas, and usage tracking. Teams enforce budget and quota limits at the gate level — if a key belongs to a team that has exceeded its budget or quota, tool calls are denied even if the individual key has credits remaining.

```bash
# Create a team
curl -X POST http://localhost:3402/teams \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"name": "Engineering", "budget": 10000, "tags": {"dept": "eng"}}'

# Assign an API key to a team
curl -X POST http://localhost:3402/teams/assign \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"teamId": "team_abc123...", "apiKey": "pg_abc123..."}'

# Set team quotas (daily/monthly limits)
curl -X POST http://localhost:3402/teams/update \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"teamId": "team_abc123...", "quota": {"dailyCalls": 1000, "monthlyCalls": 25000, "dailyCredits": 5000, "monthlyCredits": 100000}}'

# View team usage with member breakdown
curl "http://localhost:3402/teams/usage?teamId=team_abc123..." \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"
```

**Team features:**

| Feature | Description |
|---------|-------------|
| Shared budget | Pool credits across all team members (0 = unlimited) |
| Team quotas | Daily/monthly call and credit limits (UTC auto-reset) |
| Member breakdown | Per-key usage within the team (keys masked) |
| Tags/metadata | Attach key-value pairs for department, project, etc. |
| Max 100 keys | Per team limit to prevent abuse |
| Gate integration | Budget + quota checked on every tool call |
| Audit trail | team.created, team.updated, team.deleted, team.key_assigned, team.key_removed events |

Each API key can belong to at most one team. Team budget and quota checks happen after individual key checks — both must pass for a tool call to succeed.

### Rate Limit Response Headers

Every `/mcp` response includes rate limit and credits headers when an API key is provided:

```
X-RateLimit-Limit: 100        # Max calls per window
X-RateLimit-Remaining: 87     # Calls remaining in current window
X-RateLimit-Reset: 45         # Seconds until window resets
X-Credits-Remaining: 4500     # Credits remaining on the key
```

When a tool has a per-tool rate limit, the headers reflect that tool's limit (not the global limit). These headers are CORS-exposed so browser-based agents can read them.

### Horizontal Scaling (Redis)

Enable Redis-backed state for multi-process deployments. Multiple PayGate instances share API keys, credits, and usage data through Redis:

```bash
# Single instance with Redis persistence
npx paygate-mcp wrap --server "your-mcp-server" --redis-url "redis://localhost:6379"

# With password and database
npx paygate-mcp wrap --server "your-mcp-server" \
  --redis-url "redis://:mypassword@redis.internal:6379/2"
```

Or in a config file:
```json
{
  "serverCommand": "your-mcp-server",
  "redisUrl": "redis://localhost:6379"
}
```

**Architecture: Write-Through Cache**

PayGate uses a write-through cache pattern for maximum performance:

- **Reads** — Served from in-memory KeyStore (zero latency, no Redis round-trip)
- **Writes** — Propagated to Redis for cross-process shared state
- **Credit deduction** — Uses Redis Lua scripts for atomic check-and-deduct (prevents double-spend across processes)
- **Periodic sync** — Local caches refresh from Redis every 5 seconds as a safety net
- **Pub/sub notifications** — Key mutations and credit changes propagate to all instances in real-time via Redis PUBLISH/SUBSCRIBE (sub-millisecond latency)

This means Gate.evaluate() stays synchronous and fast, while credit operations remain atomic across your entire fleet. The server automatically wires Redis hooks into the gate — every usage event and credit deduction flows to Redis without any code changes. Pub/sub ensures other instances see changes near-instantly (no 5-second wait).

**What Gets Synced**

| State | Redis Key Pattern | Sync Method |
|-------|-------------------|-------------|
| API keys | `pg:key:<keyId>` (Hash) | Write-through + pub/sub + periodic refresh |
| Key registry | `pg:keys` (Set) | Write-through |
| Credit deduction | `pg:key:<keyId>` | Atomic Lua script + pub/sub broadcast |
| Credit top-up | `pg:key:<keyId>` | Atomic Lua script + pub/sub broadcast |
| Admin mutations | `pg:key:<keyId>` (Hash) | Write-through (all admin endpoints) |
| Rate limiting | `pg:rate:<key>` (Sorted Set) | Atomic Lua (sliding window) |
| Usage events | `pg:usage` (List) | Fire-and-forget RPUSH |
| Cross-instance events | `pg:events` (Pub/Sub) | PUBLISH/SUBSCRIBE with inline data |

**Deployment Pattern**

```
                    ┌──────────────┐
                    │   Redis 7+   │
                    │  ┌────────┐  │
                    │  │pub/sub │  │
                    └──┴───┬────┴──┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────┴─────┐ ┌───┴───┐ ┌─────┴─────┐
        │ PayGate 1 │ │  PG 2 │ │ PayGate 3 │
        │ (sub+pub) │ │ (sub) │ │ (sub+pub) │
        └─────┬─────┘ └───┬───┘ └─────┬─────┘
              │            │            │
        ┌─────┴────────────┴────────────┴─────┐
        │          Load Balancer               │
        └──────────────────────────────────────┘
```

**Real-Time Pub/Sub** — When one instance creates/revokes a key or changes credits, it publishes an event to the `pg:events` channel. All other instances receive it instantly and update their local KeyStore without waiting for the 5-second sync. Credit changes include inline data (credits, totalSpent, totalCalls) so receivers skip the Redis roundtrip entirely. Each instance has a unique ID for self-message filtering — no echo loops. If pub/sub fails, the periodic sync continues as a fallback.

**Admin API Sync** — All admin HTTP endpoints (create key, revoke, rotate, topup, set ACL, expiry, quota, tags, IP allowlist, spending limit) write through to Redis. Topup and revoke use atomic Lua scripts; other mutations use fire-and-forget `HSET` to propagate changes across instances immediately.

**Distributed Rate Limiting** — Rate limits are enforced atomically across all instances using Redis sorted sets with Lua scripts. Each rate check does ZREMRANGEBYSCORE + ZCARD + ZADD in a single round-trip, preventing burst bypass across processes. Falls open (allows) if Redis is temporarily unavailable.

**Persistent Usage Audit Trail** — Usage events are appended to a Redis list (RPUSH), creating a shared audit trail visible from any instance. Events survive process restarts and are queryable from the dashboard. Max 100k events with automatic trimming.

**Graceful Fallback** — If Redis is temporarily unavailable, PayGate falls back to local in-memory operations. On reconnect, state syncs automatically.

**Zero Dependencies** — The Redis client uses Node.js `net.Socket` with raw RESP protocol encoding. No `ioredis`, no `redis` package — pure built-in networking.

### Config File Mode

Load all settings from a JSON file instead of CLI flags:

```bash
npx paygate-mcp wrap --config paygate.json
```

Example `paygate.json`:
```json
{
  "serverCommand": "npx",
  "serverArgs": ["@modelcontextprotocol/server-filesystem", "/tmp"],
  "port": 3402,
  "defaultCreditsPerCall": 2,
  "globalRateLimitPerMin": 30,
  "webhookUrl": "https://billing.example.com/events",
  "refundOnFailure": true,
  "stateFile": "~/.paygate/state.json",
  "toolPricing": {
    "premium_analyze": { "creditsPerCall": 10, "creditsPerKbInput": 5 }
  },
  "globalQuota": {
    "dailyCallLimit": 1000,
    "monthlyCreditLimit": 50000
  },
  "oauth": {
    "accessTokenTtl": 3600,
    "scopes": ["tools:*"]
  },
  "redisUrl": "redis://localhost:6379",
  "importKeys": {
    "pg_abc123def456": 500
  }
}
```

CLI flags override config file values when both are specified.

## Programmatic API

```typescript
import { PayGateServer } from 'paygate-mcp';

// Wrap a local server (stdio)
const server = new PayGateServer({
  serverCommand: 'npx',
  serverArgs: ['@modelcontextprotocol/server-filesystem', '/tmp'],
  port: 3402,
  defaultCreditsPerCall: 1,
  toolPricing: {
    'premium_analyze': { creditsPerCall: 10 }
  },
});

const { port, adminKey } = await server.start();

// Multi-server mode
const multiServer = new PayGateServer(
  { serverCommand: '', port: 3402, defaultCreditsPerCall: 1 },
  undefined, undefined, undefined, undefined,
  [
    { prefix: 'fs', serverCommand: 'npx', serverArgs: ['@modelcontextprotocol/server-filesystem', '/tmp'] },
    { prefix: 'api', remoteUrl: 'https://my-mcp-server.example.com/mcp' },
  ]
);

// With Redis for horizontal scaling
const redisServer = new PayGateServer(
  { serverCommand: 'npx', serverArgs: ['my-mcp-server'], port: 3402, defaultCreditsPerCall: 1 },
  undefined, undefined, undefined, undefined, undefined,
  'redis://localhost:6379'
);

// Client SDK
import { PayGateClient } from 'paygate-mcp/client';

const client = new PayGateClient({
  url: `http://localhost:${port}`,
  apiKey: 'pg_...',
});

const tools = await client.listTools();
const result = await client.callTool('search', { query: 'hello' });
```

## Security

- Cryptographic API key generation (`pg_` prefix, 48 hex chars)
- Keys masked in list endpoints
- Integer-only credits (no float precision attacks)
- 1MB request body limit
- Input sanitization on all endpoints
- Admin key never exposed in responses
- API keys never forwarded to remote servers (HTTP transport)
- Rate limiting is per-key, concurrent-safe
- Stripe webhook signature verification (HMAC-SHA256, timing-safe)
- Dashboard uses safe DOM methods (textContent/createElement) — no innerHTML
- Webhook HMAC-SHA256 signatures with timing-safe verification
- Webhook URLs masked in status output
- Spending limits enforced with integer arithmetic (no float bypass)
- Per-tool ACL enforcement (whitelist + blacklist, sanitized inputs)
- Key expiry with fail-closed behavior (expired = denied)
- OAuth 2.1 with PKCE (S256) — no implicit grant, no plain challenge
- OAuth tokens are opaque hex strings (no JWT data leakage)
- Quota counters reset atomically at UTC boundaries
- SSE sessions auto-expire (30 min), max 1000 concurrent, max 3 SSE per session
- Audit log with retention policies (ring buffer, age-based cleanup)
- API keys masked in audit events (only first 7 + last 4 chars visible)
- Discovery endpoints (/.well-known/mcp-payment, /pricing) are public but read-only
- Team budgets enforce integer arithmetic (no float bypass)
- Keys masked in team usage summaries (first 7 + last 4 chars only)
- Team quota resets atomic at UTC day/month boundaries
- Redis credit deduction uses Lua scripts for atomic check-and-deduct (no double-spend)
- Redis rate limiting uses Lua scripts for atomic check-and-record (no burst bypass)
- Redis auth supported via password in URL (redis://:password@host:port)
- Graceful Redis fallback — local operations continue if Redis disconnects
- Rate limiter fails open on Redis error (allows request, never blocks on network issues)
- Pub/sub self-message filtering via unique instance IDs (no echo loops)
- Pub/sub subscriber uses a dedicated Redis connection (required by Redis protocol)
- Red-teamed with 101 adversarial security tests across 14 passes

## Current Limitations

- **No response size limits for HTTP transport** — Large responses from remote servers are forwarded as-is.
- **Redis key metadata syncs on write** — Admin mutations write through to Redis immediately; pub/sub delivers near-instant cross-instance updates; periodic sync (5s) serves as a safety net. Credits, rate limits, and usage are always atomic.
- **SSE sessions are per-instance** — Each PayGate instance manages its own SSE connections (HTTP streams can't be serialized to Redis).

## Roadmap

- [x] Persistent storage (`--state-file`)
- [x] Streamable HTTP transport (`--remote-url`)
- [x] Stripe webhook integration (`--stripe-secret`)
- [x] Client self-service balance check (`/balance`)
- [x] Usage data export — JSON and CSV (`/usage`)
- [x] Admin web dashboard (`/dashboard`)
- [x] Per-key spending limits (`/limits`)
- [x] Webhook events (`--webhook-url`)
- [x] Refund on failure (`--refund-on-failure`)
- [x] Config file mode (`--config`)
- [x] Per-tool ACL — whitelist/blacklist tools per key
- [x] Per-tool rate limits — independent limits per tool
- [x] Key expiry (TTL) — auto-expire API keys
- [x] Multi-server mode — wrap N MCP servers behind one PayGate
- [x] Client SDK — `PayGateClient` with auto 402 retry
- [x] Usage quotas — daily/monthly call and credit limits per key
- [x] Dynamic pricing — charge by input size (`creditsPerKbInput`)
- [x] OAuth 2.1 — PKCE, client registration, Bearer tokens, token refresh/revocation
- [x] SSE streaming — Full MCP Streamable HTTP transport with session management
- [x] Audit log — Structured audit trail with retention, query API, CSV/JSON export
- [x] Registry/discovery — Agent-discoverable pricing (/.well-known/mcp-payment, /pricing, tools/list _pricing)
- [x] Prometheus metrics — /metrics endpoint with counters, gauges, and uptime
- [x] Key rotation — Rotate API keys preserving credits, ACLs, quotas, and spending limits
- [x] Rate limit headers — X-RateLimit-* and X-Credits-Remaining on /mcp responses
- [x] Webhook signatures — HMAC-SHA256 signed payloads with timing-safe verification
- [x] Admin lifecycle events — Webhook notifications for key management operations
- [x] IP allowlisting — Restrict API keys to specific IPs or CIDR ranges
- [x] Key tags/metadata — Attach key-value tags for external system integration
- [x] Usage analytics — Time-series analytics API with tool breakdown, trends, and top consumers
- [x] Alert webhooks — Configurable threshold alerts (spending, credits, quota, expiry, rate limits)
- [x] Team management — Group API keys with shared budgets, quotas, and usage tracking
- [x] Horizontal scaling — Redis-backed state for multi-process deployments

## Requirements

- Node.js >= 18.0.0
- Zero external dependencies

## License

MIT
