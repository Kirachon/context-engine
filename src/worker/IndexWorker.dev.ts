import { parentPort, workerData } from 'worker_threads';
import type { WorkerFailureKind, WorkerPayload, WorkerMessage } from './messages.js';
import { ContextServiceClient } from '../mcp/serviceClient.js';

const WORKER_EXIT_ERROR_PREFIX = 'Index worker exited with code';
const WORKER_TERMINAL_STATUS_ERROR =
  'Index worker completed without emitting a terminal status';

type TerminalWorkerMessage = Extract<WorkerMessage, { type: 'index_complete' | 'index_error' }>;
type IndexErrorMessage = Extract<WorkerMessage, { type: 'index_error' }>;

function isTerminalMessage(message: WorkerMessage): message is TerminalWorkerMessage {
  return message.type === 'index_complete' || message.type === 'index_error';
}

export function normalizeWorkerError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createIndexErrorMessage(
  error: unknown,
  failureKind: WorkerFailureKind = 'job_error',
  exitCode?: number
): IndexErrorMessage {
  const message: IndexErrorMessage = {
    type: 'index_error',
    error: normalizeWorkerError(error),
    failureKind,
  };

  if (typeof exitCode === 'number') {
    message.exitCode = exitCode;
  }

  return message;
}

export function createWorkerExecutionGuard(send: (message: WorkerMessage) => void) {
  let terminalMessage: TerminalWorkerMessage | null = null;

  const emit = (message: WorkerMessage): boolean => {
    if (terminalMessage && isTerminalMessage(message)) {
      return false;
    }

    send(message);

    if (isTerminalMessage(message)) {
      terminalMessage = message;
    }

    return true;
  };

  return {
    send: emit,
    complete: (message: Extract<WorkerMessage, { type: 'index_complete' }>): boolean => emit(message),
    fail: (
      error: unknown,
      failureKind: WorkerFailureKind = 'job_error',
      exitCode?: number
    ): boolean => emit(createIndexErrorMessage(error, failureKind, exitCode)),
    reportExit: (code: number): boolean => {
      if (code === 0 || terminalMessage) {
        return false;
      }

      return emit(
        createIndexErrorMessage(
          `${WORKER_EXIT_ERROR_PREFIX} ${code}`,
          'abnormal_exit',
          code
        )
      );
    },
    hasTerminalMessage: (): boolean => terminalMessage !== null,
  };
}

export async function runIndexJob(
  payload: WorkerPayload,
  send: (message: WorkerMessage) => void
): Promise<void> {
  const guard = createWorkerExecutionGuard(send);

  if (payload.mock) {
    guard.complete({ type: 'index_complete', duration: 0, count: 0 });
    return;
  }

  // Prevent nested worker spawning from within the worker.
  // The worker is already off the main event loop, so keep indexing in-process here.
  process.env.CE_INDEX_USE_WORKER = 'false';

  try {
    guard.send({
      type: 'index_start',
      files: payload.files ?? [],
    });

    const client = new ContextServiceClient(payload.workspacePath);
    const result = payload.files?.length
      ? await client.indexFiles(payload.files)
      : await client.indexWorkspace();

    guard.complete({
      type: 'index_complete',
      duration: result.duration,
      count: result.indexed,
      skipped: result.skipped,
      errors: result.errors,
      totalIndexable: result.totalIndexable,
      unchangedSkipped: result.unchangedSkipped,
    });
  } catch (error) {
    guard.fail(error, 'job_error');
  }
}

function attachWorkerProcessGuards(
  guard: ReturnType<typeof createWorkerExecutionGuard>
): () => void {
  const handleUncaughtException = (error: Error): void => {
    guard.fail(error, 'runtime_error');
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
  };

  const handleUnhandledRejection = (reason: unknown): void => {
    guard.fail(reason, 'runtime_error');
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
  };

  const handleExit = (code: number): void => {
    guard.reportExit(code);
  };

  process.once('uncaughtException', handleUncaughtException);
  process.once('unhandledRejection', handleUnhandledRejection);
  process.once('exit', handleExit);

  return () => {
    process.off('uncaughtException', handleUncaughtException);
    process.off('unhandledRejection', handleUnhandledRejection);
    process.off('exit', handleExit);
  };
}

export async function runWorkerThreadMain(
  payload: WorkerPayload,
  send: (message: WorkerMessage) => void
): Promise<void> {
  const guard = createWorkerExecutionGuard(send);
  const cleanup = attachWorkerProcessGuards(guard);

  try {
    await runIndexJob(payload, guard.send);

    if (!guard.hasTerminalMessage()) {
      guard.fail(WORKER_TERMINAL_STATUS_ERROR, 'runtime_error');
    }
  } catch (error) {
    guard.fail(error, 'runtime_error');
  } finally {
    cleanup();
  }
}

const port = parentPort;
if (port && workerData) {
  void runWorkerThreadMain(workerData as WorkerPayload, (message) => port.postMessage(message));
}
