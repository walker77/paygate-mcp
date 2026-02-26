/**
 * McpProxy — Spawns a wrapped MCP server (stdio) and proxies JSON-RPC
 * through the PayGate for tool-call gating.
 *
 * Architecture:
 *   HTTP Client <--JSON-RPC over HTTP--> PayGate Proxy <--stdio--> Wrapped MCP Server
 *
 * Free methods (initialize, tools/list, ping, etc.) pass through without auth.
 * tools/call requests are gated: API key + credits + rate limit.
 */

import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { JsonRpcRequest, JsonRpcResponse, ToolCallParams, BatchToolCall, BatchGateResult } from './types';
import { Gate } from './gate';

export class McpProxy extends EventEmitter {
  private process: ChildProcess | null = null;
  private readonly gate: Gate;
  private readonly serverCommand: string;
  private readonly serverArgs: string[];
  private pendingRequests = new Map<string | number, {
    resolve: (value: JsonRpcResponse) => void;
    reject: (error: Error) => void;
    startTime: number;
  }>();
  private buffer = '';
  private started = false;

  constructor(gate: Gate, serverCommand: string, serverArgs: string[]) {
    super();
    this.gate = gate;
    this.serverCommand = serverCommand;
    this.serverArgs = serverArgs;
  }

  /**
   * Start the wrapped MCP server process.
   */
  async start(): Promise<void> {
    if (this.started) return;

    this.process = spawn(this.serverCommand, this.serverArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.process.stdout!.on('data', (data: Buffer) => {
      this.handleServerOutput(data.toString());
    });

    this.process.stderr!.on('data', (data: Buffer) => {
      this.emit('server-stderr', data.toString());
    });

    this.process.on('exit', (code) => {
      this.started = false;
      this.emit('server-exit', code);
      // Reject all pending requests
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(new Error(`Server exited with code ${code}`));
      }
      this.pendingRequests.clear();
    });

    this.process.on('error', (error) => {
      this.emit('server-error', error);
    });

    this.started = true;
  }

  /**
   * Handle an incoming JSON-RPC request from the client.
   * Gates tools/call through the PayGate. Passes other methods through.
   */
  async handleRequest(request: JsonRpcRequest, apiKey: string | null, clientIp?: string): Promise<JsonRpcResponse> {
    if (!this.started || !this.process) {
      return this.errorResponse(request.id, -32603, 'Server not started');
    }

    // Free methods pass through without auth (but tools/list may be ACL-filtered)
    if (this.gate.isFreeMethod(request.method)) {
      const response = await this.forwardToServer(request);
      // Filter tools/list based on key ACL
      if (request.method === 'tools/list' && response.result && apiKey) {
        const result = response.result as { tools?: Array<{ name: string; [k: string]: unknown }> };
        if (result.tools && Array.isArray(result.tools)) {
          const filtered = this.gate.filterToolsForKey(apiKey, result.tools);
          if (filtered) {
            result.tools = filtered;
          }
        }
      }
      return response;
    }

    // tools/call — gate it
    if (request.method === 'tools/call') {
      const toolCall = request.params as unknown as ToolCallParams;
      if (!toolCall || !toolCall.name) {
        return this.errorResponse(request.id, -32602, 'Invalid tool call: missing tool name');
      }

      const decision = this.gate.evaluate(apiKey, toolCall, clientIp);

      if (!decision.allowed) {
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32402,
            message: `Payment required: ${decision.reason}`,
            data: {
              creditsRequired: this.gate.getToolPrice(toolCall.name),
              remainingCredits: decision.remainingCredits,
            },
          },
        };
      }

      // Allowed — forward to wrapped server
      const response = await this.forwardToServer(request);

      // Refund on failure: if the downstream tool call returned an error,
      // give the credits back (pre-execution deduction model).
      let refunded = false;
      if (response.error && this.gate.refundOnFailure && decision.creditsCharged > 0) {
        this.gate.refund(apiKey!, toolCall.name, decision.creditsCharged);
        refunded = true;
      }

      const remaining = refunded
        ? (this.gate.store.getKey(apiKey!)?.credits ?? decision.remainingCredits)
        : decision.remainingCredits;

      // Emit for observability
      this.emit('tool-call', {
        tool: toolCall.name,
        apiKey: apiKey?.slice(0, 10),
        creditsCharged: refunded ? 0 : decision.creditsCharged,
        remainingCredits: remaining,
        refunded,
      });

      return response;
    }

    // Unknown gated method — forward but log
    return this.forwardToServer(request);
  }

  /**
   * Handle a batch of tool calls (tools/call_batch).
   * All-or-nothing: pre-validates all calls, then executes in parallel.
   */
  async handleBatchRequest(
    calls: BatchToolCall[],
    batchId: string | number | undefined,
    apiKey: string | null,
    clientIp?: string,
  ): Promise<JsonRpcResponse> {
    if (!this.started || !this.process) {
      return this.errorResponse(batchId, -32603, 'Server not started');
    }

    if (!calls || calls.length === 0) {
      return this.errorResponse(batchId, -32602, 'Invalid batch: empty calls array');
    }

    // Pre-validate all calls via gate
    const batchResult = this.gate.evaluateBatch(apiKey, calls, clientIp);

    if (!batchResult.allAllowed) {
      return {
        jsonrpc: '2.0',
        id: batchId,
        error: {
          code: -32402,
          message: `Payment required: ${batchResult.reason}`,
          data: {
            failedIndex: batchResult.failedIndex,
            totalCreditsRequired: calls.reduce((sum, c) => sum + this.gate.getToolPrice(c.name, c.arguments), 0),
            remainingCredits: batchResult.remainingCredits,
          },
        },
      };
    }

    // All approved — execute each call in parallel
    const results = await Promise.all(calls.map((call, i) => {
      const req: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: `batch_${batchId}_${i}`,
        method: 'tools/call',
        params: { name: call.name, arguments: call.arguments },
      };
      return this.forwardToServer(req);
    }));

    // Refund on failure: if any downstream call errored, refund its credits
    let totalRefunded = 0;
    if (this.gate.refundOnFailure) {
      for (let i = 0; i < results.length; i++) {
        if (results[i].error && batchResult.decisions[i].creditsCharged > 0) {
          this.gate.refund(apiKey!, calls[i].name, batchResult.decisions[i].creditsCharged);
          totalRefunded += batchResult.decisions[i].creditsCharged;
        }
      }
    }

    const finalRemaining = this.gate.store.getKey(apiKey!)?.credits ?? batchResult.remainingCredits;

    this.emit('batch-call', {
      apiKey: apiKey?.slice(0, 10),
      callCount: calls.length,
      totalCreditsCharged: batchResult.totalCredits - totalRefunded,
      remainingCredits: finalRemaining,
      refunded: totalRefunded,
    });

    return {
      jsonrpc: '2.0',
      id: batchId,
      result: {
        results: results.map((r, i) => ({
          tool: calls[i].name,
          result: r.result,
          error: r.error,
          creditsCharged: r.error && totalRefunded > 0 ? 0 : batchResult.decisions[i].creditsCharged,
        })),
        totalCreditsCharged: batchResult.totalCredits - totalRefunded,
        remainingCredits: finalRemaining,
      },
    };
  }

  /**
   * Forward a JSON-RPC request to the wrapped server via stdio.
   */
  private forwardToServer(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error('Server stdin not writable'));
        return;
      }

      const id = request.id;

      // Notifications (no id) — fire and forget
      if (id === undefined || id === null) {
        const msg = JSON.stringify(request) + '\n';
        this.process.stdin.write(msg);
        resolve({ jsonrpc: '2.0', result: {} });
        return;
      }

      // Set timeout for response
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${id} timed out after 30s`));
      }, 30_000);

      this.pendingRequests.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        startTime: Date.now(),
      });

      const msg = JSON.stringify(request) + '\n';
      this.process.stdin.write(msg);
    });
  }

  /**
   * Parse JSON-RPC responses from the server's stdout.
   * Uses newline-delimited JSON.
   */
  private handleServerOutput(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const response = JSON.parse(trimmed) as JsonRpcResponse;
        if (response.id !== undefined && response.id !== null) {
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            this.pendingRequests.delete(response.id);
            pending.resolve(response);
          }
        } else {
          // Server-initiated notification
          this.emit('server-notification', response);
        }
      } catch {
        this.emit('parse-error', trimmed);
      }
    }
  }

  /**
   * Gracefully stop the wrapped server.
   */
  async stop(): Promise<void> {
    if (!this.started || !this.process) return;
    this.started = false;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.process?.kill('SIGKILL');
        resolve();
      }, 5000);

      this.process!.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      this.process!.kill('SIGTERM');
    });
  }

  /**
   * Forward a request directly to the wrapped server without gating.
   * Used by MultiServerRouter which handles gating at the router level.
   */
  async forwardUngated(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this.started || !this.process) {
      return this.errorResponse(request.id, -32603, 'Server not started');
    }
    return this.forwardToServer(request);
  }

  get isRunning(): boolean {
    return this.started;
  }

  private errorResponse(id: string | number | undefined, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}
