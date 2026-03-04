import { describe, expect, it, jest } from '@jest/globals';
import type { RetrievalProviderCallbacks } from '../../../src/retrieval/providers/types.js';
import { AugmentLegacyProvider } from '../../../src/retrieval/providers/augmentLegacyProvider.js';
import { LocalNativeProvider } from '../../../src/retrieval/providers/localNativeProvider.js';

function createCallbacks(): RetrievalProviderCallbacks {
  return {
    search: jest.fn(async () => []),
    indexWorkspace: jest.fn(async () => ({ indexed: 0, skipped: 0, errors: [], duration: 0 })),
    indexFiles: jest.fn(async () => ({ indexed: 0, skipped: 0, errors: [], duration: 0 })),
    clearIndex: jest.fn(async () => undefined),
    getIndexStatus: jest.fn(
      async () =>
        ({
          workspace: 'test',
          status: 'idle',
          lastIndexed: null,
          fileCount: 0,
          isStale: false,
        }) as any
    ),
    health: jest.fn(async () => ({ ok: true })),
  };
}

describe('retrieval provider wrappers', () => {
  it('augment legacy provider forwards calls to callbacks', async () => {
    const callbacks = createCallbacks();
    const provider = new AugmentLegacyProvider(callbacks);
    await provider.search('query', 5, { bypassCache: true });

    expect(provider.id).toBe('augment_legacy');
    expect(callbacks.search).toHaveBeenCalledWith('query', 5, { bypassCache: true });
  });

  it('local native provider forwards index lifecycle calls to callbacks', async () => {
    const callbacks = createCallbacks();
    const provider = new LocalNativeProvider(callbacks);
    await provider.indexWorkspace();
    await provider.indexFiles(['a.ts']);
    await provider.clearIndex();
    await provider.getIndexStatus();
    await provider.health();

    expect(provider.id).toBe('local_native');
    expect(callbacks.indexWorkspace).toHaveBeenCalledTimes(1);
    expect(callbacks.indexFiles).toHaveBeenCalledWith(['a.ts']);
    expect(callbacks.clearIndex).toHaveBeenCalledTimes(1);
    expect(callbacks.getIndexStatus).toHaveBeenCalledTimes(1);
    expect(callbacks.health).toHaveBeenCalledTimes(1);
  });
});
