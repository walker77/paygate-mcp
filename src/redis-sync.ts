/**
 * RedisSync — Write-through cache adapter for distributed PayGate deployments.
 *
 * Keeps the existing in-memory KeyStore as the fast sync read path, while
 * propagating all writes to Redis for cross-process shared state. On startup,
 * loads existing state from Redis. Periodically refreshes local state from Redis
 * to pick up changes made by other PayGate processes.
 *
 * Architecture:
 *   Gate.evaluate() → reads from local KeyStore (sync, fast)
 *   KeyStore.save() → writes to memory + triggers Redis write (async, fire-and-forget)
 *   RedisPersistence.refresh() → pulls latest state from Redis → updates local KeyStore
 *
 * For credit deduction, uses a Redis Lua script to ensure atomicity across
 * multiple PayGate instances (prevents double-spend race conditions).
 */

import { RedisClient } from './redis-client';
import { KeyStore } from './store';
import { ApiKeyRecord, QuotaConfig, UsageEvent } from './types';

const KEY_PREFIX = 'pg:key:';
const KEY_SET = 'pg:keys';
const META_KEY = 'pg:meta';
const USAGE_LIST = 'pg:usage';
const RATE_PREFIX = 'pg:rate:';

/** Lua: atomic credit deduction — check + deduct + increment in one round trip */
const DEDUCT_LUA = `
local key = KEYS[1]
local amount = tonumber(ARGV[1])
local now = ARGV[2]

local credits = tonumber(redis.call('HGET', key, 'credits') or '0')
local active = redis.call('HGET', key, 'active')
if active == '0' then return -1 end
if credits < amount then return 0 end

redis.call('HINCRBY', key, 'credits', -amount)
redis.call('HINCRBY', key, 'totalSpent', amount)
redis.call('HINCRBY', key, 'totalCalls', 1)
redis.call('HSET', key, 'lastUsedAt', now)
return 1
`;

/** Lua: atomic credit addition (top-up) */
const TOPUP_LUA = `
local key = KEYS[1]
local amount = tonumber(ARGV[1])
local active = redis.call('HGET', key, 'active')
if active == '0' then return 0 end
redis.call('HINCRBY', key, 'credits', amount)
return 1
`;

/** Lua: atomic rate limit check + record (sliding window via sorted set) */
const RATE_CHECK_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local maxCalls = tonumber(ARGV[3])
local cutoff = now - window

-- Remove expired entries
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)

-- Count current entries
local count = redis.call('ZCARD', key)
if count >= maxCalls then
  -- Rate limited: return [0, count, oldest_timestamp]
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local oldestTs = oldest[2] or now
  return {0, count, oldestTs}
end

-- Allowed: add this call and set expiry
redis.call('ZADD', key, now, now .. ':' .. math.random(100000))
redis.call('PEXPIRE', key, window)
return {1, count + 1, 0}
`;

export class RedisSync {
  private readonly redis: RedisClient;
  private readonly store: KeyStore;
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private readonly syncMs: number;

  constructor(redis: RedisClient, store: KeyStore, syncIntervalMs = 5000) {
    this.redis = redis;
    this.store = store;
    this.syncMs = syncIntervalMs;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Initialize: connect to Redis and load existing state into local KeyStore.
   */
  async init(): Promise<void> {
    await this.redis.connect();
    await this.redis.ping();
    console.log('[paygate:redis] Connected to Redis');

    await this.loadFromRedis();

    // Start periodic refresh
    this.syncInterval = setInterval(() => {
      this.loadFromRedis().catch(err => {
        console.error('[paygate:redis] Sync error:', err.message);
      });
    }, this.syncMs);
  }

  async destroy(): Promise<void> {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    await this.redis.disconnect();
  }

  // ─── Write-through operations ──────────────────────────────────────────────

  /**
   * Save a single key record to Redis. Called after local KeyStore mutations.
   * Fire-and-forget (errors logged, not thrown).
   */
  async saveKey(record: ApiKeyRecord): Promise<void> {
    try {
      const redisKey = KEY_PREFIX + record.key;
      await this.redis.hset(redisKey, ...this.recordToHash(record));
      await this.redis.command('SADD', KEY_SET, record.key);
    } catch (err) {
      console.error(`[paygate:redis] Save key error: ${(err as Error).message}`);
    }
  }

  /**
   * Save ALL keys to Redis. Called when local KeyStore.save() fires.
   */
  async saveAll(): Promise<void> {
    try {
      const keys = this.store.listKeys();
      // Use the internal key map via a dedicated export method
      const data = (this.store as any).keys as Map<string, ApiKeyRecord>;
      if (!data) return;

      for (const [key, record] of data) {
        const redisKey = KEY_PREFIX + key;
        await this.redis.hset(redisKey, ...this.recordToHash(record));
        await this.redis.command('SADD', KEY_SET, key);
      }
    } catch (err) {
      console.error(`[paygate:redis] SaveAll error: ${(err as Error).message}`);
    }
  }

  /**
   * Atomic credit deduction via Redis Lua. Returns true if deduction succeeded.
   * Call this INSTEAD of store.deductCredits() in Redis mode.
   */
  async atomicDeduct(apiKey: string, amount: number): Promise<boolean> {
    try {
      const result = await this.redis.evalLua(
        DEDUCT_LUA,
        1,
        KEY_PREFIX + apiKey,
        String(amount),
        new Date().toISOString()
      );
      if (result === 1) {
        // Update local cache to reflect the deduction
        const record = (this.store as any).keys.get(apiKey) as ApiKeyRecord | undefined;
        if (record) {
          record.credits -= amount;
          record.totalSpent += amount;
          record.totalCalls++;
          record.lastUsedAt = new Date().toISOString();
        }
        return true;
      }
      return false;
    } catch (err) {
      console.error(`[paygate:redis] Atomic deduct error: ${(err as Error).message}`);
      // Fallback to local deduction if Redis is temporarily unavailable
      return this.store.deductCredits(apiKey, amount);
    }
  }

  /**
   * Atomic credit top-up via Redis.
   */
  async atomicTopup(apiKey: string, amount: number): Promise<boolean> {
    try {
      const result = await this.redis.evalLua(
        TOPUP_LUA,
        1,
        KEY_PREFIX + apiKey,
        String(amount)
      );
      if (result === 1) {
        // Update local cache
        const record = (this.store as any).keys.get(apiKey) as ApiKeyRecord | undefined;
        if (record) {
          record.credits += amount;
        }
        return true;
      }
      return false;
    } catch (err) {
      console.error(`[paygate:redis] Atomic topup error: ${(err as Error).message}`);
      return this.store.addCredits(apiKey, amount);
    }
  }

  /**
   * Revoke a key in both local store and Redis.
   */
  async revokeKey(apiKey: string): Promise<boolean> {
    const localResult = this.store.revokeKey(apiKey);
    try {
      await this.redis.hset(KEY_PREFIX + apiKey, 'active', '0');
    } catch (err) {
      console.error(`[paygate:redis] Revoke error: ${(err as Error).message}`);
    }
    return localResult;
  }

  // ─── Usage Meter sync ──────────────────────────────────────────────────────

  /**
   * Record a usage event to Redis (append to list). Fire-and-forget.
   * Events are stored as JSON strings in a Redis list with max 100k entries.
   */
  async recordUsage(event: UsageEvent): Promise<void> {
    try {
      await this.redis.command('RPUSH', USAGE_LIST, JSON.stringify(event));
      // Trim to max 100k events (same as local UsageMeter)
      await this.redis.command('LTRIM', USAGE_LIST, '-100000', '-1');
    } catch (err) {
      console.error(`[paygate:redis] Usage record error: ${(err as Error).message}`);
    }
  }

  /**
   * Get usage events from Redis. Returns events after `since` timestamp if provided.
   */
  async getUsageEvents(since?: string): Promise<UsageEvent[]> {
    try {
      const raw = await this.redis.command('LRANGE', USAGE_LIST, '0', '-1') as string[];
      if (!raw || !Array.isArray(raw)) return [];
      const events: UsageEvent[] = raw.map(s => JSON.parse(s));
      if (since) return events.filter(e => e.timestamp >= since);
      return events;
    } catch (err) {
      console.error(`[paygate:redis] Usage get error: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Get the count of usage events in Redis.
   */
  async getUsageCount(): Promise<number> {
    try {
      const len = await this.redis.command('LLEN', USAGE_LIST) as number;
      return len || 0;
    } catch (err) {
      return 0;
    }
  }

  // ─── Rate Limiter sync ────────────────────────────────────────────────────

  /**
   * Atomic rate limit check + record via Redis. Returns a result compatible with
   * the local RateLimiter interface. Uses a sorted set per rate-limit key with
   * timestamps as scores for O(log N) sliding window.
   *
   * @param key Composite key (e.g. "pg_abc" or "pg_abc:tool:search")
   * @param maxCalls Maximum calls per window
   * @param windowMs Window size in milliseconds (default: 60000)
   */
  async checkRateLimit(key: string, maxCalls: number, windowMs = 60_000): Promise<{
    allowed: boolean;
    remaining: number;
    resetInMs: number;
  }> {
    if (maxCalls <= 0) {
      return { allowed: true, remaining: Infinity, resetInMs: 0 };
    }

    try {
      const now = Date.now();
      const result = await this.redis.evalLua(
        RATE_CHECK_LUA,
        1,
        RATE_PREFIX + key,
        String(now),
        String(windowMs),
        String(maxCalls)
      ) as number[];

      if (!result || !Array.isArray(result)) {
        // Fallback: allow on Redis error
        return { allowed: true, remaining: maxCalls - 1, resetInMs: windowMs };
      }

      const [allowed, count, oldestTs] = result;
      if (allowed === 1) {
        return {
          allowed: true,
          remaining: maxCalls - count,
          resetInMs: windowMs,
        };
      }

      // Rate limited
      const resetInMs = oldestTs ? (Number(oldestTs) + windowMs - now) : windowMs;
      return {
        allowed: false,
        remaining: 0,
        resetInMs: Math.max(0, resetInMs),
      };
    } catch (err) {
      console.error(`[paygate:redis] Rate check error: ${(err as Error).message}`);
      // Fallback: allow on Redis error (fail-open for rate limiting)
      return { allowed: true, remaining: maxCalls - 1, resetInMs: windowMs };
    }
  }

  // ─── Load from Redis ───────────────────────────────────────────────────────

  /**
   * Load all keys from Redis into the local in-memory KeyStore.
   * Merges with any locally-created keys (doesn't overwrite local-only keys).
   */
  private async loadFromRedis(): Promise<void> {
    try {
      const allKeyIds = await this.redis.command('SMEMBERS', KEY_SET) as string[];
      if (!allKeyIds || allKeyIds.length === 0) {
        // No keys in Redis — push local state up if we have any
        await this.pushLocalToRedis();
        return;
      }

      let loaded = 0;
      for (const keyId of allKeyIds) {
        const hash = await this.redis.hgetall(KEY_PREFIX + keyId);
        if (!hash || !hash.key) continue;

        const record = this.hashToRecord(hash);
        if (!record) continue;

        // Write directly into the local store's map
        const localKeys = (this.store as any).keys as Map<string, ApiKeyRecord>;
        localKeys.set(record.key, record);
        loaded++;
      }

      if (loaded > 0) {
        console.log(`[paygate:redis] Synced ${loaded} key(s) from Redis`);
      }
    } catch (err) {
      console.error(`[paygate:redis] Load error: ${(err as Error).message}`);
    }
  }

  /**
   * Push local KeyStore state to Redis (used when Redis is empty on first connect).
   */
  private async pushLocalToRedis(): Promise<void> {
    const localKeys = (this.store as any).keys as Map<string, ApiKeyRecord>;
    if (localKeys.size === 0) return;

    for (const [key, record] of localKeys) {
      const redisKey = KEY_PREFIX + key;
      await this.redis.hset(redisKey, ...this.recordToHash(record));
      await this.redis.command('SADD', KEY_SET, key);
    }
    console.log(`[paygate:redis] Pushed ${localKeys.size} local key(s) to Redis`);
  }

  // ─── Serialization ─────────────────────────────────────────────────────────

  private recordToHash(record: ApiKeyRecord): string[] {
    const fields: string[] = [];
    fields.push('key', record.key);
    fields.push('name', record.name);
    fields.push('credits', String(record.credits));
    fields.push('totalSpent', String(record.totalSpent));
    fields.push('totalCalls', String(record.totalCalls));
    fields.push('createdAt', record.createdAt);
    fields.push('lastUsedAt', record.lastUsedAt || '');
    fields.push('active', record.active ? '1' : '0');
    fields.push('spendingLimit', String(record.spendingLimit));
    fields.push('allowedTools', JSON.stringify(record.allowedTools));
    fields.push('deniedTools', JSON.stringify(record.deniedTools));
    fields.push('expiresAt', record.expiresAt || '');
    fields.push('quota', record.quota ? JSON.stringify(record.quota) : '');
    fields.push('tags', JSON.stringify(record.tags));
    fields.push('ipAllowlist', JSON.stringify(record.ipAllowlist));
    fields.push('quotaDailyCalls', String(record.quotaDailyCalls));
    fields.push('quotaMonthlyCalls', String(record.quotaMonthlyCalls));
    fields.push('quotaDailyCredits', String(record.quotaDailyCredits));
    fields.push('quotaMonthlyCredits', String(record.quotaMonthlyCredits));
    fields.push('quotaLastResetDay', record.quotaLastResetDay);
    fields.push('quotaLastResetMonth', record.quotaLastResetMonth);
    return fields;
  }

  private hashToRecord(hash: Record<string, string>): ApiKeyRecord | null {
    if (!hash.key) return null;
    return {
      key: hash.key,
      name: hash.name || '',
      credits: parseInt(hash.credits, 10) || 0,
      totalSpent: parseInt(hash.totalSpent, 10) || 0,
      totalCalls: parseInt(hash.totalCalls, 10) || 0,
      createdAt: hash.createdAt || new Date().toISOString(),
      lastUsedAt: hash.lastUsedAt || null,
      active: hash.active !== '0',
      spendingLimit: parseInt(hash.spendingLimit, 10) || 0,
      allowedTools: hash.allowedTools ? JSON.parse(hash.allowedTools) : [],
      deniedTools: hash.deniedTools ? JSON.parse(hash.deniedTools) : [],
      expiresAt: hash.expiresAt || null,
      quota: hash.quota ? JSON.parse(hash.quota) : undefined,
      tags: hash.tags ? JSON.parse(hash.tags) : {},
      ipAllowlist: hash.ipAllowlist ? JSON.parse(hash.ipAllowlist) : [],
      quotaDailyCalls: parseInt(hash.quotaDailyCalls, 10) || 0,
      quotaMonthlyCalls: parseInt(hash.quotaMonthlyCalls, 10) || 0,
      quotaDailyCredits: parseInt(hash.quotaDailyCredits, 10) || 0,
      quotaMonthlyCredits: parseInt(hash.quotaMonthlyCredits, 10) || 0,
      quotaLastResetDay: hash.quotaLastResetDay || new Date().toISOString().slice(0, 10),
      quotaLastResetMonth: hash.quotaLastResetMonth || new Date().toISOString().slice(0, 7),
    };
  }
}
