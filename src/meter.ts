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

  getEvents(since?: string): UsageEvent[] {
    if (!since) return [...this.events];
    return this.events.filter(e => e.timestamp >= since);
  }

  getSummary(since?: string): UsageSummary {
    const events = this.getEvents(since);
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

  clear(): void {
    this.events = [];
  }

  get eventCount(): number {
    return this.events.length;
  }
}
