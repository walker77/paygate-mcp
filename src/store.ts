/**
 * KeyStore — API key + credit management with optional file persistence.
 *
 * Keys are hex strings. Credits are integers (1 credit = 1 unit of pricing).
 * Thread-safe for single-process Node.js (no async gaps in critical sections).
 *
 * When statePath is provided, state is saved to disk after every mutation
 * and loaded on construction. Uses atomic writes (tmp + rename) for safety.
 */

import { randomBytes } from 'crypto';
import { writeFileSync, readFileSync, mkdirSync, renameSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { ApiKeyRecord, QuotaConfig } from './types';

export class KeyStore {
  private keys = new Map<string, ApiKeyRecord>();
  private readonly statePath: string | null;

  constructor(statePath?: string) {
    this.statePath = statePath || null;
    if (this.statePath) {
      this.load();
    }
  }

  /**
   * Sanitize and validate credit amounts. Must be non-negative integer.
   */
  private sanitizeCredits(amount: number): number {
    const n = Math.floor(amount);
    return Math.max(0, n);
  }

  /**
   * Sanitize key name. Max 200 chars, trimmed.
   */
  private sanitizeName(name: string): string {
    return String(name).trim().slice(0, 200);
  }

  /**
   * Sanitize and validate tool list for ACL. Max 100 entries, trimmed.
   */
  private sanitizeToolList(tools?: string[]): string[] {
    if (!tools || !Array.isArray(tools)) return [];
    return tools
      .filter(t => typeof t === 'string' && t.trim().length > 0)
      .map(t => t.trim())
      .slice(0, 100);
  }

  /**
   * Create a new API key with initial credits.
   */
  createKey(name: string, initialCredits: number, options?: {
    allowedTools?: string[];
    deniedTools?: string[];
    expiresAt?: string | null;
    quota?: QuotaConfig;
  }): ApiKeyRecord {
    const key = `pg_${randomBytes(24).toString('hex')}`;
    const today = new Date().toISOString().slice(0, 10);
    const month = new Date().toISOString().slice(0, 7);
    const record: ApiKeyRecord = {
      key,
      name: this.sanitizeName(name),
      credits: this.sanitizeCredits(initialCredits),
      totalSpent: 0,
      totalCalls: 0,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      active: true,
      spendingLimit: 0,
      allowedTools: this.sanitizeToolList(options?.allowedTools),
      deniedTools: this.sanitizeToolList(options?.deniedTools),
      expiresAt: options?.expiresAt || null,
      quota: options?.quota,
      quotaDailyCalls: 0,
      quotaMonthlyCalls: 0,
      quotaDailyCredits: 0,
      quotaMonthlyCredits: 0,
      quotaLastResetDay: today,
      quotaLastResetMonth: month,
    };
    this.keys.set(key, record);
    this.save();
    return record;
  }

  /**
   * Look up an API key. Returns null if not found, inactive, or expired.
   */
  getKey(key: string): ApiKeyRecord | null {
    const record = this.keys.get(key);
    if (!record || !record.active) return null;
    // Check expiry
    if (record.expiresAt) {
      const expiresAt = new Date(record.expiresAt).getTime();
      if (!isNaN(expiresAt) && Date.now() >= expiresAt) {
        return null; // Expired
      }
    }
    return record;
  }

  /**
   * Look up key without expiry check (for admin operations on expired keys).
   */
  getKeyRaw(key: string): ApiKeyRecord | null {
    const record = this.keys.get(key);
    if (!record) return null;
    return record;
  }

  /**
   * Check if a key is expired (not inactive, specifically expired).
   */
  isExpired(key: string): boolean {
    const record = this.keys.get(key);
    if (!record) return false;
    if (!record.expiresAt) return false;
    const expiresAt = new Date(record.expiresAt).getTime();
    return !isNaN(expiresAt) && Date.now() >= expiresAt;
  }

  /**
   * Check if key has enough credits. Does NOT deduct.
   */
  hasCredits(key: string, amount: number): boolean {
    const record = this.getKey(key);
    if (!record) return false;
    return record.credits >= amount;
  }

  /**
   * Deduct credits from a key. Returns false if insufficient.
   * Call ONLY after gate decision is ALLOW.
   */
  deductCredits(key: string, amount: number): boolean {
    const record = this.getKey(key);
    if (!record || record.credits < amount) return false;

    record.credits -= amount;
    record.totalSpent += amount;
    record.totalCalls++;
    record.lastUsedAt = new Date().toISOString();
    this.save();
    return true;
  }

  /**
   * Add credits to a key (top-up). Amount must be positive.
   */
  addCredits(key: string, amount: number): boolean {
    const record = this.getKey(key);
    if (!record) return false;
    const sanitized = this.sanitizeCredits(amount);
    if (sanitized <= 0) return false;
    record.credits += sanitized;
    this.save();
    return true;
  }

  /**
   * Set tool ACL for a key. allowedTools = whitelist, deniedTools = blacklist.
   */
  setAcl(key: string, allowedTools?: string[], deniedTools?: string[]): boolean {
    const record = this.getKey(key);
    if (!record) return false;
    if (allowedTools !== undefined) {
      record.allowedTools = this.sanitizeToolList(allowedTools);
    }
    if (deniedTools !== undefined) {
      record.deniedTools = this.sanitizeToolList(deniedTools);
    }
    this.save();
    return true;
  }

  /**
   * Set quota for a key. Null = use global defaults / unlimited.
   */
  setQuota(key: string, quota: QuotaConfig | null): boolean {
    const record = this.getKey(key);
    if (!record) return false;
    record.quota = quota || undefined;
    this.save();
    return true;
  }

  /**
   * Set expiry for a key. Null = never expires.
   */
  setExpiry(key: string, expiresAt: string | null): boolean {
    const record = this.getKeyRaw(key);
    if (!record) return false;
    record.expiresAt = expiresAt;
    this.save();
    return true;
  }

  /**
   * Revoke an API key.
   */
  revokeKey(key: string): boolean {
    const record = this.keys.get(key);
    if (!record) return false;
    record.active = false;
    this.save();
    return true;
  }

  /**
   * List all keys (with key values masked). Includes expiry status.
   */
  listKeys(): Array<Omit<ApiKeyRecord, 'key'> & { keyPrefix: string; expired: boolean }> {
    const result: Array<Omit<ApiKeyRecord, 'key'> & { keyPrefix: string; expired: boolean }> = [];
    for (const record of this.keys.values()) {
      const { key, ...rest } = record;
      result.push({
        ...rest,
        keyPrefix: key.slice(0, 10) + '...',
        expired: this.isExpired(key),
      });
    }
    return result;
  }

  /**
   * Get count of active keys.
   */
  get activeKeyCount(): number {
    let count = 0;
    for (const record of this.keys.values()) {
      if (record.active) count++;
    }
    return count;
  }

  /**
   * Import a key directly (for config file loading).
   */
  importKey(key: string, name: string, credits: number, options?: {
    allowedTools?: string[];
    deniedTools?: string[];
    expiresAt?: string | null;
    quota?: QuotaConfig;
  }): ApiKeyRecord {
    const today = new Date().toISOString().slice(0, 10);
    const month = new Date().toISOString().slice(0, 7);
    const record: ApiKeyRecord = {
      key,
      name: this.sanitizeName(name),
      credits: this.sanitizeCredits(credits),
      totalSpent: 0,
      totalCalls: 0,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      active: true,
      spendingLimit: 0,
      allowedTools: this.sanitizeToolList(options?.allowedTools),
      deniedTools: this.sanitizeToolList(options?.deniedTools),
      expiresAt: options?.expiresAt || null,
      quota: options?.quota,
      quotaDailyCalls: 0,
      quotaMonthlyCalls: 0,
      quotaDailyCredits: 0,
      quotaMonthlyCredits: 0,
      quotaLastResetDay: today,
      quotaLastResetMonth: month,
    };
    this.keys.set(key, record);
    this.save();
    return record;
  }

  // ─── Persistence ──────────────────────────────────────────────────────────────

  /**
   * Save state to disk (atomic: write tmp, then rename).
   * No-op if statePath is not set.
   */
  save(): void {
    if (!this.statePath) return;

    const data = Array.from(this.keys.entries());
    const json = JSON.stringify(data, null, 2);
    const tmpPath = this.statePath + '.tmp';

    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(tmpPath, json, 'utf-8');
      renameSync(tmpPath, this.statePath);
    } catch (err) {
      // Log but don't crash — persistence is best-effort
      console.error(`[paygate] Failed to save state: ${(err as Error).message}`);
    }
  }

  /**
   * Load state from disk. No-op if file doesn't exist.
   */
  private load(): void {
    if (!this.statePath || !existsSync(this.statePath)) return;

    try {
      const json = readFileSync(this.statePath, 'utf-8');
      const data: Array<[string, ApiKeyRecord]> = JSON.parse(json);

      if (!Array.isArray(data)) {
        console.error('[paygate] Invalid state file format, starting fresh.');
        return;
      }

      for (const [key, record] of data) {
        if (key && record && typeof record.key === 'string') {
          // Backfill fields for old state files
          if (record.spendingLimit === undefined) record.spendingLimit = 0;
          if (!Array.isArray(record.allowedTools)) record.allowedTools = [];
          if (!Array.isArray(record.deniedTools)) record.deniedTools = [];
          if (record.expiresAt === undefined) record.expiresAt = null;
          // Backfill quota fields
          if (record.quotaDailyCalls === undefined) record.quotaDailyCalls = 0;
          if (record.quotaMonthlyCalls === undefined) record.quotaMonthlyCalls = 0;
          if (record.quotaDailyCredits === undefined) record.quotaDailyCredits = 0;
          if (record.quotaMonthlyCredits === undefined) record.quotaMonthlyCredits = 0;
          if (!record.quotaLastResetDay) record.quotaLastResetDay = new Date().toISOString().slice(0, 10);
          if (!record.quotaLastResetMonth) record.quotaLastResetMonth = new Date().toISOString().slice(0, 7);
          this.keys.set(key, record);
        }
      }

      console.log(`[paygate] Loaded ${this.keys.size} key(s) from ${this.statePath}`);
    } catch (err) {
      console.error(`[paygate] Failed to load state: ${(err as Error).message}`);
    }
  }
}
