/**
 * Self-service Portal — Embedded HTML portal for API key holders.
 *
 * Served at GET /portal. API key entered via browser prompt.
 * Uses only inline CSS and vanilla JS — no external dependencies.
 * All dynamic content is escaped to prevent XSS.
 *
 * Features:
 *   - Credit balance and usage overview
 *   - Recent tool call activity feed
 *   - Rate limit status
 *   - Available tools listing
 *   - Spending velocity and depletion forecast
 */

export function getPortalHtml(serverName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(serverName)} — API Portal</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0f;--surface:#12121a;--border:#1e1e2e;--text:#e0e0e8;--muted:#6b6b80;
--accent:#6366f1;--accent2:#818cf8;--green:#22c55e;--red:#ef4444;--yellow:#eab308;
--font:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;--mono:'SF Mono',Monaco,Consolas,monospace}
body{background:var(--bg);color:var(--text);font-family:var(--font);min-height:100vh}
.login{display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px}
.login h1{font-size:24px;font-weight:600;color:var(--accent2)}
.login p{font-size:14px;color:var(--muted);max-width:360px;text-align:center}
.login input{background:var(--surface);border:1px solid var(--border);color:var(--text);padding:12px 16px;
border-radius:8px;font-size:14px;width:360px;font-family:var(--mono)}
.login input:focus{outline:none;border-color:var(--accent)}
.login button{background:var(--accent);color:#fff;border:none;padding:12px 24px;border-radius:8px;
font-size:14px;cursor:pointer;font-weight:500}
.login button:hover{background:var(--accent2)}
.login .error{color:var(--red);font-size:13px}
header{background:var(--surface);border-bottom:1px solid var(--border);padding:16px 24px;
display:flex;align-items:center;justify-content:space-between}
header h1{font-size:18px;font-weight:600;display:flex;align-items:center;gap:8px}
header h1 span{color:var(--accent2)}
.header-meta{display:flex;align-items:center;gap:12px;font-size:13px;color:var(--muted)}
main{max-width:960px;margin:0 auto;padding:24px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px}
.card-label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px}
.card-value{font-size:28px;font-weight:700;font-family:var(--mono)}
.card-value.green{color:var(--green)}
.card-value.accent{color:var(--accent2)}
.card-value.red{color:var(--red)}
.card-value.yellow{color:var(--yellow)}
.card-sub{font-size:12px;color:var(--muted);margin-top:4px;font-family:var(--mono)}
.progress-bar{margin-top:12px;height:6px;background:var(--bg);border-radius:3px;overflow:hidden}
.progress-fill{height:100%;border-radius:3px;transition:width 0.5s ease}
.progress-fill.green{background:var(--green)}
.progress-fill.yellow{background:var(--yellow)}
.progress-fill.red{background:var(--red)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}
@media(max-width:768px){.grid2{grid-template-columns:1fr}}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}
.panel h2{font-size:14px;font-weight:600;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.feed{max-height:320px;overflow-y:auto}
.feed-item{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px}
.feed-item:last-child{border-bottom:none}
.feed-badge{padding:2px 8px;border-radius:4px;font-size:11px;font-family:var(--mono);font-weight:500;white-space:nowrap}
.feed-badge.allow{background:#22c55e20;color:var(--green)}
.feed-badge.deny{background:#ef444420;color:var(--red)}
.feed-tool{font-family:var(--mono);color:var(--accent2);min-width:100px}
.feed-credits{color:var(--yellow);font-family:var(--mono);font-size:12px}
.feed-time{color:var(--muted);font-size:12px;margin-left:auto;white-space:nowrap}
.tool-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px}
.tool-chip{background:var(--bg);border:1px solid var(--border);padding:8px 12px;border-radius:8px;
font-family:var(--mono);font-size:13px;color:var(--accent2)}
.info-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px}
.info-row:last-child{border-bottom:none}
.info-label{color:var(--muted)}
.info-value{font-family:var(--mono)}
.warning{background:#eab30810;border:1px solid #eab30830;border-radius:8px;padding:12px 16px;
color:var(--yellow);font-size:13px;margin-bottom:16px;display:none}
.danger{background:#ef444410;border:1px solid #ef444430;border-radius:8px;padding:12px 16px;
color:var(--red);font-size:13px;margin-bottom:16px;display:none}
.buy-bar{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 20px;
margin-bottom:16px;display:none;align-items:center;gap:12px;flex-wrap:wrap}
.buy-bar h3{font-size:14px;font-weight:600;white-space:nowrap}
.pkg-btn{background:var(--bg);border:1px solid var(--border);color:var(--text);padding:8px 16px;
border-radius:8px;font-size:13px;cursor:pointer;font-family:var(--mono);transition:all 0.2s}
.pkg-btn:hover{border-color:var(--accent);color:var(--accent2)}
.pkg-btn .pkg-price{color:var(--green);font-weight:600}
.pkg-btn .pkg-credits{color:var(--accent2)}
#app{display:none}
</style>
</head>
<body>

<div class="login" id="login-screen">
  <h1>API Portal</h1>
  <p>Check your credits, usage, rate limits, and available tools. Enter your API key below.</p>
  <input type="password" id="api-key-input" placeholder="Enter your API key (pg_...)" autofocus>
  <button onclick="doLogin()">View Portal</button>
  <div class="error" id="login-error"></div>
</div>

<div id="app">
  <header>
    <h1><span>&#x1f511;</span> <span id="key-name">API Portal</span></h1>
    <div class="header-meta">
      <span id="key-prefix"></span>
      <span id="last-refresh"></span>
    </div>
  </header>

  <main>
    <div class="danger" id="alert-exhausted">Credits exhausted. Tool calls will be denied until credits are added.</div>
    <div class="warning" id="alert-low">Credits are running low. Contact your administrator for a top-up.</div>

    <div class="buy-bar" id="buy-credits-bar">
      <h3>&#x1f4b3; Buy Credits</h3>
      <div id="packages-list" style="display:flex;gap:8px;flex-wrap:wrap"></div>
    </div>

    <div class="cards">
      <div class="card">
        <div class="card-label">Credits Remaining</div>
        <div class="card-value green" id="stat-credits">0</div>
        <div class="card-sub" id="stat-credits-sub"></div>
        <div class="progress-bar"><div class="progress-fill green" id="credit-bar" style="width:100%"></div></div>
      </div>
      <div class="card">
        <div class="card-label">Total Calls</div>
        <div class="card-value accent" id="stat-calls">0</div>
        <div class="card-sub" id="stat-calls-sub"></div>
      </div>
      <div class="card">
        <div class="card-label">Credits Spent</div>
        <div class="card-value yellow" id="stat-spent">0</div>
      </div>
      <div class="card">
        <div class="card-label">Denied Calls</div>
        <div class="card-value red" id="stat-denied">0</div>
      </div>
    </div>

    <div class="grid2">
      <div class="panel">
        <h2>&#x26a1; Recent Activity</h2>
        <div class="feed" id="activity-feed"></div>
        <div id="feed-empty" style="color:var(--muted);font-size:13px">No activity yet.</div>
      </div>

      <div class="panel">
        <h2>&#x2139;&#xfe0f; Key Details</h2>
        <div id="key-details"></div>
      </div>
    </div>

    <div class="panel">
      <h2>&#x1f527; Available Tools</h2>
      <div class="tool-grid" id="tool-list"></div>
      <div id="tools-empty" style="color:var(--muted);font-size:13px">No tools loaded yet.</div>
    </div>
  </main>
</div>

<script>
let API_KEY = '';
const BASE = window.location.origin;

function setText(id, text) {
  var el = document.getElementById(id);
  if (el) el.textContent = String(text);
}

async function apiFetch(path) {
  var res = await fetch(BASE + path, {
    headers: { 'X-API-Key': API_KEY },
  });
  var text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch(e) { return { status: res.status, body: text }; }
}

function doLogin() {
  API_KEY = document.getElementById('api-key-input').value.trim();
  if (!API_KEY) return;
  apiFetch('/balance').then(function(r) {
    if (r.status === 200) {
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('app').style.display = 'block';
      refresh();
      loadPackages();
      setInterval(refresh, 30000);
    } else {
      document.getElementById('login-error').textContent = 'Invalid API key or balance check failed.';
    }
  }).catch(function() {
    document.getElementById('login-error').textContent = 'Connection failed.';
  });
}

document.getElementById('api-key-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') doLogin();
});

function buildActivityFeed(events) {
  var feedEl = document.getElementById('activity-feed');
  var emptyEl = document.getElementById('feed-empty');
  feedEl.textContent = '';

  var items = (events || []).slice(-30).reverse();
  if (items.length === 0) { emptyEl.style.display = 'block'; return; }
  emptyEl.style.display = 'none';

  items.forEach(function(e) {
    var item = document.createElement('div');
    item.className = 'feed-item';

    var badge = document.createElement('span');
    badge.className = 'feed-badge ' + (e.status === 'allowed' ? 'allow' : 'deny');
    badge.textContent = e.status === 'allowed' ? 'OK' : 'DENY';

    var tool = document.createElement('span');
    tool.className = 'feed-tool';
    tool.textContent = e.tool;

    item.appendChild(badge);
    item.appendChild(tool);

    if (e.credits > 0) {
      var cr = document.createElement('span');
      cr.className = 'feed-credits';
      cr.textContent = '-' + e.credits;
      item.appendChild(cr);
    }

    if (e.denyReason) {
      var reason = document.createElement('span');
      reason.style.cssText = 'color:var(--muted);font-size:11px';
      reason.textContent = e.denyReason;
      item.appendChild(reason);
    }

    var time = document.createElement('span');
    time.className = 'feed-time';
    time.textContent = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '';
    item.appendChild(time);

    feedEl.appendChild(item);
  });
}

function buildKeyDetails(balance) {
  var container = document.getElementById('key-details');
  container.textContent = '';

  var rows = [
    ['Key Name', balance.name || 'unnamed'],
    ['Key Prefix', balance.keyPrefix || API_KEY.slice(0, 7) + '...'],
    ['Status', balance.active === false ? 'Revoked' : balance.suspended ? 'Suspended' : 'Active'],
    ['Credits Remaining', String(balance.credits)],
    ['Total Spent', String(balance.totalSpent || 0)],
    ['Total Calls', String(balance.totalCalls || 0)],
  ];

  if (balance.expiresAt) {
    var expDate = new Date(balance.expiresAt);
    var msLeft = expDate.getTime() - Date.now();
    var daysLeft = Math.max(0, Math.round(msLeft / 86400000 * 10) / 10);
    rows.push(['Expires', expDate.toLocaleDateString() + ' (' + daysLeft + 'd left)']);
  }

  if (balance.rateLimit) {
    rows.push(['Rate Limit', balance.rateLimit + '/min']);
  }
  if (balance.dailyQuota) {
    rows.push(['Daily Quota', String(balance.dailyQuota)]);
  }
  if (balance.namespace) {
    rows.push(['Namespace', balance.namespace]);
  }

  rows.forEach(function(r) {
    var row = document.createElement('div');
    row.className = 'info-row';

    var label = document.createElement('span');
    label.className = 'info-label';
    label.textContent = r[0];

    var value = document.createElement('span');
    value.className = 'info-value';
    value.textContent = r[1];

    row.appendChild(label);
    row.appendChild(value);
    container.appendChild(row);
  });
}

function buildToolsList(tools) {
  var container = document.getElementById('tool-list');
  var emptyEl = document.getElementById('tools-empty');
  container.textContent = '';

  if (!tools || tools.length === 0) { emptyEl.style.display = 'block'; return; }
  emptyEl.style.display = 'none';

  tools.forEach(function(t) {
    var chip = document.createElement('div');
    chip.className = 'tool-chip';
    chip.textContent = typeof t === 'string' ? t : (t.name || t.tool || String(t));
    container.appendChild(chip);
  });
}

async function loadPackages() {
  try {
    var res = await fetch(BASE + '/stripe/packages');
    if (res.status !== 200) return;
    var data = await res.json();
    if (!data.configured || !data.packages || data.packages.length === 0) return;

    var bar = document.getElementById('buy-credits-bar');
    var list = document.getElementById('packages-list');
    bar.style.display = 'flex';
    list.textContent = '';

    data.packages.forEach(function(pkg) {
      var btn = document.createElement('button');
      btn.className = 'pkg-btn';
      btn.onclick = function() { buyPackage(pkg.id); };

      var price = document.createElement('span');
      price.className = 'pkg-price';
      price.textContent = '$' + (pkg.priceInCents / 100).toFixed(2);

      var sep = document.createTextNode(' — ');

      var credits = document.createElement('span');
      credits.className = 'pkg-credits';
      credits.textContent = pkg.credits.toLocaleString() + ' credits';

      btn.appendChild(price);
      btn.appendChild(sep);
      btn.appendChild(credits);
      list.appendChild(btn);
    });
  } catch(e) { console.log('No packages:', e); }
}

async function buyPackage(packageId) {
  try {
    var res = await fetch(BASE + '/stripe/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
      body: JSON.stringify({ packageId: packageId }),
    });
    var data = await res.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      alert('Failed to create checkout session: ' + (data.error || 'Unknown error'));
    }
  } catch(e) {
    alert('Checkout failed: ' + e.message);
  }
}

async function refresh() {
  try {
    var balanceRes = await apiFetch('/balance');
    if (balanceRes.status !== 200) return;
    var b = balanceRes.body;

    setText('key-name', b.name || 'API Portal');
    setText('key-prefix', b.keyPrefix || '');

    // Credits
    var remaining = b.credits || 0;
    var totalAlloc = remaining + (b.totalSpent || 0);
    var pct = totalAlloc > 0 ? Math.round((remaining / totalAlloc) * 100) : 100;
    setText('stat-credits', remaining.toLocaleString());
    setText('stat-credits-sub', pct + '% remaining');

    var bar = document.getElementById('credit-bar');
    bar.style.width = pct + '%';
    bar.className = 'progress-fill ' + (pct > 30 ? 'green' : pct > 10 ? 'yellow' : 'red');

    // Alerts
    var exhausted = document.getElementById('alert-exhausted');
    var low = document.getElementById('alert-low');
    exhausted.style.display = remaining <= 0 ? 'block' : 'none';
    low.style.display = remaining > 0 && pct <= 20 ? 'block' : 'none';

    // Stats
    setText('stat-calls', (b.totalCalls || 0).toLocaleString());
    setText('stat-calls-sub', (b.allowedCalls || 0) + ' allowed / ' + (b.deniedCalls || 0) + ' denied');
    setText('stat-spent', (b.totalSpent || 0).toLocaleString());
    setText('stat-denied', (b.deniedCalls || 0).toLocaleString());

    // Key details
    buildKeyDetails(b);

    // Tools — try to get available tools via /tools/available or from balance
    if (b.tools) {
      buildToolsList(b.tools);
    } else {
      try {
        var toolsRes = await apiFetch('/tools/available');
        if (toolsRes.status === 200 && toolsRes.body.tools) {
          buildToolsList(toolsRes.body.tools);
        }
      } catch(e) {}
    }

    // Activity — try request log filtered by this key
    try {
      var activityRes = await apiFetch('/requests?limit=30');
      if (activityRes.status === 200 && activityRes.body.entries) {
        buildActivityFeed(activityRes.body.entries);
      }
    } catch(e) {}

    setText('last-refresh', 'Updated ' + new Date().toLocaleTimeString());
  } catch (err) {
    console.error('Refresh failed:', err);
  }
}
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
