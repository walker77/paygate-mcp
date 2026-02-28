/**
 * TenantManager — Multi-tenant data isolation for PayGate.
 *
 * Provides full tenant isolation for companies running PayGate as a
 * platform serving multiple customers. Each tenant gets isolated
 * rate limits, credit pools, usage quotas, and data boundaries.
 *
 * Features:
 *   - Tenant CRUD with metadata
 *   - API key → tenant binding (keys belong to exactly one tenant)
 *   - Per-tenant rate limits (override global limits)
 *   - Per-tenant credit pools (isolated balances)
 *   - Per-tenant usage tracking and reporting
 *   - Tenant suspension/activation
 *   - Cross-tenant queries for platform operators
 *   - Stats: per-tenant and aggregate
 *
 * Zero external dependencies.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TenantConfig {
  /** Enable tenant isolation. Default false. */
  enabled: boolean;
  /** Max tenants. Default 10_000. */
  maxTenants: number;
  /** Max keys per tenant. Default 1_000. */
  maxKeysPerTenant: number;
  /** Default rate limit per tenant (calls/min). 0 = use global. Default 0. */
  defaultRateLimitPerMin: number;
  /** Default credit allocation for new tenants. Default 0. */
  defaultCredits: number;
}

export interface TenantRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  status: 'active' | 'suspended';
  metadata: Record<string, string>;
  /** Per-tenant rate limit override. 0 = use global. */
  rateLimitPerMin: number;
  /** Per-tenant credit pool. */
  credits: number;
  /** Total credits ever allocated. */
  totalCreditsAllocated: number;
  /** Total credits consumed. */
  totalCreditsConsumed: number;
  /** Total API calls made. */
  totalCalls: number;
  /** Keys belonging to this tenant. */
  keyCount: number;
}

export interface TenantUsageReport {
  tenantId: string;
  tenantName: string;
  status: string;
  credits: number;
  totalCalls: number;
  totalCreditsConsumed: number;
  keyCount: number;
  keys: string[];
}

export interface TenantStats {
  enabled: boolean;
  config: TenantConfig;
  totalTenants: number;
  activeTenants: number;
  suspendedTenants: number;
  totalKeys: number;
  totalCredits: number;
  totalCalls: number;
}

export interface TenantCreateParams {
  id?: string;
  name: string;
  metadata?: Record<string, string>;
  rateLimitPerMin?: number;
  credits?: number;
}

// ─── Default config ─────────────────────────────────────────────────────────

const DEFAULT_TENANT_CONFIG: TenantConfig = {
  enabled: false,
  maxTenants: 10_000,
  maxKeysPerTenant: 1_000,
  defaultRateLimitPerMin: 0,
  defaultCredits: 0,
};

// ─── ID generation ──────────────────────────────────────────────────────────

import * as crypto from 'crypto';

function generateTenantId(): string {
  return 'tnt_' + crypto.randomBytes(12).toString('hex');
}

// ─── TenantManager Class ────────────────────────────────────────────────────

export class TenantManager {
  private config: TenantConfig;

  // Tenants
  private tenants = new Map<string, TenantRecord>();

  // Key → Tenant mapping
  private keyToTenant = new Map<string, string>();

  // Tenant → Keys mapping
  private tenantKeys = new Map<string, Set<string>>();

  constructor(config?: Partial<TenantConfig>) {
    this.config = { ...DEFAULT_TENANT_CONFIG, ...config };
  }

  /**
   * Create a new tenant.
   */
  create(params: TenantCreateParams): TenantRecord {
    if (!this.config.enabled) {
      throw new Error('Tenant isolation is not enabled');
    }

    if (this.tenants.size >= this.config.maxTenants) {
      throw new Error(`Max tenants reached (${this.config.maxTenants})`);
    }

    const id = params.id ?? generateTenantId();
    if (this.tenants.has(id)) {
      throw new Error(`Tenant already exists: ${id}`);
    }

    // Validate name
    if (!params.name || params.name.length > 256) {
      throw new Error('Tenant name required (max 256 chars)');
    }

    const now = Date.now();
    const tenant: TenantRecord = {
      id,
      name: params.name,
      createdAt: now,
      updatedAt: now,
      status: 'active',
      metadata: params.metadata ?? {},
      rateLimitPerMin: params.rateLimitPerMin ?? this.config.defaultRateLimitPerMin,
      credits: params.credits ?? this.config.defaultCredits,
      totalCreditsAllocated: params.credits ?? this.config.defaultCredits,
      totalCreditsConsumed: 0,
      totalCalls: 0,
      keyCount: 0,
    };

    this.tenants.set(id, tenant);
    this.tenantKeys.set(id, new Set());
    return { ...tenant };
  }

  /**
   * Get a tenant by ID.
   */
  get(tenantId: string): TenantRecord | undefined {
    const t = this.tenants.get(tenantId);
    return t ? { ...t } : undefined;
  }

  /**
   * List all tenants.
   */
  list(status?: 'active' | 'suspended'): TenantRecord[] {
    const result: TenantRecord[] = [];
    for (const t of this.tenants.values()) {
      if (status && t.status !== status) continue;
      result.push({ ...t });
    }
    return result;
  }

  /**
   * Update a tenant.
   */
  update(tenantId: string, updates: Partial<Pick<TenantRecord, 'name' | 'metadata' | 'rateLimitPerMin'>>): TenantRecord | null {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return null;

    if (updates.name !== undefined) tenant.name = updates.name;
    if (updates.metadata !== undefined) tenant.metadata = updates.metadata;
    if (updates.rateLimitPerMin !== undefined) tenant.rateLimitPerMin = Math.max(0, updates.rateLimitPerMin);
    tenant.updatedAt = Date.now();

    return { ...tenant };
  }

  /**
   * Suspend a tenant. All keys under this tenant will be denied.
   */
  suspend(tenantId: string): boolean {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return false;
    tenant.status = 'suspended';
    tenant.updatedAt = Date.now();
    return true;
  }

  /**
   * Activate a suspended tenant.
   */
  activate(tenantId: string): boolean {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return false;
    tenant.status = 'active';
    tenant.updatedAt = Date.now();
    return true;
  }

  /**
   * Delete a tenant. Removes all key bindings.
   */
  delete(tenantId: string): boolean {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return false;

    // Remove all key bindings
    const keys = this.tenantKeys.get(tenantId);
    if (keys) {
      for (const key of keys) {
        this.keyToTenant.delete(key);
      }
    }
    this.tenantKeys.delete(tenantId);
    this.tenants.delete(tenantId);
    return true;
  }

  /**
   * Bind an API key to a tenant.
   */
  bindKey(tenantId: string, apiKey: string): boolean {
    if (!this.config.enabled) return false;

    const tenant = this.tenants.get(tenantId);
    if (!tenant) return false;

    // Check if key is already bound to another tenant
    const existingTenant = this.keyToTenant.get(apiKey);
    if (existingTenant && existingTenant !== tenantId) {
      throw new Error(`Key already bound to tenant: ${existingTenant}`);
    }

    const keys = this.tenantKeys.get(tenantId);
    if (!keys) return false;

    if (keys.size >= this.config.maxKeysPerTenant) {
      throw new Error(`Max keys per tenant reached (${this.config.maxKeysPerTenant})`);
    }

    keys.add(apiKey);
    this.keyToTenant.set(apiKey, tenantId);
    tenant.keyCount = keys.size;
    return true;
  }

  /**
   * Unbind an API key from its tenant.
   */
  unbindKey(apiKey: string): boolean {
    const tenantId = this.keyToTenant.get(apiKey);
    if (!tenantId) return false;

    this.keyToTenant.delete(apiKey);
    const keys = this.tenantKeys.get(tenantId);
    if (keys) {
      keys.delete(apiKey);
      const tenant = this.tenants.get(tenantId);
      if (tenant) tenant.keyCount = keys.size;
    }
    return true;
  }

  /**
   * Get the tenant for an API key.
   */
  getTenantForKey(apiKey: string): TenantRecord | undefined {
    const tenantId = this.keyToTenant.get(apiKey);
    if (!tenantId) return undefined;
    return this.get(tenantId);
  }

  /**
   * Check if a key's tenant is active. Returns the tenant or null if blocked.
   */
  checkAccess(apiKey: string): { allowed: boolean; tenant?: TenantRecord; reason?: string } {
    if (!this.config.enabled) {
      return { allowed: true };
    }

    const tenantId = this.keyToTenant.get(apiKey);
    if (!tenantId) {
      // Key not bound to any tenant — allow (tenant isolation is opt-in per key)
      return { allowed: true };
    }

    const tenant = this.tenants.get(tenantId);
    if (!tenant) {
      return { allowed: false, reason: 'tenant-not-found' };
    }

    if (tenant.status === 'suspended') {
      return { allowed: false, tenant: { ...tenant }, reason: 'tenant-suspended' };
    }

    return { allowed: true, tenant: { ...tenant } };
  }

  /**
   * Add credits to a tenant's pool.
   */
  addCredits(tenantId: string, amount: number): number | null {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return null;

    tenant.credits += amount;
    tenant.totalCreditsAllocated += amount;
    tenant.updatedAt = Date.now();
    return tenant.credits;
  }

  /**
   * Consume credits from a tenant's pool.
   * Returns remaining credits or null if insufficient.
   */
  consumeCredits(tenantId: string, amount: number): number | null {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return null;

    if (tenant.credits < amount) return null;

    tenant.credits -= amount;
    tenant.totalCreditsConsumed += amount;
    tenant.totalCalls++;
    tenant.updatedAt = Date.now();
    return tenant.credits;
  }

  /**
   * Record a call for a tenant (without consuming credits from tenant pool).
   * Use this when credits are managed at the key level, not tenant level.
   */
  recordCall(apiKey: string): void {
    const tenantId = this.keyToTenant.get(apiKey);
    if (!tenantId) return;
    const tenant = this.tenants.get(tenantId);
    if (tenant) {
      tenant.totalCalls++;
      tenant.updatedAt = Date.now();
    }
  }

  /**
   * Get usage report for a tenant.
   */
  getUsageReport(tenantId: string): TenantUsageReport | null {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return null;

    const keys = this.tenantKeys.get(tenantId);
    return {
      tenantId: tenant.id,
      tenantName: tenant.name,
      status: tenant.status,
      credits: tenant.credits,
      totalCalls: tenant.totalCalls,
      totalCreditsConsumed: tenant.totalCreditsConsumed,
      keyCount: tenant.keyCount,
      keys: keys ? Array.from(keys).map(k => k.slice(0, 8) + '...') : [],
    };
  }

  /**
   * Get rate limit for a key's tenant. Returns 0 if no tenant override.
   */
  getRateLimit(apiKey: string): number {
    const tenantId = this.keyToTenant.get(apiKey);
    if (!tenantId) return 0;
    const tenant = this.tenants.get(tenantId);
    return tenant?.rateLimitPerMin ?? 0;
  }

  /**
   * Update configuration at runtime.
   */
  configure(updates: Partial<TenantConfig>): TenantConfig {
    if (updates.enabled !== undefined) this.config.enabled = updates.enabled;
    if (updates.maxTenants !== undefined) this.config.maxTenants = Math.max(1, updates.maxTenants);
    if (updates.maxKeysPerTenant !== undefined) this.config.maxKeysPerTenant = Math.max(1, updates.maxKeysPerTenant);
    if (updates.defaultRateLimitPerMin !== undefined) this.config.defaultRateLimitPerMin = Math.max(0, updates.defaultRateLimitPerMin);
    if (updates.defaultCredits !== undefined) this.config.defaultCredits = Math.max(0, updates.defaultCredits);
    return { ...this.config };
  }

  /**
   * Get aggregate statistics.
   */
  stats(): TenantStats {
    let activeTenants = 0;
    let suspendedTenants = 0;
    let totalCredits = 0;
    let totalCalls = 0;

    for (const tenant of this.tenants.values()) {
      if (tenant.status === 'active') activeTenants++;
      else suspendedTenants++;
      totalCredits += tenant.credits;
      totalCalls += tenant.totalCalls;
    }

    return {
      enabled: this.config.enabled,
      config: { ...this.config },
      totalTenants: this.tenants.size,
      activeTenants,
      suspendedTenants,
      totalKeys: this.keyToTenant.size,
      totalCredits,
      totalCalls,
    };
  }

  /**
   * Clear all state.
   */
  clear(): void {
    this.tenants.clear();
    this.keyToTenant.clear();
    this.tenantKeys.clear();
  }
}
