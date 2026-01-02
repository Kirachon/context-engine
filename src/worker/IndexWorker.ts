import { parentPort, workerData } from 'worker_threads';
import type { WorkerPayload, WorkerMessage } from './messages.js';
import { ContextServiceClient } from '../mcp/serviceClient.js';

export async function runIndexJob(
  payload: WorkerPayload,
  send: (message: WorkerMessage) => void
): Promise<void> {
  if (payload.mock) {
    send({ type: 'index_complete', duration: 0, count: 0 });
    return;
  }

  // Prevent nested worker spawning from within the worker.
  // The worker is already off the main event loop, so keep indexing in-process here.
  process.env.CE_INDEX_USE_WORKER = 'false';

  send({
    type: 'index_start',
    files: payload.files ?? [],
  });

  try {
    const client = new ContextServiceClient(payload.workspacePath);
    const result = payload.files?.length
      ? await client.indexFiles(payload.files)
      : await client.indexWorkspace();

   send({
     type: 'index_complete',
     duration: result.duration,
     count: result.indexed,
     skipped: result.skipped,
     errors: result.errors,
     totalIndexable: result.totalIndexable,
     unchangedSkipped: result.unchangedSkipped,
   });
 } catch (error) {
   send({
     type: 'index_error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const port = parentPort;
if (port && workerData) {
  void runIndexJob(workerData as WorkerPayload, (message) => port.postMessage(message));
}
