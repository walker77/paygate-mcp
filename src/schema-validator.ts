/**
 * ToolSchemaValidator — Per-tool JSON Schema validation for tool call arguments.
 *
 * Validates `tools/call` argument payloads against registered JSON Schemas
 * before they reach the downstream MCP server. Rejects invalid payloads with
 * error code -32602 (Invalid params).
 *
 * Implements a zero-dependency JSON Schema subset validator supporting:
 * type, required, properties, enum, minLength, maxLength, minimum, maximum,
 * pattern, minItems, maxItems, items (single schema).
 *
 * Zero external dependencies.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ToolSchema {
  /** Tool name this schema validates. */
  toolName: string;
  /** JSON Schema (draft-04 subset). */
  schema: SchemaNode;
  /** When this schema was registered. */
  createdAt: string;
  /** When this schema was last updated. */
  updatedAt: string;
}

export interface SchemaNode {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  items?: SchemaNode;
  minItems?: number;
  maxItems?: number;
  description?: string;
  default?: unknown;
}

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface SchemaStats {
  totalSchemas: number;
  schemas: Array<{ toolName: string; createdAt: string; updatedAt: string }>;
  totalValidations: number;
  totalFailures: number;
}

// ─── Schema Validator Class ─────────────────────────────────────────────────

export class ToolSchemaValidator {
  private readonly schemas = new Map<string, ToolSchema>();
  private totalValidations = 0;
  private totalFailures = 0;
  private readonly maxSchemas = 500;

  /**
   * Register or update a JSON Schema for a tool.
   */
  registerSchema(toolName: string, schema: SchemaNode): ToolSchema {
    if (!toolName || !toolName.match(/^[a-zA-Z0-9_:.-]+$/)) {
      throw new Error(`Invalid tool name: "${toolName}"`);
    }
    if (!schema || typeof schema !== 'object') {
      throw new Error('Schema must be a non-null object');
    }
    if (this.schemas.size >= this.maxSchemas && !this.schemas.has(toolName)) {
      throw new Error(`Maximum ${this.maxSchemas} schemas reached`);
    }

    const now = new Date().toISOString();
    const existing = this.schemas.get(toolName);
    const entry: ToolSchema = {
      toolName,
      schema,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    this.schemas.set(toolName, entry);
    return entry;
  }

  /**
   * Remove a schema for a tool.
   */
  removeSchema(toolName: string): boolean {
    return this.schemas.delete(toolName);
  }

  /**
   * Get schema for a tool.
   */
  getSchema(toolName: string): ToolSchema | null {
    return this.schemas.get(toolName) || null;
  }

  /**
   * Validate tool call arguments against registered schema.
   * Returns { valid: true } if no schema registered or valid.
   */
  validate(toolName: string, args: unknown): ValidationResult {
    const entry = this.schemas.get(toolName);
    if (!entry) return { valid: true, errors: [] };

    this.totalValidations++;
    const errors: ValidationError[] = [];
    this.validateNode(entry.schema, args, '', errors);

    if (errors.length > 0) {
      this.totalFailures++;
    }

    return { valid: errors.length === 0, errors: errors.slice(0, 20) };
  }

  private validateNode(schema: SchemaNode, value: unknown, path: string, errors: ValidationError[]): void {
    // Type check
    if (schema.type) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      const actualType = this.getJsonType(value);
      if (!types.includes(actualType)) {
        errors.push({ path: path || '/', message: `Expected type ${types.join('|')}, got ${actualType}` });
        return; // Skip further checks if type is wrong
      }
    }

    // Enum check
    if (schema.enum) {
      if (!schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value))) {
        errors.push({ path: path || '/', message: `Value not in enum: [${schema.enum.map(e => JSON.stringify(e)).join(', ')}]` });
      }
    }

    // String checks
    if (typeof value === 'string') {
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push({ path: path || '/', message: `String too short: ${value.length} < ${schema.minLength}` });
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push({ path: path || '/', message: `String too long: ${value.length} > ${schema.maxLength}` });
      }
      if (schema.pattern) {
        try {
          const re = new RegExp(schema.pattern);
          if (!re.test(value)) {
            errors.push({ path: path || '/', message: `String does not match pattern: ${schema.pattern}` });
          }
        } catch {
          errors.push({ path: path || '/', message: `Invalid regex pattern: ${schema.pattern}` });
        }
      }
    }

    // Number checks
    if (typeof value === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push({ path: path || '/', message: `Number too small: ${value} < ${schema.minimum}` });
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push({ path: path || '/', message: `Number too large: ${value} > ${schema.maximum}` });
      }
    }

    // Array checks
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push({ path: path || '/', message: `Array too short: ${value.length} < ${schema.minItems}` });
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push({ path: path || '/', message: `Array too long: ${value.length} > ${schema.maxItems}` });
      }
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          this.validateNode(schema.items, value[i], `${path}[${i}]`, errors);
        }
      }
    }

    // Object checks
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;

      // Required fields
      if (schema.required) {
        for (const req of schema.required) {
          if (!(req in obj)) {
            errors.push({ path: `${path}.${req}`, message: `Missing required property: "${req}"` });
          }
        }
      }

      // Property validation
      if (schema.properties) {
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          if (key in obj) {
            this.validateNode(propSchema, obj[key], `${path}.${key}`, errors);
          }
        }
      }
    }
  }

  private getJsonType(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value; // 'string', 'number', 'boolean', 'object', 'undefined'
  }

  /**
   * Get validation stats.
   */
  stats(): SchemaStats {
    return {
      totalSchemas: this.schemas.size,
      schemas: Array.from(this.schemas.values()).map(s => ({
        toolName: s.toolName,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
      totalValidations: this.totalValidations,
      totalFailures: this.totalFailures,
    };
  }

  /**
   * Export all schemas.
   */
  exportSchemas(): ToolSchema[] {
    return Array.from(this.schemas.values());
  }

  /**
   * Import schemas.
   */
  importSchemas(schemas: Array<{ toolName: string; schema: SchemaNode }>): number {
    let imported = 0;
    for (const s of schemas) {
      try {
        this.registerSchema(s.toolName, s.schema);
        imported++;
      } catch { /* skip invalid */ }
    }
    return imported;
  }

  /** Number of registered schemas. */
  get size(): number {
    return this.schemas.size;
  }
}
