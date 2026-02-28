import { NotificationManager } from '../src/notification-manager';

describe('NotificationManager', () => {
  let mgr: NotificationManager;

  beforeEach(() => {
    mgr = new NotificationManager({ defaultThrottleMs: 0 }); // no throttle for tests
  });

  // ── Channel Management ──────────────────────────────────────────

  it('adds a channel', () => {
    const ch = mgr.addChannel({ name: 'email', type: 'email' });
    expect(ch.name).toBe('email');
    expect(ch.type).toBe('email');
    expect(ch.enabled).toBe(true);
  });

  it('rejects duplicate channel names', () => {
    mgr.addChannel({ name: 'email', type: 'email' });
    expect(() => mgr.addChannel({ name: 'email', type: 'email' })).toThrow('already exists');
  });

  it('gets channel by name', () => {
    mgr.addChannel({ name: 'slack', type: 'slack' });
    expect(mgr.getChannelByName('slack')!.type).toBe('slack');
  });

  it('lists channels', () => {
    mgr.addChannel({ name: 'a', type: 'email' });
    mgr.addChannel({ name: 'b', type: 'slack' });
    expect(mgr.listChannels()).toHaveLength(2);
  });

  it('removes a channel', () => {
    const ch = mgr.addChannel({ name: 'a', type: 'email' });
    expect(mgr.removeChannel(ch.id)).toBe(true);
    expect(mgr.getChannelByName('a')).toBeNull();
  });

  it('enables and disables channels', () => {
    const ch = mgr.addChannel({ name: 'a', type: 'email' });
    mgr.setChannelEnabled(ch.id, false);
    expect(mgr.getChannel(ch.id)!.enabled).toBe(false);
  });

  // ── Rule Management ─────────────────────────────────────────────

  it('adds a rule', () => {
    mgr.addChannel({ name: 'email', type: 'email' });
    const rule = mgr.addRule({ event: 'quota.exceeded', channels: ['email'], template: 'Quota exceeded' });
    expect(rule.event).toBe('quota.exceeded');
    expect(rule.channels).toEqual(['email']);
  });

  it('requires at least one channel', () => {
    expect(() => mgr.addRule({ event: 'e', channels: [], template: '' })).toThrow('At least one channel');
  });

  it('lists rules sorted by priority', () => {
    mgr.addChannel({ name: 'ch', type: 'log' });
    mgr.addRule({ event: 'a', channels: ['ch'], template: '', priority: 1 });
    mgr.addRule({ event: 'b', channels: ['ch'], template: '', priority: 10 });
    const rules = mgr.listRules();
    expect(rules[0].event).toBe('b');
  });

  it('removes a rule', () => {
    mgr.addChannel({ name: 'ch', type: 'log' });
    const rule = mgr.addRule({ event: 'a', channels: ['ch'], template: '' });
    expect(mgr.removeRule(rule.id)).toBe(true);
    expect(mgr.getRule(rule.id)).toBeNull();
  });

  it('gets rules for event', () => {
    mgr.addChannel({ name: 'ch', type: 'log' });
    mgr.addRule({ event: 'a', channels: ['ch'], template: '' });
    mgr.addRule({ event: 'b', channels: ['ch'], template: '' });
    expect(mgr.getRulesForEvent('a')).toHaveLength(1);
  });

  // ── Notification Dispatch ───────────────────────────────────────

  it('sends notification for matching event', () => {
    mgr.addChannel({ name: 'log', type: 'log' });
    mgr.addRule({ event: 'alert', channels: ['log'], template: 'Alert: {{msg}}' });

    const result = mgr.notify('alert', { msg: 'test' });
    expect(result.matchedRules).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.notifications[0].renderedMessage).toBe('Alert: test');
    expect(result.notifications[0].status).toBe('sent');
  });

  it('no match returns zero sent', () => {
    const result = mgr.notify('unknown');
    expect(result.matchedRules).toBe(0);
    expect(result.sent).toBe(0);
  });

  it('fails for missing channel', () => {
    mgr.addRule({ event: 'e', channels: ['nonexistent'], template: '' });
    const result = mgr.notify('e');
    expect(result.failed).toBe(1);
    expect(result.notifications[0].status).toBe('failed');
  });

  it('fails for disabled channel', () => {
    const ch = mgr.addChannel({ name: 'ch', type: 'log' });
    mgr.setChannelEnabled(ch.id, false);
    mgr.addRule({ event: 'e', channels: ['ch'], template: '' });
    const result = mgr.notify('e');
    expect(result.failed).toBe(1);
  });

  it('sends to multiple channels', () => {
    mgr.addChannel({ name: 'a', type: 'log' });
    mgr.addChannel({ name: 'b', type: 'log' });
    mgr.addRule({ event: 'e', channels: ['a', 'b'], template: 'msg' });
    const result = mgr.notify('e');
    expect(result.sent).toBe(2);
  });

  // ── Template Rendering ──────────────────────────────────────────

  it('renders template variables', () => {
    mgr.addChannel({ name: 'ch', type: 'log' });
    mgr.addRule({ event: 'e', channels: ['ch'], template: 'Key {{key}} used {{credits}} credits' });
    const result = mgr.notify('e', { key: 'key_abc', credits: 100 });
    expect(result.notifications[0].renderedMessage).toBe('Key key_abc used 100 credits');
  });

  it('preserves unmatched template variables', () => {
    mgr.addChannel({ name: 'ch', type: 'log' });
    mgr.addRule({ event: 'e', channels: ['ch'], template: 'Hello {{name}} {{unknown}}' });
    const result = mgr.notify('e', { name: 'test' });
    expect(result.notifications[0].renderedMessage).toBe('Hello test {{unknown}}');
  });

  // ── Throttling ──────────────────────────────────────────────────

  it('throttles duplicate notifications', () => {
    const m = new NotificationManager({ defaultThrottleMs: 60000 });
    m.addChannel({ name: 'ch', type: 'log' });
    m.addRule({ event: 'e', channels: ['ch'], template: 'msg' });

    const r1 = m.notify('e', { key: 'k1' });
    expect(r1.sent).toBe(1);

    const r2 = m.notify('e', { key: 'k1' });
    expect(r2.throttled).toBe(1);
    expect(r2.sent).toBe(0);
    m.destroy();
  });

  it('does not throttle different keys', () => {
    const m = new NotificationManager({ defaultThrottleMs: 60000 });
    m.addChannel({ name: 'ch', type: 'log' });
    m.addRule({ event: 'e', channels: ['ch'], template: 'msg' });

    m.notify('e', { key: 'k1' });
    const r2 = m.notify('e', { key: 'k2' });
    expect(r2.sent).toBe(1);
    m.destroy();
  });

  // ── History ─────────────────────────────────────────────────────

  it('records notification history', () => {
    mgr.addChannel({ name: 'ch', type: 'log' });
    mgr.addRule({ event: 'e', channels: ['ch'], template: 'msg' });

    mgr.notify('e');
    mgr.notify('e');

    const history = mgr.getHistory();
    expect(history).toHaveLength(2);
  });

  it('filters history by event', () => {
    mgr.addChannel({ name: 'ch', type: 'log' });
    mgr.addRule({ event: 'a', channels: ['ch'], template: '' });
    mgr.addRule({ event: 'b', channels: ['ch'], template: '' });

    mgr.notify('a');
    mgr.notify('b');

    expect(mgr.getHistory({ event: 'a' })).toHaveLength(1);
  });

  it('filters history by status', () => {
    mgr.addRule({ event: 'e', channels: ['missing'], template: '' });
    mgr.addChannel({ name: 'ok', type: 'log' });
    mgr.addRule({ event: 'e', channels: ['ok'], template: '' });

    mgr.notify('e');
    expect(mgr.getHistory({ status: 'failed' })).toHaveLength(1);
    expect(mgr.getHistory({ status: 'sent' })).toHaveLength(1);
  });

  // ── Stats ───────────────────────────────────────────────────────

  it('tracks stats', () => {
    mgr.addChannel({ name: 'ch', type: 'log' });
    mgr.addRule({ event: 'e', channels: ['ch'], template: '' });
    mgr.notify('e');

    const stats = mgr.getStats();
    expect(stats.totalChannels).toBe(1);
    expect(stats.enabledChannels).toBe(1);
    expect(stats.totalRules).toBe(1);
    expect(stats.totalSent).toBe(1);
  });

  // ── Destroy ─────────────────────────────────────────────────────

  it('clears all data on destroy', () => {
    mgr.addChannel({ name: 'ch', type: 'log' });
    mgr.addRule({ event: 'e', channels: ['ch'], template: '' });
    mgr.notify('e');
    mgr.destroy();
    expect(mgr.getStats().totalChannels).toBe(0);
    expect(mgr.getStats().totalRules).toBe(0);
    expect(mgr.getStats().totalSent).toBe(0);
  });
});
