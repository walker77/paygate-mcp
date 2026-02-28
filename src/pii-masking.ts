/**
 * PII Reversible Masking — Extends guardrails with reversible tokenization.
 *
 * Unlike guardrails' destructive redaction ([REDACTED]), PII masking replaces
 * sensitive data with deterministic tokens (e.g., <EMAIL_1>, <SSN_1>) before
 * sending to the backend, then reinserts the original values in the response.
 *
 * This prevents PII from reaching backend servers while preserving data
 * integrity for the end user.
 *
 * Features:
 *   - Reversible tokenization (mask → unmask round-trip)
 *   - Per-request token vaults (no cross-request leakage)
 *   - Built-in patterns for email, phone, SSN, credit card, IBAN
 *   - Custom pattern support via regex
 *   - Statistics and audit trail
 *   - Token format configurable (e.g., <TYPE_N> or __TYPE_N__)
 *
 * Zero external dependencies.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PiiPattern {
  /** Unique pattern ID. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Regex pattern string. */
  pattern: string;
  /** Regex flags. Default: 'g'. */
  flags?: string;
  /** Token prefix used in replacement (e.g., 'EMAIL' → <EMAIL_1>). */
  tokenPrefix: string;
  /** Whether pattern is active. Default: true. */
  active: boolean;
  /** Apply to inputs, outputs, or both. Default: 'input'. */
  scope: 'input' | 'output' | 'both';
  /** Only apply to these tools. Empty = all. */
  tools: string[];
}

export interface PiiMaskingConfig {
  /** Enable PII masking. Default: false. */
  enabled: boolean;
  /** Patterns to detect and mask. Uses built-in defaults if empty. */
  patterns?: PiiPattern[];
  /** Token format template. Default: '<{PREFIX}_{N}>'. */
  tokenFormat?: string;
  /** Max tokens per request vault. Default: 1000. */
  maxTokensPerRequest?: number;
}

export interface TokenVault {
  /** Request-scoped mapping: token → original value. */
  tokens: Map<string, string>;
  /** Reverse mapping: original value → token (for dedup). */
  reverseMap: Map<string, string>;
  /** Counter per token prefix. */
  counters: Map<string, number>;
  /** Creation timestamp. */
  createdAt: number;
}

export interface MaskResult {
  /** The masked content. */
  masked: string;
  /** Number of tokens created. */
  tokensCreated: number;
  /** Token types found (e.g., ['EMAIL', 'PHONE']). */
  typesFound: string[];
}

export interface UnmaskResult {
  /** The unmasked content with original values restored. */
  unmasked: string;
  /** Number of tokens replaced. */
  tokensReplaced: number;
}

export interface PiiMaskingStats {
  /** Total mask operations performed. */
  totalMaskOps: number;
  /** Total unmask operations performed. */
  totalUnmaskOps: number;
  /** Total tokens created across all requests. */
  totalTokensCreated: number;
  /** Total tokens restored across all requests. */
  totalTokensRestored: number;
  /** Tokens by type (e.g., { EMAIL: 42, SSN: 5 }). */
  byType: Record<string, number>;
  /** Active vaults (requests in flight). */
  activeVaults: number;
  /** Total vaults ever created. */
  totalVaults: number;
}

// ─── Built-in Patterns ──────────────────────────────────────────────────────

const BUILT_IN_PII_PATTERNS: PiiPattern[] = [
  {
    id: 'pii_email',
    name: 'Email Address',
    pattern: '[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}',
    tokenPrefix: 'EMAIL',
    active: true,
    scope: 'input',
    tools: [],
  },
  {
    id: 'pii_phone',
    name: 'Phone Number',
    pattern: '(?:\\+?1[-\\s.]?)?(?:\\(?\\d{3}\\)?[-\\s.]?)\\d{3}[-\\s.]?\\d{4}',
    tokenPrefix: 'PHONE',
    active: true,
    scope: 'input',
    tools: [],
  },
  {
    id: 'pii_ssn',
    name: 'Social Security Number',
    pattern: '\\b(?!000|666|9\\d{2})\\d{3}[-\\s]?(?!00)\\d{2}[-\\s]?(?!0000)\\d{4}\\b',
    tokenPrefix: 'SSN',
    active: true,
    scope: 'input',
    tools: [],
  },
  {
    id: 'pii_credit_card',
    name: 'Credit Card Number',
    pattern: '\\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\\b',
    tokenPrefix: 'CARD',
    active: true,
    scope: 'input',
    tools: [],
  },
  {
    id: 'pii_iban',
    name: 'IBAN',
    pattern: '\\b[A-Z]{2}\\d{2}[A-Z0-9]{4}\\d{7}(?:[A-Z0-9]{0,18})\\b',
    tokenPrefix: 'IBAN',
    active: true,
    scope: 'input',
    tools: [],
  },
];

// ─── PII Masking Engine ──────────────────────────────────────────────────────

export class PiiMasker {
  private patterns: PiiPattern[];
  private compiledPatterns: Map<string, RegExp> = new Map();
  private vaults: Map<string, TokenVault> = new Map();
  private tokenFormat: string;
  private maxTokensPerRequest: number;
  private enabled: boolean;

  // Stats
  private stats: PiiMaskingStats = {
    totalMaskOps: 0,
    totalUnmaskOps: 0,
    totalTokensCreated: 0,
    totalTokensRestored: 0,
    byType: {},
    activeVaults: 0,
    totalVaults: 0,
  };

  constructor(config?: Partial<PiiMaskingConfig>) {
    this.enabled = config?.enabled ?? false;
    this.patterns = config?.patterns ?? [...BUILT_IN_PII_PATTERNS];
    this.tokenFormat = config?.tokenFormat ?? '<{PREFIX}_{N}>';
    this.maxTokensPerRequest = config?.maxTokensPerRequest ?? 1000;

    // Pre-compile patterns
    for (const p of this.patterns) {
      try {
        this.compiledPatterns.set(p.id, new RegExp(p.pattern, p.flags ?? 'g'));
      } catch {
        // Invalid regex — skip
      }
    }
  }

  /** Whether PII masking is enabled. */
  get isEnabled(): boolean { return this.enabled; }

  /** Enable/disable at runtime. */
  setEnabled(enabled: boolean): void { this.enabled = enabled; }

  /** Get configured patterns. */
  getPatterns(): PiiPattern[] { return [...this.patterns]; }

  /** Add or update a pattern. */
  upsertPattern(pattern: PiiPattern): PiiPattern {
    const idx = this.patterns.findIndex(p => p.id === pattern.id);
    if (idx >= 0) {
      this.patterns[idx] = pattern;
    } else {
      this.patterns.push(pattern);
    }
    try {
      this.compiledPatterns.set(pattern.id, new RegExp(pattern.pattern, pattern.flags ?? 'g'));
    } catch {
      this.compiledPatterns.delete(pattern.id);
    }
    return pattern;
  }

  /** Remove a pattern by ID. */
  removePattern(id: string): boolean {
    const idx = this.patterns.findIndex(p => p.id === id);
    if (idx < 0) return false;
    this.patterns.splice(idx, 1);
    this.compiledPatterns.delete(id);
    return true;
  }

  /**
   * Create a per-request token vault.
   * Call this at the start of each request.
   */
  createVault(requestId: string): void {
    this.vaults.set(requestId, {
      tokens: new Map(),
      reverseMap: new Map(),
      counters: new Map(),
      createdAt: Date.now(),
    });
    this.stats.activeVaults = this.vaults.size;
    this.stats.totalVaults++;
  }

  /**
   * Destroy a request vault.
   * Call this after response is sent.
   */
  destroyVault(requestId: string): void {
    this.vaults.delete(requestId);
    this.stats.activeVaults = this.vaults.size;
  }

  /**
   * Mask PII in content by replacing with tokens.
   *
   * @param content - Text to scan
   * @param requestId - Request ID for vault scoping
   * @param tool - Tool name for tool-specific filtering
   * @param scope - 'input' or 'output'
   */
  mask(content: string, requestId: string, tool: string, scope: 'input' | 'output'): MaskResult {
    const result: MaskResult = {
      masked: content,
      tokensCreated: 0,
      typesFound: [],
    };

    if (!this.enabled || !content) return result;

    const vault = this.vaults.get(requestId);
    if (!vault) return result;

    this.stats.totalMaskOps++;

    let masked = content;
    const typesFound = new Set<string>();

    for (const pattern of this.patterns) {
      if (!pattern.active) continue;
      if (pattern.scope !== 'both' && pattern.scope !== scope) continue;
      if (pattern.tools.length > 0 && !pattern.tools.includes(tool)) continue;

      const regex = this.compiledPatterns.get(pattern.id);
      if (!regex) continue;

      regex.lastIndex = 0;

      masked = masked.replace(regex, (match) => {
        // Check if we already tokenized this exact value
        const existing = vault.reverseMap.get(match);
        if (existing) return existing;

        // Check vault size
        if (vault.tokens.size >= this.maxTokensPerRequest) return match;

        // Create new token
        const counter = (vault.counters.get(pattern.tokenPrefix) ?? 0) + 1;
        vault.counters.set(pattern.tokenPrefix, counter);

        const token = this.tokenFormat
          .replace('{PREFIX}', pattern.tokenPrefix)
          .replace('{N}', String(counter));

        vault.tokens.set(token, match);
        vault.reverseMap.set(match, token);

        result.tokensCreated++;
        this.stats.totalTokensCreated++;
        typesFound.add(pattern.tokenPrefix);
        this.stats.byType[pattern.tokenPrefix] = (this.stats.byType[pattern.tokenPrefix] ?? 0) + 1;

        return token;
      });
    }

    result.masked = masked;
    result.typesFound = [...typesFound];
    return result;
  }

  /**
   * Unmask tokens in content by replacing with original values.
   *
   * @param content - Text containing tokens
   * @param requestId - Request ID for vault lookup
   */
  unmask(content: string, requestId: string): UnmaskResult {
    const result: UnmaskResult = {
      unmasked: content,
      tokensReplaced: 0,
    };

    if (!this.enabled || !content) return result;

    const vault = this.vaults.get(requestId);
    if (!vault || vault.tokens.size === 0) return result;

    this.stats.totalUnmaskOps++;

    let unmasked = content;

    for (const [token, original] of vault.tokens) {
      // Use a simple global string replace for each token
      let count = 0;
      while (unmasked.includes(token)) {
        unmasked = unmasked.replace(token, original);
        count++;
        if (count > 100) break; // Safety valve
      }
      if (count > 0) {
        result.tokensReplaced += count;
        this.stats.totalTokensRestored += count;
      }
    }

    result.unmasked = unmasked;
    return result;
  }

  /** Get vault info for a request. */
  getVaultInfo(requestId: string): { tokenCount: number; types: string[] } | null {
    const vault = this.vaults.get(requestId);
    if (!vault) return null;
    return {
      tokenCount: vault.tokens.size,
      types: [...vault.counters.keys()],
    };
  }

  /** Get statistics. */
  getStats(): PiiMaskingStats {
    return { ...this.stats };
  }

  /** Reset statistics. */
  resetStats(): void {
    this.stats = {
      totalMaskOps: 0,
      totalUnmaskOps: 0,
      totalTokensCreated: 0,
      totalTokensRestored: 0,
      byType: {},
      activeVaults: this.vaults.size,
      totalVaults: this.stats.totalVaults,
    };
  }

  /** Cleanup stale vaults older than maxAgeMs. */
  cleanupVaults(maxAgeMs: number = 300_000): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, vault] of this.vaults) {
      if (now - vault.createdAt > maxAgeMs) {
        this.vaults.delete(id);
        cleaned++;
      }
    }
    this.stats.activeVaults = this.vaults.size;
    return cleaned;
  }

  /** Destroy engine and release all resources. */
  destroy(): void {
    this.vaults.clear();
    this.compiledPatterns.clear();
    this.patterns = [];
    this.stats.activeVaults = 0;
  }
}

export { BUILT_IN_PII_PATTERNS };
