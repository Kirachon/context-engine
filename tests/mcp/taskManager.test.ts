import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { handleIndexWorkspace } from '../../src/mcp/tools/index.js';
import { handleReindexWorkspace } from '../../src/mcp/tools/lifecycle.js';
import { IndexResult, IndexStatus } from '../../src/mcp/serviceClient.js';
import {
  createTaskManager,
  executeIndexingTask,
  getDefaultTaskManager,
  resetDefaultTaskManagerForTests,
  shouldUseIndexingTaskMode,
  startIndexingTask,
} from '../../src/mcp/tasks/taskManager.js';

describe('taskManager', () => {
  afterEach(() => {
    resetDefaultTaskManagerForTests();
  });

  it('creates queued tasks with timestamps and progress', () => {
    const manager = createTaskManager();
    const task = manager.createTask({
      kind: 'index_workspace',
      progress: { current: 0, message: 'Queued workspace indexing' },
    });

    expect(task.id).toMatch(/^task_index_workspace_/);
    expect(task.kind).toBe('index_workspace');
    expect(task.status).toBe('queued');
    expect(task.progress).toEqual({
      current: 0,
      message: 'Queued workspace indexing',
    });
    expect(task.createdAt).toEqual(task.updatedAt);
    expect(task.error).toBeUndefined();
  });

  it('lists and retrieves tasks with optional filters', () => {
    const manager = createTaskManager();
    const first = manager.createTask({ kind: 'index_workspace' });
    const second = manager.createTask({ kind: 'reindex_workspace' });

    expect(manager.getTask(first.id)?.id).toBe(first.id);
    expect(manager.listTasks()).toHaveLength(2);
    expect(manager.listTasks({ kind: 'reindex_workspace' })).toEqual([
      expect.objectContaining({ id: second.id }),
    ]);
  });

  it('transitions tasks through running, completed, and failed states', () => {
    const manager = createTaskManager();
    const task = manager.createTask({ kind: 'index_workspace' });

    const running = manager.markTaskRunning(task.id);
    expect(running?.status).toBe('running');

    const completed = manager.markTaskCompleted(task.id, { indexed: 3 }, {
      current: 3,
      total: 3,
      message: 'Indexed 3 files',
    });
    expect(completed?.status).toBe('completed');
    expect(completed?.result).toEqual({ indexed: 3 });
    expect(completed?.progress.message).toBe('Indexed 3 files');

    const failedTask = manager.createTask({ kind: 'index_workspace' });
    manager.markTaskRunning(failedTask.id);
    const failed = manager.markTaskFailed(failedTask.id, 'boom');
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBe('boom');
  });

  it('cancels queued tasks immediately and preserves terminal tasks', () => {
    const manager = createTaskManager();
    const queued = manager.createTask({ kind: 'index_workspace' });
    const completed = manager.createTask({ kind: 'index_workspace' });
    manager.markTaskRunning(completed.id);
    manager.markTaskCompleted(completed.id, { indexed: 1 });

    const cancelled = manager.cancelTask(queued.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(manager.isTaskCancelled(queued.id)).toBe(true);
    expect(manager.cancelTask(completed.id)?.status).toBe('completed');
  });

  it('keeps cancelled status when a running indexing task finishes', async () => {
    const manager = createTaskManager();
    const task = manager.createTask({ kind: 'index_workspace' });
    const serviceClient = {
      clearIndex: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      indexWorkspace: jest.fn<() => Promise<IndexResult>>().mockImplementation(async () => {
        manager.cancelTask(task.id);
        return {
          indexed: 5,
          skipped: 0,
          errors: [],
          duration: 10,
        };
      }),
    };

    const finalTask = await executeIndexingTask(task.id, serviceClient as any, {}, manager);
    expect(serviceClient.indexWorkspace).toHaveBeenCalledTimes(1);
    expect(finalTask?.status).toBe('cancelled');
    expect(finalTask?.result).toBeUndefined();
  });

  it('executes indexing tasks and records progress/results', async () => {
    const manager = createTaskManager();
    const task = manager.createTask({ kind: 'index_workspace' });
    const result: IndexResult = {
      indexed: 12,
      skipped: 2,
      errors: [],
      duration: 50,
      totalIndexable: 14,
    };
    const serviceClient = {
      clearIndex: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      indexWorkspace: jest.fn<() => Promise<IndexResult>>().mockResolvedValue(result),
    };

    const finalTask = await executeIndexingTask(task.id, serviceClient as any, { force: true }, manager);

    expect(serviceClient.clearIndex).toHaveBeenCalledTimes(1);
    expect(serviceClient.indexWorkspace).toHaveBeenCalledTimes(1);
    expect(finalTask?.status).toBe('completed');
    expect(finalTask?.result).toEqual(result);
    expect(finalTask?.progress).toEqual({
      current: 12,
      total: 14,
      message: 'Indexed 12 files',
    });
  });

  it('marks indexing tasks failed when serviceClient throws', async () => {
    const manager = createTaskManager();
    const task = manager.createTask({ kind: 'reindex_workspace' });
    const serviceClient = {
      clearIndex: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('clear failed')),
      indexWorkspace: jest.fn<() => Promise<IndexResult>>(),
    };

    const finalTask = await executeIndexingTask(task.id, serviceClient as any, { reindex: true }, manager);

    expect(finalTask?.status).toBe('failed');
    expect(finalTask?.error).toBe('clear failed');
    expect(serviceClient.indexWorkspace).not.toHaveBeenCalled();
  });

  it('starts background indexing tasks without blocking', async () => {
    const manager = createTaskManager();
    let releaseIndex: (() => void) | undefined;
    const indexGate = new Promise<void>((resolve) => {
      releaseIndex = resolve;
    });
    const serviceClient = {
      clearIndex: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      indexWorkspace: jest.fn<() => Promise<IndexResult>>().mockImplementation(async () => {
        await indexGate;
        return {
          indexed: 1,
          skipped: 0,
          errors: [],
          duration: 5,
        };
      }),
    };

    const task = startIndexingTask(serviceClient as any, { reindex: true }, manager);
    expect(task.status).toBe('queued');

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.getTask(task.id)?.status).toBe('running');

    releaseIndex?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.getTask(task.id)?.status).toBe('completed');
  });

  it('detects task mode flags', () => {
    expect(shouldUseIndexingTaskMode({})).toBe(false);
    expect(shouldUseIndexingTaskMode({ background: true })).toBe(true);
    expect(shouldUseIndexingTaskMode({ task: true })).toBe(true);
  });
});

describe('indexing task tool integration', () => {
  let mockServiceClient: {
    clearIndex: ReturnType<typeof jest.fn>;
    indexWorkspace: ReturnType<typeof jest.fn>;
    getIndexStatus: ReturnType<typeof jest.fn>;
  };

  beforeEach(() => {
    resetDefaultTaskManagerForTests();
    jest.clearAllMocks();

    const result: IndexResult = {
      indexed: 10,
      skipped: 1,
      errors: [],
      duration: 100,
      totalIndexable: 11,
    };
    const status: IndexStatus = {
      workspace: '/tmp/workspace',
      status: 'idle',
      lastIndexed: '2025-01-11T00:00:00.000Z',
      fileCount: 42,
      isStale: false,
    };

    mockServiceClient = {
      clearIndex: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      indexWorkspace: jest.fn<() => Promise<IndexResult>>().mockResolvedValue(result),
      getIndexStatus: jest.fn().mockReturnValue(status),
    };
  });

  it('keeps synchronous index_workspace behavior by default', async () => {
    const result = await handleIndexWorkspace({}, mockServiceClient as any);
    const payload = JSON.parse(result);

    expect(payload.success).toBe(true);
    expect(payload.indexed).toBe(10);
    expect(payload.task_id).toBeUndefined();
    expect(mockServiceClient.indexWorkspace).toHaveBeenCalledTimes(1);
  });

  it('returns task metadata for background index_workspace calls', async () => {
    const result = await handleIndexWorkspace({ background: true }, mockServiceClient as any);
    const payload = JSON.parse(result);

    expect(payload.success).toBe(true);
    expect(payload.message).toContain('Background indexing started');
    expect(payload.task_id).toMatch(/^task_index_workspace_/);
    expect(payload.task_status).toBe('queued');
    expect(payload.progress.message).toContain('Queued workspace indexing');

    await new Promise((resolve) => setTimeout(resolve, 0));
    const task = getDefaultTaskManager().getTask(payload.task_id);
    expect(task?.status).toBe('completed');
    expect(task?.progress.current).toBe(10);
  });

  it('keeps synchronous reindex_workspace behavior by default', async () => {
    const result = await handleReindexWorkspace({}, mockServiceClient as any);
    const payload = JSON.parse(result);

    expect(payload.success).toBe(true);
    expect(payload.indexed).toBe(10);
    expect(payload.task_id).toBeUndefined();
    expect(mockServiceClient.clearIndex).toHaveBeenCalledTimes(1);
    expect(mockServiceClient.indexWorkspace).toHaveBeenCalledTimes(1);
  });

  it('returns task metadata for task-mode reindex_workspace calls', async () => {
    const result = await handleReindexWorkspace({ task: true }, mockServiceClient as any);
    const payload = JSON.parse(result);

    expect(payload.success).toBe(true);
    expect(payload.message).toContain('Background reindexing started');
    expect(payload.task_id).toMatch(/^task_reindex_workspace_/);
    expect(payload.task_kind).toBe('reindex_workspace');

    await new Promise((resolve) => setTimeout(resolve, 0));
    const task = getDefaultTaskManager().getTask(payload.task_id);
    expect(task?.status).toBe('completed');
    expect(mockServiceClient.clearIndex).toHaveBeenCalledTimes(1);
  });
});
