import { IncidentManager } from '../src/incident-manager';

describe('IncidentManager', () => {
  let mgr: IncidentManager;

  beforeEach(() => {
    mgr = new IncidentManager();
  });

  // ── Service Registration ─────────────────────────────────────────────

  it('registers a service', () => {
    mgr.registerService('api-gateway');
    expect(mgr.listServices()).toContain('api-gateway');
  });

  // ── Incident Creation ────────────────────────────────────────────────

  it('creates an incident', () => {
    const inc = mgr.createIncident({
      title: 'API Latency Spike',
      severity: 'major',
      affectedServices: ['api-gateway'],
    });
    expect(inc.title).toBe('API Latency Spike');
    expect(inc.severity).toBe('major');
    expect(inc.status).toBe('investigating');
    expect(inc.affectedServices).toEqual(['api-gateway']);
    expect(inc.updates).toHaveLength(1);
  });

  it('auto-registers affected services', () => {
    mgr.createIncident({ title: 'Test', severity: 'minor', affectedServices: ['db', 'cache'] });
    expect(mgr.listServices()).toContain('db');
    expect(mgr.listServices()).toContain('cache');
  });

  it('rejects empty title', () => {
    expect(() => mgr.createIncident({ title: '', severity: 'minor' })).toThrow('required');
  });

  it('enforces max incidents', () => {
    const small = new IncidentManager({ maxIncidents: 2 });
    small.createIncident({ title: 'a', severity: 'minor' });
    small.createIncident({ title: 'b', severity: 'minor' });
    expect(() => small.createIncident({ title: 'c', severity: 'minor' })).toThrow('Maximum');
  });

  // ── Updates ──────────────────────────────────────────────────────────

  it('adds status update', () => {
    const inc = mgr.createIncident({ title: 'Test', severity: 'major' });
    const updated = mgr.addUpdate(inc.id, { status: 'identified', message: 'Found the issue' });
    expect(updated.status).toBe('identified');
    expect(updated.updates).toHaveLength(2);
  });

  it('resolves incident via addUpdate', () => {
    const inc = mgr.createIncident({ title: 'Test', severity: 'major' });
    const resolved = mgr.addUpdate(inc.id, { status: 'resolved', message: 'Fixed it' });
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.durationMs).not.toBeNull();
  });

  it('rejects update on resolved incident', () => {
    const inc = mgr.createIncident({ title: 'Test', severity: 'minor' });
    mgr.resolveIncident(inc.id, 'Done');
    expect(() => mgr.addUpdate(inc.id, { status: 'investigating', message: 'Reopen' })).toThrow('already resolved');
  });

  it('rejects update on unknown incident', () => {
    expect(() => mgr.addUpdate('nope', { status: 'identified', message: 'x' })).toThrow('not found');
  });

  // ── Resolve ──────────────────────────────────────────────────────────

  it('resolves an incident', () => {
    const inc = mgr.createIncident({ title: 'Test', severity: 'critical' });
    const resolved = mgr.resolveIncident(inc.id, 'Scaled up instances');
    expect(resolved.status).toBe('resolved');
    expect(resolved.updates[resolved.updates.length - 1].message).toBe('Scaled up instances');
  });

  // ── Query ────────────────────────────────────────────────────────────

  it('gets incident by ID', () => {
    const inc = mgr.createIncident({ title: 'Test', severity: 'minor' });
    expect(mgr.getIncident(inc.id)).not.toBeNull();
    expect(mgr.getIncident('nope')).toBeNull();
  });

  it('lists incidents with filters', () => {
    mgr.createIncident({ title: 'A', severity: 'minor' });
    mgr.createIncident({ title: 'B', severity: 'major' });
    const inc3 = mgr.createIncident({ title: 'C', severity: 'critical' });
    mgr.resolveIncident(inc3.id, 'fixed');

    expect(mgr.listIncidents()).toHaveLength(3);
    expect(mgr.listIncidents({ severity: 'major' })).toHaveLength(1);
    expect(mgr.listIncidents({ status: 'resolved' })).toHaveLength(1);
  });

  it('gets active incidents', () => {
    mgr.createIncident({ title: 'A', severity: 'minor' });
    const inc2 = mgr.createIncident({ title: 'B', severity: 'major' });
    mgr.resolveIncident(inc2.id, 'fixed');
    expect(mgr.getActiveIncidents()).toHaveLength(1);
  });

  // ── Status Page ──────────────────────────────────────────────────────

  it('returns operational when no active incidents', () => {
    mgr.registerService('api');
    const page = mgr.getStatusPage();
    expect(page.overallStatus).toBe('operational');
    expect(page.activeIncidents).toHaveLength(0);
  });

  it('returns degraded for non-critical active incidents', () => {
    mgr.registerService('api');
    mgr.createIncident({ title: 'Slow', severity: 'major', affectedServices: ['api'] });
    const page = mgr.getStatusPage();
    expect(page.overallStatus).toBe('degraded');
    expect(page.serviceStatuses.find(s => s.service === 'api')!.status).toBe('affected');
  });

  it('returns major_outage for critical incidents', () => {
    mgr.createIncident({ title: 'Down', severity: 'critical' });
    const page = mgr.getStatusPage();
    expect(page.overallStatus).toBe('major_outage');
  });

  it('includes recent resolved incidents', () => {
    const inc = mgr.createIncident({ title: 'Fixed', severity: 'minor' });
    mgr.resolveIncident(inc.id, 'done');
    const page = mgr.getStatusPage();
    expect(page.recentResolved).toHaveLength(1);
  });

  // ── Stats ────────────────────────────────────────────────────────────

  it('tracks stats', () => {
    mgr.createIncident({ title: 'A', severity: 'minor' });
    const inc2 = mgr.createIncident({ title: 'B', severity: 'critical' });
    mgr.resolveIncident(inc2.id, 'fixed');
    const stats = mgr.getStats();
    expect(stats.totalIncidents).toBe(2);
    expect(stats.activeIncidents).toBe(1);
    expect(stats.resolvedIncidents).toBe(1);
    expect(stats.incidentsBySeverity.minor).toBe(1);
    expect(stats.incidentsBySeverity.critical).toBe(1);
  });

  // ── Destroy ──────────────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    mgr.createIncident({ title: 'A', severity: 'minor' });
    mgr.registerService('api');
    mgr.destroy();
    expect(mgr.getStats().totalIncidents).toBe(0);
    expect(mgr.listServices()).toHaveLength(0);
  });
});
