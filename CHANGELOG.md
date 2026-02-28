# Changelog

## 10.13.0 (2026-02-28)

### Event Ledger — Immutable Event Sourcing
- **Full audit trail** with immutable event append:
  - Sequence-ordered events with aggregate versioning
  - Optimistic concurrency control via `expectedVersion` parameter
  - Batch append for multi-event atomicity
  - Query with filters: aggregateId, type, types, time range, afterSequence
  - Pagination with offset/limit and `hasMore` flag
  - Aggregate snapshots with version, event count, and type list
  - `replay()` and `replayAll()` for state reconstruction from events
  - Time-travel queries via `getEventsAsOf()` for point-in-time state
  - Event type count analytics
  - Configurable `maxEvents` eviction for bounded memory

### Dynamic Pricing Engine — Demand-Based Tool Pricing
- **Composable pricing rules** evaluated in priority order:
  - Time-of-day multipliers with configurable peak hours
  - Demand-based surge pricing with threshold/window/maxMultiplier
  - Volume discount tiers (percentage-based, key-scoped)
  - Per-key price overrides via key-specific pricing maps
  - Custom pricing functions with fail-safe error handling
  - Rule enable/disable toggle without removal
  - Demand tracking with automatic timestamp pruning
  - Price result includes basePrice, finalPrice, appliedRules, multiplier

### Quota Rollover Manager — Recurring Quotas with Rollover
- **Periodic quota management** with unused credit rollover:
  - Daily, weekly, and monthly quota periods
  - Configurable rollover percentage (0-100%) of unused quota
  - Maximum rollover cap to prevent unbounded accumulation
  - Auto-advance expired periods on consumption
  - Rollover chain: unused credits from rollover periods roll over again
  - Rollover history tracking with full event details
  - Quota limit and rollover settings updatable mid-period
  - Consumption denied with remaining balance reporting

### API Key Scoping — Fine-Grained Tool Access Control
- **Scope-based permission system** for API keys:
  - Define named scopes with descriptions and inheritance chains
  - Circular scope reference protection
  - Tool-to-scope mapping: require any matching scope for access
  - Permanent and temporary (TTL) scope grants per key
  - Effective scope resolution with full inheritance expansion
  - Wildcard `*` scope grants access to all scoped tools
  - Detailed access check results with matched scopes and denial reasons
  - Configurable: allowUnscopedTools, denyUnscopedKeys
  - Automatic cleanup of expired temporary grants

## 10.12.0 (2026-02-28)

### SLO Monitor — Service Level Objective Tracking
- **Error budget monitoring** with burn rate alerting:
  - 3 SLO types: latency (p99 threshold), availability (success rate), error rate
  - Configurable targets (e.g., 99.9% availability = 0.001 error budget)
  - Rolling window computation with customizable `windowSeconds`
  - Budget consumed/remaining tracking with compliant/violated status
  - Burn rate calculation relative to window elapsed time
  - Auto-alerts: budget warning, budget exhausted, high burn rate
  - Alert deduplication (60s cooldown per SLO+type)
  - Filter SLOs by tools and keys for scoped monitoring
  - `getViolations()` for quick SLO breach summary

### Credit Reservation — Pre-Authorization for Tool Calls
- **Reserve-settle-release pattern** for safe credit management:
  - `reserve()` holds credits before execution, reducing available balance
  - `settle(id, actualAmount)` consumes credits (actual may differ from reserved)
  - `release(id)` returns held credits to available pool
  - TTL-based auto-expiration with configurable `defaultTtlSeconds`
  - Available vs held balance tracking per key
  - `maxReservationsPerKey` and `maxReservationAmount` limits
  - Full reservation lifecycle: held → settled/released/expired
  - Query active reservations per key with history

### Billing Cycle Manager — Metered Billing Periods
- **Subscription-based billing cycles** with invoice generation:
  - 3 frequencies: daily, weekly, monthly
  - Usage recording per key with tool/credit/metadata tracking
  - `generateInvoice()` aggregates usage into line items by tool
  - Invoice lifecycle: draft → finalized → paid (or voided)
  - Subscription management: create, pause, resume, cancel
  - Auto-cycle advancement when period expires
  - Invoice query by key with limit; stats tracking
  - Configurable `maxUsageRecords` and `maxInvoices`

### API Version Router — Versioned Tool Migration
- **Multi-version tool routing** with deprecation management:
  - Register tool versions with status: preview/current/deprecated/sunset
  - Per-key version overrides for gradual rollout
  - Resolution: key override → current version → latest fallback
  - Deprecation warnings with sunset dates and migration suggestions
  - Auto-sunset versions past their sunset date
  - `planMigration()` identifies affected keys between versions
  - `executeMigration()` bulk-moves keys from old to new version
  - `getApproachingSunset(days)` for proactive migration planning
  - Version removal auto-cleans key overrides

## 10.11.0 (2026-02-28)

### Batch Credit Manager — Bulk Credit Operations
- **Atomic batch execution** for credit operations:
  - 5 operation types: topup, deduct, transfer, refund, adjust
  - Atomic mode: all-or-nothing with automatic rollback on failure
  - Non-atomic mode: partial success with per-op error reporting
  - Transfer validation: same-key rejection, max transfer amount enforcement
  - Negative balance protection (configurable `allowNegativeBalance`)
  - `validate()` dry-run for pre-flight checking
  - Batch size limits with `maxOpsPerBatch` configuration
  - Full execution history with `getHistory()` and `getBatch(id)`
  - Stats: batches, ops by type, failures, rollbacks, tracked keys

### Key Lifecycle Manager — State Machine for API Keys
- **Full state machine** with 5 states: created → active → suspended/expired/revoked
  - Valid transitions enforced: created→active, active→suspended/expired/revoked, suspended→active/revoked
  - Auto-expiration: keys transition to expired when past `expiresAt`
  - `suspend(id, reason)` and `reactivate(id)` with reason tracking
  - `revoke(id, reason)` for permanent deactivation
  - `getExpiringKeys(withinSeconds)` for proactive expiration alerting
  - `expireKeys()` batch expiration sweep
  - Event history per key with full audit trail
  - List and filter by state, search by name/description
  - Configurable `maxKeys`, `defaultTtlMs`, `autoExpire`

### Webhook Template Engine — Customizable Payloads
- **Template rendering** with variable interpolation and conditionals:
  - `{{variable}}` interpolation with nested dot-notation support
  - `{{#if variable}}...{{/if}}` conditional blocks
  - Format-aware escaping: JSON (backslash), form (URL-encode), text (passthrough)
  - Header interpolation with template variables
  - Default and required variable tracking with validation
  - `validateTemplate()` for syntax and variable checking
  - `extractVars()` to discover all template variables
  - Inline rendering with `renderInline()` for ad-hoc templates
  - Stats: templates, renders, render errors

### Access Log Engine — Structured Request Logging
- **Full-featured access logging** with search and analytics:
  - Record key, tool, method, status, response time, IP, user agent, credits
  - Search with 10+ filter dimensions: key, keys, tool, tools, status, IP, time range, response time range, free text
  - Pagination with limit/offset and hasMore indicator
  - `summarize()` with p95/p99 response times, top keys/tools, unique IPs
  - `importEntries()` for bulk loading
  - Automatic eviction on `maxEntries` and retention period
  - `purge()` for manual retention-based cleanup

## 10.10.0 (2026-02-28)

### Per-Tool Rate Limiting — Fine-Grained Call Throttling
- **Sliding window rate limiter** with per-tool rules:
  - Exact tool match → wildcard `*` → configurable default fallback
  - Per-key, per-tool independent rate windows
  - `peek()` checks remaining capacity without consuming a slot
  - `resetWindow(key, tool)` and `resetKey(key)` for manual override
  - Active/inactive rule toggling; inactive rules skipped transparently
  - Stats: checks, denials, denials-by-tool, active tracking windows
  - Configurable `maxRules` and `defaultMaxCalls`/`defaultWindowSeconds`

### Usage Export Engine — CSV/JSON Data Export with Aggregation
- **Flexible export** for billing, compliance, and analytics:
  - Record usage events with key, tool, credits, allowed, response time
  - Export as JSON or CSV with proper escaping (commas, quotes)
  - Filter by keys, tools, date range, allowed/denied status, with limit
  - Aggregated export: hourly, daily, weekly, monthly time buckets
  - Each bucket includes total calls, denied calls, total credits, avg response time
  - `importRecords()` for bulk loading; `count()` for filtered record counts
  - Configurable `maxRecords` with automatic eviction of oldest records
  - Date range metadata in export results

### API Key Permissions Engine — Conditional Access Control
- **Rule-based ACL** with 7 condition types:
  - `environment`: restrict to production, staging, etc.
  - `max_payload_bytes`: enforce request size limits
  - `tool_pattern`: wildcard tool name matching (e.g., `search_*`)
  - `ip_cidr`: IPv4 CIDR range filtering with full subnet math
  - `time_range`: hour-of-day restrictions
  - `day_of_week`: day-based scheduling (0=Sunday through 6=Saturday)
  - `custom`: arbitrary key/value checks on extra context
  - AND logic: all conditions must pass for a rule to match
  - Priority-ordered evaluation; inactive rules skipped
  - Assign multiple rules per key; configurable default effect (allow/deny)
  - Stats: checks, denials, rule count, assigned key count

### Health Check Monitor — Backend Health Tracking
- **Multi-target health monitoring** with status transitions:
  - Status flow: unknown → healthy/degraded/unhealthy
  - Configurable thresholds: `unhealthyThreshold` and `healthyThreshold`
  - Check types: ping, tcp, http (extensible)
  - `getSnapshot()` with uptime %, avg response time, consecutive success/fail counts
  - `getOverallHealth()` aggregates all targets (unhealthy if any unhealthy)
  - `getDueTargets()` returns targets past their check interval
  - Inactive targets excluded from due checks
  - Full check history with configurable retention
  - Stats: total checks, total failures, target counts

## 10.9.0 (2026-02-28)

### Webhook Signature Verification — Inbound Webhook Validation
- **Multi-scheme signature verification** for incoming webhooks:
  - HMAC-SHA256, Stripe v1, GitHub SHA-256, and custom scheme support
  - Timing-safe comparison using Node.js `timingSafeEqual`
  - Replay protection with configurable timestamp validation (default: 5 min max age)
  - Auto-discovery: tries all active secrets when no specific secret ID given
  - Case-insensitive header lookup for all signature headers
  - `sign()` and `signStripe()` helper methods for generating outbound signatures
  - Secret masking: `getSecret()` and `getSecrets()` never expose raw secret values
  - Stats: verifications by secret, success/failure counts, failure reasons

### Key Rotation Scheduler — Automated API Key Lifecycle
- **Policy-based key rotation** with grace period support:
  - Create rotation policies with configurable intervals (default: 30 days)
  - Grace periods: old key stays valid during transition (default: 24 hours)
  - Schedule keys for automatic rotation based on policies
  - `getDueKeys()` returns all keys past their rotation deadline
  - `expireGracePeriods()` cleans up expired grace periods
  - `isKeyValid()` checks both current and grace-period keys
  - Full rotation history with auto/manual trigger tracking
  - Export rotation events for compliance audit trails
  - Stats: scheduled keys, due keys, grace keys, auto vs manual rotations

### Usage Forecast Engine — Predictive Credit Analytics
- **EMA + linear regression** for usage prediction:
  - Record usage data points with automatic time-bucket aggregation
  - Exponential moving average (EMA) for trend smoothing (configurable alpha)
  - Linear regression for daily/weekly/monthly credit projections
  - Days-until-exhaustion prediction when current balance is provided
  - Trend detection: rising, falling, or stable with strength indicator
  - Anomaly detection: spike/drop alerts based on standard deviation thresholds
  - Confidence scoring based on available data volume
  - Per-key tracking with configurable max data points (default: 720)
  - Stats: tracked keys, total forecasts, total anomalies

### Multi-Currency Credit Conversion — Global Billing
- **Currency-aware pricing** for international billing:
  - Add/update currencies with ISO 4217 codes and exchange rates
  - `creditsToMoney()` and `moneyToCredits()` with proper rounding
  - `convertBetween()` for cross-currency conversion via credits
  - `getToolPricing()` returns per-tool pricing in all active currencies
  - Support for zero-decimal currencies (JPY) and symbol placement (before/after)
  - Configurable base currency with max currency limit (default: 50)
  - Stats: conversions by currency, total conversions

## 10.8.0 (2026-02-28)

### Key Hierarchy — Parent/Child API Key Relationships
- **Hierarchical key management** for organizations and resellers:
  - Create parent-child key relationships with credit ceiling inheritance
  - Child keys deduct from parent's balance with configurable credit ceilings
  - Multi-level hierarchy support (configurable max depth, default: 3)
  - Circular reference prevention and max-children enforcement
  - Ancestry chain queries (getAncestors, getDescendants, getRoot)
  - Credit usage tracking per child with refund support
  - Inherit allowed/denied tools and quota from parent
  - Export/import for persistence
  - Stats: relations, depth, cascaded credits

### Sandbox Mode — Try-Before-Buy
- **Free trial tier** for API keys without credit deduction:
  - Create sandbox policies with call limits and time windows
  - Assign policies to keys (or set a default for all unassigned keys)
  - Per-tool allowlists and denylists within sandbox
  - Real or mocked response modes — preview tools before purchasing
  - Automatic window reset (e.g., 10 free calls per hour)
  - Per-key usage tracking with per-tool breakdown
  - Export/import for persistence and backup
  - Stats: sandbox calls, denials, per-tool usage

### Revenue Share Tracking — Split Billing for Marketplaces
- **Revenue splitting** between platform and tool developers:
  - Create revenue share rules per tool or catch-all
  - Configurable developer share percentage (0-100%)
  - Minimum credits per call threshold before sharing applies
  - Per-developer payout tracking with per-tool breakdown
  - Settlement workflow — mark balances as paid with external refs
  - Settlement history and developer payout reports
  - Platform revenue summary (total/platform/developer split)
  - Stats: rules, entries, credits split, settlements

### Connection-Time Billing — Duration-Based Charges
- **Bill for connection duration** (SSE/stdio/HTTP long-lived connections):
  - Track active connections as billable sessions
  - Configurable credits per interval (e.g., 1 credit/minute)
  - Grace period before billing starts
  - Idle timeout enforcement — auto-terminate inactive sessions
  - Maximum session duration limits
  - Pause/resume billing per session
  - Credit availability check callback — terminate on insufficient funds
  - Bulk billing (billAll) for periodic processing
  - Cost estimation for connection durations
  - Per-transport billing configuration (SSE, stdio, HTTP)
  - Stats: active sessions, credits billed, termination reasons

## 10.7.0 (2026-02-28)

### Prepaid Credit Grants with Expiration, Priority & Rollover
- **Named credit grants** — go beyond simple balance -= cost:
  - Create named grants (e.g., 'Welcome Credits', 'Monthly Allowance') with configurable amounts
  - Priority-based consumption — lower priority number consumed first
  - Automatic expiration — grants expire at a configurable date
  - Soonest-expiring grants consumed first within same priority tier
  - Rollover support — transfer remaining balance to a new grant before expiry
  - Partial rollover with configurable percentage (e.g., 50% rollover)
  - Refund credits back to specific grants
  - Void grants (cancel and mark remaining as lost)
  - Per-grant usage tracking with deduction breakdown
  - Export/import for persistence and backup
  - Stats: grants created, consumed, expired, rollovers, deductions
  - Config: `manager.createGrant(key, { name, amount, priority, expiresAt, metadata })`

### A2A Protocol Support (Agent-to-Agent)
- **Google A2A protocol primitives** for inter-agent communication:
  - Agent Cards (/.well-known/agent.json) — advertise agent capabilities and skills
  - Task lifecycle: submitted → working → input-required → completed/failed/canceled
  - Message exchange with typed parts (text, file, data)
  - State transition history recording
  - Artifact production during task execution
  - Skill discovery and matching by name, tags, description
  - Session-scoped multi-turn conversations
  - Full JSON-RPC 2.0 request handling (tasks/send, tasks/get, tasks/cancel)
  - Task cleanup with configurable max age
  - Stats: tasks by status, messages exchanged, artifacts produced

### Sequence Anomaly Detection
- **Markov chain anomaly detection** over tool call history (inspired by Cloudflare):
  - Per-key transition model — learns normal tool call patterns
  - Learning mode: passively builds model without enforcement
  - Enforcement mode: flags unusual sequences after configurable threshold
  - Laplace smoothing for unseen transitions
  - Global baseline model for new keys (cross-key patterns)
  - Sliding window for recent sequence context
  - Configurable anomaly threshold and actions (log, warn, block)
  - Sequence score calculation for overall key health
  - Top transitions report for debugging
  - Key-level eviction when capacity is reached
  - Stats: checks, anomalies, blocks, learning/enforcing keys, recent events

### Proxy-as-MCP-Server
- **Expose PayGate management as MCP tools** agents can discover and call:
  - 10 built-in management tools: balance, usage, pricing, rate limits, quotas, cost estimation, grants, health, key info, tool listing
  - Agents make informed resource decisions without separate admin API calls
  - Custom prefix support (default: `paygate_`)
  - Resolver-based architecture — connect tools to any data source
  - Enable/disable individual management tools
  - Register custom management tools at runtime
  - Returns MCP-compatible tool definitions for tools/list
  - Proper error handling with JSON-RPC error codes
  - Stats: calls per tool, total errors

## 10.6.0 (2026-02-28)

### PII Reversible Masking
- **Reversible PII tokenization** — masks sensitive data before it reaches backend servers:
  - Unlike destructive redaction, replaces PII with deterministic tokens (e.g., `<EMAIL_1>`, `<SSN_1>`)
  - Per-request token vaults — zero cross-request data leakage
  - Automatic unmasking in responses — original values restored transparently
  - Built-in patterns: email, phone, SSN, credit card, IBAN
  - Custom pattern support via regex with per-tool scoping
  - Token deduplication — same value gets same token within a request
  - Vault cleanup with configurable TTL for in-flight request safety
  - Stats: mask/unmask counts, tokens by type, active vaults
  - Config: `piiMasking: { enabled, patterns, tokenFormat, maxTokensPerRequest }`

### Virtual MCP Server Composition (Tool Federation)
- **Compose multiple upstream MCP servers into one endpoint** — agents see a unified tool list:
  - Prefix-based namespacing (e.g., `fs_readFile`, `db_query`) prevents tool name collisions
  - Health-aware routing with per-upstream latency tracking
  - Automatic tool discovery via `tools/list` to each upstream
  - Configurable discovery cache TTL (default: 60s)
  - Partial discovery mode — continues if some upstreams are unreachable
  - Runtime upstream management (add, remove, enable/disable)
  - Mixed transport support (upstream servers can be HTTP)
  - Stats: requests by upstream, tool counts, error rates, health status
  - Config: `upstreams: [{ id, prefix, remoteUrl, authHeader, enabled, timeoutMs }]`

### OpenTelemetry Trace Emission
- **Zero-dependency OTLP/HTTP JSON trace export** to any OpenTelemetry collector:
  - Emits spans in standard OTLP format (`POST /v1/traces`)
  - W3C `traceparent` header parsing and propagation
  - Configurable batch export (flush interval, max batch size, max queue)
  - Resource attributes (`service.name`, `service.version`, custom)
  - Span kinds: INTERNAL, SERVER, CLIENT
  - Configurable sample rate (0.0-1.0)
  - Auth header support for collector authentication
  - Graceful shutdown with final flush
  - Stats: spans created/exported/dropped, batch counts, export errors
  - Config: `otel: { enabled, endpoint, serviceName, sampleRate, flushIntervalMs }`

### Billable Metric Expressions
- **Config-driven pricing formulas** — compute credits from request/response attributes:
  - Expression language: `input_size_kb * 2 + response_size_kb * 5`
  - Safe recursive descent parser — no code execution, only arithmetic and math functions
  - Built-in math functions: `min`, `max`, `ceil`, `floor`, `round`, `abs`, `sqrt`, `pow`
  - Auto-extracted variables: `input_size_bytes`, `input_size_kb`, `response_size_bytes`, `response_size_kb`, `duration_ms`, `duration_s`
  - Numeric tool args injected as variables; string args create `{name}_length` vars
  - Custom variable injection for external data
  - Per-metric min/max cost bounds
  - Graceful fallback to flat pricing on expression errors
  - Stats: evaluations by metric/tool, success/fallback rates, total credits computed
  - Config: `billableMetrics: [{ id, name, expression, tools, minCost, maxCost, fallbackCost }]`

### Test Coverage
- 4,438 tests across 210 test suites (102 new tests for v10.6.0 features)

## 10.5.0 (2026-02-28)

### x402 Payment Protocol Support
- **HTTP 402-based micropayments** as an alternative to API keys for tool billing:
  - x402 protocol (coinbase/x402) integration — pay per tool call with stablecoins (USDC)
  - Client flow: request without key → receives 402 + `PAYMENT-REQUIRED` header → signs payment → retries with `X-PAYMENT` header
  - Server verifies payment via external Facilitator service (Coinbase, QuickNode, etc.)
  - Zero blockchain dependencies — all verification is delegated to Facilitator
  - Ephemeral API keys created on payment verification with exact credits awarded
  - Configurable credits-per-dollar exchange rate
  - `GET /admin/x402` — view payment stats, config, and verification history
  - `POST /admin/x402` — manual payment verification, generate test requirements
  - Config: `x402: { enabled, payTo, network, asset, facilitatorUrl, creditsPerDollar }`

### OpenAPI-to-MCP Transformation (wrap-api)
- **`paygate-mcp wrap-api --openapi spec.json`** — wraps any REST API as gated MCP tools:
  - Parses OpenAPI 3.x specs → generates MCP tool definitions from operations
  - Tool naming: uses `operationId` or `{method}_{path_slug}` as fallback
  - Input schemas from path/query parameters and request body
  - HTTP proxy handler forwards MCP tool calls to upstream REST API
  - Path parameter substitution, query parameter injection, JSON body forwarding
  - Tag filtering (`--tag-filter`), tool prefix (`--prefix`), deprecated exclusion
  - Auth header forwarding for upstream API authentication
  - Full RequestHandler interface — works with all PayGate features (billing, rate limiting, analytics, etc.)
  - `--base-url` to override API server URL
  - `--dry-run` to discover tools without running

### Test Coverage
- 4,336 tests across 206 suites (60 new tests)
- New test suites: `x402.test.ts`, `openapi-to-mcp.test.ts`, `openapi-backend.test.ts`

## 10.4.0 (2026-02-28)

### Spend Caps with Auto-Suspend
- **Server-wide and per-key spend caps** to prevent runaway agent spending:
  - Server-wide daily credit cap (`serverDailyCreditCap`) across all API keys
  - Server-wide daily call cap (`serverDailyCallCap`) across all API keys
  - Per-key hourly credit and call limits (`hourlyCreditLimit`, `hourlyCallLimit`) via QuotaConfig
  - Configurable breach action: `deny` (block the call) or `suspend` (block + auto-suspend key)
  - Auto-resume: suspended keys automatically resume after configurable cooldown (`autoResumeAfterSeconds`)
  - Callbacks: `onAutoSuspend` and `onAutoResume` hooks for logging/alerting
  - `GET /admin/spend-caps` — view server stats, per-key stats, suspended key info
  - `POST /admin/spend-caps` — update config at runtime, clear auto-suspend for specific keys
  - Config: `spendCaps: { breachAction, serverDailyCreditCap, serverDailyCallCap, autoResumeAfterSeconds }`

### MCP Tasks Primitive (MCP 2025-11-25 Spec)
- **Async task lifecycle for long-running tool calls** — full implementation of the MCP Tasks specification:
  - `tasks/send` — create a task wrapping a tool call with pre-charge billing; returns task ID immediately
  - `tasks/get` — get task status, progress, and metadata
  - `tasks/result` — get task result (completed) or error (failed)
  - `tasks/list` — list tasks filtered by session, status, or API key prefix with pagination
  - `tasks/cancel` — cancel a running or pending task
  - Task states: `pending` → `running` → `completed` | `failed` | `cancelled`
  - Pre-charge billing: credits deducted at task creation, refunded on failure
  - Background execution: tool calls run asynchronously, clients poll for results
  - Auto-timeout: configurable task timeout (default 5 minutes) with automatic failure
  - Capacity management: evicts oldest completed tasks when at limit (default 10K)
  - `GET /admin/tasks` — list tasks with filters, view stats
  - `POST /admin/tasks` — cancel tasks, get stats

### OAuth Protected Resource Metadata (RFC 9728)
- **`GET /.well-known/oauth-protected-resource`** — standard endpoint for OAuth client discovery:
  - Returns `resource`, `authorization_servers`, `bearer_methods_supported`, `scopes_supported`
  - Enables automated OAuth client configuration per RFC 9728
  - Complements existing OAuth 2.1 + PKCE + Dynamic Client Registration

### Test Coverage
- 4,276 tests across 203 suites (89 new tests)
- New test suites: `spend-caps.test.ts`, `task-manager.test.ts`

## 10.3.0 (2026-02-28)

### CLI DX: Interactive Setup Wizard
- **`paygate-mcp init` — guided config file generator** with zero dependencies (Node.js readline):
  - 3 templates: filesystem server, custom stdio, remote HTTP
  - 10-step wizard: server type → command → port → pricing → rate limits → shadow mode → persistence → Stripe → webhooks → log format
  - Generates `paygate.json` with next-steps instructions
  - `--output <path>` to specify output file (default: `paygate.json`)
  - `--force` to overwrite existing files

### CLI DX: Shell Completions
- **`paygate-mcp completions <bash|zsh|fish>` — tab completion for all commands and flags**:
  - Bash: `_init_completion`-based with `compgen` for flags, file paths, and enum values
  - Zsh: `_arguments`-based with `_files` and `_describe` for rich completions
  - Fish: `complete` with `__fish_use_subcommand` and `__fish_seen_subcommand_from`
  - All commands, all flags, log levels, log formats, discovery modes, and shell names completed
  - Install instructions in generated output

### CLI DX: Machine-Readable Output
- **`--json` flag for CI/CD pipelines and automation**:
  - `paygate-mcp version --json` → `{"version":"10.3.0"}`
  - `paygate-mcp validate --config ... --json` → structured diagnostics with `valid`, `errors`, `warnings` counts
  - Consistent JSON output for programmatic consumption

### Dynamic Tool Discovery Mode
- **`--discovery dynamic` — meta-tools for context window optimization**:
  - When enabled, `tools/list` returns 3 meta-tools instead of the full backend tool list
  - `paygate_list_tools` — paginated listing with pricing, rate limits, and descriptions
  - `paygate_search_tools` — keyword search across tool names and descriptions with relevance scoring
  - `paygate_call_tool` — proxy any backend tool call through the gate
  - Reduces agent context window from N tools to 3, with on-demand discovery
  - Lazy-cached backend tool list (fetched once, reused)
  - Config: `discoveryMode: "dynamic"` or `--discovery dynamic` CLI flag
  - Env var: `PAYGATE_DISCOVERY_MODE=dynamic`

### Test Coverage
- 4,187 tests across 201 suites (40 new tests)
- New test suites: `cli-completions.test.ts`, `dynamic-discovery.test.ts`, `cli-init.test.ts`

## 10.2.0 (2026-02-28)

### Scheduled Reports
- **Automated periodic usage, billing, compliance, and security reports** — schedule daily/weekly/monthly reports delivered via webhook:
  - `GET /admin/scheduled-reports` — list schedules with stats
  - `GET /admin/scheduled-reports?scheduleId=...` — specific schedule
  - `GET /admin/scheduled-reports?name=...` — lookup by name
  - `POST /admin/scheduled-reports` — create, update, delete, generate, configure schedules
  - `DELETE /admin/scheduled-reports` — clear all schedules
  - 4 report types: usage, billing, compliance, security
  - 3 frequencies: daily, weekly, monthly
  - HMAC-SHA256 signed webhook delivery
  - Report filters by namespace, group, tools, or keys
  - Run tracking with success/failure status

### Approval Workflows
- **Pre-execution approval gates for tool calls** — define rules that require admin approval before execution:
  - `GET /admin/approval-workflows` — list rules, pending requests, stats
  - `GET /admin/approval-workflows?ruleId=...` — specific rule
  - `GET /admin/approval-workflows?requestId=...` — specific request
  - `GET /admin/approval-workflows?status=pending` — filter by status
  - `POST /admin/approval-workflows` — createRule, updateRule, deleteRule, check, decide, expirePending, configure
  - `DELETE /admin/approval-workflows` — clear all state
  - 3 conditions: cost_threshold (credit amount), tool_match (glob pattern), key_match (prefix)
  - Pending requests with configurable TTL (default 1 hour)
  - Approve/deny with reason and decidedBy tracking
  - Auto-expire stale pending requests

### Gateway Hooks
- **Pre/post request lifecycle hooks for custom logic injection** at the gateway level:
  - `GET /admin/gateway-hooks` — list hooks with stats
  - `GET /admin/gateway-hooks?hookId=...` — specific hook
  - `POST /admin/gateway-hooks` — register, update, delete, test, configure hooks
  - `DELETE /admin/gateway-hooks` — clear all hooks
  - 3 stages: pre_gate, pre_backend, post_backend
  - 4 hook types: log (metadata), header_inject (add headers), metadata_tag (add tags), reject (block request)
  - Priority-based execution order (lower = earlier)
  - Tool and key glob pattern filters
  - Test execution via admin API without real requests
  - Per-hook execution count tracking

### Stats
- **4,147 tests** across 198 test suites
- **199+ HTTP endpoints**

## 10.1.0 (2026-02-28)

### Quota Management
- **Daily/weekly/monthly hard caps per API key** — absolute call or credit ceilings distinct from rate limiting:
  - `GET /admin/quota-rules` — view all quota rules, usage, and stats
  - `GET /admin/quota-rules?ruleId=...` — specific rule with current usage
  - `GET /admin/quota-rules?apiKey=...` — all quotas for a key
  - `POST /admin/quota-rules` — create rules, check quotas, delete rules, reset usage, configure
  - `DELETE /admin/quota-rules` — clear all quota state
  - Per-key quotas with daily/weekly/monthly periods
  - Call count and credit amount metrics
  - Per-tool quotas (restrict specific tool usage per key)
  - Global default quotas (apiKey: '*') with key-specific overrides
  - Overage actions: deny (hard block), warn (allow with warning), throttle
  - Burst allowance: configurable % over limit before hard deny
  - Period-aware rollover (daily at midnight UTC, weekly at Monday 00:00 UTC, monthly at 1st)
  - Usage reporting with period boundaries
  - Admin usage reset per rule
  - Public API: `QuotaManager` class exported

### Webhook Replay (Enhanced DLQ)
- **Dead letter queue management for failed webhook deliveries** — inspect, retry, and purge failed webhooks:
  - `GET /admin/webhook-replay` — view DLQ stats and entries (filterable by status, event type)
  - `GET /admin/webhook-replay?deliveryId=...` — specific failed delivery details
  - `POST /admin/webhook-replay` — record failures, replay single/bulk, purge entries, configure
  - `DELETE /admin/webhook-replay` — clear all DLQ state
  - Failed delivery recording with URL, payload, event type, status code, error message
  - Individual replay with HTTP retry and status tracking
  - Bulk replay of all pending entries with configurable limit
  - Purge by individual ID or status (pending/succeeded/exhausted)
  - HMAC signature preservation across retries
  - Configurable max retries (default 5), request timeout (10s), max age (7 days)
  - Auto-purge of old entries beyond max age
  - Stats: total failed, pending, succeeded, exhausted, retry success rate
  - Public API: `WebhookReplayManager` class exported

### Config Profiles
- **Named configuration presets for environment switching** — save, compare, and switch between dev/staging/prod configs:
  - `GET /admin/config-profiles` — list all profiles with stats
  - `GET /admin/config-profiles?profileId=...` — specific profile with resolved config
  - `GET /admin/config-profiles?name=...` — lookup by name
  - `GET /admin/config-profiles?action=export` — export all profiles as JSON
  - `POST /admin/config-profiles` — save, activate, rollback, compare, delete, import, configure
  - `DELETE /admin/config-profiles` — clear all profile state
  - Named profiles with description and SHA-256 checksum
  - Profile inheritance: extend a base profile, child overrides parent values
  - One-click activation with automatic deactivation of previous
  - Rollback to previous profile
  - Config comparison: flat-key diff showing unchanged, changed, only-in-A, only-in-B
  - Import/export with merge or replace mode
  - Circular inheritance detection
  - Stats: total profiles, active profile, switch count, rollback availability
  - Public API: `ConfigProfileManager` class exported

## 10.0.0 (2026-02-28)

### Request Tracing
- **End-to-end request visibility with structured tracing** — trace every request through gate evaluation, backend calls, transforms, and caching:
  - `GET /admin/tracing` — view tracing stats (total, active, completed, avg/p95 duration)
  - `GET /admin/tracing?action=recent` — list recent traces
  - `GET /admin/tracing?action=slow` — list slowest requests
  - `GET /admin/tracing?action=export` — export all traces as JSON
  - `GET /admin/tracing?traceId=...` — retrieve specific trace by ID
  - `GET /admin/tracing?requestId=...` — find trace by request ID
  - `POST /admin/tracing` — configure tracing (enabled, sampleRate, maxTraces, maxAgeMs)
  - `DELETE /admin/tracing` — clear all traces
  - Span recording at key decision points (gate, backend, transform)
  - Per-trace timing breakdown: gateMs, backendMs, transformMs
  - Configurable sample rate (0.0-1.0) for production use
  - Configurable retention (max 50,000 traces, max age)
  - P95 latency and slowest trace ID tracking
  - Public API: `RequestTracer` class exported

### Budget Policy Engine
- **Burn rate monitoring with progressive throttling** — protect against runaway agents and unexpected cost explosions:
  - `GET /admin/budget-policies` — view all policies with utilization stats
  - `GET /admin/budget-policies?policyId=...` — retrieve specific policy
  - `POST /admin/budget-policies` — create policies, record spend, delete policies
  - `DELETE /admin/budget-policies` — clear all policies
  - Daily and monthly budget enforcement with automatic reset
  - Burn rate monitoring: credits/minute over configurable rolling window
  - Three burn rate actions: `alert`, `throttle`, `deny`
  - Progressive throttling with configurable cooldown period
  - Per-namespace and per-API-key policy targeting
  - Budget remaining forecast: hours until exhaustion at current rate
  - Most restrictive policy wins when multiple apply
  - Stats: daily/monthly utilization %, current burn rate, throttle events
  - Public API: `BudgetPolicyEngine` class exported

### Tool Dependency Graph
- **DAG-based workflow validation and failure propagation** — model dependencies between MCP tools for multi-step agent workflows:
  - `GET /admin/tool-deps` — view dependency graph stats and registered deps
  - `GET /admin/tool-deps?action=sort` — topological sort of all tools
  - `GET /admin/tool-deps?action=validate` — detect cycles in the graph
  - `GET /admin/tool-deps?action=dependents&tool=X` — downstream impact analysis
  - `GET /admin/tool-deps?action=prerequisites&tool=X` — upstream prerequisites
  - `GET /admin/tool-deps?action=workflow&workflowId=...` — workflow execution history
  - `POST /admin/tool-deps` — register/unregister deps, check/record execution, start workflows, configure
  - `DELETE /admin/tool-deps` — clear all state
  - Hard vs soft dependency enforcement
  - Failure propagation: if A fails, B/C/D are automatically blocked
  - Cycle detection via Kahn's algorithm
  - Per-workflow execution tracking with automatic expiry
  - Group-scoped dependency graphs
  - Public API: `ToolDependencyGraph` class exported

## 9.9.0 (2026-02-28)

### IP Access Control
- **Fine-grained IP-based access control with CIDR notation** — global allow/deny lists, per-key IP binding, and automatic blocking:
  - `GET /admin/ip-access` — view IP access stats and blocked IPs
  - `POST /admin/ip-access` — configure allow/deny lists, bind keys to IPs, block/unblock IPs
  - `DELETE /admin/ip-access` — clear all IP rules and blocks
  - CIDR notation support (e.g., `10.0.0.0/8`, `192.168.1.0/24`)
  - Per-key IP binding: restrict API keys to specific IPs/CIDRs
  - Auto-blocking: configurable threshold for automatic IP blocking after repeated violations
  - X-Forwarded-For and X-Real-IP header support with configurable trusted proxy depth
  - IPv6-mapped IPv4 normalization (`::ffff:` prefix stripping)
  - Deny list takes precedence over allow list
  - Stats: total checks, blocked, allowed, auto-blocked IPs, per-key bindings
  - Public API: `IpAccessController` class exported

### Request Signing (HMAC-SHA256)
- **Cryptographic request authentication with replay protection** — prevents tampering and replay attacks via HMAC-SHA256 signatures:
  - `GET /admin/signing` — view signing stats (verified, failed, replayed, expired)
  - `POST /admin/signing` — register/rotate signing secrets, configure signing
  - `DELETE /admin/signing` — clear all signing secrets
  - Signature header format: `X-Signature: t=<unix-ms>,n=<nonce>,s=<hex-signature>`
  - Canonical signing payload: `<timestamp>.<nonce>.<METHOD>.<path>.<body-sha256>`
  - Timestamp-based replay protection (configurable tolerance, default 5 min)
  - Nonce tracking to prevent exact replay within dedup window
  - Per-key signing secrets (separate from API key)
  - Key rotation without downtime
  - Timing-safe signature comparison (prevents timing attacks)
  - Stats: verified, failed, replayed, expired, nonces cached
  - Public API: `RequestSigner` class exported

### Multi-Tenant Isolation
- **Full tenant isolation for platform operators** — isolated rate limits, credit pools, usage tracking, and data boundaries per tenant:
  - `GET /admin/tenants` — list tenants with stats; `GET /admin/tenants?id=<id>` — tenant usage report
  - `POST /admin/tenants` — create/update tenants, bind keys, manage credits, suspend/activate
  - `DELETE /admin/tenants` — delete specific tenant or clear all
  - Tenant CRUD with metadata (create, read, update, delete)
  - API key → tenant binding (keys belong to exactly one tenant)
  - Per-tenant rate limit overrides (independent of global limits)
  - Per-tenant credit pools (isolated balances, allocation tracking)
  - Tenant suspension: all keys under a suspended tenant are denied
  - Per-tenant usage tracking: calls, credits consumed, credit allocation history
  - Cross-tenant queries for platform operators
  - Configurable limits: max tenants (10,000), max keys per tenant (1,000)
  - Stats: total tenants, active/suspended, total keys, total credits, total calls
  - Public API: `TenantManager` class exported

## 9.8.0 (2026-02-28)

### Request Deduplication (Idempotency Layer)
- **Prevents duplicate billing from agent retries** — clients send `X-Idempotency-Key` header or proxy auto-generates one via SHA-256 of apiKey + tool + sorted args:
  - `GET /admin/dedup` — view dedup stats (cached entries, credits saved, hit rate)
  - `POST /admin/dedup` — configure dedup TTL, max entries, auto-generation
  - `DELETE /admin/dedup` — clear dedup cache
  - In-flight request coalescing: concurrent duplicate requests share the first result
  - Configurable TTL window (default 60s) for completed request cache
  - LRU eviction at capacity (default 10,000 entries)
  - Errors are not cached — retries of failed requests go through
  - Stats: total deduped, total coalesced, credits saved, hit rate
  - Public API: `RequestDeduplicator` class exported

### Request Priority Queue
- **Tiered request prioritization with fair scheduling** — higher-priority keys are processed first when the system is under contention:
  - `GET /admin/priority-queue` — view queue stats (depth per tier, wait times, promotions)
  - `POST /admin/priority-queue` — configure queue or assign key priority tier
  - Five priority tiers: critical (bypasses queue), high, normal (default), low, background
  - Per-key priority assignment via admin endpoint or key group inheritance
  - Configurable max wait time per tier (critical=1s, high=5s, normal=15s, low=30s, background=60s)
  - Starvation prevention: automatic promotion after aging threshold
  - Max queue depth (default 1,000) with per-tier breakdown
  - Stats: total enqueued, processed, timed out, promoted, average wait time
  - Public API: `PriorityQueue` class exported

### Cost Allocation Tags with Chargeback Reporting
- **Per-request cost attribution for enterprise chargeback** — clients attach tags via `X-Cost-Tags` header (JSON) for fine-grained cost tracking:
  - `GET /admin/cost-tags` — view cost tag stats (unique keys, values per key, credits tracked)
  - `GET /admin/cost-tags?dimension=project` — generate chargeback report grouped by tag dimension
  - `GET /admin/cost-tags?dimension=project&dim2=dept` — cross-tabulation report (two dimensions)
  - `GET /admin/cost-tags?dimension=project&format=csv` — CSV export for billing/ERP integration
  - `POST /admin/cost-tags` — configure limits or set required tags per API key
  - `DELETE /admin/cost-tags` — clear recorded entries
  - Tag validation: max 10 tags/request, 64-char keys/values, alphanumeric + `-_:.` pattern
  - Cardinality limits: max 1,000 unique keys, 10,000 values per key
  - Required tag enforcement: keys with `requiredTags` must include specified tags
  - Public API: `CostAllocator` class exported

## 9.7.0 (2026-02-28)

### Request/Response Transform Pipeline
- **Declarative rewriting of tool call arguments and responses** — inject defaults, strip fields, rename keys, and template values without touching server code:
  - `POST /admin/transforms` — create transform rules with ordered operations
  - `GET /admin/transforms` — list all rules with applied/error counts
  - `PUT /admin/transforms` — update rule priority, enabled status, or description
  - `DELETE /admin/transforms` — remove rule by ID
  - Four operations: `set` (inject value at dotted path), `remove` (strip key), `rename` (move key), `template` (interpolate `{{variables}}` from context)
  - Wildcard tool matching (`*`) for global transforms
  - Priority ordering (lower = earlier) for deterministic rule execution
  - Deep clone on apply — input data never mutated
  - Import/export for backup and restore
  - Max 200 rules per instance
  - Public API: `TransformPipeline` class exported

### Backend Retry Policy
- **Automatic retry with exponential backoff** — prevents credits being charged for transient failures:
  - `GET /admin/retry-policy` — view retry config and stats
  - `POST /admin/retry-policy` — update retry configuration at runtime
  - Configurable max retries (default 3), base backoff (200ms), max backoff (5s)
  - Full jitter option for thundering-herd prevention
  - Retry budget: max percentage of recent traffic as retries (default 20%) with cold-start grace period
  - Configurable retryable error patterns: JSON-RPC codes (`-32603`, `-32004`) and string patterns (`ETIMEDOUT`, `ECONNRESET`)
  - Per-tool stats: attempts, successes-after-retry, exhausted counts
  - Sliding 60-second window for budget calculation
  - Public API: `RetryPolicy` class exported

### Adaptive Rate Limiting
- **Dynamic rate adjustment based on key behavior** — tightens for abusers, boosts for good actors:
  - `GET /admin/adaptive-rates` — view adaptive rate stats per key
  - `POST /admin/adaptive-rates` — enable/disable adaptive rates and configure thresholds
  - Behavior tracking: success rate, denial count, error rate per key
  - Auto-tighten: keys with >30% error rate get reduced limits (down to configurable minimum)
  - Auto-boost: keys with <5% error rate and 0 denials get increased limits (up to configurable maximum)
  - Cooldown period prevents rapid oscillation (default 60s)
  - `evaluateAll()` for periodic batch assessment
  - Max 5,000 tracked keys with LRU eviction
  - Per-key reset and global clear
  - Public API: `AdaptiveRateLimiter` class exported

## 9.6.0 (2026-02-28)

### Usage Plans
- **Tiered key policies (free/pro/enterprise)** — bundle rate limits, quotas, pricing, and tool ACL into reusable templates:
  - `POST /admin/plans` — create named plans with rate limits, call/credit limits, credit multipliers, tool whitelists/blacklists, and concurrency caps
  - `GET /admin/plans` — list all plans with assigned key counts
  - `DELETE /admin/plans?name=` — delete plan (fails if keys still assigned)
  - `POST /admin/keys/plan` — assign/unassign key to a plan
  - Plan-level tool ACL: denied tools take precedence, then allowed tools whitelist
  - Credit multiplier: keys on a plan get automatic credit scaling (e.g. 0.5 = half price)
  - Import/export for backup and restore
  - Error code `-32403` when plan denies tool access
  - Public API: `UsagePlanManager` class exported

### Tool Input Schema Validation
- **Per-tool JSON Schema validation at the gateway** — reject invalid payloads before they reach downstream:
  - `POST /admin/tools/schema` — register JSON Schema for any tool
  - `GET /admin/tools/schema` — list registered schemas with validation stats
  - `DELETE /admin/tools/schema?tool=` — remove schema
  - Zero-dependency JSON Schema subset validator supporting: type, required, properties, enum, minLength, maxLength, minimum, maximum, pattern, items, minItems, maxItems
  - Nested object and array validation with path-aware error reporting
  - Validation stats: total validations, total failures, per-schema timestamps
  - Error code `-32602` (Invalid params) with detailed error list in `data.errors`
  - Public API: `ToolSchemaValidator` class exported

### Canary Routing
- **Weighted traffic splitting** between primary and canary MCP servers for zero-downtime upgrades:
  - `POST /admin/canary` — enable canary with server command, args, and weight (0-100%)
  - `POST /admin/canary` (weight only) — update weight without restart when already enabled
  - `DELETE /admin/canary` — disable canary, route all traffic to primary
  - `GET /admin/canary` — view canary stats (enabled, weight, call counts, error rates)
  - Uses `crypto.randomInt` for unbiased routing decisions
  - Per-backend call and error tracking for monitoring rollout health
  - EventEmitter: subscribe to `enabled`, `disabled`, `weight-changed` events
  - Public API: `CanaryRouter` class exported

## 9.5.0 (2026-02-28)

### Concurrency Limiter
- **Per-key and per-tool inflight request caps** — distinct from rate limiting (calls/time), this limits simultaneous active requests:
  - `maxConcurrentPerKey`: max concurrent in-flight requests per API key (0 = unlimited)
  - `maxConcurrentPerTool`: max concurrent in-flight requests per tool (0 = unlimited)
  - Error code `-32005` with `Retry-After: 1` header when at capacity
  - `GET /admin/concurrency` — view inflight counts per key/tool + current limits
  - `POST /admin/concurrency` — update limits at runtime
  - Acquire/release pattern with try/finally — slots always released even on errors
  - Public API: `ConcurrencyLimiter` class exported

### Traffic Mirroring
- **Fire-and-forget request duplication** to a shadow backend for A/B testing MCP server versions:
  - Duplicates tool call requests to a configurable mirror URL (Streamable HTTP)
  - Percentage-based sampling (0-100%) for gradual rollout
  - Mirror response logged but never returned to client — zero impact on primary path
  - `GET /admin/mirror` — view mirror stats (success/error counts, avg latency, recent results)
  - `POST /admin/mirror` — configure mirror URL, percentage, and timeout
  - `DELETE /admin/mirror` — disable mirroring
  - EventEmitter-based: subscribe to `mirror-result` events for custom handling
  - Public API: `TrafficMirror` class exported

### Tool Aliasing + Deprecation
- **Tool renaming with RFC 8594 deprecation notices** for smooth API evolution:
  - Map old tool names to new ones — requests transparently routed to target
  - `Deprecation: true` header on aliased responses (RFC 8594)
  - `Sunset` header with HTTP-date when sunset date is set (RFC 8594)
  - `Link: </tools/new_name>; rel="successor-version"` header
  - Chain prevention: A→B→C alias chains rejected
  - `GET /admin/tool-aliases` — list aliases with per-alias call counts
  - `POST /admin/tool-aliases` — add/update alias with optional sunsetDate and message
  - `DELETE /admin/tool-aliases?from=` — remove an alias
  - Import/export support for alias persistence
  - Public API: `ToolAliasManager` class exported

## 9.4.0 (2026-02-28)

### Content Guardrails (PII Detection & Redaction)
- **Regex-based content scanning** for tool call inputs and outputs:
  - 8 built-in rules: credit card, SSN, email, phone, AWS access key, API secret, IBAN, passport
  - 4 configurable actions per rule: `log`, `warn`, `block`, `redact`
  - Scope filtering: scan `input`, `output`, or `both`
  - Per-tool filtering: apply rules only to specific tools
  - Violation tracking with queryable history
  - `GET /admin/guardrails` — view rules, stats, and enabled state
  - `POST /admin/guardrails` — toggle enabled state, upsert rules, import rule sets
  - `DELETE /admin/guardrails?id=` — remove a rule
  - `GET /admin/guardrails/violations` — query violations with ruleId/tool filters
  - `DELETE /admin/guardrails/violations` — clear violation history
  - Input violations block with error code `-32406`
  - Output violations block or redact depending on rule action
  - Public API: `ContentGuardrails` class, `BUILT_IN_RULES` array exported

### IP Country Restrictions (Geo-Fencing)
- **Per-key country allow/deny lists** for geographic access control:
  - `allowedCountries`: only these country codes can use the key (ISO 3166-1 alpha-2)
  - `deniedCountries`: these country codes are blocked
  - Country code extracted from reverse-proxy headers (`X-Country`, `CF-IPCountry`, configurable)
  - `POST /keys/geo` — set allowed/denied countries for a key
  - `GET /keys/geo?key=` — view current restrictions
  - `DELETE /keys/geo?key=` — clear all restrictions
  - ISO 3166-1 alpha-2 validation on all country codes
  - Configurable header via `geoCountryHeader` config option
  - Enforced in gate evaluation between IP allowlist and tool ACL checks

### Bulk Key Operations (Suspend/Resume)
- Added `suspend` and `resume` actions to `POST /keys/bulk`:
  - Bulk suspend: temporarily disable multiple keys in one request
  - Bulk resume: re-activate multiple suspended keys
  - Per-operation error handling with index tracking
  - Already-suspended/already-active keys handled gracefully
  - Audit logging for each operation

### Tests
- 52 new tests: content guardrails unit (21), guardrails integration (10), geo-fencing (12), bulk suspend/resume (6), root listing (3)
- Total: 3,686+ tests across 190 suites

## 9.3.0 (2026-02-28)

### Outcome-Based Pricing
- **Output surcharge (`creditsPerKbOutput`)**: Charge extra credits based on response size
  - Post-response billing: credits deducted after tool call completes based on output size in KB
  - Per-tool configuration via `toolPricing[tool].creditsPerKbOutput` (credits per KB)
  - `X-Output-Surcharge` header on every tool call response showing surcharge amount
  - Complements existing `creditsPerKbInput` for complete size-based pricing
  - Graceful degradation: charges available credits if balance insufficient for full surcharge

### Compliance Audit Export
- **Framework-specific compliance reports** (`GET /admin/compliance/export`):
  - SOC 2 report sections: CC6.1 (Logical Access Controls), CC7.2 (System Operations Monitoring), CC8.1 (Change Management), CC6.8 (Security Incident Detection)
  - GDPR report sections: Article 25 (Data Protection by Design), Article 30 (Records of Processing Activities), Article 32 (Security of Processing), Article 33 (Notification of Data Breaches)
  - HIPAA report sections: §164.312(a) (Access Control), §164.312(b) (Audit Controls), §164.312(e) (Transmission Security), §164.308(a)(6) (Security Incident Procedures)
  - Event classification into access control, data processing, config changes, and security categories
  - Severity levels: info, warning, critical per event type
  - Export as JSON or CSV format with Content-Disposition headers for download
  - Summary statistics: auth failures, keys created/revoked/suspended, unique actors
  - Configurable time period with `since` and `until` query parameters
  - Public API: `generateComplianceReport()` and `complianceReportToCsv()` exported

### Per-Key Webhook URLs
- **Key-level webhook routing** (`POST/GET/DELETE /keys/webhook`):
  - Set per-key webhook URL: events for that specific key are also sent to key's webhook
  - SSRF protection: all per-key webhook URLs validated against private IP ranges
  - HMAC-SHA256 signing with per-key webhook secret
  - Lazy emitter creation: WebhookEmitter instances created on first use, cached, destroyed on removal
  - Admin events (key.created, key.revoked, etc.) also routed to key-specific webhooks
  - GET: Check if a key has a webhook configured
  - DELETE: Remove per-key webhook URL and destroy cached emitter
  - Complements global webhook and webhook filter rules

### Tests
- 44 new tests across 5 test suites: compliance report unit tests (17), outcome-based pricing integration (4), compliance export endpoint integration (9), per-key webhook integration (12), root listing (2)
- Total: 3,634+ tests across 189 suites

## 9.2.0 (2026-02-28)

### Response Caching
- **SHA-256 keyed response cache**: Identical tool calls return cached responses, skipping backend invocation and credit deduction
  - Cache key = `SHA-256(toolName + sorted JSON args)` — deterministic, order-independent
  - LRU eviction when `maxCacheEntries` reached (default: 10,000)
  - `X-Cache: HIT/MISS` header on every tool call response
  - Per-tool TTL override via `toolPricing[tool].cacheTtlSeconds`
  - Global TTL via `cacheTtlSeconds` config option
  - Cache hits bypass both credit deduction and circuit breaker
- **Admin cache management** (`GET/DELETE /admin/cache`):
  - GET: Cache stats (entries, hits, misses, hit rate, per-tool breakdown, evictions)
  - DELETE: Clear all entries or filter by `?tool=` query param
  - Prometheus gauge: `paygate_cache_entries`

### Circuit Breaker
- **Three-state circuit breaker** for backend failure detection and fast-fail:
  - CLOSED → OPEN after N consecutive backend failures (`circuitBreakerThreshold`)
  - OPEN → HALF_OPEN after cooldown expires (`circuitBreakerCooldownSeconds`)
  - HALF_OPEN → CLOSED on probe success, OPEN on probe failure
  - Open circuit returns error code `-32003` (`circuit_breaker_open`)
  - Tracks: consecutive failures, total failures/successes/rejections, timestamps
- **Admin circuit management** (`GET/POST /admin/circuit`):
  - GET: Current state, failure counts, timestamps
  - POST: Manual reset to closed state
  - Audit trail for manual resets

### Configurable Timeouts
- **Per-tool call timeouts** via `toolPricing[tool].timeoutMs`
- **Global timeout** via `toolTimeoutMs` config option (per-tool overrides global)
- Timeout returns error code `-32004` (`tool_timeout`) with tool name and duration
- Timed-out calls trigger circuit breaker failure recording

### Infrastructure
- All new endpoints in OpenAPI 3.1 spec and root listing
- 53 new tests (188 suites, 3,590 tests total)
- Exported: `ResponseCache`, `CacheEntry`, `CacheStats`, `CircuitBreaker`, `CircuitBreakerConfig`, `CircuitState`, `CircuitStatus`

## 9.1.0 (2026-02-28)

### Self-Service Key Rotation
- **Portal key rotation** (`POST /portal/rotate`): API key holders can rotate their own keys
  - Old key is permanently revoked, new key inherits all config (credits, ACL, quotas, tags, IP)
  - Rate limited to once per 5 minutes per key name (survives across rotations)
  - Rotation modal in portal with copy-to-clipboard and forced re-login
  - Audit trail with `source: 'portal'` flag
  - Self-service alerts automatically migrate to the new key

### Credit History for Key Holders
- **Credit mutation history** (`GET /balance/history`): Key holders can view their credit history
  - Shows all credit events: initial allocation, topups, deductions, transfers, refunds, auto-topups
  - Spending velocity data: credits/hour, credits/day, calls/day, depletion forecast
  - Query params: `?type=`, `?limit=`, `?since=` for filtering
  - Visual history panel in portal with color-coded entries and velocity bar

### Self-Service Usage Alerts
- **Usage alert configuration** (`GET/POST/DELETE /balance/alerts`): Key holders set low-credit alerts
  - Configurable credit threshold (0-1,000,000)
  - Optional HTTPS webhook URL for alert delivery
  - Enable/disable without losing config
  - Visual alert indicator in portal when credits drop below threshold
  - Capped at 10,000 alert configs to prevent memory abuse

### Portal Enhancements
- Action buttons bar: Credit History, Usage Alerts, Rotate Key
- Credit history panel with spending velocity metrics and color-coded entries
- Alert configuration panel with threshold input and save/disable buttons
- Key rotation modal with confirmation, new key display, and copy-to-clipboard
- All portal UI built with safe DOM methods (XSS-safe)

### Infrastructure
- All new endpoints in OpenAPI 3.1 spec and root listing
- 27 new tests (186 suites, 3,521 tests total)

## 9.0.0 (2026-02-27)

### Stripe Checkout — Self-Service Credit Purchases
- **Stripe Checkout Sessions** (`POST /stripe/checkout`): API key holders can purchase credits via Stripe
  - Configurable credit packages with id, credits, price, currency, name, description
  - Creates Stripe Checkout Sessions with PayGate metadata for auto-top-up
  - After payment, existing `StripeWebhookHandler` automatically tops up credits
  - Zero dependencies — uses Node.js built-in `https` module
- **Credit packages listing** (`GET /stripe/packages`): Public endpoint to list available packages
  - Returns `configured: false` with empty packages when Stripe not configured
  - Rate-limited via public endpoint rate limiter
- **Portal Buy Credits UI**: Self-service portal now includes Buy Credits bar
  - Fetches available packages, renders purchase buttons with price/credits
  - Redirects to Stripe Checkout on purchase — credits added automatically
- **New module**: `StripeCheckout` class exported from `paygate-mcp`
  - `listPackages()`, `getPackage()`, `createSession()`, `getSession()`
  - Full TypeScript types: `CreditPackage`, `StripeCheckoutConfig`, `CheckoutSessionResult`

### State Backup & Restore — Disaster Recovery
- **Full state backup** (`GET /admin/backup`): Export complete server state as JSON snapshot
  - Includes keys, teams, groups, webhook filters, and aggregate stats
  - SHA-256 checksum for integrity verification
  - `Content-Disposition: attachment` header for direct download
  - Versioned snapshot format (v1.0) for forward compatibility
- **State restore** (`POST /admin/restore`): Import state from a backup snapshot
  - Three restore modes: `full` (replace), `merge` (additive), `overwrite` (merge + overwrite)
  - Checksum validation before restore — rejects corrupted snapshots
  - Per-entity import results (imported, skipped, errors)
- **New module**: `BackupManager` class exported from `paygate-mcp`
  - `createSnapshot()`, `validateSnapshot()`, `restoreFromSnapshot()`
  - `BackupStateProvider` adapter interface for clean separation

### API Version Header
- **`X-PayGate-Version` header**: Included on every HTTP response
  - Version read from package.json at runtime — no hardcoded strings
  - Exposed in `Access-Control-Expose-Headers` for browser access
  - Present on health, ready, admin, CORS preflight, and all other endpoints

### Infrastructure
- New audit event types: `stripe.checkout_created`, `admin.backup_created`, `admin.backup_restored`
- All new endpoints in OpenAPI 3.1 spec, root listing, and robots.txt
- Root listing includes `stripeCheckout` flag indicating Stripe configuration status
- 34 new tests (185 suites, 3,494 tests total)

## 8.99.0 (2026-02-27)

### Admin Dashboard v2
- **Tabbed admin dashboard** (`GET /dashboard`): Complete rewrite with 4-tab interface
  - **Overview tab**: Stat cards (keys, calls, credits, denials, uptime), top tools chart, recent activity feed, notification alerts
  - **Keys tab**: Full key management table with search/filter, create key modal (name, credits, namespace, rate limit), suspend/resume/revoke actions, top-up modal
  - **Analytics tab**: Credit flow visualization, deny reason breakdown, top consumer chart, webhook delivery stats
  - **System tab**: Version, in-flight requests, backend status, maintenance toggle, CSV export (keys + audit)
  - All data rendered via safe DOM methods (XSS-safe), 30s auto-refresh

### Self-Service Portal
- **API key portal** (`GET /portal`): Browser UI for API key holders to check their own status
  - Credit balance with progress bar and low/exhausted alerts
  - Usage stats (calls, credits spent, denied calls)
  - Key details (name, prefix, status, expiry, rate limit, namespace)
  - Available tools listing
  - Recent activity feed
  - Auth via X-API-Key prompt — no admin key needed

### Readiness Probe
- **Kubernetes readiness probe** (`GET /ready`): Returns 200 when server can accept traffic, 503 when not
  - Checks: not draining, not in maintenance, MCP backend connected
  - Separate from `/health` (liveness probe) — `/ready` reflects operational state
  - JSON response with per-check breakdown and timestamp
  - HEAD method support for lightweight probes

### Infrastructure
- New endpoints in OpenAPI 3.1 spec, root listing, and robots.txt
- 22 new tests (184 suites, 3,460 tests total)

## 8.98.0 (2026-02-27)

### Public Endpoint Hardening
- **Public endpoint rate limiting**: Configurable per-IP rate limit on all public endpoints
  - `/health`, `/info`, `/pricing`, `/openapi.json`, `/docs`, `/.well-known/*`, `/robots.txt`, `/`
  - Default: 300 requests/min per IP (configurable via `publicRateLimit`, 0 = unlimited)
  - Returns 429 with `Retry-After` header when limit is exceeded
  - Separate from admin rate limiter — admin endpoints unaffected
  - DDoS and scrape protection for discovery endpoints
- **`/robots.txt` handler**: Standard crawler directives
  - Allows public discovery endpoints (`/health`, `/info`, `/pricing`, `/openapi.json`, `/docs`, `/.well-known/`)
  - Disallows admin, key, webhook, OAuth, config, stripe, and metrics paths
  - Improves SEO discoverability and prevents crawler abuse
- **HEAD method support**: All public GET endpoints respond to HEAD requests
  - Returns 200 with empty body (no rate limit consumed)
  - Supports uptime monitoring tools (Pingdom, UptimeRobot, etc.)
  - CORS `Access-Control-Allow-Methods` updated to include `HEAD`
- **Flaky CI test fix**: Stabilized `resource-cleanup.test.ts` with retry logic
  - Both v8.96.0 and v8.97.0 failed to publish due to transient ECONNRESET in CI
  - Added 100ms delay + retry with 200ms backoff for oversized body rejection test

### Stats
- 3,438 tests across 183 suites (24 new tests)

## 8.97.0 (2026-02-27)

### Developer Experience & Discovery
- **OpenAPI 3.1 spec** (`GET /openapi.json`): Auto-generated spec covering all 130+ endpoints
  - 13 tags: Core, Keys, Billing, Discovery, OAuth, Webhooks, Analytics, Teams, Tokens, Groups, Admin, Operations, Audit
  - 8 component schemas: JsonRpcRequest, JsonRpcResponse, JsonRpcError, ApiKey, ToolPricing, PaymentMetadata, x402Block, Error
  - 3 security schemes: ApiKeyAuth (X-API-Key), AdminKeyAuth (X-Admin-Key), BearerAuth (OAuth)
  - Programmatically generated — always in sync with server version
  - Cacheable (1-hour public cache)
- **Interactive API docs** (`GET /docs`): Swagger UI loaded from CDN
  - Dark topbar with PayGate branding, accent colors per HTTP method
  - Filter, deep linking, model expansion — zero bundled dependencies
  - No authentication required
- **MCP Server Identity** (`GET /.well-known/mcp.json`): Machine-readable server identity card
  - Protocol, transport, capabilities (tools, tasks, elicitation)
  - Payment metadata: model, currency, free tool count, x402 compatibility
  - Auth methods: API key, OAuth 2.1 (conditional)
  - Endpoint map: all major URLs for agent discovery
  - Links: homepage, repository, npm
  - Enables agent registries and automated MCP server cataloging

### Stats
- 3,414 tests across 182 suites (49 new tests)

## 8.96.0 (2026-02-27)

### Protocol & Competitive Alignment
- **OAuth `client_credentials` grant (M2M)**: Machine-to-machine authentication without user interaction
  - Confidential clients authenticate with `client_id` + `client_secret`
  - Issues access tokens directly (no auth code flow, no refresh token per OAuth 2.1)
  - Validates client secret, grant type authorization, and linked API key
  - Metadata endpoint includes `client_credentials` in `grant_types_supported`
- **Free tool flag in pricing discovery**: `isFree: true/false` in `_pricing` metadata for each tool
  - Agents can identify zero-cost tools before calling them, skipping payment flows
  - `freeToolCount` added to `/.well-known/mcp-payment` server metadata
- **x402-compatible payment recovery data**: All `-32402` errors now include `x402` block
  - `version`, `scheme`, `creditsRequired`, `creditsAvailable`, `topUpUrl`, `pricingUrl`, `accepts`
  - Enables cross-protocol interop with x402 payment agents
  - `x402Compatible: true` added to server metadata
  - Fixed http-proxy error code from -32000 to -32402 for consistency
- **MCP 2025-11-25 Tasks support**: `tasks/list`, `tasks/get`, `tasks/cancel` added to default free methods
  - `elicitation/create` also added as free (agent asks user for input)
  - New `billTaskCreation` config option: when `true`, `tasks/send` requires payment
- **One-click deploy**: Railway (`railway.json`), Render (`render.yaml`), and Fly.io templates added
  - Deploy buttons in README for instant cloud deployment

### Stats
- 3,365 tests across 181 suites (29 new tests)

## 8.95.0 (2026-02-27)

### Output & Config Hardening
- **Metrics cardinality cap**: Each metric now limited to 10,000 unique label-set entries
  - Prevents unbounded memory growth from high-cardinality labels (e.g., unique request IDs)
  - Existing entries can still be updated; new entries silently dropped once cap is reached
- **Metrics output size cap**: `serialize()` output capped at 5 MB
  - Prevents OOM from gigantic /metrics responses when scraping
  - Output truncated cleanly at metric boundaries
- **HTTP header injection prevention**: Custom response headers validated at config time
  - Rejects header names that don't conform to RFC 7230 token rules
  - Strips values containing CR, LF, or NUL bytes (prevents CRLF injection / response splitting)
  - Header values capped at 8 KB to prevent memory abuse
- **OAuth state parameter sanitization**: Validate and sanitize the `state` param in authorization redirects
  - Cap length to 512 characters (prevents URL bloat)
  - Strip control characters (0x00-0x1F, 0x7F) to prevent injection
  - `error_description` in redirect URLs capped at 256 characters
- **Request log string truncation**: Tool names, deny reasons, and request IDs capped at 200 characters in the request log ring buffer
  - Prevents memory bloat from crafted oversized tool names or denial reasons
- 13 new tests covering cardinality caps, header injection, OAuth state sanitization, and log truncation

---

## 8.94.0 (2026-02-27)

### Delivery & Request Hardening
- **Content-Length pre-check**: `readBody()` now rejects requests early if `Content-Length` exceeds the 1MB body limit
  - Returns 413 Payload Too Large before reading any body data
  - Prevents memory exhaustion from multi-GB declared Content-Length headers
- **DNS rebinding SSRF prevention**: Webhook delivery now re-validates the destination URL against private/reserved IP ranges at send time
  - Defense-in-depth against DNS rebinding attacks where a hostname passes creation-time validation but later resolves to a private IP
  - Configurable via `webhookSsrfAtDelivery` config option (default: `true`); disable for dev/test environments with localhost webhooks
  - Blocked deliveries are dead-lettered with clear error messages
- **Webhook socket-level idle timeout**: Added 5-second socket idle timeout on webhook delivery requests
  - Prevents slow-loris attacks where the receiver accepts connections but drips data byte-by-byte
  - Separate from the 10-second request-level timeout — targets socket-layer stalls
- **Audit metadata size cap**: Audit log entries now cap metadata at 10KB and messages at 2000 characters
  - Prevents memory exhaustion from tools returning massive metadata objects
  - Oversized metadata replaced with `{ _truncated: true, _originalSize: N }`
  - Non-serializable metadata safely handled with `{ _error: 'Metadata not serializable' }`
- 10 new tests covering Content-Length pre-check, audit caps, delivery-time SSRF, and socket timeout

---

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
