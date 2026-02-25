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
import { ApiKeyRecord } from './types';

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
   * Create a new API key with initial credits.
   */
  createKey(name: string, initialCredits: number): ApiKeyRecord {
    const key = `pg_${randomBytes(24).toString('hex')}`;
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
    };
    this.keys.set(key, record);
    this.save();
    return record;
  }

  /**
   * Look up an API key. Returns null if not found or inactive.
   */
  getKey(key: string): ApiKeyRecord | null {
    const record = this.keys.get(key);
    if (!record || !record.active) return null;
    return record;
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
   * List all keys (with key values masked).
   */
  listKeys(): Array<Omit<ApiKeyRecord, 'key'> & { keyPrefix: string }> {
    const result: Array<Omit<ApiKeyRecord, 'key'> & { keyPrefix: string }> = [];
    for (const record of this.keys.values()) {
      const { key, ...rest } = record;
      result.push({ ...rest, keyPrefix: key.slice(0, 10) + '...' });
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
  importKey(key: string, name: string, credits: number): ApiKeyRecord {
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
          // Backfill spendingLimit for old state files
          if (record.spendingLimit === undefined) record.spendingLimit = 0;
          this.keys.set(key, record);
        }
      }

      console.log(`[paygate] Loaded ${this.keys.size} key(s) from ${this.statePath}`);
    } catch (err) {
      console.error(`[paygate] Failed to load state: ${(err as Error).message}`);
    }
  }
}
