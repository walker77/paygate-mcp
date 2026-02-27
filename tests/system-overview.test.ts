import { PayGateServer } from '../src/server';

const serverCommand = process.execPath;
const serverArgs = ['-e', 'process.stdin.resume();process.stdin.on("data",d=>{const j=JSON.parse(d);if(j.method==="initialize")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{protocolVersion:"2025-01-01",capabilities:{tools:{}},serverInfo:{name:"echo",version:"1.0"}}})+`\\n`);if(j.method==="tools/list")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{tools:[{name:"echo",inputSchema:{type:"object"}}]}})+`\\n`);if(j.method==="tools/call")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{content:[{type:"text",text:"ok"}]}})+`\\n`)})'];

describe('GET /admin/system-overview', () => {
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

  it('returns overview when no keys exist', async () => {
    const res = await fetch(`http://localhost:${port}/admin/system-overview`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.keys.total).toBe(0);
    expect(body.keys.active).toBe(0);
    expect(body.credits.totalAllocated).toBe(0);
    expect(body.credits.totalSpent).toBe(0);
    expect(body.credits.totalRemaining).toBe(0);
    expect(body.activity.totalCalls).toBe(0);
  });

  it('returns comprehensive system metrics', async () => {
    const createRes = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'test', credits: 1000 }),
    });
    const { key } = await createRes.json() as any;

    await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } }),
    });

    const res = await fetch(`http://localhost:${port}/admin/system-overview`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.keys.total).toBe(1);
    expect(body.keys.active).toBe(1);
    expect(body.credits.totalAllocated).toBe(1000);
    expect(body.credits.totalSpent).toBeGreaterThan(0);
    expect(body.credits.totalRemaining).toBeLessThan(1000);
    expect(body.credits.utilizationPercent).toBeGreaterThanOrEqual(0);
    expect(body.activity.totalCalls).toBeGreaterThan(0);
    expect(body.activity.uniqueTools).toBeGreaterThanOrEqual(0);
  });

  it('counts revoked and suspended keys separately', async () => {
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'active', credits: 100 }),
    });

    const res2 = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'revoked', credits: 100 }),
    });
    const { key: rKey } = await res2.json() as any;
    await fetch(`http://localhost:${port}/keys/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ key: rKey }),
    });

    const res3 = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'suspended', credits: 100 }),
    });
    const { key: sKey } = await res3.json() as any;
    await fetch(`http://localhost:${port}/keys/suspend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ key: sKey }),
    });

    const res = await fetch(`http://localhost:${port}/admin/system-overview`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.keys.total).toBe(3);
    expect(body.keys.active).toBe(1);
    expect(body.keys.revoked).toBe(1);
    expect(body.keys.suspended).toBe(1);
  });

  it('tracks unique tools used', async () => {
    const createRes = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'caller', credits: 1000 }),
    });
    const { key } = await createRes.json() as any;

    await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } }),
    });

    const res = await fetch(`http://localhost:${port}/admin/system-overview`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.activity.uniqueTools).toBeGreaterThanOrEqual(1);
  });

  it('includes generatedAt timestamp', async () => {
    const res = await fetch(`http://localhost:${port}/admin/system-overview`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.generatedAt).toBeDefined();
    expect(new Date(body.generatedAt).getTime()).toBeGreaterThan(0);
  });

  it('requires admin key', async () => {
    const res = await fetch(`http://localhost:${port}/admin/system-overview`);
    expect(res.status).toBe(401);
  });

  it('rejects POST method', async () => {
    const res = await fetch(`http://localhost:${port}/admin/system-overview`, {
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
    expect(body.endpoints.systemOverview).toBeDefined();
  });

  it('does not modify system state', async () => {
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'state-test', credits: 100 }),
    });

    const beforeRes = await fetch(`http://localhost:${port}/admin/system-overview`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const before: any = await beforeRes.json();

    const afterRes = await fetch(`http://localhost:${port}/admin/system-overview`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const after: any = await afterRes.json();

    expect(before.keys.total).toBe(after.keys.total);
    expect(before.credits.totalAllocated).toBe(after.credits.totalAllocated);
  });
});
