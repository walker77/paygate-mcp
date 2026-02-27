import { PayGateServer } from '../src/server';

const serverCommand = process.execPath;
const serverArgs = ['-e', 'process.stdin.resume();process.stdin.on("data",d=>{const j=JSON.parse(d);if(j.method==="initialize")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{protocolVersion:"2025-01-01",capabilities:{tools:{}},serverInfo:{name:"echo",version:"1.0"}}})+`\\n`);if(j.method==="tools/list")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{tools:[{name:"echo",inputSchema:{type:"object"}}]}})+`\\n`);if(j.method==="tools/call")process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:j.id,result:{content:[{type:"text",text:"ok"}]}})+`\\n`)})'];

describe('v9.0.0 Features', () => {
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

  // ─── X-PayGate-Version header ───

  describe('X-PayGate-Version header', () => {
    it('includes version header on /health', async () => {
      const res = await fetch(`http://localhost:${port}/health`);
      const version = res.headers.get('x-paygate-version');
      expect(version).toBeDefined();
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('includes version header on /ready', async () => {
      const res = await fetch(`http://localhost:${port}/ready`);
      expect(res.headers.get('x-paygate-version')).toBeDefined();
    });

    it('includes version header on admin endpoint', async () => {
      const res = await fetch(`http://localhost:${port}/status`, {
        headers: { 'X-Admin-Key': adminKey },
      });
      expect(res.headers.get('x-paygate-version')).toBeDefined();
    });

    it('includes version header on CORS preflight', async () => {
      const res = await fetch(`http://localhost:${port}/mcp`, {
        method: 'OPTIONS',
      });
      expect(res.headers.get('x-paygate-version')).toBeDefined();
    });

    it('exposes version in Access-Control-Expose-Headers', async () => {
      const res = await fetch(`http://localhost:${port}/health`);
      const expose = res.headers.get('access-control-expose-headers') || '';
      expect(expose).toContain('X-PayGate-Version');
    });
  });

  // ─── Stripe Checkout (without Stripe config) ───

  describe('Stripe Checkout (unconfigured)', () => {
    it('returns 404 when Stripe not configured', async () => {
      const res = await fetch(`http://localhost:${port}/stripe/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': 'fake_key' },
        body: JSON.stringify({ packageId: 'starter' }),
      });
      expect(res.status).toBe(404);
      const body: any = await res.json();
      expect(body.error).toContain('not configured');
    });

    it('returns empty packages when not configured', async () => {
      const res = await fetch(`http://localhost:${port}/stripe/packages`);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.configured).toBe(false);
      expect(body.packages).toEqual([]);
    });

    it('includes checkout in OpenAPI spec', async () => {
      const res = await fetch(`http://localhost:${port}/openapi.json`);
      const body: any = await res.json();
      expect(body.paths['/stripe/checkout']).toBeDefined();
      expect(body.paths['/stripe/packages']).toBeDefined();
    });

    it('includes checkout in root listing', async () => {
      const res = await fetch(`http://localhost:${port}/`, {
        headers: { 'X-Admin-Key': adminKey },
      });
      const body: any = await res.json();
      expect(body.endpoints.stripeCheckout).toBeDefined();
      expect(body.endpoints.stripePackages).toBeDefined();
    });
  });

  // ─── Backup & Restore ───

  describe('Admin Backup & Restore', () => {
    it('creates backup with checksum', async () => {
      // Create a key first
      await fetch(`http://localhost:${port}/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
        body: JSON.stringify({ name: 'backup-test', credits: 100 }),
      });

      const res = await fetch(`http://localhost:${port}/admin/backup`, {
        headers: { 'X-Admin-Key': adminKey },
      });
      expect(res.status).toBe(200);

      const body: any = await res.json();
      expect(body.version).toBe('1.0');
      expect(body.timestamp).toBeDefined();
      expect(body.serverVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(body.checksum).toBeDefined();
      expect(body.checksum).toHaveLength(64); // SHA-256 hex
      expect(body.data.keys).toBeDefined();
      expect(Array.isArray(body.data.keys)).toBe(true);
      expect(body.data.keys.length).toBeGreaterThanOrEqual(1);
    });

    it('requires admin auth', async () => {
      const res = await fetch(`http://localhost:${port}/admin/backup`);
      expect(res.status).toBe(401);
    });

    it('rejects invalid restore snapshot', async () => {
      const res = await fetch(`http://localhost:${port}/admin/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
        body: JSON.stringify({ snapshot: { version: 'bad' }, mode: 'merge' }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.errors).toBeDefined();
    });

    it('round-trips backup and restore', async () => {
      // Create a key
      const createRes = await fetch(`http://localhost:${port}/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
        body: JSON.stringify({ name: 'roundtrip-key', credits: 500 }),
      });
      const createBody: any = await createRes.json();
      const keyToCheck = createBody.key;

      // Backup
      const backupRes = await fetch(`http://localhost:${port}/admin/backup`, {
        headers: { 'X-Admin-Key': adminKey },
      });
      const snapshot = await backupRes.json();

      // Restore to a new server
      const server2 = new PayGateServer({ serverCommand, serverArgs, port: 0 });
      const info2 = await server2.start();
      try {
        const restoreRes = await fetch(`http://localhost:${info2.port}/admin/restore`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': info2.adminKey },
          body: JSON.stringify({ snapshot, mode: 'merge' }),
        });
        expect(restoreRes.status).toBe(200);

        const restoreBody: any = await restoreRes.json();
        expect(restoreBody.results.keys).toBeDefined();
        expect(restoreBody.results.keys.imported).toBeGreaterThanOrEqual(1);
      } finally {
        await server2.gracefulStop(5_000);
      }
    }, 30_000);

    it('backup includes stats', async () => {
      const res = await fetch(`http://localhost:${port}/admin/backup`, {
        headers: { 'X-Admin-Key': adminKey },
      });
      const body: any = await res.json();
      expect(body.data.stats).toBeDefined();
      expect(typeof body.data.stats.totalKeys).toBe('number');
      expect(typeof body.data.stats.totalTeams).toBe('number');
      expect(typeof body.data.stats.totalGroups).toBe('number');
    });

    it('includes backup/restore in OpenAPI spec', async () => {
      const res = await fetch(`http://localhost:${port}/openapi.json`);
      const body: any = await res.json();
      expect(body.paths['/admin/backup']).toBeDefined();
      expect(body.paths['/admin/restore']).toBeDefined();
    });

    it('includes backup/restore in root listing', async () => {
      const res = await fetch(`http://localhost:${port}/`, {
        headers: { 'X-Admin-Key': adminKey },
      });
      const body: any = await res.json();
      expect(body.endpoints.adminBackup).toBeDefined();
      expect(body.endpoints.adminRestore).toBeDefined();
    });

    it('restore requires POST', async () => {
      const res = await fetch(`http://localhost:${port}/admin/restore`, {
        headers: { 'X-Admin-Key': adminKey },
      });
      expect(res.status).toBe(405);
    });

    it('backup content-disposition header', async () => {
      const res = await fetch(`http://localhost:${port}/admin/backup`, {
        headers: { 'X-Admin-Key': adminKey },
      });
      const cd = res.headers.get('content-disposition') || '';
      expect(cd).toContain('attachment');
      expect(cd).toContain('paygate-backup-');
    });
  });

  // ─── Portal Buy Credits UI ───

  describe('Portal updates', () => {
    it('portal has buy credits elements', async () => {
      const res = await fetch(`http://localhost:${port}/portal`);
      const body = await res.text();
      expect(body).toContain('buy-credits-bar');
      expect(body).toContain('packages-list');
      expect(body).toContain('Buy Credits');
    });

    it('portal has loadPackages function', async () => {
      const res = await fetch(`http://localhost:${port}/portal`);
      const body = await res.text();
      expect(body).toContain('loadPackages');
      expect(body).toContain('buyPackage');
    });

    it('portal has stripe checkout integration', async () => {
      const res = await fetch(`http://localhost:${port}/portal`);
      const body = await res.text();
      expect(body).toContain('/stripe/checkout');
      expect(body).toContain('/stripe/packages');
    });
  });

  // ─── Root listing updates ───

  describe('Root listing v9 fields', () => {
    it('includes stripeCheckout flag', async () => {
      const res = await fetch(`http://localhost:${port}/`, {
        headers: { 'X-Admin-Key': adminKey },
      });
      const body: any = await res.json();
      expect(body).toHaveProperty('stripeCheckout');
      expect(body.stripeCheckout).toBe(false); // not configured in test
    });
  });
});

// ─── Stripe Checkout unit tests (no server needed) ───

import { StripeCheckout } from '../src/stripe-checkout';

describe('StripeCheckout unit', () => {
  it('requires secretKey', () => {
    expect(() => new StripeCheckout({
      secretKey: '',
      packages: [{ id: 'a', credits: 100, priceInCents: 500, currency: 'usd', name: '100' }],
      successUrl: 'http://x',
      cancelUrl: 'http://y',
    })).toThrow('Stripe secret key');
  });

  it('requires at least one package', () => {
    expect(() => new StripeCheckout({
      secretKey: 'sk_test_123',
      packages: [],
      successUrl: 'http://x',
      cancelUrl: 'http://y',
    })).toThrow('At least one credit package');
  });

  it('lists packages', () => {
    const checkout = new StripeCheckout({
      secretKey: 'sk_test_123',
      packages: [
        { id: 'starter', credits: 100, priceInCents: 500, currency: 'usd', name: '100 Credits' },
        { id: 'pro', credits: 500, priceInCents: 2000, currency: 'usd', name: '500 Credits' },
      ],
      successUrl: 'http://x',
      cancelUrl: 'http://y',
    });

    const pkgs = checkout.listPackages();
    expect(pkgs).toHaveLength(2);
    expect(pkgs[0].id).toBe('starter');
    expect(pkgs[1].credits).toBe(500);
  });

  it('gets package by ID', () => {
    const checkout = new StripeCheckout({
      secretKey: 'sk_test_123',
      packages: [
        { id: 'starter', credits: 100, priceInCents: 500, currency: 'usd', name: '100 Credits' },
      ],
      successUrl: 'http://x',
      cancelUrl: 'http://y',
    });

    expect(checkout.getPackage('starter')?.credits).toBe(100);
    expect(checkout.getPackage('nonexistent')).toBeUndefined();
  });

  it('rejects unknown package on createSession', async () => {
    const checkout = new StripeCheckout({
      secretKey: 'sk_test_123',
      packages: [
        { id: 'starter', credits: 100, priceInCents: 500, currency: 'usd', name: '100 Credits' },
      ],
      successUrl: 'http://x',
      cancelUrl: 'http://y',
    });

    await expect(checkout.createSession('nonexistent', 'pg_abc123'))
      .rejects.toThrow('Unknown package');
  });

  it('rejects invalid API key on createSession', async () => {
    const checkout = new StripeCheckout({
      secretKey: 'sk_test_123',
      packages: [
        { id: 'starter', credits: 100, priceInCents: 500, currency: 'usd', name: '100 Credits' },
      ],
      successUrl: 'http://x',
      cancelUrl: 'http://y',
    });

    await expect(checkout.createSession('starter', ''))
      .rejects.toThrow('Valid API key');
  });
});

// ─── BackupManager unit tests ───

import { BackupManager, BackupSnapshot } from '../src/backup';

describe('BackupManager unit', () => {
  function createMockProvider() {
    return {
      exportKeys: () => [{ key: 'pg_test_123', name: 'test', credits: 100 }],
      importKeys: (keys: any[], mode: string) => keys.map(k => ({ key: k.key, status: 'imported' })),
      exportTeams: () => [{ id: 'team_1', name: 'Team A' }],
      importTeams: () => ({ imported: 1, skipped: 0, errors: 0 }),
      exportGroups: () => [],
      importGroups: () => ({ imported: 0, skipped: 0, errors: 0 }),
      exportWebhookFilters: () => [],
      importWebhookFilters: () => ({ imported: 0, skipped: 0, errors: 0 }),
      getStats: () => ({ totalKeys: 1, totalTeams: 1, totalGroups: 0, totalAuditEntries: 5, totalUsageEvents: 100 }),
      getServerVersion: () => '9.0.0',
    };
  }

  it('creates snapshot with checksum', () => {
    const manager = new BackupManager(createMockProvider());
    const snapshot = manager.createSnapshot();

    expect(snapshot.version).toBe('1.0');
    expect(snapshot.timestamp).toBeDefined();
    expect(snapshot.serverVersion).toBe('9.0.0');
    expect(snapshot.checksum).toHaveLength(64);
    expect(snapshot.data.keys).toHaveLength(1);
    expect(snapshot.data.teams).toHaveLength(1);
  });

  it('validates correct snapshot', () => {
    const manager = new BackupManager(createMockProvider());
    const snapshot = manager.createSnapshot();
    const result = manager.validateSnapshot(snapshot);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects null snapshot', () => {
    const manager = new BackupManager(createMockProvider());
    const result = manager.validateSnapshot(null);
    expect(result.valid).toBe(false);
  });

  it('rejects corrupted checksum', () => {
    const manager = new BackupManager(createMockProvider());
    const snapshot = manager.createSnapshot();
    snapshot.checksum = 'deadbeef'.repeat(8);
    const result = manager.validateSnapshot(snapshot);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Checksum'))).toBe(true);
  });

  it('restores in merge mode', () => {
    const manager = new BackupManager(createMockProvider());
    const snapshot = manager.createSnapshot();
    const result = manager.restoreFromSnapshot(snapshot, 'merge');

    expect(result.mode).toBe('merge');
    expect(result.results.keys).toBeDefined();
    expect(result.results.keys!.imported).toBe(1);
  });

  it('reports errors for invalid snapshot version', () => {
    const manager = new BackupManager(createMockProvider());
    const bad = { version: '2.0', timestamp: new Date().toISOString(), data: {}, checksum: 'x' };
    const result = manager.validateSnapshot(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('version'))).toBe(true);
  });
});
