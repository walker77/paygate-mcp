import { PayGateServer } from '../src/server';

const serverCommand = process.execPath;
const serverArgs = ['-e', 'process.stdin.resume();process.stdin.on("data",d=>{const j=JSON.parse(d);if(j.method==="initialize")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{protocolVersion:"2025-01-01",capabilities:{tools:{}},serverInfo:{name:"echo",version:"1.0"}}})+`\\n`);if(j.method==="tools/list")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{tools:[{name:"echo",inputSchema:{type:"object"}}]}})+`\\n`);if(j.method==="tools/call")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{content:[{type:"text",text:"ok"}]}})+`\\n`)})'];

describe('GET /admin/key-health-overview', () => {
  let server: PayGateServer;
  let port: number;
  let adminKey: string;

  beforeEach(async () => {
    server = new PayGateServer({ serverCommand, serverArgs, port: 0 });
    const info = await server.start();
    port = info.port;
    adminKey = info.adminKey;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns empty when no active keys', async () => {
    const res = await fetch(`http://localhost:${port}/admin/key-health-overview`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.keys).toEqual([]);
    expect(body.summary.totalKeys).toBe(0);
  });

  it('returns per-key health overview', async () => {
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'test-key', credits: 1000 }),
    });

    const res = await fetch(`http://localhost:${port}/admin/key-health-overview`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.keys.length).toBe(1);
    expect(body.keys[0].name).toBe('test-key');
    expect(body.keys[0].credits).toBe(1000);
    expect(body.keys[0].totalSpent).toBe(0);
    expect(body.keys[0].totalCalls).toBe(0);
    expect(body.keys[0].utilizationPercent).toBe(0);
    expect(body.keys[0].status).toBe('healthy');
  });

  it('active key with high utilization shows warning status', async () => {
    const createRes = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'heavy', credits: 2 }),
    });
    const { key } = await createRes.json() as any;

    // Spend 1 of 2 credits (50% utilization)
    await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } }),
    });

    const res = await fetch(`http://localhost:${port}/admin/key-health-overview`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    const k = body.keys.find((x: any) => x.name === 'heavy');
    expect(k.utilizationPercent).toBe(50);
    expect(['warning', 'healthy']).toContain(k.status);
  });

  it('depleted key shows critical status', async () => {
    const createRes = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'depleted', credits: 1 }),
    });
    const { key } = await createRes.json() as any;

    // Spend all credits
    await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } }),
    });

    const res = await fetch(`http://localhost:${port}/admin/key-health-overview`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    const k = body.keys.find((x: any) => x.name === 'depleted');
    expect(k.credits).toBe(0);
    expect(k.status).toBe('critical');
  });

  it('summary includes health distribution', async () => {
    // Create one healthy key (lots of credits) and one critical key (depleted)
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'healthy-key', credits: 10000 }),
    });

    const createRes = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'critical-key', credits: 1 }),
    });
    const { key } = await createRes.json() as any;

    await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } }),
    });

    const res = await fetch(`http://localhost:${port}/admin/key-health-overview`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.summary.totalKeys).toBe(2);
    expect(body.summary.healthDistribution).toBeDefined();
    expect(body.summary.healthDistribution.healthy).toBeGreaterThanOrEqual(1);
    expect(body.summary.healthDistribution.critical).toBeGreaterThanOrEqual(1);
  });

  it('sorted by credits ascending (most depleted first)', async () => {
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'low', credits: 10 }),
    });
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'high', credits: 10000 }),
    });

    const res = await fetch(`http://localhost:${port}/admin/key-health-overview`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.keys[0].credits).toBeLessThanOrEqual(body.keys[1].credits);
  });

  it('excludes revoked keys', async () => {
    const createRes = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'revoked', credits: 500 }),
    });
    const { key } = await createRes.json() as any;

    await fetch(`http://localhost:${port}/keys/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ key }),
    });

    const res = await fetch(`http://localhost:${port}/admin/key-health-overview`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.keys).toEqual([]);
  });

  it('includes generatedAt timestamp', async () => {
    const res = await fetch(`http://localhost:${port}/admin/key-health-overview`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.generatedAt).toBeDefined();
  });

  it('requires admin key', async () => {
    const res = await fetch(`http://localhost:${port}/admin/key-health-overview`);
    expect(res.status).toBe(401);
  });

  it('rejects POST method', async () => {
    const res = await fetch(`http://localhost:${port}/admin/key-health-overview`, {
      method: 'POST',
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(405);
  });

  it('root listing includes endpoint', async () => {
    const res = await fetch(`http://localhost:${port}/`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.endpoints.keyHealthOverview).toBeDefined();
  });
});
