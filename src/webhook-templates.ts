/**
 * WebhookTemplateEngine — Customizable webhook payload templates.
 *
 * Define templates with variable interpolation, conditional sections,
 * and format conversion (JSON, form-encoded, plain text).
 *
 * @example
 * ```ts
 * const engine = new WebhookTemplateEngine();
 *
 * engine.upsertTemplate({
 *   id: 'slack-alert',
 *   name: 'Slack Alert',
 *   format: 'json',
 *   body: '{"text":"Alert: {{event}} on key {{key}} — {{message}}"}',
 *   headers: { 'Content-Type': 'application/json' },
 *   active: true,
 * });
 *
 * const rendered = engine.render('slack-alert', {
 *   event: 'rate_limit_exceeded',
 *   key: 'key_abc',
 *   message: 'Rate limit hit at 100 calls/min',
 * });
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────

export type TemplateFormat = 'json' | 'text' | 'form';

export interface WebhookTemplate {
  id: string;
  name: string;
  format: TemplateFormat;
  body: string;
  headers: Record<string, string>;
  active: boolean;
  description?: string;
  requiredVars?: string[];
  defaultVars?: Record<string, string>;
}

export interface TemplateCreateParams {
  id: string;
  name: string;
  format: TemplateFormat;
  body: string;
  headers?: Record<string, string>;
  active?: boolean;
  description?: string;
  requiredVars?: string[];
  defaultVars?: Record<string, string>;
}

export interface RenderResult {
  templateId: string;
  body: string;
  headers: Record<string, string>;
  format: TemplateFormat;
  varsUsed: string[];
  missingVars: string[];
}

export interface TemplateValidation {
  valid: boolean;
  errors: string[];
  extractedVars: string[];
}

export interface WebhookTemplateConfig {
  maxTemplates?: number;
  maxBodySize?: number;
}

export interface WebhookTemplateStats {
  totalTemplates: number;
  activeTemplates: number;
  totalRenders: number;
  rendersByTemplate: Record<string, number>;
  totalErrors: number;
}

// ── Implementation ───────────────────────────────────────────────────

const VAR_PATTERN = /\{\{(\w[\w.]*)\}\}/g;
const CONDITIONAL_PATTERN = /\{\{#if\s+(\w[\w.]*)\}\}([\s\S]*?)\{\{\/if\}\}/g;

export class WebhookTemplateEngine {
  private templates = new Map<string, WebhookTemplate>();
  private maxTemplates: number;
  private maxBodySize: number;

  // Stats
  private totalRenders = 0;
  private rendersByTemplate = new Map<string, number>();
  private totalErrors = 0;

  constructor(config: WebhookTemplateConfig = {}) {
    this.maxTemplates = config.maxTemplates ?? 200;
    this.maxBodySize = config.maxBodySize ?? 64_000;
  }

  // ── Template CRUD ──────────────────────────────────────────────────

  /** Create or update a template. */
  upsertTemplate(params: TemplateCreateParams): boolean {
    if (!params.id || !params.name || !params.body) return false;
    if (params.body.length > this.maxBodySize) return false;

    if (!this.templates.has(params.id) && this.templates.size >= this.maxTemplates) {
      return false;
    }

    const template: WebhookTemplate = {
      id: params.id,
      name: params.name,
      format: params.format,
      body: params.body,
      headers: params.headers ?? {},
      active: params.active ?? true,
      description: params.description,
      requiredVars: params.requiredVars,
      defaultVars: params.defaultVars,
    };
    this.templates.set(params.id, template);
    return true;
  }

  /** Get a template by ID. */
  getTemplate(id: string): WebhookTemplate | null {
    return this.templates.get(id) ?? null;
  }

  /** List all templates. */
  getTemplates(): WebhookTemplate[] {
    return [...this.templates.values()];
  }

  /** Remove a template. */
  removeTemplate(id: string): boolean {
    return this.templates.delete(id);
  }

  // ── Rendering ──────────────────────────────────────────────────────

  /** Render a template with variables. */
  render(templateId: string, vars: Record<string, string> = {}): RenderResult | null {
    const template = this.templates.get(templateId);
    if (!template) {
      this.totalErrors++;
      return null;
    }

    if (!template.active) {
      this.totalErrors++;
      return null;
    }

    // Merge defaults
    const merged = { ...template.defaultVars, ...vars };

    // Track used and missing vars
    const varsUsed: string[] = [];
    const missingVars: string[] = [];

    // Process conditionals first
    let body = template.body.replace(CONDITIONAL_PATTERN, (_, varName: string, content: string) => {
      const val = this.resolveVar(varName, merged);
      if (val !== undefined && val !== '' && val !== 'false') {
        varsUsed.push(varName);
        return content;
      }
      return '';
    });

    // Interpolate variables
    body = body.replace(VAR_PATTERN, (_, varName: string) => {
      const val = this.resolveVar(varName, merged);
      if (val !== undefined) {
        if (!varsUsed.includes(varName)) varsUsed.push(varName);
        return this.escapeForFormat(val, template.format);
      }
      if (!missingVars.includes(varName)) missingVars.push(varName);
      return '';
    });

    // Interpolate headers too
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(template.headers)) {
      headers[k] = v.replace(VAR_PATTERN, (_, varName: string) => {
        const val = this.resolveVar(varName, merged);
        return val ?? '';
      });
    }

    // Check required vars
    if (template.requiredVars) {
      for (const rv of template.requiredVars) {
        if (!merged[rv] && !missingVars.includes(rv)) {
          missingVars.push(rv);
        }
      }
    }

    this.totalRenders++;
    const count = this.rendersByTemplate.get(templateId) ?? 0;
    this.rendersByTemplate.set(templateId, count + 1);

    return {
      templateId,
      body,
      headers,
      format: template.format,
      varsUsed,
      missingVars,
    };
  }

  /** Render a template body string directly without storing it. */
  renderInline(body: string, vars: Record<string, string> = {}, format: TemplateFormat = 'text'): string {
    // Process conditionals
    let result = body.replace(CONDITIONAL_PATTERN, (_, varName: string, content: string) => {
      const val = this.resolveVar(varName, vars);
      return (val !== undefined && val !== '' && val !== 'false') ? content : '';
    });

    // Interpolate
    result = result.replace(VAR_PATTERN, (_, varName: string) => {
      const val = this.resolveVar(varName, vars);
      return val !== undefined ? this.escapeForFormat(val, format) : '';
    });

    return result;
  }

  // ── Validation ─────────────────────────────────────────────────────

  /** Validate a template body and extract variables. */
  validateTemplate(body: string, format: TemplateFormat): TemplateValidation {
    const errors: string[] = [];
    const extractedVars: string[] = [];

    // Extract variables
    let match: RegExpExecArray | null;
    const varRegex = new RegExp(VAR_PATTERN.source, 'g');
    while ((match = varRegex.exec(body)) !== null) {
      if (!extractedVars.includes(match[1])) {
        extractedVars.push(match[1]);
      }
    }

    // Check conditionals are balanced
    const opens = (body.match(/\{\{#if\s+\w[\w.]*\}\}/g) || []).length;
    const closes = (body.match(/\{\{\/if\}\}/g) || []).length;
    if (opens !== closes) {
      errors.push(`Unbalanced conditionals: ${opens} opens, ${closes} closes`);
    }

    // Validate JSON format
    if (format === 'json') {
      // Try replacing all vars with dummy values
      const testBody = body
        .replace(CONDITIONAL_PATTERN, '')
        .replace(VAR_PATTERN, '"test"');
      try {
        JSON.parse(testBody);
      } catch {
        errors.push('Template body is not valid JSON after variable substitution');
      }
    }

    if (body.length > this.maxBodySize) {
      errors.push(`Body exceeds max size (${this.maxBodySize})`);
    }

    return {
      valid: errors.length === 0,
      errors,
      extractedVars,
    };
  }

  /** Extract all variable names from a template body. */
  extractVars(body: string): string[] {
    const vars: string[] = [];
    let match: RegExpExecArray | null;
    const regex = new RegExp(VAR_PATTERN.source, 'g');
    while ((match = regex.exec(body)) !== null) {
      if (!vars.includes(match[1])) vars.push(match[1]);
    }
    // Also extract from conditionals
    const condRegex = new RegExp(/\{\{#if\s+(\w[\w.]*)\}\}/.source, 'g');
    while ((match = condRegex.exec(body)) !== null) {
      if (!vars.includes(match[1])) vars.push(match[1]);
    }
    return vars;
  }

  // ── Stats ──────────────────────────────────────────────────────────

  getStats(): WebhookTemplateStats {
    const rendersByTemplate: Record<string, number> = {};
    for (const [k, v] of this.rendersByTemplate) {
      rendersByTemplate[k] = v;
    }
    return {
      totalTemplates: this.templates.size,
      activeTemplates: [...this.templates.values()].filter(t => t.active).length,
      totalRenders: this.totalRenders,
      rendersByTemplate,
      totalErrors: this.totalErrors,
    };
  }

  /** Clear all templates and stats. */
  destroy(): void {
    this.templates.clear();
    this.totalRenders = 0;
    this.rendersByTemplate.clear();
    this.totalErrors = 0;
  }

  // ── Private ─────────────────────────────────────────────────────────

  private resolveVar(name: string, vars: Record<string, string>): string | undefined {
    // Support dot notation: "user.name" -> vars['user.name'] or nested
    if (name in vars) return vars[name];

    // Try nested object resolution
    const parts = name.split('.');
    let current: any = vars;
    for (const part of parts) {
      if (current === undefined || current === null) return undefined;
      current = current[part];
    }
    return current !== undefined ? String(current) : undefined;
  }

  private escapeForFormat(value: string, format: TemplateFormat): string {
    switch (format) {
      case 'json':
        // Escape for JSON string context
        return value
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
          .replace(/\t/g, '\\t');
      case 'form':
        return encodeURIComponent(value);
      case 'text':
      default:
        return value;
    }
  }
}
