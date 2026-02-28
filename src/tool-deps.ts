/**
 * ToolDependencyGraph — DAG-based tool workflow validation.
 *
 * Models dependencies between MCP tools so PayGate can:
 *   - Validate execution order (prevent calling B before A)
 *   - Detect circular dependency chains
 *   - Propagate failure states (if A fails, skip B/C/D)
 *   - Suggest optimal execution order (topological sort)
 *   - Track dependency health across tool calls
 *
 * Use cases:
 *   - Multi-step agent workflows (data fetch → transform → store)
 *   - Prerequisite enforcement (auth → action)
 *   - Failure cascading (upstream failure skips downstream)
 *   - Workflow visualization (dependency tree export)
 *
 * Zero external dependencies.
 */

import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ToolDep {
  /** The tool that has dependencies. */
  tool: string;
  /** Tools that must succeed before this tool can run. */
  dependsOn: string[];
  /** If true, failure of any dependency blocks this tool. Default true. */
  hardDependency: boolean;
  /** Optional group/namespace for scoping. */
  group?: string;
  createdAt: number;
}

export interface DepCheckResult {
  allowed: boolean;
  tool: string;
  /** Which dependencies are not yet satisfied. */
  unsatisfied: string[];
  /** Which dependencies have failed. */
  failed: string[];
  reason?: string;
}

export interface ExecutionRecord {
  tool: string;
  status: 'success' | 'failure' | 'pending';
  timestamp: number;
  /** Unique workflow/session ID. */
  workflowId: string;
}

export interface TopologicalOrder {
  /** Tools in valid execution order. */
  order: string[];
  /** Tools involved in cycles (if any). */
  cycles: string[][];
  /** Number of dependency levels. */
  depth: number;
}

export interface DepGraphStats {
  totalTools: number;
  totalEdges: number;
  totalWorkflows: number;
  checksPerformed: number;
  checksBlocked: number;
  failurePropagations: number;
  cyclesDetected: number;
}

export interface DepGraphConfig {
  /** Enable dependency checking. Default false. */
  enabled: boolean;
  /** Max tools in the graph. Default 1000. */
  maxTools: number;
  /** Max workflows to track. Default 10000. */
  maxWorkflows: number;
  /** Workflow expiry in ms. Default 1 hour. */
  workflowExpiryMs: number;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: DepGraphConfig = {
  enabled: false,
  maxTools: 1000,
  maxWorkflows: 10_000,
  workflowExpiryMs: 60 * 60 * 1000, // 1 hour
};

// ─── ToolDependencyGraph Class ──────────────────────────────────────────────

export class ToolDependencyGraph {
  private config: DepGraphConfig;

  /** tool → ToolDep */
  private deps = new Map<string, ToolDep>();

  /** workflowId → ExecutionRecord[] */
  private workflows = new Map<string, ExecutionRecord[]>();

  // Stats
  private _checksPerformed = 0;
  private _checksBlocked = 0;
  private _failurePropagations = 0;
  private _cyclesDetected = 0;

  constructor(config?: Partial<DepGraphConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─── Dependency Registration ────────────────────────────────────────────

  /**
   * Register a tool's dependencies.
   */
  register(tool: string, dependsOn: string[], options?: { hardDependency?: boolean; group?: string }): ToolDep {
    if (!tool || tool.length > 256) {
      throw new Error('Tool name required (max 256 chars)');
    }
    if (this.deps.size >= this.config.maxTools && !this.deps.has(tool)) {
      throw new Error(`Max tools reached (${this.config.maxTools})`);
    }

    const dep: ToolDep = {
      tool,
      dependsOn: [...new Set(dependsOn)], // deduplicate
      hardDependency: options?.hardDependency ?? true,
      group: options?.group,
      createdAt: Date.now(),
    };

    this.deps.set(tool, dep);
    return { ...dep };
  }

  /**
   * Remove a tool from the graph (and from other tools' dependencies).
   */
  unregister(tool: string): boolean {
    const removed = this.deps.delete(tool);
    // Always remove from other tools' dependsOn lists
    for (const dep of this.deps.values()) {
      dep.dependsOn = dep.dependsOn.filter(d => d !== tool);
    }
    return removed;
  }

  /**
   * Get a tool's dependency info.
   */
  getDep(tool: string): ToolDep | undefined {
    const d = this.deps.get(tool);
    return d ? { ...d, dependsOn: [...d.dependsOn] } : undefined;
  }

  /**
   * List all registered dependencies.
   */
  listDeps(group?: string): ToolDep[] {
    const results: ToolDep[] = [];
    for (const d of this.deps.values()) {
      if (group && d.group !== group) continue;
      results.push({ ...d, dependsOn: [...d.dependsOn] });
    }
    return results;
  }

  // ─── Dependency Checking ────────────────────────────────────────────────

  /**
   * Check if a tool can execute given the current workflow state.
   */
  check(tool: string, workflowId: string): DepCheckResult {
    this._checksPerformed++;

    if (!this.config.enabled) {
      return { allowed: true, tool, unsatisfied: [], failed: [] };
    }

    const dep = this.deps.get(tool);
    if (!dep || dep.dependsOn.length === 0) {
      return { allowed: true, tool, unsatisfied: [], failed: [] };
    }

    const records = this.workflows.get(workflowId) ?? [];
    const successTools = new Set(
      records.filter(r => r.status === 'success').map(r => r.tool)
    );
    const failedTools = new Set(
      records.filter(r => r.status === 'failure').map(r => r.tool)
    );

    const unsatisfied: string[] = [];
    const failed: string[] = [];

    for (const required of dep.dependsOn) {
      if (failedTools.has(required)) {
        failed.push(required);
      } else if (!successTools.has(required)) {
        unsatisfied.push(required);
      }
    }

    // Hard dependency: any failure or unsatisfied blocks
    if (dep.hardDependency && (failed.length > 0 || unsatisfied.length > 0)) {
      this._checksBlocked++;
      if (failed.length > 0) this._failurePropagations++;
      return {
        allowed: false,
        tool,
        unsatisfied,
        failed,
        reason: failed.length > 0 ? 'dependency-failed' : 'dependency-unsatisfied',
      };
    }

    // Soft dependency: only block on unsatisfied (allow if deps just failed)
    if (!dep.hardDependency && unsatisfied.length > 0) {
      this._checksBlocked++;
      return {
        allowed: false,
        tool,
        unsatisfied,
        failed,
        reason: 'dependency-unsatisfied',
      };
    }

    return { allowed: true, tool, unsatisfied: [], failed };
  }

  // ─── Execution Recording ────────────────────────────────────────────────

  /**
   * Record a tool execution result for a workflow.
   */
  recordExecution(tool: string, workflowId: string, status: 'success' | 'failure'): void {
    this.pruneWorkflows();

    let records = this.workflows.get(workflowId);
    if (!records) {
      if (this.workflows.size >= this.config.maxWorkflows) {
        // Evict oldest workflow
        const oldest = this.workflows.keys().next().value;
        if (oldest) this.workflows.delete(oldest);
      }
      records = [];
      this.workflows.set(workflowId, records);
    }

    records.push({
      tool,
      status,
      timestamp: Date.now(),
      workflowId,
    });
  }

  /**
   * Get execution history for a workflow.
   */
  getWorkflow(workflowId: string): ExecutionRecord[] {
    const records = this.workflows.get(workflowId);
    return records ? records.map(r => ({ ...r })) : [];
  }

  /**
   * Start a new workflow (returns a unique ID).
   */
  startWorkflow(): string {
    return 'wf_' + crypto.randomBytes(8).toString('hex');
  }

  // ─── Graph Analysis ─────────────────────────────────────────────────────

  /**
   * Compute topological sort of all tools.
   * Detects cycles and returns them separately.
   */
  topologicalSort(group?: string): TopologicalOrder {
    // Build adjacency for the group
    const tools = new Set<string>();
    const edges = new Map<string, string[]>(); // tool → dependsOn
    const inDegree = new Map<string, number>();

    for (const dep of this.deps.values()) {
      if (group && dep.group !== group) continue;
      tools.add(dep.tool);
      for (const d of dep.dependsOn) {
        tools.add(d);
      }
    }

    for (const t of tools) {
      edges.set(t, []);
      inDegree.set(t, 0);
    }

    for (const dep of this.deps.values()) {
      if (group && dep.group !== group) continue;
      for (const d of dep.dependsOn) {
        // Edge: d → dep.tool (d must come first)
        edges.get(d)?.push(dep.tool);
        inDegree.set(dep.tool, (inDegree.get(dep.tool) ?? 0) + 1);
      }
    }

    // Kahn's algorithm
    const queue: string[] = [];
    for (const [t, deg] of inDegree) {
      if (deg === 0) queue.push(t);
    }

    const order: string[] = [];
    let depth = 0;
    let levelSize = queue.length;
    let processed = 0;

    while (queue.length > 0) {
      if (processed === 0) depth++;
      const tool = queue.shift()!;
      order.push(tool);
      processed++;

      for (const next of (edges.get(tool) ?? [])) {
        const newDeg = (inDegree.get(next) ?? 1) - 1;
        inDegree.set(next, newDeg);
        if (newDeg === 0) queue.push(next);
      }

      if (processed === levelSize) {
        processed = 0;
        levelSize = queue.length;
      }
    }

    // Detect cycles — tools not in the sorted order
    const cycles: string[][] = [];
    if (order.length < tools.size) {
      const inOrder = new Set(order);
      const cycleNodes = [...tools].filter(t => !inOrder.has(t));
      if (cycleNodes.length > 0) {
        this._cyclesDetected++;
        // Find connected components in cycle nodes
        cycles.push(cycleNodes);
      }
    }

    return { order, cycles, depth };
  }

  /**
   * Get all tools that depend on a given tool (direct + transitive).
   * Useful for failure impact analysis.
   */
  getDependents(tool: string): string[] {
    const dependents = new Set<string>();
    const queue = [tool];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const dep of this.deps.values()) {
        if (dep.dependsOn.includes(current) && !dependents.has(dep.tool)) {
          dependents.add(dep.tool);
          queue.push(dep.tool);
        }
      }
    }

    return [...dependents];
  }

  /**
   * Get all prerequisites for a tool (direct + transitive).
   */
  getPrerequisites(tool: string): string[] {
    const prereqs = new Set<string>();
    const queue = [tool];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const dep = this.deps.get(current);
      if (!dep) continue;
      for (const d of dep.dependsOn) {
        if (!prereqs.has(d)) {
          prereqs.add(d);
          queue.push(d);
        }
      }
    }

    return [...prereqs];
  }

  /**
   * Validate the entire graph for cycles.
   */
  validate(): { valid: boolean; cycles: string[][] } {
    const result = this.topologicalSort();
    return {
      valid: result.cycles.length === 0,
      cycles: result.cycles,
    };
  }

  // ─── Configuration ──────────────────────────────────────────────────────

  /**
   * Update configuration at runtime.
   */
  configure(updates: Partial<DepGraphConfig>): DepGraphConfig {
    if (updates.enabled !== undefined) this.config.enabled = updates.enabled;
    if (updates.maxTools !== undefined) this.config.maxTools = Math.max(1, updates.maxTools);
    if (updates.maxWorkflows !== undefined) this.config.maxWorkflows = Math.max(1, updates.maxWorkflows);
    if (updates.workflowExpiryMs !== undefined) this.config.workflowExpiryMs = Math.max(1000, updates.workflowExpiryMs);
    return { ...this.config };
  }

  /**
   * Get aggregate statistics.
   */
  stats(): DepGraphStats {
    let totalEdges = 0;
    for (const dep of this.deps.values()) {
      totalEdges += dep.dependsOn.length;
    }

    return {
      totalTools: this.deps.size,
      totalEdges,
      totalWorkflows: this.workflows.size,
      checksPerformed: this._checksPerformed,
      checksBlocked: this._checksBlocked,
      failurePropagations: this._failurePropagations,
      cyclesDetected: this._cyclesDetected,
    };
  }

  /**
   * Clear all state.
   */
  clear(): void {
    this.deps.clear();
    this.workflows.clear();
    this._checksPerformed = 0;
    this._checksBlocked = 0;
    this._failurePropagations = 0;
    this._cyclesDetected = 0;
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private pruneWorkflows(): void {
    const now = Date.now();
    const cutoff = now - this.config.workflowExpiryMs;
    for (const [wfId, records] of this.workflows) {
      const latest = records[records.length - 1];
      if (latest && latest.timestamp < cutoff) {
        this.workflows.delete(wfId);
      }
    }
  }
}
