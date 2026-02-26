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
   * Sanitize tags: max 50 entries, keys and values trimmed, max 100 chars each.
   */
  private sanitizeTags(tags?: Record<string, string>): Record<string, string> {
    if (!tags || typeof tags !== 'object') return {};
    const result: Record<string, string> = {};
    const entries = Object.entries(tags).slice(0, 50);
    for (const [k, v] of entries) {
      const key = String(k).trim().slice(0, 100);
      const val = String(v).trim().slice(0, 100);
      if (key) result[key] = val;
    }
    return result;
  }

  /**
   * Sanitize namespace: max 50 chars, lowercase, alphanumeric + hyphens.
   * Defaults to 'default'.
   */
  private sanitizeNamespace(ns?: string): string {
    if (!ns || typeof ns !== 'string') return 'default';
    const sanitized = ns.trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 50);
    return sanitized || 'default';
  }

  /**
   * Sanitize IP allowlist: max 100 entries, trimmed, basic format validation.
   */
  private sanitizeIpList(ips?: string[]): string[] {
    if (!ips || !Array.isArray(ips)) return [];
    return ips
      .filter(ip => typeof ip === 'string' && ip.trim().length > 0)
      .map(ip => ip.trim())
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
    tags?: Record<string, string>;
    ipAllowlist?: string[];
    namespace?: string;
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
      tags: this.sanitizeTags(options?.tags),
      ipAllowlist: this.sanitizeIpList(options?.ipAllowlist),
      namespace: this.sanitizeNamespace(options?.namespace),
      quotaDailyCalls: 0,
      quotaMonthlyCalls: 0,
      quotaDailyCredits: 0,
      quotaMonthlyCredits: 0,
      quotaLastResetDay: today,
      quotaLastResetMonth: month,
      autoTopupTodayCount: 0,
      autoTopupLastResetDay: today,
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
   * Set tags on a key. Merges with existing tags; pass null value to remove a tag.
   */
  setTags(key: string, tags: Record<string, string | null>): boolean {
    const record = this.getKey(key);
    if (!record) return false;
    for (const [k, v] of Object.entries(tags)) {
      const sanitizedKey = String(k).trim().slice(0, 100);
      if (!sanitizedKey) continue;
      if (v === null) {
        delete record.tags[sanitizedKey];
      } else {
        if (Object.keys(record.tags).length >= 50 && !(sanitizedKey in record.tags)) continue;
        record.tags[sanitizedKey] = String(v).trim().slice(0, 100);
      }
    }
    this.save();
    return true;
  }

  /**
   * Set IP allowlist for a key. Empty array = all IPs allowed.
   */
  setIpAllowlist(key: string, ips: string[]): boolean {
    const record = this.getKey(key);
    if (!record) return false;
    record.ipAllowlist = this.sanitizeIpList(ips);
    this.save();
    return true;
  }

  /**
   * Check if an IP is allowed for a key. Returns true if allowlist is empty or IP is in list.
   * Supports CIDR notation for IPv4 (e.g., "10.0.0.0/8").
   */
  checkIp(key: string, ip: string): boolean {
    const record = this.getKey(key);
    if (!record) return false;
    if (record.ipAllowlist.length === 0) return true;

    const clientIp = ip.trim();
    for (const allowed of record.ipAllowlist) {
      if (allowed.includes('/')) {
        // CIDR match
        if (this.matchCidr(clientIp, allowed)) return true;
      } else if (allowed === clientIp) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if an IP is in an arbitrary allowlist (CIDR + exact match).
   * Public method for use by group policy resolution.
   */
  checkIpInList(ip: string, allowlist: string[]): boolean {
    const clientIp = ip.trim();
    for (const allowed of allowlist) {
      if (allowed.includes('/')) {
        if (this.matchCidr(clientIp, allowed)) return true;
      } else if (allowed === clientIp) {
        return true;
      }
    }
    return false;
  }

  /**
   * Match an IPv4 address against a CIDR range (e.g., "192.168.1.0/24").
   */
  private matchCidr(ip: string, cidr: string): boolean {
    const [range, bitsStr] = cidr.split('/');
    const bits = parseInt(bitsStr, 10);
    if (isNaN(bits) || bits < 0 || bits > 32) return false;

    const ipNum = this.ipToNumber(ip);
    const rangeNum = this.ipToNumber(range);
    if (ipNum === null || rangeNum === null) return false;

    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipNum & mask) === (rangeNum & mask);
  }

  private ipToNumber(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let num = 0;
    for (const part of parts) {
      const n = parseInt(part, 10);
      if (isNaN(n) || n < 0 || n > 255) return null;
      num = (num << 8) + n;
    }
    return num >>> 0;
  }

  /**
   * List keys filtered by tag. Returns keys where ALL specified tag key-value pairs match.
   */
  listKeysByTag(tags: Record<string, string>, namespace?: string): Array<Omit<ApiKeyRecord, 'key'> & { keyPrefix: string; expired: boolean }> {
    const result: Array<Omit<ApiKeyRecord, 'key'> & { keyPrefix: string; expired: boolean }> = [];
    for (const record of this.keys.values()) {
      // Filter by namespace if specified
      if (namespace && record.namespace !== namespace) continue;

      // Check all tag filters match
      let match = true;
      for (const [k, v] of Object.entries(tags)) {
        if (record.tags[k] !== v) { match = false; break; }
      }
      if (!match) continue;

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
   * Rotate an API key — generate a new key string while preserving all
   * credits, ACL, quotas, spending limits, and metadata. The old key is
   * immediately invalidated.
   */
  rotateKey(oldKey: string): ApiKeyRecord | null {
    const record = this.keys.get(oldKey);
    if (!record || !record.active) return null;

    // Generate new key
    const newKey = `pg_${randomBytes(24).toString('hex')}`;

    // Create new record with all state transferred
    const rotated: ApiKeyRecord = {
      ...record,
      key: newKey,
      // Keep everything: credits, totalSpent, totalCalls, lastUsedAt,
      // allowedTools, deniedTools, expiresAt, spendingLimit, quota, etc.
    };

    // Deactivate old key and insert new one
    record.active = false;
    this.keys.set(oldKey, record);
    this.keys.set(newKey, rotated);
    this.save();

    return rotated;
  }

  /**
   * List all keys (with key values masked). Includes expiry status.
   * Optionally filter by namespace.
   */
  listKeys(namespace?: string): Array<Omit<ApiKeyRecord, 'key'> & { keyPrefix: string; expired: boolean }> {
    const result: Array<Omit<ApiKeyRecord, 'key'> & { keyPrefix: string; expired: boolean }> = [];
    for (const record of this.keys.values()) {
      if (namespace && record.namespace !== namespace) continue;
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
   * List all unique namespaces with summary stats.
   */
  listNamespaces(): Array<{ namespace: string; keyCount: number; activeKeys: number; totalCredits: number; totalSpent: number }> {
    const nsMap = new Map<string, { keyCount: number; activeKeys: number; totalCredits: number; totalSpent: number }>();
    for (const record of this.keys.values()) {
      const ns = record.namespace || 'default';
      let entry = nsMap.get(ns);
      if (!entry) {
        entry = { keyCount: 0, activeKeys: 0, totalCredits: 0, totalSpent: 0 };
        nsMap.set(ns, entry);
      }
      entry.keyCount++;
      if (record.active) entry.activeKeys++;
      entry.totalCredits += record.credits;
      entry.totalSpent += record.totalSpent;
    }
    return Array.from(nsMap.entries()).map(([namespace, stats]) => ({ namespace, ...stats }));
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
    tags?: Record<string, string>;
    ipAllowlist?: string[];
    namespace?: string;
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
      tags: this.sanitizeTags(options?.tags),
      ipAllowlist: this.sanitizeIpList(options?.ipAllowlist),
      namespace: this.sanitizeNamespace(options?.namespace),
      quotaDailyCalls: 0,
      quotaMonthlyCalls: 0,
      quotaDailyCredits: 0,
      quotaMonthlyCredits: 0,
      quotaLastResetDay: today,
      quotaLastResetMonth: month,
      autoTopupTodayCount: 0,
      autoTopupLastResetDay: today,
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
          // Backfill v1.7.0 fields
          if (!record.tags || typeof record.tags !== 'object') record.tags = {};
          if (!Array.isArray(record.ipAllowlist)) record.ipAllowlist = [];
          // Backfill v2.9.0 namespace
          if (!record.namespace) record.namespace = 'default';
          // Backfill v3.2.0 auto-topup tracking
          if (record.autoTopupTodayCount === undefined) record.autoTopupTodayCount = 0;
          if (!record.autoTopupLastResetDay) record.autoTopupLastResetDay = new Date().toISOString().slice(0, 10);
          this.keys.set(key, record);
        }
      }

      console.log(`[paygate] Loaded ${this.keys.size} key(s) from ${this.statePath}`);
    } catch (err) {
      console.error(`[paygate] Failed to load state: ${(err as Error).message}`);
    }
  }
}
