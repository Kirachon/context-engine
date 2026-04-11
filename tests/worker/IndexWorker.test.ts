import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { WorkerMessage } from '../../src/worker/messages.js';

type IndexResult = {
  duration: number;
  indexed: number;
  skipped?: number;
  errors?: string[];
  totalIndexable?: number;
  unchangedSkipped?: number;
};

const ORIGINAL_ENV = { ...process.env };
const mockIndexWorkspace = jest.fn<() => Promise<IndexResult>>();
const mockIndexFiles = jest.fn<(files: string[]) => Promise<IndexResult>>();
const mockContextServiceClient = jest.fn((_workspacePath: string) => ({
  indexWorkspace: mockIndexWorkspace,
  indexFiles: mockIndexFiles,
}));

async function loadWorkerModule() {
  jest.resetModules();
  mockIndexWorkspace.mockReset();
  mockIndexFiles.mockReset();
  mockContextServiceClient.mockClear();

  jest.unstable_mockModule('../../src/mcp/serviceClient.js', () => ({
    ContextServiceClient: mockContextServiceClient,
  }));

  return import('../../src/worker/IndexWorker.js');
}

describe('IndexWorker', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('emits completion message in mock mode', async () => {
    const { runIndexJob } = await loadWorkerModule();
    const messages: WorkerMessage[] = [];

    await runIndexJob(
      { workspacePath: process.cwd(), mock: true },
      (msg) => messages.push(msg)
    );

    expect(messages).toEqual([{ type: 'index_complete', duration: 0, count: 0 }]);
    expect(mockContextServiceClient).not.toHaveBeenCalled();
  });

  it('emits start and complete messages for successful indexing and disables nested workers', async () => {
    const { runIndexJob } = await loadWorkerModule();
    const messages: WorkerMessage[] = [];
    process.env.CE_INDEX_USE_WORKER = 'true';

    mockIndexFiles.mockResolvedValue({
      duration: 12,
      indexed: 3,
      skipped: 1,
      errors: ['warn'],
      totalIndexable: 5,
      unchangedSkipped: 2,
    });

    await runIndexJob(
      {
        workspacePath: 'D:\\GitProjects\\context-engine',
        files: ['src\\worker\\IndexWorker.ts'],
      },
      (msg) => messages.push(msg)
    );

    expect(process.env.CE_INDEX_USE_WORKER).toBe('false');
    expect(mockContextServiceClient).toHaveBeenCalledWith('D:\\GitProjects\\context-engine');
    expect(mockIndexFiles).toHaveBeenCalledWith(['src\\worker\\IndexWorker.ts']);
    expect(messages).toEqual([
      { type: 'index_start', files: ['src\\worker\\IndexWorker.ts'] },
      {
        type: 'index_complete',
        duration: 12,
        count: 3,
        skipped: 1,
        errors: ['warn'],
        totalIndexable: 5,
        unchangedSkipped: 2,
      },
    ]);
  });

  it('emits explicit job error messages when indexing fails', async () => {
    const { runIndexJob } = await loadWorkerModule();
    const messages: WorkerMessage[] = [];

    mockIndexWorkspace.mockRejectedValue(new Error('index failed'));

    await runIndexJob(
      { workspacePath: 'D:\\GitProjects\\context-engine' },
      (msg) => messages.push(msg)
    );

    expect(messages).toEqual([
      { type: 'index_start', files: [] },
      {
        type: 'index_error',
        error: 'index failed',
        failureKind: 'job_error',
      },
    ]);
  });

  it('reports abnormal exits once with explicit metadata', async () => {
    const { createWorkerExecutionGuard } = await loadWorkerModule();
    const messages: WorkerMessage[] = [];
    const guard = createWorkerExecutionGuard((message) => messages.push(message));

    expect(guard.reportExit(5)).toBe(true);
    expect(guard.reportExit(6)).toBe(false);
    expect(guard.complete({ type: 'index_complete', duration: 0, count: 0 })).toBe(false);

    expect(messages).toEqual([
      {
        type: 'index_error',
        error: 'Index worker exited with code 5',
        failureKind: 'abnormal_exit',
        exitCode: 5,
      },
    ]);
  });

  it('marks runtime failures explicitly before later exit noise', async () => {
    const { createWorkerExecutionGuard } = await loadWorkerModule();
    const messages: WorkerMessage[] = [];
    const guard = createWorkerExecutionGuard((message) => messages.push(message));

    expect(guard.fail(new Error('runtime failure'), 'runtime_error')).toBe(true);
    expect(guard.reportExit(1)).toBe(false);

    expect(messages).toEqual([
      {
        type: 'index_error',
        error: 'runtime failure',
        failureKind: 'runtime_error',
      },
    ]);
  });
});
