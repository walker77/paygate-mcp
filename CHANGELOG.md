# Changelog

## 8.72.0 (2026-02-27)

### Startup Summary
- **Configuration summary log** on server start — transport, price, rate limit, active features, key count
- Text format: `[paygate] Listening on port 3402 { transport: 'stdio', price: 1, ... }`
- JSON format: `{"ts":"...","level":"info","msg":"Listening on port 3402","transport":"stdio","features":"webhooks, quotas",...}`
- Detects 11 optional features: shadow-mode, redis, webhooks, oauth, multi-server, plugins, alerts, expiry-scanner, quotas, trusted-proxies, cors-restricted
- **`KeyStore.getKeyCount()`** — new public method for key count without iterating
- Respects log level (silent = no banner)
- 10 new tests

---

## 8.71.0 (2026-02-27)

### Security Headers
- **7 security headers** on every response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `X-XSS-Protection: 0`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'`, `X-Powered-By` removed
- **Dashboard CSP override**: `/dashboard` gets relaxed CSP for inline scripts/styles while keeping `frame-ancestors 'none'`
- Headers apply to all responses: API, admin, errors, OPTIONS preflight, metrics, CSV exports
- Compatible with existing `customHeaders` config — security headers apply first, custom headers can extend
- 16 new tests

---

## 8.70.0 (2026-02-27)

### Server Hardening
- **Request timeout** — `requestTimeoutMs` config (default 30s) prevents slow-loris and hung requests (Node.js default: no timeout)
- **Headers timeout** — `headersTimeoutMs` config (default 10s) limits time to receive HTTP headers
- **Keep-alive timeout** — `keepAliveTimeoutMs` config (default 65s, > typical 60s LB idle) for idle connection recycling
- **Max requests per socket** — `maxRequestsPerSocket` config for HTTP pipelining limits
- **CLI flags**: `--request-timeout`, `--headers-timeout`, `--keepalive-timeout`, `--max-requests-per-socket`
- **Env vars**: `PAYGATE_REQUEST_TIMEOUT`, `PAYGATE_HEADERS_TIMEOUT`, `PAYGATE_KEEPALIVE_TIMEOUT`, `PAYGATE_MAX_REQUESTS_PER_SOCKET`
- **Config file**: `requestTimeoutMs`, `headersTimeoutMs`, `keepAliveTimeoutMs`, `maxRequestsPerSocket` in paygate.config.json
- **`/info` endpoint**: Exposes `serverLimits` section with all timeout settings
- 11 new tests

---

## 8.69.0 (2026-02-27)

### Structured Logging
- **Logger class** (`src/logger.ts`) — zero-dependency structured logging with levels (`debug`, `info`, `warn`, `error`, `silent`) and formats (`text`, `json`)
- **Text format**: `[paygate] message` / `[paygate:redis] message` — human-readable for development
- **JSON format**: `{"ts":"...","level":"info","component":"paygate","msg":"..."}` — machine-parseable for log aggregators (Datadog, ELK, CloudWatch)
- **Child loggers**: hierarchical component names (`paygate:redis`, `paygate:oauth`) for filtering
- **38 operational `console.*` calls replaced** across 5 source files (server.ts, redis-sync.ts, store.ts, key-templates.ts, oauth.ts)
- **CLI flags**: `--log-level` and `--log-format` with env var support (`PAYGATE_LOG_LEVEL`, `PAYGATE_LOG_FORMAT`)
- **Config file support**: `logLevel` and `logFormat` fields in `paygate.config.json`
- **Exported API**: `Logger`, `parseLogLevel`, `parseLogFormat`, `VALID_LOG_LEVELS`, `VALID_LOG_FORMATS` + types
- 44 new tests (construction, text/JSON output, level filtering, child loggers, integration with PayGateServer)

---

## 8.68.0 (2026-02-27)

### CI/CD
- **Enhanced GitHub Actions CI** — coverage reporting job (80% threshold gate), Docker build verification job
- Coverage check fails CI if lines or functions drop below 80%
- Docker job builds image and verifies `/health` endpoint responds
- Multi-node matrix testing: Node.js 18, 20, 22

---

## 8.67.0 (2026-02-27)

### Load Testing
- **k6 load test script** (`load-test.js`) — 3 scenarios: MCP tool calls (50 VUs), admin reads, health probes
- Thresholds: p95 < 200ms, p99 < 500ms, error rate < 5%, 100+ req/s
- Setup/teardown creates and revokes test API keys automatically
- README load testing section with usage examples
- `npm run test:load` script

---

## 8.66.0 (2026-02-27)

### Refactoring
- **Response helpers** — `sendJson()` and `sendError()` private methods replace 588 instances of boilerplate `res.writeHead()`/`res.end(JSON.stringify())` patterns
- **server.ts reduced by 572 lines** (12,995 → 12,423) with zero behavior changes
- All 2,920 tests pass with identical output

---

## 8.65.0 (2026-02-27)

### Production Readiness
- **Dockerfile** + `.dockerignore` for containerized deployments (multi-stage build, non-root user, health check)
- **docker-compose.yml** with Redis for production horizontal scaling
- **Deployment guide** in README — Docker, docker-compose, systemd, PM2 with production checklist
- **Table of contents** in README for 5000+ line navigation
- **Error code reference** — HTTP status codes, JSON-RPC error codes, webhook event types
- **CHANGELOG.md** updated with full version history from v8.39.0 to v8.65.0

### Fixed
- Credit burn rate test mock now properly handles MCP `initialize` method (fixes flaky test under load)

---

## 8.58.0–8.64.0 (2026-02-27)

### Analytics Endpoints (7 new admin endpoints)
- `GET /admin/group-activity` — Per-group activity metrics (v8.58.0)
- `GET /admin/credit-waste` — Per-key credit waste analysis (v8.59.0)
- `GET /admin/tool-profitability` — Per-tool profitability with revenue metrics (v8.60.0)
- `GET /admin/consumer-growth` — Consumer growth metrics with spend rate (v8.61.0)
- `GET /admin/namespace-comparison` — Side-by-side namespace comparison (v8.62.0)
- `GET /admin/key-health-overview` — Per-key health with status levels (v8.63.0)
- `GET /admin/system-overview` — Executive summary dashboard (v8.64.0)

### Tests
- 2,920 tests across 151 suites

---

## 8.39.0–8.57.0 (2026-02-25 – 2026-02-26)

### Analytics Endpoints (19 new admin endpoints)
- Tool revenue ranking, consumer retention cohorts, consumer lifetime value, response time distribution, credit distribution, consumer segmentation, tool correlation, key churn analysis, access heatmap, credit efficiency, tool adoption, system health score, consumer insights, webhook health, key status overview, request volume trends, group performance, audit summary, namespace usage summary
- Key age analysis, credit flow analysis, error rate trends, tool latency, key dependency map, capacity planning, SLA monitoring, compliance report, usage forecasting, anomaly detection, key portfolio health, revenue analysis, security audit, traffic analysis, denial analysis, quota analysis, rate limit analysis, cost analysis
- Hourly traffic, key ranking, daily summary, credit allocation, tool popularity, consumer activity, peak usage times, group revenue, namespace revenue, credit utilization rate, error breakdown
- Consumer spend velocity, namespace activity, credit burn rate, consumer risk score, revenue forecast

### Tests
- Grew from ~2,600 to 2,920 tests across 151 suites

---

## 0.8.0 (2026-02-25)

### Features
- **Per-tool ACL** — Whitelist (`allowedTools`) and blacklist (`deniedTools`) tools per API key. ACL also filters `tools/list` responses so clients only see permitted tools. Manage via `POST /keys/acl` or set at key creation.
- **Per-tool rate limits** — Set independent rate limits per tool via `toolPricing[tool].rateLimitPerMin`. Enforced independently per API key on top of the global rate limit.
- **Key expiry (TTL)** — Create API keys with `expiresIn` (seconds) or `expiresAt` (ISO date). Expired keys return `api_key_expired` error. Manage via `POST /keys/expiry`. Admins can extend or remove expiry at any time.
- **Enhanced `/keys` endpoint** — Create keys with ACL, expiry, and credits in one call.
- **Enhanced `/balance` endpoint** — Returns `allowedTools`, `deniedTools`, and `expiresAt` alongside credits.
- **New admin endpoints** — `POST /keys/acl` (set tool ACL), `POST /keys/expiry` (set key TTL).
- **Backward-compatible persistence** — Old state files auto-backfill new fields on load.

### Security
- 17 new red-team tests (Passes 12-14): ACL bypass, key expiry bypass, per-tool rate limit bypass
- ACL lists capped at 100 entries, empty/whitespace values filtered
- Expiry uses fail-closed behavior — expired = denied
- Invalid date strings treated as no-expiry (safe default)
- Per-tool rate limit counters isolated per key (no cross-key leakage)

### Tests
- 311 tests across 16 suites (up from 232 across 12)

---

## 0.7.0 (2026-02-25)

### Features
- **Spending limits** — Set max total spend per API key via `POST /limits`. Keys are denied when they hit their cap. Balance endpoint shows `spendingLimit` and `remainingBudget`.
- **Refund on failure** — `--refund-on-failure` flag returns credits when a downstream tool call fails. Rolls back `totalSpent` and `totalCalls`.
- **Webhook events** — `--webhook-url <url>` POSTs batched usage events to any URL. Events are buffered (10 per batch, 5s flush interval) with one retry on failure.
- **Config file mode** — `--config <path>` loads all settings from a JSON file. CLI flags override config file values. Supports `importKeys` map for pre-provisioned keys.

### Security
- 14 new red-team tests (Passes 9-11): budget bypass, refund abuse, webhook URL security
- Spending limits use integer arithmetic to prevent float precision attacks
- Webhook URLs masked in `/status` output
- Error code updated to `-32402` (SEP-2007 aligned)

### Tests
- 232 tests across 12 suites (up from 207 across 10)

---

## 0.5.0 (2026-02-25)

### Features
- **Streamable HTTP transport** — Gate remote MCP servers via `--remote-url`
- **Admin web dashboard** — Real-time UI at `/dashboard` with auto-refresh, charts, and key management
- **Stripe integration** — Auto top-up credits on payment via `/stripe/webhook`
- **Usage data export** — JSON and CSV export via `/usage` endpoint
- **Key revocation** — `POST /keys/revoke` to deactivate keys
- **Client self-service** — `/balance` endpoint for API key holders

### Security
- Stripe HMAC-SHA256 signature verification with timing-safe comparison
- Dashboard uses safe DOM methods (no innerHTML)
- API keys never forwarded to remote servers
- 70 adversarial red-team tests across 8 passes

### Tests
- 207 tests across 10 suites
