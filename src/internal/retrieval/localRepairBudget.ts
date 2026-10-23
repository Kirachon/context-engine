/** Deliberate resource rejection must not be mistaken for no matching files. */
export class LocalRetrievalBudgetError extends Error {
  constructor(kind: 'request' | 'analysis') {
    super(`Local retrieval ${kind} memory budget exceeded; narrow include_paths and retry.`);
    this.name = 'LocalRetrievalBudgetError';
  }
}

export function isLocalRetrievalBudgetError(error: unknown): error is LocalRetrievalBudgetError {
  return error instanceof LocalRetrievalBudgetError;
}
