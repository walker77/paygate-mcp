/**
 * NotificationManager — Event-driven notification system with channels and throttling.
 *
 * Register notification channels, define rules that match events to channels,
 * throttle duplicate notifications, and track delivery history.
 *
 * @example
 * ```ts
 * const mgr = new NotificationManager();
 *
 * mgr.addChannel({ name: 'email', type: 'email', config: { to: 'admin@co.com' } });
 * mgr.addRule({ event: 'quota.exceeded', channels: ['email'], template: 'Quota exceeded for {{key}}' });
 *
 * mgr.notify('quota.exceeded', { key: 'key_abc', usage: 950, limit: 1000 });
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type ChannelType = 'email' | 'webhook' | 'slack' | 'log' | 'custom';

export interface NotificationChannel {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: number;
}

export interface ChannelCreateParams {
  name: string;
  type: ChannelType;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface NotificationRule {
  id: string;
  event: string;
  channels: string[]; // channel names
  template: string;
  enabled: boolean;
  priority: number;
  throttleMs: number; // min ms between same event+key notifications
  conditions?: Record<string, unknown>;
  createdAt: number;
}

export interface RuleCreateParams {
  event: string;
  channels: string[];
  template: string;
  enabled?: boolean;
  priority?: number;
  throttleMs?: number;
  conditions?: Record<string, unknown>;
}

export interface NotificationRecord {
  id: string;
  ruleId: string;
  event: string;
  channel: string;
  payload: Record<string, unknown>;
  renderedMessage: string;
  status: 'sent' | 'throttled' | 'failed';
  error?: string;
  timestamp: number;
}

export interface NotifyResult {
  event: string;
  matchedRules: number;
  sent: number;
  throttled: number;
  failed: number;
  notifications: NotificationRecord[];
}

export interface NotificationManagerConfig {
  /** Default throttle in ms. Default 60000 (1 min). */
  defaultThrottleMs?: number;
  /** Max notification history to retain. Default 10000. */
  maxHistory?: number;
  /** Max channels. Default 50. */
  maxChannels?: number;
  /** Max rules. Default 200. */
  maxRules?: number;
}

export interface NotificationManagerStats {
  totalChannels: number;
  enabledChannels: number;
  totalRules: number;
  enabledRules: number;
  totalSent: number;
  totalThrottled: number;
  totalFailed: number;
  historySize: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class NotificationManager {
  private channels = new Map<string, NotificationChannel>();
  private rules = new Map<string, NotificationRule>();
  private history: NotificationRecord[] = [];
  private throttleMap = new Map<string, number>(); // throttleKey → lastSentTimestamp
  private nextChannelId = 1;
  private nextRuleId = 1;
  private nextNotifId = 1;

  private defaultThrottleMs: number;
  private maxHistory: number;
  private maxChannels: number;
  private maxRules: number;

  // Stats
  private totalSent = 0;
  private totalThrottled = 0;
  private totalFailed = 0;

  constructor(config: NotificationManagerConfig = {}) {
    this.defaultThrottleMs = config.defaultThrottleMs ?? 60_000;
    this.maxHistory = config.maxHistory ?? 10_000;
    this.maxChannels = config.maxChannels ?? 50;
    this.maxRules = config.maxRules ?? 200;
  }

  // ── Channel Management ──────────────────────────────────────────

  /** Add a notification channel. */
  addChannel(params: ChannelCreateParams): NotificationChannel {
    if (!params.name) throw new Error('Channel name is required');
    if (this.getChannelByName(params.name)) {
      throw new Error(`Channel '${params.name}' already exists`);
    }
    if (this.channels.size >= this.maxChannels) {
      throw new Error(`Maximum ${this.maxChannels} channels reached`);
    }

    const channel: NotificationChannel = {
      id: `ch_${this.nextChannelId++}`,
      name: params.name,
      type: params.type,
      enabled: params.enabled ?? true,
      config: params.config ?? {},
      createdAt: Date.now(),
    };

    this.channels.set(channel.id, channel);
    return channel;
  }

  /** Get channel by ID. */
  getChannel(id: string): NotificationChannel | null {
    return this.channels.get(id) ?? null;
  }

  /** Get channel by name. */
  getChannelByName(name: string): NotificationChannel | null {
    for (const ch of this.channels.values()) {
      if (ch.name === name) return ch;
    }
    return null;
  }

  /** List all channels. */
  listChannels(): NotificationChannel[] {
    return [...this.channels.values()];
  }

  /** Remove a channel. */
  removeChannel(id: string): boolean {
    return this.channels.delete(id);
  }

  /** Enable/disable a channel. */
  setChannelEnabled(id: string, enabled: boolean): void {
    const ch = this.channels.get(id);
    if (!ch) throw new Error(`Channel '${id}' not found`);
    ch.enabled = enabled;
  }

  // ── Rule Management ─────────────────────────────────────────────

  /** Add a notification rule. */
  addRule(params: RuleCreateParams): NotificationRule {
    if (!params.event) throw new Error('Event is required');
    if (!params.channels || params.channels.length === 0) {
      throw new Error('At least one channel is required');
    }
    if (this.rules.size >= this.maxRules) {
      throw new Error(`Maximum ${this.maxRules} rules reached`);
    }

    const rule: NotificationRule = {
      id: `rule_${this.nextRuleId++}`,
      event: params.event,
      channels: params.channels,
      template: params.template,
      enabled: params.enabled ?? true,
      priority: params.priority ?? 0,
      throttleMs: params.throttleMs ?? this.defaultThrottleMs,
      conditions: params.conditions,
      createdAt: Date.now(),
    };

    this.rules.set(rule.id, rule);
    return rule;
  }

  /** Get rule by ID. */
  getRule(id: string): NotificationRule | null {
    return this.rules.get(id) ?? null;
  }

  /** List all rules. */
  listRules(): NotificationRule[] {
    return [...this.rules.values()].sort((a, b) => b.priority - a.priority);
  }

  /** Remove a rule. */
  removeRule(id: string): boolean {
    return this.rules.delete(id);
  }

  /** Enable/disable a rule. */
  setRuleEnabled(id: string, enabled: boolean): void {
    const rule = this.rules.get(id);
    if (!rule) throw new Error(`Rule '${id}' not found`);
    rule.enabled = enabled;
  }

  /** Get rules that match an event. */
  getRulesForEvent(event: string): NotificationRule[] {
    return [...this.rules.values()]
      .filter(r => r.enabled && r.event === event)
      .sort((a, b) => b.priority - a.priority);
  }

  // ── Notification Dispatch ───────────────────────────────────────

  /** Send notifications for an event. */
  notify(event: string, payload: Record<string, unknown> = {}): NotifyResult {
    const matchedRules = this.getRulesForEvent(event);
    const result: NotifyResult = {
      event,
      matchedRules: matchedRules.length,
      sent: 0,
      throttled: 0,
      failed: 0,
      notifications: [],
    };

    for (const rule of matchedRules) {
      for (const channelName of rule.channels) {
        const channel = this.getChannelByName(channelName);
        const notifId = `notif_${this.nextNotifId++}`;

        if (!channel || !channel.enabled) {
          const record: NotificationRecord = {
            id: notifId,
            ruleId: rule.id,
            event,
            channel: channelName,
            payload,
            renderedMessage: '',
            status: 'failed',
            error: !channel ? `Channel '${channelName}' not found` : 'Channel disabled',
            timestamp: Date.now(),
          };
          result.failed++;
          this.totalFailed++;
          result.notifications.push(record);
          this.addToHistory(record);
          continue;
        }

        // Check throttle
        const throttleKey = `${rule.id}:${channelName}:${payload.key ?? ''}`;
        const lastSent = this.throttleMap.get(throttleKey) ?? 0;
        const now = Date.now();

        if (rule.throttleMs > 0 && (now - lastSent) < rule.throttleMs) {
          const record: NotificationRecord = {
            id: notifId,
            ruleId: rule.id,
            event,
            channel: channelName,
            payload,
            renderedMessage: '',
            status: 'throttled',
            timestamp: now,
          };
          result.throttled++;
          this.totalThrottled++;
          result.notifications.push(record);
          this.addToHistory(record);
          continue;
        }

        // Render template
        const rendered = this.renderTemplate(rule.template, payload);

        const record: NotificationRecord = {
          id: notifId,
          ruleId: rule.id,
          event,
          channel: channelName,
          payload,
          renderedMessage: rendered,
          status: 'sent',
          timestamp: now,
        };

        this.throttleMap.set(throttleKey, now);
        result.sent++;
        this.totalSent++;
        result.notifications.push(record);
        this.addToHistory(record);
      }
    }

    return result;
  }

  // ── History ─────────────────────────────────────────────────────

  /** Get notification history. */
  getHistory(options: { event?: string; channel?: string; status?: string; limit?: number } = {}): NotificationRecord[] {
    let records = this.history;

    if (options.event) {
      records = records.filter(r => r.event === options.event);
    }
    if (options.channel) {
      records = records.filter(r => r.channel === options.channel);
    }
    if (options.status) {
      records = records.filter(r => r.status === options.status);
    }

    const limit = options.limit ?? 100;
    return records.slice(-limit);
  }

  // ── Stats ───────────────────────────────────────────────────────

  getStats(): NotificationManagerStats {
    let enabledChannels = 0;
    for (const ch of this.channels.values()) {
      if (ch.enabled) enabledChannels++;
    }

    let enabledRules = 0;
    for (const r of this.rules.values()) {
      if (r.enabled) enabledRules++;
    }

    return {
      totalChannels: this.channels.size,
      enabledChannels,
      totalRules: this.rules.size,
      enabledRules,
      totalSent: this.totalSent,
      totalThrottled: this.totalThrottled,
      totalFailed: this.totalFailed,
      historySize: this.history.length,
    };
  }

  /** Clear all data. */
  destroy(): void {
    this.channels.clear();
    this.rules.clear();
    this.history = [];
    this.throttleMap.clear();
    this.totalSent = 0;
    this.totalThrottled = 0;
    this.totalFailed = 0;
  }

  // ── Private ─────────────────────────────────────────────────────

  private renderTemplate(template: string, payload: Record<string, unknown>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
      return payload[key] !== undefined ? String(payload[key]) : `{{${key}}}`;
    });
  }

  private addToHistory(record: NotificationRecord): void {
    this.history.push(record);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
  }
}
