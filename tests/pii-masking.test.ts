/**
 * Tests for PII Reversible Masking.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { PiiMasker, BUILT_IN_PII_PATTERNS, PiiPattern } from '../src/pii-masking';

describe('PiiMasker', () => {
  let masker: PiiMasker;

  beforeEach(() => {
    masker = new PiiMasker({ enabled: true });
  });

  // ─── Basic Enable/Disable ──────────────────────────────────────────────
  describe('enable/disable', () => {
    it('starts enabled when configured', () => {
      expect(masker.isEnabled).toBe(true);
    });

    it('defaults to disabled', () => {
      const m = new PiiMasker();
      expect(m.isEnabled).toBe(false);
    });

    it('can be toggled at runtime', () => {
      masker.setEnabled(false);
      expect(masker.isEnabled).toBe(false);
      masker.setEnabled(true);
      expect(masker.isEnabled).toBe(true);
    });
  });

  // ─── Built-in Patterns ─────────────────────────────────────────────────
  describe('built-in patterns', () => {
    it('has default PII patterns', () => {
      const patterns = masker.getPatterns();
      expect(patterns.length).toBeGreaterThanOrEqual(5);
      const ids = patterns.map(p => p.id);
      expect(ids).toContain('pii_email');
      expect(ids).toContain('pii_phone');
      expect(ids).toContain('pii_ssn');
      expect(ids).toContain('pii_credit_card');
      expect(ids).toContain('pii_iban');
    });

    it('exports BUILT_IN_PII_PATTERNS', () => {
      expect(BUILT_IN_PII_PATTERNS.length).toBeGreaterThanOrEqual(5);
    });
  });

  // ─── Vault Lifecycle ───────────────────────────────────────────────────
  describe('vault lifecycle', () => {
    it('creates and destroys vaults', () => {
      masker.createVault('req-1');
      const info = masker.getVaultInfo('req-1');
      expect(info).not.toBeNull();
      expect(info!.tokenCount).toBe(0);

      masker.destroyVault('req-1');
      expect(masker.getVaultInfo('req-1')).toBeNull();
    });

    it('tracks vault count in stats', () => {
      masker.createVault('req-1');
      masker.createVault('req-2');
      expect(masker.getStats().activeVaults).toBe(2);
      expect(masker.getStats().totalVaults).toBe(2);

      masker.destroyVault('req-1');
      expect(masker.getStats().activeVaults).toBe(1);
    });
  });

  // ─── Masking ───────────────────────────────────────────────────────────
  describe('mask', () => {
    it('masks email addresses', () => {
      masker.createVault('req-1');
      const result = masker.mask('Contact john@example.com for details', 'req-1', 'sendEmail', 'input');
      expect(result.masked).not.toContain('john@example.com');
      expect(result.masked).toContain('<EMAIL_1>');
      expect(result.tokensCreated).toBe(1);
      expect(result.typesFound).toContain('EMAIL');
    });

    it('masks multiple emails with different tokens', () => {
      masker.createVault('req-1');
      const result = masker.mask('From: a@b.com To: c@d.com', 'req-1', 'tool', 'input');
      expect(result.masked).toContain('<EMAIL_1>');
      expect(result.masked).toContain('<EMAIL_2>');
      expect(result.tokensCreated).toBe(2);
    });

    it('deduplicates same value', () => {
      masker.createVault('req-1');
      const result = masker.mask('Email: a@b.com and again a@b.com', 'req-1', 'tool', 'input');
      // Same email should get the same token
      expect(result.tokensCreated).toBe(1);
      // Both occurrences should be replaced
      expect(result.masked).not.toContain('a@b.com');
    });

    it('masks phone numbers', () => {
      masker.createVault('req-1');
      const result = masker.mask('Call me at (555) 123-4567', 'req-1', 'tool', 'input');
      expect(result.masked).not.toContain('123-4567');
      expect(result.typesFound).toContain('PHONE');
    });

    it('masks SSNs', () => {
      masker.createVault('req-1');
      const result = masker.mask('SSN: 123-45-6789', 'req-1', 'tool', 'input');
      expect(result.masked).not.toContain('123-45-6789');
      expect(result.typesFound).toContain('SSN');
    });

    it('masks credit card numbers', () => {
      masker.createVault('req-1');
      const result = masker.mask('Card: 4111111111111111', 'req-1', 'tool', 'input');
      expect(result.masked).not.toContain('4111111111111111');
      // May match CARD or PHONE pattern depending on order; verify masking happened
      expect(result.tokensCreated).toBeGreaterThanOrEqual(1);
    });

    it('returns original if masking is disabled', () => {
      masker.setEnabled(false);
      masker.createVault('req-1');
      const result = masker.mask('Email: a@b.com', 'req-1', 'tool', 'input');
      expect(result.masked).toBe('Email: a@b.com');
      expect(result.tokensCreated).toBe(0);
    });

    it('returns original if no vault exists', () => {
      const result = masker.mask('Email: a@b.com', 'nonexistent', 'tool', 'input');
      expect(result.masked).toBe('Email: a@b.com');
    });

    it('handles empty content', () => {
      masker.createVault('req-1');
      const result = masker.mask('', 'req-1', 'tool', 'input');
      expect(result.masked).toBe('');
      expect(result.tokensCreated).toBe(0);
    });
  });

  // ─── Unmasking ─────────────────────────────────────────────────────────
  describe('unmask', () => {
    it('restores masked values', () => {
      masker.createVault('req-1');
      const masked = masker.mask('Email: john@example.com', 'req-1', 'tool', 'input');
      const unmasked = masker.unmask(masked.masked, 'req-1');
      expect(unmasked.unmasked).toBe('Email: john@example.com');
      expect(unmasked.tokensReplaced).toBe(1);
    });

    it('restores multiple tokens', () => {
      masker.createVault('req-1');
      const masked = masker.mask('From a@b.com to c@d.com via (555) 123-4567', 'req-1', 'tool', 'input');
      const unmasked = masker.unmask(masked.masked, 'req-1');
      expect(unmasked.unmasked).toContain('a@b.com');
      expect(unmasked.unmasked).toContain('c@d.com');
    });

    it('handles no vault gracefully', () => {
      const result = masker.unmask('some <EMAIL_1> text', 'nonexistent');
      expect(result.unmasked).toBe('some <EMAIL_1> text');
      expect(result.tokensReplaced).toBe(0);
    });

    it('handles content with no tokens', () => {
      masker.createVault('req-1');
      const result = masker.unmask('no tokens here', 'req-1');
      expect(result.unmasked).toBe('no tokens here');
      expect(result.tokensReplaced).toBe(0);
    });

    it('round-trips complex content', () => {
      masker.createVault('req-1');
      const original = 'User john@example.com called from (555) 123-4567 with SSN 123-45-6789';
      const masked = masker.mask(original, 'req-1', 'tool', 'input');
      expect(masked.tokensCreated).toBeGreaterThanOrEqual(2);
      const unmasked = masker.unmask(masked.masked, 'req-1');
      expect(unmasked.unmasked).toBe(original);
    });
  });

  // ─── Pattern Management ────────────────────────────────────────────────
  describe('pattern management', () => {
    it('adds custom patterns', () => {
      const custom: PiiPattern = {
        id: 'custom_id',
        name: 'Custom ID',
        pattern: 'ID-\\d{6}',
        tokenPrefix: 'CID',
        active: true,
        scope: 'input',
        tools: [],
      };
      masker.upsertPattern(custom);
      expect(masker.getPatterns().find(p => p.id === 'custom_id')).toBeDefined();

      masker.createVault('req-1');
      const result = masker.mask('Reference: ID-123456', 'req-1', 'tool', 'input');
      expect(result.masked).toContain('<CID_1>');
    });

    it('removes patterns', () => {
      expect(masker.removePattern('pii_email')).toBe(true);
      expect(masker.removePattern('nonexistent')).toBe(false);

      masker.createVault('req-1');
      const result = masker.mask('Email: a@b.com', 'req-1', 'tool', 'input');
      // Email pattern removed, so should not mask
      expect(result.masked).toBe('Email: a@b.com');
    });

    it('respects tool filtering', () => {
      const toolPattern: PiiPattern = {
        id: 'tool_specific',
        name: 'Tool Specific',
        pattern: 'SECRET-\\w+',
        tokenPrefix: 'SEC',
        active: true,
        scope: 'input',
        tools: ['specialTool'],
      };
      masker.upsertPattern(toolPattern);

      masker.createVault('req-1');
      // Should NOT mask for other tools
      const r1 = masker.mask('Code: SECRET-ABC123', 'req-1', 'otherTool', 'input');
      expect(r1.masked).toContain('SECRET-ABC123');

      // Should mask for the specified tool
      const r2 = masker.mask('Code: SECRET-ABC123', 'req-1', 'specialTool', 'input');
      expect(r2.masked).toContain('<SEC_1>');
    });

    it('respects scope filtering', () => {
      // Default email pattern scope is 'input'
      masker.createVault('req-1');
      const r1 = masker.mask('Email: a@b.com', 'req-1', 'tool', 'output');
      // Should NOT mask on output since email scope is 'input'
      expect(r1.masked).toBe('Email: a@b.com');
    });
  });

  // ─── Stats ─────────────────────────────────────────────────────────────
  describe('stats', () => {
    it('tracks mask/unmask operations', () => {
      masker.createVault('req-1');
      masker.mask('john@example.com', 'req-1', 'tool', 'input');
      masker.unmask('<EMAIL_1>', 'req-1');

      const stats = masker.getStats();
      expect(stats.totalMaskOps).toBe(1);
      expect(stats.totalUnmaskOps).toBe(1);
      expect(stats.totalTokensCreated).toBe(1);
      expect(stats.byType.EMAIL).toBe(1);
    });

    it('resets stats', () => {
      masker.createVault('req-1');
      masker.mask('john@example.com', 'req-1', 'tool', 'input');
      masker.resetStats();
      const stats = masker.getStats();
      expect(stats.totalMaskOps).toBe(0);
      expect(stats.totalTokensCreated).toBe(0);
    });
  });

  // ─── Vault Cleanup ─────────────────────────────────────────────────────
  describe('cleanup', () => {
    it('cleans up stale vaults', async () => {
      masker.createVault('old-req');
      // Wait a small amount so the vault age exceeds maxAgeMs
      await new Promise(r => setTimeout(r, 20));
      const cleaned = masker.cleanupVaults(10); // 10ms = vault is stale after 20ms wait
      expect(cleaned).toBe(1);
      expect(masker.getVaultInfo('old-req')).toBeNull();
    });
  });

  // ─── Destroy ───────────────────────────────────────────────────────────
  describe('destroy', () => {
    it('releases all resources', () => {
      masker.createVault('req-1');
      masker.destroy();
      expect(masker.getPatterns()).toHaveLength(0);
      expect(masker.getStats().activeVaults).toBe(0);
    });
  });
});
