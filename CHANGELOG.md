# Changelog

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
