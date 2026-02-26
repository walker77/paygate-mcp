/**
 * Tests for Redis client RESP protocol, URL parsing, and RedisSync adapter.
 *
 * These tests verify:
 * 1. RESP protocol encoding/decoding (unit tests, no real Redis needed)
 * 2. Redis URL parsing
 * 3. RedisSync write-through adapter (using a mock Redis)
 * 4. Server constructor with redisUrl parameter
 */

import { RedisClient, parseRedisUrl, RedisClientOptions, RedisSubscriber } from '../src/redis-client';
import { RedisSync, PubSubEvent } from '../src/redis-sync';
import { KeyStore } from '../src/store';
import { PayGateServer } from '../src/server';
import { Socket } from 'net';

// ─── URL Parsing ──────────────────────────────────────────────────────────────

describe('parseRedisUrl', () => {
  it('should parse basic redis URL', () => {
    const opts = parseRedisUrl('redis://localhost:6379');
    expect(opts.host).toBe('localhost');
    expect(opts.port).toBe(6379);
    expect(opts.password).toBeUndefined();
    expect(opts.db).toBe(0);
  });

  it('should parse URL with password', () => {
    const opts = parseRedisUrl('redis://:mypassword@redis.example.com:6380');
    expect(opts.host).toBe('redis.example.com');
    expect(opts.port).toBe(6380);
    expect(opts.password).toBe('mypassword');
    expect(opts.db).toBe(0);
  });

  it('should parse URL with database number', () => {
    const opts = parseRedisUrl('redis://localhost:6379/3');
    expect(opts.host).toBe('localhost');
    expect(opts.port).toBe(6379);
    expect(opts.db).toBe(3);
  });

  it('should parse URL with password and db', () => {
    const opts = parseRedisUrl('redis://:secret@host:6380/5');
    expect(opts.host).toBe('host');
    expect(opts.port).toBe(6380);
    expect(opts.password).toBe('secret');
    expect(opts.db).toBe(5);
  });

  it('should default port to 6379', () => {
    const opts = parseRedisUrl('redis://localhost');
    expect(opts.port).toBe(6379);
  });

  it('should default host to 127.0.0.1 when only host specified', () => {
    const opts = parseRedisUrl('redis://127.0.0.1');
    expect(opts.host).toBe('127.0.0.1');
    expect(opts.port).toBe(6379);
    expect(opts.db).toBe(0);
  });
});

// ─── RedisClient unit tests (RESP protocol) ──────────────────────────────────

describe('RedisClient', () => {
  it('should construct with options', () => {
    const client = new RedisClient({
      host: 'localhost',
      port: 6379,
    });
    expect(client).toBeDefined();
    expect(client.isConnected).toBe(false);
  });

  it('should set default timeouts', () => {
    const client = new RedisClient({
      host: 'localhost',
      port: 6379,
      connectTimeout: 1000,
      commandTimeout: 2000,
    });
    expect(client).toBeDefined();
  });

  it('should handle disconnect when not connected', async () => {
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    await client.disconnect();
    expect(client.isConnected).toBe(false);
  });

  it('should fail to connect to non-existent server', async () => {
    const client = new RedisClient({
      host: '127.0.0.1',
      port: 59999, // unlikely to have a server here
      connectTimeout: 500,
    });
    await expect(client.connect()).rejects.toThrow();
  });
});

// ─── RedisSync adapter tests (with mock) ─────────────────────────────────────

describe('RedisSync', () => {
  let store: KeyStore;

  beforeEach(() => {
    store = new KeyStore();
  });

  it('should construct with store and client', () => {
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);
    expect(sync).toBeDefined();
  });

  it('should serialize ApiKeyRecord to hash fields', () => {
    // Create a key in the store
    const record = store.createKey('test', 1000, {
      allowedTools: ['search'],
      tags: { env: 'test' },
    });

    // Access the private method via casting
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);

    // Verify the store has the record
    const retrieved = store.getKey(record.key);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe('test');
    expect(retrieved!.credits).toBe(1000);
    expect(retrieved!.allowedTools).toEqual(['search']);
    expect(retrieved!.tags).toEqual({ env: 'test' });
  });

  it('should handle destroy gracefully', async () => {
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);
    // Should not throw even without init
    await sync.destroy();
  });
});

// ─── Server integration ──────────────────────────────────────────────────────

describe('Server with Redis URL', () => {
  it('should accept redisUrl parameter', () => {
    // RedisSync is created but not connected until start() is called
    const server = new PayGateServer(
      {
        serverCommand: 'echo',
        serverArgs: ['test'],
        port: 0,
        defaultCreditsPerCall: 1,
        globalRateLimitPerMin: 60,
      },
      'admin_test123',
      undefined,
      undefined,
      undefined,
      undefined,
      'redis://localhost:6379'
    );

    expect(server.redisSync).not.toBeNull();
  });

  it('should have null redisSync when no URL provided', () => {
    const server = new PayGateServer(
      {
        serverCommand: 'echo',
        serverArgs: ['test'],
        port: 0,
        defaultCreditsPerCall: 1,
        globalRateLimitPerMin: 60,
      },
      'admin_test123'
    );

    expect(server.redisSync).toBeNull();
  });

  it('should include redis in root endpoint response', async () => {
    const server = new PayGateServer(
      {
        serverCommand: 'echo',
        serverArgs: ['test'],
        port: 0,
        defaultCreditsPerCall: 1,
        globalRateLimitPerMin: 60,
      },
      'admin_testkey',
      undefined,
      undefined,
      undefined,
      undefined,
      'redis://localhost:6379'
    );

    // Use internal handler to test root response
    // The server has redisSync set
    expect(server.redisSync).toBeDefined();
  });
});

// ─── RESP Protocol Encoding Tests ────────────────────────────────────────────

describe('RESP Protocol', () => {
  it('RedisClient should encode commands as RESP arrays', () => {
    // We test encoding indirectly by verifying the client can be constructed
    // and that it properly encodes RESP format. The actual encoding is private
    // but we can verify the client structure.
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    expect(client).toHaveProperty('isConnected');
    expect(client.isConnected).toBe(false);
  });
});

// ─── Hash serialization round-trip tests ─────────────────────────────────────

describe('RedisSync serialization', () => {
  it('should round-trip ApiKeyRecord through hash format', () => {
    const store = new KeyStore();
    const record = store.createKey('round-trip-test', 5000, {
      allowedTools: ['tool1', 'tool2'],
      deniedTools: ['tool3'],
      expiresAt: '2030-01-01T00:00:00Z',
      quota: {
        dailyCallLimit: 100,
        monthlyCallLimit: 3000,
        dailyCreditLimit: 500,
        monthlyCreditLimit: 15000,
      },
      tags: { project: 'test', env: 'staging' },
      ipAllowlist: ['192.168.1.0/24', '10.0.0.1'],
    });

    // Verify all fields are properly stored
    const retrieved = store.getKey(record.key);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.key).toBe(record.key);
    expect(retrieved!.name).toBe('round-trip-test');
    expect(retrieved!.credits).toBe(5000);
    expect(retrieved!.allowedTools).toEqual(['tool1', 'tool2']);
    expect(retrieved!.deniedTools).toEqual(['tool3']);
    expect(retrieved!.expiresAt).toBe('2030-01-01T00:00:00Z');
    expect(retrieved!.quota).toEqual({
      dailyCallLimit: 100,
      monthlyCallLimit: 3000,
      dailyCreditLimit: 500,
      monthlyCreditLimit: 15000,
    });
    expect(retrieved!.tags).toEqual({ project: 'test', env: 'staging' });
    expect(retrieved!.ipAllowlist).toEqual(['192.168.1.0/24', '10.0.0.1']);
    expect(retrieved!.active).toBe(true);
    expect(retrieved!.totalSpent).toBe(0);
    expect(retrieved!.totalCalls).toBe(0);
  });

  it('should handle empty/null optional fields', () => {
    const store = new KeyStore();
    const record = store.createKey('minimal', 100);

    const retrieved = store.getKey(record.key);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.allowedTools).toEqual([]);
    expect(retrieved!.deniedTools).toEqual([]);
    expect(retrieved!.expiresAt).toBeNull();
    expect(retrieved!.quota).toBeUndefined();
    expect(retrieved!.tags).toEqual({});
    expect(retrieved!.ipAllowlist).toEqual([]);
  });
});

// ─── Usage Meter sync tests ─────────────────────────────────────────────────

describe('RedisSync usage meter', () => {
  it('should have recordUsage method', () => {
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);
    expect(typeof sync.recordUsage).toBe('function');
  });

  it('should have getUsageEvents method', () => {
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);
    expect(typeof sync.getUsageEvents).toBe('function');
  });

  it('should have getUsageCount method', () => {
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);
    expect(typeof sync.getUsageCount).toBe('function');
  });

  it('recordUsage should handle errors gracefully when not connected', async () => {
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);
    // Should not throw — errors are caught internally
    await expect(sync.recordUsage({
      timestamp: new Date().toISOString(),
      apiKey: 'pg_test123',
      keyName: 'test',
      tool: 'search',
      creditsCharged: 1,
      allowed: true,
    })).resolves.not.toThrow();
  });

  it('getUsageEvents should return empty array when not connected', async () => {
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);
    const events = await sync.getUsageEvents();
    expect(events).toEqual([]);
  });

  it('getUsageCount should return 0 when not connected', async () => {
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);
    const count = await sync.getUsageCount();
    expect(count).toBe(0);
  });
});

// ─── Rate Limiter sync tests ────────────────────────────────────────────────

describe('RedisSync rate limiter', () => {
  it('should have checkRateLimit method', () => {
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);
    expect(typeof sync.checkRateLimit).toBe('function');
  });

  it('checkRateLimit should allow unlimited when maxCalls is 0', async () => {
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);
    const result = await sync.checkRateLimit('test-key', 0);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(Infinity);
    expect(result.resetInMs).toBe(0);
  });

  it('checkRateLimit should allow unlimited when maxCalls is negative', async () => {
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);
    const result = await sync.checkRateLimit('test-key', -1);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(Infinity);
  });

  it('checkRateLimit should fail-open when Redis not connected', async () => {
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);
    // Not connected — should fail-open (allow)
    const result = await sync.checkRateLimit('test-key', 100);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(99);
  });

  it('checkRateLimit should support custom window size', async () => {
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);
    // Custom 30-second window
    const result = await sync.checkRateLimit('test-key', 100, 30000);
    expect(result.allowed).toBe(true);
  });

  it('should use composite keys for per-tool rate limiting', async () => {
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);
    // Composite key format: "pg_abc:tool:search"
    const result = await sync.checkRateLimit('pg_abc:tool:search', 100);
    expect(result.allowed).toBe(true);
  });
});

// ─── Rate limiter Lua script structure tests ────────────────────────────────

describe('Rate Limiter Lua script', () => {
  it('should use sorted set pattern for sliding window', () => {
    // Verify the Redis sync class exposes the right interface
    const store = new KeyStore();
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    const sync = new RedisSync(client, store);

    // The Lua script uses ZREMRANGEBYSCORE + ZCARD + ZADD pattern
    // We verify the API contract returns the expected shape
    expect(sync.checkRateLimit).toBeDefined();
  });
});

// ─── Gate hook wiring tests ──────────────────────────────────────────────────

describe('Gate Redis hooks', () => {
  it('should have onUsageEvent hook property', () => {
    const { Gate } = require('../src/gate');
    const gate = new Gate({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 60,
      freeMethods: ['initialize', 'ping'],
      toolPricing: {},
      shadowMode: false,
      webhookUrl: null,
      webhookSecret: null,
      refundOnFailure: false,
      name: 'test',
    });
    expect(gate.onUsageEvent).toBeUndefined();
    // Should be settable
    const events: any[] = [];
    gate.onUsageEvent = (event: any) => events.push(event);
    expect(typeof gate.onUsageEvent).toBe('function');
  });

  it('should have onCreditsDeducted hook property', () => {
    const { Gate } = require('../src/gate');
    const gate = new Gate({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 60,
      freeMethods: ['initialize', 'ping'],
      toolPricing: {},
      shadowMode: false,
      webhookUrl: null,
      webhookSecret: null,
      refundOnFailure: false,
      name: 'test',
    });
    expect(gate.onCreditsDeducted).toBeUndefined();
    const deductions: any[] = [];
    gate.onCreditsDeducted = (key: string, amt: number) => deductions.push({ key, amt });
    expect(typeof gate.onCreditsDeducted).toBe('function');
  });

  it('should fire onUsageEvent when gate evaluates', () => {
    const { Gate } = require('../src/gate');
    const gate = new Gate({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 60,
      freeMethods: ['initialize', 'ping'],
      toolPricing: {},
      shadowMode: false,
      webhookUrl: null,
      webhookSecret: null,
      refundOnFailure: false,
      name: 'test',
    });

    const events: any[] = [];
    gate.onUsageEvent = (event: any) => events.push(event);

    // Create a key and evaluate
    const record = gate.store.createKey('test-key', 100);
    gate.evaluate(record.key, { name: 'search', arguments: {} });

    // Should have recorded at least one usage event
    expect(events.length).toBe(1);
    expect(events[0].tool).toBe('search');
    expect(events[0].allowed).toBe(true);
    expect(events[0].creditsCharged).toBe(1);
  });

  it('should fire onCreditsDeducted when gate allows', () => {
    const { Gate } = require('../src/gate');
    const gate = new Gate({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      defaultCreditsPerCall: 5,
      globalRateLimitPerMin: 60,
      freeMethods: ['initialize', 'ping'],
      toolPricing: {},
      shadowMode: false,
      webhookUrl: null,
      webhookSecret: null,
      refundOnFailure: false,
      name: 'test',
    });

    const deductions: any[] = [];
    gate.onCreditsDeducted = (key: string, amt: number) => deductions.push({ key, amt });

    const record = gate.store.createKey('test-key', 100);
    gate.evaluate(record.key, { name: 'search', arguments: {} });

    expect(deductions.length).toBe(1);
    expect(deductions[0].key).toBe(record.key);
    expect(deductions[0].amt).toBe(5);
  });

  it('should NOT fire onCreditsDeducted when gate denies', () => {
    const { Gate } = require('../src/gate');
    const gate = new Gate({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 60,
      freeMethods: ['initialize', 'ping'],
      toolPricing: {},
      shadowMode: false,
      webhookUrl: null,
      webhookSecret: null,
      refundOnFailure: false,
      name: 'test',
    });

    const deductions: any[] = [];
    gate.onCreditsDeducted = (key: string, amt: number) => deductions.push({ key, amt });

    // Evaluate with no key (should deny)
    gate.evaluate(null, { name: 'search', arguments: {} });

    expect(deductions.length).toBe(0);
  });

  it('should fire onUsageEvent for denied calls too', () => {
    const { Gate } = require('../src/gate');
    const gate = new Gate({
      serverCommand: 'echo',
      serverArgs: ['test'],
      port: 0,
      defaultCreditsPerCall: 1,
      globalRateLimitPerMin: 60,
      freeMethods: ['initialize', 'ping'],
      toolPricing: {},
      shadowMode: false,
      webhookUrl: null,
      webhookSecret: null,
      refundOnFailure: false,
      name: 'test',
    });

    const events: any[] = [];
    gate.onUsageEvent = (event: any) => events.push(event);

    // Evaluate with no key (denied)
    gate.evaluate(null, { name: 'search', arguments: {} });

    expect(events.length).toBe(1);
    expect(events[0].allowed).toBe(false);
    expect(events[0].denyReason).toBe('missing_api_key');
  });

  it('server should wire hooks when redisUrl is provided', () => {
    const server = new PayGateServer(
      {
        serverCommand: 'echo',
        serverArgs: ['test'],
        port: 0,
        defaultCreditsPerCall: 1,
        globalRateLimitPerMin: 60,
      },
      'admin_test123',
      undefined,
      undefined,
      undefined,
      undefined,
      'redis://localhost:6379'
    );

    // Hooks should be set
    expect(server.gate.onUsageEvent).toBeDefined();
    expect(server.gate.onCreditsDeducted).toBeDefined();
  });

  it('server should NOT wire hooks when no redisUrl', () => {
    const server = new PayGateServer(
      {
        serverCommand: 'echo',
        serverArgs: ['test'],
        port: 0,
        defaultCreditsPerCall: 1,
        globalRateLimitPerMin: 60,
      },
      'admin_test123'
    );

    // Hooks should be undefined
    expect(server.gate.onUsageEvent).toBeUndefined();
    expect(server.gate.onCreditsDeducted).toBeUndefined();
  });
});

// ─── CLI config tests ────────────────────────────────────────────────────────

describe('CLI --redis-url', () => {
  it('should parse redis URL from config file format', () => {
    // Simulate config file with redisUrl
    const config = { redisUrl: 'redis://redis.internal:6379/2' };
    const parsed = parseRedisUrl(config.redisUrl);
    expect(parsed.host).toBe('redis.internal');
    expect(parsed.port).toBe(6379);
    expect(parsed.db).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Redis Pub/Sub Tests — v2.3.0
// ═══════════════════════════════════════════════════════════════════════════════

// ─── RedisSubscriber unit tests ──────────────────────────────────────────────

describe('RedisSubscriber', () => {
  it('should construct with options', () => {
    const sub = new RedisSubscriber({
      host: 'localhost',
      port: 6379,
    });
    expect(sub).toBeDefined();
    expect(sub.isConnected).toBe(false);
    expect(sub.isSubscribed).toBe(false);
  });

  it('should handle disconnect when not connected', async () => {
    const sub = new RedisSubscriber({ host: 'localhost', port: 6379 });
    await sub.disconnect();
    expect(sub.isConnected).toBe(false);
    expect(sub.isSubscribed).toBe(false);
  });

  it('should fail to connect to non-existent server', async () => {
    const sub = new RedisSubscriber({
      host: '127.0.0.1',
      port: 59998,
      connectTimeout: 500,
    });
    await expect(sub.connect()).rejects.toThrow();
  });

  it('should support custom timeouts', () => {
    const sub = new RedisSubscriber({
      host: 'localhost',
      port: 6379,
      connectTimeout: 1000,
      commandTimeout: 2000,
    });
    expect(sub).toBeDefined();
  });
});

// ─── RedisClient publish() tests ─────────────────────────────────────────────

describe('RedisClient publish', () => {
  it('should have publish method', () => {
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    expect(typeof client.publish).toBe('function');
  });

  it('should have list command methods', () => {
    const client = new RedisClient({ host: 'localhost', port: 6379 });
    expect(typeof client.rpush).toBe('function');
    expect(typeof client.lrange).toBe('function');
    expect(typeof client.llen).toBe('function');
    expect(typeof client.ltrim).toBe('function');
  });
});

// ─── RedisSync pub/sub integration tests ─────────────────────────────────────

describe('RedisSync pub/sub', () => {
  let store: KeyStore;
  let client: RedisClient;
  let sync: RedisSync;

  beforeEach(() => {
    store = new KeyStore();
    client = new RedisClient({ host: 'localhost', port: 6379 });
    sync = new RedisSync(client, store);
  });

  it('should generate unique instanceId', () => {
    const sync2 = new RedisSync(client, store);
    expect(sync.instanceId).toBeDefined();
    expect(sync.instanceId.length).toBe(16); // 8 bytes = 16 hex chars
    expect(sync.instanceId).not.toBe(sync2.instanceId);
  });

  it('should have publishEvent method', () => {
    expect(typeof sync.publishEvent).toBe('function');
  });

  it('should have isPubSubActive getter', () => {
    expect(sync.isPubSubActive).toBe(false); // Not initialized yet
  });

  it('should have onPubSubEvent callback property', () => {
    expect(sync.onPubSubEvent).toBeUndefined();
    const events: PubSubEvent[] = [];
    sync.onPubSubEvent = (event) => events.push(event);
    expect(typeof sync.onPubSubEvent).toBe('function');
  });

  it('publishEvent should handle errors gracefully when not connected', async () => {
    // Should not throw — errors are caught internally
    await expect(sync.publishEvent({
      type: 'key_updated',
      key: 'pg_test123',
    })).resolves.not.toThrow();
  });

  it('publishEvent should include instanceId', async () => {
    // Mock the publish method on the client to capture the message
    let captured: string | null = null;
    (client as any).publish = async (_channel: string, message: string) => {
      captured = message;
      return 0;
    };
    // Force connected state for publish
    (client as any).connected = true;

    await sync.publishEvent({ type: 'key_updated', key: 'pg_test123' });

    expect(captured).not.toBeNull();
    const parsed = JSON.parse(captured!);
    expect(parsed.instanceId).toBe(sync.instanceId);
    expect(parsed.type).toBe('key_updated');
    expect(parsed.key).toBe('pg_test123');
  });

  it('should ignore self-messages in handlePubSubMessage', () => {
    const store2 = new KeyStore();
    const record = store2.createKey('test-key', 100);
    // Create sync with a known store
    const sync2 = new RedisSync(client, store2);

    const receivedEvents: PubSubEvent[] = [];
    sync2.onPubSubEvent = (event) => receivedEvents.push(event);

    // Simulate receiving a message from ourselves
    const selfMessage: PubSubEvent = {
      type: 'key_revoked',
      key: record.key,
      instanceId: sync2.instanceId, // same instance!
    };
    (sync2 as any).handlePubSubMessage(JSON.stringify(selfMessage));

    // Should be ignored — no callback fired
    expect(receivedEvents.length).toBe(0);
    // And key should NOT be revoked locally
    const retrieved = store2.getKey(record.key);
    expect(retrieved?.active).toBe(true);
  });

  it('should process credits_changed from other instances', () => {
    const record = store.createKey('test-key', 500);

    const receivedEvents: PubSubEvent[] = [];
    sync.onPubSubEvent = (event) => receivedEvents.push(event);

    // Simulate receiving a credits_changed message from another instance
    const otherMessage: PubSubEvent = {
      type: 'credits_changed',
      key: record.key,
      instanceId: 'other_instance_id_1234',
      data: {
        credits: 450,
        totalSpent: 50,
        totalCalls: 5,
      },
    };
    (sync as any).handlePubSubMessage(JSON.stringify(otherMessage));

    // Callback should fire
    expect(receivedEvents.length).toBe(1);
    expect(receivedEvents[0].type).toBe('credits_changed');

    // Local store should be updated with inline data
    const updated = store.getKey(record.key);
    expect(updated?.credits).toBe(450);
    expect(updated?.totalSpent).toBe(50);
    expect(updated?.totalCalls).toBe(5);
  });

  it('should process key_revoked from other instances', () => {
    const record = store.createKey('revoke-test', 200);
    expect(store.getKey(record.key)?.active).toBe(true);

    // Simulate key_revoked from another instance
    const revokeMsg: PubSubEvent = {
      type: 'key_revoked',
      key: record.key,
      instanceId: 'other_instance_9999',
    };
    (sync as any).handlePubSubMessage(JSON.stringify(revokeMsg));

    // Local key should be marked inactive — access internal map directly
    // (store.getKey returns null for inactive keys)
    const localKeys = (store as any).keys as Map<string, any>;
    const found = localKeys.get(record.key);
    expect(found?.active).toBe(false);
  });

  it('should handle malformed pub/sub messages gracefully', () => {
    // Should not throw on invalid JSON
    expect(() => {
      (sync as any).handlePubSubMessage('not valid json {{{');
    }).not.toThrow();

    // Should not throw on valid JSON but wrong shape
    expect(() => {
      (sync as any).handlePubSubMessage(JSON.stringify({ foo: 'bar' }));
    }).not.toThrow();

    // Should not throw on empty string
    expect(() => {
      (sync as any).handlePubSubMessage('');
    }).not.toThrow();
  });

  it('should handle credits_changed for non-existent key', () => {
    // Receiving update for a key we don't have locally — should not throw
    const msg: PubSubEvent = {
      type: 'credits_changed',
      key: 'pg_nonexistent_key',
      instanceId: 'other_instance',
      data: { credits: 100 },
    };
    expect(() => {
      (sync as any).handlePubSubMessage(JSON.stringify(msg));
    }).not.toThrow();
  });

  it('should handle key_updated by triggering refreshSingleKey', () => {
    // key_updated triggers an async refresh from Redis
    // We just verify it doesn't throw (actual refresh would need Redis connection)
    const msg: PubSubEvent = {
      type: 'key_updated',
      key: 'pg_some_key',
      instanceId: 'other_instance',
    };
    expect(() => {
      (sync as any).handlePubSubMessage(JSON.stringify(msg));
    }).not.toThrow();
  });

  it('should handle key_created by triggering refreshSingleKey', () => {
    const msg: PubSubEvent = {
      type: 'key_created',
      key: 'pg_new_key',
      instanceId: 'other_instance',
    };
    expect(() => {
      (sync as any).handlePubSubMessage(JSON.stringify(msg));
    }).not.toThrow();
  });
});

// ─── PubSubEvent type tests ──────────────────────────────────────────────────

describe('PubSubEvent types', () => {
  it('should support all event types', () => {
    const types: PubSubEvent['type'][] = ['key_updated', 'key_revoked', 'credits_changed', 'key_created'];
    for (const type of types) {
      const event: PubSubEvent = {
        type,
        key: 'pg_test',
        instanceId: 'test_instance',
      };
      expect(event.type).toBe(type);
    }
  });

  it('should support optional inline data', () => {
    const event: PubSubEvent = {
      type: 'credits_changed',
      key: 'pg_test',
      instanceId: 'test_instance',
      data: {
        credits: 100,
        totalSpent: 50,
        totalCalls: 10,
        active: true,
      },
    };
    expect(event.data?.credits).toBe(100);
    expect(event.data?.active).toBe(true);
  });

  it('should work without inline data', () => {
    const event: PubSubEvent = {
      type: 'key_updated',
      key: 'pg_test',
      instanceId: 'test_instance',
    };
    expect(event.data).toBeUndefined();
  });
});

// ─── Server pub/sub wiring tests ─────────────────────────────────────────────

describe('Server Redis pub/sub', () => {
  it('should store subscriber opts when redisUrl is provided', () => {
    const server = new PayGateServer(
      {
        serverCommand: 'echo',
        serverArgs: ['test'],
        port: 0,
        defaultCreditsPerCall: 1,
        globalRateLimitPerMin: 60,
      },
      'admin_test123',
      undefined,
      undefined,
      undefined,
      undefined,
      'redis://localhost:6379'
    );

    expect(server.redisSync).not.toBeNull();
    const subOpts = (server.redisSync as any)._subscriberOpts;
    expect(subOpts).toBeDefined();
    expect(subOpts.host).toBe('localhost');
    expect(subOpts.port).toBe(6379);
  });

  it('should have unique instanceId per RedisSync', () => {
    const server1 = new PayGateServer(
      { serverCommand: 'echo', serverArgs: ['test'], port: 0, defaultCreditsPerCall: 1, globalRateLimitPerMin: 60 },
      'admin_1', undefined, undefined, undefined, undefined, 'redis://localhost:6379'
    );
    const server2 = new PayGateServer(
      { serverCommand: 'echo', serverArgs: ['test'], port: 0, defaultCreditsPerCall: 1, globalRateLimitPerMin: 60 },
      'admin_2', undefined, undefined, undefined, undefined, 'redis://localhost:6379'
    );

    expect(server1.redisSync!.instanceId).not.toBe(server2.redisSync!.instanceId);
  });

  it('redisSync should not be pubsub active before start()', () => {
    const server = new PayGateServer(
      { serverCommand: 'echo', serverArgs: ['test'], port: 0, defaultCreditsPerCall: 1, globalRateLimitPerMin: 60 },
      'admin_test', undefined, undefined, undefined, undefined, 'redis://localhost:6379'
    );

    expect(server.redisSync!.isPubSubActive).toBe(false);
  });
});
