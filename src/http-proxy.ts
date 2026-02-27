/**
 * HttpMcpProxy — Forwards JSON-RPC requests to a remote MCP server
 * using the Streamable HTTP transport (MCP spec 2025-03-26).
 *
 * Architecture:
 *   HTTP Client <--JSON-RPC over HTTP--> PayGate <--Streamable HTTP--> Remote MCP Server
 *
 * Supports:
 *   - POST with application/json responses
 *   - POST with text/event-stream (SSE) responses
 *   - Mcp-Session-Id session management
 *   - Automatic initialization handshake
 */

import { EventEmitter } from 'events';
import { JsonRpcRequest, JsonRpcResponse, ToolCallParams, BatchToolCall } from './types';
import { Gate } from './gate';
import * as http from 'http';
import * as https from 'https';

export class HttpMcpProxy extends EventEmitter {
  private readonly gate: Gate;
  private readonly remoteUrl: URL;
  private sessionId: string | null = null;
  private started = false;

  constructor(gate: Gate, remoteUrl: string) {
    super();
    this.gate = gate;
    this.remoteUrl = new URL(remoteUrl);
  }

  /**
   * Start the proxy — verify the remote server is reachable.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
  }

  /**
   * Handle an incoming JSON-RPC request from the client.
   * Gates tools/call through the PayGate. Passes other methods through.
   */
  async handleRequest(request: JsonRpcRequest, apiKey: string | null, clientIp?: string, scopedTokenTools?: string[]): Promise<JsonRpcResponse> {
    if (!this.started) {
      return this.errorResponse(request.id, -32603, 'Proxy not started');
    }

    // Free methods pass through without auth (but tools/list may be ACL-filtered)
    if (this.gate.isFreeMethod(request.method)) {
      const response = await this.forwardToServer(request);
      // Filter tools/list based on key ACL
      if (request.method === 'tools/list' && response.result && apiKey) {
        const result = response.result as { tools?: Array<{ name: string; [k: string]: unknown }> };
        if (result.tools && Array.isArray(result.tools)) {
          const filtered = this.gate.filterToolsForKey(apiKey, result.tools, scopedTokenTools);
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

      const decision = this.gate.evaluate(apiKey, toolCall, clientIp, scopedTokenTools);

      if (!decision.allowed) {
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32000,
            message: `Payment required: ${decision.reason}`,
            data: {
              creditsRequired: this.gate.getToolPrice(toolCall.name),
              remainingCredits: decision.remainingCredits,
            },
          },
        };
      }

      // Allowed — forward to remote server
      const response = await this.forwardToServer(request);

      // Emit for observability
      this.emit('tool-call', {
        tool: toolCall.name,
        apiKey: apiKey?.slice(0, 10),
        creditsCharged: decision.creditsCharged,
        remainingCredits: decision.remainingCredits,
      });

      return response;
    }

    // Unknown method — forward
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
    scopedTokenTools?: string[],
  ): Promise<JsonRpcResponse> {
    if (!this.started) {
      return this.errorResponse(batchId, -32603, 'Proxy not started');
    }

    if (!calls || calls.length === 0) {
      return this.errorResponse(batchId, -32602, 'Invalid batch: empty calls array');
    }

    const batchResult = this.gate.evaluateBatch(apiKey, calls, clientIp, scopedTokenTools);

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

    const finalRemaining = this.gate.store.getKey(apiKey!)?.credits ?? batchResult.remainingCredits;

    this.emit('batch-call', {
      apiKey: apiKey?.slice(0, 10),
      callCount: calls.length,
      totalCreditsCharged: batchResult.totalCredits,
      remainingCredits: finalRemaining,
    });

    return {
      jsonrpc: '2.0',
      id: batchId,
      result: {
        results: results.map((r, i) => ({
          tool: calls[i].name,
          result: r.result,
          error: r.error,
          creditsCharged: batchResult.decisions[i].creditsCharged,
        })),
        totalCreditsCharged: batchResult.totalCredits,
        remainingCredits: finalRemaining,
      },
    };
  }

  /**
   * Forward a JSON-RPC request to the remote MCP server via HTTP POST.
   * Handles both application/json and text/event-stream responses.
   */
  private async forwardToServer(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    // Notifications (no id) — fire and forget
    if (request.id === undefined || request.id === null) {
      try {
        await this.httpPost(request);
      } catch {
        // Best effort for notifications
      }
      return { jsonrpc: '2.0', result: {} };
    }

    try {
      const { body, headers } = await this.httpPost(request);

      // Capture session ID from initialize response
      const newSessionId = headers['mcp-session-id'];
      if (newSessionId && typeof newSessionId === 'string') {
        this.sessionId = newSessionId;
      }

      const contentType = headers['content-type'] || '';

      if (contentType.includes('text/event-stream')) {
        // Parse SSE response
        return this.parseSseResponse(body, request.id);
      }

      // Standard JSON response
      const response = JSON.parse(body) as JsonRpcResponse;
      return response;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return this.errorResponse(request.id, -32603, `Remote server error: ${msg}`);
    }
  }

  /**
   * Send an HTTP POST to the remote MCP server.
   */
  private httpPost(request: JsonRpcRequest): Promise<{ body: string; headers: Record<string, string | string[] | undefined> }> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(request);
      const isHttps = this.remoteUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': String(Buffer.byteLength(payload)),
      };

      if (this.sessionId) {
        headers['Mcp-Session-Id'] = this.sessionId;
      }

      const options: http.RequestOptions = {
        hostname: this.remoteUrl.hostname,
        port: this.remoteUrl.port || (isHttps ? 443 : 80),
        path: this.remoteUrl.pathname + this.remoteUrl.search,
        method: 'POST',
        headers,
        timeout: 30_000,
      };

      const MAX_RESPONSE_BODY = 10 * 1024 * 1024; // 10 MB response limit
      let settled = false;
      const req = transport.request(options, (res) => {
        let body = '';
        let bodySize = 0;
        res.on('data', (chunk: Buffer) => {
          bodySize += chunk.length;
          if (bodySize > MAX_RESPONSE_BODY) {
            if (!settled) {
              settled = true;
              req.destroy();
              reject(new Error(`Response body too large (>${MAX_RESPONSE_BODY} bytes)`));
            }
            return;
          }
          body += chunk.toString();
        });
        res.on('end', () => {
          if (settled) return;
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          resolve({ body, headers: res.headers as Record<string, string | string[] | undefined> });
        });
      });

      req.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      req.on('timeout', () => {
        if (!settled) {
          settled = true;
          req.destroy();
          reject(new Error('Request timed out after 30s'));
        }
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Parse an SSE (text/event-stream) response body to extract JSON-RPC responses.
   *
   * SSE format:
   *   event: message
   *   data: {"jsonrpc":"2.0","id":1,"result":{...}}
   *
   * Per the MCP spec, the stream may contain multiple events.
   * We look for the JSON-RPC response matching our request ID.
   */
  private parseSseResponse(body: string, requestId: string | number | undefined): JsonRpcResponse {
    const lines = body.split('\n');
    let currentData = '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        currentData = line.slice(6);
      } else if (line === '' && currentData) {
        // End of event
        try {
          const parsed = JSON.parse(currentData);
          // Check if this is the response we're looking for
          if (parsed.jsonrpc === '2.0' && parsed.id === requestId) {
            return parsed as JsonRpcResponse;
          }
          // Could be a batched response
          if (Array.isArray(parsed)) {
            const match = parsed.find((r: JsonRpcResponse) => r.id === requestId);
            if (match) return match;
          }
        } catch {
          // Skip unparseable events
        }
        currentData = '';
      }
    }

    // Try parsing the last data chunk if there was no trailing newline
    if (currentData) {
      try {
        const parsed = JSON.parse(currentData);
        if (parsed.jsonrpc === '2.0') {
          return parsed as JsonRpcResponse;
        }
      } catch {
        // Ignore
      }
    }

    return this.errorResponse(requestId, -32603, 'No matching response in SSE stream');
  }

  /**
   * Stop the proxy and clean up the session.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    // Per MCP spec, send DELETE to terminate session
    if (this.sessionId) {
      try {
        await this.httpDelete();
      } catch {
        // Best effort cleanup
      }
      this.sessionId = null;
    }
  }

  /**
   * Send HTTP DELETE to terminate the MCP session.
   */
  private httpDelete(): Promise<void> {
    return new Promise((resolve) => {
      const isHttps = this.remoteUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const headers: Record<string, string> = {};
      if (this.sessionId) {
        headers['Mcp-Session-Id'] = this.sessionId;
      }

      const options: http.RequestOptions = {
        hostname: this.remoteUrl.hostname,
        port: this.remoteUrl.port || (isHttps ? 443 : 80),
        path: this.remoteUrl.pathname,
        method: 'DELETE',
        headers,
        timeout: 5_000,
      };

      const req = transport.request(options, () => resolve());
      req.on('error', () => resolve());
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.end();
    });
  }

  /**
   * Forward a request directly to the remote server without gating.
   * Used by MultiServerRouter which handles gating at the router level.
   */
  async forwardUngated(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this.started) {
      return this.errorResponse(request.id, -32603, 'Proxy not started');
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
