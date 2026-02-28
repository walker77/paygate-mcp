/**
 * Tests for A2A Protocol Support.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { A2AManager, A2AManagerConfig, AgentCard, A2ATask, A2ARequest } from '../src/a2a-protocol';

function createTestConfig(): A2AManagerConfig {
  return {
    agentCard: {
      name: 'Test Agent',
      description: 'A test agent for unit tests',
      version: '1.0.0',
      url: 'http://localhost:3000/a2a',
      skills: [
        {
          id: 'code-review',
          name: 'Code Review',
          description: 'Review code for quality issues',
          tags: ['code', 'review', 'quality'],
          examples: ['Review this pull request'],
        },
        {
          id: 'data-analysis',
          name: 'Data Analysis',
          description: 'Analyze datasets and generate reports',
          tags: ['data', 'analysis', 'reports'],
        },
      ],
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: true,
      },
    },
  };
}

describe('A2AManager', () => {
  let manager: A2AManager;

  beforeEach(() => {
    manager = new A2AManager(createTestConfig());
  });

  // ─── Agent Card ─────────────────────────────────────────────────────
  describe('agent card', () => {
    it('returns the agent card', () => {
      const card = manager.getAgentCard();
      expect(card.name).toBe('Test Agent');
      expect(card.skills).toHaveLength(2);
      expect(card.version).toBe('1.0.0');
    });

    it('updates agent card', () => {
      manager.updateAgentCard({ version: '2.0.0' });
      expect(manager.getAgentCard().version).toBe('2.0.0');
    });
  });

  // ─── Task Creation ──────────────────────────────────────────────────
  describe('tasks/send', () => {
    it('creates a new task', () => {
      const response = manager.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          message: {
            role: 'user',
            parts: [{ type: 'text', text: 'Please review my code' }],
          },
        },
      });

      expect(response.error).toBeUndefined();
      const task = response.result as A2ATask;
      expect(task.id).toBeDefined();
      expect(task.status.state).toBe('submitted');
      expect(task.sessionId).toBeDefined();
    });

    it('creates a task with explicit ID', () => {
      const response = manager.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          id: 'custom-task-1',
          message: {
            role: 'user',
            parts: [{ type: 'text', text: 'Hello' }],
          },
        },
      });

      const task = response.result as A2ATask;
      expect(task.id).toBe('custom-task-1');
    });

    it('appends message to existing task', () => {
      // Create task
      const r1 = manager.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          id: 'task-1',
          message: {
            role: 'user',
            parts: [{ type: 'text', text: 'First message' }],
          },
        },
      });
      expect(r1.error).toBeUndefined();

      // Append
      const r2 = manager.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/send',
        params: {
          id: 'task-1',
          message: {
            role: 'user',
            parts: [{ type: 'text', text: 'Follow up' }],
          },
        },
      });

      const task = r2.result as A2ATask;
      expect(task.status.state).toBe('working');
      expect(task.history).toHaveLength(1); // Previous status recorded
    });

    it('rejects empty message', () => {
      const response = manager.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          message: { role: 'user', parts: [] },
        },
      });

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32602);
    });

    it('supports file parts', () => {
      const response = manager.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          message: {
            role: 'user',
            parts: [
              { type: 'text', text: 'Analyze this file' },
              { type: 'file', file: { name: 'data.csv', mimeType: 'text/csv', uri: 'file:///tmp/data.csv' } },
            ],
          },
        },
      });

      expect(response.error).toBeUndefined();
    });
  });

  // ─── Task Get ───────────────────────────────────────────────────────
  describe('tasks/get', () => {
    it('retrieves a task by ID', () => {
      manager.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          id: 'task-1',
          message: { role: 'user', parts: [{ type: 'text', text: 'Test' }] },
        },
      });

      const response = manager.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/get',
        params: { id: 'task-1' },
      });

      expect(response.error).toBeUndefined();
      const task = response.result as A2ATask;
      expect(task.id).toBe('task-1');
    });

    it('returns error for unknown task', () => {
      const response = manager.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/get',
        params: { id: 'nonexistent' },
      });

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32001);
    });

    it('returns error without task ID', () => {
      const response = manager.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/get',
        params: {},
      });

      expect(response.error).toBeDefined();
    });
  });

  // ─── Task Cancel ────────────────────────────────────────────────────
  describe('tasks/cancel', () => {
    it('cancels a submitted task', () => {
      manager.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          id: 'task-1',
          message: { role: 'user', parts: [{ type: 'text', text: 'Test' }] },
        },
      });

      const response = manager.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/cancel',
        params: { id: 'task-1' },
      });

      expect(response.error).toBeUndefined();
      const task = response.result as A2ATask;
      expect(task.status.state).toBe('canceled');
    });

    it('cannot cancel a completed task', () => {
      manager.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          id: 'task-1',
          message: { role: 'user', parts: [{ type: 'text', text: 'Test' }] },
        },
      });

      // Complete the task
      manager.transitionTask('task-1', 'completed');

      const response = manager.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/cancel',
        params: { id: 'task-1' },
      });

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32002);
    });
  });

  // ─── Task Transitions ──────────────────────────────────────────────
  describe('transitionTask', () => {
    it('transitions task state', () => {
      manager.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          id: 'task-1',
          message: { role: 'user', parts: [{ type: 'text', text: 'Test' }] },
        },
      });

      const task = manager.transitionTask('task-1', 'working');
      expect(task?.status.state).toBe('working');
    });

    it('adds artifacts during transition', () => {
      manager.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          id: 'task-1',
          message: { role: 'user', parts: [{ type: 'text', text: 'Test' }] },
        },
      });

      const artifact = {
        id: 'artifact-1',
        name: 'result.json',
        parts: [{ type: 'data' as const, data: { score: 95 } }],
        lastChunk: true,
      };

      manager.transitionTask('task-1', 'completed', undefined, artifact);
      const task = manager.getTask('task-1');
      expect(task?.artifacts).toHaveLength(1);
      expect(task?.artifacts[0].name).toBe('result.json');
    });

    it('records state history', () => {
      manager.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          id: 'task-1',
          message: { role: 'user', parts: [{ type: 'text', text: 'Test' }] },
        },
      });

      manager.transitionTask('task-1', 'working');
      manager.transitionTask('task-1', 'completed');

      const task = manager.getTask('task-1');
      expect(task?.history).toHaveLength(2); // submitted → working, working → completed
      expect(task?.history[0].state).toBe('submitted');
      expect(task?.history[1].state).toBe('working');
    });

    it('returns null for unknown task', () => {
      expect(manager.transitionTask('nonexistent', 'working')).toBeNull();
    });
  });

  // ─── List Tasks ─────────────────────────────────────────────────────
  describe('listTasks', () => {
    it('lists all tasks', () => {
      for (let i = 0; i < 3; i++) {
        manager.handleRequest({
          jsonrpc: '2.0',
          id: i,
          method: 'tasks/send',
          params: {
            id: `task-${i}`,
            message: { role: 'user', parts: [{ type: 'text', text: `Task ${i}` }] },
          },
        });
      }

      const tasks = manager.listTasks();
      expect(tasks).toHaveLength(3);
    });

    it('filters by status', () => {
      manager.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: { id: 'task-1', message: { role: 'user', parts: [{ type: 'text', text: 'A' }] } },
      });
      manager.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/send',
        params: { id: 'task-2', message: { role: 'user', parts: [{ type: 'text', text: 'B' }] } },
      });
      manager.transitionTask('task-1', 'completed');

      const completed = manager.listTasks({ status: 'completed' });
      expect(completed).toHaveLength(1);
      expect(completed[0].id).toBe('task-1');
    });

    it('limits results', () => {
      for (let i = 0; i < 5; i++) {
        manager.handleRequest({
          jsonrpc: '2.0',
          id: i,
          method: 'tasks/send',
          params: { id: `task-${i}`, message: { role: 'user', parts: [{ type: 'text', text: `T${i}` }] } },
        });
      }

      const tasks = manager.listTasks({ limit: 2 });
      expect(tasks).toHaveLength(2);
    });
  });

  // ─── Skill Search ──────────────────────────────────────────────────
  describe('findSkills', () => {
    it('finds skills by name', () => {
      const skills = manager.findSkills('code');
      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe('code-review');
    });

    it('finds skills by tag', () => {
      const skills = manager.findSkills('analysis');
      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe('data-analysis');
    });

    it('returns empty for no match', () => {
      const skills = manager.findSkills('nonexistent');
      expect(skills).toHaveLength(0);
    });
  });

  // ─── Unknown Method ────────────────────────────────────────────────
  describe('unknown method', () => {
    it('returns error for unknown method', () => {
      const response = manager.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/sendSubscribe' as any,
        params: {},
      });

      // sendSubscribe is defined in type but not implemented
      // The handler should catch it
      expect(response.error).toBeDefined();
    });
  });

  // ─── Stats ──────────────────────────────────────────────────────────
  describe('stats', () => {
    it('tracks task stats', () => {
      manager.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          id: 'task-1',
          message: { role: 'user', parts: [{ type: 'text', text: 'Test' }] },
        },
      });

      manager.transitionTask('task-1', 'completed', undefined, {
        id: 'a1',
        parts: [{ type: 'text', text: 'Result' }],
      });

      const stats = manager.getStats();
      expect(stats.totalTasks).toBe(1);
      expect(stats.totalMessages).toBe(1);
      expect(stats.totalArtifacts).toBe(1);
      expect(stats.byStatus.completed).toBe(1);
    });
  });

  // ─── Cleanup ────────────────────────────────────────────────────────
  describe('cleanup', () => {
    it('removes old tasks', async () => {
      manager.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          id: 'old-task',
          message: { role: 'user', parts: [{ type: 'text', text: 'Test' }] },
        },
      });
      manager.transitionTask('old-task', 'completed');

      await new Promise(r => setTimeout(r, 20));
      const cleaned = manager.cleanup(10); // 10ms — task is older
      expect(cleaned).toBe(1);
      expect(manager.getTask('old-task')).toBeNull();
    });
  });

  // ─── Destroy ────────────────────────────────────────────────────────
  describe('destroy', () => {
    it('releases resources', () => {
      manager.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          id: 'task-1',
          message: { role: 'user', parts: [{ type: 'text', text: 'Test' }] },
        },
      });

      manager.destroy();
      expect(manager.getStats().totalTasks).toBe(0);
    });
  });
});
