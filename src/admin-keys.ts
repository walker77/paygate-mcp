/**
 * AdminKeyManager — Multiple admin keys with role-based permissions.
 *
 * Roles (hierarchical):
 *   - super_admin: Full access, including admin key management
 *   - admin: All API key and system operations, but cannot manage admin keys
 *   - viewer: Read-only access to status, usage, analytics, audit, etc.
 *
 * The bootstrap admin key (from constructor) is always a super_admin.
 * Supports file-based persistence (separate file from API key state).
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'fs';
import { dirname } from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

export type AdminRole = 'super_admin' | 'admin' | 'viewer';

export interface AdminKeyRecord {
  /** The admin API key (ak_ prefix, or legacy admin_ prefix for bootstrap) */
  key: string;
  /** Human-readable name */
  name: string;
  /** Permission level */
  role: AdminRole;
  /** ISO timestamp when the key was created */
  createdAt: string;
  /** Who created this key (masked key or 'bootstrap') */
  createdBy: string;
  /** Whether this key is active (can be revoked) */
  active: boolean;
  /** Last time this key was used for authentication (ISO timestamp) */
  lastUsedAt: string | null;
}

/** Role hierarchy for permission checks (higher = more permissions) */
export const ROLE_HIERARCHY: Record<AdminRole, number> = {
  super_admin: 3,
  admin: 2,
  viewer: 1,
};

/** Valid role names */
export const VALID_ROLES: AdminRole[] = ['super_admin', 'admin', 'viewer'];

// ─── AdminKeyManager ─────────────────────────────────────────────────────────

export class AdminKeyManager {
  private keys: Map<string, AdminKeyRecord> = new Map();
  private readonly filePath: string | null;

  constructor(filePath?: string) {
    this.filePath = filePath || null;
    if (this.filePath) this.load();
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  /** Load admin keys from file. */
  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      if (Array.isArray(data)) {
        for (const record of data) {
          if (record && record.key) {
            this.keys.set(record.key, record);
          }
        }
      }
    } catch { /* ignore corrupted file */ }
  }

  /** Save admin keys to file (atomic: write tmp, then rename). */
  save(): void {
    if (!this.filePath) return;
    const json = JSON.stringify(this.toJSON(), null, 2);
    const tmpPath = this.filePath + '.tmp';
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(tmpPath, json, 'utf-8');
      renameSync(tmpPath, this.filePath);
    } catch {
      // Best-effort persistence — don't crash the server
    }
  }

  // ─── Bootstrap ───────────────────────────────────────────────────────────

  /**
   * Bootstrap the manager with the initial admin key.
   * This is the key passed to PayGateServer constructor (or auto-generated).
   * It always gets super_admin role. Skips if the key is already known.
   */
  bootstrap(key: string): void {
    if (this.keys.has(key)) return;
    this.keys.set(key, {
      key,
      name: 'Bootstrap Admin',
      role: 'super_admin',
      createdAt: new Date().toISOString(),
      createdBy: 'bootstrap',
      active: true,
      lastUsedAt: null,
    });
    this.save();
  }

  /**
   * Rotate the bootstrap admin key without server restart.
   * Generates a new bootstrap key, revokes the old one, and persists.
   * Returns the new key, or null if oldKey is not the current bootstrap.
   */
  rotateBootstrap(oldKey: string): { newKey: string } | { error: string } {
    const oldRecord = this.keys.get(oldKey);
    if (!oldRecord) return { error: 'Admin key not found' };
    if (!oldRecord.active) return { error: 'Admin key is already revoked' };
    if (oldRecord.createdBy !== 'bootstrap') return { error: 'Key is not the bootstrap admin key' };

    // Generate new bootstrap key
    const newKey = `admin_${randomBytes(16).toString('hex')}`;
    const newRecord: AdminKeyRecord = {
      key: newKey,
      name: 'Bootstrap Admin',
      role: 'super_admin',
      createdAt: new Date().toISOString(),
      createdBy: 'bootstrap',
      active: true,
      lastUsedAt: null,
    };

    // Add new key first (so there's always at least one super_admin)
    this.keys.set(newKey, newRecord);
    // Revoke old key
    oldRecord.active = false;
    this.save();

    return { newKey };
  }

  // ─── Validation ──────────────────────────────────────────────────────────

  /**
   * Validate an admin key using constant-time comparison.
   * Returns the record if valid, null otherwise.
   * Updates lastUsedAt on successful validation.
   *
   * Uses timingSafeEqual to prevent timing attacks that could
   * enumerate valid admin key prefixes through response time analysis.
   */
  validate(key: string): AdminKeyRecord | null {
    if (!key) return null;

    const keyBuffer = Buffer.from(key, 'utf-8');
    let match: AdminKeyRecord | null = null;

    // Always iterate ALL keys to prevent timing leaks from early exit
    for (const [storedKey, record] of this.keys) {
      const storedBuffer = Buffer.from(storedKey, 'utf-8');
      // timingSafeEqual requires equal-length buffers; pad shorter one
      if (keyBuffer.length === storedBuffer.length) {
        if (timingSafeEqual(keyBuffer, storedBuffer) && record.active) {
          match = record;
        }
      } else {
        // Different lengths — still do a comparison to keep timing consistent
        const padded = Buffer.alloc(Math.max(keyBuffer.length, storedBuffer.length));
        const paddedKey = Buffer.alloc(padded.length);
        keyBuffer.copy(paddedKey);
        storedBuffer.copy(padded);
        timingSafeEqual(paddedKey, padded); // Result discarded — lengths differ, so never a match
      }
    }

    if (match) {
      match.lastUsedAt = new Date().toISOString();
    }
    return match;
  }

  /**
   * Check if a key has at least the minimum required role.
   */
  hasRole(key: string, minRole: AdminRole): boolean {
    const record = this.validate(key);
    if (!record) return false;
    return ROLE_HIERARCHY[record.role] >= ROLE_HIERARCHY[minRole];
  }

  // ─── CRUD ────────────────────────────────────────────────────────────────

  /**
   * Create a new admin key with ak_ prefix.
   */
  create(name: string, role: AdminRole, createdBy: string): AdminKeyRecord {
    const key = `ak_${randomBytes(16).toString('hex')}`;
    const record: AdminKeyRecord = {
      key,
      name,
      role,
      createdAt: new Date().toISOString(),
      createdBy,
      active: true,
      lastUsedAt: null,
    };
    this.keys.set(key, record);
    this.save();
    return record;
  }

  /**
   * Revoke an admin key.
   * Cannot revoke the last active super_admin key (safety check).
   */
  revoke(key: string): { success: boolean; error?: string } {
    const record = this.keys.get(key);
    if (!record) return { success: false, error: 'Admin key not found' };
    if (!record.active) return { success: false, error: 'Admin key already revoked' };

    // Prevent revoking the last super_admin
    if (record.role === 'super_admin') {
      const activeSuperAdmins = Array.from(this.keys.values())
        .filter(k => k.active && k.role === 'super_admin');
      if (activeSuperAdmins.length <= 1) {
        return { success: false, error: 'Cannot revoke the last super_admin key' };
      }
    }

    record.active = false;
    this.save();
    return { success: true };
  }

  // ─── Query ───────────────────────────────────────────────────────────────

  /**
   * List all admin keys.
   */
  list(): AdminKeyRecord[] {
    return Array.from(this.keys.values());
  }

  /**
   * Get a specific admin key record.
   */
  get(key: string): AdminKeyRecord | undefined {
    return this.keys.get(key);
  }

  /**
   * Number of active admin keys.
   */
  get activeCount(): number {
    return Array.from(this.keys.values()).filter(k => k.active).length;
  }

  // ─── Serialization ──────────────────────────────────────────────────────

  /**
   * Export state for persistence.
   */
  toJSON(): AdminKeyRecord[] {
    return Array.from(this.keys.values());
  }

  /**
   * Import state from array. Clears existing keys.
   */
  fromJSON(records: AdminKeyRecord[]): void {
    this.keys.clear();
    for (const record of records) {
      this.keys.set(record.key, record);
    }
  }
}
