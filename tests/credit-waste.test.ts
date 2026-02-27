import { PayGateServer } from '../src/server';

const serverCommand = process.execPath;
const serverArgs = ['-e', 'process.stdin.resume();process.stdin.on("data",d=>{const j=JSON.parse(d);if(j.method==="initialize")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{protocolVersion:"2025-01-01",capabilities:{tools:{}},serverInfo:{name:"echo",version:"1.0"}}})+`\\n`);if(j.method==="tools/list")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{tools:[{name:"echo",inputSchema:{type:"object"}}]}})+`\\n`);if(j.method==="tools/call")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{content:[{type:"text",text:"ok"}]}})+`\\n`)})'];

describe('GET /admin/credit-waste', () => {
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
    const res = await fetch(`http://localhost:${port}/admin/credit-waste`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.keys).toEqual([]);
    expect(body.summary.totalAllocated).toBe(0);
    expect(body.summary.totalWasted).toBe(0);
  });

  it('returns per-key waste analysis', async () => {
    const createRes = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'waste-test', credits: 1000 }),
    });
    const { key } = await createRes.json() as any;

    await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } }),
    });

    const res = await fetch(`http://localhost:${port}/admin/credit-waste`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.keys.length).toBe(1);
    expect(body.keys[0].name).toBe('waste-test');
    expect(body.keys[0].creditsAllocated).toBe(1000);
    expect(body.keys[0].creditsUsed).toBeGreaterThan(0);
    expect(body.keys[0].creditsRemaining).toBeLessThan(1000);
    expect(body.keys[0].wastePercent).toBeGreaterThanOrEqual(0);
    expect(body.keys[0].wastePercent).toBeLessThanOrEqual(100);
  });

  it('calculates waste percent correctly for unused key', async () => {
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'unused', credits: 500 }),
    });

    const res = await fetch(`http://localhost:${port}/admin/credit-waste`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.keys[0].wastePercent).toBe(100);
    expect(body.keys[0].creditsUsed).toBe(0);
    expect(body.keys[0].creditsRemaining).toBe(500);
  });

  it('fully utilized key has 0 waste', async () => {
    const createRes = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'full-use', credits: 1 }),
    });
    const { key } = await createRes.json() as any;

    await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } }),
    });

    const res = await fetch(`http://localhost:${port}/admin/credit-waste`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    const k = body.keys.find((x: any) => x.name === 'full-use');
    expect(k.wastePercent).toBe(0);
    expect(k.creditsRemaining).toBe(0);
  });

  it('sorted by wastePercent descending', async () => {
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'unused', credits: 500 }),
    });

    const createRes = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'partial', credits: 100 }),
    });
    const { key } = await createRes.json() as any;

    await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } }),
    });

    const res = await fetch(`http://localhost:${port}/admin/credit-waste`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.keys.length).toBe(2);
    expect(body.keys[0].wastePercent).toBeGreaterThanOrEqual(body.keys[1].wastePercent);
  });

  it('summary includes correct totals', async () => {
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'k1', credits: 1000 }),
    });
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'k2', credits: 500 }),
    });

    const res = await fetch(`http://localhost:${port}/admin/credit-waste`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.summary.totalAllocated).toBe(1500);
    expect(body.summary.totalWasted).toBe(1500);
    expect(body.summary.averageWastePercent).toBe(100);
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

    const res = await fetch(`http://localhost:${port}/admin/credit-waste`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.keys).toEqual([]);
  });

  it('excludes suspended keys', async () => {
    const createRes = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'suspended', credits: 500 }),
    });
    const { key } = await createRes.json() as any;

    await fetch(`http://localhost:${port}/keys/suspend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ key }),
    });

    const res = await fetch(`http://localhost:${port}/admin/credit-waste`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.keys).toEqual([]);
  });

  it('includes generatedAt timestamp', async () => {
    const res = await fetch(`http://localhost:${port}/admin/credit-waste`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.generatedAt).toBeDefined();
    expect(new Date(body.generatedAt).getTime()).toBeGreaterThan(0);
  });

  it('requires admin key', async () => {
    const res = await fetch(`http://localhost:${port}/admin/credit-waste`);
    expect(res.status).toBe(401);
  });

  it('rejects POST method', async () => {
    const res = await fetch(`http://localhost:${port}/admin/credit-waste`, {
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
    expect(body.endpoints.creditWaste).toBeDefined();
  });

  it('does not modify system state', async () => {
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'state-test', credits: 100 }),
    });

    const beforeRes = await fetch(`http://localhost:${port}/admin/credit-waste`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const before: any = await beforeRes.json();

    const afterRes = await fetch(`http://localhost:${port}/admin/credit-waste`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const after: any = await afterRes.json();

    expect(before.keys.length).toBe(after.keys.length);
    expect(before.summary.totalAllocated).toBe(after.summary.totalAllocated);
  });
});
