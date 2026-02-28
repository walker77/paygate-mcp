/**
 * CLI Init Wizard — Interactive setup for paygate-mcp.
 *
 * Generates a paygate.json config file with guided prompts.
 * Uses only Node.js built-in readline — zero dependencies.
 */

import { createInterface, Interface } from 'readline';
import { writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ─── Readline helpers ─────────────────────────────────────────────────────────

function createRl(): Interface {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl: Interface, question: string, defaultValue?: string): Promise<string> {
  const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function askYesNo(rl: Interface, question: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  return new Promise((resolve) => {
    rl.question(`${question} ${hint}: `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (!a) return resolve(defaultYes);
      resolve(a === 'y' || a === 'yes');
    });
  });
}

function askChoice(rl: Interface, question: string, choices: string[], defaultIndex = 0): Promise<string> {
  return new Promise((resolve) => {
    console.log(`\n  ${question}`);
    choices.forEach((c, i) => {
      const marker = i === defaultIndex ? '>' : ' ';
      console.log(`  ${marker} ${i + 1}. ${c}`);
    });
    rl.question(`  Choice [${defaultIndex + 1}]: `, (answer) => {
      const idx = parseInt(answer.trim(), 10) - 1;
      if (idx >= 0 && idx < choices.length) {
        resolve(choices[idx]);
      } else {
        resolve(choices[defaultIndex]);
      }
    });
  });
}

// ─── Templates ────────────────────────────────────────────────────────────────

interface InitTemplate {
  name: string;
  description: string;
  serverCommand: string;
  serverArgs: string[];
  defaultPrice: number;
  rateLimit: number;
}

const TEMPLATES: InitTemplate[] = [
  {
    name: 'filesystem',
    description: 'Wrap the MCP filesystem server',
    serverCommand: 'npx',
    serverArgs: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    defaultPrice: 1,
    rateLimit: 60,
  },
  {
    name: 'custom-stdio',
    description: 'Wrap a custom stdio MCP server',
    serverCommand: '',
    serverArgs: [],
    defaultPrice: 1,
    rateLimit: 60,
  },
  {
    name: 'remote-http',
    description: 'Gate a remote MCP server (Streamable HTTP)',
    serverCommand: '',
    serverArgs: [],
    defaultPrice: 1,
    rateLimit: 60,
  },
];

// ─── Init Command ─────────────────────────────────────────────────────────────

export async function runInit(flags: Record<string, string>): Promise<void> {
  const outputPath = resolve(flags['output'] || flags['o'] || 'paygate.json');

  // Check if file already exists
  if (existsSync(outputPath) && !flags['force']) {
    console.error(`\n  Error: ${outputPath} already exists. Use --force to overwrite.\n`);
    process.exit(1);
  }

  console.log(`
  ╔══════════════════════════════════════════════════╗
  ║       PayGate MCP — Interactive Setup            ║
  ║       Monetize any MCP server in seconds         ║
  ╚══════════════════════════════════════════════════╝
  `);

  const rl = createRl();

  try {
    // Step 1: Choose template
    const templateChoice = await askChoice(
      rl,
      'What type of MCP server do you want to gate?',
      TEMPLATES.map(t => `${t.name} — ${t.description}`),
      0,
    );
    const templateIdx = TEMPLATES.findIndex(t => templateChoice.startsWith(t.name));
    const template = TEMPLATES[templateIdx >= 0 ? templateIdx : 0];

    const config: Record<string, any> = {};

    // Step 2: Server command or remote URL
    if (template.name === 'remote-http') {
      const url = await ask(rl, 'Remote MCP server URL', 'https://my-server.example.com/mcp');
      config.remoteUrl = url;
    } else if (template.name === 'filesystem') {
      const dir = await ask(rl, 'Directory to serve', '/tmp');
      config.serverCommand = 'npx';
      config.serverArgs = ['-y', '@modelcontextprotocol/server-filesystem', dir];
    } else {
      const cmd = await ask(rl, 'Server command (e.g., "node server.js" or "python server.py")');
      if (!cmd) {
        console.error('\n  Error: server command is required.\n');
        process.exit(1);
      }
      const parts = cmd.split(/\s+/);
      config.serverCommand = parts[0];
      config.serverArgs = parts.slice(1);
    }

    // Step 3: Port
    const portStr = await ask(rl, 'Port', '3402');
    config.port = parseInt(portStr, 10) || 3402;

    // Step 4: Pricing
    const priceStr = await ask(rl, 'Default credits per tool call', String(template.defaultPrice));
    config.defaultCreditsPerCall = parseInt(priceStr, 10) || 1;

    // Step 5: Rate limit
    const rateStr = await ask(rl, 'Rate limit (calls/min per key, 0=unlimited)', String(template.rateLimit));
    config.globalRateLimitPerMin = parseInt(rateStr, 10);

    // Step 6: Shadow mode
    const shadow = await askYesNo(rl, 'Enable shadow mode? (log without enforcing)', false);
    if (shadow) {
      config.shadowMode = true;
    }

    // Step 7: State persistence
    const persist = await askYesNo(rl, 'Persist state to disk? (survives restarts)', true);
    if (persist) {
      const stateFile = await ask(rl, 'State file path', 'paygate-state.json');
      config.stateFile = stateFile;
    }

    // Step 8: Stripe integration
    const stripe = await askYesNo(rl, 'Enable Stripe integration for credit purchases?', false);
    if (stripe) {
      const stripeSecret = await ask(rl, 'Stripe webhook signing secret (whsec_...)');
      if (stripeSecret) {
        config.stripeWebhookSecret = stripeSecret;
      }
      // Add credit packages placeholder
      config.creditPackages = [
        { id: 'starter', credits: 100, priceInCents: 999, currency: 'usd', name: 'Starter Pack' },
        { id: 'pro', credits: 1000, priceInCents: 4999, currency: 'usd', name: 'Pro Pack' },
      ];
    }

    // Step 9: Webhook
    const webhook = await askYesNo(rl, 'Send usage events to a webhook?', false);
    if (webhook) {
      const webhookUrl = await ask(rl, 'Webhook URL');
      if (webhookUrl) {
        config.webhookUrl = webhookUrl;
        const webhookSecret = await ask(rl, 'Webhook HMAC secret (optional)');
        if (webhookSecret) {
          config.webhookSecret = webhookSecret;
        }
      }
    }

    // Step 10: Log format
    const jsonLogs = await askYesNo(rl, 'Use JSON log format? (recommended for production)', false);
    if (jsonLogs) {
      config.logFormat = 'json';
    }

    // Write config file
    const configJson = JSON.stringify(config, null, 2);
    writeFileSync(outputPath, configJson + '\n', 'utf-8');

    console.log(`
  ✓ Config written to ${outputPath}

  Next steps:
    1. Start PayGate:
       paygate-mcp wrap --config ${outputPath.endsWith('paygate.json') ? 'paygate.json' : outputPath}

    2. Create an API key:
       curl -X POST http://localhost:${config.port}/keys \\
         -H "X-Admin-Key: <admin-key>" \\
         -H "Content-Type: application/json" \\
         -d '{"name":"my-client","credits":100}'

    3. Make a tool call:
       curl http://localhost:${config.port}/mcp \\
         -H "X-API-Key: <api-key>" \\
         -H "Content-Type: application/json" \\
         -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"tool_name","arguments":{}},"id":1}'

  Admin dashboard: http://localhost:${config.port}/dashboard
  API docs:        http://localhost:${config.port}/docs
  `);
  } finally {
    rl.close();
  }
}
