import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { handleReviewDiff } from '../../src/mcp/tools/reviewDiff.js';
import { handleReviewAuto } from '../../src/mcp/tools/reviewAuto.js';
import { handleRunStaticAnalysis } from '../../src/mcp/tools/staticAnalysis.js';
import {
  createTaskManager,
  executeBackgroundTask,
  getDefaultTaskManager,
  resetDefaultTaskManagerForTests,
  shouldUseTaskMode,
  startReviewDiffTask,
  startStaticAnalysisTask,
} from '../../src/mcp/tasks/taskManager.js';

const SAMPLE_DIFF = `diff --git a/src/example.ts b/src/example.ts
index 1234567..abcdefg 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,2 +1,2 @@
-export const value = 1;
+export const value = 2;
`;

describe('review/static-analysis task mode helpers', () => {
  afterEach(() => {
    resetDefaultTaskManagerForTests();
  });

  it('detects task mode flags', () => {
    expect(shouldUseTaskMode({})).toBe(false);
    expect(shouldUseTaskMode({ background: true })).toBe(true);
    expect(shouldUseTaskMode({ task: true })).toBe(true);
  });

  it('marks background review tasks failed when executor throws', async () => {
    const manager = createTaskManager();
    const task = startReviewDiffTask(
      async () => {
        throw new Error('review failed');
      },
      manager
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    const finalTask = manager.getTask(task.id);
    expect(finalTask?.status).toBe('failed');
    expect(finalTask?.error).toBe('review failed');
  });

  it('preserves cancelled status when a running background task finishes', async () => {
    const manager = createTaskManager();
    const task = manager.createTask({ kind: 'review_diff' });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    void executeBackgroundTask(
      task.id,
      async () => {
        await gate;
        return { findings: [] };
      },
      {
        runningMessage: 'Running diff review',
        buildCompletedProgress: () => ({
          current: 1,
          total: 1,
          message: 'Review completed with 0 finding(s)',
        }),
      },
      manager
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    manager.cancelTask(task.id);
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.getTask(task.id)?.status).toBe('cancelled');
    expect(manager.getTask(task.id)?.result).toBeUndefined();
  });
});

describe('review_diff task integration', () => {
  const mockServiceClient = {
    getWorkspacePath: () => process.cwd(),
    getFile: jest.fn(),
  };

  beforeEach(() => {
    resetDefaultTaskManagerForTests();
    jest.clearAllMocks();
  });

  it('keeps synchronous review_diff behavior by default', async () => {
    const resultStr = await handleReviewDiff({ diff: SAMPLE_DIFF }, mockServiceClient as any);
    const payload = JSON.parse(resultStr);

    expect(payload).toHaveProperty('run_id');
    expect(payload).toHaveProperty('findings');
    expect(payload.task_id).toBeUndefined();
  });

  it('returns task metadata for background review_diff calls', async () => {
    const resultStr = await handleReviewDiff(
      { diff: SAMPLE_DIFF, background: true },
      mockServiceClient as any
    );
    const payload = JSON.parse(resultStr);

    expect(payload.success).toBe(true);
    expect(payload.message).toContain('Background diff review started');
    expect(payload.task_id).toMatch(/^task_review_diff_/);
    expect(payload.task_status).toBe('queued');
    expect(payload.task_kind).toBe('review_diff');
    expect(payload.progress.message).toContain('Queued diff review');

    await new Promise((resolve) => setTimeout(resolve, 0));
    const task = getDefaultTaskManager().getTask(payload.task_id);
    expect(task?.status).toBe('completed');
    expect(task?.result).toHaveProperty('findings');
    expect(task?.progress.message).toContain('Review completed');
  });

  it('throws synchronously for invalid diff even in task mode', async () => {
    await expect(
      handleReviewDiff({ diff: '', task: true }, mockServiceClient as any)
    ).rejects.toThrow('Missing or invalid "diff" argument');
  });
});

describe('review_auto task integration', () => {
  const mockServiceClient = {
    getWorkspacePath: () => process.cwd(),
    getFile: jest.fn(),
  };

  beforeEach(() => {
    resetDefaultTaskManagerForTests();
    jest.clearAllMocks();
  });

  it('keeps synchronous review_auto behavior by default', async () => {
    const resultStr = await handleReviewAuto({ diff: SAMPLE_DIFF }, mockServiceClient as any);
    const payload = JSON.parse(resultStr);

    expect(payload.selected_tool).toBe('review_diff');
    expect(payload.output).toHaveProperty('findings');
    expect(payload.task_id).toBeUndefined();
  });

  it('returns task metadata for task-mode review_auto calls', async () => {
    const resultStr = await handleReviewAuto(
      { diff: SAMPLE_DIFF, task: true },
      mockServiceClient as any
    );
    const payload = JSON.parse(resultStr);

    expect(payload.success).toBe(true);
    expect(payload.message).toContain('Background review started');
    expect(payload.task_id).toMatch(/^task_review_auto_/);
    expect(payload.task_kind).toBe('review_auto');

    await new Promise((resolve) => setTimeout(resolve, 0));
    const task = getDefaultTaskManager().getTask(payload.task_id);
    expect(task?.status).toBe('completed');
    expect(task?.result).toHaveProperty('selected_tool', 'review_diff');
  });
});

describe('run_static_analysis task integration', () => {
  const mockServiceClient = {
    getWorkspacePath: () => process.cwd(),
  };

  beforeEach(() => {
    resetDefaultTaskManagerForTests();
  });

  it('keeps synchronous run_static_analysis behavior by default', async () => {
    const resultStr = await handleRunStaticAnalysis(
      { changed_files: [], options: { analyzers: [] } },
      mockServiceClient as any
    );
    const payload = JSON.parse(resultStr);

    expect(payload.success).toBe(true);
    expect(payload.task_id).toBeUndefined();
  });

  it('returns task metadata for background run_static_analysis calls', async () => {
    const resultStr = await handleRunStaticAnalysis(
      {
        changed_files: [],
        task: true,
        options: { analyzers: [] },
      },
      mockServiceClient as any
    );
    const payload = JSON.parse(resultStr);

    expect(payload.success).toBe(true);
    expect(payload.message).toContain('Background static analysis started');
    expect(payload.task_id).toMatch(/^task_run_static_analysis_/);
    expect(payload.task_kind).toBe('run_static_analysis');
    expect(payload.progress.message).toContain('Queued static analysis');

    await new Promise((resolve) => setTimeout(resolve, 0));
    const task = getDefaultTaskManager().getTask(payload.task_id);
    expect(task?.status).toBe('completed');
    expect(task?.result).toHaveProperty('findings');
    expect(task?.progress.message).toContain('Static analysis completed');
  });

  it('starts static analysis tasks without blocking', async () => {
    const manager = createTaskManager();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const task = startStaticAnalysisTask(
      async () => {
        await gate;
        return { findings: [{ id: 'finding-1' }] };
      },
      manager
    );

    expect(task.status).toBe('queued');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.getTask(task.id)?.status).toBe('running');

    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.getTask(task.id)?.status).toBe('completed');
  });
});
