/**
 * k6 Load Test for PayGate MCP
 *
 * Prerequisites:
 *   brew install k6          # macOS
 *   # or: https://k6.io/docs/getting-started/installation
 *
 * Start server:
 *   npx paygate-mcp wrap -- echo '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ok"}]}}' \
 *     --port 3000 --credits-per-call 1
 *
 * Run load test:
 *   k6 run load-test.js                          # default (50 VUs, 30s)
 *   k6 run --vus 100 --duration 60s load-test.js # custom
 *   K6_PAYGATE_URL=http://prod:3000 k6 run load-test.js  # remote
 *
 * Stages (default scenario):
 *   1. Ramp up to 50 VUs over 10s
 *   2. Sustain 50 VUs for 30s
 *   3. Ramp down over 5s
 *
 * Thresholds:
 *   - p(95) response time < 200ms
 *   - p(99) response time < 500ms
 *   - Error rate < 5%
 *   - Requests/sec > 100
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = __ENV.K6_PAYGATE_URL || 'http://localhost:3000';
const ADMIN_KEY = __ENV.K6_ADMIN_KEY || ''; // auto-detected from /status if empty

// Custom metrics
const errorRate = new Rate('paygate_errors');
const mcpLatency = new Trend('paygate_mcp_latency', true);
const adminLatency = new Trend('paygate_admin_latency', true);

// ─── Options ─────────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    // Main MCP traffic (simulates agent tool calls)
    mcp_traffic: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 50 },
        { duration: '30s', target: 50 },
        { duration: '5s', target: 0 },
      ],
      exec: 'mcpToolCall',
    },
    // Admin reads (dashboards, monitoring)
    admin_reads: {
      executor: 'constant-vus',
      vus: 5,
      duration: '45s',
      exec: 'adminEndpoints',
    },
    // Health checks (load balancer probes)
    health_checks: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '45s',
      preAllocatedVUs: 5,
      exec: 'healthCheck',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<200', 'p(99)<500'],
    paygate_errors: ['rate<0.05'],
    paygate_mcp_latency: ['p(95)<150'],
    paygate_admin_latency: ['p(95)<300'],
    http_reqs: ['rate>100'],
  },
};

// ─── Setup ───────────────────────────────────────────────────────────────────

let adminKey = ADMIN_KEY;
const apiKeys = [];

export function setup() {
  // Discover admin key from startup output if not provided
  if (!adminKey) {
    console.log('⚠️  No K6_ADMIN_KEY set — admin endpoints will be skipped.');
    console.log('   Set K6_ADMIN_KEY=<your-key> or pass via env.');
    return { adminKey: '', apiKeys: [] };
  }

  // Create test API keys with plenty of credits
  const keys = [];
  for (let i = 0; i < 10; i++) {
    const res = http.post(
      `${BASE_URL}/keys`,
      JSON.stringify({
        credits: 100000,
        name: `k6-loadtest-${i}`,
        namespace: 'loadtest',
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': adminKey,
        },
      }
    );
    if (res.status === 201) {
      const body = JSON.parse(res.body);
      keys.push(body.key);
    }
  }

  console.log(`✅ Created ${keys.length} test API keys`);
  return { adminKey, apiKeys: keys };
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

/**
 * Simulates MCP tool calls — the primary hot path.
 * Sends JSON-RPC tools/call requests via POST /mcp.
 */
export function mcpToolCall(data) {
  if (data.apiKeys.length === 0) {
    sleep(1);
    return;
  }

  const key = data.apiKeys[Math.floor(Math.random() * data.apiKeys.length)];
  const toolNames = ['echo', 'search', 'analyze', 'generate', 'summarize'];
  const tool = toolNames[Math.floor(Math.random() * toolNames.length)];

  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: {
      name: tool,
      arguments: { input: `load-test-${__VU}-${__ITER}` },
    },
  });

  const res = http.post(`${BASE_URL}/mcp`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': key,
    },
    tags: { endpoint: 'mcp' },
  });

  mcpLatency.add(res.timings.duration);

  const ok = check(res, {
    'mcp status 200': (r) => r.status === 200,
    'mcp has jsonrpc': (r) => {
      try {
        return JSON.parse(r.body).jsonrpc === '2.0';
      } catch {
        return false;
      }
    },
  });

  errorRate.add(!ok);
  sleep(0.1);
}

/**
 * Simulates admin dashboard reads — /status, /keys, analytics.
 */
export function adminEndpoints(data) {
  if (!data.adminKey) {
    sleep(1);
    return;
  }

  const headers = { 'X-Admin-Key': data.adminKey };
  const endpoints = [
    '/status',
    '/keys',
    '/health',
    '/info',
    '/tools/stats',
    '/requests?limit=20',
    '/keys/stats',
    '/admin/system-health',
    '/admin/dashboard',
  ];

  const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];
  const res = http.get(`${BASE_URL}${endpoint}`, {
    headers,
    tags: { endpoint: endpoint.split('?')[0] },
  });

  adminLatency.add(res.timings.duration);

  const ok = check(res, {
    'admin status 200': (r) => r.status === 200,
    'admin has body': (r) => r.body && r.body.length > 2,
  });

  errorRate.add(!ok);
  sleep(0.5);
}

/**
 * Simulates load balancer health probes.
 */
export function healthCheck() {
  const res = http.get(`${BASE_URL}/health`, {
    tags: { endpoint: 'health' },
  });

  check(res, {
    'health 200': (r) => r.status === 200,
    'health status ok': (r) => {
      try {
        return JSON.parse(r.body).status === 'ok';
      } catch {
        return false;
      }
    },
  });
}

// ─── Teardown ────────────────────────────────────────────────────────────────

export function teardown(data) {
  if (!data.adminKey || data.apiKeys.length === 0) return;

  // Revoke test keys
  let revoked = 0;
  for (const key of data.apiKeys) {
    const res = http.post(
      `${BASE_URL}/keys/revoke`,
      JSON.stringify({ key }),
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Key': data.adminKey,
        },
      }
    );
    if (res.status === 200) revoked++;
  }
  console.log(`🧹 Revoked ${revoked}/${data.apiKeys.length} test keys`);
}
