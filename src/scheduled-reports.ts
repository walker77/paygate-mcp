/**
 * Scheduled Reports — Automated periodic usage, billing, and compliance reports.
 *
 * Generates daily/weekly/monthly reports and delivers them via webhook URL.
 * Reports include usage summaries, billing breakdowns, top consumers,
 * tool analytics, and compliance snapshots.
 *
 * @example
 * ```ts
 * const reports = new ScheduledReportManager();
 * reports.configure({ enabled: true });
 *
 * // Create a daily usage report schedule
 * const schedule = reports.createSchedule({
 *   name: 'daily-usage',
 *   type: 'usage',
 *   frequency: 'daily',
 *   webhookUrl: 'https://example.com/reports',
 *   enabled: true,
 * });
 * ```
 */

import * as crypto from 'crypto';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ReportType = 'usage' | 'billing' | 'compliance' | 'security';
export type ReportFrequency = 'daily' | 'weekly' | 'monthly';

export interface ReportSchedule {
  id: string;
  name: string;
  type: ReportType;
  frequency: ReportFrequency;
  webhookUrl: string;
  webhookSecret?: string;
  enabled: boolean;
  filters?: ReportFilters;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunStatus?: 'success' | 'failed';
  runCount: number;
}

export interface ReportFilters {
  namespace?: string;
  group?: string;
  tools?: string[];
  keys?: string[];
}

export interface ReportCreateParams {
  name: string;
  type: ReportType;
  frequency: ReportFrequency;
  webhookUrl: string;
  webhookSecret?: string;
  enabled?: boolean;
  filters?: ReportFilters;
}

export interface GeneratedReport {
  id: string;
  scheduleId: string;
  scheduleName: string;
  type: ReportType;
  frequency: ReportFrequency;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  data: ReportData;
}

export interface ReportData {
  summary: ReportSummary;
  topConsumers: ReportConsumer[];
  topTools: ReportTool[];
  trends: ReportTrend[];
}

export interface ReportSummary {
  totalCalls: number;
  totalCreditsSpent: number;
  totalCreditsAllocated: number;
  uniqueConsumers: number;
  uniqueTools: number;
  successRate: number;
  avgResponseTimeMs: number;
}

export interface ReportConsumer {
  key: string;
  calls: number;
  creditsSpent: number;
}

export interface ReportTool {
  tool: string;
  calls: number;
  creditsSpent: number;
  avgResponseTimeMs: number;
}

export interface ReportTrend {
  period: string;
  calls: number;
  creditsSpent: number;
}

export interface ScheduledReportStats {
  totalSchedules: number;
  enabledSchedules: number;
  disabledSchedules: number;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  byType: Record<ReportType, number>;
  byFrequency: Record<ReportFrequency, number>;
}

export interface ScheduledReportConfig {
  enabled: boolean;
  maxSchedules: number;
  requestTimeoutMs: number;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeId(): string {
  return 'rpt_' + crypto.randomBytes(8).toString('hex');
}

function makeReportId(): string {
  return 'rr_' + crypto.randomBytes(8).toString('hex');
}

function getPeriodBounds(frequency: ReportFrequency, now: Date): { start: Date; end: Date } {
  const end = new Date(now);
  const start = new Date(now);

  switch (frequency) {
    case 'daily':
      start.setUTCDate(start.getUTCDate() - 1);
      start.setUTCHours(0, 0, 0, 0);
      end.setUTCHours(0, 0, 0, 0);
      break;
    case 'weekly':
      start.setUTCDate(start.getUTCDate() - 7);
      start.setUTCHours(0, 0, 0, 0);
      end.setUTCHours(0, 0, 0, 0);
      break;
    case 'monthly':
      start.setUTCMonth(start.getUTCMonth() - 1);
      start.setUTCDate(1);
      start.setUTCHours(0, 0, 0, 0);
      end.setUTCDate(1);
      end.setUTCHours(0, 0, 0, 0);
      break;
  }

  return { start, end };
}

/* ------------------------------------------------------------------ */
/*  Manager                                                            */
/* ------------------------------------------------------------------ */

export class ScheduledReportManager {
  private schedules = new Map<string, ReportSchedule>();
  private config: ScheduledReportConfig = {
    enabled: false,
    maxSchedules: 50,
    requestTimeoutMs: 15_000,
  };

  /* ── Schedule CRUD ─────────────────────────────────────────────── */

  createSchedule(params: ReportCreateParams): ReportSchedule {
    if (!this.config.enabled) throw new Error('Scheduled reports are disabled');
    if (this.schedules.size >= this.config.maxSchedules) {
      throw new Error(`Maximum schedules reached (${this.config.maxSchedules})`);
    }
    if (!params.name || !params.type || !params.frequency || !params.webhookUrl) {
      throw new Error('name, type, frequency, and webhookUrl are required');
    }

    const VALID_TYPES: ReportType[] = ['usage', 'billing', 'compliance', 'security'];
    const VALID_FREQS: ReportFrequency[] = ['daily', 'weekly', 'monthly'];
    if (!VALID_TYPES.includes(params.type)) throw new Error(`Invalid type: ${params.type}`);
    if (!VALID_FREQS.includes(params.frequency)) throw new Error(`Invalid frequency: ${params.frequency}`);

    // Validate URL
    try { new URL(params.webhookUrl); } catch { throw new Error('Invalid webhookUrl'); }

    // Check duplicate name
    for (const s of this.schedules.values()) {
      if (s.name === params.name) throw new Error(`Schedule name '${params.name}' already exists`);
    }

    const now = new Date().toISOString();
    const schedule: ReportSchedule = {
      id: makeId(),
      name: params.name,
      type: params.type,
      frequency: params.frequency,
      webhookUrl: params.webhookUrl,
      webhookSecret: params.webhookSecret,
      enabled: params.enabled !== false,
      filters: params.filters,
      createdAt: now,
      updatedAt: now,
      runCount: 0,
    };

    this.schedules.set(schedule.id, schedule);
    return schedule;
  }

  getSchedule(id: string): ReportSchedule | undefined {
    return this.schedules.get(id);
  }

  getScheduleByName(name: string): ReportSchedule | undefined {
    for (const s of this.schedules.values()) {
      if (s.name === name) return s;
    }
    return undefined;
  }

  listSchedules(filter?: { type?: ReportType; frequency?: ReportFrequency; enabled?: boolean }): ReportSchedule[] {
    let result = Array.from(this.schedules.values());
    if (filter?.type) result = result.filter(s => s.type === filter.type);
    if (filter?.frequency) result = result.filter(s => s.frequency === filter.frequency);
    if (filter?.enabled !== undefined) result = result.filter(s => s.enabled === filter.enabled);
    return result;
  }

  updateSchedule(id: string, updates: Partial<Pick<ReportSchedule, 'name' | 'webhookUrl' | 'webhookSecret' | 'enabled' | 'filters'>>): ReportSchedule {
    const schedule = this.schedules.get(id);
    if (!schedule) throw new Error(`Schedule not found: ${id}`);

    if (updates.name !== undefined) {
      // Check duplicate name
      for (const s of this.schedules.values()) {
        if (s.id !== id && s.name === updates.name) {
          throw new Error(`Schedule name '${updates.name}' already exists`);
        }
      }
      schedule.name = updates.name;
    }
    if (updates.webhookUrl !== undefined) {
      try { new URL(updates.webhookUrl); } catch { throw new Error('Invalid webhookUrl'); }
      schedule.webhookUrl = updates.webhookUrl;
    }
    if (updates.webhookSecret !== undefined) schedule.webhookSecret = updates.webhookSecret;
    if (updates.enabled !== undefined) schedule.enabled = updates.enabled;
    if (updates.filters !== undefined) schedule.filters = updates.filters;

    schedule.updatedAt = new Date().toISOString();
    return schedule;
  }

  deleteSchedule(id: string): boolean {
    return this.schedules.delete(id);
  }

  /* ── Report Generation ─────────────────────────────────────────── */

  generateReport(scheduleId: string, dataProvider?: () => ReportData): GeneratedReport {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) throw new Error(`Schedule not found: ${scheduleId}`);

    const now = new Date();
    const { start, end } = getPeriodBounds(schedule.frequency, now);

    const data = dataProvider ? dataProvider() : this.generateEmptyData();

    const report: GeneratedReport = {
      id: makeReportId(),
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      type: schedule.type,
      frequency: schedule.frequency,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      generatedAt: now.toISOString(),
      data,
    };

    schedule.lastRunAt = now.toISOString();
    schedule.lastRunStatus = 'success';
    schedule.runCount++;
    schedule.updatedAt = now.toISOString();

    return report;
  }

  markRunFailed(scheduleId: string): void {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) return;
    schedule.lastRunAt = new Date().toISOString();
    schedule.lastRunStatus = 'failed';
    schedule.runCount++;
    schedule.updatedAt = schedule.lastRunAt;
  }

  private generateEmptyData(): ReportData {
    return {
      summary: {
        totalCalls: 0,
        totalCreditsSpent: 0,
        totalCreditsAllocated: 0,
        uniqueConsumers: 0,
        uniqueTools: 0,
        successRate: 100,
        avgResponseTimeMs: 0,
      },
      topConsumers: [],
      topTools: [],
      trends: [],
    };
  }

  /* ── Delivery ──────────────────────────────────────────────────── */

  async deliverReport(report: GeneratedReport, schedule: ReportSchedule): Promise<{ success: boolean; statusCode?: number; error?: string }> {
    const body = JSON.stringify(report);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (schedule.webhookSecret) {
      const sig = crypto.createHmac('sha256', schedule.webhookSecret).update(body).digest('hex');
      headers['X-PayGate-Signature'] = sig;
    }

    try {
      const url = new URL(schedule.webhookUrl);
      const mod = url.protocol === 'https:' ? await import('https') : await import('http');

      return new Promise((resolve) => {
        const req = mod.request(url, {
          method: 'POST',
          headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() },
          timeout: this.config.requestTimeoutMs,
        }, (res) => {
          res.resume();
          const code = res.statusCode ?? 0;
          resolve({ success: code >= 200 && code < 300, statusCode: code });
        });

        req.on('error', (err) => resolve({ success: false, error: err.message }));
        req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'timeout' }); });
        req.write(body);
        req.end();
      });
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /* ── Config & Stats ────────────────────────────────────────────── */

  configure(updates: Partial<ScheduledReportConfig>): ScheduledReportConfig {
    if (updates.enabled !== undefined) this.config.enabled = updates.enabled;
    if (updates.maxSchedules !== undefined && updates.maxSchedules > 0) this.config.maxSchedules = updates.maxSchedules;
    if (updates.requestTimeoutMs !== undefined && updates.requestTimeoutMs > 0) this.config.requestTimeoutMs = updates.requestTimeoutMs;
    return { ...this.config };
  }

  stats(): ScheduledReportStats {
    const schedules = Array.from(this.schedules.values());
    const byType: Record<ReportType, number> = { usage: 0, billing: 0, compliance: 0, security: 0 };
    const byFrequency: Record<ReportFrequency, number> = { daily: 0, weekly: 0, monthly: 0 };
    let successfulRuns = 0;
    let failedRuns = 0;
    let totalRuns = 0;
    let enabled = 0;

    for (const s of schedules) {
      byType[s.type]++;
      byFrequency[s.frequency]++;
      totalRuns += s.runCount;
      if (s.enabled) enabled++;
      if (s.lastRunStatus === 'success') successfulRuns++;
      if (s.lastRunStatus === 'failed') failedRuns++;
    }

    return {
      totalSchedules: schedules.length,
      enabledSchedules: enabled,
      disabledSchedules: schedules.length - enabled,
      totalRuns,
      successfulRuns,
      failedRuns,
      byType,
      byFrequency,
    };
  }

  clear(): void {
    this.schedules.clear();
  }
}
