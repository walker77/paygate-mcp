import { PayGateServer } from '../src/server';

const serverCommand = process.execPath;
const serverArgs = ['-e', 'process.stdin.resume();process.stdin.on("data",d=>{const j=JSON.parse(d);if(j.method==="initialize")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{protocolVersion:"2025-01-01",capabilities:{tools:{}},serverInfo:{name:"echo",version:"1.0"}}})+`\\n`);if(j.method==="tools/list")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{tools:[{name:"echo",inputSchema:{type:"object"}}]}})+`\\n`);if(j.method==="tools/call")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{content:[{type:"text",text:"ok"}]}})+`\\n`)})'];

describe('Portal and Readiness', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeEach(async () => {
    server = new PayGateServer({ serverCommand, serverArgs, port: 0 });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  }, 30_000);

  afterEach(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  // ─── /portal ───

  describe('GET /portal', () => {
    it('returns HTML page', async () => {
      const res = await fetch(`http://localhost:${port}/portal`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const body = await res.text();
      expect(body).toContain('API Portal');
      expect(body).toContain('api-key-input');
    });

    it('includes CSP header', async () => {
      const res = await fetch(`http://localhost:${port}/portal`);
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    });

    it('supports HEAD method', async () => {
      const res = await fetch(`http://localhost:${port}/portal`, { method: 'HEAD' });
      expect(res.status).toBe(200);
    });

    it('is rate-limited', async () => {
      const srv = new PayGateServer({ serverCommand, serverArgs, port: 0, publicRateLimit: 2 });
      const info = await srv.start();
      try {
        await fetch(`http://localhost:${info.port}/portal`);
        await fetch(`http://localhost:${info.port}/portal`);
        const res = await fetch(`http://localhost:${info.port}/portal`);
        expect(res.status).toBe(429);
      } finally {
        await srv.gracefulStop(5_000);
      }
    });

    it('includes server name in title', async () => {
      const res = await fetch(`http://localhost:${port}/portal`);
      const body = await res.text();
      expect(body).toContain('PayGate MCP');
    });

    it('contains credit balance UI elements', async () => {
      const res = await fetch(`http://localhost:${port}/portal`);
      const body = await res.text();
      expect(body).toContain('Credits Remaining');
      expect(body).toContain('Total Calls');
      expect(body).toContain('Available Tools');
    });
  });

  // ─── /ready ───

  describe('GET /ready', () => {
    it('returns 200 when ready', async () => {
      const res = await fetch(`http://localhost:${port}/ready`);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.ready).toBe(true);
      expect(body.checks.notDraining).toBe(true);
      expect(body.checks.notMaintenance).toBe(true);
      expect(body.checks.backendConnected).toBe(true);
      expect(body.timestamp).toBeDefined();
    });

    it('returns 503 during maintenance', async () => {
      // Enable maintenance mode
      await fetch(`http://localhost:${port}/maintenance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
        body: JSON.stringify({ enabled: true }),
      });

      const res = await fetch(`http://localhost:${port}/ready`);
      expect(res.status).toBe(503);
      const body: any = await res.json();
      expect(body.ready).toBe(false);
      expect(body.checks.notMaintenance).toBe(false);
    });

    it('supports HEAD method', async () => {
      const res = await fetch(`http://localhost:${port}/ready`, { method: 'HEAD' });
      expect(res.status).toBe(200);
    });

    it('is rate-limited', async () => {
      const srv = new PayGateServer({ serverCommand, serverArgs, port: 0, publicRateLimit: 2 });
      const info = await srv.start();
      try {
        await fetch(`http://localhost:${info.port}/ready`);
        await fetch(`http://localhost:${info.port}/ready`);
        const res = await fetch(`http://localhost:${info.port}/ready`);
        expect(res.status).toBe(429);
      } finally {
        await srv.gracefulStop(5_000);
      }
    });

    it('includes all check fields', async () => {
      const res = await fetch(`http://localhost:${port}/ready`);
      const body: any = await res.json();
      expect(body.checks).toHaveProperty('notDraining');
      expect(body.checks).toHaveProperty('notMaintenance');
      expect(body.checks).toHaveProperty('backendConnected');
    });
  });

  // ─── Dashboard v2 ───

  describe('GET /dashboard (v2)', () => {
    it('returns tabbed HTML dashboard', async () => {
      const res = await fetch(`http://localhost:${port}/dashboard`);
      expect(res.status).toBe(200);
      const body = await res.text();
      // v2 tabs
      expect(body).toContain('tab-overview');
      expect(body).toContain('tab-keys');
      expect(body).toContain('tab-analytics');
      expect(body).toContain('tab-system');
    });

    it('has key management actions (suspend, resume, revoke)', async () => {
      const res = await fetch(`http://localhost:${port}/dashboard`);
      const body = await res.text();
      expect(body).toContain('Suspend');
      expect(body).toContain('Resume');
      expect(body).toContain('Revoke');
      expect(body).toContain('Top Up');
    });

    it('has create key modal', async () => {
      const res = await fetch(`http://localhost:${port}/dashboard`);
      const body = await res.text();
      expect(body).toContain('create-key-modal');
      expect(body).toContain('modal-key-name');
      expect(body).toContain('modal-key-credits');
    });

    it('has system health panel', async () => {
      const res = await fetch(`http://localhost:${port}/dashboard`);
      const body = await res.text();
      expect(body).toContain('sys-version');
      expect(body).toContain('sys-inflight');
      expect(body).toContain('sys-maintenance');
    });

    it('has notifications panel', async () => {
      const res = await fetch(`http://localhost:${port}/dashboard`);
      const body = await res.text();
      expect(body).toContain('notif-panel');
    });

    it('has webhook stats in analytics', async () => {
      const res = await fetch(`http://localhost:${port}/dashboard`);
      const body = await res.text();
      expect(body).toContain('Webhook Health');
      expect(body).toContain('webhook-stats');
    });
  });

  // ─── Root listing ───

  describe('Root listing', () => {
    it('includes portal endpoint', async () => {
      const res = await fetch(`http://localhost:${port}/`, {
        headers: { 'X-Admin-Key': adminKey },
      });
      const body: any = await res.json();
      expect(body.endpoints.portal).toBeDefined();
      expect(body.endpoints.portal).toContain('/portal');
    });

    it('includes ready endpoint', async () => {
      const res = await fetch(`http://localhost:${port}/`, {
        headers: { 'X-Admin-Key': adminKey },
      });
      const body: any = await res.json();
      expect(body.endpoints.ready).toBeDefined();
      expect(body.endpoints.ready).toContain('/ready');
    });
  });

  // ─── OpenAPI spec ───

  describe('OpenAPI spec', () => {
    it('includes /portal', async () => {
      const res = await fetch(`http://localhost:${port}/openapi.json`);
      const body: any = await res.json();
      expect(body.paths['/portal']).toBeDefined();
    });

    it('includes /ready', async () => {
      const res = await fetch(`http://localhost:${port}/openapi.json`);
      const body: any = await res.json();
      expect(body.paths['/ready']).toBeDefined();
    });
  });

  // ─── Robots.txt ───

  describe('robots.txt', () => {
    it('disallows /portal', async () => {
      const res = await fetch(`http://localhost:${port}/robots.txt`);
      const body = await res.text();
      expect(body).toContain('Disallow: /portal');
    });
  });
});
