export type FileChangeType = 'add' | 'change' | 'unlink';

export interface FileChange {
  type: FileChangeType;
  path: string;
  timestamp: number;
}

/**
 * R3b1 -- optional gate applied to each flushed batch before `onBatch` is
 * invoked. Backed by the canonical discovery manifest (see
 * `discoveryAdapter.ts`) in production wiring; omitted entirely (default
 * pass-through, no filtering) when a caller does not supply one, so
 * existing direct `FileWatcher` usage is unaffected.
 */
export interface WatcherChangeFilter {
  applyBatch(changes: readonly FileChange[]): Promise<{ eligibleChanges: FileChange[] }>;
}

export interface WatcherOptions {
  debounceMs?: number;      // Default: 500ms
  ignored?: (string | RegExp)[]; // Patterns to ignore (passed to chokidar)
  persistent?: boolean;     // Keep process alive
  maxBatchSize?: number;    // Default: 100
  changeFilter?: WatcherChangeFilter;
}

export interface WatcherHooks {
  onBatch: (changes: FileChange[]) => void | Promise<void>;
}
