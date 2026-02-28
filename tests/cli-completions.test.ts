import { generateCompletions } from '../src/cli-completions';

describe('CLI Completions', () => {
  describe('generateCompletions', () => {
    it('should generate bash completions', () => {
      const result = generateCompletions('bash');
      expect(result).toContain('_paygate_mcp');
      expect(result).toContain('complete -F _paygate_mcp paygate-mcp');
      expect(result).toContain('wrap');
      expect(result).toContain('init');
      expect(result).toContain('validate');
      expect(result).toContain('completions');
      expect(result).toContain('version');
      expect(result).toContain('help');
      expect(result).toContain('--server');
      expect(result).toContain('--discovery');
      expect(result).toContain('static dynamic');
    });

    it('should generate zsh completions', () => {
      const result = generateCompletions('zsh');
      expect(result).toContain('#compdef paygate-mcp');
      expect(result).toContain('_paygate_mcp');
      expect(result).toContain('wrap:Start a payment-gated MCP proxy');
      expect(result).toContain('init:Interactive setup wizard');
      expect(result).toContain('completions:Generate shell completions');
      expect(result).toContain("'--server[MCP server command to wrap]");
      expect(result).toContain('--discovery');
      expect(result).toContain('(static dynamic)');
      expect(result).toContain('1:shell:(bash zsh fish)');
    });

    it('should generate fish completions', () => {
      const result = generateCompletions('fish');
      expect(result).toContain('complete -c paygate-mcp');
      expect(result).toContain('__fish_use_subcommand');
      expect(result).toContain('"wrap"');
      expect(result).toContain('"init"');
      expect(result).toContain('"validate"');
      expect(result).toContain('--discovery');
      expect(result).toContain('static dynamic');
    });

    it('should be case-insensitive for shell name', () => {
      expect(() => generateCompletions('BASH')).not.toThrow();
      expect(() => generateCompletions('Zsh')).not.toThrow();
      expect(() => generateCompletions('FISH')).not.toThrow();
    });

    it('should throw for unsupported shell', () => {
      expect(() => generateCompletions('powershell')).toThrow('Unsupported shell: powershell');
      expect(() => generateCompletions('csh')).toThrow('Unsupported shell: csh');
    });

    it('should include all wrap flags in bash completions', () => {
      const result = generateCompletions('bash');
      const requiredFlags = [
        '--server', '--remote-url', '--config', '--port', '--price',
        '--rate-limit', '--name', '--shadow', '--admin-key', '--tool-price',
        '--import-key', '--state-file', '--stripe-secret', '--webhook-url',
        '--dry-run', '--log-level', '--log-format', '--json', '--discovery',
      ];
      for (const flag of requiredFlags) {
        expect(result).toContain(flag);
      }
    });

    it('should include init flags in bash completions', () => {
      const result = generateCompletions('bash');
      expect(result).toContain('--output');
      expect(result).toContain('--force');
    });

    it('should include validate flags in bash completions', () => {
      const result = generateCompletions('bash');
      expect(result).toContain('validate');
      expect(result).toContain('--config');
    });

    it('should include log level options in bash completions', () => {
      const result = generateCompletions('bash');
      expect(result).toContain('debug');
      expect(result).toContain('info');
      expect(result).toContain('warn');
      expect(result).toContain('error');
      expect(result).toContain('silent');
    });

    it('should include file completion for --config in bash', () => {
      const result = generateCompletions('bash');
      expect(result).toContain('--config|--state-file|--output');
      expect(result).toContain('compgen -f');
    });

    it('should include _files in zsh for file arguments', () => {
      const result = generateCompletions('zsh');
      expect(result).toContain(':file:_files');
    });
  });
});
