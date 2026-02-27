/**
 * Admin Dashboard v2 — Embedded HTML dashboard for PayGate MCP.
 *
 * Served at GET /dashboard. Admin key entered via browser prompt.
 * Uses only inline CSS and vanilla JS — no external dependencies.
 * All dynamic content is escaped to prevent XSS.
 *
 * Features:
 *   - Tabbed interface: Overview, Keys, Analytics, System
 *   - Overview: stat cards, top tools, recent activity, notifications
 *   - Keys: full CRUD (create, revoke, suspend, resume, top-up), search/filter
 *   - Analytics: credit flow, deny reasons, tool breakdown
 *   - System: uptime, health, config, version
 *   - Auto-refresh every 30s
 */

export function getDashboardHtml(serverName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(serverName)} — Admin Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0f;--surface:#12121a;--border:#1e1e2e;--text:#e0e0e8;--muted:#6b6b80;
--accent:#6366f1;--accent2:#818cf8;--green:#22c55e;--red:#ef4444;--yellow:#eab308;--cyan:#06b6d4;
--font:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;--mono:'SF Mono',Monaco,Consolas,monospace}
body{background:var(--bg);color:var(--text);font-family:var(--font);min-height:100vh}
.login{display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px}
.login h1{font-size:24px;font-weight:600;color:var(--accent2)}
.login input{background:var(--surface);border:1px solid var(--border);color:var(--text);padding:12px 16px;
border-radius:8px;font-size:14px;width:320px;font-family:var(--mono)}
.login input:focus{outline:none;border-color:var(--accent)}
.login button{background:var(--accent);color:#fff;border:none;padding:12px 24px;border-radius:8px;
font-size:14px;cursor:pointer;font-weight:500}
.login button:hover{background:var(--accent2)}
.login .error{color:var(--red);font-size:13px}
header{background:var(--surface);border-bottom:1px solid var(--border);padding:0 24px;
display:flex;align-items:center;justify-content:space-between;height:56px}
header h1{font-size:18px;font-weight:600;display:flex;align-items:center;gap:8px}
header h1 span{color:var(--accent2)}
.header-right{display:flex;align-items:center;gap:12px;font-size:13px;color:var(--muted)}
.refresh-btn{background:var(--surface);border:1px solid var(--border);color:var(--muted);padding:6px 12px;
border-radius:6px;cursor:pointer;font-size:12px}
.refresh-btn:hover{border-color:var(--accent);color:var(--text)}
nav{background:var(--surface);border-bottom:1px solid var(--border);padding:0 24px;display:flex;gap:0}
.tab{padding:12px 20px;font-size:13px;font-weight:500;color:var(--muted);cursor:pointer;
border-bottom:2px solid transparent;transition:all 0.2s}
.tab:hover{color:var(--text)}
.tab.active{color:var(--accent2);border-bottom-color:var(--accent2)}
main{max-width:1280px;margin:0 auto;padding:24px}
.tab-content{display:none}
.tab-content.active{display:block}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px}
.card-label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px}
.card-value{font-size:28px;font-weight:700;font-family:var(--mono)}
.card-value.green{color:var(--green)}
.card-value.accent{color:var(--accent2)}
.card-value.red{color:var(--red)}
.card-value.yellow{color:var(--yellow)}
.card-value.cyan{color:var(--cyan)}
.card-sub{font-size:12px;color:var(--muted);margin-top:4px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:24px}
@media(max-width:960px){.grid3{grid-template-columns:1fr 1fr}}
@media(max-width:768px){.grid2,.grid3{grid-template-columns:1fr}}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}
.panel h2{font-size:14px;font-weight:600;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.bar-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.bar-label{font-size:13px;font-family:var(--mono);min-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar-track{flex:1;height:24px;background:var(--bg);border-radius:6px;overflow:hidden;position:relative}
.bar-fill{height:100%;border-radius:6px;transition:width 0.5s ease;min-width:2px}
.bar-fill.accent{background:linear-gradient(90deg,var(--accent),var(--accent2))}
.bar-fill.green{background:var(--green)}
.bar-fill.red{background:var(--red)}
.bar-fill.yellow{background:var(--yellow)}
.bar-count{position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:11px;
font-family:var(--mono);color:var(--text);z-index:1}
.feed{max-height:400px;overflow-y:auto}
.feed-item{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px}
.feed-item:last-child{border-bottom:none}
.feed-badge{padding:2px 8px;border-radius:4px;font-size:11px;font-family:var(--mono);font-weight:500;white-space:nowrap}
.feed-badge.allow{background:#22c55e20;color:var(--green)}
.feed-badge.deny{background:#ef444420;color:var(--red)}
.feed-badge.info{background:#6366f120;color:var(--accent2)}
.feed-badge.warn{background:#eab30820;color:var(--yellow)}
.feed-badge.crit{background:#ef444420;color:var(--red)}
.feed-tool{font-family:var(--mono);color:var(--accent2);min-width:100px}
.feed-key{color:var(--muted);font-family:var(--mono);font-size:12px}
.feed-time{color:var(--muted);font-size:12px;margin-left:auto;white-space:nowrap}
.key-toolbar{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center}
.key-toolbar input,.key-toolbar select{background:var(--bg);border:1px solid var(--border);color:var(--text);
padding:8px 12px;border-radius:6px;font-size:13px;font-family:var(--mono)}
.key-toolbar input:focus,.key-toolbar select:focus{outline:none;border-color:var(--accent)}
.btn{border:none;padding:8px 16px;border-radius:6px;font-size:13px;cursor:pointer;font-weight:500;
transition:opacity 0.2s}
.btn:disabled{opacity:0.5;cursor:not-allowed}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover:not(:disabled){background:var(--accent2)}
.btn-danger{background:var(--red);color:#fff}
.btn-danger:hover:not(:disabled){opacity:0.8}
.btn-warn{background:var(--yellow);color:#000}
.btn-warn:hover:not(:disabled){opacity:0.8}
.btn-success{background:var(--green);color:#fff}
.btn-success:hover:not(:disabled){opacity:0.8}
.btn-sm{padding:4px 10px;font-size:12px}
.key-table{width:100%;border-collapse:collapse}
.key-table th{text-align:left;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;
padding:8px 12px;border-bottom:1px solid var(--border)}
.key-table td{padding:10px 12px;border-bottom:1px solid var(--border);font-size:13px}
.key-table tr:hover{background:var(--bg)}
.key-table .mono{font-family:var(--mono)}
.status-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}
.status-dot.active{background:var(--green)}
.status-dot.suspended{background:var(--yellow)}
.status-dot.revoked{background:var(--red)}
.info-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px}
.info-row:last-child{border-bottom:none}
.info-label{color:var(--muted)}
.info-value{font-family:var(--mono)}
.toast{position:fixed;bottom:24px;right:24px;background:var(--surface);border:1px solid var(--accent);
color:var(--text);padding:12px 20px;border-radius:8px;font-size:13px;z-index:100;display:none;
box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:400px;word-break:break-all}
.modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:200;
display:none;align-items:center;justify-content:center}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;
min-width:360px;max-width:480px}
.modal h3{font-size:16px;font-weight:600;margin-bottom:16px}
.modal label{font-size:13px;color:var(--muted);display:block;margin-bottom:4px;margin-top:12px}
.modal input{width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:8px 12px;
border-radius:6px;font-size:13px;font-family:var(--mono)}
.modal input:focus{outline:none;border-color:var(--accent)}
.modal-actions{display:flex;gap:8px;margin-top:20px;justify-content:flex-end}
.empty{color:var(--muted);font-size:13px;padding:20px 0;text-align:center}
#app{display:none}
</style>
</head>
<body>

<div class="login" id="login-screen">
  <h1>$ PayGate Dashboard</h1>
  <input type="password" id="admin-key-input" placeholder="Enter admin key..." autofocus>
  <button onclick="doLogin()">Sign In</button>
  <div class="error" id="login-error"></div>
</div>

<div id="app">
  <header>
    <h1><span>$</span> ${esc(serverName)}</h1>
    <div class="header-right">
      <span id="last-refresh"></span>
      <button class="refresh-btn" onclick="refresh()">&#x21bb; Refresh</button>
    </div>
  </header>

  <nav>
    <div class="tab active" data-tab="overview" onclick="switchTab('overview')">Overview</div>
    <div class="tab" data-tab="keys" onclick="switchTab('keys')">Keys</div>
    <div class="tab" data-tab="analytics" onclick="switchTab('analytics')">Analytics</div>
    <div class="tab" data-tab="system" onclick="switchTab('system')">System</div>
  </nav>

  <main>
    <!-- ═══ Overview Tab ═══ -->
    <div class="tab-content active" id="tab-overview">
      <div class="cards">
        <div class="card"><div class="card-label">Active Keys</div>
          <div class="card-value accent" id="stat-keys">0</div>
          <div class="card-sub" id="stat-keys-sub"></div></div>
        <div class="card"><div class="card-label">Total Calls</div>
          <div class="card-value green" id="stat-calls">0</div></div>
        <div class="card"><div class="card-label">Credits Spent</div>
          <div class="card-value yellow" id="stat-credits">0</div></div>
        <div class="card"><div class="card-label">Credits Remaining</div>
          <div class="card-value cyan" id="stat-remaining">0</div></div>
        <div class="card"><div class="card-label">Denied</div>
          <div class="card-value red" id="stat-denied">0</div></div>
        <div class="card"><div class="card-label">Uptime</div>
          <div class="card-value" id="stat-uptime" style="font-size:20px">-</div></div>
      </div>

      <div class="grid2">
        <div class="panel">
          <h2>Top Tools</h2>
          <div id="tools-chart"></div>
          <div id="tools-empty" class="empty">No tool calls yet.</div>
        </div>
        <div class="panel">
          <h2>Recent Activity</h2>
          <div class="feed" id="activity-feed"></div>
          <div id="feed-empty" class="empty">No activity yet.</div>
        </div>
      </div>

      <div class="panel" id="notif-panel" style="display:none">
        <h2>Notifications</h2>
        <div id="notif-list"></div>
      </div>
    </div>

    <!-- ═══ Keys Tab ═══ -->
    <div class="tab-content" id="tab-keys">
      <div class="key-toolbar">
        <input type="text" id="key-search" placeholder="Search keys..." oninput="filterKeys()">
        <select id="key-filter" onchange="filterKeys()">
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="revoked">Revoked</option>
        </select>
        <button class="btn btn-primary" onclick="showCreateKeyModal()">+ Create Key</button>
      </div>
      <div style="overflow-x:auto">
        <table class="key-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Name</th>
              <th>Key Prefix</th>
              <th>Credits</th>
              <th>Calls</th>
              <th>Spent</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="key-tbody"></tbody>
        </table>
      </div>
      <div id="keys-empty" class="empty">No keys found.</div>
      <div id="key-pagination" style="display:flex;gap:8px;margin-top:12px;justify-content:center"></div>
    </div>

    <!-- ═══ Analytics Tab ═══ -->
    <div class="tab-content" id="tab-analytics">
      <div class="grid2">
        <div class="panel">
          <h2>Deny Reasons</h2>
          <div id="deny-chart"></div>
          <div id="deny-empty" class="empty">No denials recorded.</div>
        </div>
        <div class="panel">
          <h2>Credit Flow</h2>
          <div id="credit-flow"></div>
        </div>
      </div>
      <div class="grid2">
        <div class="panel">
          <h2>Top Consumers</h2>
          <div id="consumers-chart"></div>
          <div id="consumers-empty" class="empty">No consumer data.</div>
        </div>
        <div class="panel">
          <h2>Webhook Health</h2>
          <div id="webhook-stats"></div>
          <div id="webhook-empty" class="empty">No webhook configured.</div>
        </div>
      </div>
    </div>

    <!-- ═══ System Tab ═══ -->
    <div class="tab-content" id="tab-system">
      <div class="cards">
        <div class="card"><div class="card-label">Version</div>
          <div class="card-value" id="sys-version" style="font-size:20px">-</div></div>
        <div class="card"><div class="card-label">In-Flight Requests</div>
          <div class="card-value accent" id="sys-inflight">0</div></div>
        <div class="card"><div class="card-label">MCP Backend</div>
          <div class="card-value green" id="sys-backend">-</div></div>
        <div class="card"><div class="card-label">Maintenance</div>
          <div class="card-value" id="sys-maintenance">Off</div></div>
      </div>
      <div class="grid2">
        <div class="panel">
          <h2>Server Info</h2>
          <div id="sys-info"></div>
        </div>
        <div class="panel">
          <h2>Quick Actions</h2>
          <div style="display:flex;flex-direction:column;gap:8px">
            <button class="btn btn-warn" onclick="toggleMaintenance()">Toggle Maintenance Mode</button>
            <button class="btn btn-primary" onclick="exportKeys()">Export Keys (CSV)</button>
            <button class="btn btn-primary" onclick="exportAudit()">Export Audit Log (CSV)</button>
          </div>
        </div>
      </div>
    </div>
  </main>
</div>

<!-- Create Key Modal -->
<div class="modal-overlay" id="create-key-modal">
  <div class="modal">
    <h3>Create API Key</h3>
    <label>Name</label>
    <input type="text" id="modal-key-name" placeholder="my-app">
    <label>Credits</label>
    <input type="number" id="modal-key-credits" value="100" min="1">
    <label>Namespace (optional)</label>
    <input type="text" id="modal-key-namespace" placeholder="default">
    <label>Rate Limit (calls/min, optional)</label>
    <input type="number" id="modal-key-ratelimit" placeholder="60">
    <div class="modal-actions">
      <button class="btn" style="background:var(--border);color:var(--text)" onclick="hideModal()">Cancel</button>
      <button class="btn btn-primary" onclick="createKey()">Create</button>
    </div>
  </div>
</div>

<!-- Top-up Modal -->
<div class="modal-overlay" id="topup-modal">
  <div class="modal">
    <h3>Top Up Credits</h3>
    <label>Key</label>
    <input type="text" id="topup-key" readonly style="color:var(--muted)">
    <label>Credits to Add</label>
    <input type="number" id="topup-amount" value="100" min="1">
    <div class="modal-actions">
      <button class="btn" style="background:var(--border);color:var(--text)" onclick="hideModal()">Cancel</button>
      <button class="btn btn-success" onclick="doTopup()">Add Credits</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let ADMIN_KEY = '';
const BASE = window.location.origin;
let allKeys = [];
let currentPage = 1;

async function api(path, opts) {
  opts = opts || {};
  var headers = { 'X-Admin-Key': ADMIN_KEY };
  if (opts.body) headers['Content-Type'] = 'application/json';
  var res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body || undefined,
  });
  var text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch(e) { return { status: res.status, body: text }; }
}

function doLogin() {
  ADMIN_KEY = document.getElementById('admin-key-input').value.trim();
  if (!ADMIN_KEY) return;
  api('/status').then(function(r) {
    if (r.status === 200) {
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('app').style.display = 'block';
      refresh();
      setInterval(refresh, 30000);
    } else {
      document.getElementById('login-error').textContent = 'Invalid admin key.';
    }
  }).catch(function() {
    document.getElementById('login-error').textContent = 'Connection failed.';
  });
}

document.getElementById('admin-key-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') doLogin();
});

function setText(id, text) {
  var el = document.getElementById(id);
  if (el) el.textContent = String(text);
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  document.querySelectorAll('.tab-content').forEach(function(tc) {
    tc.classList.toggle('active', tc.id === 'tab-' + name);
  });
}

// ─── Bar chart builder ───
function buildBarChart(containerId, emptyId, entries, labelFn, valueFn, countFn, fillClass) {
  var container = document.getElementById(containerId);
  var emptyEl = document.getElementById(emptyId);
  container.textContent = '';
  if (!entries || entries.length === 0) { if (emptyEl) emptyEl.style.display = 'block'; return; }
  if (emptyEl) emptyEl.style.display = 'none';
  var maxVal = entries.reduce(function(m, e) { return Math.max(m, valueFn(e)); }, 1);

  entries.forEach(function(entry) {
    var pct = Math.max(2, (valueFn(entry) / maxVal) * 100);
    var row = document.createElement('div'); row.className = 'bar-row';
    var label = document.createElement('div'); label.className = 'bar-label'; label.textContent = labelFn(entry);
    var track = document.createElement('div'); track.className = 'bar-track';
    var fill = document.createElement('div'); fill.className = 'bar-fill ' + (fillClass || 'accent'); fill.style.width = pct + '%';
    var count = document.createElement('div'); count.className = 'bar-count'; count.textContent = countFn(entry);
    track.appendChild(fill); track.appendChild(count);
    row.appendChild(label); row.appendChild(track);
    container.appendChild(row);
  });
}

// ─── Activity feed ───
function buildActivityFeed(events) {
  var feedEl = document.getElementById('activity-feed');
  var emptyEl = document.getElementById('feed-empty');
  feedEl.textContent = '';
  var items = (events || []).slice(-50).reverse();
  if (items.length === 0) { emptyEl.style.display = 'block'; return; }
  emptyEl.style.display = 'none';

  items.forEach(function(e) {
    var item = document.createElement('div'); item.className = 'feed-item';
    var badge = document.createElement('span');
    badge.className = 'feed-badge ' + (e.allowed ? 'allow' : 'deny');
    badge.textContent = e.allowed ? 'OK' : 'DENY';
    var tool = document.createElement('span'); tool.className = 'feed-tool'; tool.textContent = e.tool;
    var key = document.createElement('span'); key.className = 'feed-key'; key.textContent = e.apiKey;
    item.appendChild(badge); item.appendChild(tool); item.appendChild(key);
    if (e.creditsCharged > 0) {
      var cr = document.createElement('span');
      cr.style.cssText = 'color:var(--yellow);font-family:var(--mono);font-size:12px';
      cr.textContent = '-' + e.creditsCharged;
      item.appendChild(cr);
    }
    var time = document.createElement('span'); time.className = 'feed-time';
    time.textContent = new Date(e.timestamp).toLocaleTimeString();
    item.appendChild(time);
    feedEl.appendChild(item);
  });
}

// ─── Keys table ───
function buildKeysTable(keys) {
  var tbody = document.getElementById('key-tbody');
  var emptyEl = document.getElementById('keys-empty');
  tbody.textContent = '';
  if (!keys || keys.length === 0) { emptyEl.style.display = 'block'; return; }
  emptyEl.style.display = 'none';

  keys.forEach(function(k) {
    var tr = document.createElement('tr');

    // Status
    var tdStatus = document.createElement('td');
    var dot = document.createElement('span');
    var statusText = !k.active ? 'revoked' : k.suspended ? 'suspended' : 'active';
    dot.className = 'status-dot ' + statusText;
    tdStatus.appendChild(dot);
    var statusLabel = document.createElement('span');
    statusLabel.textContent = statusText.charAt(0).toUpperCase() + statusText.slice(1);
    statusLabel.style.fontSize = '12px';
    tdStatus.appendChild(statusLabel);

    // Name
    var tdName = document.createElement('td');
    tdName.textContent = k.name || 'unnamed';

    // Key prefix
    var tdPrefix = document.createElement('td');
    tdPrefix.className = 'mono';
    tdPrefix.style.color = 'var(--accent2)';
    tdPrefix.textContent = k.keyPrefix || '';

    // Credits
    var tdCredits = document.createElement('td');
    tdCredits.className = 'mono';
    tdCredits.style.color = 'var(--green)';
    tdCredits.textContent = String(k.credits);

    // Calls
    var tdCalls = document.createElement('td');
    tdCalls.className = 'mono';
    tdCalls.textContent = String(k.totalCalls || 0);

    // Spent
    var tdSpent = document.createElement('td');
    tdSpent.className = 'mono';
    tdSpent.style.color = 'var(--yellow)';
    tdSpent.textContent = String(k.totalSpent || 0);

    // Actions
    var tdActions = document.createElement('td');
    tdActions.style.whiteSpace = 'nowrap';

    if (k.active && !k.suspended) {
      var topupBtn = document.createElement('button');
      topupBtn.className = 'btn btn-success btn-sm';
      topupBtn.textContent = '+Top Up';
      topupBtn.style.marginRight = '4px';
      topupBtn.onclick = function() { showTopupModal(k.keyPrefix); };
      tdActions.appendChild(topupBtn);

      var suspendBtn = document.createElement('button');
      suspendBtn.className = 'btn btn-warn btn-sm';
      suspendBtn.textContent = 'Suspend';
      suspendBtn.style.marginRight = '4px';
      suspendBtn.onclick = function() { keyAction('suspend', k.keyPrefix); };
      tdActions.appendChild(suspendBtn);
    }

    if (k.active && k.suspended) {
      var resumeBtn = document.createElement('button');
      resumeBtn.className = 'btn btn-success btn-sm';
      resumeBtn.textContent = 'Resume';
      resumeBtn.style.marginRight = '4px';
      resumeBtn.onclick = function() { keyAction('resume', k.keyPrefix); };
      tdActions.appendChild(resumeBtn);
    }

    if (k.active) {
      var revokeBtn = document.createElement('button');
      revokeBtn.className = 'btn btn-danger btn-sm';
      revokeBtn.textContent = 'Revoke';
      revokeBtn.onclick = function() { if (confirm('Revoke key ' + k.keyPrefix + '?')) keyAction('revoke', k.keyPrefix); };
      tdActions.appendChild(revokeBtn);
    }

    tr.appendChild(tdStatus); tr.appendChild(tdName); tr.appendChild(tdPrefix);
    tr.appendChild(tdCredits); tr.appendChild(tdCalls); tr.appendChild(tdSpent);
    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  });
}

function filterKeys() {
  var search = document.getElementById('key-search').value.toLowerCase();
  var filter = document.getElementById('key-filter').value;
  var filtered = allKeys.filter(function(k) {
    if (filter === 'active' && (!k.active || k.suspended)) return false;
    if (filter === 'suspended' && !k.suspended) return false;
    if (filter === 'revoked' && k.active) return false;
    if (search && !(k.name || '').toLowerCase().includes(search) &&
        !(k.keyPrefix || '').toLowerCase().includes(search)) return false;
    return true;
  });
  buildKeysTable(filtered);
}

// ─── Notifications ───
function buildNotifications(data) {
  var panel = document.getElementById('notif-panel');
  var list = document.getElementById('notif-list');
  list.textContent = '';
  var items = [];

  // From admin/notifications if available
  if (data.notifications) {
    var n = data.notifications;
    if (n.critical > 0) items.push({ level: 'crit', text: n.critical + ' critical alert(s) — keys expired or exhausted' });
    if (n.warning > 0) items.push({ level: 'warn', text: n.warning + ' warning(s) — keys expiring soon' });
    if (n.info > 0) items.push({ level: 'info', text: n.info + ' suspended key(s)' });
  }

  if (items.length === 0) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';

  items.forEach(function(item) {
    var el = document.createElement('div'); el.className = 'feed-item';
    var badge = document.createElement('span');
    badge.className = 'feed-badge ' + item.level;
    badge.textContent = item.level.toUpperCase();
    var text = document.createElement('span'); text.textContent = item.text;
    el.appendChild(badge); el.appendChild(text);
    list.appendChild(el);
  });
}

// ─── Credit flow ───
function buildCreditFlow(data) {
  var container = document.getElementById('credit-flow');
  container.textContent = '';
  var rows = [
    ['Total Allocated', (data.totalAllocated || 0).toLocaleString(), 'var(--accent2)'],
    ['Total Spent', (data.totalSpent || 0).toLocaleString(), 'var(--yellow)'],
    ['Total Remaining', (data.totalRemaining || 0).toLocaleString(), 'var(--green)'],
    ['Utilization', data.totalAllocated > 0 ? Math.round(data.totalSpent / data.totalAllocated * 100) + '%' : '0%', 'var(--cyan)'],
  ];
  rows.forEach(function(r) {
    var row = document.createElement('div'); row.className = 'info-row';
    var label = document.createElement('span'); label.className = 'info-label'; label.textContent = r[0];
    var value = document.createElement('span'); value.className = 'info-value'; value.style.color = r[2]; value.textContent = r[1];
    row.appendChild(label); row.appendChild(value); container.appendChild(row);
  });
}

// ─── System info ───
function buildSystemInfo(info) {
  var container = document.getElementById('sys-info');
  container.textContent = '';
  var rows = [];
  if (info.name) rows.push(['Server Name', info.name]);
  if (info.version) rows.push(['Version', info.version]);
  if (info.transport) rows.push(['Transport', info.transport]);
  if (info.uptime) rows.push(['Uptime', info.uptime.uptimeHours + ' hours']);
  if (info.uptime) rows.push(['Started', new Date(info.uptime.startedAt).toLocaleString()]);
  if (info.mcpServer) rows.push(['MCP Server', info.mcpServer]);
  if (info.features) rows.push(['Features', (info.features || []).join(', ')]);

  rows.forEach(function(r) {
    var row = document.createElement('div'); row.className = 'info-row';
    var label = document.createElement('span'); label.className = 'info-label'; label.textContent = r[0];
    var value = document.createElement('span'); value.className = 'info-value'; value.textContent = r[1];
    row.appendChild(label); row.appendChild(value); container.appendChild(row);
  });
}

// ─── Webhook stats ───
function buildWebhookStats(stats) {
  var container = document.getElementById('webhook-stats');
  var emptyEl = document.getElementById('webhook-empty');
  container.textContent = '';
  if (!stats || (!stats.totalDelivered && !stats.totalFailed)) {
    emptyEl.style.display = 'block'; return;
  }
  emptyEl.style.display = 'none';
  var rows = [
    ['Delivered', String(stats.totalDelivered || 0)],
    ['Failed', String(stats.totalFailed || 0)],
    ['Pending', String(stats.pendingCount || 0)],
    ['Dead Letters', String(stats.deadLetterCount || 0)],
  ];
  rows.forEach(function(r) {
    var row = document.createElement('div'); row.className = 'info-row';
    var label = document.createElement('span'); label.className = 'info-label'; label.textContent = r[0];
    var value = document.createElement('span'); value.className = 'info-value'; value.textContent = r[1];
    row.appendChild(label); row.appendChild(value); container.appendChild(row);
  });
}

// ─── Modals ───
function showCreateKeyModal() {
  document.getElementById('create-key-modal').style.display = 'flex';
  document.getElementById('modal-key-name').focus();
}
function showTopupModal(keyPrefix) {
  document.getElementById('topup-key').value = keyPrefix;
  document.getElementById('topup-modal').style.display = 'flex';
  document.getElementById('topup-amount').focus();
}
function hideModal() {
  document.getElementById('create-key-modal').style.display = 'none';
  document.getElementById('topup-modal').style.display = 'none';
}

async function createKey() {
  var name = document.getElementById('modal-key-name').value.trim() || 'unnamed';
  var credits = parseInt(document.getElementById('modal-key-credits').value) || 100;
  var body = { name: name, credits: credits };
  var ns = document.getElementById('modal-key-namespace').value.trim();
  if (ns) body.namespace = ns;
  var rl = parseInt(document.getElementById('modal-key-ratelimit').value);
  if (rl > 0) body.rateLimit = rl;
  var res = await api('/keys', { method: 'POST', body: JSON.stringify(body) });
  if (res.status === 201) {
    toast('Key created: ' + res.body.key);
    hideModal();
    refresh();
  } else {
    toast('Error: ' + (res.body.error || 'Failed'), true);
  }
}

async function doTopup() {
  var keyPrefix = document.getElementById('topup-key').value;
  var amount = parseInt(document.getElementById('topup-amount').value) || 100;
  // Find full key from allKeys by prefix
  var keyRecord = allKeys.find(function(k) { return k.keyPrefix === keyPrefix; });
  if (!keyRecord) { toast('Key not found', true); return; }
  var res = await api('/topup', { method: 'POST', body: JSON.stringify({ key: keyRecord.key || keyPrefix, credits: amount }) });
  if (res.status === 200) {
    toast('Added ' + amount + ' credits');
    hideModal();
    refresh();
  } else {
    toast('Error: ' + (res.body.error || 'Failed'), true);
  }
}

async function keyAction(action, keyPrefix) {
  var keyRecord = allKeys.find(function(k) { return k.keyPrefix === keyPrefix; });
  if (!keyRecord) { toast('Key not found', true); return; }
  var path = '/keys/' + action;
  var res = await api(path, { method: 'POST', body: JSON.stringify({ key: keyRecord.key || keyPrefix }) });
  if (res.status === 200) {
    toast('Key ' + action + 'd successfully');
    refresh();
  } else {
    toast('Error: ' + (res.body.error || 'Failed'), true);
  }
}

async function toggleMaintenance() {
  var res = await api('/maintenance');
  var isOn = res.status === 200 && res.body.enabled;
  var toggleRes = await api('/maintenance', {
    method: 'POST',
    body: JSON.stringify({ enabled: !isOn }),
  });
  if (toggleRes.status === 200) {
    toast('Maintenance mode ' + (!isOn ? 'enabled' : 'disabled'));
    refresh();
  } else {
    toast('Error: ' + (toggleRes.body.error || 'Failed'), true);
  }
}

async function exportKeys() {
  window.open(BASE + '/keys/export?format=csv&adminKey=' + encodeURIComponent(ADMIN_KEY));
}

async function exportAudit() {
  window.open(BASE + '/audit/export?format=csv&adminKey=' + encodeURIComponent(ADMIN_KEY));
}

async function refresh() {
  try {
    var results = await Promise.all([
      api('/admin/dashboard'),
      api('/usage'),
      api('/keys'),
      api('/info'),
    ]);
    var dashRes = results[0];
    var usageRes = results[1];
    var keysRes = results[2];
    var infoRes = results[3];

    // Overview cards
    if (dashRes.status === 200) {
      var d = dashRes.body;
      setText('stat-keys', d.keys ? d.keys.active : 0);
      setText('stat-keys-sub', d.keys ? (d.keys.total + ' total, ' + d.keys.suspended + ' suspended') : '');
      setText('stat-calls', d.usage ? d.usage.totalCalls.toLocaleString() : '0');
      setText('stat-credits', d.credits ? d.credits.totalSpent.toLocaleString() : '0');
      setText('stat-remaining', d.credits ? d.credits.totalRemaining.toLocaleString() : '0');
      setText('stat-denied', d.usage ? d.usage.totalDenied.toLocaleString() : '0');
      setText('stat-uptime', d.uptime ? d.uptime.uptimeHours + 'h' : '-');

      // Notifications
      buildNotifications(d);

      // Analytics: credit flow
      if (d.credits) buildCreditFlow(d.credits);

      // Analytics: top consumers
      if (d.topConsumers && d.topConsumers.length > 0) {
        buildBarChart('consumers-chart', 'consumers-empty', d.topConsumers.slice(0, 8),
          function(e) { return e.name; }, function(e) { return e.credits; },
          function(e) { return e.credits + ' cr / ' + e.calls + ' calls'; }, 'yellow');
      }

      // System
      setText('sys-inflight', d.inflight || 0);
      setText('sys-maintenance', d.maintenanceMode ? 'ON' : 'Off');
      if (d.maintenanceMode) {
        document.getElementById('sys-maintenance').style.color = 'var(--yellow)';
      } else {
        document.getElementById('sys-maintenance').style.color = 'var(--green)';
      }
    }

    // Tools chart
    if (usageRes.status === 200) {
      var u = usageRes.body;
      if (u.events) buildActivityFeed(u.events);
      if (u.perTool) {
        var toolEntries = Object.entries(u.perTool)
          .map(function(e) { return { tool: e[0], calls: e[1].calls, credits: e[1].credits }; })
          .sort(function(a, b) { return b.calls - a.calls; }).slice(0, 10);
        buildBarChart('tools-chart', 'tools-empty', toolEntries,
          function(e) { return e.tool; }, function(e) { return e.calls; },
          function(e) { return e.calls + ' calls / ' + e.credits + ' cr'; }, 'accent');
      }
      // Deny reasons
      if (u.denyReasons) {
        var denyEntries = Object.entries(u.denyReasons)
          .map(function(e) { return { reason: e[0], count: e[1] }; })
          .sort(function(a, b) { return b.count - a.count; });
        buildBarChart('deny-chart', 'deny-empty', denyEntries,
          function(e) { return e.reason; }, function(e) { return e.count; },
          function(e) { return String(e.count); }, 'red');
      }
    }

    // Keys table
    if (keysRes.status === 200 && Array.isArray(keysRes.body)) {
      allKeys = keysRes.body;
      filterKeys();
    }

    // System info
    if (infoRes.status === 200) {
      var info = infoRes.body;
      setText('sys-version', info.version || '-');
      setText('sys-backend', info.mcpServer || 'Connected');
      buildSystemInfo(info);
    }

    // Webhook stats
    try {
      var whRes = await api('/webhooks/stats');
      if (whRes.status === 200) buildWebhookStats(whRes.body);
    } catch(e) {}

    setText('last-refresh', 'Updated ' + new Date().toLocaleTimeString());
  } catch (err) {
    console.error('Refresh failed:', err);
  }
}

function toast(msg, isError) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.style.borderColor = isError ? 'var(--red)' : 'var(--accent)';
  el.style.display = 'block';
  setTimeout(function() { el.style.display = 'none'; }, 5000);
}

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(function(el) {
  el.addEventListener('click', function(e) { if (e.target === el) hideModal(); });
});
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
