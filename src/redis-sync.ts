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

import { RedisClient, RedisSubscriber, parseRedisUrl } from './redis-client';
import type { RedisClientOptions } from './redis-client';
import { KeyStore } from './store';
import { ApiKeyRecord, QuotaConfig, UsageEvent } from './types';
import { KeyGroupManager, KeyGroupRecord } from './groups';
import { randomBytes } from 'crypto';
import { Logger } from './logger';

const KEY_PREFIX = 'pg:key:';
const KEY_SET = 'pg:keys';
const META_KEY = 'pg:meta';
const USAGE_LIST = 'pg:usage';
const RATE_PREFIX = 'pg:rate:';
const GROUP_PREFIX = 'pg:group:';
const GROUP_SET = 'pg:groups';
const GROUP_ASSIGN_KEY = 'pg:group_assignments';
const PG_CHANNEL = 'pg:events';

// ─── Pub/Sub Event Types ──────────────────────────────────────────────────────

export interface PubSubEvent {
  /** Event type */
  type: 'key_updated' | 'key_revoked' | 'credits_changed' | 'key_created' | 'token_revoked' | 'group_updated' | 'group_deleted' | 'group_assignment_changed';
  /** API key or group ID affected */
  key: string;
  /** Originating instance ID (for self-message filtering) */
  instanceId: string;
  /** Inline data for fast path (avoids Redis roundtrip on receiver) */
  data?: {
    credits?: number;
    totalSpent?: number;
    totalCalls?: number;
    active?: boolean;
    // Token revocation data
    expiresAt?: string;
    revokedAt?: string;
    reason?: string;
  };
}

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
  /** Unique instance ID for self-message filtering in pub/sub */
  readonly instanceId: string;
  /** Dedicated subscriber connection (Redis requires separate connection for SUBSCRIBE) */
  private subscriber: RedisSubscriber | null = null;
  /** Redis connection options (needed to create subscriber on same host) */
  private redisOpts: RedisClientOptions | null = null;
  /** Whether pub/sub is actively listening */
  private pubsubActive = false;
  /** Callback for external consumers of pub/sub events (testing, monitoring) */
  onPubSubEvent?: (event: PubSubEvent) => void;
  /** Callback for token revocation events (wired to ScopedTokenManager by server) */
  onTokenRevoked?: (fingerprint: string, expiresAt: string, revokedAt: string, reason?: string) => void;
  /** Optional KeyGroupManager for group sync (wired by server when groups are used) */
  groupManager?: KeyGroupManager;
  /** Structured logger (set by PayGateServer after construction) */
  logger: Logger = new Logger({ component: 'paygate:redis' });

  constructor(redis: RedisClient, store: KeyStore, syncIntervalMs = 5000) {
    this.redis = redis;
    this.store = store;
    this.syncMs = syncIntervalMs;
    this.instanceId = randomBytes(8).toString('hex');
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Initialize: connect to Redis, load existing state, and start pub/sub listener.
   */
  async init(subscriberOpts?: RedisClientOptions): Promise<void> {
    await this.redis.connect();
    await this.redis.ping();
    this.logger.info('Connected to Redis');

    await this.loadFromRedis();
    await this.loadGroupsFromRedis();

    // Start periodic refresh (fallback for missed pub/sub messages)
    this.syncInterval = setInterval(() => {
      this.loadFromRedis().catch(err => {
        this.logger.error(`Sync error: ${err.message}`);
      });
      this.loadGroupsFromRedis().catch(err => {
        this.logger.error(`Group sync error: ${err.message}`);
      });
    }, this.syncMs);

    // Start pub/sub subscriber if connection options available
    if (subscriberOpts) {
      this.redisOpts = subscriberOpts;
      await this.startPubSub(subscriberOpts);
    }
  }

  async destroy(): Promise<void> {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    // Tear down pub/sub subscriber
    if (this.subscriber) {
      await this.subscriber.disconnect();
      this.subscriber = null;
      this.pubsubActive = false;
    }
    await this.redis.disconnect();
  }

  // ─── Pub/Sub ────────────────────────────────────────────────────────────────

  /**
   * Start a dedicated subscriber connection for real-time cross-instance events.
   * Messages from the same instance (matching instanceId) are ignored.
   */
  private async startPubSub(opts: RedisClientOptions): Promise<void> {
    try {
      this.subscriber = new RedisSubscriber(opts);
      await this.subscriber.connect();
      await this.subscriber.subscribe(PG_CHANNEL, (channel, message) => {
        this.handlePubSubMessage(message);
      });
      this.pubsubActive = true;
      this.logger.info(`Pub/sub active (instance: ${this.instanceId.slice(0, 8)})`);
    } catch (err) {
      this.logger.error(`Pub/sub setup failed: ${(err as Error).message}`);
      // Non-fatal: periodic sync is still running as fallback
    }
  }

  /**
   * Publish an event to all PayGate instances via Redis pub/sub.
   * Fire-and-forget — errors are logged but not thrown.
   */
  async publishEvent(event: Omit<PubSubEvent, 'instanceId'>): Promise<void> {
    try {
      const fullEvent: PubSubEvent = { ...event, instanceId: this.instanceId };
      await this.redis.publish(PG_CHANNEL, JSON.stringify(fullEvent));
    } catch (err) {
      this.logger.error(`Publish error: ${(err as Error).message}`);
    }
  }

  /**
   * Handle an incoming pub/sub message from another instance.
   * Self-messages (same instanceId) are ignored. Other events trigger
   * immediate local KeyStore updates from inline data or a Redis HGETALL.
   */
  private handlePubSubMessage(message: string): void {
    try {
      const event: PubSubEvent = JSON.parse(message);

      // Ignore messages from ourselves
      if (event.instanceId === this.instanceId) return;

      // Notify external consumers (for testing/monitoring)
      this.onPubSubEvent?.(event);

      const localKeys = (this.store as any).keys as Map<string, ApiKeyRecord>;

      switch (event.type) {
        case 'credits_changed': {
          // Fast path: update credits from inline data (no Redis roundtrip)
          const record = localKeys.get(event.key);
          if (record && event.data) {
            if (event.data.credits !== undefined) record.credits = event.data.credits;
            if (event.data.totalSpent !== undefined) record.totalSpent = event.data.totalSpent;
            if (event.data.totalCalls !== undefined) record.totalCalls = event.data.totalCalls;
          }
          break;
        }
        case 'key_revoked': {
          const record = localKeys.get(event.key);
          if (record) {
            record.active = false;
          }
          break;
        }
        case 'key_updated':
        case 'key_created': {
          // Full refresh of this key from Redis (needs latest data)
          this.refreshSingleKey(event.key).catch(() => {});
          break;
        }
        case 'token_revoked': {
          // Propagate token revocation to local ScopedTokenManager
          if (this.onTokenRevoked && event.data) {
            this.onTokenRevoked(
              event.key, // fingerprint
              event.data.expiresAt || '',
              event.data.revokedAt || new Date().toISOString(),
              event.data.reason,
            );
          }
          break;
        }
        case 'group_updated':
        case 'group_deleted':
        case 'group_assignment_changed': {
          // Reload all groups from Redis (groups are small, full reload is fine)
          this.loadGroupsFromRedis().catch(() => {});
          break;
        }
      }
    } catch {
      // Malformed message — silently ignore
    }
  }

  /**
   * Refresh a single key from Redis into the local KeyStore.
   */
  private async refreshSingleKey(apiKey: string): Promise<void> {
    try {
      const hash = await this.redis.hgetall(KEY_PREFIX + apiKey);
      if (!hash || !hash.key) return;
      const record = this.hashToRecord(hash);
      if (!record) return;
      const localKeys = (this.store as any).keys as Map<string, ApiKeyRecord>;
      localKeys.set(record.key, record);
    } catch (err) {
      this.logger.error(`Single key refresh error: ${(err as Error).message}`);
    }
  }

  /** Whether the main Redis client is connected */
  get isConnected(): boolean {
    return this.redis.isConnected;
  }

  /** Whether pub/sub is actively listening */
  get isPubSubActive(): boolean {
    return this.pubsubActive;
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
      // Notify other instances
      await this.publishEvent({ type: 'key_updated', key: record.key });
    } catch (err) {
      this.logger.error(`Save key error: ${(err as Error).message}`);
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
      this.logger.error(`SaveAll error: ${(err as Error).message}`);
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
          // Notify other instances with inline data (no roundtrip needed on receivers)
          this.publishEvent({
            type: 'credits_changed',
            key: apiKey,
            data: {
              credits: record.credits,
              totalSpent: record.totalSpent,
              totalCalls: record.totalCalls,
            },
          }).catch(() => {});
        }
        return true;
      }
      return false;
    } catch (err) {
      this.logger.error(`Atomic deduct error: ${(err as Error).message}`);
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
          // Notify other instances
          this.publishEvent({
            type: 'credits_changed',
            key: apiKey,
            data: { credits: record.credits },
          }).catch(() => {});
        }
        return true;
      }
      return false;
    } catch (err) {
      this.logger.error(`Atomic topup error: ${(err as Error).message}`);
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
      // Notify other instances
      await this.publishEvent({ type: 'key_revoked', key: apiKey });
    } catch (err) {
      this.logger.error(`Revoke error: ${(err as Error).message}`);
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
      this.logger.error(`Usage record error: ${(err as Error).message}`);
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
      this.logger.error(`Usage get error: ${(err as Error).message}`);
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
      this.logger.error(`Rate check error: ${(err as Error).message}`);
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
        this.logger.info(`Synced ${loaded} key(s) from Redis`);
      }
    } catch (err) {
      this.logger.error(`Load error: ${(err as Error).message}`);
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
    this.logger.info(`Pushed ${localKeys.size} local key(s) to Redis`);
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
    fields.push('namespace', record.namespace || 'default');
    fields.push('autoTopup', record.autoTopup ? JSON.stringify(record.autoTopup) : '');
    fields.push('autoTopupTodayCount', String(record.autoTopupTodayCount));
    fields.push('autoTopupLastResetDay', record.autoTopupLastResetDay);
    fields.push('group', record.group || '');
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
      namespace: hash.namespace || 'default',
      autoTopup: hash.autoTopup ? JSON.parse(hash.autoTopup) : undefined,
      autoTopupTodayCount: parseInt(hash.autoTopupTodayCount, 10) || 0,
      autoTopupLastResetDay: hash.autoTopupLastResetDay || new Date().toISOString().slice(0, 10),
      group: hash.group || undefined,
    };
  }

  // ─── Group Sync Operations ─────────────────────────────────────────────────

  /**
   * Save a group record to Redis. Fire-and-forget.
   */
  async saveGroup(group: KeyGroupRecord): Promise<void> {
    try {
      const redisKey = GROUP_PREFIX + group.id;
      await this.redis.hset(redisKey, ...this.groupToHash(group));
      await this.redis.command('SADD', GROUP_SET, group.id);
      await this.publishEvent({ type: 'group_updated', key: group.id });
    } catch (err) {
      this.logger.error(`Save group error: ${(err as Error).message}`);
    }
  }

  /**
   * Delete a group from Redis. Fire-and-forget.
   */
  async deleteGroup(groupId: string): Promise<void> {
    try {
      await this.redis.command('DEL', GROUP_PREFIX + groupId);
      await this.redis.command('SREM', GROUP_SET, groupId);
      await this.publishEvent({ type: 'group_deleted', key: groupId });
    } catch (err) {
      this.logger.error(`Delete group error: ${(err as Error).message}`);
    }
  }

  /**
   * Save all group assignments to Redis as a single hash (apiKey → groupId).
   * Fire-and-forget.
   */
  async saveGroupAssignments(): Promise<void> {
    if (!this.groupManager) return;
    try {
      // Clear existing assignments
      await this.redis.command('DEL', GROUP_ASSIGN_KEY);
      // Rebuild from group manager
      const serialized = this.groupManager.serialize();
      if (serialized.assignments.length > 0) {
        const fields: string[] = [];
        for (const [apiKey, groupId] of serialized.assignments) {
          fields.push(apiKey, groupId);
        }
        await this.redis.hset(GROUP_ASSIGN_KEY, ...fields);
      }
      await this.publishEvent({ type: 'group_assignment_changed', key: '' });
    } catch (err) {
      this.logger.error(`Save assignments error: ${(err as Error).message}`);
    }
  }

  /**
   * Load all groups and assignments from Redis into the local KeyGroupManager.
   */
  async loadGroupsFromRedis(): Promise<void> {
    if (!this.groupManager) return;
    try {
      const groupIds = await this.redis.command('SMEMBERS', GROUP_SET) as string[];
      if (!groupIds || groupIds.length === 0) {
        // No groups in Redis — push local state up if we have any
        if (this.groupManager.count > 0) {
          await this.pushGroupsToRedis();
        }
        return;
      }

      // Load all group records as [id, record] tuples (matches serialize() format)
      const groups: Array<[string, KeyGroupRecord]> = [];
      for (const id of groupIds) {
        const hash = await this.redis.hgetall(GROUP_PREFIX + id);
        if (!hash || !hash.id) continue;
        const record = this.hashToGroup(hash);
        if (record) groups.push([id, record]);
      }

      // Load assignments
      const assignHash = await this.redis.hgetall(GROUP_ASSIGN_KEY);
      const assignments: Array<[string, string]> = [];
      if (assignHash) {
        for (const [apiKey, groupId] of Object.entries(assignHash)) {
          assignments.push([apiKey, groupId]);
        }
      }

      // Load into group manager
      this.groupManager.load({ groups, assignments });

      if (groups.length > 0) {
        this.logger.info(`Synced ${groups.length} group(s) from Redis`);
      }
    } catch (err) {
      this.logger.error(`Load groups error: ${(err as Error).message}`);
    }
  }

  /**
   * Push local groups to Redis (used when Redis is empty on first connect).
   */
  private async pushGroupsToRedis(): Promise<void> {
    if (!this.groupManager) return;
    const serialized = this.groupManager.serialize();
    if (serialized.groups.length === 0) return;

    for (const [id, group] of serialized.groups) {
      const redisKey = GROUP_PREFIX + id;
      await this.redis.hset(redisKey, ...this.groupToHash(group));
      await this.redis.command('SADD', GROUP_SET, id);
    }

    if (serialized.assignments.length > 0) {
      const fields: string[] = [];
      for (const [apiKey, groupId] of serialized.assignments) {
        fields.push(apiKey, groupId);
      }
      await this.redis.hset(GROUP_ASSIGN_KEY, ...fields);
    }

    this.logger.info(`Pushed ${serialized.groups.length} local group(s) to Redis`);
  }

  // ─── Group Serialization ───────────────────────────────────────────────────

  private groupToHash(group: KeyGroupRecord): string[] {
    return [
      'id', group.id,
      'name', group.name,
      'description', group.description,
      'allowedTools', JSON.stringify(group.allowedTools),
      'deniedTools', JSON.stringify(group.deniedTools),
      'rateLimitPerMin', String(group.rateLimitPerMin),
      'toolPricing', JSON.stringify(group.toolPricing),
      'quota', group.quota ? JSON.stringify(group.quota) : '',
      'ipAllowlist', JSON.stringify(group.ipAllowlist),
      'defaultCredits', String(group.defaultCredits),
      'maxSpendingLimit', String(group.maxSpendingLimit),
      'tags', JSON.stringify(group.tags),
      'createdAt', group.createdAt,
      'active', group.active ? '1' : '0',
    ];
  }

  private hashToGroup(hash: Record<string, string>): KeyGroupRecord | null {
    if (!hash.id) return null;
    return {
      id: hash.id,
      name: hash.name || '',
      description: hash.description || '',
      allowedTools: hash.allowedTools ? JSON.parse(hash.allowedTools) : [],
      deniedTools: hash.deniedTools ? JSON.parse(hash.deniedTools) : [],
      rateLimitPerMin: parseInt(hash.rateLimitPerMin, 10) || 0,
      toolPricing: hash.toolPricing ? JSON.parse(hash.toolPricing) : {},
      quota: hash.quota ? JSON.parse(hash.quota) : undefined,
      ipAllowlist: hash.ipAllowlist ? JSON.parse(hash.ipAllowlist) : [],
      defaultCredits: parseInt(hash.defaultCredits, 10) || 0,
      maxSpendingLimit: parseInt(hash.maxSpendingLimit, 10) || 0,
      tags: hash.tags ? JSON.parse(hash.tags) : {},
      createdAt: hash.createdAt || new Date().toISOString(),
      active: hash.active !== '0',
    };
  }
}
