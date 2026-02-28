import {
  getMetaTools,
  isMetaTool,
  handleMetaToolCall,
  ToolInfo,
  DynamicDiscoveryConfig,
} from '../src/dynamic-discovery';

describe('Dynamic Tool Discovery', () => {
  const sampleTools: ToolInfo[] = [
    { name: 'search', description: 'Search the web for information', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'read_file', description: 'Read a file from disk', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'write_file', description: 'Write content to a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
    { name: 'list_files', description: 'List files in a directory', inputSchema: { type: 'object', properties: { dir: { type: 'string' } } } },
    { name: 'execute_sql', description: 'Execute a SQL query against the database', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'send_email', description: 'Send an email message', inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } } } },
  ];

  const config: DynamicDiscoveryConfig = {
    defaultCreditsPerCall: 1,
    toolPricing: {
      search: { creditsPerCall: 5, rateLimitPerMin: 30 },
      execute_sql: { creditsPerCall: 10 },
    },
    globalRateLimitPerMin: 60,
  };

  describe('getMetaTools', () => {
    it('should return exactly 3 meta-tools', () => {
      const tools = getMetaTools();
      expect(tools).toHaveLength(3);
    });

    it('should return paygate_list_tools', () => {
      const tools = getMetaTools();
      const listTool = tools.find(t => t.name === 'paygate_list_tools');
      expect(listTool).toBeDefined();
      expect(listTool!.description).toContain('List all available tools');
      expect(listTool!.inputSchema).toBeDefined();
      expect(listTool!.inputSchema.properties).toHaveProperty('cursor');
      expect(listTool!.inputSchema.properties).toHaveProperty('pageSize');
    });

    it('should return paygate_search_tools', () => {
      const tools = getMetaTools();
      const searchTool = tools.find(t => t.name === 'paygate_search_tools');
      expect(searchTool).toBeDefined();
      expect(searchTool!.description).toContain('Search for tools');
      expect(searchTool!.inputSchema).toBeDefined();
      expect(searchTool!.inputSchema.required).toContain('query');
    });

    it('should return paygate_call_tool', () => {
      const tools = getMetaTools();
      const callTool = tools.find(t => t.name === 'paygate_call_tool');
      expect(callTool).toBeDefined();
      expect(callTool!.description).toContain('Call any available tool');
      expect(callTool!.inputSchema).toBeDefined();
      expect(callTool!.inputSchema.required).toContain('name');
    });
  });

  describe('isMetaTool', () => {
    it('should return true for meta-tool names', () => {
      expect(isMetaTool('paygate_list_tools')).toBe(true);
      expect(isMetaTool('paygate_search_tools')).toBe(true);
      expect(isMetaTool('paygate_call_tool')).toBe(true);
    });

    it('should return false for regular tool names', () => {
      expect(isMetaTool('search')).toBe(false);
      expect(isMetaTool('read_file')).toBe(false);
      expect(isMetaTool('paygate_other')).toBe(false);
    });
  });

  describe('handleMetaToolCall — paygate_list_tools', () => {
    it('should list all tools with pricing', () => {
      const result = handleMetaToolCall('paygate_list_tools', {}, sampleTools, config);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!.content[0].text);
      expect(parsed.tools).toHaveLength(6);
      expect(parsed.total).toBe(6);
    });

    it('should include correct pricing for tools', () => {
      const result = handleMetaToolCall('paygate_list_tools', {}, sampleTools, config);
      const parsed = JSON.parse(result!.content[0].text);
      const searchEntry = parsed.tools.find((t: any) => t.name === 'search');
      expect(searchEntry.creditsPerCall).toBe(5);
      expect(searchEntry.rateLimitPerMin).toBe(30);

      const readEntry = parsed.tools.find((t: any) => t.name === 'read_file');
      expect(readEntry.creditsPerCall).toBe(1); // default
      expect(readEntry.rateLimitPerMin).toBe(60); // global default
    });

    it('should support pagination with cursor', () => {
      const result1 = handleMetaToolCall('paygate_list_tools', { pageSize: 2 }, sampleTools, config);
      const parsed1 = JSON.parse(result1!.content[0].text);
      expect(parsed1.tools).toHaveLength(2);
      expect(parsed1.total).toBe(6);
      expect(parsed1.nextCursor).toBe('2');

      const result2 = handleMetaToolCall('paygate_list_tools', { pageSize: 2, cursor: '2' }, sampleTools, config);
      const parsed2 = JSON.parse(result2!.content[0].text);
      expect(parsed2.tools).toHaveLength(2);
      expect(parsed2.nextCursor).toBe('4');

      const result3 = handleMetaToolCall('paygate_list_tools', { pageSize: 2, cursor: '4' }, sampleTools, config);
      const parsed3 = JSON.parse(result3!.content[0].text);
      expect(parsed3.tools).toHaveLength(2);
      expect(parsed3.nextCursor).toBeUndefined();
    });

    it('should clamp pageSize to max 200', () => {
      const result = handleMetaToolCall('paygate_list_tools', { pageSize: 500 }, sampleTools, config);
      const parsed = JSON.parse(result!.content[0].text);
      expect(parsed.pageSize).toBe(200);
    });

    it('should default pageSize to 50', () => {
      const result = handleMetaToolCall('paygate_list_tools', {}, sampleTools, config);
      const parsed = JSON.parse(result!.content[0].text);
      expect(parsed.pageSize).toBe(50);
    });

    it('should handle empty tool list', () => {
      const result = handleMetaToolCall('paygate_list_tools', {}, [], config);
      const parsed = JSON.parse(result!.content[0].text);
      expect(parsed.tools).toHaveLength(0);
      expect(parsed.total).toBe(0);
    });

    it('should show unlimited for tools with 0 rate limit', () => {
      const unlimitedConfig: DynamicDiscoveryConfig = {
        ...config,
        globalRateLimitPerMin: 0,
      };
      const result = handleMetaToolCall('paygate_list_tools', {}, [sampleTools[1]], unlimitedConfig);
      const parsed = JSON.parse(result!.content[0].text);
      expect(parsed.tools[0].rateLimitPerMin).toBe('unlimited');
    });
  });

  describe('handleMetaToolCall — paygate_search_tools', () => {
    it('should find tools by name', () => {
      const result = handleMetaToolCall('paygate_search_tools', { query: 'file' }, sampleTools, config);
      const parsed = JSON.parse(result!.content[0].text);
      expect(parsed.matches.length).toBeGreaterThanOrEqual(3); // read_file, write_file, list_files
      expect(parsed.matches.map((m: any) => m.name)).toContain('read_file');
      expect(parsed.matches.map((m: any) => m.name)).toContain('write_file');
      expect(parsed.matches.map((m: any) => m.name)).toContain('list_files');
    });

    it('should find tools by description', () => {
      const result = handleMetaToolCall('paygate_search_tools', { query: 'database' }, sampleTools, config);
      const parsed = JSON.parse(result!.content[0].text);
      expect(parsed.matches.length).toBeGreaterThanOrEqual(1);
      expect(parsed.matches[0].name).toBe('execute_sql');
    });

    it('should score name matches higher than description matches', () => {
      const result = handleMetaToolCall('paygate_search_tools', { query: 'search' }, sampleTools, config);
      const parsed = JSON.parse(result!.content[0].text);
      expect(parsed.matches[0].name).toBe('search'); // name match first
    });

    it('should return empty for no matches', () => {
      const result = handleMetaToolCall('paygate_search_tools', { query: 'nonexistent_xyz' }, sampleTools, config);
      const parsed = JSON.parse(result!.content[0].text);
      expect(parsed.matches).toHaveLength(0);
    });

    it('should require query parameter', () => {
      const result = handleMetaToolCall('paygate_search_tools', {}, sampleTools, config);
      const parsed = JSON.parse(result!.content[0].text);
      expect(parsed.error).toBe('query is required');
      expect(parsed.matches).toHaveLength(0);
    });

    it('should include schemas when requested', () => {
      const result = handleMetaToolCall('paygate_search_tools', { query: 'search', includeSchema: true }, sampleTools, config);
      const parsed = JSON.parse(result!.content[0].text);
      const match = parsed.matches.find((m: any) => m.name === 'search');
      expect(match.inputSchema).toBeDefined();
      expect(match.inputSchema.type).toBe('object');
    });

    it('should not include schemas by default', () => {
      const result = handleMetaToolCall('paygate_search_tools', { query: 'search' }, sampleTools, config);
      const parsed = JSON.parse(result!.content[0].text);
      const match = parsed.matches.find((m: any) => m.name === 'search');
      expect(match.inputSchema).toBeUndefined();
    });

    it('should cap results at 20', () => {
      // Create 30 tools
      const manyTools: ToolInfo[] = Array.from({ length: 30 }, (_, i) => ({
        name: `tool_${i}`,
        description: `Generic tool number ${i}`,
      }));
      const result = handleMetaToolCall('paygate_search_tools', { query: 'tool' }, manyTools, config);
      const parsed = JSON.parse(result!.content[0].text);
      expect(parsed.matches.length).toBeLessThanOrEqual(20);
    });

    it('should support multi-word search', () => {
      const result = handleMetaToolCall('paygate_search_tools', { query: 'read disk' }, sampleTools, config);
      const parsed = JSON.parse(result!.content[0].text);
      expect(parsed.matches.length).toBeGreaterThanOrEqual(1);
      expect(parsed.matches[0].name).toBe('read_file');
    });

    it('should include pricing in search results', () => {
      const result = handleMetaToolCall('paygate_search_tools', { query: 'search' }, sampleTools, config);
      const parsed = JSON.parse(result!.content[0].text);
      const match = parsed.matches.find((m: any) => m.name === 'search');
      expect(match.creditsPerCall).toBe(5);
      expect(match.rateLimitPerMin).toBe(30);
    });
  });

  describe('handleMetaToolCall — unknown tool', () => {
    it('should return null for non-meta-tool names', () => {
      const result = handleMetaToolCall('search', {}, sampleTools, config);
      expect(result).toBeNull();
    });

    it('should return null for paygate_call_tool (handled separately)', () => {
      const result = handleMetaToolCall('paygate_call_tool', { name: 'search' }, sampleTools, config);
      expect(result).toBeNull();
    });
  });

  describe('result format', () => {
    it('should return content array with text type', () => {
      const result = handleMetaToolCall('paygate_list_tools', {}, sampleTools, config);
      expect(result!.content).toHaveLength(1);
      expect(result!.content[0].type).toBe('text');
      expect(() => JSON.parse(result!.content[0].text)).not.toThrow();
    });

    it('should return valid JSON in text content', () => {
      const result = handleMetaToolCall('paygate_search_tools', { query: 'search' }, sampleTools, config);
      expect(result!.content).toHaveLength(1);
      expect(result!.content[0].type).toBe('text');
      const parsed = JSON.parse(result!.content[0].text);
      expect(parsed).toHaveProperty('query');
      expect(parsed).toHaveProperty('matches');
      expect(parsed).toHaveProperty('total');
    });
  });
});
