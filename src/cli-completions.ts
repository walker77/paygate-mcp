/**
 * Shell Completions — Generate tab completion scripts for bash, zsh, and fish.
 *
 * Usage:
 *   paygate-mcp completions bash  > ~/.local/share/bash-completion/completions/paygate-mcp
 *   paygate-mcp completions zsh   > ~/.zfunc/_paygate-mcp
 *   paygate-mcp completions fish  > ~/.config/fish/completions/paygate-mcp.fish
 */

const COMMANDS = ['wrap', 'init', 'validate', 'completions', 'version', 'help'];

const WRAP_FLAGS = [
  '--server', '--remote-url', '--config', '--port', '--price',
  '--rate-limit', '--name', '--shadow', '--admin-key', '--tool-price',
  '--import-key', '--state-file', '--stripe-secret', '--webhook-url',
  '--webhook-secret', '--webhook-retries', '--refund-on-failure',
  '--redis-url', '--header', '--trusted-proxies', '--dry-run',
  '--log-level', '--log-format', '--request-timeout', '--headers-timeout',
  '--keepalive-timeout', '--max-requests-per-socket', '--admin-rate-limit',
  '--discovery', '--json',
];

const INIT_FLAGS = ['--output', '--force'];

const VALIDATE_FLAGS = ['--config', '--json'];

const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'];
const LOG_FORMATS = ['text', 'json'];

export function generateCompletions(shell: string): string {
  switch (shell.toLowerCase()) {
    case 'bash': return generateBash();
    case 'zsh': return generateZsh();
    case 'fish': return generateFish();
    default:
      throw new Error(`Unsupported shell: ${shell}. Supported: bash, zsh, fish`);
  }
}

function generateBash(): string {
  return `# paygate-mcp bash completion
# Install: paygate-mcp completions bash > ~/.local/share/bash-completion/completions/paygate-mcp
# Or:      paygate-mcp completions bash >> ~/.bashrc

_paygate_mcp() {
  local cur prev words cword
  _init_completion || return

  local commands="${COMMANDS.join(' ')}"
  local wrap_flags="${WRAP_FLAGS.join(' ')}"
  local init_flags="${INIT_FLAGS.join(' ')}"
  local validate_flags="${VALIDATE_FLAGS.join(' ')}"
  local log_levels="${LOG_LEVELS.join(' ')}"
  local log_formats="${LOG_FORMATS.join(' ')}"
  local shells="bash zsh fish"

  # Complete commands at position 1
  if [[ \${cword} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
    return
  fi

  local cmd="\${words[1]}"

  # Complete based on previous flag
  case "\${prev}" in
    --log-level)
      COMPREPLY=( $(compgen -W "\${log_levels}" -- "\${cur}") )
      return
      ;;
    --log-format)
      COMPREPLY=( $(compgen -W "\${log_formats}" -- "\${cur}") )
      return
      ;;
    --config|--state-file|--output)
      COMPREPLY=( $(compgen -f -- "\${cur}") )
      return
      ;;
    --discovery)
      COMPREPLY=( $(compgen -W "static dynamic" -- "\${cur}") )
      return
      ;;
  esac

  # Complete flags based on command
  case "\${cmd}" in
    wrap)
      COMPREPLY=( $(compgen -W "\${wrap_flags}" -- "\${cur}") )
      ;;
    init)
      COMPREPLY=( $(compgen -W "\${init_flags}" -- "\${cur}") )
      ;;
    validate)
      COMPREPLY=( $(compgen -W "\${validate_flags}" -- "\${cur}") )
      ;;
    completions)
      COMPREPLY=( $(compgen -W "\${shells}" -- "\${cur}") )
      ;;
  esac
}

complete -F _paygate_mcp paygate-mcp
`;
}

function generateZsh(): string {
  const wrapFlagDefs = WRAP_FLAGS.map(f => `'${f}[${flagDescription(f)}]'`).join('\n      ');
  return `#compdef paygate-mcp
# paygate-mcp zsh completion
# Install: paygate-mcp completions zsh > ~/.zfunc/_paygate-mcp
# Then add: fpath=(~/.zfunc $fpath) and run: compinit

_paygate_mcp() {
  local -a commands
  commands=(
    'wrap:Start a payment-gated MCP proxy'
    'init:Interactive setup wizard'
    'validate:Validate a config file'
    'completions:Generate shell completions'
    'version:Print version'
    'help:Show help'
  )

  _arguments -C \\
    '1:command:->command' \\
    '*::arg:->args'

  case $state in
    command)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        wrap)
          _arguments \\
            '--server[MCP server command to wrap]:command:' \\
            '--remote-url[Remote MCP server URL]:url:' \\
            '--config[Config file path]:file:_files' \\
            '--port[HTTP port]:port:' \\
            '--price[Default credits per call]:credits:' \\
            '--rate-limit[Max calls/min per key]:limit:' \\
            '--name[Server display name]:name:' \\
            '--shadow[Shadow mode]' \\
            '--admin-key[Admin key]:key:' \\
            '--tool-price[Per-tool pricing]:pricing:' \\
            '--state-file[State persistence file]:file:_files' \\
            '--stripe-secret[Stripe webhook secret]:secret:' \\
            '--webhook-url[Webhook URL]:url:' \\
            '--webhook-secret[Webhook HMAC secret]:secret:' \\
            '--redis-url[Redis URL]:url:' \\
            '--dry-run[Discover tools and exit]' \\
            '--log-level[Log level]:level:(debug info warn error silent)' \\
            '--log-format[Log format]:format:(text json)' \\
            '--json[JSON output mode]' \\
            '--refund-on-failure[Refund on downstream failure]' \\
            '--discovery[Tool discovery mode]:mode:(static dynamic)'
          ;;
        init)
          _arguments \\
            '--output[Output file path]:file:_files' \\
            '--force[Overwrite existing file]'
          ;;
        validate)
          _arguments \\
            '--config[Config file path]:file:_files' \\
            '--json[JSON output mode]'
          ;;
        completions)
          _arguments '1:shell:(bash zsh fish)'
          ;;
      esac
      ;;
  esac
}

_paygate_mcp "$@"
`;
}

function generateFish(): string {
  return `# paygate-mcp fish completion
# Install: paygate-mcp completions fish > ~/.config/fish/completions/paygate-mcp.fish

# Disable file completions by default
complete -c paygate-mcp -f

# Commands
complete -c paygate-mcp -n "__fish_use_subcommand" -a "wrap" -d "Start a payment-gated MCP proxy"
complete -c paygate-mcp -n "__fish_use_subcommand" -a "init" -d "Interactive setup wizard"
complete -c paygate-mcp -n "__fish_use_subcommand" -a "validate" -d "Validate a config file"
complete -c paygate-mcp -n "__fish_use_subcommand" -a "completions" -d "Generate shell completions"
complete -c paygate-mcp -n "__fish_use_subcommand" -a "version" -d "Print version"
complete -c paygate-mcp -n "__fish_use_subcommand" -a "help" -d "Show help"

# wrap flags
${WRAP_FLAGS.map(f => `complete -c paygate-mcp -n "__fish_seen_subcommand_from wrap" -l "${f.slice(2)}" -d "${flagDescription(f)}"`).join('\n')}

# init flags
complete -c paygate-mcp -n "__fish_seen_subcommand_from init" -l "output" -d "Output file path" -r -F
complete -c paygate-mcp -n "__fish_seen_subcommand_from init" -l "force" -d "Overwrite existing file"

# validate flags
complete -c paygate-mcp -n "__fish_seen_subcommand_from validate" -l "config" -d "Config file path" -r -F
complete -c paygate-mcp -n "__fish_seen_subcommand_from validate" -l "json" -d "JSON output mode"

# completions shells
complete -c paygate-mcp -n "__fish_seen_subcommand_from completions" -a "bash zsh fish"

# log-level values
complete -c paygate-mcp -n "__fish_seen_subcommand_from wrap; and __fish_prev_arg_in --log-level" -a "debug info warn error silent"

# log-format values
complete -c paygate-mcp -n "__fish_seen_subcommand_from wrap; and __fish_prev_arg_in --log-format" -a "text json"

# discovery mode values
complete -c paygate-mcp -n "__fish_seen_subcommand_from wrap; and __fish_prev_arg_in --discovery" -a "static dynamic"
`;
}

function flagDescription(flag: string): string {
  const descriptions: Record<string, string> = {
    '--server': 'MCP server command',
    '--remote-url': 'Remote MCP server URL',
    '--config': 'Config file path',
    '--port': 'HTTP port',
    '--price': 'Default credits per call',
    '--rate-limit': 'Max calls/min per key',
    '--name': 'Server display name',
    '--shadow': 'Shadow mode',
    '--admin-key': 'Admin key',
    '--tool-price': 'Per-tool pricing',
    '--import-key': 'Import API key with credits',
    '--state-file': 'State persistence file',
    '--stripe-secret': 'Stripe webhook secret',
    '--webhook-url': 'Webhook URL',
    '--webhook-secret': 'Webhook HMAC secret',
    '--webhook-retries': 'Max webhook retries',
    '--refund-on-failure': 'Refund on downstream failure',
    '--redis-url': 'Redis URL',
    '--header': 'Custom response header',
    '--trusted-proxies': 'Trusted proxy IPs',
    '--dry-run': 'Discover tools and exit',
    '--log-level': 'Log level',
    '--log-format': 'Log format',
    '--request-timeout': 'Max request time (ms)',
    '--headers-timeout': 'Max header receive time (ms)',
    '--keepalive-timeout': 'Idle connection timeout (ms)',
    '--max-requests-per-socket': 'Max requests per socket',
    '--admin-rate-limit': 'Admin rate limit per IP',
    '--json': 'JSON output mode',
    '--discovery': 'Tool discovery mode (static/dynamic)',
  };
  return descriptions[flag] || flag.slice(2);
}
