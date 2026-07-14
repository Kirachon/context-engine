import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileWatcher } from '../../src/watcher/FileWatcher.js';
import { FileChange, WatcherChangeFilter } from '../../src/watcher/types.js';
import { createWatcherDiscoveryAdapter } from '../../src/watcher/discoveryAdapter.js';

describe('FileWatcher', () => {
  jest.useFakeTimers();

  const root = process.cwd();
  let onBatch: jest.Mock<(changes: FileChange[]) => Promise<void>>;
  let watcher: FileWatcher;

  beforeEach(() => {
    onBatch = jest.fn<(changes: FileChange[]) => Promise<void>>().mockResolvedValue(undefined);
    watcher = new FileWatcher(root, { onBatch }, { debounceMs: 50, maxBatchSize: 10 });
  });

  it('debounces and batches file changes', async () => {
    watcher.handleEvent('add', path.join(root, 'a.ts'));
    watcher.handleEvent('change', path.join(root, 'a.ts')); // should replace add with change
    watcher.handleEvent('add', path.join(root, 'b.ts'));
    watcher.handleEvent('unlink', path.join(root, 'b.ts')); // last event should win for the path

    jest.advanceTimersByTime(60);
    await Promise.resolve();

    expect(onBatch).toHaveBeenCalledTimes(1);
    const batch = onBatch.mock.calls[0][0] as FileChange[];
    expect(batch).toHaveLength(2);

    const aChange = batch.find((c) => c.path === 'a.ts');
    expect(aChange?.type).toBe('change');
    const bChange = batch.find((c) => c.path === 'b.ts');
    expect(bChange?.type).toBe('unlink');
  });

  it('splits batches when exceeding maxBatchSize', async () => {
    const paths = Array.from({ length: 12 }, (_, i) => path.join(root, `file${i}.ts`));
    paths.forEach((p) => watcher.handleEvent('change', p));

    jest.advanceTimersByTime(60);
    await Promise.resolve();

    expect(onBatch).toHaveBeenCalledTimes(2); // 12 files with batch size 10 -> 2 batches
  });

  describe('changeFilter (R3b1)', () => {
    it('forwards only the changes the filter marks eligible', async () => {
      const filter: WatcherChangeFilter = {
        applyBatch: jest
          .fn<WatcherChangeFilter['applyBatch']>()
          .mockImplementation(async (changes) => ({
            eligibleChanges: changes.filter((c) => c.path === 'a.ts'),
          })),
      };
      const filteredWatcher = new FileWatcher(
        root,
        { onBatch },
        { debounceMs: 50, maxBatchSize: 10, changeFilter: filter }
      );

      filteredWatcher.handleEvent('add', path.join(root, 'a.ts'));
      filteredWatcher.handleEvent('add', path.join(root, 'b.ts'));

      jest.advanceTimersByTime(60);
      await Promise.resolve();
      await Promise.resolve();

      expect(filter.applyBatch).toHaveBeenCalledTimes(1);
      expect(onBatch).toHaveBeenCalledTimes(1);
      const batch = onBatch.mock.calls[0][0] as FileChange[];
      expect(batch.map((c) => c.path)).toEqual(['a.ts']);
    });

    it('never calls onBatch when the filter drops every change in the batch', async () => {
      const filter: WatcherChangeFilter = {
        applyBatch: jest.fn<WatcherChangeFilter['applyBatch']>().mockResolvedValue({ eligibleChanges: [] }),
      };
      const filteredWatcher = new FileWatcher(
        root,
        { onBatch },
        { debounceMs: 50, maxBatchSize: 10, changeFilter: filter }
      );

      filteredWatcher.handleEvent('add', path.join(root, 'ignored.ts'));

      jest.advanceTimersByTime(60);
      await Promise.resolve();
      await Promise.resolve();

      expect(filter.applyBatch).toHaveBeenCalledTimes(1);
      expect(onBatch).not.toHaveBeenCalled();
    });

    it('integrates with the canonical discovery adapter to drop ineligible paths and preserve negation', async () => {
      // Real fs I/O inside the discovery adapter needs the real event loop
      // (libuv poll phase), not just fake-timer macrotask advancement.
      jest.useRealTimers();
      const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-filewatcher-discovery-'));
      try {
        fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
        fs.writeFileSync(path.join(workspacePath, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
        fs.writeFileSync(path.join(workspacePath, '.gitignore'), ['*.md', '!keep.md'].join('\n'), 'utf-8');

        const discoveryAdapter = await createWatcherDiscoveryAdapter(workspacePath);
        const changeFilter: WatcherChangeFilter = {
          applyBatch: async (changes) => {
            const result = await discoveryAdapter.applyBatch(changes);
            return { eligibleChanges: [...result.eligibleChanges] };
          },
        };
        const discoveryWatcher = new FileWatcher(
          workspacePath,
          { onBatch },
          { debounceMs: 50, maxBatchSize: 10, ignored: discoveryAdapter.chokidarIgnored, changeFilter }
        );

        fs.writeFileSync(path.join(workspacePath, 'keep.md'), 'keep\n', 'utf-8');
        fs.writeFileSync(path.join(workspacePath, 'debug.md'), 'debug\n', 'utf-8');
        fs.mkdirSync(path.join(workspacePath, 'node_modules', 'pkg'), { recursive: true });
        fs.writeFileSync(path.join(workspacePath, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};\n', 'utf-8');

        discoveryWatcher.handleEvent('add', path.join(workspacePath, 'keep.md'));
        discoveryWatcher.handleEvent('add', path.join(workspacePath, 'debug.md'));
        discoveryWatcher.handleEvent('add', path.join(workspacePath, 'node_modules', 'pkg', 'index.js'));

        await new Promise((resolve) => setTimeout(resolve, 150));

        expect(onBatch).toHaveBeenCalledTimes(1);
        const batch = onBatch.mock.calls[0][0] as FileChange[];
        expect(batch.map((c) => c.path)).toEqual(['keep.md']);
      } finally {
        fs.rmSync(workspacePath, { recursive: true, force: true });
        jest.useFakeTimers();
      }
    });
  });
});
