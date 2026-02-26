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
- **Webhook Retry Queue** — Exponential backoff retry (1s, 2s, 4s...) with dead letter queue for permanently failed deliveries, admin API for monitoring, clearing, and replaying
- **Health Check + Graceful Shutdown** — `GET /health` public endpoint with status, uptime, version, in-flight requests, Redis & webhook stats; `gracefulStop()` drains in-flight requests before teardown
- **Config Validation + Dry Run** — `paygate-mcp validate --config paygate.json` catches misconfigurations before starting; `--dry-run` discovers tools, prints pricing table, then exits
- **Batch Tool Calls** — `tools/call_batch` method for calling multiple tools in one request with all-or-nothing billing, aggregate credit checks, and parallel execution
- **Multi-Tenant Namespaces** — Isolate API keys and usage data by tenant with namespace-filtered admin endpoints, analytics, and usage export
- **Scoped Tokens** — Issue short-lived `pgt_` tokens scoped to specific tools with auto-expiry (max 24h), HMAC-SHA256 signed, zero server-side state
- **Token Revocation List** — Revoke scoped tokens before expiry with O(1) lookup, auto-cleanup, Redis cross-instance sync, and admin API
- **Usage-Based Auto-Topup** — Automatically add credits when balance drops below a threshold with configurable daily limits, audit trail, webhook events, and Redis sync
- **Admin API Key Management** — Multiple admin keys with role-based permissions (super_admin, admin, viewer), file persistence, audit trail, and safety guards
- **Plugin System** — Extensible middleware hooks for custom billing logic, request/response transformation, custom endpoints, and lifecycle management
- **Key Groups** — Policy templates that apply shared ACL, rate limits, pricing overrides, IP allowlists, and quotas to groups of API keys with automatic inheritance and key-level override support
- **Refund on Failure** — Automatically refund credits when downstream tool calls fail
- **Credit Transfers** — Atomically transfer credits between API keys with validation, audit trail, and webhook events
- **Bulk Key Operations** — Execute multiple key operations (create, topup, revoke) in a single request with per-operation error handling and index tracking
- **Key Import/Export** — Export all API keys for backup/migration (JSON or CSV) and import with conflict resolution (skip, overwrite, error modes)
- **Webhook Filters** — Route webhook events to different destinations based on event type and API key prefix with per-filter secrets, independent retry queues, and admin CRUD API
- **Key Cloning** — `POST /keys/clone` creates a new API key with the same config (ACL, quotas, tags, IP, namespace, group, spending limit, expiry, auto-topup) but fresh counters — ideal for provisioning similar keys
- **Key Suspension** — Temporarily disable API keys without revoking them — suspended keys are denied at the gate but can be resumed, and admin operations (topup, ACL, etc.) still work on suspended keys
- **Per-Key Usage** — `GET /keys/usage?key=...` returns detailed usage breakdown for a specific key: per-tool stats, hourly time-series, deny reasons, recent events, and key metadata
- **Webhook Test** — `POST /webhooks/test` sends a test event to your configured webhook URL with synchronous response including status code, response time, and delivery success/failure — verifies webhook connectivity without generating real events
- **Webhook Delivery Log** — `GET /webhooks/log` returns a queryable log of all webhook delivery attempts with timestamps, HTTP status codes, response times, success/failure, retry attempts, event counts, and event types — filter by success status, time range, and limit
- **Webhook Pause/Resume** — `POST /webhooks/pause` and `POST /webhooks/resume` temporarily halt webhook delivery during maintenance — events are buffered (not lost) and flushed on resume, with pause state visible in `/webhooks/stats`
- **Key Aliases** — `POST /keys/alias` assigns human-readable aliases (e.g. `my-service`, `prod-backend`) to API keys — use aliases in any admin endpoint (topup, revoke, suspend, resume, clone, transfer, usage) instead of opaque key IDs, with uniqueness enforcement, format validation, state file persistence, and audit trail
- **Key Expiry Scanner** — Proactive background scanner that detects expiring API keys before they expire — configurable scan interval and notification thresholds (default: 7d, 24h, 1h), de-duplicated `key.expiry_warning` webhook events, audit trail, `GET /keys/expiring?within=86400` query endpoint, and graceful shutdown
- **Key Templates** — Named templates for API key creation — define reusable presets (credits, ACL, quotas, IP, tags, namespace, expiry TTL, spending limit, auto-topup) and create keys with `template: "free-tier"` — explicit params override template defaults, CRUD admin API, Prometheus gauge, file persistence, max 100 templates
- **Config Hot Reload** — `POST /config/reload` reloads pricing, rate limits, webhooks, quotas, and behavior flags from config file without server restart
- **Webhook Events** — POST batched usage events to any URL for external billing/alerting
- **Config File Mode** — Load all settings from a JSON file (`--config`)
- **Shadow Mode** — Log everything without enforcing payment (for testing)
- **Persistent Storage** — Keys, credits, admin keys, and groups survive restarts with `--state-file`
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
| `/keys/transfer` | POST | `X-Admin-Key` | Transfer credits between API keys |
| `/keys/bulk` | POST | `X-Admin-Key` | Execute multiple key operations (create, topup, revoke) in one request |
| `/keys/export` | GET | `X-Admin-Key` | Export all API keys for backup/migration (JSON or CSV) |
| `/keys/import` | POST | `X-Admin-Key` | Import API keys from backup with conflict resolution |
| `/keys/revoke` | POST | `X-Admin-Key` | Permanently revoke an API key |
| `/keys/suspend` | POST | `X-Admin-Key` | Temporarily suspend a key (reversible) |
| `/keys/resume` | POST | `X-Admin-Key` | Resume a suspended key |
| `/keys/clone` | POST | `X-Admin-Key` | Clone a key (new key, same config, fresh counters) |
| `/keys/usage` | GET | `X-Admin-Key` | Per-key usage breakdown (per-tool, time-series, deny reasons) |
| `/keys/rotate` | POST | `X-Admin-Key` | Rotate key (new key, same credits/ACL/quotas) |
| `/keys/acl` | POST | `X-Admin-Key` | Set tool ACL (whitelist/blacklist) on a key |
| `/keys/expiry` | POST | `X-Admin-Key` | Set or remove key expiry (TTL) |
| `/keys/quota` | POST | `X-Admin-Key` | Set usage quota (daily/monthly limits) |
| `/keys/tags` | POST | `X-Admin-Key` | Set key tags/metadata (merge semantics) |
| `/keys/ip` | POST | `X-Admin-Key` | Set IP allowlist (CIDR + exact match) |
| `/keys/search` | POST | `X-Admin-Key` | Search keys by tag values |
| `/keys/auto-topup` | POST | `X-Admin-Key` | Configure or disable auto-topup for a key |
| `/admin/keys` | GET | `X-Admin-Key` (super_admin) | List all admin keys (masked) |
| `/admin/keys` | POST | `X-Admin-Key` (super_admin) | Create a new admin key with role |
| `/admin/keys/revoke` | POST | `X-Admin-Key` (super_admin) | Revoke an admin key |
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
| `/tokens` | POST | `X-Admin-Key` | Create a scoped token (short-lived, tool-restricted) |
| `/tokens/revoke` | POST | `X-Admin-Key` | Revoke a scoped token (by full token string) |
| `/tokens/revoked` | GET | `X-Admin-Key` | List all revoked token entries |
| `/namespaces` | GET | `X-Admin-Key` | List all namespaces with key/credit/spending stats |
| `/audit` | GET | `X-Admin-Key` | Query audit log (filter by type, actor, time) |
| `/audit/export` | GET | `X-Admin-Key` | Export full audit log (JSON or CSV) |
| `/audit/stats` | GET | `X-Admin-Key` | Audit log statistics |
| `/plugins` | GET | `X-Admin-Key` | List registered plugins with hook info |
| `/groups` | GET | `X-Admin-Key` | List all key groups (policy templates) |
| `/groups` | POST | `X-Admin-Key` | Create a key group with shared policies |
| `/groups/update` | POST | `X-Admin-Key` | Update group policies |
| `/groups/delete` | POST | `X-Admin-Key` | Delete (deactivate) a group |
| `/groups/assign` | POST | `X-Admin-Key` | Assign an API key to a group |
| `/groups/remove` | POST | `X-Admin-Key` | Remove an API key from a group |
| `/webhooks/filters` | GET | `X-Admin-Key` | List all webhook filter rules |
| `/webhooks/filters` | POST | `X-Admin-Key` | Create a webhook filter rule |
| `/webhooks/filters/update` | POST | `X-Admin-Key` | Update a webhook filter rule |
| `/webhooks/filters/delete` | POST | `X-Admin-Key` | Delete a webhook filter rule |
| `/webhooks/replay` | POST | `X-Admin-Key` | Replay dead letter webhook events (all or by index) |
| `/webhooks/test` | POST | `X-Admin-Key` | Send test event to configured webhook URL (synchronous) |
| `/webhooks/log` | GET | `X-Admin-Key` | Webhook delivery log with status, timing, and filters |
| `/webhooks/pause` | POST | `X-Admin-Key` | Pause webhook delivery (events buffered until resumed) |
| `/webhooks/resume` | POST | `X-Admin-Key` | Resume webhook delivery and flush buffered events |
| `/keys/alias` | POST | `X-Admin-Key` | Set or clear a human-readable alias for an API key |
| `/keys/expiring` | GET | `X-Admin-Key` | List keys expiring within a time window (`?within=86400` seconds) |
| `/keys/templates` | GET | `X-Admin-Key` | List all key templates |
| `/keys/templates` | POST | `X-Admin-Key` | Create or update a key template |
| `/keys/templates/delete` | POST | `X-Admin-Key` | Delete a key template |
| `/config/reload` | POST | `X-Admin-Key` | Hot-reload config file (pricing, rate limits, webhooks, quotas) |
| `/health` | GET | None | Health check (status, uptime, version, in-flight, Redis/webhook status) |
| `/` | GET | None | Root endpoint (endpoint list) |

### Free Methods

These MCP methods pass through without auth or billing:
`initialize`, `initialized`, `ping`, `tools/list`, `resources/list`, `prompts/list`

**Gated methods:** `tools/call` (single), `tools/call_batch` (batch — all-or-nothing billing, parallel execution). See [Batch Tool Calls](#batch-tool-calls).

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

### Credit Transfers

Atomically transfer credits between API keys:

```bash
curl -X POST http://localhost:3402/keys/transfer \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "from": "pg_source_key", "to": "pg_dest_key", "credits": 500, "memo": "Monthly allocation" }'
```

Response:
```json
{
  "transferred": 500,
  "from": { "keyMasked": "pg_sour...key1", "balance": 500 },
  "to": { "keyMasked": "pg_dest...key2", "balance": 700 },
  "memo": "Monthly allocation",
  "message": "Transferred 500 credits"
}
```

**Validation:** Both keys must exist, be active (not revoked/expired), and the source must have sufficient credits. Fractional credits are floored to integers. Self-transfers are rejected.

**Audit trail:** Every transfer logs a `key.credits_transferred` audit event with masked keys, amount, balances, and memo.

### Bulk Key Operations

Execute multiple key operations (create, topup, revoke) in a single request. Failed operations don't stop subsequent ones — each result includes success status and index for easy correlation.

```bash
curl -X POST http://localhost:3402/keys/bulk \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "operations": [
      { "action": "create", "name": "api-key-1", "credits": 500, "tags": { "env": "prod" } },
      { "action": "create", "name": "api-key-2", "credits": 200 },
      { "action": "topup", "key": "pg_existing_key", "credits": 1000 },
      { "action": "revoke", "key": "pg_old_key" }
    ]
  }'
```

Response:
```json
{
  "total": 4,
  "succeeded": 4,
  "failed": 0,
  "results": [
    { "index": 0, "action": "create", "success": true, "result": { "key": "pg_abc...", "name": "api-key-1", "credits": 500 } },
    { "index": 1, "action": "create", "success": true, "result": { "key": "pg_def...", "name": "api-key-2", "credits": 200 } },
    { "index": 2, "action": "topup", "success": true, "result": { "creditsAdded": 1000, "newBalance": 1500 } },
    { "index": 3, "action": "revoke", "success": true, "result": { "message": "Key revoked" } }
  ]
}
```

**Actions:** `create` (with optional name, credits, tags, namespace, allowedTools, deniedTools), `topup` (key + credits), `revoke` (key). Unknown actions return an error result without stopping the batch.

**Limits:** Maximum 100 operations per request. Empty operations array returns 400.

**Audit trail:** Each successful operation logs an individual audit event with "(bulk)" suffix.

### Key Import/Export

Export all API keys for backup or migration between PayGate instances:

```bash
# Export as JSON (includes full key secrets)
curl http://localhost:3402/keys/export \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -o paygate-keys-backup.json

# Export as CSV
curl "http://localhost:3402/keys/export?format=csv" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -o paygate-keys-backup.csv

# Export only active keys in a specific namespace
curl "http://localhost:3402/keys/export?activeOnly=true&namespace=production" \
  -H "X-Admin-Key: $ADMIN_KEY"
```

Import keys into a PayGate instance:

```bash
curl -X POST http://localhost:3402/keys/import \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "keys": [{ "key": "pg_abc123...", "name": "my-key", "credits": 500, "active": true, "tags": {} }],
    "mode": "skip"
  }'
```

Response:
```json
{
  "total": 1,
  "imported": 1,
  "overwritten": 0,
  "skipped": 0,
  "errors": 0,
  "mode": "skip",
  "results": [{ "key": "pg_abc123...", "name": "my-key", "status": "imported" }]
}
```

**Conflict modes:** `skip` (default) — skip keys that already exist, `overwrite` — replace existing keys, `error` — fail on duplicate keys.

**Limits:** Maximum 1000 keys per import request. Keys must start with `pg_` prefix.

**Export formats:** JSON (full records with all fields) or CSV (key subset for spreadsheet use).

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
| `/webhooks/replay` | POST | Replay dead letter events (all or by index) |

Retry attempts include an `X-PayGate-Retry` header with the attempt number for observability.

#### Webhook Event Replay

Replay permanently failed webhook events from the dead letter queue:

```bash
# Replay all dead letter entries
curl -X POST http://localhost:3402/webhooks/replay \
  -H "X-Admin-Key: $ADMIN_KEY"

# Replay specific entries by index
curl -X POST http://localhost:3402/webhooks/replay \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "indices": [0, 2, 5] }'
```

Replayed entries are removed from the dead letter queue and re-queued for fresh delivery (attempt counter resets to 0). If delivery fails again, they follow the normal retry/dead-letter flow.

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

#### Webhook Filters (Event Routing)

Route webhook events to different destinations based on event type and API key prefix. Each filter rule routes matching events to its own URL with independent retry queues, dead letter queues, and optional signing secrets.

**Create a filter rule:**
```bash
curl -X POST http://localhost:3402/webhooks/filters \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "production-alerts",
    "events": ["key.created", "key.revoked", "alert.fired"],
    "url": "https://alerts.example.com/webhook",
    "secret": "whsec_alerts_secret",
    "keyPrefixes": ["pk_prod_"],
    "active": true
  }'
```

**List filters:**
```bash
curl http://localhost:3402/webhooks/filters -H "X-Admin-Key: $ADMIN_KEY"
```

**Update a filter:**
```bash
curl -X POST http://localhost:3402/webhooks/filters/update \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "id": "wf_abc123", "active": false }'
```

**Delete a filter:**
```bash
curl -X POST http://localhost:3402/webhooks/filters/delete \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "id": "wf_abc123" }'
```

**Filter rules:**
- `events` — Array of event types to match (exact match or `"*"` wildcard for all events)
- `keyPrefixes` — Optional array of API key prefixes (e.g., `["pk_prod_"]`). Events only match if the associated key starts with one of these prefixes. Omit for all keys.
- `url` — Destination URL for matched events (each unique URL gets its own retry queue)
- `secret` — Optional HMAC-SHA256 signing secret for this destination
- `active` — Enable/disable the filter without deleting it

**Routing behavior:**
- Events matching filter rules are sent to the filter's destination URL
- The default webhook URL (if configured) always receives all events (backward compatible)
- Multiple filters can match the same event — it's sent to all matching destinations
- Inactive filters are skipped during routing

**Config file:**
```json
{
  "webhookUrl": "https://billing.example.com/events",
  "webhookFilters": [
    {
      "name": "production-alerts",
      "events": ["key.created", "key.revoked", "alert.fired"],
      "url": "https://alerts.example.com/webhook",
      "keyPrefixes": ["pk_prod_"]
    }
  ]
}
```

**Stats:** `GET /webhooks/stats` includes per-URL delivery statistics for all filter destinations plus the default endpoint.

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

### Key Cloning

Create a new API key with the same configuration as an existing key but fresh counters. Ideal for provisioning similar keys for team members, staging environments, or batch key creation:

```bash
# Clone with same config and credits
curl -X POST http://localhost:3402/keys/clone \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"key": "pg_source..."}'
# → { "message": "Key cloned", "key": "pg_newkey...", "name": "source-clone", "credits": 200, ... }

# Clone with overrides
curl -X POST http://localhost:3402/keys/clone \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"key": "pg_source...", "name": "staging-key", "credits": 50, "namespace": "staging"}'
```

**What gets cloned:** allowedTools, deniedTools, expiresAt, quota, tags, ipAllowlist, namespace, group, spendingLimit, autoTopup config. **What gets reset:** totalSpent, totalCalls, lastUsedAt, quotaDailyCalls, suspended state. You can override `name`, `credits`, `tags`, and `namespace` in the clone request. Suspended and expired keys can be cloned (but not revoked keys).

### Key Rotation

Rotate an API key without losing credits, ACLs, quotas, or spending limits:

```bash
curl -X POST http://localhost:3402/keys/rotate \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"key": "pg_oldkey..."}'
# → { "message": "Key rotated", "newKey": "pg_newkey...", "name": "my-key", "credits": 500 }
```

The old key is immediately invalidated. All state (credits, totalSpent, totalCalls, ACL, quota, expiry, spending limit) transfers to the new key. Use this for periodic key rotation policies, compromised key response, or key migration.

### Key Suspension & Resumption

Temporarily disable an API key without permanently revoking it. Suspended keys are denied at the gate (`key_suspended` reason), but admin operations (topup, ACL, quota, tags, etc.) still work — making this ideal for investigating abuse, pausing billing, or temporary lockouts:

```bash
# Suspend a key (with optional reason for audit trail)
curl -X POST http://localhost:3402/keys/suspend \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"key": "pg_abc123...", "reason": "investigating abuse"}'
# → { "message": "Key suspended", "suspended": true }

# Resume a suspended key
curl -X POST http://localhost:3402/keys/resume \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"key": "pg_abc123..."}'
# → { "message": "Key resumed", "suspended": false }
```

**Suspension vs Revocation:**
- **Suspend** — Reversible. Key remains active but is denied at the gate. Admin operations still work. Use for temporary lockouts.
- **Revoke** — Permanent. Key is deactivated and cannot be restored. Use for compromised or decommissioned keys.

Suspension fires `key.suspended` and `key.resumed` audit events and webhook notifications. Shadow mode allows suspended keys through (with `shadow:key_suspended` reason) for testing.

### Per-Key Usage

Get detailed usage breakdown for a specific API key — per-tool stats, hourly time-series, deny reasons, and recent events:

```bash
# Get full usage for a key
curl http://localhost:3402/keys/usage?key=pg_abc123... \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"

# Filter by time (ISO 8601)
curl "http://localhost:3402/keys/usage?key=pg_abc123...&since=2025-01-01T00:00:00Z" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"
```

Response includes:

| Field | Description |
|-------|-------------|
| `key` | Masked API key (first 10 chars + `...`) |
| `name` | Key name |
| `credits` | Current credit balance |
| `active` / `suspended` | Key status |
| `totalCalls` | Total tool calls made |
| `totalAllowed` / `totalDenied` | Allowed vs denied breakdown |
| `totalCreditsSpent` | Total credits consumed |
| `perTool` | Per-tool breakdown: `{ calls, credits, denied }` |
| `denyReasons` | Aggregated deny reasons with counts |
| `timeSeries` | Hourly buckets: `{ hour, calls, credits, denied }` |
| `recentEvents` | Last 50 events (newest first) with tool, credits, and deny reason |

Works for active, suspended, and expired keys. Useful for debugging, billing audits, and per-customer analytics.

### Webhook Test

Send a test event to your configured webhook URL to verify connectivity without generating real events:

```bash
# Send test event
curl -X POST http://localhost:3402/webhooks/test \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"

# With custom message
curl -X POST http://localhost:3402/webhooks/test \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"message": "Testing from staging deploy"}'
```

Response:

| Field | Description |
|-------|-------------|
| `url` | Webhook URL (credentials masked) |
| `success` | `true` if webhook returned 2xx |
| `statusCode` | HTTP status code from webhook endpoint |
| `responseTime` | Round-trip delivery time in milliseconds |
| `error` | Error message (only on failure) |

The test event includes `X-PayGate-Test: 1` header and `X-PayGate-Signature` when a webhook secret is configured. Returns 400 if no webhook URL is configured. Creates an audit trail entry (`webhook.test`).

### Webhook Delivery Log

Query the log of all webhook delivery attempts — successes, failures, and retries:

```bash
# Get recent deliveries (default: last 50, newest first)
curl http://localhost:3402/webhooks/log \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"

# Filter by success/failure
curl "http://localhost:3402/webhooks/log?success=false" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"

# Filter by time and limit
curl "http://localhost:3402/webhooks/log?since=2025-01-01T00:00:00Z&limit=10" \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"
```

Each entry includes:

| Field | Description |
|-------|-------------|
| `id` | Auto-incrementing delivery ID |
| `timestamp` | When the delivery attempt was made |
| `url` | Webhook URL (credentials masked) |
| `statusCode` | HTTP status code (0 for connection errors) |
| `success` | `true` if webhook returned 2xx |
| `responseTime` | Round-trip time in milliseconds |
| `attempt` | Retry attempt number (0 = first attempt) |
| `error` | Error message (only on failure) |
| `eventCount` | Number of events in the batch |
| `eventTypes` | Distinct event types (e.g. `["usage"]`, `["key.created"]`) |

Query parameters: `limit` (default 50, max 200), `since` (ISO 8601), `success` (`true` or `false`). Entries are capped at 500 in memory. Use alongside `/webhooks/stats` for aggregate counters.

### Webhook Pause/Resume

Temporarily halt webhook delivery during maintenance windows. Events are buffered (not lost) and flushed on resume:

```bash
# Pause delivery
curl -X POST http://localhost:3402/webhooks/pause \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"

# Check pause status (visible in /webhooks/stats)
curl http://localhost:3402/webhooks/stats \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"
# → { "paused": true, "pausedAt": "2025-...", "bufferedEvents": 12, ... }

# Resume delivery (flushes buffered events)
curl -X POST http://localhost:3402/webhooks/resume \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"
# → { "paused": false, "flushedEvents": 12 }
```

While paused, events continue to accumulate in the buffer. On resume, all buffered events are flushed immediately. The pause state and buffered event count are visible in `/webhooks/stats`. Creates audit trail entries (`webhook.pause`, `webhook.resume`).

### Key Aliases

Assign human-readable aliases to API keys so you can reference them by name instead of opaque key IDs in admin endpoints:

```bash
# Set an alias
curl -X POST http://localhost:3402/keys/alias \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"key": "pg_abc123...", "alias": "prod-backend"}'
# → { "key": "pg_abc12...", "alias": "prod-backend", "message": "Alias set to \"prod-backend\"" }

# Use the alias in any admin endpoint
curl -X POST http://localhost:3402/topup \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"key": "prod-backend", "credits": 500}'

curl -X POST http://localhost:3402/keys/suspend \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"key": "prod-backend", "reason": "maintenance"}'

curl -X POST http://localhost:3402/keys/transfer \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"from": "prod-backend", "to": "staging-api", "credits": 100}'

# Clear an alias
curl -X POST http://localhost:3402/keys/alias \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"key": "prod-backend", "alias": null}'
```

| Field | Description |
|-------|-------------|
| `alias` | 1-100 chars, alphanumeric + hyphens + underscores only |
| Uniqueness | Aliases must be unique across all keys and cannot collide with existing key IDs |
| Scope | Aliases work in all admin endpoints (topup, revoke, suspend, resume, clone, transfer, usage) — they do **not** work for API key authentication on `/mcp` |
| Persistence | Aliases are saved to the state file and survive server restarts |
| Clone | Cloned keys do **not** inherit the source key's alias |
| Audit | `key.alias_set` event logged for every set/clear operation |

### Key Expiry Scanner

Proactive background scanner that detects API keys approaching expiration and sends webhook notifications before they expire — even if the keys are not actively being used:

```bash
# Query keys expiring within 24 hours (default)
curl http://localhost:3402/keys/expiring \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"
# → { "within": 86400, "count": 2, "scanner": { ... }, "keys": [ ... ] }

# Query keys expiring within 7 days
curl http://localhost:3402/keys/expiring?within=604800 \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"
```

Configure the scanner in your config file:

```json
{
  "expiryScanner": {
    "enabled": true,
    "intervalSeconds": 3600,
    "thresholds": [604800, 86400, 3600]
  }
}
```

| Field | Description |
|-------|-------------|
| `enabled` | Enable/disable the background scanner. Default: `true` |
| `intervalSeconds` | How often to scan (seconds). Default: `3600` (1 hour). Min: 60 |
| `thresholds` | Seconds before expiry to notify. Default: `[604800, 86400, 3600]` (7d, 24h, 1h) |
| Webhook | Fires `key.expiry_warning` events with key name, alias, namespace, expiry time, and remaining seconds |
| De-duplication | Each key+threshold pair is only notified once (no duplicate alerts) |
| Progressive | Largest threshold fires first, then progressively smaller thresholds on subsequent scans |
| Audit | `key.expiry_warning` event logged for every notification |
| Endpoint | `GET /keys/expiring?within=N` lists keys expiring within N seconds (default: 86400) |

### Key Templates

Named templates for API key creation. Define reusable presets and create keys with `template: "free-tier"`:

```bash
# Create a template
curl -X POST http://localhost:3402/keys/templates \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{
    "name": "free-tier",
    "description": "Free plan with basic access",
    "credits": 50,
    "allowedTools": ["search", "read"],
    "deniedTools": ["admin"],
    "tags": {"plan": "free"},
    "namespace": "public",
    "expiryTtlSeconds": 2592000,
    "spendingLimit": 200
  }'

# List all templates
curl http://localhost:3402/keys/templates \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"

# Create a key from template (inherits all defaults)
curl -X POST http://localhost:3402/keys \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"name": "new-user", "template": "free-tier"}'

# Create a key from template with overrides
curl -X POST http://localhost:3402/keys \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"name": "vip-user", "template": "free-tier", "credits": 500, "tags": {"plan": "vip"}}'

# Delete a template
curl -X POST http://localhost:3402/keys/templates/delete \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -d '{"name": "free-tier"}'
```

| Feature | Details |
|---------|---------|
| Fields | credits, allowedTools, deniedTools, quota, ipAllowlist, spendingLimit, tags, namespace, expiryTtlSeconds, autoTopup |
| Override | Explicit params in `POST /keys` always override template defaults |
| TTL | `expiryTtlSeconds` sets expiry relative to key creation time (0 = never) |
| Limit | Max 100 templates per server |
| Persistence | `-templates.json` alongside state file, survives restarts |
| Audit | `template.created`, `template.updated`, `template.deleted` events |
| Prometheus | `paygate_templates_total` gauge tracks template count |

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

### Health Check + Graceful Shutdown

The `GET /health` endpoint provides a public (no auth required) health check for load balancers and orchestrators:

```bash
curl http://localhost:3402/health
```

```json
{
  "status": "healthy",
  "uptime": 3600,
  "version": "2.6.0",
  "inflight": 3,
  "redis": { "connected": true, "pubsub": true },
  "webhooks": { "pendingRetries": 0, "deadLetterCount": 2 }
}
```

| Field | Description |
|-------|-------------|
| `status` | `"healthy"` or `"draining"` (during graceful shutdown) |
| `uptime` | Seconds since server started |
| `version` | Package version |
| `inflight` | Number of in-flight `/mcp` requests |
| `redis` | Redis connectivity (only present when `--redis-url` is set) |
| `webhooks` | Webhook retry stats (only present when `--webhook-url` is set) |

During graceful shutdown, `/health` returns HTTP 503 with `"status": "draining"`, and new `/mcp` requests are rejected with 503. Existing in-flight requests are allowed to complete before the server tears down. The CLI uses `gracefulStop()` on SIGTERM/SIGINT with a 30-second drain timeout.

**Programmatic API:**

```typescript
// Graceful shutdown with custom timeout (default 30s)
await server.gracefulStop(15_000);
```

### Config Validation + Dry Run

Validate a config file before starting the server:

```bash
# Validate a config file — exits 0 if valid, 1 if errors found
paygate-mcp validate --config paygate.json
```

Output on error:
```
✗ 2 error(s):
  ERROR  [port] Invalid port 99999. Must be 0–65535.
  ERROR  [redisUrl] Invalid redisUrl protocol "http:". Expected "redis://" or "rediss://".
⚠ 1 warning(s):
  WARN   [shadowMode] Shadow mode is enabled. Payment will not be enforced.
```

Dry run mode starts the server, discovers tools from the backend, prints a pricing table, then exits:

```bash
paygate-mcp wrap --server "node my-server.js" --dry-run
```

```
  ── DRY RUN ──────────────────────────────────────
  Discovered 3 tool(s):

  ────────────────────────────────────────────────────────────
  Tool                          Credits/Call   Rate Limit
  ────────────────────────────────────────────────────────────
  search                        5              30/min
  generate                      10             10/min
  list_items                    1              60/min
  ────────────────────────────────────────────────────────────

  Dry run complete — shutting down.
```

**Programmatic API:**

```typescript
import { validateConfig, formatDiagnostics } from 'paygate-mcp';

const diags = validateConfig(myConfig);
if (diags.some(d => d.level === 'error')) {
  console.error(formatDiagnostics(diags));
  process.exit(1);
}
```

### Batch Tool Calls

Call multiple tools in a single request with all-or-nothing billing:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call_batch",
  "params": {
    "calls": [
      { "name": "search", "arguments": { "q": "MCP servers" } },
      { "name": "translate", "arguments": { "text": "hello", "to": "es" } },
      { "name": "summarize", "arguments": { "url": "https://example.com" } }
    ]
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "results": [
      { "tool": "search", "result": { "content": [...] }, "creditsCharged": 5 },
      { "tool": "translate", "result": { "content": [...] }, "creditsCharged": 3 },
      { "tool": "summarize", "result": { "content": [...] }, "creditsCharged": 2 }
    ],
    "totalCreditsCharged": 10,
    "remainingCredits": 90
  }
}
```

**Key features:**
- **All-or-nothing** — All calls are pre-validated (auth, ACL, rate limits, credits, quotas) before any execute. If any call would be denied, the entire batch is rejected and zero credits are charged.
- **Aggregate pricing** — Total credits are checked and deducted atomically. A batch of 3 calls needing 5+3+2=10 credits requires 10 credits available.
- **Parallel execution** — After gate approval, all tool calls execute concurrently for minimum latency.
- **Refund on failure** — With `refundOnFailure` enabled, individual tools that error downstream get their credits refunded.
- **Multi-server support** — Works with prefixed tools in multi-server mode (e.g., `fs:read`, `github:search`).

**Programmatic API:**

```typescript
import { Gate, BatchToolCall } from 'paygate-mcp';

const calls: BatchToolCall[] = [
  { name: 'search', arguments: { q: 'test' } },
  { name: 'translate', arguments: { text: 'hi' } },
];

const result = gate.evaluateBatch(apiKey, calls, clientIp);
if (!result.allAllowed) {
  console.log(`Denied at index ${result.failedIndex}: ${result.reason}`);
} else {
  console.log(`Charged ${result.totalCredits} credits for ${calls.length} calls`);
}
```

### Multi-Tenant Namespaces

Isolate API keys and usage data by tenant. Each key belongs to a `namespace` (default: `"default"`). All admin endpoints support namespace filtering for tenant-scoped views.

**Create a key in a namespace:**

```bash
curl -X POST http://localhost:3402/keys \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "acme-agent", "credits": 1000, "namespace": "acme-corp"}'
```

**List keys filtered by namespace:**

```bash
curl http://localhost:3402/keys?namespace=acme-corp \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"
```

**List all namespaces with stats:**

```bash
curl http://localhost:3402/namespaces \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"
```

Returns:

```json
{
  "namespaces": [
    { "namespace": "acme-corp", "keyCount": 3, "activeKeys": 2, "totalCredits": 2500, "totalSpent": 480 },
    { "namespace": "beta-inc", "keyCount": 1, "activeKeys": 1, "totalCredits": 500, "totalSpent": 120 }
  ],
  "count": 2
}
```

**Namespace-filtered status, usage, and analytics:**

```bash
# Status filtered to one namespace
curl http://localhost:3402/status?namespace=acme-corp -H "X-Admin-Key: ..."

# Usage events filtered by namespace
curl http://localhost:3402/usage?namespace=acme-corp -H "X-Admin-Key: ..."

# Analytics filtered by namespace
curl "http://localhost:3402/analytics?namespace=acme-corp&from=2025-01-01" -H "X-Admin-Key: ..."

# Search keys by tag within a namespace
curl -X POST http://localhost:3402/keys/search \
  -H "X-Admin-Key: ..." -H "Content-Type: application/json" \
  -d '{"tags": {"env": "prod"}, "namespace": "acme-corp"}'
```

Namespace rules:
- Alphanumeric + hyphens only, max 50 characters, case-insensitive (stored lowercase)
- Defaults to `"default"` if omitted or invalid
- Old keys automatically backfilled to `"default"` on state file load
- Usage events carry the key's namespace for cross-cutting analytics
- Namespaces are implicit — created automatically when a key is assigned to one

### Scoped Tokens

Issue short-lived, tool-restricted tokens from any API key. Scoped tokens let you delegate narrow access to agents or sub-processes without exposing the parent API key.

**Create a scoped token (admin):**

```bash
curl -X POST http://localhost:3402/tokens \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "pg_parent_key_here",
    "ttl": 300,
    "allowedTools": ["search", "summarize"],
    "label": "agent-session-42"
  }'
```

Returns:

```json
{
  "token": "pgt_eyJhcGl...signature",
  "expiresAt": "2025-06-15T12:05:00.000Z",
  "ttl": 300,
  "parentKey": "my-agent",
  "allowedTools": ["search", "summarize"],
  "label": "agent-session-42",
  "message": "Use as X-API-Key or Bearer token on /mcp"
}
```

**Use the token on /mcp:**

```bash
# As X-API-Key header
curl -X POST http://localhost:3402/mcp \
  -H "X-API-Key: pgt_eyJhcGl...signature" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"q":"hello"}}}'

# As Bearer token
curl -X POST http://localhost:3402/mcp \
  -H "Authorization: Bearer pgt_eyJhcGl...signature" \
  -H "Content-Type: application/json" \
  -d '...'
```

Token behavior:
- **Self-contained** — HMAC-SHA256 signed, zero server-side state. Validated cryptographically on every request.
- **Auto-expiry** — TTL defaults to 1 hour, max 24 hours. Expired tokens are rejected instantly.
- **Tool ACL narrowing** — If `allowedTools` is set, the token can only call those tools (intersection with parent key's ACL).
- **Credits from parent** — Tool calls charge against the parent key's credit balance.
- **`tools/list` filtering** — When a scoped token calls `tools/list`, only the allowed tools are returned.
- **Batch-aware** — `tools/call_batch` checks scoped token ACL for every call in the batch.
- **Resolution priority** — `X-API-Key` header → `pgt_` scoped token → OAuth Bearer token.

Token format: `pgt_<base64url(JSON payload)>.<base64url(HMAC-SHA256 signature)>`

**Programmatic usage:**

```typescript
import { ScopedTokenManager } from 'paygate-mcp';

const tokens = new ScopedTokenManager('your-signing-secret');

// Create
const token = tokens.create({
  apiKey: 'pg_parent_key',
  ttlSeconds: 300,
  allowedTools: ['search'],
  label: 'agent-42',
});

// Validate
const result = tokens.validate(token);
if (result.valid) {
  console.log(result.payload.apiKey); // 'pg_parent_key'
  console.log(result.payload.allowedTools); // ['search']
}

// Check if a string is a scoped token
ScopedTokenManager.isToken('pgt_...'); // true
ScopedTokenManager.isToken('pg_...');  // false
```

### Token Revocation List

Revoke scoped tokens before they expire. Once revoked, the token is immediately rejected by all PayGate instances (synced via Redis pub/sub in multi-instance deployments).

**Revoke a token (admin):**

```bash
curl -X POST http://localhost:3402/tokens/revoke \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"token": "pgt_eyJhcGl...signature", "reason": "session ended"}'
```

Returns:

```json
{
  "message": "Token revoked",
  "fingerprint": "a1b2c3d4e5f6...",
  "expiresAt": "2025-06-15T12:05:00.000Z",
  "revokedAt": "2025-06-15T11:30:00.000Z"
}
```

**List revoked tokens (admin):**

```bash
curl http://localhost:3402/tokens/revoked \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"
```

Returns `{ count, entries: [{ fingerprint, expiresAt, revokedAt, reason }] }`.

Revocation behavior:
- **O(1) lookup** — SHA-256 fingerprints stored in a Map for constant-time rejection checks.
- **Auto-cleanup** — Revocation entries are purged once the original token would have naturally expired (max 24h), so the list never grows unbounded.
- **Redis sync** — In multi-instance deployments, revocations are propagated via `token_revoked` pub/sub events. Other instances add the entry to their local revocation list immediately.
- **Audit trail** — Every revocation is logged as a `token.revoked` audit event with fingerprint and reason.
- **Signature validation** — Only tokens signed by this server can be revoked (prevents revoking arbitrary strings).

**Programmatic usage:**

```typescript
import { ScopedTokenManager } from 'paygate-mcp';

const tokens = new ScopedTokenManager('your-signing-secret');
const token = tokens.create({ apiKey: 'pg_key', ttlSeconds: 3600 });

// Revoke
const entry = tokens.revokeToken(token, 'session ended');
console.log(entry.fingerprint); // SHA-256 hex

// Validate — now returns { valid: false, reason: 'token_revoked' }
tokens.validate(token); // { valid: false, reason: 'token_revoked' }

// Check revocation list size
tokens.revocationList.size; // 1

// Clean up on shutdown
tokens.destroy();
```

### Usage-Based Auto-Topup

Automatically refill credits when a key's balance drops below a threshold. Prevents service interruptions for high-value API consumers.

**Configure auto-topup (admin):**

```bash
curl -X POST http://localhost:3402/keys/auto-topup \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key": "pg_abc123...", "threshold": 100, "amount": 500, "maxDaily": 10}'
```

Returns:

```json
{
  "autoTopup": { "threshold": 100, "amount": 500, "maxDaily": 10 },
  "message": "Auto-topup enabled: add 500 credits when balance drops below 100 (max 10/day)"
}
```

**Disable auto-topup:**

```bash
curl -X POST http://localhost:3402/keys/auto-topup \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key": "pg_abc123...", "disable": true}'
```

Auto-topup behavior:
- **Post-deduction trigger** — After each tool call (or batch) deducts credits, the gate checks if credits fell below the threshold and automatically adds credits.
- **Daily limits** — `maxDaily` caps how many auto-topups can occur per UTC day. Set to `0` for unlimited.
- **Audit trail** — Every auto-topup is logged as a `key.auto_topped_up` audit event. Configuration changes are logged as `key.auto_topup_configured`.
- **Webhook events** — Both `key.auto_topup_configured` and `key.auto_topped_up` events are sent via webhooks.
- **Redis sync** — In multi-instance deployments, auto-topup credits are synced atomically via Redis.
- **State persistence** — Auto-topup config and daily counters are persisted in the state file and Redis.

**Programmatic usage:**

```typescript
import { Gate } from 'paygate-mcp';

const gate = new Gate(config, 'state.json');
const record = gate.store.createKey('premium-client', 1000);

// Configure auto-topup
record.autoTopup = { threshold: 100, amount: 500, maxDaily: 5 };
gate.store.save();

// Hook for notifications
gate.onAutoTopup = (apiKey, amount, newBalance) => {
  console.log(`Auto-topped up ${amount} credits → balance: ${newBalance}`);
};

// Gate.evaluate() automatically triggers auto-topup after credit deduction
const result = gate.evaluate(record.key, { name: 'expensive-tool' });
```

### Admin API Key Management

Manage multiple admin keys with role-based permissions. The bootstrap admin key (from constructor or CLI) is always a `super_admin`.

**Roles:**
| Role | Description |
|------|-------------|
| `super_admin` | Full access, including admin key management |
| `admin` | All API key and system operations, but cannot manage admin keys |
| `viewer` | Read-only access to status, usage, analytics, audit, etc. |

**Create an admin key (super_admin only):**

```bash
curl -X POST http://localhost:3402/admin/keys \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "CI Bot", "role": "admin"}'
# Returns: { "key": "ak_...", "name": "CI Bot", "role": "admin", "createdAt": "..." }
```

**List admin keys (super_admin only):**

```bash
curl http://localhost:3402/admin/keys \
  -H "X-Admin-Key: $ADMIN_KEY"
# Returns masked keys with roles, status, and last used timestamps
```

**Revoke an admin key (super_admin only):**

```bash
curl -X POST http://localhost:3402/admin/keys/revoke \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key": "ak_..."}'
```

**Behavior:**
- The default role for `POST /admin/keys` is `admin` if not specified.
- Cannot revoke your own admin key (safety guard).
- Cannot revoke the last `super_admin` key (safety guard).
- `viewer` keys can access all read-only endpoints (GET) but are denied write operations (POST).
- `admin` keys can create/revoke/rotate API keys, manage teams, tokens, etc. but cannot manage admin keys.
- Admin keys are persisted to a separate file (`*-admin.json`) alongside the state file.
- All operations are logged in the audit trail (`admin_key.created`, `admin_key.revoked`).
- Webhook events are fired for admin key lifecycle changes.

### Plugin System

Add custom logic to PayGate with the plugin API. Plugins can intercept gate decisions, transform pricing, modify tool requests/responses, add custom HTTP endpoints, and hook into server lifecycle events.

```ts
import { PayGateServer, PayGatePlugin } from 'paygate-mcp';

// Define a plugin
const loggingPlugin: PayGatePlugin = {
  name: 'request-logger',
  version: '1.0.0',

  // Gate hooks (sync — hot path)
  beforeGate: (ctx) => {
    // Return { allowed: false, reason: '...' } to short-circuit
    // Return null to continue normal evaluation
    if (ctx.toolName === 'dangerous_tool') {
      return { allowed: false, reason: 'tool_disabled' };
    }
    return null;
  },

  afterGate: (ctx, decision) => {
    // Modify the gate decision after evaluation
    console.log(`${ctx.toolName}: ${decision.allowed ? 'allowed' : 'denied'}`);
    return decision;
  },

  transformPrice: (toolName, basePrice, args) => {
    // Return a number to override price, or null to keep base price
    if (toolName === 'premium_search') return basePrice * 2;
    return null;
  },

  onDeny: (ctx, reason) => {
    // Called whenever a tool call is denied
    console.log(`Denied: ${ctx.toolName} — ${reason}`);
  },

  // Tool hooks (async)
  beforeToolCall: async (ctx) => {
    // Modify the JSON-RPC request before forwarding
    return { ...ctx.request, params: { ...ctx.request.params, audit: true } };
  },

  afterToolCall: async (ctx, response) => {
    // Modify the JSON-RPC response before returning to client
    return response;
  },

  // HTTP hook (async)
  onRequest: (req, res) => {
    // Add custom endpoints — return true if handled
    if (req.url === '/custom/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ custom: true }));
      return true;
    }
    return false;
  },

  // Lifecycle hooks (async)
  onStart: async () => { console.log('Plugin started'); },
  onStop: async () => { console.log('Plugin stopped'); },
};

// Register plugins with .use() (chainable)
const server = new PayGateServer({ ... });
server
  .use(loggingPlugin)
  .use(anotherPlugin);

await server.start();
```

**Hook types:**

| Hook | Sync/Async | Description |
|------|-----------|-------------|
| `beforeGate` | Sync | Short-circuit gate evaluation. First non-null result wins. |
| `afterGate` | Sync | Modify gate decision. Cascading (each plugin sees previous result). |
| `transformPrice` | Sync | Override tool pricing. First non-null number wins. |
| `onDeny` | Sync | Notification on denial. All plugins called. |
| `beforeToolCall` | Async | Modify JSON-RPC request before forwarding. Cascading. |
| `afterToolCall` | Async | Modify JSON-RPC response before returning. Cascading. |
| `onRequest` | Async | Add custom HTTP endpoints. First `true` return handles the request. |
| `onStart` | Async | Called after server starts. Registration order. |
| `onStop` | Async | Called before server stops. Reverse registration order. |

**Error isolation:** Plugin errors are caught and logged — a crashing plugin never takes down the server.

**List registered plugins (admin only):**

```bash
curl http://localhost:3402/plugins -H "X-Admin-Key: $ADMIN_KEY"
# { "count": 2, "plugins": [{ "name": "...", "version": "...", "hooks": ["beforeGate", ...] }] }
```

### Key Groups (Policy Templates)

Key groups let you define reusable policy templates and apply them to multiple API keys at once. Unlike teams (which share budgets), groups share **policies**: ACL, rate limits, pricing overrides, IP allowlists, and quotas.

**Create a group:**

```bash
curl -X POST http://localhost:3402/groups \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -d '{
    "name": "free-tier",
    "allowedTools": ["search", "read_file"],
    "rateLimitPerMin": 30,
    "ipAllowlist": ["10.0.0.0/8"],
    "quota": { "dailyCallLimit": 100, "monthlyCallLimit": 1000, "dailyCreditLimit": 50, "monthlyCreditLimit": 200 },
    "toolPricing": { "search": { "creditsPerCall": 2 } },
    "tags": { "tier": "free" }
  }'
# { "id": "grp_a1b2c3...", "name": "free-tier", ... }
```

**Assign keys to a group:**

```bash
curl -X POST http://localhost:3402/groups/assign \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -d '{ "groupId": "grp_a1b2c3...", "key": "pgk_..." }'
```

**Policy resolution rules:**

| Policy | Resolution |
|--------|-----------|
| `allowedTools` | Key wins if non-empty, otherwise group |
| `deniedTools` | Union of both (most restrictive) |
| `ipAllowlist` | Union of both (additive) |
| `rateLimitPerMin` | Key wins if set, otherwise group |
| `quota` | Key wins if set, otherwise group |
| `toolPricing` | Group overrides global config |
| `maxSpendingLimit` | Group default (key can override via `/limits`) |

**List groups:**

```bash
curl http://localhost:3402/groups -H "X-Admin-Key: $ADMIN_KEY"
# [{ "id": "grp_...", "name": "free-tier", "memberCount": 5, ... }]
```

**Update / delete / remove:**

```bash
# Update group policies
curl -X POST http://localhost:3402/groups/update \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -d '{ "id": "grp_...", "rateLimitPerMin": 60 }'

# Remove a key from its group
curl -X POST http://localhost:3402/groups/remove \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -d '{ "key": "pgk_..." }'

# Delete a group (removes all assignments)
curl -X POST http://localhost:3402/groups/delete \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -d '{ "id": "grp_..." }'
```

**Programmatic usage:**

```typescript
import { PayGateServer, KeyGroupManager } from 'paygate-mcp';

const server = new PayGateServer({ ... });
const { port, adminKey } = await server.start();

// Access groups directly
const group = server.groups.createGroup({ name: 'enterprise', rateLimitPerMin: 1000 });
server.groups.assignKey(apiKey, group.id);

// Resolve effective policy for a key
const policy = server.groups.resolvePolicy(apiKey, keyRecord);
// { allowedTools, deniedTools, rateLimitPerMin, quota, ipAllowlist, toolPricing, maxSpendingLimit }
```

**File persistence:** When using `--state-file`, group definitions and key assignments are automatically saved to a `*-groups.json` file alongside the main state file. Groups survive restarts without needing Redis.

**Redis sync:** When running with `--redis-url`, group definitions and key assignments are additionally persisted to Redis and synced across instances via pub/sub. All group CRUD operations and assignment changes propagate in real-time to other PayGate processes.

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
  "webhookFilters": [
    {
      "name": "production-alerts",
      "events": ["key.created", "key.revoked", "alert.fired"],
      "url": "https://alerts.example.com/webhook",
      "keyPrefixes": ["pk_prod_"]
    }
  ],
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

### Config Hot Reload

Reload pricing, rate limits, webhooks, quotas, and behavior flags from your config file without restarting the server:

```bash
# Reload from the config file used at startup
curl -X POST http://localhost:3402/config/reload \
  -H "X-Admin-Key: YOUR_ADMIN_KEY"

# One-time reload from a different config file
curl -X POST http://localhost:3402/config/reload \
  -H "X-Admin-Key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"configPath": "/path/to/updated-config.json"}'
```

**Hot-reloadable fields** (take effect immediately):
- `defaultCreditsPerCall`, `toolPricing` — pricing changes
- `globalRateLimitPerMin` — rate limit adjustment
- `shadowMode`, `refundOnFailure` — behavior flags
- `freeMethods` — free method list
- `globalQuota` — daily/monthly call and credit limits
- `webhookUrl`, `webhookSecret`, `webhookMaxRetries` — webhook infrastructure (rebuilt)
- `alertRules` — alert thresholds and rules

**Non-reloadable fields** (reported as skipped, require restart):
- `serverCommand`, `serverArgs` — backend MCP server process
- `port` — listening port
- `oauth` — OAuth 2.1 configuration

Response includes changed fields, skipped fields, and any validation warnings:
```json
{
  "ok": true,
  "changed": ["defaultCreditsPerCall", "globalRateLimitPerMin"],
  "skipped": [],
  "warnings": [],
  "message": "Config reloaded: 2 fields updated"
}
```

The config file is validated before applying changes — invalid configs are rejected with detailed error messages and zero changes applied.

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
- [x] Batch tool calls — `tools/call_batch` with all-or-nothing billing and parallel execution
- [x] Multi-tenant namespaces — Isolate API keys and usage data by tenant with namespace-filtered endpoints
- [x] Scoped tokens — Short-lived `pgt_` tokens with tool ACL narrowing, HMAC-SHA256 signed, zero server-side state
- [x] Token revocation list — Revoke scoped tokens before expiry with O(1) lookup, auto-cleanup, Redis sync
- [x] Usage-based auto-topup — Automatically refill credits when balance drops below threshold with daily limits
- [x] Admin API key management — Multiple admin keys with role-based permissions (super_admin, admin, viewer)
- [x] Webhook filters — Route events to multiple destinations by event type and key prefix with independent retry queues
- [x] Credit transfers — Atomically transfer credits between API keys with validation and audit trail
- [x] Bulk key operations — Execute multiple create/topup/revoke operations in one request with per-operation error handling
- [x] Key import/export — Export keys (JSON/CSV) for backup/migration, import with conflict resolution (skip, overwrite, error modes)
- [x] Webhook event replay — Replay dead letter entries (all or by index) with fresh delivery attempt and audit trail

## Requirements

- Node.js >= 18.0.0
- Zero external dependencies

## License

MIT
