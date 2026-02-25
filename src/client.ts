/**
 * PayGateClient — Client SDK for consuming PayGate-protected MCP servers.
 *
 * Features:
 *   - Auto 402 retry: when a tool call returns -32402 (payment required),
 *     the client can automatically call a top-up function and retry.
 *   - Balance tracking: monitors remaining credits locally.
 *   - Connection management: handles MCP Streamable HTTP transport.
 *
 * @example
 * ```ts
 * import { PayGateClient } from 'paygate-mcp/client';
 *
 * const client = new PayGateClient({
 *   url: 'http://localhost:3402',
 *   apiKey: 'pg_abc123...',
 * });
 *
 * const tools = await client.listTools();
 * const result = await client.callTool('search', { query: 'hello' });
 * const balance = await client.getBalance();
 * ```
 */

import * as http from 'http';
import * as https from 'https';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PayGateClientConfig {
  /** PayGate server URL (e.g., "http://localhost:3402") */
  url: string;
  /** API key for authentication */
  apiKey: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Auto-retry on 402 (payment required). Calls onCreditsNeeded before retry.
   *  Default: false. */
  autoRetry?: boolean;
  /** Called when credits are needed (402 response). Return true if credits
   *  were added (e.g., via external top-up), false to abort. */
  onCreditsNeeded?: (info: CreditsNeededInfo) => Promise<boolean>;
  /** Max auto-retries per request (default: 1) */
  maxRetries?: number;
}

export interface CreditsNeededInfo {
  tool: string;
  creditsRequired: number;
  remainingCredits: number;
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ToolCallResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
}

export interface BalanceInfo {
  name: string;
  credits: number;
  totalSpent: number;
  totalCalls: number;
  spendingLimit: number;
  remainingBudget: number | null;
  lastUsedAt: string | null;
  allowedTools: string[];
  deniedTools: string[];
  expiresAt: string | null;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class PayGateClient {
  private readonly baseUrl: URL;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly autoRetry: boolean;
  private readonly maxRetries: number;
  private readonly onCreditsNeeded?: (info: CreditsNeededInfo) => Promise<boolean>;
  private nextId = 1;
  private _lastBalance: number | null = null;

  constructor(config: PayGateClientConfig) {
    this.baseUrl = new URL(config.url);
    this.apiKey = config.apiKey;
    this.timeout = config.timeout || 30_000;
    this.autoRetry = config.autoRetry || false;
    this.maxRetries = config.maxRetries || 1;
    this.onCreditsNeeded = config.onCreditsNeeded;
  }

  /**
   * List available tools from the gated MCP server.
   */
  async listTools(): Promise<ToolInfo[]> {
    const response = await this.rpcCall('tools/list', {});
    if (response.error) {
      throw new PayGateError(response.error.code, response.error.message, response.error.data);
    }
    const result = response.result as { tools?: ToolInfo[] };
    return result?.tools || [];
  }

  /**
   * Call a tool on the gated MCP server.
   * If autoRetry is enabled and the server returns -32402 (payment required),
   * the client will call onCreditsNeeded and retry.
   */
  async callTool(name: string, args?: Record<string, unknown>): Promise<ToolCallResult> {
    let retries = 0;

    while (true) {
      const response = await this.rpcCall('tools/call', { name, arguments: args || {} });

      if (response.error) {
        // Check if it's a payment-required error
        if (response.error.code === -32402 && this.autoRetry && retries < this.maxRetries) {
          const data = response.error.data as { creditsRequired?: number; remainingCredits?: number } | undefined;
          const creditsRequired = data?.creditsRequired || 0;
          const remainingCredits = data?.remainingCredits || 0;

          if (this.onCreditsNeeded) {
            const shouldRetry = await this.onCreditsNeeded({
              tool: name,
              creditsRequired,
              remainingCredits,
            });

            if (shouldRetry) {
              retries++;
              continue;
            }
          }
        }

        throw new PayGateError(response.error.code, response.error.message, response.error.data);
      }

      const result = response.result as ToolCallResult;
      return result;
    }
  }

  /**
   * Get balance information for the current API key.
   */
  async getBalance(): Promise<BalanceInfo> {
    const response = await this.httpGet('/balance');
    const balance = response as unknown as BalanceInfo;
    this._lastBalance = balance.credits;
    return balance;
  }

  /**
   * Send an initialize request to the MCP server.
   */
  async initialize(): Promise<Record<string, unknown>> {
    const response = await this.rpcCall('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'paygate-client', version: '1.0.0' },
    });
    if (response.error) {
      throw new PayGateError(response.error.code, response.error.message, response.error.data);
    }
    return response.result as Record<string, unknown>;
  }

  /**
   * Ping the server.
   */
  async ping(): Promise<boolean> {
    const response = await this.rpcCall('ping', {});
    return !response.error;
  }

  /**
   * Get the last known balance (from the last getBalance() call).
   * Returns null if getBalance() hasn't been called yet.
   */
  get lastKnownBalance(): number | null {
    return this._lastBalance;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private async rpcCall(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });

    const responseBody = await this.httpPost('/mcp', body, {
      'Content-Type': 'application/json',
      'X-API-Key': this.apiKey,
    });

    return JSON.parse(responseBody) as JsonRpcResponse;
  }

  private httpPost(path: string, body: string, headers: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const isHttps = this.baseUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const options: http.RequestOptions = {
        hostname: this.baseUrl.hostname,
        port: this.baseUrl.port || (isHttps ? 443 : 80),
        path,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': String(Buffer.byteLength(body)),
        },
        timeout: this.timeout,
      };

      const req = transport.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve(data));
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timed out after ${this.timeout}ms`));
      });

      req.write(body);
      req.end();
    });
  }

  private httpGet(path: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const isHttps = this.baseUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const options: http.RequestOptions = {
        hostname: this.baseUrl.hostname,
        port: this.baseUrl.port || (isHttps ? 443 : 80),
        path,
        method: 'GET',
        headers: {
          'X-API-Key': this.apiKey,
        },
        timeout: this.timeout,
      };

      const req = transport.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON response: ${data.slice(0, 100)}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timed out after ${this.timeout}ms`));
      });

      req.end();
    });
  }
}

// ─── Error class ──────────────────────────────────────────────────────────

export class PayGateError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'PayGateError';
    this.code = code;
    this.data = data;
  }

  get isPaymentRequired(): boolean {
    return this.code === -32402;
  }

  get isRateLimited(): boolean {
    return this.message.includes('rate_limit');
  }

  get isExpired(): boolean {
    return this.message.includes('expired');
  }
}
