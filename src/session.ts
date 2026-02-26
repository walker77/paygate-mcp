/**
 * SessionManager — MCP session tracking for Streamable HTTP transport.
 *
 * Manages:
 *   - Session creation and lifecycle (Mcp-Session-Id)
 *   - SSE connection tracking per session
 *   - Server-to-client notification routing
 *   - Session cleanup on DELETE or timeout
 *
 * Per MCP spec (2025-03-26):
 *   - POST /mcp may return SSE or JSON
 *   - GET /mcp opens SSE stream for server notifications
 *   - DELETE /mcp terminates a session
 *   - Mcp-Session-Id correlates all requests in a session
 */

import { randomBytes } from 'crypto';
import { ServerResponse } from 'http';
import { JsonRpcResponse } from './types';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface McpSession {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  /** SSE connections for server-to-client notifications */
  sseConnections: Set<ServerResponse>;
  /** API key associated with this session (null if unauthenticated) */
  apiKey: string | null;
}

export interface SessionManagerConfig {
  /** Session timeout in ms. Default: 30 minutes. */
  sessionTimeoutMs: number;
  /** Max concurrent sessions. Default: 1000. */
  maxSessions: number;
  /** Max SSE connections per session. Default: 3. */
  maxSsePerSession: number;
}

const DEFAULT_SESSION_CONFIG: SessionManagerConfig = {
  sessionTimeoutMs: 30 * 60 * 1000, // 30 minutes
  maxSessions: 1000,
  maxSsePerSession: 3,
};

// ─── SSE Helpers ─────────────────────────────────────────────────────────────

/**
 * Write SSE headers to a response.
 * Extra headers (e.g., Mcp-Session-Id) can be merged in.
 */
export function writeSseHeaders(res: ServerResponse, extraHeaders?: Record<string, string>): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable Nginx buffering
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    ...extraHeaders,
  });
}

/**
 * Write a JSON-RPC response as an SSE event.
 */
export function writeSseEvent(res: ServerResponse, data: JsonRpcResponse | object, eventType?: string): void {
  if (eventType) {
    res.write(`event: ${eventType}\n`);
  }
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Write a keepalive comment to an SSE stream (prevents connection timeout).
 */
export function writeSseKeepAlive(res: ServerResponse): void {
  res.write(': keepalive\n\n');
}

// ─── SessionManager ──────────────────────────────────────────────────────────

export class SessionManager {
  private sessions = new Map<string, McpSession>();
  private readonly config: SessionManagerConfig;
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(config?: Partial<SessionManagerConfig>) {
    this.config = { ...DEFAULT_SESSION_CONFIG, ...config };
    // Cleanup expired sessions every 60 seconds
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  /**
   * Create a new session. Returns the session ID.
   */
  createSession(apiKey: string | null): string {
    // Enforce max sessions
    if (this.sessions.size >= this.config.maxSessions) {
      this.evictOldest();
    }

    const id = `mcp_sess_${randomBytes(16).toString('hex')}`;
    const session: McpSession = {
      id,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sseConnections: new Set(),
      apiKey,
    };

    this.sessions.set(id, session);
    return id;
  }

  /**
   * Get a session by ID. Returns null if not found or expired.
   */
  getSession(sessionId: string): McpSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Check timeout
    if (Date.now() - session.lastActivityAt > this.config.sessionTimeoutMs) {
      this.destroySession(sessionId);
      return null;
    }

    session.lastActivityAt = Date.now();
    return session;
  }

  /**
   * Register an SSE connection for a session.
   * Returns false if the session is at its SSE limit.
   */
  addSseConnection(sessionId: string, res: ServerResponse): boolean {
    const session = this.getSession(sessionId);
    if (!session) return false;

    if (session.sseConnections.size >= this.config.maxSsePerSession) {
      return false;
    }

    session.sseConnections.add(res);

    // Clean up when the connection closes
    res.on('close', () => {
      session.sseConnections.delete(res);
    });

    return true;
  }

  /**
   * Send a server-initiated notification to all SSE connections in a session.
   */
  sendNotification(sessionId: string, notification: JsonRpcResponse | object): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    for (const res of session.sseConnections) {
      try {
        writeSseEvent(res, notification, 'message');
      } catch {
        // Connection already closed
        session.sseConnections.delete(res);
      }
    }
  }

  /**
   * Destroy a session, closing all SSE connections.
   */
  destroySession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Close all SSE connections
    for (const res of session.sseConnections) {
      try {
        res.end();
      } catch {
        // Already closed
      }
    }
    session.sseConnections.clear();

    this.sessions.delete(sessionId);
    return true;
  }

  /**
   * Get active session count.
   */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Cleanup expired sessions.
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivityAt > this.config.sessionTimeoutMs) {
        this.destroySession(id);
      }
    }
  }

  /**
   * Evict the oldest session to make room for a new one.
   */
  private evictOldest(): void {
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [id, session] of this.sessions) {
      if (session.lastActivityAt < oldestTime) {
        oldestTime = session.lastActivityAt;
        oldestId = id;
      }
    }

    if (oldestId) {
      this.destroySession(oldestId);
    }
  }

  /**
   * Stop the session manager, clean up all sessions.
   */
  destroy(): void {
    clearInterval(this.cleanupInterval);
    for (const id of this.sessions.keys()) {
      this.destroySession(id);
    }
  }
}
