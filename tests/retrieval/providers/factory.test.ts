import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRetrievalProvider, getRetrievalProviderRegistry } from '../../../src/retrieval/providers/factory.js';
import { RetrievalProviderError } from '../../../src/retrieval/providers/types.js';
import type {
  RetrievalProviderCallbackContext,
  RetrievalProviderCallbacks,
} from '../../../src/retrieval/providers/types.js';

const ORIGINAL_ENV = { ...process.env };

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

describe('retrieval provider factory', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.CE_RETRIEVAL_PROVIDER;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('creates local_native by default', () => {
    const { callbacks } = createCallbackHarness();
    const provider = createRetrievalProvider({ callbacks });
    expect(provider.id).toBe('local_native');
  });

  it('creates local_native when configured via env', () => {
    process.env.CE_RETRIEVAL_PROVIDER = 'local_native';
    const { callbacks } = createCallbackHarness();
    const provider = createRetrievalProvider({ callbacks });
    expect(provider.id).toBe('local_native');
  });

  it('fails fast with typed error when env explicitly selects a removed provider id', () => {
    process.env.CE_RETRIEVAL_PROVIDER = 'augment_legacy';
    const { callbacks } = createCallbackHarness();

    try {
      createRetrievalProvider({ callbacks });
      throw new Error('expected createRetrievalProvider to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RetrievalProviderError);
      const typed = error as RetrievalProviderError;
      expect(typed.code).toBe('provider_config_invalid');
      expect(typed.provider).toBeUndefined();
      expect(typed.envVar).toBe('CE_RETRIEVAL_PROVIDER');
    }
  });

  it('exposes only local_native in registry', () => {
    const registry = getRetrievalProviderRegistry();
    expect(Object.keys(registry).sort()).toEqual(['local_native']);
  });

  it('routes through local-native callback methods and preserves callback context', async () => {
    const { callbacks, spies } = createCallbackHarness();
    process.env.CE_RETRIEVAL_PROVIDER = 'local_native';
    const provider = createRetrievalProvider({ callbacks });

    await provider.search('query', 2, { bypassCache: true });
    await provider.indexWorkspace();
    await provider.indexFiles(['a.ts']);
    await provider.clearIndex();
    await provider.getIndexStatus();
    await provider.health();

    expect(spies.localNative.search).toHaveBeenCalledWith(
      'query',
      2,
      { bypassCache: true },
      { providerId: 'local_native', operation: 'search' }
    );
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
