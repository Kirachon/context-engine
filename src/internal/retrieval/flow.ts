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

export function assertRetrievalFlowActive(flow: RetrievalFlowContext, stage: string): void {
  if (flow.signal?.aborted) {
    throw new Error(`Retrieval flow aborted during ${stage}.`);
  }
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
