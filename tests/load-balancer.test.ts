import { LoadBalancer } from '../src/load-balancer';

describe('LoadBalancer', () => {
  let lb: LoadBalancer;

  beforeEach(() => {
    lb = new LoadBalancer();
  });

  // ── Backend Management ────────────────────────────────────────────

  it('adds a backend', () => {
    const b = lb.addBackend({ name: 'api-1', url: 'http://localhost:3001' });
    expect(b.name).toBe('api-1');
    expect(b.weight).toBe(1);
    expect(b.healthy).toBe(true);
    expect(b.activeConnections).toBe(0);
  });

  it('rejects duplicate backend names', () => {
    lb.addBackend({ name: 'a', url: 'http://a' });
    expect(() => lb.addBackend({ name: 'a', url: 'http://b' })).toThrow('already exists');
  });

  it('rejects empty name', () => {
    expect(() => lb.addBackend({ name: '', url: 'http://a' })).toThrow('name');
  });

  it('rejects empty url', () => {
    expect(() => lb.addBackend({ name: 'a', url: '' })).toThrow('URL');
  });

  it('enforces max backends', () => {
    const small = new LoadBalancer({ maxBackends: 2 });
    small.addBackend({ name: 'a', url: 'http://a' });
    small.addBackend({ name: 'b', url: 'http://b' });
    expect(() => small.addBackend({ name: 'c', url: 'http://c' })).toThrow('Maximum');
  });

  it('removes a backend', () => {
    lb.addBackend({ name: 'a', url: 'http://a' });
    expect(lb.removeBackend('a')).toBe(true);
    expect(lb.getBackendByName('a')).toBeNull();
  });

  it('lists backends', () => {
    lb.addBackend({ name: 'a', url: 'http://a' });
    lb.addBackend({ name: 'b', url: 'http://b' });
    expect(lb.listBackends()).toHaveLength(2);
  });

  it('sets backend health', () => {
    lb.addBackend({ name: 'a', url: 'http://a' });
    lb.setHealth('a', false);
    expect(lb.getBackendByName('a')!.healthy).toBe(false);
    lb.setHealth('a', true);
    expect(lb.getBackendByName('a')!.healthy).toBe(true);
  });

  // ── Routing ───────────────────────────────────────────────────────

  it('round-robin picks backends in order', () => {
    lb.addBackend({ name: 'a', url: 'http://a' });
    lb.addBackend({ name: 'b', url: 'http://b' });
    const first = lb.pick()!;
    const second = lb.pick()!;
    expect(first.backend.name).not.toBe(second.backend.name);
  });

  it('returns null when no healthy backends', () => {
    lb.addBackend({ name: 'a', url: 'http://a', healthy: false });
    expect(lb.pick()).toBeNull();
  });

  it('skips unhealthy backends', () => {
    lb.addBackend({ name: 'a', url: 'http://a', healthy: false });
    lb.addBackend({ name: 'b', url: 'http://b' });
    const picked = lb.pick()!;
    expect(picked.backend.name).toBe('b');
  });

  it('least-connections strategy picks lowest', () => {
    const lcLb = new LoadBalancer({ strategy: 'least-connections' });
    lcLb.addBackend({ name: 'a', url: 'http://a' });
    lcLb.addBackend({ name: 'b', url: 'http://b' });
    lcLb.connect('a');
    lcLb.connect('a');
    const picked = lcLb.pick()!;
    expect(picked.backend.name).toBe('b');
  });

  it('changes strategy dynamically', () => {
    lb.addBackend({ name: 'a', url: 'http://a' });
    lb.setStrategy('random');
    const picked = lb.pick()!;
    expect(picked.reason).toContain('Random');
  });

  // ── Request Tracking ──────────────────────────────────────────────

  it('records successful requests', () => {
    lb.addBackend({ name: 'a', url: 'http://a' });
    lb.recordRequest('a', 200, 50);
    const b = lb.getBackendByName('a')!;
    expect(b.totalRequests).toBe(1);
    expect(b.avgLatencyMs).toBe(50);
    expect(b.totalErrors).toBe(0);
  });

  it('records errors and auto-marks unhealthy', () => {
    const strict = new LoadBalancer({ errorThreshold: 3 });
    strict.addBackend({ name: 'a', url: 'http://a' });
    strict.recordRequest('a', 500, 10);
    strict.recordRequest('a', 500, 10);
    expect(strict.getBackendByName('a')!.healthy).toBe(true);
    strict.recordRequest('a', 500, 10);
    expect(strict.getBackendByName('a')!.healthy).toBe(false);
  });

  it('tracks active connections', () => {
    lb.addBackend({ name: 'a', url: 'http://a' });
    lb.connect('a');
    lb.connect('a');
    expect(lb.getBackendByName('a')!.activeConnections).toBe(2);
    lb.disconnect('a');
    expect(lb.getBackendByName('a')!.activeConnections).toBe(1);
  });

  it('calculates running average latency', () => {
    lb.addBackend({ name: 'a', url: 'http://a' });
    lb.recordRequest('a', 200, 10);
    lb.recordRequest('a', 200, 20);
    expect(lb.getBackendByName('a')!.avgLatencyMs).toBe(15);
  });

  // ── Stats ─────────────────────────────────────────────────────────

  it('tracks stats', () => {
    lb.addBackend({ name: 'a', url: 'http://a' });
    lb.addBackend({ name: 'b', url: 'http://b', healthy: false });
    lb.recordRequest('a', 200, 10);
    const stats = lb.getStats();
    expect(stats.totalBackends).toBe(2);
    expect(stats.healthyBackends).toBe(1);
    expect(stats.unhealthyBackends).toBe(1);
    expect(stats.totalRequests).toBe(1);
    expect(stats.strategy).toBe('round-robin');
  });

  // ── Destroy ───────────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    lb.addBackend({ name: 'a', url: 'http://a' });
    lb.recordRequest('a', 200, 10);
    lb.destroy();
    expect(lb.getStats().totalBackends).toBe(0);
    expect(lb.getStats().totalRequests).toBe(0);
  });
});
