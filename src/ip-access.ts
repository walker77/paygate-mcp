/**
 * IpAccessController — IP-based access control for PayGate.
 *
 * Provides allow/deny lists with CIDR notation support, per-key IP
 * restrictions, and automatic blocking of abusive IPs. Operates
 * entirely in-process with zero external dependencies.
 *
 * Features:
 *   - Global allow/deny lists with CIDR notation (IPv4 and IPv6)
 *   - Per-key IP restrictions (bind keys to specific IPs/CIDRs)
 *   - Automatic IP blocking based on configurable thresholds
 *   - X-Forwarded-For / X-Real-IP header support with trust depth
 *   - Stats: blocked requests, auto-blocked IPs, per-key violations
 *
 * CIDR parsing is done inline — no external libraries.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface IpAccessConfig {
  /** Enable IP access control. Default false (disabled until configured). */
  enabled: boolean;
  /** Global allow list. If non-empty, only these IPs/CIDRs are allowed. */
  allowList: string[];
  /** Global deny list. Checked before allow list. */
  denyList: string[];
  /** Auto-block IPs after this many denied requests in the window. 0 = disabled. Default 0. */
  autoBlockThreshold: number;
  /** Window in ms for auto-block counting. Default 300_000 (5 min). */
  autoBlockWindowMs: number;
  /** Duration in ms for auto-blocks. Default 3_600_000 (1 hour). */
  autoBlockDurationMs: number;
  /** Max trusted proxy depth for X-Forwarded-For. Default 1. */
  trustedProxyDepth: number;
  /** Max entries in per-key IP map. Default 10_000. */
  maxKeyEntries: number;
}

export interface IpCheckResult {
  allowed: boolean;
  reason?: string;
  rule?: string;
}

export interface AutoBlockEntry {
  ip: string;
  blockedAt: number;
  expiresAt: number;
  violations: number;
  reason: string;
}

export interface IpAccessStats {
  enabled: boolean;
  config: IpAccessConfig;
  globalAllowCount: number;
  globalDenyCount: number;
  perKeyBindings: number;
  autoBlockedIps: number;
  totalChecks: number;
  totalBlocked: number;
  totalAllowed: number;
}

interface ViolationTracker {
  count: number;
  firstSeen: number;
}

// ─── Default config ─────────────────────────────────────────────────────────

const DEFAULT_IP_ACCESS_CONFIG: IpAccessConfig = {
  enabled: false,
  allowList: [],
  denyList: [],
  autoBlockThreshold: 0,
  autoBlockWindowMs: 300_000,
  autoBlockDurationMs: 3_600_000,
  trustedProxyDepth: 1,
  maxKeyEntries: 10_000,
};

// ─── CIDR Helpers ───────────────────────────────────────────────────────────

/** Parse IPv4 address to 32-bit number. Returns null if invalid. */
function parseIpv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const n = parseInt(part, 10);
    if (isNaN(n) || n < 0 || n > 255 || String(n) !== part) return null;
    result = (result << 8) | n;
  }
  return result >>> 0; // unsigned
}

/** Parse IPv4 CIDR notation (e.g., "10.0.0.0/8"). */
function parseIpv4Cidr(cidr: string): { ip: number; mask: number } | null {
  const slash = cidr.indexOf('/');
  if (slash === -1) {
    // Single IP — treat as /32
    const ip = parseIpv4(cidr);
    if (ip === null) return null;
    return { ip, mask: 0xFFFFFFFF >>> 0 };
  }
  const ipStr = cidr.slice(0, slash);
  const prefix = parseInt(cidr.slice(slash + 1), 10);
  if (isNaN(prefix) || prefix < 0 || prefix > 32) return null;
  const ip = parseIpv4(ipStr);
  if (ip === null) return null;
  const mask = prefix === 0 ? 0 : ((0xFFFFFFFF << (32 - prefix)) >>> 0);
  return { ip, mask };
}

/** Check if an IPv4 address matches a CIDR range. */
function ipv4MatchesCidr(ip: number, cidr: { ip: number; mask: number }): boolean {
  return (ip & cidr.mask) === (cidr.ip & cidr.mask);
}

/** Normalize an IP address: strip IPv6-mapped IPv4 prefix, trim whitespace. */
function normalizeIp(ip: string): string {
  let cleaned = ip.trim();
  // IPv6-mapped IPv4: ::ffff:192.168.1.1 → 192.168.1.1
  if (cleaned.startsWith('::ffff:')) {
    cleaned = cleaned.slice(7);
  }
  return cleaned;
}

/** Check if an IP matches a pattern (single IP or CIDR). */
function ipMatchesPattern(ip: string, pattern: string): boolean {
  const normalizedIp = normalizeIp(ip);
  const normalizedPattern = normalizeIp(pattern);

  // Simple exact match
  if (normalizedIp === normalizedPattern) return true;

  // CIDR match (IPv4 only for now)
  const cidr = parseIpv4Cidr(normalizedPattern);
  if (cidr === null) return false;

  const ipNum = parseIpv4(normalizedIp);
  if (ipNum === null) return false;

  return ipv4MatchesCidr(ipNum, cidr);
}

// ─── IpAccessController Class ───────────────────────────────────────────────

export class IpAccessController {
  private config: IpAccessConfig;

  // Per-key IP bindings: apiKey → list of allowed IPs/CIDRs
  private keyBindings = new Map<string, string[]>();

  // Auto-blocked IPs
  private autoBlocked = new Map<string, AutoBlockEntry>();

  // Violation tracking for auto-block
  private violations = new Map<string, ViolationTracker>();

  // Stats
  private totalChecks = 0;
  private totalBlocked = 0;
  private totalAllowed = 0;

  constructor(config?: Partial<IpAccessConfig>) {
    this.config = { ...DEFAULT_IP_ACCESS_CONFIG, ...config };
  }

  /**
   * Check whether an IP is allowed access.
   * Optionally checks per-key bindings if apiKey is provided.
   */
  check(ip: string, apiKey?: string): IpCheckResult {
    this.totalChecks++;

    if (!this.config.enabled) {
      this.totalAllowed++;
      return { allowed: true };
    }

    const normalizedIp = normalizeIp(ip);

    // 1. Check auto-blocked
    const autoBlock = this.autoBlocked.get(normalizedIp);
    if (autoBlock) {
      if (Date.now() < autoBlock.expiresAt) {
        this.totalBlocked++;
        return { allowed: false, reason: 'auto-blocked', rule: `auto-block (${autoBlock.violations} violations)` };
      }
      // Expired — remove
      this.autoBlocked.delete(normalizedIp);
    }

    // 2. Check global deny list
    for (const pattern of this.config.denyList) {
      if (ipMatchesPattern(normalizedIp, pattern)) {
        this.totalBlocked++;
        this.trackViolation(normalizedIp, 'deny-list');
        return { allowed: false, reason: 'denied', rule: `deny:${pattern}` };
      }
    }

    // 3. Check global allow list (if non-empty, acts as whitelist)
    if (this.config.allowList.length > 0) {
      let globalAllowed = false;
      for (const pattern of this.config.allowList) {
        if (ipMatchesPattern(normalizedIp, pattern)) {
          globalAllowed = true;
          break;
        }
      }
      if (!globalAllowed) {
        this.totalBlocked++;
        this.trackViolation(normalizedIp, 'not-in-allow-list');
        return { allowed: false, reason: 'not-allowed', rule: 'global-allow-list' };
      }
    }

    // 4. Check per-key IP binding
    if (apiKey) {
      const keyIps = this.keyBindings.get(apiKey);
      if (keyIps && keyIps.length > 0) {
        let keyAllowed = false;
        for (const pattern of keyIps) {
          if (ipMatchesPattern(normalizedIp, pattern)) {
            keyAllowed = true;
            break;
          }
        }
        if (!keyAllowed) {
          this.totalBlocked++;
          this.trackViolation(normalizedIp, `key-binding:${apiKey.slice(0, 8)}`);
          return { allowed: false, reason: 'key-ip-mismatch', rule: `key:${apiKey.slice(0, 8)}...` };
        }
      }
    }

    this.totalAllowed++;
    return { allowed: true };
  }

  /**
   * Bind an API key to specific IP addresses/CIDRs.
   * Only requests from these IPs will be allowed for this key.
   */
  bindKey(apiKey: string, ips: string[]): void {
    if (this.keyBindings.size >= this.config.maxKeyEntries && !this.keyBindings.has(apiKey)) {
      throw new Error(`Max key bindings reached (${this.config.maxKeyEntries})`);
    }
    this.keyBindings.set(apiKey, ips.map(normalizeIp));
  }

  /**
   * Remove IP binding for a key.
   */
  unbindKey(apiKey: string): boolean {
    return this.keyBindings.delete(apiKey);
  }

  /**
   * Get IP binding for a key.
   */
  getKeyBinding(apiKey: string): string[] | undefined {
    return this.keyBindings.get(apiKey);
  }

  /**
   * Manually block an IP for a duration.
   */
  blockIp(ip: string, durationMs?: number, reason?: string): void {
    const normalizedIp = normalizeIp(ip);
    const duration = durationMs ?? this.config.autoBlockDurationMs;
    this.autoBlocked.set(normalizedIp, {
      ip: normalizedIp,
      blockedAt: Date.now(),
      expiresAt: Date.now() + duration,
      violations: 0,
      reason: reason ?? 'manual-block',
    });
  }

  /**
   * Unblock an IP.
   */
  unblockIp(ip: string): boolean {
    return this.autoBlocked.delete(normalizeIp(ip));
  }

  /**
   * Get all auto-blocked IPs.
   */
  getBlocked(): AutoBlockEntry[] {
    this.pruneExpiredBlocks();
    return Array.from(this.autoBlocked.values());
  }

  /**
   * Update configuration at runtime.
   */
  configure(updates: Partial<IpAccessConfig>): IpAccessConfig {
    if (updates.enabled !== undefined) this.config.enabled = updates.enabled;
    if (updates.allowList !== undefined) this.config.allowList = updates.allowList;
    if (updates.denyList !== undefined) this.config.denyList = updates.denyList;
    if (updates.autoBlockThreshold !== undefined) this.config.autoBlockThreshold = Math.max(0, updates.autoBlockThreshold);
    if (updates.autoBlockWindowMs !== undefined) this.config.autoBlockWindowMs = Math.max(1000, updates.autoBlockWindowMs);
    if (updates.autoBlockDurationMs !== undefined) this.config.autoBlockDurationMs = Math.max(1000, updates.autoBlockDurationMs);
    if (updates.trustedProxyDepth !== undefined) this.config.trustedProxyDepth = Math.max(0, Math.min(10, updates.trustedProxyDepth));
    if (updates.maxKeyEntries !== undefined) this.config.maxKeyEntries = Math.max(100, updates.maxKeyEntries);
    return { ...this.config };
  }

  /**
   * Extract client IP from request headers, respecting trusted proxy depth.
   */
  resolveClientIp(remoteAddress: string, headers: Record<string, string | string[] | undefined>): string {
    const xff = headers['x-forwarded-for'];
    if (xff) {
      const xffStr = Array.isArray(xff) ? xff[0] : xff;
      const ips = xffStr.split(',').map(s => s.trim()).filter(Boolean);
      if (ips.length > 0) {
        // Take the IP at position (length - trustedProxyDepth)
        const idx = Math.max(0, ips.length - this.config.trustedProxyDepth);
        return normalizeIp(ips[idx]);
      }
    }
    const realIp = headers['x-real-ip'];
    if (realIp) {
      const val = Array.isArray(realIp) ? realIp[0] : realIp;
      return normalizeIp(val);
    }
    return normalizeIp(remoteAddress || '127.0.0.1');
  }

  /**
   * Get statistics.
   */
  stats(): IpAccessStats {
    this.pruneExpiredBlocks();
    return {
      enabled: this.config.enabled,
      config: { ...this.config },
      globalAllowCount: this.config.allowList.length,
      globalDenyCount: this.config.denyList.length,
      perKeyBindings: this.keyBindings.size,
      autoBlockedIps: this.autoBlocked.size,
      totalChecks: this.totalChecks,
      totalBlocked: this.totalBlocked,
      totalAllowed: this.totalAllowed,
    };
  }

  /**
   * Clear all state (blocks, bindings, violations).
   */
  clear(): void {
    this.keyBindings.clear();
    this.autoBlocked.clear();
    this.violations.clear();
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private trackViolation(ip: string, reason: string): void {
    if (this.config.autoBlockThreshold <= 0) return;

    const now = Date.now();
    const tracker = this.violations.get(ip);
    if (tracker) {
      if (now - tracker.firstSeen > this.config.autoBlockWindowMs) {
        // Window expired, reset
        tracker.count = 1;
        tracker.firstSeen = now;
      } else {
        tracker.count++;
        if (tracker.count >= this.config.autoBlockThreshold) {
          // Auto-block
          this.autoBlocked.set(ip, {
            ip,
            blockedAt: now,
            expiresAt: now + this.config.autoBlockDurationMs,
            violations: tracker.count,
            reason: `auto-blocked after ${tracker.count} violations (${reason})`,
          });
          this.violations.delete(ip);
        }
      }
    } else {
      this.violations.set(ip, { count: 1, firstSeen: now });
    }

    // Evict old violation entries (simple cap)
    if (this.violations.size > 50_000) {
      const cutoff = now - this.config.autoBlockWindowMs;
      for (const [key, val] of this.violations) {
        if (val.firstSeen < cutoff) this.violations.delete(key);
      }
    }
  }

  private pruneExpiredBlocks(): void {
    const now = Date.now();
    for (const [ip, entry] of this.autoBlocked) {
      if (now >= entry.expiresAt) this.autoBlocked.delete(ip);
    }
  }
}
