/**
 * TaskManager — MCP Tasks primitive (MCP 2025-11-25 spec).
 *
 * Manages async task lifecycle for long-running tool calls:
 *   - tasks/send   — Create a task wrapping a tool call
 *   - tasks/get    — Get task status and progress
 *   - tasks/result — Get task result (completed or error)
 *   - tasks/list   — List tasks for a session
 *   - tasks/cancel — Cancel a running task
 *
 * Task states: pending → running → completed | failed | cancelled
 *
 * Billing integration:
 *   - Pre-charge: credits deducted at task creation (tasks/send)
 *   - Refund: if task fails and refundOnFailure is enabled
 *   - Outcome billing: additional credits charged on completion if output pricing is configured
 */

import { randomBytes } from 'crypto';

// ─── Types ───────────────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface TaskRecord {
  /** Unique task ID. */
  id: string;
  /** Current task status. */
  status: TaskStatus;
  /** Tool name being called. */
  toolName: string;
  /** Tool call arguments. */
  arguments?: Record<string, unknown>;
  /** API key that created this task (prefix only). */
  apiKeyPrefix: string;
  /** Session ID this task belongs to. */
  sessionId: string;
  /** ISO timestamp when task was created. */
  createdAt: string;
  /** ISO timestamp when task started running. */
  startedAt?: string;
  /** ISO timestamp when task completed/failed/was cancelled. */
  completedAt?: string;
  /** Progress percentage (0-100). Updated by the backend. */
  progress?: number;
  /** Human-readable progress message. */
  message?: string;
  /** Credits charged at task creation. */
  creditsCharged: number;
  /** Additional credits charged post-completion (outcome billing). */
  outcomeCredits?: number;
  /** Task result (populated on completion). */
  result?: unknown;
  /** Error message (populated on failure). */
  error?: string;
  /** Duration in milliseconds. */
  durationMs?: number;
}

export interface TaskListQuery {
  /** Filter by session ID. */
  sessionId?: string;
  /** Filter by status. */
  status?: TaskStatus;
  /** Filter by API key prefix. */
  apiKeyPrefix?: string;
  /** Pagination cursor. */
  cursor?: string;
  /** Page size. Default: 50. Max: 200. */
  pageSize?: number;
}

export interface TaskListResult {
  tasks: TaskRecord[];
  total: number;
  nextCursor?: string;
}

// ─── TaskManager ─────────────────────────────────────────────────────────────

export class TaskManager {
  /** All tasks, keyed by task ID. */
  private tasks = new Map<string, TaskRecord>();
  /** Max tasks to retain. Oldest completed tasks are evicted first. Default: 10000. */
  private maxTasks: number;
  /** Task timeout in ms. 0 = no timeout. Default: 300000 (5 min). */
  private taskTimeoutMs: number;
  /** Cleanup interval handle. */
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(options?: { maxTasks?: number; taskTimeoutMs?: number }) {
    this.maxTasks = options?.maxTasks ?? 10000;
    this.taskTimeoutMs = options?.taskTimeoutMs ?? 300_000;

    // Cleanup stale tasks every 60 seconds
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  /**
   * Create a new task (tasks/send).
   * Returns the task record in pending state.
   */
  createTask(params: {
    toolName: string;
    arguments?: Record<string, unknown>;
    apiKeyPrefix: string;
    sessionId: string;
    creditsCharged: number;
  }): TaskRecord {
    // Evict if at capacity
    this.evictIfNeeded();

    const id = `task_${randomBytes(12).toString('hex')}`;
    const task: TaskRecord = {
      id,
      status: 'pending',
      toolName: params.toolName,
      arguments: params.arguments,
      apiKeyPrefix: params.apiKeyPrefix,
      sessionId: params.sessionId,
      createdAt: new Date().toISOString(),
      creditsCharged: params.creditsCharged,
    };

    this.tasks.set(id, task);
    return task;
  }

  /**
   * Transition task to 'running'.
   */
  startTask(taskId: string): TaskRecord | null {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'pending') return null;

    task.status = 'running';
    task.startedAt = new Date().toISOString();
    return task;
  }

  /**
   * Update task progress.
   */
  updateProgress(taskId: string, progress: number, message?: string): TaskRecord | null {
    const task = this.tasks.get(taskId);
    if (!task || (task.status !== 'running' && task.status !== 'pending')) return null;

    task.progress = Math.min(100, Math.max(0, progress));
    if (message) task.message = message;
    return task;
  }

  /**
   * Complete a task with result.
   */
  completeTask(taskId: string, result: unknown, outcomeCredits?: number): TaskRecord | null {
    const task = this.tasks.get(taskId);
    if (!task || task.status === 'completed' || task.status === 'cancelled') return null;

    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    task.progress = 100;
    task.result = result;
    if (outcomeCredits) task.outcomeCredits = outcomeCredits;

    // Calculate duration
    const start = task.startedAt ? new Date(task.startedAt).getTime() : new Date(task.createdAt).getTime();
    task.durationMs = Date.now() - start;

    return task;
  }

  /**
   * Fail a task with error.
   */
  failTask(taskId: string, error: string): TaskRecord | null {
    const task = this.tasks.get(taskId);
    if (!task || task.status === 'completed' || task.status === 'cancelled') return null;

    task.status = 'failed';
    task.completedAt = new Date().toISOString();
    task.error = error;

    const start = task.startedAt ? new Date(task.startedAt).getTime() : new Date(task.createdAt).getTime();
    task.durationMs = Date.now() - start;

    return task;
  }

  /**
   * Cancel a task.
   */
  cancelTask(taskId: string): TaskRecord | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return null;

    task.status = 'cancelled';
    task.completedAt = new Date().toISOString();

    const start = task.startedAt ? new Date(task.startedAt).getTime() : new Date(task.createdAt).getTime();
    task.durationMs = Date.now() - start;

    return task;
  }

  /**
   * Get a task by ID.
   */
  getTask(taskId: string): TaskRecord | null {
    return this.tasks.get(taskId) || null;
  }

  /**
   * List tasks with optional filters.
   */
  listTasks(query?: TaskListQuery): TaskListResult {
    let all = Array.from(this.tasks.values());

    // Apply filters
    if (query?.sessionId) {
      all = all.filter(t => t.sessionId === query.sessionId);
    }
    if (query?.status) {
      all = all.filter(t => t.status === query.status);
    }
    if (query?.apiKeyPrefix) {
      all = all.filter(t => t.apiKeyPrefix === query.apiKeyPrefix);
    }

    // Sort by creation time (newest first)
    all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = all.length;
    const pageSize = Math.min(Math.max(1, query?.pageSize || 50), 200);
    const offset = query?.cursor ? Math.max(0, parseInt(query.cursor, 10) || 0) : 0;

    const page = all.slice(offset, offset + pageSize);
    const hasMore = offset + pageSize < total;

    return {
      tasks: page,
      total,
      ...(hasMore ? { nextCursor: String(offset + pageSize) } : {}),
    };
  }

  /**
   * Get summary stats.
   */
  getStats(): { total: number; pending: number; running: number; completed: number; failed: number; cancelled: number } {
    const stats = { total: 0, pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const task of this.tasks.values()) {
      stats.total++;
      stats[task.status]++;
    }
    return stats;
  }

  /** Get total task count. */
  get taskCount(): number {
    return this.tasks.size;
  }

  /**
   * Handle a tasks/* JSON-RPC method.
   * Returns the response content or null if not a tasks method.
   */
  handleTasksMethod(
    method: string,
    params: Record<string, unknown>,
    apiKeyPrefix: string,
    sessionId: string,
  ): { content: Array<{ type: string; text: string }> } | null {
    switch (method) {
      case 'tasks/get': {
        const taskId = String(params.taskId || '');
        if (!taskId) {
          return this.errorResult('taskId is required');
        }
        const task = this.getTask(taskId);
        if (!task) {
          return this.errorResult('Task not found', taskId);
        }
        return this.jsonResult(this.taskToResponse(task));
      }

      case 'tasks/result': {
        const taskId = String(params.taskId || '');
        if (!taskId) {
          return this.errorResult('taskId is required');
        }
        const task = this.getTask(taskId);
        if (!task) {
          return this.errorResult('Task not found', taskId);
        }
        if (task.status === 'completed') {
          return this.jsonResult({ taskId: task.id, status: task.status, result: task.result });
        }
        if (task.status === 'failed') {
          return this.jsonResult({ taskId: task.id, status: task.status, error: task.error });
        }
        // Task still in progress — return current status
        return this.jsonResult(this.taskToResponse(task));
      }

      case 'tasks/list': {
        const result = this.listTasks({
          sessionId: params.sessionId as string || sessionId,
          status: params.status as TaskStatus,
          apiKeyPrefix: params.apiKeyPrefix as string || apiKeyPrefix,
          cursor: params.cursor as string,
          pageSize: params.pageSize as number,
        });
        return this.jsonResult(result);
      }

      case 'tasks/cancel': {
        const taskId = String(params.taskId || '');
        if (!taskId) {
          return this.errorResult('taskId is required');
        }
        const task = this.cancelTask(taskId);
        if (!task) {
          return this.errorResult('Task not found or cannot be cancelled', taskId);
        }
        return this.jsonResult(this.taskToResponse(task));
      }

      default:
        return null;
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private taskToResponse(task: TaskRecord): Record<string, unknown> {
    return {
      taskId: task.id,
      status: task.status,
      toolName: task.toolName,
      progress: task.progress,
      message: task.message,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      creditsCharged: task.creditsCharged,
      outcomeCredits: task.outcomeCredits,
      durationMs: task.durationMs,
      ...(task.status === 'completed' ? { result: task.result } : {}),
      ...(task.status === 'failed' ? { error: task.error } : {}),
    };
  }

  private jsonResult(data: unknown): { content: Array<{ type: string; text: string }> } {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  private errorResult(message: string, taskId?: string): { content: Array<{ type: string; text: string }> } {
    return { content: [{ type: 'text', text: JSON.stringify({ error: message, taskId }) }] };
  }

  /**
   * Evict oldest completed tasks if at capacity.
   */
  private evictIfNeeded(): void {
    if (this.tasks.size < this.maxTasks) return;

    // Find completed/failed/cancelled tasks sorted by completion time
    const evictable = Array.from(this.tasks.entries())
      .filter(([, t]) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')
      .sort((a, b) => new Date(a[1].completedAt || a[1].createdAt).getTime() - new Date(b[1].completedAt || b[1].createdAt).getTime());

    // Remove oldest 10% or at least 1
    const toRemove = Math.max(1, Math.floor(evictable.length * 0.1));
    for (let i = 0; i < toRemove && i < evictable.length; i++) {
      this.tasks.delete(evictable[i][0]);
    }
  }

  /**
   * Cleanup timed-out tasks.
   */
  private cleanup(): void {
    if (this.taskTimeoutMs <= 0) return;

    const now = Date.now();
    for (const [id, task] of this.tasks) {
      if (task.status === 'pending' || task.status === 'running') {
        const created = new Date(task.createdAt).getTime();
        if (now - created > this.taskTimeoutMs) {
          task.status = 'failed';
          task.completedAt = new Date().toISOString();
          task.error = `Task timed out after ${this.taskTimeoutMs}ms`;
          task.durationMs = now - created;
        }
      }
    }
  }
}
