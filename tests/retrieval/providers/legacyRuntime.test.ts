import { describe, expect, it, jest } from '@jest/globals';
import {
  createLegacyContextFactoryFromDirectContext,
  ensureLegacyRuntimeContext,
  LegacyRuntimeAdapter,
  LegacyRuntimeManager,
  loadLegacyContextFactory,
  type LegacyContextFactory,
  type LegacyContextInstance,
} from '../../../src/retrieval/providers/legacyRuntime.js';

function createContextMock(): jest.Mocked<LegacyContextInstance> {
  return {
    addToIndex: jest.fn(async () => ({ newlyUploaded: [], alreadyUploaded: [] })),
    search: jest.fn(async () => '[]'),
    exportToFile: jest.fn(async () => undefined),
  };
}

function createFactoryMock(context: LegacyContextInstance): jest.Mocked<LegacyContextFactory> {
  return {
    create: jest.fn(async () => context),
    importFromFile: jest.fn(async () => context),
  };
}

describe('legacy context factory helpers', () => {
  it('createLegacyContextFactoryFromDirectContext delegates create/import to DirectContext', async () => {
    const context = createContextMock();
    const directContext = createFactoryMock(context);

    const factory = createLegacyContextFactoryFromDirectContext(directContext);
    const created = await factory.create();
    const restored = await factory.importFromFile('state.json');

    expect(created).toBe(context);
    expect(restored).toBe(context);
    expect(directContext.create).toHaveBeenCalledTimes(1);
    expect(directContext.importFromFile).toHaveBeenCalledWith('state.json');
  });

  it('loadLegacyContextFactory loads module and returns delegating factory', async () => {
    const context = createContextMock();
    const directContext = createFactoryMock(context);
    const moduleLoader = jest.fn(async () => ({ DirectContext: directContext }));

    const factory = await loadLegacyContextFactory(moduleLoader);
    const created = await factory.create();
    const restored = await factory.importFromFile('cached-state.json');

    expect(moduleLoader).toHaveBeenCalledTimes(1);
    expect(created).toBe(context);
    expect(restored).toBe(context);
    expect(directContext.create).toHaveBeenCalledTimes(1);
    expect(directContext.importFromFile).toHaveBeenCalledWith('cached-state.json');
  });
});

describe('LegacyRuntimeAdapter', () => {
  it('restores context from state file when import succeeds', async () => {
    const context = createContextMock();
    const factory = createFactoryMock(context);

    const adapter = new LegacyRuntimeAdapter({
      loadFactory: async () => factory,
      fileExists: jest.fn(() => true),
      deleteFile: jest.fn(),
    });

    const result = await adapter.restoreOrCreate('state.json');

    expect(result).toEqual({ context, restoredFromState: true });
    expect(factory.importFromFile).toHaveBeenCalledWith('state.json');
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('creates context and deletes state file when restore fails', async () => {
    const context = createContextMock();
    const factory = createFactoryMock(context);
    factory.importFromFile.mockRejectedValueOnce(new Error('corrupt'));
    const deleteFile = jest.fn();

    const adapter = new LegacyRuntimeAdapter({
      loadFactory: async () => factory,
      fileExists: jest.fn(() => true),
      deleteFile,
    });

    const result = await adapter.restoreOrCreate('state.json');

    expect(result).toEqual({ context, restoredFromState: false });
    expect(factory.importFromFile).toHaveBeenCalledWith('state.json');
    expect(deleteFile).toHaveBeenCalledWith('state.json');
    expect(factory.create).toHaveBeenCalledTimes(1);
  });

  it('creates a new context when state file does not exist', async () => {
    const context = createContextMock();
    const factory = createFactoryMock(context);

    const adapter = new LegacyRuntimeAdapter({
      loadFactory: async () => factory,
      fileExists: jest.fn(() => false),
      deleteFile: jest.fn(),
    });

    const result = await adapter.restoreOrCreate('state.json');

    expect(result).toEqual({ context, restoredFromState: false });
    expect(factory.importFromFile).not.toHaveBeenCalled();
    expect(factory.create).toHaveBeenCalledTimes(1);
  });

  it('caches factory load and supports direct create/search/index/save calls', async () => {
    const context = createContextMock();
    const factory = createFactoryMock(context);
    const loadFactory = jest.fn(async () => factory);
    const adapter = new LegacyRuntimeAdapter({ loadFactory });

    const created = await adapter.createContext();
    const addResult = await adapter.addToIndex(created, [{ path: 'a.ts', contents: 'x' }], {
      waitForIndexing: true,
    });
    const searchResult = await adapter.search(created, 'query', { maxOutputLength: 55 });
    await adapter.saveState(created, 'state.json');

    expect(created).toBe(context);
    expect(addResult).toEqual({ newlyUploaded: [], alreadyUploaded: [] });
    expect(searchResult).toBe('[]');
    expect(context.addToIndex).toHaveBeenCalledWith([{ path: 'a.ts', contents: 'x' }], {
      waitForIndexing: true,
    });
    expect(context.search).toHaveBeenCalledWith('query', { maxOutputLength: 55 });
    expect(context.exportToFile).toHaveBeenCalledWith('state.json');
    expect(loadFactory).toHaveBeenCalledTimes(1);
  });

  it('deletes only state files that currently exist', () => {
    const existing = new Set(['one.json', 'three.json']);
    const deleteFile = jest.fn();
    const adapter = new LegacyRuntimeAdapter({
      loadFactory: async () => createFactoryMock(createContextMock()),
      fileExists: (filePath) => existing.has(filePath),
      deleteFile,
    });

    adapter.clearStateFiles(['one.json', 'two.json', 'three.json']);

    expect(deleteFile).toHaveBeenCalledTimes(2);
    expect(deleteFile).toHaveBeenCalledWith('one.json');
    expect(deleteFile).toHaveBeenCalledWith('three.json');
  });
});

describe('LegacyRuntimeManager', () => {
  it('initializes by restoring state when available', async () => {
    const context = createContextMock();
    const factory = createFactoryMock(context);

    const manager = new LegacyRuntimeManager({
      stateFilePath: 'state.json',
      loadFactory: async () => factory,
      fileExists: jest.fn(() => true),
      deleteFile: jest.fn(),
    });

    const initialized = await manager.initialize();

    expect(initialized).toBe(context);
    expect(manager.isInitialized()).toBe(true);
    expect(manager.wasRestoredFromState()).toBe(true);
    expect(factory.importFromFile).toHaveBeenCalledWith('state.json');
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('supports explicit fresh context creation and marks restored flag false', async () => {
    const context = createContextMock();
    const factory = createFactoryMock(context);

    const manager = new LegacyRuntimeManager({
      stateFilePath: 'state.json',
      loadFactory: async () => factory,
      fileExists: jest.fn(() => true),
      deleteFile: jest.fn(),
    });

    const created = await manager.createFreshContext();

    expect(created).toBe(context);
    expect(manager.wasRestoredFromState()).toBe(false);
    expect(factory.create).toHaveBeenCalledTimes(1);
    expect(factory.importFromFile).not.toHaveBeenCalled();
  });

  it('persists state only after initialization', async () => {
    const context = createContextMock();
    const factory = createFactoryMock(context);

    const manager = new LegacyRuntimeManager({
      stateFilePath: 'state.json',
      loadFactory: async () => factory,
      fileExists: jest.fn(() => false),
      deleteFile: jest.fn(),
    });

    await expect(manager.persistState()).resolves.toBe(false);
    await manager.initialize();
    await expect(manager.persistState()).resolves.toBe(true);
    expect(context.exportToFile).toHaveBeenCalledWith('state.json');
  });

  it('reloads state and can force a fresh initialize', async () => {
    const firstContext = createContextMock();
    const secondContext = createContextMock();
    const factory = {
      create: jest.fn(async () => firstContext),
      importFromFile: jest.fn(async (_filePath: string) => secondContext),
    } satisfies LegacyContextFactory;

    const manager = new LegacyRuntimeManager({
      stateFilePath: 'state.json',
      loadFactory: async () => factory,
      fileExists: jest.fn(() => true),
      deleteFile: jest.fn(),
    });

    const fresh = await manager.initialize({ restoreFromState: false });
    const reloaded = await manager.reload({ restoreFromState: true });

    expect(fresh).toBe(firstContext);
    expect(reloaded).toBe(secondContext);
    expect(factory.create).toHaveBeenCalledTimes(1);
    expect(factory.importFromFile).toHaveBeenCalledWith('state.json');
    expect(manager.wasRestoredFromState()).toBe(true);
  });

  it('clears persisted state through adapter-managed state file', () => {
    const deleteFile = jest.fn();
    const manager = new LegacyRuntimeManager({
      stateFilePath: 'state.json',
      loadFactory: async () => createFactoryMock(createContextMock()),
      fileExists: jest.fn(() => true),
      deleteFile,
    });

    manager.clearPersistedState();

    expect(deleteFile).toHaveBeenCalledWith('state.json');
  });

  it('reports restored lifecycle outcome metadata when initializeWithOutcome restores state', async () => {
    const context = createContextMock();
    const factory = createFactoryMock(context);

    const manager = new LegacyRuntimeManager({
      stateFilePath: 'state.json',
      loadFactory: async () => factory,
      fileExists: jest.fn(() => true),
      deleteFile: jest.fn(),
    });

    const outcome = await manager.initializeWithOutcome();

    expect(outcome).toEqual({
      context,
      restoredFromState: true,
      lifecycleStatus: 'restored',
      hadStateFile: true,
    });
  });

  it('reports created lifecycle outcome metadata when state file is missing', async () => {
    const context = createContextMock();
    const factory = createFactoryMock(context);

    const manager = new LegacyRuntimeManager({
      stateFilePath: 'state.json',
      loadFactory: async () => factory,
      fileExists: jest.fn(() => false),
      deleteFile: jest.fn(),
    });

    const outcome = await manager.initializeWithOutcome();

    expect(outcome).toEqual({
      context,
      restoredFromState: false,
      lifecycleStatus: 'created',
      hadStateFile: false,
    });
  });

  it('reports fallback lifecycle outcome metadata when restore fails and a fresh context is created', async () => {
    const context = createContextMock();
    const factory = createFactoryMock(context);
    factory.importFromFile.mockRejectedValueOnce(new Error('corrupt'));
    const deleteFile = jest.fn();

    const manager = new LegacyRuntimeManager({
      stateFilePath: 'state.json',
      loadFactory: async () => factory,
      fileExists: jest.fn(() => true),
      deleteFile,
    });

    const outcome = await manager.initializeWithOutcome();

    expect(outcome).toEqual({
      context,
      restoredFromState: false,
      lifecycleStatus: 'fallback_after_restore_failure',
      hadStateFile: true,
    });
    expect(deleteFile).toHaveBeenCalledWith('state.json');
  });
});

describe('ensureLegacyRuntimeContext', () => {
  it('hydrates restored contexts and preserves skipAutoIndexOnce when restored', async () => {
    const context = createContextMock();
    const factory = createFactoryMock(context);
    const onRestoredFromState = jest.fn();
    const onAutoIndex = jest.fn(async () => undefined);
    const onAutoIndexSkip = jest.fn();

    const manager = new LegacyRuntimeManager({
      stateFilePath: 'state.json',
      loadFactory: async () => factory,
      fileExists: jest.fn(() => true),
      deleteFile: jest.fn(),
    });

    const result = await ensureLegacyRuntimeContext({
      manager,
      stateFilePath: 'state.json',
      offlineMode: false,
      apiUrl: 'https://api.example.com',
      skipAutoIndexOnce: true,
      onRestoredFromState,
      onAutoIndex,
      onAutoIndexSkip,
      logger: { error: jest.fn() },
    });

    expect(result.context).toBe(context);
    expect(result.skipAutoIndexOnce).toBe(true);
    expect(onRestoredFromState).toHaveBeenCalledTimes(1);
    expect(onAutoIndex).not.toHaveBeenCalled();
    expect(onAutoIndexSkip).not.toHaveBeenCalled();
  });

  it('auto-indexes when creating a new context and auto-index is enabled', async () => {
    const context = createContextMock();
    const factory = createFactoryMock(context);
    const onAutoIndex = jest.fn(async () => undefined);

    const manager = new LegacyRuntimeManager({
      stateFilePath: 'state.json',
      loadFactory: async () => factory,
      fileExists: jest.fn(() => false),
      deleteFile: jest.fn(),
    });

    const result = await ensureLegacyRuntimeContext({
      manager,
      stateFilePath: 'state.json',
      offlineMode: false,
      apiUrl: undefined,
      skipAutoIndexOnce: false,
      onAutoIndex,
      logger: { error: jest.fn() },
    });

    expect(result.context).toBe(context);
    expect(result.skipAutoIndexOnce).toBe(false);
    expect(onAutoIndex).toHaveBeenCalledTimes(1);
  });

  it('consumes skipAutoIndexOnce and calls onAutoIndexSkip when auto-index is skipped', async () => {
    const context = createContextMock();
    const factory = createFactoryMock(context);
    const onAutoIndex = jest.fn(async () => undefined);
    const onAutoIndexSkip = jest.fn();

    const manager = new LegacyRuntimeManager({
      stateFilePath: 'state.json',
      loadFactory: async () => factory,
      fileExists: jest.fn(() => false),
      deleteFile: jest.fn(),
    });

    const result = await ensureLegacyRuntimeContext({
      manager,
      stateFilePath: 'state.json',
      offlineMode: false,
      skipAutoIndexOnce: true,
      onAutoIndex,
      onAutoIndexSkip,
      logger: { error: jest.fn() },
    });

    expect(result.context).toBe(context);
    expect(result.skipAutoIndexOnce).toBe(false);
    expect(onAutoIndex).not.toHaveBeenCalled();
    expect(onAutoIndexSkip).toHaveBeenCalledTimes(1);
  });

  it('rejects remote API URLs while offline and reports status errors', async () => {
    const onStatusError = jest.fn();
    const manager = new LegacyRuntimeManager({
      stateFilePath: 'state.json',
      loadFactory: async () => createFactoryMock(createContextMock()),
      fileExists: jest.fn(() => true),
      deleteFile: jest.fn(),
    });

    await expect(
      ensureLegacyRuntimeContext({
        manager,
        stateFilePath: 'state.json',
        offlineMode: true,
        apiUrl: 'https://api.example.com',
        skipAutoIndexOnce: false,
        onStatusError,
        logger: { error: jest.fn() },
      })
    ).rejects.toThrow(/Offline mode enforced .*AUGMENT_API_URL points to a remote endpoint/i);
    expect(onStatusError).toHaveBeenCalledTimes(1);
  });

  it('rejects missing persisted state in offline mode', async () => {
    const onStatusError = jest.fn();
    const manager = new LegacyRuntimeManager({
      stateFilePath: 'state.json',
      loadFactory: async () => createFactoryMock(createContextMock()),
      fileExists: jest.fn(() => false),
      deleteFile: jest.fn(),
    });

    await expect(
      ensureLegacyRuntimeContext({
        manager,
        stateFilePath: 'state.json',
        offlineMode: true,
        skipAutoIndexOnce: false,
        onStatusError,
        logger: { error: jest.fn() },
      })
    ).rejects.toThrow(/Offline mode is enabled but no saved index found/i);
    expect(onStatusError).toHaveBeenCalledTimes(1);
  });

  it('rejects fallback-after-restore in offline mode and clears in-memory runtime', async () => {
    const context = createContextMock();
    const factory = createFactoryMock(context);
    factory.importFromFile.mockRejectedValueOnce(new Error('corrupt'));

    const onStatusError = jest.fn();
    const manager = new LegacyRuntimeManager({
      stateFilePath: 'state.json',
      loadFactory: async () => factory,
      fileExists: jest.fn(() => true),
      deleteFile: jest.fn(),
    });

    await expect(
      ensureLegacyRuntimeContext({
        manager,
        stateFilePath: 'state.json',
        offlineMode: true,
        skipAutoIndexOnce: false,
        onStatusError,
        logger: { error: jest.fn() },
      })
    ).rejects.toThrow(/Offline mode is enabled but no saved index found/i);
    expect(onStatusError).toHaveBeenCalledTimes(1);
    expect(manager.isInitialized()).toBe(false);
  });
});
