/**
 * UsageMeter — Tracks all tool call events for billing and analytics.
 */

import { UsageEvent, UsageSummary } from './types';

export class UsageMeter {
  private events: UsageEvent[] = [];
  private readonly maxEvents: number;

  constructor(maxEvents = 100_000) {
    this.maxEvents = maxEvents;
  }

  record(event: UsageEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      const dropCount = Math.floor(this.maxEvents * 0.25);
      this.events = this.events.slice(dropCount);
    }
  }

  getEvents(since?: string, namespace?: string): UsageEvent[] {
    let events = this.events;
    if (since) {
      events = events.filter(e => e.timestamp >= since);
    }
    if (namespace) {
      events = events.filter(e => e.namespace === namespace);
    }
    return [...events];
  }

  getSummary(since?: string, namespace?: string): UsageSummary {
    const events = this.getEvents(since, namespace);
    const summary: UsageSummary = {
      totalCalls: 0,
      totalCreditsSpent: 0,
      totalDenied: 0,
      perTool: {},
      perKey: {},
      denyReasons: {},
    };

    for (const event of events) {
      summary.totalCalls++;
      if (event.allowed) {
        summary.totalCreditsSpent += event.creditsCharged;
      } else {
        summary.totalDenied++;
        if (event.denyReason) {
          summary.denyReasons[event.denyReason] = (summary.denyReasons[event.denyReason] || 0) + 1;
        }
      }

      // Per-tool
      if (!summary.perTool[event.tool]) {
        summary.perTool[event.tool] = { calls: 0, credits: 0, denied: 0 };
      }
      summary.perTool[event.tool].calls++;
      if (event.allowed) {
        summary.perTool[event.tool].credits += event.creditsCharged;
      } else {
        summary.perTool[event.tool].denied++;
      }

      // Per-key
      const keyLabel = event.keyName || event.apiKey.slice(0, 10);
      if (!summary.perKey[keyLabel]) {
        summary.perKey[keyLabel] = { calls: 0, credits: 0, denied: 0 };
      }
      summary.perKey[keyLabel].calls++;
      if (event.allowed) {
        summary.perKey[keyLabel].credits += event.creditsCharged;
      } else {
        summary.perKey[keyLabel].denied++;
      }
    }

    return summary;
  }

  /**
   * Get usage summary for a specific API key.
   * Returns per-tool breakdown, time-series (hourly buckets), and deny reasons.
   */
  getKeyUsage(apiKey: string, since?: string): {
    totalCalls: number;
    totalAllowed: number;
    totalDenied: number;
    totalCreditsSpent: number;
    perTool: Record<string, { calls: number; credits: number; denied: number }>;
    denyReasons: Record<string, number>;
    timeSeries: Array<{ hour: string; calls: number; credits: number; denied: number }>;
    recentEvents: Array<{
      timestamp: string;
      tool: string;
      creditsCharged: number;
      allowed: boolean;
      denyReason?: string;
    }>;
  } {
    // Gate records events with truncated apiKey (first 10 chars) for privacy.
    // Match both full key and truncated prefix so callers can pass either form.
    const prefix = apiKey.slice(0, 10);
    let events = this.events.filter(e => e.apiKey === apiKey || e.apiKey === prefix);
    if (since) {
      events = events.filter(e => e.timestamp >= since);
    }

    const result = {
      totalCalls: 0,
      totalAllowed: 0,
      totalDenied: 0,
      totalCreditsSpent: 0,
      perTool: {} as Record<string, { calls: number; credits: number; denied: number }>,
      denyReasons: {} as Record<string, number>,
      timeSeries: [] as Array<{ hour: string; calls: number; credits: number; denied: number }>,
      recentEvents: [] as Array<{
        timestamp: string;
        tool: string;
        creditsCharged: number;
        allowed: boolean;
        denyReason?: string;
      }>,
    };

    // Hourly buckets for time-series
    const hourlyBuckets = new Map<string, { calls: number; credits: number; denied: number }>();

    for (const event of events) {
      result.totalCalls++;
      if (event.allowed) {
        result.totalAllowed++;
        result.totalCreditsSpent += event.creditsCharged;
      } else {
        result.totalDenied++;
        if (event.denyReason) {
          result.denyReasons[event.denyReason] = (result.denyReasons[event.denyReason] || 0) + 1;
        }
      }

      // Per-tool
      if (!result.perTool[event.tool]) {
        result.perTool[event.tool] = { calls: 0, credits: 0, denied: 0 };
      }
      result.perTool[event.tool].calls++;
      if (event.allowed) {
        result.perTool[event.tool].credits += event.creditsCharged;
      } else {
        result.perTool[event.tool].denied++;
      }

      // Hourly bucket
      const hour = event.timestamp.slice(0, 13) + ':00:00'; // YYYY-MM-DDTHH:00:00
      if (!hourlyBuckets.has(hour)) {
        hourlyBuckets.set(hour, { calls: 0, credits: 0, denied: 0 });
      }
      const bucket = hourlyBuckets.get(hour)!;
      bucket.calls++;
      if (event.allowed) {
        bucket.credits += event.creditsCharged;
      } else {
        bucket.denied++;
      }
    }

    // Convert hourly buckets to sorted time-series
    result.timeSeries = Array.from(hourlyBuckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([hour, data]) => ({ hour, ...data }));

    // Recent events (last 50, newest first)
    result.recentEvents = events
      .slice(-50)
      .reverse()
      .map(e => ({
        timestamp: e.timestamp,
        tool: e.tool,
        creditsCharged: e.creditsCharged,
        allowed: e.allowed,
        denyReason: e.denyReason,
      }));

    return result;
  }

  clear(): void {
    this.events = [];
  }

  get eventCount(): number {
    return this.events.length;
  }
}
