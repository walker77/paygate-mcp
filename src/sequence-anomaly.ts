/**
 * Sequence Anomaly Detection — Markov chain over tool call history.
 *
 * Builds a probabilistic model of normal tool call sequences per API key.
 * When a tool call pattern deviates significantly from the learned model,
 * it flags the request as anomalous. This detects:
 *
 *   - Compromised keys (unusual tool patterns)
 *   - Automated abuse (repetitive unnatural sequences)
 *   - Privilege escalation attempts (admin tools after read-only history)
 *
 * Inspired by Cloudflare's sequence anomaly detection for API endpoints.
 *
 * Features:
 *   - Per-key Markov chain model (tool A → tool B transition probabilities)
 *   - Configurable anomaly threshold (log-probability cutoff)
 *   - Learning mode: passively build model without enforcing
 *   - Enforcement mode: flag or block anomalous sequences
 *   - Sliding window for recent sequence context
 *   - Global baseline model for new keys
 *
 * Zero external dependencies.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SequenceAnomalyConfig {
  /** Enable anomaly detection. Default: false. */
  enabled: boolean;
  /** Number of transitions to learn before enforcing. Default: 100. */
  learningThreshold: number;
  /** Anomaly score threshold (0-1). Higher = more permissive. Default: 0.01. */
  anomalyThreshold: number;
  /** Action on anomaly: 'log', 'warn', 'block'. Default: 'log'. */
  action: 'log' | 'warn' | 'block';
  /** Window size for recent tool calls. Default: 10. */
  windowSize: number;
  /** Max keys to track. Default: 50000. */
  maxKeys: number;
  /** Smoothing factor for unseen transitions (Laplace smoothing). Default: 0.01. */
  smoothingFactor: number;
}

/** Transition count from one tool to another. */
export interface TransitionModel {
  /** Total transitions recorded from this tool. */
  totalFromTool: Record<string, number>;
  /** Transition counts: fromTool → toTool → count. */
  transitions: Record<string, Record<string, number>>;
  /** Total transitions recorded. */
  totalTransitions: number;
}

export interface AnomalyCheckResult {
  /** Whether the sequence is anomalous. */
  anomalous: boolean;
  /** Anomaly score (0-1). Lower = more anomalous. */
  score: number;
  /** Transition probability that triggered the anomaly (if any). */
  transitionProbability: number;
  /** The transition that was checked: fromTool → toTool. */
  transition: { from: string; to: string };
  /** Action to take based on config. */
  action: 'allow' | 'log' | 'warn' | 'block';
  /** Whether the model is still learning (not enough data). */
  learning: boolean;
  /** Number of transitions learned for this key. */
  transitionsLearned: number;
}

export interface AnomalyEvent {
  /** ISO timestamp. */
  timestamp: string;
  /** API key (prefix only). */
  keyPrefix: string;
  /** The anomalous transition. */
  from: string;
  /** Target tool. */
  to: string;
  /** Anomaly score. */
  score: number;
  /** Action taken. */
  action: string;
}

export interface SequenceAnomalyStats {
  /** Total keys being tracked. */
  trackedKeys: number;
  /** Total transitions learned (global). */
  totalTransitions: number;
  /** Total anomaly checks performed. */
  totalChecks: number;
  /** Total anomalies detected. */
  totalAnomalies: number;
  /** Total blocks (action=block). */
  totalBlocks: number;
  /** Keys still in learning mode. */
  keysLearning: number;
  /** Keys in enforcement mode. */
  keysEnforcing: number;
  /** Recent anomaly events. */
  recentAnomalies: AnomalyEvent[];
}

// ─── Key State ───────────────────────────────────────────────────────────────

interface KeyState {
  /** Per-key transition model. */
  model: TransitionModel;
  /** Recent tool calls (sliding window). */
  recentTools: string[];
  /** Whether this key is past the learning threshold. */
  enforcing: boolean;
}

// ─── Sequence Anomaly Detector ───────────────────────────────────────────────

export class SequenceAnomalyDetector {
  private config: SequenceAnomalyConfig;
  private keys: Map<string, KeyState> = new Map();
  private globalModel: TransitionModel;
  private recentAnomalies: AnomalyEvent[] = [];
  private maxRecentAnomalies = 100;

  private stats = {
    totalChecks: 0,
    totalAnomalies: 0,
    totalBlocks: 0,
  };

  constructor(config?: Partial<SequenceAnomalyConfig>) {
    this.config = {
      enabled: config?.enabled ?? false,
      learningThreshold: config?.learningThreshold ?? 100,
      anomalyThreshold: config?.anomalyThreshold ?? 0.01,
      action: config?.action ?? 'log',
      windowSize: config?.windowSize ?? 10,
      maxKeys: config?.maxKeys ?? 50_000,
      smoothingFactor: config?.smoothingFactor ?? 0.01,
    };

    this.globalModel = this.createEmptyModel();
  }

  /** Whether anomaly detection is enabled. */
  get isEnabled(): boolean { return this.config.enabled; }

  /** Enable/disable at runtime. */
  setEnabled(enabled: boolean): void { this.config.enabled = enabled; }

  /**
   * Record a tool call and check for anomalies.
   *
   * @param key - API key
   * @param tool - Tool name being called
   * @returns Check result with anomaly info
   */
  check(key: string, tool: string): AnomalyCheckResult {
    this.stats.totalChecks++;

    const result: AnomalyCheckResult = {
      anomalous: false,
      score: 1.0,
      transitionProbability: 1.0,
      transition: { from: '__START__', to: tool },
      action: 'allow',
      learning: true,
      transitionsLearned: 0,
    };

    if (!this.config.enabled) return result;

    // Get or create key state
    let state = this.keys.get(key);
    if (!state) {
      if (this.keys.size >= this.config.maxKeys) {
        this.evictOldestKey();
      }
      state = {
        model: this.createEmptyModel(),
        recentTools: [],
        enforcing: false,
      };
      this.keys.set(key, state);
    }

    // Get previous tool (last in window)
    const prevTool = state.recentTools.length > 0
      ? state.recentTools[state.recentTools.length - 1]
      : '__START__';

    result.transition = { from: prevTool, to: tool };
    result.transitionsLearned = state.model.totalTransitions;

    // Check if we're past learning threshold
    if (state.model.totalTransitions >= this.config.learningThreshold) {
      state.enforcing = true;
      result.learning = false;

      // Calculate transition probability
      const prob = this.getTransitionProbability(state.model, prevTool, tool);
      result.transitionProbability = prob;
      result.score = prob;

      if (prob < this.config.anomalyThreshold) {
        result.anomalous = true;
        result.action = this.config.action;
        this.stats.totalAnomalies++;

        if (this.config.action === 'block') {
          this.stats.totalBlocks++;
        }

        // Record anomaly event
        const event: AnomalyEvent = {
          timestamp: new Date().toISOString(),
          keyPrefix: key.slice(0, 12) + '...',
          from: prevTool,
          to: tool,
          score: prob,
          action: this.config.action,
        };
        this.recentAnomalies.push(event);
        if (this.recentAnomalies.length > this.maxRecentAnomalies) {
          this.recentAnomalies.shift();
        }
      }
    }

    // Always learn (update model)
    this.recordTransition(state.model, prevTool, tool);
    this.recordTransition(this.globalModel, prevTool, tool);

    // Update sliding window
    state.recentTools.push(tool);
    if (state.recentTools.length > this.config.windowSize) {
      state.recentTools.shift();
    }

    return result;
  }

  /**
   * Get the transition probability from one tool to another.
   */
  getTransitionProbability(model: TransitionModel, from: string, to: string): number {
    const fromTotal = model.totalFromTool[from];
    if (!fromTotal || fromTotal === 0) {
      // Never seen this source tool — use global model as fallback
      const globalTotal = this.globalModel.totalFromTool[from];
      if (!globalTotal || globalTotal === 0) {
        return this.config.smoothingFactor; // Completely unknown
      }
      const globalCount = this.globalModel.transitions[from]?.[to] ?? 0;
      return (globalCount + this.config.smoothingFactor) / (globalTotal + this.config.smoothingFactor * this.getToolCount());
    }

    const count = model.transitions[from]?.[to] ?? 0;
    // Laplace smoothing
    const toolCount = this.getToolCount();
    return (count + this.config.smoothingFactor) / (fromTotal + this.config.smoothingFactor * toolCount);
  }

  /**
   * Get the sequence score for a key's recent activity.
   * Returns average transition probability over the window.
   */
  getSequenceScore(key: string): number {
    const state = this.keys.get(key);
    if (!state || state.recentTools.length < 2) return 1.0;

    let totalLogProb = 0;
    let count = 0;

    for (let i = 1; i < state.recentTools.length; i++) {
      const prob = this.getTransitionProbability(state.model, state.recentTools[i - 1], state.recentTools[i]);
      totalLogProb += Math.log(prob);
      count++;
    }

    return count > 0 ? Math.exp(totalLogProb / count) : 1.0;
  }

  /**
   * Get the most common transitions for a key.
   */
  getTopTransitions(key: string, limit: number = 10): Array<{ from: string; to: string; count: number; probability: number }> {
    const state = this.keys.get(key);
    const model = state?.model ?? this.globalModel;

    const transitions: Array<{ from: string; to: string; count: number; probability: number }> = [];

    for (const [from, tos] of Object.entries(model.transitions)) {
      for (const [to, count] of Object.entries(tos)) {
        const prob = this.getTransitionProbability(model, from, to);
        transitions.push({ from, to, count, probability: prob });
      }
    }

    transitions.sort((a, b) => b.count - a.count);
    return transitions.slice(0, limit);
  }

  /**
   * Get key info.
   */
  getKeyInfo(key: string): { enforcing: boolean; transitions: number; recentTools: string[]; sequenceScore: number } | null {
    const state = this.keys.get(key);
    if (!state) return null;

    return {
      enforcing: state.enforcing,
      transitions: state.model.totalTransitions,
      recentTools: [...state.recentTools],
      sequenceScore: this.getSequenceScore(key),
    };
  }

  /**
   * Reset model for a specific key (e.g., after key rotation).
   */
  resetKey(key: string): boolean {
    return this.keys.delete(key);
  }

  /**
   * Get stats.
   */
  getStats(): SequenceAnomalyStats {
    let keysLearning = 0;
    let keysEnforcing = 0;

    for (const state of this.keys.values()) {
      if (state.enforcing) keysEnforcing++;
      else keysLearning++;
    }

    return {
      trackedKeys: this.keys.size,
      totalTransitions: this.globalModel.totalTransitions,
      totalChecks: this.stats.totalChecks,
      totalAnomalies: this.stats.totalAnomalies,
      totalBlocks: this.stats.totalBlocks,
      keysLearning,
      keysEnforcing,
      recentAnomalies: [...this.recentAnomalies],
    };
  }

  /**
   * Get the global baseline model.
   */
  getGlobalModel(): TransitionModel {
    return {
      totalFromTool: { ...this.globalModel.totalFromTool },
      transitions: Object.fromEntries(
        Object.entries(this.globalModel.transitions).map(([k, v]) => [k, { ...v }])
      ),
      totalTransitions: this.globalModel.totalTransitions,
    };
  }

  /**
   * Destroy and release resources.
   */
  destroy(): void {
    this.keys.clear();
    this.globalModel = this.createEmptyModel();
    this.recentAnomalies = [];
    this.stats = { totalChecks: 0, totalAnomalies: 0, totalBlocks: 0 };
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private createEmptyModel(): TransitionModel {
    return { totalFromTool: {}, transitions: {}, totalTransitions: 0 };
  }

  private recordTransition(model: TransitionModel, from: string, to: string): void {
    model.totalFromTool[from] = (model.totalFromTool[from] ?? 0) + 1;

    if (!model.transitions[from]) {
      model.transitions[from] = {};
    }
    model.transitions[from][to] = (model.transitions[from][to] ?? 0) + 1;
    model.totalTransitions++;
  }

  private getToolCount(): number {
    // Count unique tools seen in global model
    const tools = new Set<string>();
    for (const from of Object.keys(this.globalModel.transitions)) {
      tools.add(from);
      for (const to of Object.keys(this.globalModel.transitions[from])) {
        tools.add(to);
      }
    }
    return Math.max(tools.size, 1);
  }

  private evictOldestKey(): void {
    // Remove the key with the fewest transitions (least data)
    let minKey: string | null = null;
    let minTransitions = Infinity;

    for (const [key, state] of this.keys) {
      if (state.model.totalTransitions < minTransitions) {
        minTransitions = state.model.totalTransitions;
        minKey = key;
      }
    }

    if (minKey) {
      this.keys.delete(minKey);
    }
  }
}
