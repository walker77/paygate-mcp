/**
 * Tests for Proxy-as-MCP-Server.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ProxyMcpServer } from '../src/proxy-mcp-server';

describe('ProxyMcpServer', () => {
  let server: ProxyMcpServer;

  beforeEach(() => {
    server = new ProxyMcpServer();
  });

  // ─── Initialization ─────────────────────────────────────────────────
  describe('initialization', () => {
    it('creates default management tools', () => {
      const names = server.getToolNames();
      expect(names).toContain('paygate_get_balance');
      expect(names).toContain('paygate_get_usage');
      expect(names).toContain('paygate_list_tools');
      expect(names).toContain('paygate_get_pricing');
      expect(names).toContain('paygate_get_rate_limit_status');
      expect(names).toContain('paygate_get_quota_status');
      expect(names).toContain('paygate_estimate_cost');
      expect(names).toContain('paygate_get_grants');
      expect(names).toContain('paygate_get_health');
      expect(names).toContain('paygate_get_key_info');
    });

    it('supports custom prefix', () => {
      const s = new ProxyMcpServer({ prefix: 'billing' });
      const names = s.getToolNames();
      expect(names).toContain('billing_get_balance');
      expect(names).not.toContain('paygate_get_balance');
    });

    it('supports disabling specific tools', () => {
      const s = new ProxyMcpServer({
        disabledTools: ['paygate_get_health', 'paygate_get_key_info'],
      });
      const names = s.getToolNames();
      expect(names).not.toContain('paygate_get_health');
      expect(names).not.toContain('paygate_get_key_info');
      expect(names).toContain('paygate_get_balance');
    });

    it('supports enabling only specific tools', () => {
      const s = new ProxyMcpServer({
        enableAll: false,
        enabledTools: ['paygate_get_balance', 'paygate_get_usage'],
      });
      const names = s.getToolNames();
      expect(names).toHaveLength(2);
      expect(names).toContain('paygate_get_balance');
      expect(names).toContain('paygate_get_usage');
    });
  });

  // ─── Tool Definitions ──────────────────────────────────────────────
  describe('getToolDefinitions', () => {
    it('returns MCP-compatible tool list', () => {
      const defs = server.getToolDefinitions();
      expect(defs.length).toBeGreaterThanOrEqual(10);

      for (const def of defs) {
        expect(def.name).toBeDefined();
        expect(def.description).toBeDefined();
        expect(def.inputSchema).toBeDefined();
      }
    });

    it('excludes disabled tools', () => {
      server.setToolEnabled('paygate_get_health', false);
      const defs = server.getToolDefinitions();
      const names = defs.map(d => d.name);
      expect(names).not.toContain('paygate_get_health');
    });
  });

  // ─── Tool Identification ───────────────────────────────────────────
  describe('isManagementTool', () => {
    it('identifies management tools', () => {
      expect(server.isManagementTool('paygate_get_balance')).toBe(true);
      expect(server.isManagementTool('readFile')).toBe(false);
      expect(server.isManagementTool('paygate_unknown')).toBe(false);
    });

    it('returns false for disabled tools', () => {
      server.setToolEnabled('paygate_get_balance', false);
      expect(server.isManagementTool('paygate_get_balance')).toBe(false);
    });
  });

  // ─── Resolver Registration ─────────────────────────────────────────
  describe('registerResolver', () => {
    it('registers a resolver for a tool', () => {
      const ok = server.registerResolver('paygate_get_balance', async (_name, _args, apiKey) => {
        return { balance: 100, key: apiKey };
      });
      expect(ok).toBe(true);
    });

    it('accepts unprefixed tool names', () => {
      const ok = server.registerResolver('get_balance', async () => ({ balance: 42 }));
      expect(ok).toBe(true);
    });

    it('returns false for unknown tool', () => {
      const ok = server.registerResolver('nonexistent', async () => ({}));
      expect(ok).toBe(false);
    });
  });

  // ─── Tool Calls ────────────────────────────────────────────────────
  describe('handleToolCall', () => {
    it('calls resolver and returns result', async () => {
      server.registerResolver('paygate_get_balance', async (_name, _args, apiKey) => {
        return { balance: 250, key: apiKey.slice(0, 8) };
      });

      const response = await server.handleToolCall('paygate_get_balance', {}, 'pk_test_12345');
      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
      const result = response.result as { content: Array<{ type: string; text: string }> };
      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.balance).toBe(250);
    });

    it('returns error for unknown tool', async () => {
      const response = await server.handleToolCall('nonexistent', {}, 'key');
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32601);
    });

    it('returns error for disabled tool', async () => {
      server.setToolEnabled('paygate_get_balance', false);
      const response = await server.handleToolCall('paygate_get_balance', {}, 'key');
      expect(response.error).toBeDefined();
    });

    it('handles resolver errors gracefully', async () => {
      server.registerResolver('paygate_get_balance', async () => {
        throw new Error('Database connection failed');
      });

      const response = await server.handleToolCall('paygate_get_balance', {}, 'key');
      expect(response.error).toBeDefined();
      expect(response.error!.message).toContain('Database connection failed');
    });

    it('passes arguments to resolver', async () => {
      server.registerResolver('paygate_get_usage', async (_name, args) => {
        return { period: args.period ?? 'day' };
      });

      const response = await server.handleToolCall('paygate_get_usage', { period: 'week' }, 'key');
      const result = response.result as { content: Array<{ type: string; text: string }> };
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.period).toBe('week');
    });

    it('handles string result', async () => {
      server.registerResolver('paygate_get_health', async () => {
        return 'Healthy';
      });

      const response = await server.handleToolCall('paygate_get_health', {}, 'key');
      const result = response.result as { content: Array<{ type: string; text: string }> };
      expect(result.content[0].text).toBe('Healthy');
    });
  });

  // ─── Custom Tools ──────────────────────────────────────────────────
  describe('registerTool', () => {
    it('registers a custom management tool', async () => {
      server.registerTool({
        name: 'paygate_custom_report',
        description: 'Generate a custom report',
        inputSchema: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: ['json', 'csv'] },
          },
        },
        enabled: true,
        resolver: async (_name, args) => {
          return { format: args.format ?? 'json', rows: 42 };
        },
      });

      expect(server.isManagementTool('paygate_custom_report')).toBe(true);

      const response = await server.handleToolCall('paygate_custom_report', { format: 'csv' }, 'key');
      const result = response.result as { content: Array<{ type: string; text: string }> };
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.format).toBe('csv');
      expect(parsed.rows).toBe(42);
    });
  });

  // ─── Enable/Disable ────────────────────────────────────────────────
  describe('setToolEnabled', () => {
    it('enables and disables tools', () => {
      expect(server.setToolEnabled('paygate_get_balance', false)).toBe(true);
      expect(server.isManagementTool('paygate_get_balance')).toBe(false);

      expect(server.setToolEnabled('paygate_get_balance', true)).toBe(true);
      expect(server.isManagementTool('paygate_get_balance')).toBe(true);
    });

    it('returns false for unknown tool', () => {
      expect(server.setToolEnabled('nonexistent', false)).toBe(false);
    });
  });

  // ─── Stats ──────────────────────────────────────────────────────────
  describe('stats', () => {
    it('tracks call counts', async () => {
      server.registerResolver('paygate_get_balance', async () => ({ balance: 0 }));
      server.registerResolver('paygate_get_usage', async () => ({ calls: 0 }));

      await server.handleToolCall('paygate_get_balance', {}, 'key');
      await server.handleToolCall('paygate_get_balance', {}, 'key');
      await server.handleToolCall('paygate_get_usage', {}, 'key');

      const stats = server.getStats();
      expect(stats.totalCalls).toBe(3);
      expect(stats.callsByTool['paygate_get_balance']).toBe(2);
      expect(stats.callsByTool['paygate_get_usage']).toBe(1);
    });

    it('tracks errors', async () => {
      server.registerResolver('paygate_get_balance', async () => {
        throw new Error('fail');
      });

      await server.handleToolCall('paygate_get_balance', {}, 'key');
      expect(server.getStats().totalErrors).toBe(1);
    });
  });

  // ─── Destroy ────────────────────────────────────────────────────────
  describe('destroy', () => {
    it('releases all resources', () => {
      server.destroy();
      expect(server.getToolNames()).toHaveLength(0);
      expect(server.getStats().totalCalls).toBe(0);
    });
  });
});
