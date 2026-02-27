import { PayGateServer } from '../src/server';

const serverCommand = process.execPath;
const serverArgs = ['-e', 'process.stdin.resume();process.stdin.on("data",d=>{const j=JSON.parse(d);if(j.method==="initialize")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{protocolVersion:"2025-01-01",capabilities:{tools:{}},serverInfo:{name:"echo",version:"1.0"}}})+`\\n`);if(j.method==="tools/list")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{tools:[{name:"echo",inputSchema:{type:"object"}},{name:"greet",inputSchema:{type:"object"}}]}})+`\\n`);if(j.method==="tools/call")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{content:[{type:"text",text:"ok"}]}})+`\\n`)})'];

describe('GET /admin/tool-profitability', () => {
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

  it('returns empty when no tool calls recorded', async () => {
    const res = await fetch(`http://localhost:${port}/admin/tool-profitability`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.tools).toEqual([]);
    expect(body.summary.totalRevenue).toBe(0);
  });

  it('returns per-tool profitability', async () => {
    const createRes = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'caller', credits: 1000 }),
    });
    const { key } = await createRes.json() as any;

    // Call echo tool
    await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } }),
    });

    const res = await fetch(`http://localhost:${port}/admin/tool-profitability`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.tools.length).toBeGreaterThanOrEqual(1);
    const echo = body.tools.find((t: any) => t.tool === 'echo');
    expect(echo).toBeDefined();
    expect(echo.totalCalls).toBeGreaterThan(0);
    expect(echo.totalRevenue).toBeGreaterThan(0);
    expect(echo.avgRevenuePerCall).toBeGreaterThan(0);
    expect(echo.callerCount).toBe(1);
  });

  it('tracks multiple callers per tool', async () => {
    const res1 = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'caller1', credits: 100 }),
    });
    const { key: key1 } = await res1.json() as any;

    const res2 = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'caller2', credits: 100 }),
    });
    const { key: key2 } = await res2.json() as any;

    // Both call echo
    await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key1 },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } }),
    });
    await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key2 },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: {} } }),
    });

    const res = await fetch(`http://localhost:${port}/admin/tool-profitability`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    const echo = body.tools.find((t: any) => t.tool === 'echo');
    expect(echo.callerCount).toBe(2);
    expect(echo.totalCalls).toBe(2);
  });

  it('sorted by totalRevenue descending', async () => {
    const createRes = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'caller', credits: 1000 }),
    });
    const { key } = await createRes.json() as any;

    // Call echo 3 times and greet 1 time (echo should have more revenue)
    for (let i = 0; i < 3; i++) {
      await fetch(`http://localhost:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
        body: JSON.stringify({ jsonrpc: '2.0', id: i + 10, method: 'tools/call', params: { name: 'echo', arguments: {} } }),
      });
    }
    await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'greet', arguments: {} } }),
    });

    const res = await fetch(`http://localhost:${port}/admin/tool-profitability`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.tools.length).toBe(2);
    expect(body.tools[0].totalRevenue).toBeGreaterThanOrEqual(body.tools[1].totalRevenue);
  });

  it('summary includes mostProfitable and leastProfitable', async () => {
    const createRes = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'caller', credits: 1000 }),
    });
    const { key } = await createRes.json() as any;

    // Call echo twice and greet once
    await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } }),
    });
    await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: {} } }),
    });
    await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'greet', arguments: {} } }),
    });

    const res = await fetch(`http://localhost:${port}/admin/tool-profitability`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.summary.mostProfitable).toBe('echo');
    expect(body.summary.leastProfitable).toBe('greet');
    expect(body.summary.totalRevenue).toBeGreaterThan(0);
  });

  it('includes generatedAt timestamp', async () => {
    const res = await fetch(`http://localhost:${port}/admin/tool-profitability`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const body: any = await res.json();
    expect(body.generatedAt).toBeDefined();
    expect(new Date(body.generatedAt).getTime()).toBeGreaterThan(0);
  });

  it('requires admin key', async () => {
    const res = await fetch(`http://localhost:${port}/admin/tool-profitability`);
    expect(res.status).toBe(401);
  });

  it('rejects POST method', async () => {
    const res = await fetch(`http://localhost:${port}/admin/tool-profitability`, {
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
    expect(body.endpoints.toolProfitability).toBeDefined();
  });

  it('does not modify system state', async () => {
    const createRes = await fetch(`http://localhost:${port}/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ name: 'state-test', credits: 100 }),
    });
    const { key } = await createRes.json() as any;

    await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } }),
    });

    const beforeRes = await fetch(`http://localhost:${port}/admin/tool-profitability`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const before: any = await beforeRes.json();

    const afterRes = await fetch(`http://localhost:${port}/admin/tool-profitability`, {
      headers: { 'X-Admin-Key': adminKey },
    });
    const after: any = await afterRes.json();

    expect(before.tools.length).toBe(after.tools.length);
    expect(before.summary.totalRevenue).toBe(after.summary.totalRevenue);
  });
});
