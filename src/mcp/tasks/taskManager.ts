import { randomUUID } from 'crypto';
import type { ContextServiceClient, IndexResult } from '../serviceClient.js';
import { auditLogTaskLifecycle } from '../../telemetry/auditLog.js';

export type McpTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface McpTaskProgress {
  current: number;
  total?: number;
  message?: string;
}

export interface McpTaskRecord {
  id: string;
  kind: string;
  status: McpTaskStatus;
  progress: McpTaskProgress;
  createdAt: string;
  updatedAt: string;
  error?: string;
  result?: unknown;
}

export interface CreateTaskInput {
  kind: string;
  progress?: Partial<McpTaskProgress>;
}

export interface ListTasksFilter {
  kind?: string;
  status?: McpTaskStatus;
}

export interface TaskManager {
  createTask(input: CreateTaskInput): McpTaskRecord;
  getTask(id: string): McpTaskRecord | null;
  listTasks(filter?: ListTasksFilter): McpTaskRecord[];
  cancelTask(id: string): McpTaskRecord | null;
  updateTaskProgress(id: string, progress: Partial<McpTaskProgress>): McpTaskRecord | null;
  markTaskRunning(id: string): McpTaskRecord | null;
  markTaskCompleted(id: string, result?: unknown, progress?: Partial<McpTaskProgress>): McpTaskRecord | null;
  markTaskFailed(id: string, error: string): McpTaskRecord | null;
  isTaskCancelled(id: string): boolean;
}

class InMemoryTaskManager implements TaskManager {
  private readonly tasks = new Map<string, McpTaskRecord>();
  private readonly cancelledTaskIds = new Set<string>();

  createTask(input: CreateTaskInput): McpTaskRecord {
    const now = new Date().toISOString();
    const id = `task_${input.kind}_${randomUUID()}`;
    const record: McpTaskRecord = {
      id,
      kind: input.kind,
      status: 'queued',
      progress: {
        current: input.progress?.current ?? 0,
        total: input.progress?.total,
        message: input.progress?.message,
      },
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(id, record);
    auditLogTaskLifecycle(id, input.kind, record.status, {
      progressMessage: record.progress.message,
    });
    return this.clone(record);
  }

  getTask(id: string): McpTaskRecord | null {
    const record = this.tasks.get(id);
    return record ? this.clone(record) : null;
  }

  listTasks(filter?: ListTasksFilter): McpTaskRecord[] {
    const records = [...this.tasks.values()];
    const filtered = records.filter((record) => {
      if (filter?.kind && record.kind !== filter.kind) {
        return false;
      }
      if (filter?.status && record.status !== filter.status) {
        return false;
      }
      return true;
    });
    return filtered
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((record) => this.clone(record));
  }

  cancelTask(id: string): McpTaskRecord | null {
    const record = this.tasks.get(id);
    if (!record) {
      return null;
    }

    if (
      record.status === 'completed'
      || record.status === 'failed'
      || record.status === 'cancelled'
    ) {
      return this.clone(record);
    }

    this.cancelledTaskIds.add(id);
    return this.patchTask(id, { status: 'cancelled' });
  }

  updateTaskProgress(id: string, progress: Partial<McpTaskProgress>): McpTaskRecord | null {
    const record = this.tasks.get(id);
    if (!record) {
      return null;
    }

    return this.patchTask(id, {
      progress: {
        ...record.progress,
        ...progress,
      },
    });
  }

  markTaskRunning(id: string): McpTaskRecord | null {
    const record = this.tasks.get(id);
    if (!record || record.status !== 'queued') {
      return record ? this.clone(record) : null;
    }

    if (this.isTaskCancelled(id)) {
      return this.patchTask(id, { status: 'cancelled' });
    }

    return this.patchTask(id, { status: 'running' });
  }

  markTaskCompleted(
    id: string,
    result?: unknown,
    progress?: Partial<McpTaskProgress>
  ): McpTaskRecord | null {
    const record = this.tasks.get(id);
    if (!record) {
      return null;
    }

    if (this.isTaskCancelled(id)) {
      return this.patchTask(id, { status: 'cancelled', result: undefined, error: undefined });
    }

    return this.patchTask(id, {
      status: 'completed',
      result,
      error: undefined,
      progress: progress
        ? {
            ...record.progress,
            ...progress,
          }
        : record.progress,
    });
  }

  markTaskFailed(id: string, error: string): McpTaskRecord | null {
    const record = this.tasks.get(id);
    if (!record) {
      return null;
    }

    if (this.isTaskCancelled(id)) {
      return this.patchTask(id, { status: 'cancelled', error: undefined, result: undefined });
    }

    return this.patchTask(id, {
      status: 'failed',
      error,
      result: undefined,
    });
  }

  isTaskCancelled(id: string): boolean {
    return this.cancelledTaskIds.has(id);
  }

  resetForTests(): void {
    this.tasks.clear();
    this.cancelledTaskIds.clear();
  }

  private patchTask(
    id: string,
    patch: Partial<Pick<McpTaskRecord, 'status' | 'progress' | 'error' | 'result'>>
  ): McpTaskRecord | null {
    const record = this.tasks.get(id);
    if (!record) {
      return null;
    }

    const next: McpTaskRecord = {
      ...record,
      ...patch,
      progress: patch.progress ?? record.progress,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(id, next);
    auditLogTaskLifecycle(id, next.kind, next.status, {
      progressMessage: next.progress.message,
      errorMessage: next.error,
    });
    return this.clone(next);
  }

  private clone(record: McpTaskRecord): McpTaskRecord {
    return {
      ...record,
      progress: { ...record.progress },
    };
  }
}

let defaultTaskManager: InMemoryTaskManager | null = null;

export function getDefaultTaskManager(): TaskManager {
  if (!defaultTaskManager) {
    defaultTaskManager = new InMemoryTaskManager();
  }
  return defaultTaskManager;
}

export function resetDefaultTaskManagerForTests(): void {
  if (defaultTaskManager) {
    defaultTaskManager.resetForTests();
  }
}

export function createTaskManager(): TaskManager {
  return new InMemoryTaskManager();
}

export interface IndexingTaskOptions {
  force?: boolean;
  reindex?: boolean;
}

function buildIndexingProgress(result: IndexResult): McpTaskProgress {
  const total = result.totalIndexable ?? result.indexed + result.skipped;
  return {
    current: result.indexed,
    total,
    message: `Indexed ${result.indexed} files`,
  };
}

export async function executeIndexingTask(
  taskId: string,
  serviceClient: ContextServiceClient,
  options: IndexingTaskOptions,
  taskManager: TaskManager = getDefaultTaskManager()
): Promise<McpTaskRecord | null> {
  const existing = taskManager.getTask(taskId);
  if (!existing) {
    return null;
  }

  if (taskManager.isTaskCancelled(taskId)) {
    return taskManager.getTask(taskId);
  }

  taskManager.markTaskRunning(taskId);
  taskManager.updateTaskProgress(taskId, {
    current: 0,
    message: options.reindex ? 'Clearing existing index state' : 'Starting workspace indexing',
  });

  try {
    if (options.force || options.reindex) {
      await serviceClient.clearIndex();
      if (taskManager.isTaskCancelled(taskId)) {
        return taskManager.getTask(taskId);
      }
    }

    taskManager.updateTaskProgress(taskId, {
      current: 0,
      message: 'Scanning and indexing files',
    });

    const result = await serviceClient.indexWorkspace();
    if (taskManager.isTaskCancelled(taskId)) {
      return taskManager.getTask(taskId);
    }

    return taskManager.markTaskCompleted(taskId, result, buildIndexingProgress(result));
  } catch (error) {
    if (taskManager.isTaskCancelled(taskId)) {
      return taskManager.getTask(taskId);
    }

    const message = error instanceof Error ? error.message : String(error);
    return taskManager.markTaskFailed(taskId, message);
  }
}

export function startIndexingTask(
  serviceClient: ContextServiceClient,
  options: IndexingTaskOptions,
  taskManager: TaskManager = getDefaultTaskManager()
): McpTaskRecord {
  const task = taskManager.createTask({
    kind: options.reindex ? 'reindex_workspace' : 'index_workspace',
    progress: {
      current: 0,
      message: options.reindex ? 'Queued workspace reindex' : 'Queued workspace indexing',
    },
  });

  void executeIndexingTask(task.id, serviceClient, options, taskManager).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[taskManager] Indexing task ${task.id} failed: ${message}`);
  });

  return task;
}

export function shouldUseTaskMode(args: { background?: boolean; task?: boolean }): boolean {
  return args.background === true || args.task === true;
}

export function shouldUseIndexingTaskMode(args: { background?: boolean; task?: boolean }): boolean {
  return shouldUseTaskMode(args);
}

export function buildTaskStartResponse(
  message: string,
  task: McpTaskRecord
): Record<string, unknown> {
  return {
    success: true,
    message,
    task_id: task.id,
    task_status: task.status,
    task_kind: task.kind,
    progress: task.progress,
  };
}

export type TaskProgressUpdater = (progress: Partial<McpTaskProgress>) => void;

export interface StartBackgroundTaskOptions {
  kind: string;
  queuedMessage: string;
  runningMessage?: string;
  buildCompletedProgress?: (result: unknown) => Partial<McpTaskProgress>;
}

export async function executeBackgroundTask(
  taskId: string,
  executor: (
    updateProgress: TaskProgressUpdater,
    isCancelled: () => boolean
  ) => Promise<unknown>,
  options: Pick<StartBackgroundTaskOptions, 'runningMessage' | 'buildCompletedProgress'>,
  taskManager: TaskManager = getDefaultTaskManager()
): Promise<McpTaskRecord | null> {
  const existing = taskManager.getTask(taskId);
  if (!existing) {
    return null;
  }

  if (taskManager.isTaskCancelled(taskId)) {
    return taskManager.getTask(taskId);
  }

  taskManager.markTaskRunning(taskId);
  taskManager.updateTaskProgress(taskId, {
    current: 0,
    message: options.runningMessage ?? 'Running',
  });

  try {
    const result = await executor(
      (progress) => {
        taskManager.updateTaskProgress(taskId, progress);
      },
      () => taskManager.isTaskCancelled(taskId)
    );

    if (taskManager.isTaskCancelled(taskId)) {
      return taskManager.getTask(taskId);
    }

    const completedProgress = options.buildCompletedProgress?.(result);
    return taskManager.markTaskCompleted(taskId, result, completedProgress);
  } catch (error) {
    if (taskManager.isTaskCancelled(taskId)) {
      return taskManager.getTask(taskId);
    }

    const message = error instanceof Error ? error.message : String(error);
    return taskManager.markTaskFailed(taskId, message);
  }
}

export function startBackgroundTask(
  options: StartBackgroundTaskOptions,
  executor: (
    updateProgress: TaskProgressUpdater,
    isCancelled: () => boolean
  ) => Promise<unknown>,
  taskManager: TaskManager = getDefaultTaskManager()
): McpTaskRecord {
  const task = taskManager.createTask({
    kind: options.kind,
    progress: {
      current: 0,
      message: options.queuedMessage,
    },
  });

  void executeBackgroundTask(task.id, executor, options, taskManager).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[taskManager] Background task ${task.id} failed: ${message}`);
  });

  return task;
}

function countFindings(result: unknown): number {
  if (!result || typeof result !== 'object') {
    return 0;
  }

  const record = result as Record<string, unknown>;
  if (Array.isArray(record.findings)) {
    return record.findings.length;
  }

  const output = record.output;
  if (output && typeof output === 'object') {
    const outputRecord = output as Record<string, unknown>;
    if (Array.isArray(outputRecord.findings)) {
      return outputRecord.findings.length;
    }
    const review = outputRecord.review;
    if (review && typeof review === 'object') {
      const reviewRecord = review as Record<string, unknown>;
      if (Array.isArray(reviewRecord.findings)) {
        return reviewRecord.findings.length;
      }
    }
  }

  return 0;
}

export function buildReviewCompletedProgress(result: unknown): McpTaskProgress {
  const findingsCount = countFindings(result);
  return {
    current: 1,
    total: 1,
    message: `Review completed with ${findingsCount} finding(s)`,
  };
}

export function buildStaticAnalysisCompletedProgress(result: unknown): McpTaskProgress {
  const findingsCount = countFindings(result);
  return {
    current: 1,
    total: 1,
    message: `Static analysis completed with ${findingsCount} finding(s)`,
  };
}

export function startReviewDiffTask(
  executor: (
    updateProgress: TaskProgressUpdater,
    isCancelled: () => boolean
  ) => Promise<unknown>,
  taskManager: TaskManager = getDefaultTaskManager()
): McpTaskRecord {
  return startBackgroundTask(
    {
      kind: 'review_diff',
      queuedMessage: 'Queued diff review',
      runningMessage: 'Running diff review',
      buildCompletedProgress: buildReviewCompletedProgress,
    },
    executor,
    taskManager
  );
}

export function startReviewAutoTask(
  executor: (
    updateProgress: TaskProgressUpdater,
    isCancelled: () => boolean
  ) => Promise<unknown>,
  taskManager: TaskManager = getDefaultTaskManager()
): McpTaskRecord {
  return startBackgroundTask(
    {
      kind: 'review_auto',
      queuedMessage: 'Queued review',
      runningMessage: 'Running review',
      buildCompletedProgress: buildReviewCompletedProgress,
    },
    executor,
    taskManager
  );
}

export function startStaticAnalysisTask(
  executor: (
    updateProgress: TaskProgressUpdater,
    isCancelled: () => boolean
  ) => Promise<unknown>,
  taskManager: TaskManager = getDefaultTaskManager()
): McpTaskRecord {
  return startBackgroundTask(
    {
      kind: 'run_static_analysis',
      queuedMessage: 'Queued static analysis',
      runningMessage: 'Running static analysis',
      buildCompletedProgress: buildStaticAnalysisCompletedProgress,
    },
    executor,
    taskManager
  );
}
