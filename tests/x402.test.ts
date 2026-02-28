/**
 * Tests for x402 payment protocol handler.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { X402Handler, X402VerifyResult, X402Stats, PaymentRequirements } from '../src/x402';
import { X402Config } from '../src/types';

const DEFAULT_CONFIG: X402Config = {
  enabled: true,
  payTo: '0x1234567890abcdef1234567890abcdef12345678',
  network: 'base',
  asset: '0xUSDC',
  facilitatorUrl: 'https://x402.org/facilitator',
  creditsPerDollar: 100,
};

describe('X402Handler', () => {
  let handler: X402Handler;

  beforeEach(() => {
    handler = new X402Handler(DEFAULT_CONFIG);
  });

  // ─── hasPayment ─────────────────────────────────────────────────────────
  describe('hasPayment', () => {
    it('returns true when X-PAYMENT header is present', () => {
      const req = { headers: { 'x-payment': 'somebase64data' } } as any;
      expect(handler.hasPayment(req)).toBe(true);
    });

    it('returns false when X-PAYMENT header is missing', () => {
      const req = { headers: {} } as any;
      expect(handler.hasPayment(req)).toBe(false);
    });

    it('returns false for empty string header', () => {
      const req = { headers: { 'x-payment': '' } } as any;
      expect(handler.hasPayment(req)).toBe(false);
    });
  });

  // ─── generatePaymentRequired ────────────────────────────────────────────
  describe('generatePaymentRequired', () => {
    it('returns base64-encoded payment requirements', () => {
      const result = handler.generatePaymentRequired(10, '/mcp');
      expect(typeof result).toBe('string');

      // Decode and verify
      const decoded: PaymentRequirements = JSON.parse(Buffer.from(result, 'base64').toString('utf-8'));
      expect(decoded.x402Version).toBe(1);
      expect(decoded.accepts).toHaveLength(1);
      expect(decoded.accepts[0].scheme).toBe('exact');
      expect(decoded.accepts[0].network).toBe('base');
      expect(decoded.accepts[0].payTo).toBe(DEFAULT_CONFIG.payTo);
      expect(decoded.accepts[0].asset).toBe('0xUSDC');
      expect(decoded.accepts[0].resource).toBe('/mcp');
    });

    it('calculates correct USD amount from credits', () => {
      const result = handler.generatePaymentRequired(50, '/mcp');
      const decoded: PaymentRequirements = JSON.parse(Buffer.from(result, 'base64').toString('utf-8'));
      // 50 credits / 100 creditsPerDollar = $0.50
      expect(decoded.accepts[0].maxAmountRequired).toBe('$0.5');
    });

    it('handles fractional amounts correctly', () => {
      const result = handler.generatePaymentRequired(1, '/mcp');
      const decoded: PaymentRequirements = JSON.parse(Buffer.from(result, 'base64').toString('utf-8'));
      // 1 credit / 100 creditsPerDollar = $0.01
      expect(decoded.accepts[0].maxAmountRequired).toBe('$0.01');
    });

    it('uses custom description when provided', () => {
      const configWithDesc: X402Config = { ...DEFAULT_CONFIG, description: 'Custom payment' };
      const h = new X402Handler(configWithDesc);
      const result = h.generatePaymentRequired(10, '/mcp');
      const decoded: PaymentRequirements = JSON.parse(Buffer.from(result, 'base64').toString('utf-8'));
      expect(decoded.accepts[0].description).toBe('Custom payment');
    });

    it('uses custom maxTimeoutSeconds when provided', () => {
      const configWithTimeout: X402Config = { ...DEFAULT_CONFIG, maxTimeoutSeconds: 120 };
      const h = new X402Handler(configWithTimeout);
      const result = h.generatePaymentRequired(10, '/mcp');
      const decoded: PaymentRequirements = JSON.parse(Buffer.from(result, 'base64').toString('utf-8'));
      expect(decoded.accepts[0].maxTimeoutSeconds).toBe(120);
    });
  });

  // ─── verifyPayment ──────────────────────────────────────────────────────
  describe('verifyPayment', () => {
    it('returns error for invalid base64 payment header', async () => {
      const result = await handler.verifyPayment('not-valid-base64!!!', 10, '/mcp');
      expect(result.valid).toBe(false);
      expect(result.creditsAwarded).toBe(0);
      expect(result.error).toContain('Invalid X-PAYMENT header');
    });

    it('returns error for invalid JSON in base64', async () => {
      const invalidPayload = Buffer.from('not json').toString('base64');
      const result = await handler.verifyPayment(invalidPayload, 10, '/mcp');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid X-PAYMENT header');
    });

    it('returns error when facilitator is unreachable', async () => {
      // Use an unreachable facilitator URL
      const badConfig: X402Config = { ...DEFAULT_CONFIG, facilitatorUrl: 'http://127.0.0.1:1' };
      const h = new X402Handler(badConfig);
      const payload = Buffer.from(JSON.stringify({ proof: 'test' })).toString('base64');
      const result = await h.verifyPayment(payload, 10, '/mcp');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Facilitator request failed');
    });

    it('increments failedVerifications stat on invalid payload', async () => {
      await handler.verifyPayment('bad', 10, '/mcp');
      const stats = handler.getStats();
      expect(stats.failedVerifications).toBe(1);
    });

    it('increments facilitatorErrors on network error', async () => {
      const badConfig: X402Config = { ...DEFAULT_CONFIG, facilitatorUrl: 'http://127.0.0.1:1' };
      const h = new X402Handler(badConfig);
      const payload = Buffer.from(JSON.stringify({ proof: 'test' })).toString('base64');
      await h.verifyPayment(payload, 10, '/mcp');
      const stats = h.getStats();
      expect(stats.facilitatorErrors).toBe(1);
    });
  });

  // ─── write402Response ───────────────────────────────────────────────────
  describe('write402Response', () => {
    it('writes 402 status with Payment-Required header', () => {
      let statusCode = 0;
      let headers: Record<string, string> = {};
      let body = '';
      const res = {
        writeHead: (code: number, h: Record<string, string>) => { statusCode = code; headers = h; },
        end: (data: string) => { body = data; },
      } as any;

      handler.write402Response(res, 10, '/mcp');

      expect(statusCode).toBe(402);
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Payment-Required']).toBeTruthy();

      const parsed = JSON.parse(body);
      expect(parsed.error).toBe('Payment Required');
      expect(parsed.x402Version).toBe(1);
      expect(parsed.creditsRequired).toBe(10);
      expect(parsed.network).toBe('base');
      expect(parsed.asset).toBe('0xUSDC');
    });

    it('includes additional message when provided', () => {
      let body = '';
      const res = {
        writeHead: () => {},
        end: (data: string) => { body = data; },
      } as any;

      handler.write402Response(res, 5, '/mcp', 'Custom message');

      const parsed = JSON.parse(body);
      expect(parsed.message).toBe('Custom message');
    });
  });

  // ─── getStats ───────────────────────────────────────────────────────────
  describe('getStats', () => {
    it('returns initial stats with all zeros', () => {
      const stats = handler.getStats();
      expect(stats.paymentsReceived).toBe(0);
      expect(stats.creditsAwarded).toBe(0);
      expect(stats.totalUsdReceived).toBe(0);
      expect(stats.failedVerifications).toBe(0);
      expect(stats.facilitatorErrors).toBe(0);
    });

    it('returns a copy (not a reference)', () => {
      const stats1 = handler.getStats();
      const stats2 = handler.getStats();
      expect(stats1).not.toBe(stats2);
      expect(stats1).toEqual(stats2);
    });
  });

  // ─── getPublicConfig ────────────────────────────────────────────────────
  describe('getPublicConfig', () => {
    it('returns safe config without sensitive fields', () => {
      const config = handler.getPublicConfig();
      expect(config.enabled).toBe(true);
      expect(config.network).toBe('base');
      expect(config.payTo).toBe(DEFAULT_CONFIG.payTo);
      expect(config.creditsPerDollar).toBe(100);
      // Should not include facilitatorUrl or asset
      expect((config as any).facilitatorUrl).toBeUndefined();
    });
  });
});
