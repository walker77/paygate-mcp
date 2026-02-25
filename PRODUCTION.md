# PayGate MCP — Production Deployment Guide

## Quick Start (5 minutes)

### 1. Publish to npm

```bash
cd packages/paygate-mcp

# Login to npm (one-time)
npm login

# Publish
npm publish --access public
```

After publishing, anyone can run:
```bash
npx @paygate/mcp wrap --server "npx @modelcontextprotocol/server-filesystem /tmp"
```

### 2. Verify it works

```bash
# Terminal 1: Start the gated server
npx @paygate/mcp wrap --server "npx @modelcontextprotocol/server-filesystem /tmp" --port 3402

# Terminal 2: Test it
# Create an API key
curl -X POST http://localhost:3402/keys \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: <admin-key-from-terminal-1>" \
  -d '{"name": "test-client", "credits": 100}'

# Use the key to call a tool
curl -X POST http://localhost:3402/mcp \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <key-from-above>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"/tmp/test.txt"}}}'

# Check status
curl http://localhost:3402/status \
  -H "X-Admin-Key: <admin-key>"
```

---

## Production Deployment Options

### Option A: Railway / Render / Fly.io (Recommended — Easiest)

**Railway:**
```bash
# Install Railway CLI
npm i -g @railway/cli

# Login and init
railway login
railway init

# Set environment variables
railway variables set PAYGATE_SERVER_CMD="npx @modelcontextprotocol/server-filesystem /data"
railway variables set PAYGATE_PORT=3402
railway variables set PAYGATE_ADMIN_KEY="admin_<generate-a-strong-key>"

# Deploy
railway up
```

**Dockerfile (for any container platform):**
```dockerfile
FROM node:20-alpine
WORKDIR /app
RUN npm install -g @paygate/mcp
EXPOSE 3402
CMD ["paygate-mcp", "wrap", \
     "--server", "npx @modelcontextprotocol/server-filesystem /data", \
     "--port", "3402", \
     "--admin-key", "$PAYGATE_ADMIN_KEY"]
```

### Option B: VPS (DigitalOcean / Hetzner)

```bash
# On the server
npm install -g @paygate/mcp pm2

# Create ecosystem file
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'paygate-mcp',
    script: 'paygate-mcp',
    args: 'wrap --server "npx @modelcontextprotocol/server-filesystem /data" --port 3402 --admin-key $PAYGATE_ADMIN_KEY',
    env: {
      NODE_ENV: 'production',
      PAYGATE_ADMIN_KEY: 'admin_<your-key-here>'
    }
  }]
};
EOF

# Start with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # Auto-restart on reboot
```

**Nginx reverse proxy (HTTPS):**
```nginx
server {
    listen 443 ssl;
    server_name api.payproof.dev;

    ssl_certificate /etc/letsencrypt/live/api.payproof.dev/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.payproof.dev/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3402;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Option C: Serverless (AWS Lambda / Vercel)

Not recommended for v1 — PayGate wraps a stdio subprocess, which needs a persistent process. Serverless cold starts would kill performance.

---

## Distribution Strategy (AI-Driven, Zero Promotion)

### npm Registry (Primary)
Publishing to npm makes it discoverable by:
- `npx @paygate/mcp` — instant usage
- npm search for "mcp monetize"
- Package analytics track adoption

### MCP Registries (Secondary)
Register on MCP server directories so AI agents find it:

1. **Smithery** (smithery.ai) — Submit server listing
2. **mcp.so** — Community MCP directory
3. **Awesome MCP Servers** — GitHub list
4. **Glama** (glama.ai) — MCP marketplace

### GitHub Discovery
- Good README with clear examples
- Proper package.json keywords
- GitHub topics: `mcp`, `monetize`, `ai-agent`, `billing`

---

## Revenue Model

### Phase 1: Open Source Tool (NOW)
- Free to use, MIT licensed
- Builds trust and adoption
- Users self-host

### Phase 2: Managed Hosting (After 100+ users)
- Hosted PayGate: `payproof.dev/hosted`
- Users don't self-host, we run the proxy
- 5% fee on all credits processed
- Stripe integration for real payments

### Phase 3: Marketplace (After 1000+ users)
- MCP server marketplace
- Server authors list their tools
- Buyers pay per-call, we take 10-15%

---

## Before You Ship Checklist

- [ ] `npm login` (you need to do this manually)
- [ ] `npm publish --access public`
- [ ] Verify: `npx @paygate/mcp --version` returns `0.1.0`
- [ ] Verify: `npx @paygate/mcp wrap --server "node -e 'process.stdin.resume()'" --shadow` starts
- [ ] Register domain: `payproof.dev` (or your choice)
- [ ] Submit to Smithery, mcp.so, awesome-mcp-servers
- [ ] Set up GitHub repository description and topics

---

## Security Notes for Production

| Threat | Mitigation | Status |
|--------|-----------|--------|
| Negative credit drain | Input sanitization — floors to 0, rejects ≤0 | ✅ Fixed |
| Body size DoS | 1MB request body limit | ✅ Fixed |
| Rate limit bypass | Per-key sliding window, concurrent-safe | ✅ Tested |
| Admin key leak | Not in responses, not in logs | ✅ Tested |
| Key enumeration | Keys masked in list, cryptographic generation | ✅ Tested |
| Float precision abuse | All credits floored to integers | ✅ Fixed |
| Path traversal | URL split on `?`, route matching only | ✅ Tested |
| Prototype pollution | Standard JSON.parse, no Object.assign from user | ✅ Tested |
| Stack trace leaks | Caught errors return generic messages | ✅ Tested |
| SQL/command injection | No SQL, no shell exec from user input | ✅ N/A |

### Known Limitations (v0.1.0)
1. **In-memory store** — All data lost on restart. Production needs Redis/Postgres.
2. **Single process** — No horizontal scaling. Use PM2 cluster mode for multi-core.
3. **No TLS** — Use Nginx/Caddy for HTTPS termination.
4. **No webhook** — No payment confirmation callbacks yet.
5. **No usage export** — Dashboard is read-only, no CSV/API export.

---

## Monitoring

```bash
# Check server health
curl http://localhost:3402/

# Full dashboard
curl http://localhost:3402/status -H "X-Admin-Key: <key>"

# PM2 monitoring
pm2 monit
pm2 logs paygate-mcp
```
