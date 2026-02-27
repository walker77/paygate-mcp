/**
 * WebhookRouter — Route webhook events to different destinations based on filter rules.
 *
 * Filter rules match on:
 *   - Event type (exact match or '*' wildcard)
 *   - API key prefix (e.g., 'pk_prod_')
 *
 * Events can be routed to multiple destinations if multiple rules match.
 * Unmatched events fall through to the default webhook URL (if configured).
 *
 * Each unique destination URL gets its own WebhookEmitter with independent
 * retry queues, dead letter queues, and delivery stats.
 *
 * Admin API:
 *   POST   /webhooks/filters          — Create filter rule
 *   GET    /webhooks/filters          — List filter rules
 *   POST   /webhooks/filters/update   — Update filter rule
 *   POST   /webhooks/filters/delete   — Delete filter rule
 */

import { randomBytes } from 'crypto';
import { WebhookEmitter, WebhookAdminEvent, WebhookEvent } from './webhook';
import { UsageEvent, WebhookFilterRule } from './types';

// ─── WebhookRouter ─────────────────────────────────────────────────────────

export class WebhookRouter {
  /** Default emitter for unmatched events (null if no default URL). */
  private defaultEmitter: WebhookEmitter | null;
  /** Per-URL emitters for filter destinations. */
  private emitters = new Map<string, WebhookEmitter>();
  /** Active filter rules. */
  private rules: WebhookFilterRule[] = [];
  /** Global config for new emitters. */
  private readonly maxRetries: number;
  /** Whether to re-check SSRF at delivery time (DNS rebinding defense). */
  private readonly ssrfCheckOnDelivery: boolean;

  constructor(options: {
    defaultUrl?: string | null;
    defaultSecret?: string | null;
    maxRetries?: number;
    filters?: WebhookFilterRule[];
    ssrfCheckOnDelivery?: boolean;
  } = {}) {
    this.maxRetries = options.maxRetries ?? 5;
    this.ssrfCheckOnDelivery = options.ssrfCheckOnDelivery ?? true;

    // Default emitter
    if (options.defaultUrl) {
      this.defaultEmitter = new WebhookEmitter(options.defaultUrl, {
        secret: options.defaultSecret || null,
        maxRetries: this.maxRetries,
        ssrfCheckOnDelivery: this.ssrfCheckOnDelivery,
      });
    } else {
      this.defaultEmitter = null;
    }

    // Initialize filter rules and their emitters
    if (options.filters) {
      for (const rule of options.filters) {
        this.addRule(rule);
      }
    }
  }

  // ─── Filter CRUD ──────────────────────────────────────────────────────────

  /**
   * Add a filter rule. Creates a new emitter for the destination URL if needed.
   */
  addRule(rule: WebhookFilterRule): WebhookFilterRule {
    // Ensure ID
    if (!rule.id) {
      rule.id = 'wf_' + randomBytes(8).toString('hex');
    }

    // Validate
    if (!rule.url) throw new Error('Filter rule must have a URL');
    if (!rule.events || rule.events.length === 0) throw new Error('Filter rule must have at least one event type');
    if (!rule.name) rule.name = `Filter ${rule.id}`;
    if (rule.active === undefined) rule.active = true;

    // Deduplicate by ID
    this.rules = this.rules.filter(r => r.id !== rule.id);
    this.rules.push(rule);

    // Ensure emitter for this URL exists
    this.getOrCreateEmitter(rule.url, rule.secret || null);

    return rule;
  }

  /**
   * Update an existing filter rule.
   */
  updateRule(id: string, updates: Partial<Omit<WebhookFilterRule, 'id'>>): WebhookFilterRule {
    const rule = this.rules.find(r => r.id === id);
    if (!rule) throw new Error(`Filter rule '${id}' not found`);

    if (updates.name !== undefined) rule.name = updates.name;
    if (updates.events !== undefined) rule.events = updates.events;
    if (updates.url !== undefined) {
      rule.url = updates.url;
      this.getOrCreateEmitter(rule.url, updates.secret ?? rule.secret ?? null);
    }
    if (updates.secret !== undefined) rule.secret = updates.secret;
    if (updates.keyPrefixes !== undefined) rule.keyPrefixes = updates.keyPrefixes;
    if (updates.active !== undefined) rule.active = updates.active;

    return rule;
  }

  /**
   * Delete a filter rule by ID.
   */
  deleteRule(id: string): boolean {
    const idx = this.rules.findIndex(r => r.id === id);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);

    // Clean up orphaned emitters (URL no longer referenced by any rule)
    this.cleanupOrphanedEmitters();
    return true;
  }

  /**
   * List all filter rules.
   */
  listRules(): WebhookFilterRule[] {
    return [...this.rules];
  }

  /**
   * Get a filter rule by ID.
   */
  getRule(id: string): WebhookFilterRule | undefined {
    return this.rules.find(r => r.id === id);
  }

  get ruleCount(): number {
    return this.rules.length;
  }

  // ─── Event Routing ────────────────────────────────────────────────────────

  /**
   * Route a usage event to matching filter destinations + default.
   */
  emit(event: UsageEvent): void {
    let matched = false;

    for (const rule of this.rules) {
      if (!rule.active) continue;
      if (this.matchesRule(rule, event.tool ? 'usage' : 'usage', event.apiKey)) {
        const emitter = this.emitters.get(rule.url);
        if (emitter) {
          emitter.emit(event);
          matched = true;
        }
      }
    }

    // Fall through to default if no filter matched (or always send to default)
    if (this.defaultEmitter) {
      this.defaultEmitter.emit(event);
    }
  }

  /**
   * Route an admin event to matching filter destinations + default.
   */
  emitAdmin(type: WebhookAdminEvent['type'], actor: string, metadata: Record<string, unknown> = {}): void {
    const apiKey = (metadata.keyMasked as string) || (metadata.apiKey as string) || '';

    for (const rule of this.rules) {
      if (!rule.active) continue;
      if (this.matchesRule(rule, type, apiKey)) {
        const emitter = this.emitters.get(rule.url);
        if (emitter) {
          emitter.emitAdmin(type, actor, metadata);
        }
      }
    }

    // Always send to default (backward compatible)
    if (this.defaultEmitter) {
      this.defaultEmitter.emitAdmin(type, actor, metadata);
    }
  }

  // ─── Rule Matching ────────────────────────────────────────────────────────

  /**
   * Check if an event type + API key matches a filter rule.
   */
  private matchesRule(rule: WebhookFilterRule, eventType: string, apiKey: string): boolean {
    // Match event type
    const eventsMatch = rule.events.includes('*') || rule.events.includes(eventType);
    if (!eventsMatch) return false;

    // Match key prefix (if specified)
    if (rule.keyPrefixes && rule.keyPrefixes.length > 0) {
      const keyMatches = rule.keyPrefixes.some(prefix => apiKey.startsWith(prefix));
      if (!keyMatches) return false;
    }

    return true;
  }

  // ─── Emitter Management ───────────────────────────────────────────────────

  private getOrCreateEmitter(url: string, secret: string | null): WebhookEmitter {
    let emitter = this.emitters.get(url);
    if (!emitter) {
      emitter = new WebhookEmitter(url, {
        secret,
        maxRetries: this.maxRetries,
        ssrfCheckOnDelivery: this.ssrfCheckOnDelivery,
      });
      this.emitters.set(url, emitter);
    }
    return emitter;
  }

  /**
   * Remove emitters for URLs that are no longer referenced by any rule.
   */
  private cleanupOrphanedEmitters(): void {
    const usedUrls = new Set(this.rules.map(r => r.url));
    for (const [url, emitter] of this.emitters) {
      if (!usedUrls.has(url)) {
        emitter.destroy();
        this.emitters.delete(url);
      }
    }
  }

  // ─── Stats / Inspection ───────────────────────────────────────────────────

  /**
   * Get the default emitter (for backward-compatible /webhooks/stats and /webhooks/dead-letter).
   */
  get defaultWebhook(): WebhookEmitter | null {
    return this.defaultEmitter;
  }

  /**
   * Get aggregate stats across all emitters.
   */
  getAggregateStats(): {
    emitterCount: number;
    filterCount: number;
    perUrl: Record<string, ReturnType<WebhookEmitter['getRetryStats']>>;
  } {
    const perUrl: Record<string, ReturnType<WebhookEmitter['getRetryStats']>> = {};

    if (this.defaultEmitter) {
      perUrl['default'] = this.defaultEmitter.getRetryStats();
    }

    for (const [url, emitter] of this.emitters) {
      perUrl[url] = emitter.getRetryStats();
    }

    return {
      emitterCount: this.emitters.size + (this.defaultEmitter ? 1 : 0),
      filterCount: this.rules.length,
      perUrl,
    };
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  destroy(): void {
    if (this.defaultEmitter) {
      this.defaultEmitter.destroy();
      this.defaultEmitter = null;
    }
    for (const emitter of this.emitters.values()) {
      emitter.destroy();
    }
    this.emitters.clear();
  }
}
