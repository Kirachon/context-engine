import { describe, expect, it, jest } from '@jest/globals';
import type { RetrievalProviderCallbacks } from '../../../src/retrieval/providers/types.js';
import { AugmentLegacyProvider } from '../../../src/retrieval/providers/augmentLegacyProvider.js';
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
        _context?: { providerId: 'augment_legacy' | 'local_native'; operation: string }
      ) => []
    ),
    indexWorkspace: jest.fn(
      async (_context?: { providerId: 'augment_legacy' | 'local_native'; operation: string }) =>
        defaultIndexResult
    ),
    indexFiles: jest.fn(
      async (
        _filePaths: string[],
        _context?: { providerId: 'augment_legacy' | 'local_native'; operation: string }
      ) => defaultIndexResult
    ),
    clearIndex: jest.fn(
      async (_context?: { providerId: 'augment_legacy' | 'local_native'; operation: string }) => undefined
    ),
    getIndexStatus: jest.fn(
      async (_context?: { providerId: 'augment_legacy' | 'local_native'; operation: string }) =>
        defaultIndexStatus
    ),
    health: jest.fn(
      async (_context?: { providerId: 'augment_legacy' | 'local_native'; operation: string }) => ({ ok: true })
    ),
  });

  const spies = {
    augmentLegacy: createScopedSpies(),
    localNative: createScopedSpies(),
  };

  const callbacks: RetrievalProviderCallbacks = {
    augmentLegacy: spies.augmentLegacy,
    localNative: spies.localNative,
  };

  return { callbacks, spies };
}

describe('retrieval provider wrappers', () => {
  it('augment legacy provider routes through augment-specific callback methods', async () => {
    const { callbacks, spies } = createCallbackHarness();
    const provider = new AugmentLegacyProvider(callbacks);
    await provider.search('query', 5, { bypassCache: true });

    expect(provider.id).toBe('augment_legacy');
    expect(spies.augmentLegacy.search).toHaveBeenCalledWith(
      'query',
      5,
      { bypassCache: true },
      { providerId: 'augment_legacy', operation: 'search' }
    );
    expect(spies.localNative.search).not.toHaveBeenCalled();
  });

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

    expect(spies.augmentLegacy.indexWorkspace).not.toHaveBeenCalled();
    expect(spies.augmentLegacy.indexFiles).not.toHaveBeenCalled();
    expect(spies.augmentLegacy.clearIndex).not.toHaveBeenCalled();
    expect(spies.augmentLegacy.getIndexStatus).not.toHaveBeenCalled();
    expect(spies.augmentLegacy.health).not.toHaveBeenCalled();
  });
});
