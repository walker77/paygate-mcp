# Changelog

## 8.93.0 (2026-02-27)

### Response & Logging Hardening
- **Log injection prevention**: Added `sanitizeLogUrl()` utility — strips control characters (newlines, tabs, carriage returns) from request URLs before logging
  - Prevents forged log entries, hidden malicious activity, and SIEM evasion via `\r\n` injection
  - Applied to all 3 locations that log `req.url`: unhandled error handler, admin auth failure audit, insufficient role audit
  - URLs truncated to 2048 chars to prevent log bloat
- **Status response capping**: `/status` endpoint now caps the `keys` array at 1000 entries
  - Adds `keysTruncated: true` and `totalKeyCount` when capped
  - Prevents multi-MB responses with thousands of API keys; use paginated `GET /admin/keys` for full listing
- **Analytics topN capping**: `?top=` query parameter clamped to [1, 1000] (default 10)
  - Prevents memory exhaustion from `?top=999999999` — previously unbounded
- **Session creation rate limiting**: New per-IP rate limiter on MCP session creation (default: 60 sessions/min)
  - Prevents attackers from exhausting the 1000-session slot pool via rapid unauthenticated requests
  - Returns 429 with `Retry-After` header when limit exceeded
  - Existing sessions unaffected — rate limit only applies to new session creation
  - Configurable via `sessionRateLimit` config option
- 12 new tests covering log injection, status capping, topN clamping, and session rate limiting

---

## 8.92.0 (2026-02-27)

### Request-Level Hardening
- **Content-Type enforcement**: All POST endpoints now require `application/json` Content-Type (returns 415 Unsupported Media Type otherwise)
  - `/oauth/token` also accepts `application/x-www-form-urlencoded` per RFC 6749
  - Check runs after method validation (405) and auth (401/403), before body parsing
  - Prevents content smuggling, protocol confusion, and non-JSON payload injection
- **405 Method Not Allowed**: 10 multi-method endpoints now correctly return 405 (not 404) for unsupported HTTP methods
  - Affected: `/keys`, `/keys/templates`, `/alerts`, `/webhooks/dead-letter`, `/webhooks/filters`, `/teams`, `/tokens`, `/admin/keys`, `/groups`
  - Compliant with RFC 7231 Section 6.5.5
- **Connection limits**: `server.maxConnections` set to 10,000 (configurable) to prevent file descriptor exhaustion
- **ReDoS prevention**: `safeErrorMessage()` truncates input to 500 chars before regex matching
- 19 new tests covering Content-Type rejection (8 tests) and 405 compliance (11 tests)

---

## 8.91.0 (2026-02-27)

### Error Message Sanitization (Information Disclosure Prevention)
- **All catch-block error responses now sanitized** — prevents leaking internal details (stack traces, filesystem paths, class names) to clients
- Added `safeErrorMessage()` utility with allowlist of known-safe validation patterns — unknown errors return generic fallback
- **Config reload** (`POST /config/reload`): no longer leaks filesystem paths (ENOENT, EACCES) or JSON parse positions
- **OAuth endpoints** (`/oauth/register`, `/oauth/authorize`, `/oauth/token`): error_description sanitized, raw errors logged internally
- **Webhook filters** (`POST /webhooks/filters`, `POST /webhooks/filters/update`): validation errors sanitized
- **Group endpoints** (`POST /groups`, `POST /groups/update`, `POST /groups/assign`): errors sanitized, safe validation messages (e.g. "already exists") pass through
- **Bulk operations** (`POST /keys/bulk`): per-operation error messages sanitized
- **Webhook test delivery**: connection errors return generic "Connection failed" instead of raw socket errors
- All sanitized endpoints now log the real error details via structured logger for debugging
- 14 new tests verifying no dangerous patterns (ENOENT, stack traces, paths) leak to clients

---

## 8.90.0 (2026-02-27)

### Array Length Bounds Enforcement
- **All array-type admin inputs now clamped to sane upper bounds** — prevents memory exhaustion DoS via unbounded lists
- `allowedTools`/`deniedTools`: capped at 1,000 items per key/group/token (`MAX_ACL_ITEMS`)
- `ipAllowlist`: capped at 200 items per key/group (`MAX_IP_ALLOWLIST`)
- Added `clampArray()` utility for consistent enforcement alongside existing `clampInt()` and `sanitizeString()`
- Applied to all entry points: key creation, ACL updates, IP allowlist updates, scoped token creation, group create/update, bulk operations
- 9 new tests covering ACL clamping on /keys, /keys/acl, /keys/ip, /tokens, and passthrough for reasonable arrays

---

## 8.89.0 (2026-02-27)

### Numeric Input Bounds Enforcement
- **All numeric admin inputs now clamped to sane upper bounds** — prevents absurd values from propagating through the system
- Credits: capped at 1 billion (`MAX_CREDITS = 1_000_000_000`) — applies to key creation, topup, transfer, bulk ops, reservations, scheduled actions
- Quota limits: capped at 1 billion (`MAX_QUOTA_LIMIT`) — dailyCallLimit, monthlyCallLimit, dailyCreditLimit, monthlyCreditLimit across all endpoints
- Spending limits: capped at 1 billion (`MAX_SPENDING_LIMIT`) — key spending limits and group maxSpendingLimit
- Auto-topup: threshold/amount capped at 100 million (`MAX_TOPUP_AMOUNT`), maxDaily at 1 billion
- Rate limits: capped at 100,000 (`MAX_RATE_LIMIT`) requests per minute in group policies
- Group defaultCredits and team budgets also clamped
- Uses existing `clampInt()` for consistent enforcement (same as export pagination)
- 13 new tests covering credit clamping, quota clamping, auto-topup clamping, spending limit clamping, bulk ops, reservations, and passthrough for reasonable values

---

## 8.88.0 (2026-02-27)

### Export Response Caps
- **Added pagination to all export endpoints** — prevents memory exhaustion DoS from unbounded response data
- `/audit/export`, `/requests/export`, `/keys/export` now accept `limit` (default 1000, max 5000) and `offset` query params
- Responses include pagination metadata: `limit`, `offset`, `total` for client-side pagination
- CSV exports also respect `limit`/`offset` parameters
- `/keys` legacy listing capped at 500 entries
- `clampInt()` enforces bounds: negative limits clamped to 1, over-max clamped to 5000
- 17 new tests covering pagination metadata, default limits, custom limits, clamping, CSV enforcement across all 3 export endpoints and legacy /keys

---

## 8.87.0 (2026-02-27)

### Webhook SSRF Prevention
- **Added `checkSsrf()` validation** — blocks webhook URLs targeting private/internal networks (RFC 1918, loopback, link-local, cloud metadata, carrier-grade NAT, IPv6 private ranges)
- Covers all untrusted URL entry points: webhook filter create (POST /webhooks/filters), webhook filter update (POST /webhooks/filters/update)
- Blocks `localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (AWS/GCP metadata), `100.64.0.0/10`, IPv6 loopback/link-local/ULA, and IPv4-mapped IPv6 hex form
- Blocks non-HTTP protocols (`file://`, `ftp://`, `gopher://`)
- Config validator now warns about private webhook URLs at startup
- Operator-configured URLs (`--webhook-url`) are trusted (not blocked at delivery time) to support localhost development
- 45 new tests: 34 unit tests for checkSsrf(), 8 integration tests on admin endpoints, 3 config validator tests

---

## 8.86.0 (2026-02-27)

### Prototype Pollution Prevention
- **Added `safeJsonParse()` with reviver-based sanitization** — strips `__proto__`, `constructor`, and `prototype` keys from all user-supplied JSON payloads
- Replaced all 54 `JSON.parse()` calls on untrusted input in server.ts with `safeJsonParse()`
- Prevents Object.prototype pollution attacks where `{"__proto__": {"admin": true}}` could escalate privileges
- Nested pollution attempts (deep `__proto__` keys) are also stripped at any depth
- Trusted local file reads (package.json, config files) intentionally left as standard `JSON.parse()`
- 14 new tests verifying pollution prevention across multiple admin endpoints, nested payloads, and error paths

---

## 8.85.0 (2026-02-27)

### Admin Endpoint Body Size Enforcement
- **Fixed 6 admin endpoints with unprotected body readers** — `handleSetMaintenance`, `handleAddNote`, `handleCreateSchedule`, `handleCreateReservation`, `handleCommitReservation`, and `handleReleaseReservation` all used inline `req.on('data')` without size limits
- These bypassed the protected `readBody()` method that enforces `MAX_BODY_SIZE` (1 MB), timeout protection, and proper listener cleanup
- An attacker could send multi-GB payloads to any of these endpoints to exhaust server memory (DoS)
- All 6 endpoints now use `readBody()` with consistent 413 error responses for oversized bodies
- Converted all 6 handlers from callback-style `void` to `async/await Promise<void>` for cleaner control flow
- Zero remaining inline `req.on('data')` body readers in the codebase
- 12 new tests (oversized body rejection + normal operation verification for all 6 endpoints)

---

## 8.84.0 (2026-02-27)

### JSON-RPC 2.0 Envelope Validation
- **Strict envelope validation on `/mcp`** — validates `jsonrpc`, `method`, and `id` fields before processing
- Rejects non-object bodies (arrays, strings, numbers) with `-32600 Invalid Request`
- Rejects missing or wrong `jsonrpc` version (must be `"2.0"`)
- Rejects missing or non-string `method` field
- **Request ID type safety** — rejects object, array, and boolean IDs per JSON-RPC 2.0 spec (must be string, number, or null)
- Prevents orphaned pending requests in stdio proxy from non-spec IDs that can't match via Map lookup
- Guards added to all three transport layers: server.ts (HTTP), proxy.ts (stdio), http-proxy.ts (Streamable HTTP)
- 14 new tests (envelope validation, ID type rejection, valid ID acceptance, prototype pollution protection)

---

## 8.83.0 (2026-02-27)

### Error Response Consistency
- **`sendError()` now accepts optional `data` param** — error responses can include structured extra fields (e.g., reservation details, RBAC roles, config diagnostics) alongside the standard `{ error, requestId }` format
- **Migrated 22 raw `res.writeHead(4xx)` calls to `sendError()`** — every admin error response now includes `requestId` for log correlation (completing the v8.80.0 rollout)
- Affected endpoints: credit transfer, key alias, alert rules, scheduled actions, reservations, config reload, key notes, webhook filters, groups, teams, admin keys, templates, batch tool calls
- 8 intentionally raw responses remain: JSON-RPC parse error (MCP spec format), Stripe webhook result passthrough, and OAuth RFC 7591/7009 errors (RFC-mandated format)
- 10 new tests (requestId in transfer/template/schedule/RBAC/group/config/notes/reserve/admin-key errors, sendError data param preservation)

---

## 8.82.0 (2026-02-27)

### Resource Leak Fixes
- **Redis subscriber `sendAndWait()` listener leak** — timeout path now properly reattaches the original data listener via extracted `reattachOriginal()`, preventing permanent listener loss after command timeouts
- **HTTP proxy response body limit** — added `MAX_RESPONSE_BODY` (10 MB) cap with `settled` guard to prevent unbounded memory growth from oversized remote server responses
- **`readBody()` listener cleanup** — refactored to use named listener functions (`onData`, `onEnd`, `onError`) with explicit `cleanup()` that removes all listeners on every code path (success, timeout, oversize, error)
- 7 new tests (oversized body handling, slow-loris timeout, rapid error burst, server resilience after error paths)

---

## 8.81.0 (2026-02-27)

### Admin Query Parameter Hardening
- **sortBy allowlist validation** — `/keys` endpoint now rejects invalid `sortBy` values with 400 and lists valid fields (`name`, `credits`, `totalSpent`, `totalCalls`, `lastUsedAt`, `createdAt`)
- **order validation** — rejects invalid `order` values (must be `asc` or `desc`)
- **Pagination bounds** — `limit` and `offset` are clamped to safe ranges via `clampInt()` across all paginated endpoints: `/keys`, `/audit`, `/requests`, `/keys/credit-history`, `/keys/activity`, `/webhooks/log`
- NaN and non-numeric values handled gracefully (fall through to defaults, never crash)
- Prevents potential memory abuse from unbounded offset values
- 20 new tests (sortBy/order validation, limit/offset clamping, NaN handling, audit/request log bounds)

---

## 8.80.0 (2026-02-27)

### Request ID in Error Responses
- Every JSON error response (`4xx`/`5xx`) now includes a `requestId` field matching the `X-Request-Id` response header
- Enables client-side log correlation: match server errors to specific requests without inspecting headers
- Works across all error codes: 400, 401, 403, 404, 405, 409, 429

### String Field Sanitization
- All user-supplied string fields are now truncated to 500 characters via `sanitizeString()` to prevent log injection and memory abuse
- Protected fields: admin key names, team names/descriptions, group names/descriptions, template names, webhook filter names, key aliases, suspend reasons, maintenance messages, transfer memos, reservation memos, token revocation reasons
- 19 new tests (7 request-ID correlation, 12 string truncation)

---

## 8.79.0 (2026-02-27)

### Admin Endpoint Rate Limiting
- **Brute-force protection for admin API** — all endpoints behind `checkAdmin()` are now rate-limited per source IP using a sliding window counter
- Configurable via `adminRateLimit` config, `--admin-rate-limit` CLI flag, or `PAYGATE_ADMIN_RATE_LIMIT` env var (default: 120 requests/min, 0 = unlimited)
- Returns `429 Too Many Requests` with `Retry-After` header when limit is exceeded
- Rate limiting applies to both valid and invalid admin key attempts, preventing key enumeration attacks
- `/health` endpoint is unaffected (no auth required, no rate limiting)
- Admin rate limiter is cleaned up during graceful shutdown
- 8 new tests (basic enforcement, 429 response format, brute-force protection, POST endpoints, health bypass, disabled mode)

---

## 8.78.0 (2026-02-27)

### Bootstrap Admin Key Rotation
- **`POST /admin/keys/rotate-bootstrap`** — rotate the bootstrap admin key without server restart, eliminating a security gap where the initial admin key was immutable
- Generates a new `admin_` prefixed key, revokes the old one, and updates the server's internal reference in a single atomic operation
- Only the current bootstrap key holder (super_admin) can trigger rotation; other super_admins get a clear error
- Supports successive rotations (rotate → rotate → rotate) for key cycling workflows
- Audit trail via `admin_key.bootstrap_rotated` event (both audit log and webhook)
- Returns new key in response with security reminder to store it securely
- 14 new tests (unit: rotate/revoke/validate/error cases/successive rotations; integration: HTTP endpoint, method enforcement, role enforcement, double rotation)

---

## 8.77.0 (2026-02-27)

### Timing-Safe Admin Key Authentication
- **Constant-time admin key comparison** — `AdminKeyManager.validate()` now uses `crypto.timingSafeEqual()` to prevent timing attacks that could enumerate valid admin key prefixes
- Always iterates ALL stored keys (no early exit) to prevent timing leaks from Map.get() hit/miss differences
- Handles different-length keys with consistent-time padded comparison
- Aligns with existing timing-safe patterns in stripe webhook signature verification and scoped token validation
- 13 new tests (correct/incorrect/empty/partial/extended key validation, multi-key validation, revoked key rejection, lastUsedAt updates, HTTP integration, concurrent auth)

---

## 8.76.0 (2026-02-27)

### Persistence & Error Response Safety
- **Atomic file writes for groups** — `KeyGroupManager.saveToFile()` now uses write-tmp-then-rename pattern (matching store.ts) to prevent corruption on crash
- **Atomic file writes for admin keys** — `AdminKeyManager.save()` now uses write-tmp-then-rename pattern to prevent corruption on crash
- **Enhanced error responses** — top-level request handler returns `413 Request body too large` and `408 Request timeout` instead of generic `500 Internal server error`
- **Error logging** — unhandled request errors now log URL, method, and error message via structured logger before returning 500
- 14 new tests (atomic writes, round-trip persistence, oversized body, invalid JSON, error paths, auth errors)

---

## 8.75.0 (2026-02-27)

### Input Validation Hardening
- **NaN credits bypass fixed** — `Number.isFinite()` guard prevents `NaN`, `Infinity`, and non-numeric values from bypassing the `credits <= 0` check in key creation
- **Invalid date rejection** — `expiresAt` validated with `new Date().getTime()` NaN check; rejects garbage strings like `"not-a-date"` and `"2025-13-45"` with clear ISO 8601 error message
- **Expiry endpoint date validation** — `POST /keys/expiry` now validates `expiresAt` the same way as key creation, with proper `null` handling for expiry removal
- **NaN alert threshold fixed** — `Number.isFinite()` replaces `typeof === 'number'` check (which passes for NaN/Infinity) in alert rule configuration
- **expiresIn validation** — Both key creation and expiry endpoints use `Number.isFinite()` for `expiresIn` to prevent NaN propagation
- 22 new tests (NaN/Infinity/negative/zero/float credits, invalid date strings, null expiry, valid ISO dates, NaN expiresIn, NaN/Infinity/negative alert thresholds)

---

## 8.74.0 (2026-02-27)

### Graceful Shutdown Completeness
- **SSE stream cleanup** during `gracefulStop()` — admin event streams are closed before drain wait, preventing dangling connections
- **Background timer cleanup** during `gracefulStop()` — scheduled actions timer stopped before drain wait
- **SSE error handler** — `res.on('error')` auto-removes disconnected clients from the admin event stream set (broken pipe, network failure)
- **Scheduled actions error boundary** — `executeScheduledActions()` wrapped in try/catch to prevent background task crashes from killing the server
- 8 new tests (SSE shutdown cleanup, drain behavior, health drain status, double-stop idempotency, timer cleanup, SSE disconnect resilience, background error boundary)

---

## 8.73.0 (2026-02-27)

### Process Safety & Socket Hardening
- **Global error handlers** — `unhandledRejection` and `uncaughtException` trigger graceful shutdown with logging instead of silent crashes
- **Socket-level error handling** — `server.on('clientError')` logs and cleanly closes malformed HTTP connections (protocol violations, invalid headers)
- **Body read timeout** — `readBody()` now enforces a timeout (reuses `requestTimeoutMs`, default 30s) to prevent slow-loris body-dripping attacks
- Body read uses settled guard to prevent double-resolve on edge cases
- Server survives concurrent malformed requests without resource leaks
- 8 new tests (malformed HTTP, body timeout, oversized body, concurrent attacks, resilience)

---

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
