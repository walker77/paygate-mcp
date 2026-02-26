/**
 * RedisClient — Minimal zero-dependency Redis client using raw RESP protocol.
 *
 * Implements just enough of the Redis protocol for PayGate's needs:
 * SET, GET, DEL, INCR, INCRBY, DECRBY, EXPIRE, PEXPIRE, EXISTS,
 * HSET, HGET, HGETALL, HDEL, EVALSHA/script execution (Lua),
 * ZADD, ZRANGEBYSCORE, ZREMRANGEBYSCORE, ZCARD,
 * SCAN, KEYS, INFO, PING, AUTH, SELECT.
 *
 * Uses Node.js net.Socket (built-in, zero deps). Supports auth and db selection.
 * Connection is lazy — established on first command.
 *
 * NOTE: The `evalLua` method uses Redis EVAL command to execute server-side
 * Lua scripts for atomic operations. These scripts are hardcoded within
 * PayGate (not user-provided) and are essential for atomic credit deduction
 * and rate limiting in distributed deployments.
 */

import { Socket } from 'net';

export interface RedisClientOptions {
  host: string;
  port: number;
  password?: string;
  db?: number;
  connectTimeout?: number;
  commandTimeout?: number;
}

type RedisReply = string | number | null | RedisReply[];

interface PendingCommand {
  resolve: (value: RedisReply) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Parse a redis:// URL into connection options.
 * Format: redis://[:password@]host[:port][/db]
 */
export function parseRedisUrl(url: string): RedisClientOptions {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || '127.0.0.1',
    port: parseInt(parsed.port, 10) || 6379,
    password: parsed.password || undefined,
    db: parsed.pathname && parsed.pathname.length > 1
      ? parseInt(parsed.pathname.slice(1), 10) || 0
      : 0,
  };
}

export class RedisClient {
  private socket: Socket | null = null;
  private connected = false;
  private connecting = false;
  private queue: PendingCommand[] = [];
  private buffer = Buffer.alloc(0);
  private readonly opts: Required<RedisClientOptions>;
  private closed = false;

  constructor(opts: RedisClientOptions) {
    this.opts = {
      host: opts.host,
      port: opts.port,
      password: opts.password || '',
      db: opts.db || 0,
      connectTimeout: opts.connectTimeout || 5000,
      commandTimeout: opts.commandTimeout || 10000,
    };
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  async ping(): Promise<string> {
    return (await this.command('PING')) as string;
  }

  async set(key: string, value: string, exSeconds?: number): Promise<string> {
    if (exSeconds && exSeconds > 0) {
      return (await this.command('SET', key, value, 'EX', String(exSeconds))) as string;
    }
    return (await this.command('SET', key, value)) as string;
  }

  async get(key: string): Promise<string | null> {
    return (await this.command('GET', key)) as string | null;
  }

  async del(...keys: string[]): Promise<number> {
    return (await this.command('DEL', ...keys)) as number;
  }

  async incr(key: string): Promise<number> {
    return (await this.command('INCR', key)) as number;
  }

  async incrby(key: string, amount: number): Promise<number> {
    return (await this.command('INCRBY', key, String(amount))) as number;
  }

  async decrby(key: string, amount: number): Promise<number> {
    return (await this.command('DECRBY', key, String(amount))) as number;
  }

  async exists(key: string): Promise<number> {
    return (await this.command('EXISTS', key)) as number;
  }

  async expire(key: string, seconds: number): Promise<number> {
    return (await this.command('EXPIRE', key, String(seconds))) as number;
  }

  async pexpire(key: string, ms: number): Promise<number> {
    return (await this.command('PEXPIRE', key, String(ms))) as number;
  }

  // ─── Hash commands ─────────────────────────────────────────────────────────

  async hset(key: string, ...fieldValues: string[]): Promise<number> {
    return (await this.command('HSET', key, ...fieldValues)) as number;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return (await this.command('HGET', key, field)) as string | null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const reply = (await this.command('HGETALL', key)) as string[];
    const result: Record<string, string> = {};
    if (Array.isArray(reply)) {
      for (let i = 0; i < reply.length; i += 2) {
        result[reply[i]] = reply[i + 1];
      }
    }
    return result;
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    return (await this.command('HDEL', key, ...fields)) as number;
  }

  // ─── Sorted set commands ───────────────────────────────────────────────────

  async zadd(key: string, score: number, member: string): Promise<number> {
    return (await this.command('ZADD', key, String(score), member)) as number;
  }

  async zrangebyscore(key: string, min: string | number, max: string | number): Promise<string[]> {
    return (await this.command('ZRANGEBYSCORE', key, String(min), String(max))) as string[];
  }

  async zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number> {
    return (await this.command('ZREMRANGEBYSCORE', key, String(min), String(max))) as number;
  }

  async zcard(key: string): Promise<number> {
    return (await this.command('ZCARD', key)) as number;
  }

  // ─── Lua scripting (for atomic operations) ─────────────────────────────────

  /**
   * Execute a server-side Lua script atomically. Used internally by PayGate
   * for atomic credit deduction and rate limiting. Scripts are hardcoded
   * constants, never user-provided input.
   */
  async evalLua(script: string, numkeys: number, ...keysAndArgs: string[]): Promise<RedisReply> {
    return this.command('EVAL', script, String(numkeys), ...keysAndArgs);
  }

  // ─── Scan ──────────────────────────────────────────────────────────────────

  async scan(cursor: string, pattern: string, count = 100): Promise<[string, string[]]> {
    const reply = (await this.command('SCAN', cursor, 'MATCH', pattern, 'COUNT', String(count))) as [string, string[]];
    return reply;
  }

  /**
   * Scan all keys matching a pattern. Iterates until cursor returns "0".
   */
  async scanAll(pattern: string, count = 100): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.scan(cursor, pattern, count);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }

  // ─── Connection management ─────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) {
      return new Promise((resolve, reject) => {
        const check = setInterval(() => {
          if (this.connected) { clearInterval(check); resolve(); }
          if (this.closed) { clearInterval(check); reject(new Error('Connection closed')); }
        }, 50);
      });
    }
    this.connecting = true;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Redis connect timeout (${this.opts.connectTimeout}ms)`));
        this.connecting = false;
      }, this.opts.connectTimeout);

      this.socket = new Socket();
      this.socket.setNoDelay(true);

      this.socket.on('data', (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.processBuffer();
      });

      this.socket.on('error', (err) => {
        clearTimeout(timer);
        if (!this.connected) {
          this.connecting = false;
          reject(err);
        }
        // Reject all pending commands
        for (const cmd of this.queue) {
          cmd.reject(err);
          if (cmd.timer) clearTimeout(cmd.timer);
        }
        this.queue = [];
      });

      this.socket.on('close', () => {
        this.connected = false;
        this.connecting = false;
      });

      this.socket.connect(this.opts.port, this.opts.host, async () => {
        clearTimeout(timer);
        this.connected = true;
        this.connecting = false;

        try {
          // AUTH if password provided
          if (this.opts.password) {
            await this.command('AUTH', this.opts.password);
          }
          // SELECT db if non-zero
          if (this.opts.db > 0) {
            await this.command('SELECT', String(this.opts.db));
          }
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.connecting = false;
    // Reject pending commands
    for (const cmd of this.queue) {
      cmd.reject(new Error('Disconnected'));
      if (cmd.timer) clearTimeout(cmd.timer);
    }
    this.queue = [];
  }

  get isConnected(): boolean {
    return this.connected;
  }

  // ─── Core command execution ────────────────────────────────────────────────

  async command(...args: string[]): Promise<RedisReply> {
    if (!this.connected && !this.connecting) {
      await this.connect();
    }

    return new Promise<RedisReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Redis command timeout: ${args[0]}`));
      }, this.opts.commandTimeout);

      this.queue.push({ resolve, reject, timer });

      // Encode RESP array
      const encoded = this.encodeCommand(args);
      this.socket!.write(encoded);
    });
  }

  // ─── RESP protocol encoding ────────────────────────────────────────────────

  private encodeCommand(args: string[]): string {
    let resp = `*${args.length}\r\n`;
    for (const arg of args) {
      const buf = Buffer.from(arg);
      resp += `$${buf.length}\r\n${arg}\r\n`;
    }
    return resp;
  }

  // ─── RESP protocol decoding ────────────────────────────────────────────────

  private processBuffer(): void {
    while (this.buffer.length > 0 && this.queue.length > 0) {
      const result = this.parseReply(this.buffer, 0);
      if (result === null) break; // Incomplete data, wait for more

      const [reply, consumed] = result;
      this.buffer = this.buffer.subarray(consumed);

      const cmd = this.queue.shift()!;
      if (cmd.timer) clearTimeout(cmd.timer);

      if (reply instanceof Error) {
        cmd.reject(reply);
      } else {
        cmd.resolve(reply);
      }
    }
  }

  /**
   * Parse a RESP reply from the buffer starting at offset.
   * Returns [parsed_value, bytes_consumed] or null if incomplete.
   */
  private parseReply(buf: Buffer, offset: number): [RedisReply | Error, number] | null {
    if (offset >= buf.length) return null;

    const type = String.fromCharCode(buf[offset]);
    const lineEnd = this.findCRLF(buf, offset);
    if (lineEnd === -1) return null;

    const line = buf.subarray(offset + 1, lineEnd).toString();
    const consumed = lineEnd + 2; // past \r\n

    switch (type) {
      case '+': // Simple string
        return [line, consumed];

      case '-': // Error
        return [new Error(line), consumed];

      case ':': // Integer
        return [parseInt(line, 10), consumed];

      case '$': { // Bulk string
        const len = parseInt(line, 10);
        if (len === -1) return [null, consumed];
        if (consumed + len + 2 > buf.length) return null; // Incomplete
        const data = buf.subarray(consumed, consumed + len).toString();
        return [data, consumed + len + 2]; // +2 for trailing \r\n
      }

      case '*': { // Array
        const count = parseInt(line, 10);
        if (count === -1) return [null, consumed];
        const items: RedisReply[] = [];
        let pos = consumed;
        for (let i = 0; i < count; i++) {
          const item = this.parseReply(buf, pos);
          if (item === null) return null; // Incomplete
          const [val, itemConsumed] = item;
          if (val instanceof Error) return [val, itemConsumed];
          items.push(val);
          pos = itemConsumed;
        }
        return [items, pos];
      }

      default:
        return [new Error(`Unknown RESP type: ${type}`), consumed];
    }
  }

  private findCRLF(buf: Buffer, start: number): number {
    for (let i = start; i < buf.length - 1; i++) {
      if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i;
    }
    return -1;
  }
}
