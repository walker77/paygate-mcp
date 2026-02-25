// ─── Terminal Typing Animation ───────────────────────────────────

const COMMAND = 'npx paygate-mcp wrap --server "npx @mcp/server-fs /tmp"';

// Output lines built with safe DOM methods
const OUTPUT_TEXT = [
  '',
  '  +---------------------------------------------+',
  '  |  PayGate MCP v0.8.0 -- Server Running        |',
  '  +---------------------------------------------+',
  '  |  Endpoint:  http://localhost:3402             |',
  '  |  Admin Key: admin_7f3a9b...                  |',
  '  |  Pricing:   1 credit per call                |',
  '  |  Rate:      60 calls/min                     |',
  '  |  ACL:       enabled                          |',
  '  +---------------------------------------------+',
];

let charIndex = 0;
const cmdEl = document.getElementById('typed-cmd');
const cursorEl = document.getElementById('cursor');
const outputEl = document.getElementById('terminal-output');

function typeCommand() {
  if (charIndex < COMMAND.length) {
    cmdEl.textContent += COMMAND[charIndex];
    charIndex++;
    setTimeout(typeCommand, 28 + Math.random() * 40);
  } else {
    // Done typing — show output after a beat
    cursorEl.style.display = 'none';
    setTimeout(showOutput, 400);
  }
}

function showOutput() {
  // Build output safely using textContent
  const pre = document.createElement('pre');
  pre.textContent = OUTPUT_TEXT.join('\n');
  pre.style.margin = '0';
  pre.style.fontFamily = 'inherit';
  pre.style.fontSize = 'inherit';
  pre.style.lineHeight = '1.5';
  pre.style.color = '#00e68a';
  outputEl.appendChild(pre);
  outputEl.classList.add('visible');
}

// Start after page loads with a small delay
setTimeout(typeCommand, 800);

// ─── Copy Helpers ────────────────────────────────────────────────

function copyInstall() {
  navigator.clipboard.writeText('npx paygate-mcp wrap --server "your-mcp-server"').then(function() {
    showCopied();
  });
}

function showCopied() {
  var btns = document.querySelectorAll('.copy-btn');
  btns.forEach(function(btn) {
    var svg = btn.querySelector('svg');
    if (svg) svg.style.display = 'none';
    var msg = document.createElement('span');
    msg.textContent = 'copied!';
    msg.style.color = 'var(--accent)';
    msg.style.fontSize = '0.78rem';
    msg.style.fontFamily = 'var(--font-body)';
    msg.className = 'copy-msg';
    btn.appendChild(msg);
    setTimeout(function() {
      var m = btn.querySelector('.copy-msg');
      if (m) m.remove();
      if (svg) svg.style.display = '';
    }, 1500);
  });
}

function copyCode(btn) {
  var code = btn.closest('.code-block').querySelector('code').textContent;
  navigator.clipboard.writeText(code).then(function() {
    var orig = btn.textContent;
    btn.textContent = 'copied!';
    btn.style.color = 'var(--accent)';
    setTimeout(function() {
      btn.textContent = orig;
      btn.style.color = '';
    }, 1500);
  });
}

// ─── Intersection Observer for scroll animations ─────────────────

var observerOptions = {
  threshold: 0.1,
  rootMargin: '0px 0px -40px 0px'
};

var observer = new IntersectionObserver(function(entries) {
  entries.forEach(function(entry) {
    if (entry.isIntersecting) {
      entry.target.style.opacity = '1';
      entry.target.style.transform = 'translateY(0)';
      observer.unobserve(entry.target);
    }
  });
}, observerOptions);

// Observe feature cards and steps
document.addEventListener('DOMContentLoaded', function() {
  var animElements = document.querySelectorAll('.feature-card, .step, .api-table-wrap');
  animElements.forEach(function(el, i) {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    el.style.transition = 'opacity 0.5s ease ' + (i * 0.06) + 's, transform 0.5s ease ' + (i * 0.06) + 's';
    observer.observe(el);
  });
});
