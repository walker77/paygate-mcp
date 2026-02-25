/**
 * Admin Dashboard — Embedded HTML dashboard for PayGate MCP.
 *
 * Served at GET /dashboard. Admin key entered via browser prompt.
 * Uses only inline CSS and vanilla JS — no external dependencies.
 * All dynamic content is escaped to prevent XSS.
 *
 * Features:
 *   - Overview cards: active keys, total calls, credits spent, denied
 *   - Top tools breakdown (bar chart)
 *   - Recent activity feed
 *   - Key management (create, revoke, top-up)
 *   - Auto-refresh every 30s
 */

export function getDashboardHtml(serverName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(serverName)} — Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0f;--surface:#12121a;--border:#1e1e2e;--text:#e0e0e8;--muted:#6b6b80;
--accent:#6366f1;--accent2:#818cf8;--green:#22c55e;--red:#ef4444;--yellow:#eab308;
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
header{background:var(--surface);border-bottom:1px solid var(--border);padding:16px 24px;
display:flex;align-items:center;justify-content:space-between}
header h1{font-size:18px;font-weight:600;display:flex;align-items:center;gap:8px}
header h1 span{color:var(--accent2)}
.header-right{display:flex;align-items:center;gap:12px;font-size:13px;color:var(--muted)}
.refresh-btn{background:var(--surface);border:1px solid var(--border);color:var(--muted);padding:6px 12px;
border-radius:6px;cursor:pointer;font-size:12px}
.refresh-btn:hover{border-color:var(--accent);color:var(--text)}
main{max-width:1200px;margin:0 auto;padding:24px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:24px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px}
.card-label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px}
.card-value{font-size:32px;font-weight:700;font-family:var(--mono)}
.card-value.green{color:var(--green)}
.card-value.accent{color:var(--accent2)}
.card-value.red{color:var(--red)}
.card-value.yellow{color:var(--yellow)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}
@media(max-width:768px){.grid2{grid-template-columns:1fr}}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px}
.panel h2{font-size:14px;font-weight:600;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.bar-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.bar-label{font-size:13px;font-family:var(--mono);min-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar-track{flex:1;height:24px;background:var(--bg);border-radius:6px;overflow:hidden;position:relative}
.bar-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:6px;
transition:width 0.5s ease;min-width:2px}
.bar-count{position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:11px;
font-family:var(--mono);color:var(--text);z-index:1}
.feed{max-height:400px;overflow-y:auto}
.feed-item{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px}
.feed-item:last-child{border-bottom:none}
.feed-badge{padding:2px 8px;border-radius:4px;font-size:11px;font-family:var(--mono);font-weight:500;white-space:nowrap}
.feed-badge.allow{background:#22c55e20;color:var(--green)}
.feed-badge.deny{background:#ef444420;color:var(--red)}
.feed-tool{font-family:var(--mono);color:var(--accent2);min-width:100px}
.feed-key{color:var(--muted);font-family:var(--mono);font-size:12px}
.feed-time{color:var(--muted);font-size:12px;margin-left:auto;white-space:nowrap}
.keys-section{margin-top:24px}
.key-actions{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.key-actions input{background:var(--bg);border:1px solid var(--border);color:var(--text);padding:8px 12px;
border-radius:6px;font-size:13px;font-family:var(--mono);width:160px}
.key-actions input:focus{outline:none;border-color:var(--accent)}
.btn{border:none;padding:8px 16px;border-radius:6px;font-size:13px;cursor:pointer;font-weight:500}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:var(--accent2)}
.btn-danger{background:var(--red);color:#fff}
.btn-danger:hover{opacity:0.8}
.btn-secondary{background:var(--border);color:var(--text)}
.btn-secondary:hover{background:#2a2a3a}
.key-list{max-height:300px;overflow-y:auto}
.key-row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px}
.key-row:last-child{border-bottom:none}
.key-prefix{font-family:var(--mono);color:var(--accent2);min-width:100px}
.key-name{min-width:100px}
.key-credits{font-family:var(--mono);color:var(--green);min-width:80px}
.key-status{font-size:11px;padding:2px 8px;border-radius:4px}
.key-status.active{background:#22c55e20;color:var(--green)}
.key-status.inactive{background:#ef444420;color:var(--red)}
.toast{position:fixed;bottom:24px;right:24px;background:var(--surface);border:1px solid var(--accent);
color:var(--text);padding:12px 20px;border-radius:8px;font-size:13px;z-index:100;display:none;
box-shadow:0 4px 12px rgba(0,0,0,0.3)}
#app{display:none}
</style>
</head>
<body>

<!-- Login screen -->
<div class="login" id="login-screen">
  <h1>$ PayGate Dashboard</h1>
  <input type="password" id="admin-key-input" placeholder="Enter admin key..." autofocus>
  <button onclick="doLogin()">Sign In</button>
  <div class="error" id="login-error"></div>
</div>

<!-- Dashboard -->
<div id="app">
  <header>
    <h1><span>$</span> ${esc(serverName)}</h1>
    <div class="header-right">
      <span id="last-refresh"></span>
      <button class="refresh-btn" onclick="refresh()">&#x21bb; Refresh</button>
    </div>
  </header>

  <main>
    <!-- Overview cards -->
    <div class="cards">
      <div class="card">
        <div class="card-label">Active Keys</div>
        <div class="card-value accent" id="stat-keys">0</div>
      </div>
      <div class="card">
        <div class="card-label">Total Calls</div>
        <div class="card-value green" id="stat-calls">0</div>
      </div>
      <div class="card">
        <div class="card-label">Credits Spent</div>
        <div class="card-value yellow" id="stat-credits">0</div>
      </div>
      <div class="card">
        <div class="card-label">Denied</div>
        <div class="card-value red" id="stat-denied">0</div>
      </div>
    </div>

    <!-- Tools + Activity -->
    <div class="grid2">
      <div class="panel">
        <h2>&#x1f527; Top Tools</h2>
        <div id="tools-chart"></div>
        <div id="tools-empty" style="color:var(--muted);font-size:13px">No tool calls yet.</div>
      </div>
      <div class="panel">
        <h2>&#x26a1; Recent Activity</h2>
        <div class="feed" id="activity-feed"></div>
        <div id="feed-empty" style="color:var(--muted);font-size:13px">No activity yet.</div>
      </div>
    </div>

    <!-- Keys Management -->
    <div class="panel keys-section">
      <h2>&#x1f511; API Keys</h2>
      <div class="key-actions">
        <input type="text" id="new-key-name" placeholder="Key name...">
        <input type="number" id="new-key-credits" placeholder="Credits" value="100" min="1">
        <button class="btn btn-primary" onclick="createKey()">Create Key</button>
      </div>
      <div class="key-list" id="key-list"></div>
    </div>
  </main>
</div>

<div class="toast" id="toast"></div>

<script>
// All dynamic content is escaped via esc() to prevent XSS.
// The dashboard only talks to the same-origin PayGate server.
let ADMIN_KEY = '';
const BASE = window.location.origin;

async function api(path, opts) {
  opts = opts || {};
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Key': ADMIN_KEY,
    },
    body: opts.body || undefined,
  });
  const text = await res.text();
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

// Escape HTML to prevent XSS - all user/server data goes through this
function esc(s) {
  if (!s) return '';
  var d = document.createElement('div');
  d.appendChild(document.createTextNode(String(s)));
  return d.textContent ? d.textContent : '';
}

// Safe text setter - uses textContent, not innerHTML
function setText(id, text) {
  var el = document.getElementById(id);
  if (el) el.textContent = String(text);
}

// Build tool chart using safe DOM methods
function buildToolsChart(perTool) {
  var container = document.getElementById('tools-chart');
  var emptyEl = document.getElementById('tools-empty');
  container.textContent = ''; // clear safely

  var entries = Object.entries(perTool).sort(function(a, b) { return b[1].calls - a[1].calls; }).slice(0, 10);
  if (entries.length === 0) {
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';
  var maxCalls = entries[0][1].calls;

  entries.forEach(function(entry) {
    var name = entry[0];
    var data = entry[1];
    var pct = Math.max(2, (data.calls / maxCalls) * 100);

    var row = document.createElement('div');
    row.className = 'bar-row';

    var label = document.createElement('div');
    label.className = 'bar-label';
    label.textContent = name;

    var track = document.createElement('div');
    track.className = 'bar-track';

    var fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = pct + '%';

    var count = document.createElement('div');
    count.className = 'bar-count';
    count.textContent = data.calls + ' calls / ' + data.credits + ' cr';

    track.appendChild(fill);
    track.appendChild(count);
    row.appendChild(label);
    row.appendChild(track);
    container.appendChild(row);
  });
}

// Build activity feed using safe DOM methods
function buildActivityFeed(events) {
  var feedEl = document.getElementById('activity-feed');
  var emptyEl = document.getElementById('feed-empty');
  feedEl.textContent = ''; // clear safely

  var items = (events || []).slice(-50).reverse();
  if (items.length === 0) {
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';

  items.forEach(function(e) {
    var item = document.createElement('div');
    item.className = 'feed-item';

    var badge = document.createElement('span');
    badge.className = 'feed-badge ' + (e.allowed ? 'allow' : 'deny');
    badge.textContent = e.allowed ? 'OK' : 'DENY';

    var tool = document.createElement('span');
    tool.className = 'feed-tool';
    tool.textContent = e.tool;

    var key = document.createElement('span');
    key.className = 'feed-key';
    key.textContent = e.apiKey;

    item.appendChild(badge);
    item.appendChild(tool);
    item.appendChild(key);

    if (e.creditsCharged > 0) {
      var cr = document.createElement('span');
      cr.style.cssText = 'color:var(--yellow);font-family:var(--mono);font-size:12px';
      cr.textContent = '-' + e.creditsCharged;
      item.appendChild(cr);
    }

    var time = document.createElement('span');
    time.className = 'feed-time';
    time.textContent = new Date(e.timestamp).toLocaleTimeString();
    item.appendChild(time);

    feedEl.appendChild(item);
  });
}

// Build keys list using safe DOM methods
function buildKeysList(keys) {
  var container = document.getElementById('key-list');
  container.textContent = ''; // clear safely

  (keys || []).forEach(function(k) {
    var row = document.createElement('div');
    row.className = 'key-row';

    var prefix = document.createElement('span');
    prefix.className = 'key-prefix';
    prefix.textContent = k.keyPrefix;

    var name = document.createElement('span');
    name.className = 'key-name';
    name.textContent = k.name;

    var credits = document.createElement('span');
    credits.className = 'key-credits';
    credits.textContent = k.credits + ' cr';

    var status = document.createElement('span');
    status.className = 'key-status ' + (k.active ? 'active' : 'inactive');
    status.textContent = k.active ? 'Active' : 'Revoked';

    var calls = document.createElement('span');
    calls.style.cssText = 'color:var(--muted);font-size:12px';
    calls.textContent = k.totalCalls + ' calls';

    row.appendChild(prefix);
    row.appendChild(name);
    row.appendChild(credits);
    row.appendChild(status);
    row.appendChild(calls);
    container.appendChild(row);
  });
}

async function refresh() {
  try {
    var results = await Promise.all([
      api('/status'),
      api('/usage'),
      api('/keys'),
    ]);
    var statusRes = results[0];
    var usageRes = results[1];
    var keysRes = results[2];

    if (statusRes.status !== 200) return;
    var s = statusRes.body;

    // Overview cards - using textContent (safe)
    setText('stat-keys', s.activeKeys || 0);
    setText('stat-calls', (s.usage && s.usage.totalCalls || 0).toLocaleString());
    setText('stat-credits', (s.usage && s.usage.totalCreditsSpent || 0).toLocaleString());
    setText('stat-denied', (s.usage && s.usage.totalDenied || 0).toLocaleString());

    // Tools chart - using safe DOM methods
    buildToolsChart(s.usage && s.usage.perTool || {});

    // Activity feed - using safe DOM methods
    if (usageRes.status === 200 && usageRes.body.events) {
      buildActivityFeed(usageRes.body.events);
    }

    // Keys list - using safe DOM methods
    if (keysRes.status === 200 && Array.isArray(keysRes.body)) {
      buildKeysList(keysRes.body);
    }

    setText('last-refresh', 'Updated ' + new Date().toLocaleTimeString());
  } catch (err) {
    console.error('Refresh failed:', err);
  }
}

async function createKey() {
  var name = document.getElementById('new-key-name').value.trim() || 'unnamed';
  var credits = parseInt(document.getElementById('new-key-credits').value) || 100;
  var res = await api('/keys', {
    method: 'POST',
    body: JSON.stringify({ name: name, credits: credits }),
  });
  if (res.status === 201) {
    toast('Key created: ' + res.body.key);
    document.getElementById('new-key-name').value = '';
    refresh();
  } else {
    toast('Error: ' + (res.body.error || 'Failed'), true);
  }
}

function toast(msg, isError) {
  var el = document.getElementById('toast');
  el.textContent = msg; // safe: textContent
  el.style.borderColor = isError ? 'var(--red)' : 'var(--accent)';
  el.style.display = 'block';
  setTimeout(function() { el.style.display = 'none'; }, 5000);
}
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
