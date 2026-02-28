import { ServiceDiscovery } from '../src/service-discovery';

describe('ServiceDiscovery', () => {
  let sd: ServiceDiscovery;

  beforeEach(() => {
    sd = new ServiceDiscovery();
  });

  // ── Registration ──────────────────────────────────────────────────

  it('registers a service', () => {
    const svc = sd.registerService({ name: 'search', endpoint: 'http://localhost:3001' });
    expect(svc.name).toBe('search');
    expect(svc.endpoint).toBe('http://localhost:3001');
    expect(svc.status).toBe('unknown');
    expect(svc.weight).toBe(1);
    expect(svc.healthEndpoint).toBe('/health');
  });

  it('rejects registration without name', () => {
    expect(() => sd.registerService({ name: '', endpoint: 'http://x' })).toThrow('name');
  });

  it('rejects registration without endpoint', () => {
    expect(() => sd.registerService({ name: 'x', endpoint: '' })).toThrow('Endpoint');
  });

  it('enforces max services', () => {
    const small = new ServiceDiscovery({ maxServices: 2 });
    small.registerService({ name: 'a', endpoint: 'http://a' });
    small.registerService({ name: 'b', endpoint: 'http://b' });
    expect(() => small.registerService({ name: 'c', endpoint: 'http://c' })).toThrow('Maximum');
  });

  it('deregisters a service', () => {
    const svc = sd.registerService({ name: 'x', endpoint: 'http://x' });
    expect(sd.deregisterService(svc.id)).toBe(true);
    expect(sd.getService(svc.id)).toBeNull();
  });

  it('lists services', () => {
    sd.registerService({ name: 'a', endpoint: 'http://a' });
    sd.registerService({ name: 'b', endpoint: 'http://b' });
    expect(sd.listServices()).toHaveLength(2);
  });

  it('gets services by name', () => {
    sd.registerService({ name: 'api', endpoint: 'http://a1' });
    sd.registerService({ name: 'api', endpoint: 'http://a2' });
    sd.registerService({ name: 'db', endpoint: 'http://d1' });
    expect(sd.getServicesByName('api')).toHaveLength(2);
  });

  // ── Health Checking ───────────────────────────────────────────────

  it('marks service healthy after healthy check', () => {
    const svc = sd.registerService({ name: 'x', endpoint: 'http://x' });
    const result = sd.checkHealth(svc.id, true, 5);
    expect(result.status).toBe('healthy');
    expect(sd.getService(svc.id)!.status).toBe('healthy');
  });

  it('marks service degraded after one failure', () => {
    const svc = sd.registerService({ name: 'x', endpoint: 'http://x' });
    sd.checkHealth(svc.id, false);
    expect(sd.getService(svc.id)!.status).toBe('degraded');
  });

  it('marks service unhealthy after threshold failures', () => {
    const sd3 = new ServiceDiscovery({ unhealthyThreshold: 3 });
    const svc = sd3.registerService({ name: 'x', endpoint: 'http://x' });
    sd3.checkHealth(svc.id, false);
    sd3.checkHealth(svc.id, false);
    expect(sd3.getService(svc.id)!.status).toBe('degraded');
    sd3.checkHealth(svc.id, false);
    expect(sd3.getService(svc.id)!.status).toBe('unhealthy');
  });

  it('resets consecutive failures on healthy check', () => {
    const svc = sd.registerService({ name: 'x', endpoint: 'http://x' });
    sd.checkHealth(svc.id, false);
    sd.checkHealth(svc.id, false);
    sd.checkHealth(svc.id, true);
    expect(sd.getService(svc.id)!.status).toBe('healthy');
    expect(sd.getService(svc.id)!.consecutiveFailures).toBe(0);
  });

  it('throws for unknown service health check', () => {
    expect(() => sd.checkHealth('unknown')).toThrow('not found');
  });

  it('checks all services', () => {
    const a = sd.registerService({ name: 'a', endpoint: 'http://a' });
    const b = sd.registerService({ name: 'b', endpoint: 'http://b' });
    const results = sd.checkAllHealth();
    expect(results).toHaveLength(2);
    expect(results.every(r => r.status === 'healthy')).toBe(true);
  });

  // ── Routing ───────────────────────────────────────────────────────

  it('returns only healthy services', () => {
    const a = sd.registerService({ name: 'api', endpoint: 'http://a1' });
    const b = sd.registerService({ name: 'api', endpoint: 'http://a2' });
    sd.checkHealth(a.id, true);
    sd.checkHealth(b.id, false);
    sd.checkHealth(b.id, false);
    sd.checkHealth(b.id, false);
    const healthy = sd.getHealthyServices('api');
    expect(healthy).toHaveLength(1);
    expect(healthy[0].id).toBe(a.id);
  });

  it('picks a healthy service', () => {
    const svc = sd.registerService({ name: 'api', endpoint: 'http://a' });
    sd.checkHealth(svc.id, true);
    const picked = sd.pickService('api');
    expect(picked).not.toBeNull();
    expect(picked!.id).toBe(svc.id);
  });

  it('returns null when no healthy services', () => {
    sd.registerService({ name: 'api', endpoint: 'http://a' });
    expect(sd.pickService('api')).toBeNull();
  });

  // ── History ───────────────────────────────────────────────────────

  it('records health history', () => {
    const svc = sd.registerService({ name: 'x', endpoint: 'http://x' });
    sd.checkHealth(svc.id, true);
    sd.checkHealth(svc.id, false);
    expect(sd.getHealthHistory(svc.id)).toHaveLength(2);
  });

  it('calculates uptime percentage', () => {
    const svc = sd.registerService({ name: 'x', endpoint: 'http://x' });
    sd.checkHealth(svc.id, true);
    sd.checkHealth(svc.id, true);
    sd.checkHealth(svc.id, true);
    sd.checkHealth(svc.id, true);
    expect(sd.getUptime(svc.id)).toBe(100);
  });

  it('returns 0 uptime with no history', () => {
    const svc = sd.registerService({ name: 'x', endpoint: 'http://x' });
    expect(sd.getUptime(svc.id)).toBe(0);
  });

  it('calculates average latency', () => {
    const svc = sd.registerService({ name: 'x', endpoint: 'http://x' });
    sd.checkHealth(svc.id, true, 10);
    sd.checkHealth(svc.id, true, 20);
    expect(sd.getAverageLatency(svc.id)).toBe(15);
  });

  // ── Stats ─────────────────────────────────────────────────────────

  it('tracks stats', () => {
    const svc = sd.registerService({ name: 'x', endpoint: 'http://x' });
    sd.checkHealth(svc.id, true);
    const stats = sd.getStats();
    expect(stats.totalServices).toBe(1);
    expect(stats.healthyServices).toBe(1);
    expect(stats.totalHealthChecks).toBe(1);
  });

  // ── Destroy ───────────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    sd.registerService({ name: 'x', endpoint: 'http://x' });
    sd.destroy();
    expect(sd.getStats().totalServices).toBe(0);
  });
});
