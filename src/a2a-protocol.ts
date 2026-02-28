/**
 * A2A Protocol Support — Agent-to-Agent communication alongside MCP.
 *
 * Implements core A2A (Agent-to-Agent) protocol primitives for inter-agent
 * communication, task delegation, and capability discovery. Supports:
 *
 *   - Agent Cards (/.well-known/agent.json): Advertise agent capabilities
 *   - Task lifecycle: create → working → completed/failed/canceled
 *   - Message exchange with typed parts (text, file, data)
 *   - Agent skill discovery and matching
 *   - Billing hooks for task-based pricing
 *
 * A2A protocol specification: https://google.github.io/A2A/
 *
 * Zero external dependencies.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** Agent capability advertised via Agent Card. */
export interface AgentSkill {
  /** Unique skill ID. */
  id: string;
  /** Human-readable skill name. */
  name: string;
  /** Description of what this skill does. */
  description?: string;
  /** Tags for discoverability. */
  tags?: string[];
  /** Example prompts that invoke this skill. */
  examples?: string[];
  /** MIME types this skill accepts as input. */
  inputModes?: string[];
  /** MIME types this skill can produce as output. */
  outputModes?: string[];
}

/** Agent Card served at /.well-known/agent.json. */
export interface AgentCard {
  /** Agent name. */
  name: string;
  /** Agent description. */
  description?: string;
  /** Agent provider info. */
  provider?: {
    organization: string;
    url?: string;
  };
  /** Agent version. */
  version: string;
  /** URL where A2A protocol requests are accepted. */
  url: string;
  /** Skills this agent provides. */
  skills: AgentSkill[];
  /** Supported A2A capabilities. */
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  /** Authentication requirements. */
  authentication?: {
    schemes: string[];
    credentials?: string;
  };
  /** Default input MIME types. */
  defaultInputModes?: string[];
  /** Default output MIME types. */
  defaultOutputModes?: string[];
}

/** Status of an A2A task. */
export type A2ATaskStatus = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled';

/** A part of a message (text, file, or data). */
export interface MessagePart {
  type: 'text' | 'file' | 'data';
  /** Text content (for type='text'). */
  text?: string;
  /** File reference (for type='file'). */
  file?: {
    name?: string;
    mimeType?: string;
    uri?: string;
    bytes?: string; // Base64
  };
  /** Structured data (for type='data'). */
  data?: Record<string, unknown>;
  /** Metadata about this part. */
  metadata?: Record<string, unknown>;
}

/** A message in the A2A conversation. */
export interface A2AMessage {
  /** Unique message ID. */
  messageId: string;
  /** Who sent this: 'user' (requesting agent) or 'agent' (this agent). */
  role: 'user' | 'agent';
  /** Message parts. */
  parts: MessagePart[];
  /** ISO timestamp. */
  timestamp: string;
  /** Arbitrary metadata. */
  metadata?: Record<string, unknown>;
}

/** Status update for a task. */
export interface TaskStatus {
  state: A2ATaskStatus;
  message?: A2AMessage;
  timestamp: string;
}

/** An A2A task. */
export interface A2ATask {
  /** Unique task ID. */
  id: string;
  /** Session ID for multi-turn conversations. */
  sessionId: string;
  /** Current status. */
  status: TaskStatus;
  /** History of status transitions. */
  history: TaskStatus[];
  /** Artifacts produced by the task. */
  artifacts: A2AArtifact[];
  /** ISO creation timestamp. */
  createdAt: string;
  /** ISO last update timestamp. */
  updatedAt: string;
  /** Metadata. */
  metadata?: Record<string, unknown>;
}

/** An artifact produced by a task. */
export interface A2AArtifact {
  /** Unique artifact ID. */
  id: string;
  /** Artifact name. */
  name?: string;
  /** Artifact parts. */
  parts: MessagePart[];
  /** Whether this artifact is the final result. */
  lastChunk?: boolean;
  /** Artifact index (for multi-artifact tasks). */
  index?: number;
  /** Metadata. */
  metadata?: Record<string, unknown>;
}

/** A2A JSON-RPC methods. */
export type A2AMethod =
  | 'tasks/send'
  | 'tasks/get'
  | 'tasks/cancel'
  | 'tasks/pushNotification/set'
  | 'tasks/pushNotification/get'
  | 'tasks/sendSubscribe';

/** A2A JSON-RPC request. */
export interface A2ARequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: A2AMethod;
  params?: Record<string, unknown>;
}

/** A2A JSON-RPC response. */
export interface A2AResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface A2AManagerConfig {
  /** This agent's card. */
  agentCard: AgentCard;
  /** Max tasks to retain. Default: 10000. */
  maxTasks?: number;
  /** Max task age in ms. Default: 86400000 (24h). */
  maxTaskAgeMs?: number;
  /** Whether to record state transition history. Default: true. */
  recordHistory?: boolean;
}

export interface A2AStats {
  /** Total tasks created. */
  totalTasks: number;
  /** Tasks by status. */
  byStatus: Record<string, number>;
  /** Total messages exchanged. */
  totalMessages: number;
  /** Total artifacts produced. */
  totalArtifacts: number;
  /** Active (non-terminal) tasks. */
  activeTasks: number;
}

// ─── A2A Manager ─────────────────────────────────────────────────────────────

export class A2AManager {
  private agentCard: AgentCard;
  private tasks: Map<string, A2ATask> = new Map();
  private maxTasks: number;
  private maxTaskAgeMs: number;
  private recordHistory: boolean;

  private stats: A2AStats = {
    totalTasks: 0,
    byStatus: {},
    totalMessages: 0,
    totalArtifacts: 0,
    activeTasks: 0,
  };

  constructor(config: A2AManagerConfig) {
    this.agentCard = config.agentCard;
    this.maxTasks = config.maxTasks ?? 10_000;
    this.maxTaskAgeMs = config.maxTaskAgeMs ?? 86_400_000;
    this.recordHistory = config.recordHistory ?? true;
  }

  /** Get the agent card for /.well-known/agent.json. */
  getAgentCard(): AgentCard {
    return { ...this.agentCard };
  }

  /** Update agent card. */
  updateAgentCard(card: Partial<AgentCard>): void {
    Object.assign(this.agentCard, card);
  }

  /**
   * Handle an incoming A2A JSON-RPC request.
   * Routes to the appropriate handler based on method.
   */
  handleRequest(request: A2ARequest): A2AResponse {
    const base = { jsonrpc: '2.0' as const, id: request.id };

    switch (request.method) {
      case 'tasks/send':
        return { ...base, ...this.handleTaskSend(request.params ?? {}) };
      case 'tasks/get':
        return { ...base, ...this.handleTaskGet(request.params ?? {}) };
      case 'tasks/cancel':
        return { ...base, ...this.handleTaskCancel(request.params ?? {}) };
      default:
        return { ...base, error: { code: -32601, message: `Unknown A2A method: ${request.method}` } };
    }
  }

  /**
   * Create a new task or send a message to an existing task.
   */
  private handleTaskSend(params: Record<string, unknown>): Partial<A2AResponse> {
    const taskId = params.id as string | undefined;
    const sessionId = (params.sessionId as string) ?? `session_${Date.now()}`;
    const messageParts = params.message as { role?: string; parts?: MessagePart[] } | undefined;

    if (!messageParts?.parts || messageParts.parts.length === 0) {
      return { error: { code: -32602, message: 'Message with parts is required' } };
    }

    const message: A2AMessage = {
      messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      role: (messageParts.role as 'user' | 'agent') ?? 'user',
      parts: messageParts.parts,
      timestamp: new Date().toISOString(),
      metadata: params.metadata as Record<string, unknown> | undefined,
    };

    this.stats.totalMessages++;

    // Existing task — append message
    if (taskId && this.tasks.has(taskId)) {
      const task = this.tasks.get(taskId)!;
      const newStatus: TaskStatus = {
        state: 'working',
        message,
        timestamp: new Date().toISOString(),
      };
      if (this.recordHistory) {
        task.history.push(task.status);
      }
      task.status = newStatus;
      task.updatedAt = new Date().toISOString();
      return { result: this.sanitizeTask(task) };
    }

    // New task
    this.evictOldTasks();

    const newTaskId = taskId ?? `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const status: TaskStatus = {
      state: 'submitted',
      message,
      timestamp: new Date().toISOString(),
    };

    const task: A2ATask = {
      id: newTaskId,
      sessionId,
      status,
      history: [],
      artifacts: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: params.metadata as Record<string, unknown> | undefined,
    };

    this.tasks.set(newTaskId, task);
    this.stats.totalTasks++;
    this.stats.activeTasks++;
    this.stats.byStatus['submitted'] = (this.stats.byStatus['submitted'] ?? 0) + 1;

    return { result: this.sanitizeTask(task) };
  }

  /**
   * Get task status.
   */
  private handleTaskGet(params: Record<string, unknown>): Partial<A2AResponse> {
    const taskId = params.id as string;
    if (!taskId) {
      return { error: { code: -32602, message: 'Task ID is required' } };
    }

    const task = this.tasks.get(taskId);
    if (!task) {
      return { error: { code: -32001, message: `Task not found: ${taskId}` } };
    }

    return { result: this.sanitizeTask(task) };
  }

  /**
   * Cancel a task.
   */
  private handleTaskCancel(params: Record<string, unknown>): Partial<A2AResponse> {
    const taskId = params.id as string;
    if (!taskId) {
      return { error: { code: -32602, message: 'Task ID is required' } };
    }

    const task = this.tasks.get(taskId);
    if (!task) {
      return { error: { code: -32001, message: `Task not found: ${taskId}` } };
    }

    const terminalStates: A2ATaskStatus[] = ['completed', 'failed', 'canceled'];
    if (terminalStates.includes(task.status.state)) {
      return { error: { code: -32002, message: `Task already in terminal state: ${task.status.state}` } };
    }

    this.transitionTask(task, 'canceled');
    return { result: this.sanitizeTask(task) };
  }

  /**
   * Transition a task to a new state (for use by task handlers).
   */
  transitionTask(taskOrId: A2ATask | string, newState: A2ATaskStatus, message?: A2AMessage, artifact?: A2AArtifact): A2ATask | null {
    const task = typeof taskOrId === 'string' ? this.tasks.get(taskOrId) : taskOrId;
    if (!task) return null;

    const oldState = task.status.state;

    if (this.recordHistory) {
      task.history.push(task.status);
    }

    const newStatus: TaskStatus = {
      state: newState,
      message,
      timestamp: new Date().toISOString(),
    };

    task.status = newStatus;
    task.updatedAt = new Date().toISOString();

    if (artifact) {
      task.artifacts.push(artifact);
      this.stats.totalArtifacts++;
    }

    // Update stats
    this.stats.byStatus[oldState] = Math.max(0, (this.stats.byStatus[oldState] ?? 0) - 1);
    this.stats.byStatus[newState] = (this.stats.byStatus[newState] ?? 0) + 1;

    const terminalStates: A2ATaskStatus[] = ['completed', 'failed', 'canceled'];
    if (terminalStates.includes(newState) && !terminalStates.includes(oldState)) {
      this.stats.activeTasks = Math.max(0, this.stats.activeTasks - 1);
    }

    return task;
  }

  /**
   * Get a task by ID.
   */
  getTask(taskId: string): A2ATask | null {
    const task = this.tasks.get(taskId);
    return task ? this.sanitizeTask(task) : null;
  }

  /**
   * List tasks with optional filters.
   */
  listTasks(opts?: { sessionId?: string; status?: A2ATaskStatus; limit?: number }): A2ATask[] {
    let tasks = [...this.tasks.values()];

    if (opts?.sessionId) {
      tasks = tasks.filter(t => t.sessionId === opts.sessionId);
    }
    if (opts?.status) {
      tasks = tasks.filter(t => t.status.state === opts.status);
    }

    tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    if (opts?.limit) {
      tasks = tasks.slice(0, opts.limit);
    }

    return tasks.map(t => this.sanitizeTask(t));
  }

  /**
   * Find skills matching a query.
   */
  findSkills(query: string): AgentSkill[] {
    const q = query.toLowerCase();
    return this.agentCard.skills.filter(s => {
      if (s.name.toLowerCase().includes(q)) return true;
      if (s.description?.toLowerCase().includes(q)) return true;
      if (s.tags?.some(t => t.toLowerCase().includes(q))) return true;
      return false;
    });
  }

  /**
   * Get stats.
   */
  getStats(): A2AStats {
    return { ...this.stats, byStatus: { ...this.stats.byStatus } };
  }

  /**
   * Clean up old tasks.
   */
  cleanup(maxAgeMs?: number): number {
    const threshold = maxAgeMs ?? this.maxTaskAgeMs;
    const cutoff = Date.now() - threshold;
    let cleaned = 0;

    for (const [id, task] of this.tasks) {
      if (new Date(task.updatedAt).getTime() < cutoff) {
        const terminalStates: A2ATaskStatus[] = ['completed', 'failed', 'canceled'];
        if (!terminalStates.includes(task.status.state)) {
          this.stats.activeTasks = Math.max(0, this.stats.activeTasks - 1);
        }
        this.tasks.delete(id);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Destroy and release resources.
   */
  destroy(): void {
    this.tasks.clear();
    this.stats = {
      totalTasks: 0,
      byStatus: {},
      totalMessages: 0,
      totalArtifacts: 0,
      activeTasks: 0,
    };
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private sanitizeTask(task: A2ATask): A2ATask {
    return {
      ...task,
      history: this.recordHistory ? [...task.history] : [],
      artifacts: [...task.artifacts],
    };
  }

  private evictOldTasks(): void {
    if (this.tasks.size < this.maxTasks) return;

    // Remove oldest completed tasks first
    const entries = [...this.tasks.entries()]
      .sort((a, b) => a[1].updatedAt.localeCompare(b[1].updatedAt));

    const terminalStates: A2ATaskStatus[] = ['completed', 'failed', 'canceled'];
    for (const [id, task] of entries) {
      if (this.tasks.size < this.maxTasks * 0.8) break; // Keep 80% capacity
      if (terminalStates.includes(task.status.state)) {
        this.tasks.delete(id);
      }
    }
  }
}
