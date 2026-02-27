import { PayGateServer } from '../src/server';

const serverCommand = process.execPath;
const serverArgs = ['-e', 'process.stdin.resume();process.stdin.on("data",d=>{const j=JSON.parse(d);if(j.method==="initialize")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{protocolVersion:"2025-01-01",capabilities:{tools:{}},serverInfo:{name:"echo",version:"1.0"}}})+`\\n`);if(j.method==="tools/list")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{tools:[{name:"echo",inputSchema:{type:"object"}}]}})+`\\n`);if(j.method==="tools/call")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{content:[{type:"text",text:"ok"}]}})+`\\n`)})'];

describe('v9.1.0 Features', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;
  let testKey: string;

  beforeEach(async () => {
    server = new PayGateServer({ serverCommand, serverArgs, port: 0 });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;

    // Create a test API key
    const res = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'test-key', credits: 1000 }),
    });
    const body: any = await res.json();
    testKey = body.key;
  }, 30_000);

  afterEach(async () => {
    await server.gracefulStop(5_000);
  }, 30_000);

  // ─── Self-Service Key Rotation ───

  describe('POST /portal/rotate', () => {
    it('rotates key and returns new key', async () => {
      const res = await fetch(`http://localhost:${port}/portal/rotate`, {
        method: 'POST',
        headers: { 'X-API-Key': testKey },
      });
      expect(res.status).toBe(200);

      const body: any = await res.json();
      expect(body.newKey).toBeDefined();
      expect(body.newKey).not.toBe(testKey);
      expect(body.credits).toBe(1000);
      expect(body.name).toBe('test-key');
    });

    it('new key works, old key does not', async () => {
      const rotateRes = await fetch(`http://localhost:${port}/portal/rotate`, {
        method: 'POST',
        headers: { 'X-API-Key': testKey },
      });
      const { newKey } = await rotateRes.json() as any;

      // New key should work
      const balRes = await fetch(`http://localhost:${port}/balance`, {
        headers: { 'X-API-Key': newKey },
      });
      expect(balRes.status).toBe(200);

      // Old key should be invalid
      const oldRes = await fetch(`http://localhost:${port}/balance`, {
        headers: { 'X-API-Key': testKey },
      });
      expect(oldRes.status).toBe(404);
    });

    it('requires API key', async () => {
      const res = await fetch(`http://localhost:${port}/portal/rotate`, {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });

    it('rate limits rotation to once per 5 min', async () => {
      // First rotation should succeed
      const first = await fetch(`http://localhost:${port}/portal/rotate`, {
        method: 'POST',
        headers: { 'X-API-Key': testKey },
      });
      expect(first.status).toBe(200);
      const { newKey } = await first.json() as any;

      // Second rotation with new key should be rate limited
      const second = await fetch(`http://localhost:${port}/portal/rotate`, {
        method: 'POST',
        headers: { 'X-API-Key': newKey },
      });
      expect(second.status).toBe(429);
    });

    it('rejects GET method', async () => {
      const res = await fetch(`http://localhost:${port}/portal/rotate`, {
        headers: { 'X-API-Key': testKey },
      });
      expect(res.status).toBe(405);
    });

    it('appears in OpenAPI spec', async () => {
      const res = await fetch(`http://localhost:${port}/openapi.json`);
      const body: any = await res.json();
      expect(body.paths['/portal/rotate']).toBeDefined();
      expect(body.paths['/portal/rotate'].post).toBeDefined();
    });

    it('appears in root listing', async () => {
      const res = await fetch(`http://localhost:${port}/`, {
        headers: { 'X-Admin-Key': adminKey },
      });
      const body: any = await res.json();
      expect(body.endpoints.portalRotate).toBeDefined();
    });
  });

  // ─── Credit History ───

  describe('GET /balance/history', () => {
    it('returns credit history for key', async () => {
      const res = await fetch(`http://localhost:${port}/balance/history`, {
        headers: { 'X-API-Key': testKey },
      });
      expect(res.status).toBe(200);

      const body: any = await res.json();
      expect(body.entries).toBeDefined();
      expect(Array.isArray(body.entries)).toBe(true);
      expect(body.total).toBeDefined();
      expect(body.velocity).toBeDefined();
      // Should have at least the initial credit allocation
      expect(body.entries.length).toBeGreaterThanOrEqual(1);
      expect(body.entries[0].type).toBe('initial');
      expect(body.entries[0].amount).toBe(1000);
    });

    it('includes velocity data', async () => {
      const res = await fetch(`http://localhost:${port}/balance/history`, {
        headers: { 'X-API-Key': testKey },
      });
      const body: any = await res.json();
      expect(body.velocity.creditsPerHour).toBeDefined();
      expect(body.velocity.creditsPerDay).toBeDefined();
      expect(body.velocity.callsPerDay).toBeDefined();
    });

    it('respects limit parameter', async () => {
      const res = await fetch(`http://localhost:${port}/balance/history?limit=1`, {
        headers: { 'X-API-Key': testKey },
      });
      const body: any = await res.json();
      expect(body.entries.length).toBeLessThanOrEqual(1);
    });

    it('requires API key', async () => {
      const res = await fetch(`http://localhost:${port}/balance/history`);
      expect(res.status).toBe(401);
    });

    it('rejects POST method', async () => {
      const res = await fetch(`http://localhost:${port}/balance/history`, {
        method: 'POST',
        headers: { 'X-API-Key': testKey },
      });
      expect(res.status).toBe(405);
    });

    it('reflects topup in history', async () => {
      // Top up the key
      await fetch(`http://localhost:${port}/topup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
        body: JSON.stringify({ key: testKey, credits: 500 }),
      });

      const res = await fetch(`http://localhost:${port}/balance/history`, {
        headers: { 'X-API-Key': testKey },
      });
      const body: any = await res.json();
      const topupEntry = body.entries.find((e: any) => e.type === 'topup');
      expect(topupEntry).toBeDefined();
      expect(topupEntry.amount).toBe(500);
    });

    it('appears in OpenAPI spec', async () => {
      const res = await fetch(`http://localhost:${port}/openapi.json`);
      const body: any = await res.json();
      expect(body.paths['/balance/history']).toBeDefined();
    });
  });

  // ─── Usage Alerts ───

  describe('/balance/alerts', () => {
    it('returns unconfigured by default', async () => {
      const res = await fetch(`http://localhost:${port}/balance/alerts`, {
        headers: { 'X-API-Key': testKey },
      });
      expect(res.status).toBe(200);

      const body: any = await res.json();
      expect(body.configured).toBe(false);
      expect(body.alert).toBeNull();
      expect(body.currentCredits).toBe(1000);
    });

    it('configures alert via POST', async () => {
      const res = await fetch(`http://localhost:${port}/balance/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': testKey },
        body: JSON.stringify({ lowCreditThreshold: 100 }),
      });
      expect(res.status).toBe(200);

      const body: any = await res.json();
      expect(body.configured).toBe(true);
      expect(body.alert.lowCreditThreshold).toBe(100);
      expect(body.alert.enabled).toBe(true);
    });

    it('reads back configured alert', async () => {
      // Configure
      await fetch(`http://localhost:${port}/balance/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': testKey },
        body: JSON.stringify({ lowCreditThreshold: 50 }),
      });

      // Read back
      const res = await fetch(`http://localhost:${port}/balance/alerts`, {
        headers: { 'X-API-Key': testKey },
      });
      const body: any = await res.json();
      expect(body.configured).toBe(true);
      expect(body.alert.lowCreditThreshold).toBe(50);
    });

    it('disables alert via POST enabled:false', async () => {
      // Configure first
      await fetch(`http://localhost:${port}/balance/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': testKey },
        body: JSON.stringify({ lowCreditThreshold: 100 }),
      });

      // Disable
      const res = await fetch(`http://localhost:${port}/balance/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': testKey },
        body: JSON.stringify({ enabled: false }),
      });
      const body: any = await res.json();
      expect(body.configured).toBe(false);
    });

    it('removes alert via DELETE', async () => {
      // Configure
      await fetch(`http://localhost:${port}/balance/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': testKey },
        body: JSON.stringify({ lowCreditThreshold: 100 }),
      });

      // Delete
      const res = await fetch(`http://localhost:${port}/balance/alerts`, {
        method: 'DELETE',
        headers: { 'X-API-Key': testKey },
      });
      expect(res.status).toBe(200);

      // Verify removed
      const check = await fetch(`http://localhost:${port}/balance/alerts`, {
        headers: { 'X-API-Key': testKey },
      });
      const body: any = await check.json();
      expect(body.configured).toBe(false);
    });

    it('rejects negative threshold', async () => {
      const res = await fetch(`http://localhost:${port}/balance/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': testKey },
        body: JSON.stringify({ lowCreditThreshold: -1 }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects non-HTTPS webhook URL', async () => {
      const res = await fetch(`http://localhost:${port}/balance/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': testKey },
        body: JSON.stringify({ lowCreditThreshold: 100, webhookUrl: 'http://insecure.com' }),
      });
      expect(res.status).toBe(400);
    });

    it('requires API key', async () => {
      const res = await fetch(`http://localhost:${port}/balance/alerts`);
      expect(res.status).toBe(401);
    });

    it('appears in OpenAPI spec', async () => {
      const res = await fetch(`http://localhost:${port}/openapi.json`);
      const body: any = await res.json();
      expect(body.paths['/balance/alerts']).toBeDefined();
      expect(body.paths['/balance/alerts'].get).toBeDefined();
      expect(body.paths['/balance/alerts'].post).toBeDefined();
      expect(body.paths['/balance/alerts'].delete).toBeDefined();
    });
  });

  // ─── Portal UI ───

  describe('Portal v9.1 UI', () => {
    it('portal includes credit history button', async () => {
      const res = await fetch(`http://localhost:${port}/portal`);
      const body = await res.text();
      expect(body).toContain('Credit History');
      expect(body).toContain('showHistory');
    });

    it('portal includes usage alerts button', async () => {
      const res = await fetch(`http://localhost:${port}/portal`);
      const body = await res.text();
      expect(body).toContain('Usage Alerts');
      expect(body).toContain('showAlertConfig');
    });

    it('portal includes rotate key button', async () => {
      const res = await fetch(`http://localhost:${port}/portal`);
      const body = await res.text();
      expect(body).toContain('Rotate Key');
      expect(body).toContain('confirmRotate');
    });

    it('portal includes rotation modal', async () => {
      const res = await fetch(`http://localhost:${port}/portal`);
      const body = await res.text();
      expect(body).toContain('rotate-modal');
      expect(body).toContain('new-key-value');
    });
  });
});
