import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import * as path from 'path';
import { FileWatcher } from '../../src/watcher/FileWatcher.js';
import { FileChange } from '../../src/watcher/types.js';

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
});
