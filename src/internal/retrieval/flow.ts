export interface RetrievalFlowContext {
  query: string;
  startedAtMs: number;
  metadata: Record<string, unknown>;
  stages: string[];
  signal?: AbortSignal;
}

export interface RetrievalFlowSummary {
  query: string;
  startedAtMs: number;
  finishedAtMs: number;
  elapsedMs: number;
  stages: string[];
  cancelled: boolean;
  metadata: Record<string, unknown>;
}

export function createRetrievalFlowContext(
  query: string,
  options?: { signal?: AbortSignal; metadata?: Record<string, unknown> }
): RetrievalFlowContext {
  return {
    query,
    startedAtMs: Date.now(),
    metadata: { ...(options?.metadata ?? {}) },
    stages: [],
    signal: options?.signal,
  };
}

export function noteRetrievalStage(flow: RetrievalFlowContext, stage: string): void {
  flow.stages.push(stage);
}

/**
 * R1b -- Single error type thrown at every retrieval abort checkpoint
 * (queue/permit acquisition, provider fanout calls, rerank calls, and the
 * flow-stage assertions below). Callers that forward the *same* AbortSignal
 * down into `executeToolCall` rely on this rejecting promptly rather than
 * being swallowed into an empty/degraded result -- `isAborted(signal)` in
 * `src/mcp/executeTool.ts` reclassifies it (and any other error racing an
 * aborted signal) as the shared 'cancelled' outcome, never as 'error'.
 */
export class RetrievalAbortedError extends Error {
  readonly stage: string;

  constructor(stage: string) {
    super(`Retrieval flow aborted during ${stage}.`);
    this.name = 'RetrievalAbortedError';
    this.stage = stage;
  }
}

export function isRetrievalFlowAborted(flow: RetrievalFlowContext): boolean {
  return flow.signal?.aborted === true;
}

export function assertRetrievalFlowActive(flow: RetrievalFlowContext, stage: string): void {
  if (isRetrievalFlowAborted(flow)) {
    throw new RetrievalAbortedError(stage);
  }
}

/**
 * Makes `promise`'s *settlement from this call's perspective* abort-aware:
 * once `signal` fires, the returned promise rejects immediately with a
 * {@link RetrievalAbortedError} even if `promise` itself has no idea a
 * signal exists and keeps running in the background. This is what lets
 * queue/provider/reranker calls that don't natively support cancellation
 * still honor the <500ms caller-visible acknowledgement budget -- the
 * *awaiter* stops waiting promptly; the still-running background operation
 * is expected to be inert from the caller's point of view because its
 * result is never awaited or published past this point.
 */
export function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  stage: string
): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(new RetrievalAbortedError(stage));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new RetrievalAbortedError(stage));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

export function finalizeRetrievalFlow(
  flow: RetrievalFlowContext,
  metadata?: Record<string, unknown>
): RetrievalFlowSummary {
  const finishedAtMs = Date.now();
  return {
    query: flow.query,
    startedAtMs: flow.startedAtMs,
    finishedAtMs,
    elapsedMs: Math.max(0, finishedAtMs - flow.startedAtMs),
    stages: [...flow.stages],
    cancelled: flow.signal?.aborted === true,
    metadata: {
      ...flow.metadata,
      ...(metadata ?? {}),
    },
  };
}
