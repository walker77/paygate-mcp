import { PayGateServer } from '../src/server';

const serverCommand = process.execPath;
const serverArgs = ['-e', 'process.stdin.resume();process.stdin.on("data",d=>{const j=JSON.parse(d);if(j.method==="initialize")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{protocolVersion:"2025-01-01",capabilities:{tools:{}},serverInfo:{name:"echo",version:"1.0"}}})+`\\n`);if(j.method==="tools/list")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{tools:[{name:"echo",inputSchema:{type:"object"}}]}})+`\\n`);if(j.method==="tools/call")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{content:[{type:"text",text:"ok"}]}})+`\\n`)})'];

describe('GET /admin/consumer-growth', () => {
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

  it('returns empty when no consumers', async () => {
    const res = await fetch(`http://localhost:${port}/admin/consumer-growth`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.consumers).toEqual([]);
    expect(body.summary.totalConsumers).toBe(0);
    expect(body.summary.newConsumers24h).toBe(0);
  });

  it('returns per-consumer growth metrics', async () => {
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'growth-test', credits: 1000 }),
    });

    const res = await fetch(`http://localhost:${port}/admin/consumer-growth`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.consumers.length).toBe(1);
    expect(body.consumers[0].name).toBe('growth-test');
    expect(body.consumers[0].ageHours).toBeGreaterThanOrEqual(0);
    expect(body.consumers[0].totalSpent).toBe(0);
    expect(body.consumers[0].creditsAllocated).toBe(1000);
  });

  it('calculates spending rate', async () => {
    const createRes = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'spender', credits: 1000 }),
    });
    const { key } = await createRes.json() as any;

    // Make some calls
    for (let i = 0; i < 3; i++) {
      await fetch(`http://localhost:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
        body: JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: 'echo', arguments: {} } }),
      });
    }

    const res = await fetch(`http://localhost:${port}/admin/consumer-growth`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    const consumer = body.consumers.find((c: any) => c.name === 'spender');
    expect(consumer.totalSpent).toBeGreaterThan(0);
    expect(consumer.spendRate).toBeGreaterThanOrEqual(0);
  });

  it('counts new consumers in last 24h', async () => {
    // Keys created just now should count as new
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'new1', credits: 100 }),
    });
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'new2', credits: 200 }),
    });

    const res = await fetch(`http://localhost:${port}/admin/consumer-growth`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.summary.newConsumers24h).toBe(2);
    expect(body.summary.totalConsumers).toBe(2);
  });

  it('sorted by creditsAllocated descending', async () => {
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'small', credits: 100 }),
    });
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'big', credits: 5000 }),
    });

    const res = await fetch(`http://localhost:${port}/admin/consumer-growth`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.consumers[0].creditsAllocated).toBeGreaterThanOrEqual(body.consumers[1].creditsAllocated);
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

    const res = await fetch(`http://localhost:${port}/admin/consumer-growth`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.consumers).toEqual([]);
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

    const res = await fetch(`http://localhost:${port}/admin/consumer-growth`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.consumers).toEqual([]);
  });

  it('includes generatedAt timestamp', async () => {
    const res = await fetch(`http://localhost:${port}/admin/consumer-growth`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.generatedAt).toBeDefined();
    expect(new Date(body.generatedAt).getTime()).toBeGreaterThan(0);
  });

  it('requires admin key', async () => {
    const res = await fetch(`http://localhost:${port}/admin/consumer-growth`);
    expect(res.status).toBe(401);
  });

  it('rejects POST method', async () => {
    const res = await fetch(`http://localhost:${port}/admin/consumer-growth`, {
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
    expect(body.endpoints.consumerGrowth).toBeDefined();
  });

  it('does not modify system state', async () => {
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'state-test', credits: 100 }),
    });

    const beforeRes = await fetch(`http://localhost:${port}/admin/consumer-growth`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const before: any = await beforeRes.json();

    const afterRes = await fetch(`http://localhost:${port}/admin/consumer-growth`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const after: any = await afterRes.json();

    expect(before.consumers.length).toBe(after.consumers.length);
    expect(before.summary.totalConsumers).toBe(after.summary.totalConsumers);
  });
});
