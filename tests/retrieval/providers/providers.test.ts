import { describe, expect, it, jest } from '@jest/globals';
import type {
  RetrievalProviderCallbackContext,
  RetrievalProviderCallbacks,
} from '../../../src/retrieval/providers/types.js';
import { LocalNativeProvider } from '../../../src/retrieval/providers/localNativeProvider.js';

function createCallbackHarness() {
  const defaultIndexResult = { indexed: 0, skipped: 0, errors: [], duration: 0 };
  const defaultIndexStatus = {
    workspace: 'test',
    status: 'idle',
    lastIndexed: null,
    fileCount: 0,
    isStale: false,
  } as any;

  const createScopedSpies = () => ({
    search: jest.fn(
      async (
        _query: string,
        _topK: number,
        _options?: { bypassCache?: boolean; maxOutputLength?: number },
        _context?: RetrievalProviderCallbackContext
      ) => []
    ),
    indexWorkspace: jest.fn(
      async (_context?: RetrievalProviderCallbackContext) =>
        defaultIndexResult
    ),
    indexFiles: jest.fn(
      async (
        _filePaths: string[],
        _context?: RetrievalProviderCallbackContext
      ) => defaultIndexResult
    ),
    clearIndex: jest.fn(
      async (_context?: RetrievalProviderCallbackContext) => undefined
    ),
    getIndexStatus: jest.fn(
      async (_context?: RetrievalProviderCallbackContext) =>
        defaultIndexStatus
    ),
    health: jest.fn(
      async (_context?: RetrievalProviderCallbackContext) => ({ ok: true })
    ),
  });

  const spies = {
    localNative: createScopedSpies(),
  };

  const callbacks: RetrievalProviderCallbacks = {
    localNative: spies.localNative,
  };

  return { callbacks, spies };
}

describe('retrieval provider wrappers', () => {
  it('local native provider routes index lifecycle through local-native callbacks', async () => {
    const { callbacks, spies } = createCallbackHarness();
    const provider = new LocalNativeProvider(callbacks);
    await provider.indexWorkspace();
    await provider.indexFiles(['a.ts']);
    await provider.clearIndex();
    await provider.getIndexStatus();
    await provider.health();

    expect(provider.id).toBe('local_native');
    expect(spies.localNative.indexWorkspace).toHaveBeenCalledWith({
      providerId: 'local_native',
      operation: 'indexWorkspace',
    });
    expect(spies.localNative.indexFiles).toHaveBeenCalledWith(['a.ts'], {
      providerId: 'local_native',
      operation: 'indexFiles',
    });
    expect(spies.localNative.clearIndex).toHaveBeenCalledWith({
      providerId: 'local_native',
      operation: 'clearIndex',
    });
    expect(spies.localNative.getIndexStatus).toHaveBeenCalledWith({
      providerId: 'local_native',
      operation: 'getIndexStatus',
    });
    expect(spies.localNative.health).toHaveBeenCalledWith({
      providerId: 'local_native',
      operation: 'health',
    });
  });
});
