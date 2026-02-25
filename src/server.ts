/**
 * PayGateServer — HTTP server that exposes the gated MCP proxy.
 *
 * Endpoints:
 *   POST /mcp     — JSON-RPC endpoint (MCP Streamable HTTP transport)
 *   GET  /status  — Dashboard / usage summary
 *   POST /keys    — Create API key
 *   GET  /keys    — List API keys
 *   POST /topup   — Add credits to a key
 *
 * API key is sent via X-API-Key header on /mcp endpoint.
 * Admin endpoints (/keys, /topup, /status) require X-Admin-Key header.
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { PayGateConfig, JsonRpcRequest, DEFAULT_CONFIG } from './types';
import { Gate } from './gate';
import { McpProxy } from './proxy';
import { HttpMcpProxy } from './http-proxy';

/** Max request body size: 1MB */
const MAX_BODY_SIZE = 1_048_576;

/** Union type for both proxy backends */
type ProxyBackend = McpProxy | HttpMcpProxy;

export class PayGateServer {
  readonly gate: Gate;
  readonly proxy: ProxyBackend;
  private server: Server | null = null;
  private readonly config: PayGateConfig;
  private readonly adminKey: string;

  constructor(
    config: Partial<PayGateConfig> & { serverCommand: string },
    adminKey?: string,
    statePath?: string,
    remoteUrl?: string,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.adminKey = adminKey || `admin_${require('crypto').randomBytes(16).toString('hex')}`;
    this.gate = new Gate(this.config, statePath);

    if (remoteUrl) {
      this.proxy = new HttpMcpProxy(this.gate, remoteUrl);
    } else {
      this.proxy = new McpProxy(this.gate, this.config.serverCommand, this.config.serverArgs);
    }
  }

  async start(): Promise<{ port: number; adminKey: string }> {
    await this.proxy.start();

    return new Promise((resolve, reject) => {
      this.server = createServer(async (req, res) => {
        try {
          await this.handleRequest(req, res);
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });

      this.server.listen(this.config.port, () => {
        resolve({ port: this.config.port, adminKey: this.adminKey });
      });

      this.server.on('error', reject);
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-Admin-Key');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url?.split('?')[0] || '/';

    switch (url) {
      case '/mcp':
        return this.handleMcp(req, res);
      case '/status':
        return this.handleStatus(req, res);
      case '/keys':
        if (req.method === 'POST') return this.handleCreateKey(req, res);
        if (req.method === 'GET') return this.handleListKeys(req, res);
        break;
      case '/topup':
        return this.handleTopUp(req, res);
      default:
        // Root — simple info
        if (url === '/' || url === '') {
          return this.handleRoot(req, res);
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  // ─── /mcp — JSON-RPC endpoint ───────────────────────────────────────────────

  private async handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const apiKey = (req.headers['x-api-key'] as string) || null;
    const body = await this.readBody(req);

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }));
      return;
    }

    const response = await this.proxy.handleRequest(request, apiKey);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  // ─── / — Root info ──────────────────────────────────────────────────────────

  private handleRoot(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: this.config.name,
      version: '0.1.0',
      endpoints: {
        mcp: 'POST /mcp — JSON-RPC (MCP transport). Send X-API-Key header.',
        status: 'GET /status — Usage dashboard (requires X-Admin-Key)',
        createKey: 'POST /keys — Create API key (requires X-Admin-Key)',
        listKeys: 'GET /keys — List API keys (requires X-Admin-Key)',
        topUp: 'POST /topup — Add credits (requires X-Admin-Key)',
      },
      shadowMode: this.config.shadowMode,
    }));
  }

  // ─── /status — Dashboard ────────────────────────────────────────────────────

  private handleStatus(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.gate.getStatus(), null, 2));
  }

  // ─── /keys — Create ─────────────────────────────────────────────────────────

  private async handleCreateKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.checkAdmin(req, res)) return;

    const body = await this.readBody(req);
    let params: { name?: string; credits?: number };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const name = String(params.name || 'unnamed').slice(0, 200);
    const credits = Math.max(0, Math.floor(Number(params.credits) || 100));

    if (credits <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Credits must be a positive integer' }));
      return;
    }

    const record = this.gate.store.createKey(name, credits);

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      key: record.key,
      name: record.name,
      credits: record.credits,
      message: 'Save this key — it cannot be retrieved later.',
    }));
  }

  // ─── /keys — List ───────────────────────────────────────────────────────────

  private handleListKeys(req: IncomingMessage, res: ServerResponse): void {
    if (!this.checkAdmin(req, res)) return;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.gate.store.listKeys(), null, 2));
  }

  // ─── /topup — Add credits ───────────────────────────────────────────────────

  private async handleTopUp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!this.checkAdmin(req, res)) return;

    const body = await this.readBody(req);
    let params: { key?: string; credits?: number };
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!params.key || !params.credits) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing key or credits' }));
      return;
    }

    const credits = Math.floor(Number(params.credits));
    if (!Number.isFinite(credits) || credits <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Credits must be a positive integer' }));
      return;
    }

    const success = this.gate.store.addCredits(params.key, credits);
    if (!success) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Key not found or inactive' }));
      return;
    }

    const record = this.gate.store.getKey(params.key);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ credits: record?.credits, message: `Added ${credits} credits` }));
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private checkAdmin(req: IncomingMessage, res: ServerResponse): boolean {
    const adminKey = req.headers['x-admin-key'] as string;
    if (adminKey !== this.adminKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid admin key' }));
      return false;
    }
    return true;
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_SIZE) {
          req.destroy();
          reject(new Error('Request body too large'));
          return;
        }
        body += chunk.toString();
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    await this.proxy.stop();
    this.gate.destroy();
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }
}
