import * as fs from 'fs';

export interface LocalNativeIndexLifecycleFinalizeOptions {
  indexedAtIso: string;
  fileCount: number;
  status: 'idle' | 'error';
  lastError?: string;
  writeStateMarker: (indexedAtIso: string) => void;
  writeFingerprint: () => void;
  updateIndexStatus: (partial: {
    status: 'idle' | 'error';
    lastIndexed?: string;
    fileCount: number;
    lastError?: string;
  }) => void;
  clearCache: () => void;
  refreshGraphStore: (
    options?: { indexedFiles?: Record<string, { hash: string; indexed_at?: string }> }
  ) => Promise<void>;
  graphIndexedFiles?: Record<string, { hash: string; indexed_at?: string }>;
  shouldRefreshGraph?: boolean;
}

export async function finalizeLocalNativeIndexLifecycle(
  options: LocalNativeIndexLifecycleFinalizeOptions
): Promise<void> {
  options.writeStateMarker(options.indexedAtIso);
  options.writeFingerprint();
  options.updateIndexStatus({
    status: options.status,
    lastIndexed: options.status === 'idle' ? options.indexedAtIso : undefined,
    fileCount: options.fileCount,
    lastError: options.lastError,
  });
  options.clearCache();
  if (options.shouldRefreshGraph !== false) {
    await options.refreshGraphStore({ indexedFiles: options.graphIndexedFiles });
  }
}

export interface ClearLocalNativeIndexLifecycleOptions {
  fingerprintPath: string;
  stateStorePaths: string[];
  stateFilePaths: string[];
  clearCache: () => void;
  resetIgnorePatterns: () => void;
  clearGraphArtifacts: () => Promise<void>;
  updateIndexStatus: (partial: {
    status: 'idle';
    lastIndexed: null;
    fileCount: number;
    lastError: undefined;
  }) => void;
  logInfo?: (message: string) => void;
  logError?: (message: string, error: unknown) => void;
}

function deletePathIfPresent(
  targetPath: string,
  successMessage: string,
  failureMessage: string,
  options: Pick<ClearLocalNativeIndexLifecycleOptions, 'logInfo' | 'logError'>
): void {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  try {
    fs.unlinkSync(targetPath);
    options.logInfo?.(successMessage);
  } catch (error) {
    options.logError?.(failureMessage, error);
  }
}

export async function clearLocalNativeIndexLifecycle(
  options: ClearLocalNativeIndexLifecycleOptions
): Promise<void> {
  deletePathIfPresent(
    options.fingerprintPath,
    `Deleted index fingerprint file: ${options.fingerprintPath}`,
    'Failed to delete index fingerprint file:',
    options
  );

  for (const stateStorePath of options.stateStorePaths) {
    deletePathIfPresent(
      stateStorePath,
      `Deleted index state store file: ${stateStorePath}`,
      'Failed to delete index state store file:',
      options
    );
  }

  for (const stateFilePath of options.stateFilePaths) {
    deletePathIfPresent(
      stateFilePath,
      `Deleted retrieval state marker file: ${stateFilePath}`,
      'Failed to delete retrieval state marker file:',
      options
    );
  }

  options.clearCache();
  options.resetIgnorePatterns();
  await options.clearGraphArtifacts();
  options.updateIndexStatus({
    status: 'idle',
    lastIndexed: null,
    fileCount: 0,
    lastError: undefined,
  });
}
