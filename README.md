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
- **Rate Limiting** — Sliding window per-key rate limits
- **Usage Metering** — Track who called what, when, and how much they spent
- **Two Transports** — Wrap local servers via stdio or remote servers via Streamable HTTP
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
| `/mcp` | POST | `X-API-Key` | JSON-RPC 2.0 proxy to wrapped MCP server |
| `/balance` | GET | `X-API-Key` | Client self-service — check own credits |
| `/keys` | POST | `X-Admin-Key` | Create a new API key with credits |
| `/keys` | GET | `X-Admin-Key` | List all keys (masked) |
| `/topup` | POST | `X-Admin-Key` | Add credits to an existing key |
| `/keys/revoke` | POST | `X-Admin-Key` | Revoke an API key |
| `/usage` | GET | `X-Admin-Key` | Export usage data (JSON or CSV) |
| `/status` | GET | `X-Admin-Key` | Full dashboard with usage stats |
| `/dashboard` | GET | None (admin key in-browser) | Real-time admin web dashboard |
| `/stripe/webhook` | POST | Stripe Signature | Auto-top-up credits on payment |
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
```

> **Note:** Use `--server` OR `--remote-url`, not both.

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

## Programmatic API

```typescript
import { PayGateServer, HttpMcpProxy } from 'paygate-mcp';

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

// Or gate a remote server (Streamable HTTP)
const remoteServer = new PayGateServer({
  serverCommand: '',
  port: 3402,
  defaultCreditsPerCall: 5,
}, undefined, undefined, 'https://my-mcp-server.example.com/mcp');

const { port, adminKey } = await server.start();
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
- Red-teamed with 70 adversarial security tests across 8 passes

## Current Limitations

- **Single process** — No clustering or horizontal scaling.
- **No response size limits for HTTP transport** — Large responses from remote servers are forwarded as-is.

## Roadmap

- [x] Persistent storage (`--state-file`)
- [x] Streamable HTTP transport (`--remote-url`)
- [x] Stripe webhook integration (`--stripe-secret`)
- [x] Client self-service balance check (`/balance`)
- [x] Usage data export — JSON and CSV (`/usage`)
- [x] Admin web dashboard (`/dashboard`)
- [ ] Multi-tenant mode

## Requirements

- Node.js >= 18.0.0
- Zero external dependencies

## License

MIT
