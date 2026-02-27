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
import { Logger } from './logger';

export class KeyStore {
  private keys = new Map<string, ApiKeyRecord>();
  /** Reverse index: alias → key */
  private aliases = new Map<string, string>();
  private readonly statePath: string | null;
  /** Structured logger (set by PayGateServer after construction) */
  logger: Logger = new Logger({ component: 'paygate' });

  constructor(statePath?: string) {
    this.statePath = statePath || null;
    if (this.statePath) {
      this.load();
    }
  }

  /** Number of keys in the store (including revoked/expired). */
  getKeyCount(): number {
    return this.keys.size;
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
   * Clone an existing key with the same configuration but a new key string and fresh counters.
   * Copies: allowedTools, deniedTools, expiresAt, quota, tags, ipAllowlist, namespace, group,
   * spendingLimit, autoTopup. Does NOT copy: suspended state, usage counters, lastUsedAt.
   * Returns null if source key not found or revoked.
   */
  cloneKey(sourceKey: string, overrides?: {
    name?: string;
    credits?: number;
    tags?: Record<string, string>;
    namespace?: string;
  }): ApiKeyRecord | null {
    const source = this.keys.get(sourceKey);
    if (!source || !source.active) return null;

    const key = `pg_${randomBytes(24).toString('hex')}`;
    const today = new Date().toISOString().slice(0, 10);
    const month = new Date().toISOString().slice(0, 7);

    const record: ApiKeyRecord = {
      key,
      name: this.sanitizeName(overrides?.name || `${source.name}-clone`),
      credits: this.sanitizeCredits(overrides?.credits ?? source.credits),
      totalSpent: 0,
      totalCalls: 0,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      active: true,
      spendingLimit: source.spendingLimit,
      allowedTools: [...source.allowedTools],
      deniedTools: [...source.deniedTools],
      expiresAt: source.expiresAt,
      quota: source.quota ? { ...source.quota } : undefined,
      tags: overrides?.tags ? this.sanitizeTags(overrides.tags) : { ...source.tags },
      ipAllowlist: [...source.ipAllowlist],
      namespace: this.sanitizeNamespace(overrides?.namespace ?? source.namespace),
      group: source.group,
      autoTopup: source.autoTopup ? { ...source.autoTopup } : undefined,
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
   * Resolve a key or alias to an active key record (with expiry check).
   * Tries direct key lookup first, then alias lookup.
   * Use this in admin endpoints where aliases should be accepted.
   */
  resolveKey(keyOrAlias: string): ApiKeyRecord | null {
    // Try direct key lookup first
    const direct = this.getKey(keyOrAlias);
    if (direct) return direct;
    // Try alias lookup
    const resolvedKey = this.aliases.get(keyOrAlias);
    if (resolvedKey) return this.getKey(resolvedKey);
    return null;
  }

  /**
   * Resolve a key or alias to a raw key record (no expiry check).
   * Use this in admin endpoints where aliases should be accepted.
   */
  resolveKeyRaw(keyOrAlias: string): ApiKeyRecord | null {
    // Try direct key lookup first
    const direct = this.getKeyRaw(keyOrAlias);
    if (direct) return direct;
    // Try alias lookup
    const resolvedKey = this.aliases.get(keyOrAlias);
    if (resolvedKey) return this.getKeyRaw(resolvedKey);
    return null;
  }

  /**
   * Set or clear an alias for a key. Returns true on success.
   * Alias must be unique across all keys.
   */
  setAlias(key: string, alias: string | null): { success: boolean; error?: string } {
    const record = this.getKeyRaw(key);
    if (!record) return { success: false, error: 'Key not found' };

    // Clear existing alias
    if (record.alias) {
      this.aliases.delete(record.alias);
    }

    if (alias === null || alias === '') {
      // Remove alias
      record.alias = undefined;
      this.save();
      return { success: true };
    }

    // Validate alias format: alphanumeric, hyphens, underscores, 1-100 chars
    const sanitized = alias.trim().slice(0, 100);
    if (!/^[a-zA-Z0-9_-]+$/.test(sanitized)) {
      return { success: false, error: 'Alias must contain only letters, numbers, hyphens, and underscores' };
    }

    // Check uniqueness (not collide with another alias or key)
    if (this.aliases.has(sanitized) && this.aliases.get(sanitized) !== key) {
      return { success: false, error: 'Alias already in use by another key' };
    }
    // Also reject aliases that look like existing key IDs
    if (this.keys.has(sanitized)) {
      return { success: false, error: 'Alias conflicts with an existing key ID' };
    }

    record.alias = sanitized;
    this.aliases.set(sanitized, key);
    this.save();
    return { success: true };
  }

  /**
   * Rebuild alias index from keys map (used after load/import).
   */
  private rebuildAliasIndex(): void {
    this.aliases.clear();
    for (const [key, record] of this.keys) {
      if (record.alias) {
        this.aliases.set(record.alias, key);
      }
    }
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
   * Suspend an API key (temporarily disable). Unlike revocation, suspension is reversible.
   * Returns false if key not found or already revoked (inactive).
   */
  suspendKey(key: string): boolean {
    const record = this.keys.get(key);
    if (!record || !record.active) return false;
    record.suspended = true;
    this.save();
    return true;
  }

  /**
   * Resume a suspended API key. Returns false if key not found, not active, or not suspended.
   */
  resumeKey(key: string): boolean {
    const record = this.keys.get(key);
    if (!record || !record.active) return false;
    if (!record.suspended) return false;
    record.suspended = false;
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
   * List keys with pagination, filtering, and sorting.
   */
  listKeysFiltered(query: import('./types').KeyListQuery): import('./types').KeyListResult {
    type MaskedKey = Omit<import('./types').ApiKeyRecord, 'key'> & { keyPrefix: string; expired: boolean };

    // ─── Filtering ───
    const filtered: MaskedKey[] = [];
    for (const record of this.keys.values()) {
      // Namespace filter
      if (query.namespace && record.namespace !== query.namespace) continue;
      // Group filter
      if (query.group !== undefined) {
        if (query.group === '' && record.group) continue;       // ungrouped only
        if (query.group !== '' && record.group !== query.group) continue;
      }
      // Active filter
      if (query.active === 'true' && !record.active) continue;
      if (query.active === 'false' && record.active) continue;
      // Suspended filter
      if (query.suspended === 'true' && !record.suspended) continue;
      if (query.suspended === 'false' && record.suspended) continue;
      // Expired filter
      const expired = this.isExpired(record.key);
      if (query.expired === 'true' && !expired) continue;
      if (query.expired === 'false' && expired) continue;
      // Name prefix filter (case-insensitive)
      if (query.namePrefix && !record.name.toLowerCase().startsWith(query.namePrefix.toLowerCase())) continue;
      // Credit range filters
      if (query.minCredits !== undefined && record.credits < query.minCredits) continue;
      if (query.maxCredits !== undefined && record.credits > query.maxCredits) continue;

      const { key, ...rest } = record;
      filtered.push({ ...rest, keyPrefix: key.slice(0, 10) + '...', expired });
    }

    // ─── Sorting ───
    const sortBy = query.sortBy || 'createdAt';
    const order = query.order || 'desc';
    const mul = order === 'asc' ? 1 : -1;

    filtered.sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'credits':
          cmp = a.credits - b.credits;
          break;
        case 'totalSpent':
          cmp = a.totalSpent - b.totalSpent;
          break;
        case 'totalCalls':
          cmp = a.totalCalls - b.totalCalls;
          break;
        case 'lastUsedAt':
          cmp = (a.lastUsedAt || '').localeCompare(b.lastUsedAt || '');
          break;
        case 'createdAt':
        default:
          cmp = a.createdAt.localeCompare(b.createdAt);
          break;
      }
      return cmp * mul;
    });

    // ─── Pagination ───
    const total = filtered.length;
    const rawLimit = query.limit != null && !isNaN(query.limit) ? query.limit : 50;
    const limit = Math.min(Math.max(1, rawLimit), 500);
    const offset = Math.max(0, query.offset || 0);
    const page = filtered.slice(offset, offset + limit);

    return {
      keys: page,
      total,
      offset,
      limit,
      hasMore: offset + limit < total,
    };
  }

  /**
   * Export all API keys as full records (including secret key values).
   * Used for backup/migration. Optionally filter by namespace or active status.
   */
  exportKeys(options?: { namespace?: string; activeOnly?: boolean }): ApiKeyRecord[] {
    const result: ApiKeyRecord[] = [];
    for (const record of this.keys.values()) {
      if (options?.namespace && record.namespace !== options.namespace) continue;
      if (options?.activeOnly && !record.active) continue;
      result.push({ ...record });
    }
    return result;
  }

  /**
   * Import API keys from exported records.
   * Returns per-key results with conflict handling.
   * mode: 'skip' (default) = skip existing keys, 'overwrite' = replace existing keys, 'error' = fail on conflicts
   */
  importKeys(records: ApiKeyRecord[], mode: 'skip' | 'overwrite' | 'error' = 'skip'): Array<{ key: string; name: string; status: 'imported' | 'skipped' | 'overwritten' | 'error'; error?: string }> {
    const results: Array<{ key: string; name: string; status: 'imported' | 'skipped' | 'overwritten' | 'error'; error?: string }> = [];
    for (const record of records) {
      // Validate key format
      if (!record.key || typeof record.key !== 'string' || !record.key.startsWith('pg_')) {
        results.push({ key: record.key || '(missing)', name: record.name || '(unknown)', status: 'error', error: 'Invalid key format — must start with pg_' });
        continue;
      }
      const existing = this.keys.get(record.key);
      if (existing) {
        if (mode === 'skip') {
          results.push({ key: record.key.slice(0, 10) + '...', name: record.name, status: 'skipped' });
          continue;
        }
        if (mode === 'error') {
          results.push({ key: record.key.slice(0, 10) + '...', name: record.name, status: 'error', error: 'Key already exists' });
          continue;
        }
        // mode === 'overwrite': fall through to set
      }
      // Sanitize and set the record
      const sanitized: ApiKeyRecord = {
        key: record.key,
        name: String(record.name || 'imported').slice(0, 200),
        credits: Math.max(0, Math.floor(Number(record.credits) || 0)),
        totalSpent: Math.max(0, Number(record.totalSpent) || 0),
        totalCalls: Math.max(0, Math.floor(Number(record.totalCalls) || 0)),
        createdAt: record.createdAt || new Date().toISOString(),
        lastUsedAt: record.lastUsedAt || null,
        active: record.active !== false,
        spendingLimit: Math.max(0, Number(record.spendingLimit) || 0),
        allowedTools: Array.isArray(record.allowedTools) ? record.allowedTools.filter(t => typeof t === 'string') : [],
        deniedTools: Array.isArray(record.deniedTools) ? record.deniedTools.filter(t => typeof t === 'string') : [],
        expiresAt: record.expiresAt || null,
        quota: record.quota,
        tags: typeof record.tags === 'object' && record.tags !== null ? record.tags : {},
        ipAllowlist: Array.isArray(record.ipAllowlist) ? record.ipAllowlist.filter(t => typeof t === 'string') : [],
        namespace: String(record.namespace || 'default'),
        group: record.group,
        suspended: record.suspended || false,
        alias: record.alias,
        autoTopup: record.autoTopup,
        autoTopupTodayCount: Number(record.autoTopupTodayCount) || 0,
        autoTopupLastResetDay: record.autoTopupLastResetDay || new Date().toISOString().slice(0, 10),
        quotaDailyCalls: Number(record.quotaDailyCalls) || 0,
        quotaMonthlyCalls: Number(record.quotaMonthlyCalls) || 0,
        quotaDailyCredits: Number(record.quotaDailyCredits) || 0,
        quotaMonthlyCredits: Number(record.quotaMonthlyCredits) || 0,
        quotaLastResetDay: record.quotaLastResetDay || new Date().toISOString().slice(0, 10),
        quotaLastResetMonth: record.quotaLastResetMonth || new Date().toISOString().slice(0, 7),
      };
      this.keys.set(sanitized.key, sanitized);
      const status = existing ? 'overwritten' : 'imported';
      results.push({ key: sanitized.key.slice(0, 10) + '...', name: sanitized.name, status });
    }
    this.rebuildAliasIndex();
    this.save();
    return results;
  }

  /**
   * Get all key records (for background scanning).
   * Returns raw records without filtering by active/expiry status.
   */
  getAllRecords(): ApiKeyRecord[] {
    return Array.from(this.keys.values());
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
      this.logger.error(`Failed to save state: ${(err as Error).message}`);
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
        this.logger.error('Invalid state file format, starting fresh.');
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
          // Backfill v4.4.0 suspended field (undefined = not suspended)
          // No explicit backfill needed — undefined treated as false
          this.keys.set(key, record);
        }
      }

      // Rebuild alias index from loaded keys
      this.rebuildAliasIndex();

      this.logger.info(`Loaded ${this.keys.size} key(s) from ${this.statePath}`);
    } catch (err) {
      this.logger.error(`Failed to load state: ${(err as Error).message}`);
    }
  }
}
