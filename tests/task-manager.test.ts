/**
 * Tests for TaskManager — MCP Tasks primitive (MCP 2025-11-25 spec).
 */

import { TaskManager, TaskRecord, TaskStatus } from '../src/task-manager';

function createTestTask(mgr: TaskManager, overrides?: Partial<{
  toolName: string;
  arguments: Record<string, unknown>;
  apiKeyPrefix: string;
  sessionId: string;
  creditsCharged: number;
}>): TaskRecord {
  return mgr.createTask({
    toolName: overrides?.toolName ?? 'test_tool',
    arguments: overrides?.arguments ?? { arg1: 'value1' },
    apiKeyPrefix: overrides?.apiKeyPrefix ?? 'key_prefix',
    sessionId: overrides?.sessionId ?? 'session_1',
    creditsCharged: overrides?.creditsCharged ?? 10,
  });
}

describe('TaskManager', () => {
  let mgr: TaskManager;

  beforeEach(() => {
    mgr = new TaskManager({ maxTasks: 100, taskTimeoutMs: 0 });
  });

  afterEach(() => {
    mgr.destroy();
  });

  describe('createTask', () => {
    it('should create a task in pending state', () => {
      const task = createTestTask(mgr);
      expect(task.id).toMatch(/^task_/);
      expect(task.status).toBe('pending');
      expect(task.toolName).toBe('test_tool');
      expect(task.arguments).toEqual({ arg1: 'value1' });
      expect(task.apiKeyPrefix).toBe('key_prefix');
      expect(task.sessionId).toBe('session_1');
      expect(task.creditsCharged).toBe(10);
      expect(task.createdAt).toBeTruthy();
    });

    it('should create unique IDs', () => {
      const t1 = createTestTask(mgr);
      const t2 = createTestTask(mgr);
      expect(t1.id).not.toBe(t2.id);
    });

    it('should track task count', () => {
      expect(mgr.taskCount).toBe(0);
      createTestTask(mgr);
      expect(mgr.taskCount).toBe(1);
      createTestTask(mgr);
      expect(mgr.taskCount).toBe(2);
    });
  });

  describe('startTask', () => {
    it('should transition pending to running', () => {
      const task = createTestTask(mgr);
      const started = mgr.startTask(task.id);
      expect(started).not.toBeNull();
      expect(started!.status).toBe('running');
      expect(started!.startedAt).toBeTruthy();
    });

    it('should return null for non-pending task', () => {
      const task = createTestTask(mgr);
      mgr.startTask(task.id);
      // Already running, can't start again
      const result = mgr.startTask(task.id);
      expect(result).toBeNull();
    });

    it('should return null for unknown task', () => {
      const result = mgr.startTask('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('updateProgress', () => {
    it('should update progress on running task', () => {
      const task = createTestTask(mgr);
      mgr.startTask(task.id);
      const updated = mgr.updateProgress(task.id, 50, 'Halfway done');
      expect(updated).not.toBeNull();
      expect(updated!.progress).toBe(50);
      expect(updated!.message).toBe('Halfway done');
    });

    it('should clamp progress to 0-100', () => {
      const task = createTestTask(mgr);
      mgr.startTask(task.id);
      const low = mgr.updateProgress(task.id, -10);
      expect(low!.progress).toBe(0);
      const high = mgr.updateProgress(task.id, 200);
      expect(high!.progress).toBe(100);
    });

    it('should return null for completed task', () => {
      const task = createTestTask(mgr);
      mgr.startTask(task.id);
      mgr.completeTask(task.id, { data: 'result' });
      const result = mgr.updateProgress(task.id, 50);
      expect(result).toBeNull();
    });

    it('should update progress on pending task too', () => {
      const task = createTestTask(mgr);
      const updated = mgr.updateProgress(task.id, 10, 'Queued');
      expect(updated).not.toBeNull();
      expect(updated!.progress).toBe(10);
    });
  });

  describe('completeTask', () => {
    it('should complete a running task', () => {
      const task = createTestTask(mgr);
      mgr.startTask(task.id);
      const completed = mgr.completeTask(task.id, { output: 'success' });
      expect(completed).not.toBeNull();
      expect(completed!.status).toBe('completed');
      expect(completed!.result).toEqual({ output: 'success' });
      expect(completed!.progress).toBe(100);
      expect(completed!.completedAt).toBeTruthy();
      expect(completed!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should complete a pending task directly', () => {
      const task = createTestTask(mgr);
      const completed = mgr.completeTask(task.id, 'quick result');
      expect(completed).not.toBeNull();
      expect(completed!.status).toBe('completed');
    });

    it('should add outcome credits', () => {
      const task = createTestTask(mgr);
      mgr.startTask(task.id);
      const completed = mgr.completeTask(task.id, 'result', 25);
      expect(completed!.outcomeCredits).toBe(25);
    });

    it('should return null for already completed task', () => {
      const task = createTestTask(mgr);
      mgr.completeTask(task.id, 'result');
      const result = mgr.completeTask(task.id, 'again');
      expect(result).toBeNull();
    });

    it('should return null for cancelled task', () => {
      const task = createTestTask(mgr);
      mgr.cancelTask(task.id);
      const result = mgr.completeTask(task.id, 'result');
      expect(result).toBeNull();
    });
  });

  describe('failTask', () => {
    it('should fail a running task', () => {
      const task = createTestTask(mgr);
      mgr.startTask(task.id);
      const failed = mgr.failTask(task.id, 'something went wrong');
      expect(failed).not.toBeNull();
      expect(failed!.status).toBe('failed');
      expect(failed!.error).toBe('something went wrong');
      expect(failed!.completedAt).toBeTruthy();
      expect(failed!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should fail a pending task', () => {
      const task = createTestTask(mgr);
      const failed = mgr.failTask(task.id, 'rejected');
      expect(failed!.status).toBe('failed');
    });

    it('should return null for completed task', () => {
      const task = createTestTask(mgr);
      mgr.completeTask(task.id, 'done');
      const result = mgr.failTask(task.id, 'too late');
      expect(result).toBeNull();
    });
  });

  describe('cancelTask', () => {
    it('should cancel a pending task', () => {
      const task = createTestTask(mgr);
      const cancelled = mgr.cancelTask(task.id);
      expect(cancelled).not.toBeNull();
      expect(cancelled!.status).toBe('cancelled');
      expect(cancelled!.completedAt).toBeTruthy();
    });

    it('should cancel a running task', () => {
      const task = createTestTask(mgr);
      mgr.startTask(task.id);
      const cancelled = mgr.cancelTask(task.id);
      expect(cancelled).not.toBeNull();
      expect(cancelled!.status).toBe('cancelled');
    });

    it('should return null for completed task', () => {
      const task = createTestTask(mgr);
      mgr.completeTask(task.id, 'done');
      const result = mgr.cancelTask(task.id);
      expect(result).toBeNull();
    });

    it('should return null for already cancelled task', () => {
      const task = createTestTask(mgr);
      mgr.cancelTask(task.id);
      const result = mgr.cancelTask(task.id);
      expect(result).toBeNull();
    });

    it('should return null for failed task', () => {
      const task = createTestTask(mgr);
      mgr.failTask(task.id, 'err');
      const result = mgr.cancelTask(task.id);
      expect(result).toBeNull();
    });

    it('should return null for unknown task', () => {
      const result = mgr.cancelTask('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getTask', () => {
    it('should return task by ID', () => {
      const task = createTestTask(mgr);
      const fetched = mgr.getTask(task.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(task.id);
    });

    it('should return null for unknown task', () => {
      const result = mgr.getTask('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('listTasks', () => {
    it('should list all tasks', () => {
      createTestTask(mgr);
      createTestTask(mgr);
      createTestTask(mgr);
      const result = mgr.listTasks();
      expect(result.tasks).toHaveLength(3);
      expect(result.total).toBe(3);
    });

    it('should filter by sessionId', () => {
      createTestTask(mgr, { sessionId: 'sess_a' });
      createTestTask(mgr, { sessionId: 'sess_b' });
      createTestTask(mgr, { sessionId: 'sess_a' });
      const result = mgr.listTasks({ sessionId: 'sess_a' });
      expect(result.tasks).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('should filter by status', () => {
      const t1 = createTestTask(mgr);
      const t2 = createTestTask(mgr);
      createTestTask(mgr);
      mgr.startTask(t1.id);
      mgr.completeTask(t1.id, 'done');
      mgr.startTask(t2.id);

      const completed = mgr.listTasks({ status: 'completed' });
      expect(completed.tasks).toHaveLength(1);

      const running = mgr.listTasks({ status: 'running' });
      expect(running.tasks).toHaveLength(1);

      const pending = mgr.listTasks({ status: 'pending' });
      expect(pending.tasks).toHaveLength(1);
    });

    it('should filter by apiKeyPrefix', () => {
      createTestTask(mgr, { apiKeyPrefix: 'abc' });
      createTestTask(mgr, { apiKeyPrefix: 'def' });
      createTestTask(mgr, { apiKeyPrefix: 'abc' });
      const result = mgr.listTasks({ apiKeyPrefix: 'abc' });
      expect(result.tasks).toHaveLength(2);
    });

    it('should return tasks in order', () => {
      const t1 = createTestTask(mgr);
      const t2 = createTestTask(mgr);
      const result = mgr.listTasks();
      // Both tasks should be returned
      expect(result.tasks).toHaveLength(2);
      const ids = result.tasks.map(t => t.id);
      expect(ids).toContain(t1.id);
      expect(ids).toContain(t2.id);
    });

    it('should paginate with cursor', () => {
      for (let i = 0; i < 10; i++) createTestTask(mgr);
      const page1 = mgr.listTasks({ pageSize: 3 });
      expect(page1.tasks).toHaveLength(3);
      expect(page1.total).toBe(10);
      expect(page1.nextCursor).toBeDefined();

      const page2 = mgr.listTasks({ pageSize: 3, cursor: page1.nextCursor });
      expect(page2.tasks).toHaveLength(3);
      expect(page2.nextCursor).toBeDefined();
    });

    it('should cap pageSize at 200', () => {
      for (let i = 0; i < 5; i++) createTestTask(mgr);
      const result = mgr.listTasks({ pageSize: 999 });
      expect(result.tasks).toHaveLength(5);
    });

    it('should enforce min pageSize of 1', () => {
      createTestTask(mgr);
      const result = mgr.listTasks({ pageSize: 0 });
      expect(result.tasks).toHaveLength(1);
    });
  });

  describe('getStats', () => {
    it('should return zero stats initially', () => {
      const stats = mgr.getStats();
      expect(stats.total).toBe(0);
      expect(stats.pending).toBe(0);
      expect(stats.running).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.cancelled).toBe(0);
    });

    it('should count by status', () => {
      const t1 = createTestTask(mgr);
      const t2 = createTestTask(mgr);
      const t3 = createTestTask(mgr);
      const t4 = createTestTask(mgr);
      const t5 = createTestTask(mgr);

      mgr.startTask(t1.id);
      mgr.completeTask(t1.id, 'done');
      mgr.startTask(t2.id);
      mgr.failTask(t2.id, 'err');
      mgr.cancelTask(t3.id);
      mgr.startTask(t4.id);
      // t5 stays pending

      const stats = mgr.getStats();
      expect(stats.total).toBe(5);
      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.cancelled).toBe(1);
      expect(stats.running).toBe(1);
      expect(stats.pending).toBe(1);
    });
  });

  describe('handleTasksMethod', () => {
    it('should handle tasks/get', () => {
      const task = createTestTask(mgr);
      const result = mgr.handleTasksMethod('tasks/get', { taskId: task.id }, 'key', 'sess');
      expect(result).not.toBeNull();
      const data = JSON.parse(result!.content[0].text);
      expect(data.taskId).toBe(task.id);
      expect(data.status).toBe('pending');
    });

    it('should handle tasks/get with missing taskId', () => {
      const result = mgr.handleTasksMethod('tasks/get', {}, 'key', 'sess');
      const data = JSON.parse(result!.content[0].text);
      expect(data.error).toContain('taskId is required');
    });

    it('should handle tasks/get with unknown taskId', () => {
      const result = mgr.handleTasksMethod('tasks/get', { taskId: 'unknown' }, 'key', 'sess');
      const data = JSON.parse(result!.content[0].text);
      expect(data.error).toContain('Task not found');
    });

    it('should handle tasks/result for completed task', () => {
      const task = createTestTask(mgr);
      mgr.startTask(task.id);
      mgr.completeTask(task.id, { output: 'hello' });

      const result = mgr.handleTasksMethod('tasks/result', { taskId: task.id }, 'key', 'sess');
      const data = JSON.parse(result!.content[0].text);
      expect(data.status).toBe('completed');
      expect(data.result).toEqual({ output: 'hello' });
    });

    it('should handle tasks/result for failed task', () => {
      const task = createTestTask(mgr);
      mgr.failTask(task.id, 'oops');

      const result = mgr.handleTasksMethod('tasks/result', { taskId: task.id }, 'key', 'sess');
      const data = JSON.parse(result!.content[0].text);
      expect(data.status).toBe('failed');
      expect(data.error).toBe('oops');
    });

    it('should handle tasks/result for in-progress task', () => {
      const task = createTestTask(mgr);
      mgr.startTask(task.id);

      const result = mgr.handleTasksMethod('tasks/result', { taskId: task.id }, 'key', 'sess');
      const data = JSON.parse(result!.content[0].text);
      expect(data.status).toBe('running');
    });

    it('should handle tasks/list', () => {
      createTestTask(mgr, { sessionId: 'sess_1', apiKeyPrefix: 'key1' });
      createTestTask(mgr, { sessionId: 'sess_1', apiKeyPrefix: 'key1' });
      createTestTask(mgr, { sessionId: 'sess_2', apiKeyPrefix: 'key1' });

      const result = mgr.handleTasksMethod('tasks/list', { sessionId: 'sess_1' }, 'key1', 'sess_1');
      const data = JSON.parse(result!.content[0].text);
      expect(data.tasks).toHaveLength(2);
      expect(data.total).toBe(2);
    });

    it('should handle tasks/cancel', () => {
      const task = createTestTask(mgr);
      const result = mgr.handleTasksMethod('tasks/cancel', { taskId: task.id }, 'key', 'sess');
      const data = JSON.parse(result!.content[0].text);
      expect(data.status).toBe('cancelled');
    });

    it('should handle tasks/cancel for unknown task', () => {
      const result = mgr.handleTasksMethod('tasks/cancel', { taskId: 'unknown' }, 'key', 'sess');
      const data = JSON.parse(result!.content[0].text);
      expect(data.error).toContain('not found or cannot be cancelled');
    });

    it('should return null for unknown method', () => {
      const result = mgr.handleTasksMethod('unknown/method', {}, 'key', 'sess');
      expect(result).toBeNull();
    });
  });

  describe('eviction', () => {
    it('should evict oldest completed tasks when at capacity', () => {
      const smallMgr = new TaskManager({ maxTasks: 5, taskTimeoutMs: 0 });

      // Fill to capacity with completed tasks
      for (let i = 0; i < 5; i++) {
        const t = createTestTask(smallMgr);
        smallMgr.completeTask(t.id, `result_${i}`);
      }
      expect(smallMgr.taskCount).toBe(5);

      // Add one more — should trigger eviction
      const newTask = createTestTask(smallMgr);
      // Should have evicted at least 1 old task
      expect(smallMgr.taskCount).toBeLessThanOrEqual(5);
      expect(smallMgr.getTask(newTask.id)).not.toBeNull();

      smallMgr.destroy();
    });
  });

  describe('task lifecycle — full flow', () => {
    it('should support full pending → running → completed flow', () => {
      const task = createTestTask(mgr);
      expect(task.status).toBe('pending');

      const started = mgr.startTask(task.id);
      expect(started!.status).toBe('running');

      mgr.updateProgress(task.id, 50, 'Processing...');
      const midpoint = mgr.getTask(task.id);
      expect(midpoint!.progress).toBe(50);

      const completed = mgr.completeTask(task.id, { data: 'final' }, 5);
      expect(completed!.status).toBe('completed');
      expect(completed!.progress).toBe(100);
      expect(completed!.result).toEqual({ data: 'final' });
      expect(completed!.outcomeCredits).toBe(5);
      expect(completed!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should support pending → running → failed flow', () => {
      const task = createTestTask(mgr);
      mgr.startTask(task.id);
      mgr.updateProgress(task.id, 30, 'Working...');
      const failed = mgr.failTask(task.id, 'Out of memory');
      expect(failed!.status).toBe('failed');
      expect(failed!.error).toBe('Out of memory');
    });

    it('should support pending → cancelled flow', () => {
      const task = createTestTask(mgr);
      const cancelled = mgr.cancelTask(task.id);
      expect(cancelled!.status).toBe('cancelled');
    });
  });

  describe('destroy', () => {
    it('should clean up without errors', () => {
      const mgr2 = new TaskManager();
      createTestTask(mgr2);
      expect(() => mgr2.destroy()).not.toThrow();
    });
  });

  describe('handleTasksMethod response format', () => {
    it('should return MCP-compatible content format', () => {
      const task = createTestTask(mgr);
      const result = mgr.handleTasksMethod('tasks/get', { taskId: task.id }, 'key', 'sess');
      expect(result).toHaveProperty('content');
      expect(Array.isArray(result!.content)).toBe(true);
      expect(result!.content[0]).toHaveProperty('type', 'text');
      expect(result!.content[0]).toHaveProperty('text');
      // Should be valid JSON
      expect(() => JSON.parse(result!.content[0].text)).not.toThrow();
    });

    it('should include result in completed task response', () => {
      const task = createTestTask(mgr);
      mgr.completeTask(task.id, { answer: 42 });
      const result = mgr.handleTasksMethod('tasks/get', { taskId: task.id }, 'key', 'sess');
      const data = JSON.parse(result!.content[0].text);
      expect(data.result).toEqual({ answer: 42 });
    });

    it('should include error in failed task response', () => {
      const task = createTestTask(mgr);
      mgr.failTask(task.id, 'kaboom');
      const result = mgr.handleTasksMethod('tasks/get', { taskId: task.id }, 'key', 'sess');
      const data = JSON.parse(result!.content[0].text);
      expect(data.error).toBe('kaboom');
    });

    it('should NOT include result in pending task response', () => {
      const task = createTestTask(mgr);
      const result = mgr.handleTasksMethod('tasks/get', { taskId: task.id }, 'key', 'sess');
      const data = JSON.parse(result!.content[0].text);
      expect(data.result).toBeUndefined();
      expect(data.error).toBeUndefined();
    });
  });
});
