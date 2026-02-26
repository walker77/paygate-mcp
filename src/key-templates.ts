/**
 * KeyTemplateManager — Named templates for API key creation.
 *
 * Templates define reusable presets for key creation (credits, ACL, quotas, etc.).
 * Instead of passing all options every time, use `template: "free-tier"` in POST /keys.
 *
 * Features:
 *   - CRUD: create, update, list, get, delete templates
 *   - File persistence (-templates.json alongside state file)
 *   - Templates define: credits, allowedTools, deniedTools, quota, ipAllowlist,
 *     spendingLimit, tags, namespace, expiryTtlSeconds, autoTopup
 *   - Max 100 templates
 */

import { writeFileSync, readFileSync, mkdirSync, renameSync, existsSync } from 'fs';
import { dirname } from 'path';
import { QuotaConfig } from './types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface KeyTemplate {
  /** Unique template name (alphanumeric, hyphens, underscores, 1-50 chars) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Initial credits for keys created from this template */
  credits: number;
  /** Whitelist: only these tools are accessible. Empty = all tools allowed. */
  allowedTools: string[];
  /** Blacklist: these tools are always denied. */
  deniedTools: string[];
  /** Per-key quota overrides. Undefined = use global defaults. */
  quota?: QuotaConfig;
  /** IP allowlist. Empty = all IPs allowed. */
  ipAllowlist: string[];
  /** Max total credits this key can spend. 0 = unlimited. */
  spendingLimit: number;
  /** Arbitrary key-value metadata tags. */
  tags: Record<string, string>;
  /** Namespace for multi-tenant isolation. */
  namespace: string;
  /** TTL in seconds from creation. 0 = never expires. */
  expiryTtlSeconds: number;
  /** Auto-topup configuration. Undefined = disabled. */
  autoTopup?: {
    threshold: number;
    amount: number;
    maxDaily: number;
  };
  /** ISO timestamp when template was created */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
}

// ─── Manager Class ────────────────────────────────────────────────────────────

const MAX_TEMPLATES = 100;

export class KeyTemplateManager {
  private templates = new Map<string, KeyTemplate>();
  private readonly filePath: string | null;

  constructor(filePath?: string) {
    this.filePath = filePath || null;
    if (this.filePath) {
      this.loadFromFile();
    }
  }

  /**
   * Create or update a template.
   */
  set(name: string, data: Partial<Omit<KeyTemplate, 'name' | 'createdAt' | 'updatedAt'>>): { success: boolean; error?: string; template?: KeyTemplate } {
    // Validate name
    const sanitized = name.trim().slice(0, 50);
    if (!/^[a-zA-Z0-9_-]+$/.test(sanitized)) {
      return { success: false, error: 'Template name must contain only letters, numbers, hyphens, and underscores' };
    }

    const existing = this.templates.get(sanitized);
    const now = new Date().toISOString();

    const template: KeyTemplate = {
      name: sanitized,
      description: String(data.description || existing?.description || '').slice(0, 500),
      credits: Math.max(0, Math.floor(Number(data.credits ?? existing?.credits ?? 100))),
      allowedTools: Array.isArray(data.allowedTools) ? data.allowedTools.filter(t => typeof t === 'string').slice(0, 100) : (existing?.allowedTools || []),
      deniedTools: Array.isArray(data.deniedTools) ? data.deniedTools.filter(t => typeof t === 'string').slice(0, 100) : (existing?.deniedTools || []),
      quota: data.quota !== undefined ? data.quota : existing?.quota,
      ipAllowlist: Array.isArray(data.ipAllowlist) ? data.ipAllowlist.filter(t => typeof t === 'string').slice(0, 100) : (existing?.ipAllowlist || []),
      spendingLimit: Math.max(0, Number(data.spendingLimit ?? existing?.spendingLimit ?? 0)),
      tags: typeof data.tags === 'object' && data.tags !== null ? data.tags : (existing?.tags || {}),
      namespace: String(data.namespace || existing?.namespace || 'default').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 50) || 'default',
      expiryTtlSeconds: Math.max(0, Math.floor(Number(data.expiryTtlSeconds ?? existing?.expiryTtlSeconds ?? 0))),
      autoTopup: data.autoTopup !== undefined ? data.autoTopup : existing?.autoTopup,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    // Check limit (only for new templates)
    if (!existing && this.templates.size >= MAX_TEMPLATES) {
      return { success: false, error: `Maximum ${MAX_TEMPLATES} templates reached` };
    }

    this.templates.set(sanitized, template);
    this.saveToFile();
    return { success: true, template };
  }

  /**
   * Get a template by name.
   */
  get(name: string): KeyTemplate | null {
    return this.templates.get(name) || null;
  }

  /**
   * Delete a template.
   */
  delete(name: string): boolean {
    const existed = this.templates.delete(name);
    if (existed) this.saveToFile();
    return existed;
  }

  /**
   * List all templates.
   */
  list(): KeyTemplate[] {
    return Array.from(this.templates.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get template count.
   */
  get count(): number {
    return this.templates.size;
  }

  // ─── File Persistence ──────────────────────────────────────────────────────

  private saveToFile(): void {
    if (!this.filePath) return;
    const data = Array.from(this.templates.entries());
    const json = JSON.stringify(data, null, 2);
    const tmpPath = this.filePath + '.tmp';
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(tmpPath, json, 'utf-8');
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error(`[paygate] Failed to save templates: ${(err as Error).message}`);
    }
  }

  private loadFromFile(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const json = readFileSync(this.filePath, 'utf-8');
      const data: Array<[string, KeyTemplate]> = JSON.parse(json);
      if (!Array.isArray(data)) return;
      for (const [name, template] of data) {
        if (name && template && typeof template.name === 'string') {
          this.templates.set(name, template);
        }
      }
      console.log(`[paygate] Loaded ${this.templates.size} template(s) from ${this.filePath}`);
    } catch (err) {
      console.error(`[paygate] Failed to load templates: ${(err as Error).message}`);
    }
  }
}
