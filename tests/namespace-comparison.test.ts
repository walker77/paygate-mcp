import { PayGateServer } from '../src/server';

const serverCommand = process.execPath;
const serverArgs = ['-e', 'process.stdin.resume();process.stdin.on("data",d=>{const j=JSON.parse(d);if(j.method==="initialize")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{protocolVersion:"2025-01-01",capabilities:{tools:{}},serverInfo:{name:"echo",version:"1.0"}}})+`\\n`);if(j.method==="tools/list")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{tools:[{name:"echo",inputSchema:{type:"object"}}]}})+`\\n`);if(j.method==="tools/call")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{content:[{type:"text",text:"ok"}]}})+`\\n`)})'];

describe('GET /admin/namespace-comparison', () => {
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

  it('returns empty when no active keys', async () => {
    const res = await fetch(`http://localhost:${port}/admin/namespace-comparison`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.namespaces).toEqual([]);
    expect(body.summary.totalNamespaces).toBe(0);
  });

  it('compares namespaces side by side', async () => {
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'prod-key', credits: 1000, namespace: 'production' }),
    });
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'stage-key', credits: 500, namespace: 'staging' }),
    });

    const res = await fetch(`http://localhost:${port}/admin/namespace-comparison`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.namespaces.length).toBe(2);
    const prod = body.namespaces.find((n: any) => n.namespace === 'production');
    const stage = body.namespaces.find((n: any) => n.namespace === 'staging');
    expect(prod).toBeDefined();
    expect(stage).toBeDefined();
    expect(prod.keyCount).toBe(1);
    expect(prod.totalAllocated).toBe(1000);
    expect(stage.keyCount).toBe(1);
    expect(stage.totalAllocated).toBe(500);
  });

  it('keys without namespace appear under default', async () => {
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'no-ns', credits: 200 }),
    });

    const res = await fetch(`http://localhost:${port}/admin/namespace-comparison`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    const def = body.namespaces.find((n: any) => n.namespace === 'default');
    expect(def).toBeDefined();
    expect(def.keyCount).toBe(1);
  });

  it('includes spend and utilization metrics', async () => {
    const createRes = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'active', credits: 1000, namespace: 'prod' }),
    });
    const { key } = await createRes.json() as any;

    await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } }),
    });

    const res = await fetch(`http://localhost:${port}/admin/namespace-comparison`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    const prod = body.namespaces.find((n: any) => n.namespace === 'prod');
    expect(prod.totalSpent).toBeGreaterThan(0);
    expect(prod.totalCalls).toBeGreaterThan(0);
    expect(prod.utilizationPercent).toBeGreaterThanOrEqual(0);
  });

  it('sorted by totalAllocated descending', async () => {
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'small', credits: 100, namespace: 'dev' }),
    });
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'big', credits: 5000, namespace: 'prod' }),
    });

    const res = await fetch(`http://localhost:${port}/admin/namespace-comparison`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.namespaces[0].totalAllocated).toBeGreaterThanOrEqual(body.namespaces[1].totalAllocated);
  });

  it('summary includes leader namespace', async () => {
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'big', credits: 5000, namespace: 'enterprise' }),
    });
    await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'small', credits: 100, namespace: 'trial' }),
    });

    const res = await fetch(`http://localhost:${port}/admin/namespace-comparison`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.summary.leader).toBe('enterprise');
    expect(body.summary.totalNamespaces).toBe(2);
  });

  it('excludes revoked keys', async () => {
    const createRes = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'revoked', credits: 500, namespace: 'gone' }),
    });
    const { key } = await createRes.json() as any;

    await fetch(`http://localhost:${port}/keys/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ key }),
    });

    const res = await fetch(`http://localhost:${port}/admin/namespace-comparison`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.namespaces).toEqual([]);
  });

  it('excludes suspended keys', async () => {
    const createRes = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'suspended', credits: 500, namespace: 'paused' }),
    });
    const { key } = await createRes.json() as any;

    await fetch(`http://localhost:${port}/keys/suspend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ key }),
    });

    const res = await fetch(`http://localhost:${port}/admin/namespace-comparison`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.namespaces).toEqual([]);
  });

  it('includes generatedAt timestamp', async () => {
    const res = await fetch(`http://localhost:${port}/admin/namespace-comparison`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.generatedAt).toBeDefined();
  });

  it('requires admin key', async () => {
    const res = await fetch(`http://localhost:${port}/admin/namespace-comparison`);
    expect(res.status).toBe(401);
  });

  it('rejects POST method', async () => {
    const res = await fetch(`http://localhost:${port}/admin/namespace-comparison`, {
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
    expect(body.endpoints.namespaceComparison).toBeDefined();
  });
});
