import chokidar from 'chokidar';
import * as path from 'path';
import { FileChange, FileChangeType, WatcherOptions, WatcherHooks, WatcherChangeFilter } from './types.js';
import { WatcherStatus } from '../mcp/serviceClient.js';

/**
 * Lightweight file watcher that batches file changes and forwards them
 * to a callback. Designed to be optional and safe (disabled by default).
 */
export class FileWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private pendingChanges: Map<string, FileChange> = new Map();
  private debounceTimer: NodeJS.Timeout | null = null;
  private flushInFlight: Promise<void> | null = null;
  private flushQueued: boolean = false;
  private lastFlush: string | undefined;

  private readonly root: string;
  private readonly hooks: WatcherHooks;
  private readonly options: Required<Omit<WatcherOptions, 'changeFilter'>>;
  private readonly changeFilter?: WatcherChangeFilter;

  constructor(root: string, hooks: WatcherHooks, options?: WatcherOptions) {
    this.root = root;
    this.hooks = hooks;
    this.options = {
      debounceMs: options?.debounceMs ?? 500,
      ignored: options?.ignored ?? [],
      persistent: options?.persistent ?? false,
      maxBatchSize: options?.maxBatchSize ?? 100,
    };
    this.changeFilter = options?.changeFilter;
  }

  start(): void {
    if (this.watcher) return;

    this.watcher = chokidar.watch(this.root, {
      ignoreInitial: true,
      persistent: this.options.persistent,
      ignored: this.options.ignored,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    });

    this.watcher.on('add', (p: string) => this.handleEvent('add', p));
    this.watcher.on('change', (p: string) => this.handleEvent('change', p));
    this.watcher.on('unlink', (p: string) => this.handleEvent('unlink', p));
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    // Flush any pending changes before closing to avoid losing events.
    await this.requestFlush();
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Exposed for tests and chokidar callbacks.
   */
  handleEvent(type: FileChangeType, filePath: string): void {
    const relative = path.relative(this.root, filePath);
    if (!relative || relative.startsWith('..')) return;

    this.pendingChanges.set(relative, {
      type,
      path: relative,
      timestamp: Date.now(),
    });

    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.requestFlush();
    }, this.options.debounceMs);
  }

  private async requestFlush(): Promise<void> {
    if (this.pendingChanges.size === 0) return;

    if (this.flushInFlight) {
      this.flushQueued = true;
      return;
    }

    this.flushInFlight = this.flush();
    try {
      await this.flushInFlight;
    } finally {
      this.flushInFlight = null;
      if (this.flushQueued) {
        this.flushQueued = false;
        await this.requestFlush();
      }
    }
  }

  private async flush(): Promise<void> {
    if (this.pendingChanges.size === 0) return;

    let changes = Array.from(this.pendingChanges.values());
    this.pendingChanges.clear();

    if (this.changeFilter) {
      // R3b1: re-validate against the canonical discovery manifest so a
      // batch can never add an ineligible path or drop an eligible
      // negation result before reaching `hooks.onBatch`.
      const { eligibleChanges } = await this.changeFilter.applyBatch(changes);
      changes = eligibleChanges;
    }

    if (changes.length === 0) {
      this.lastFlush = new Date().toISOString();
      return;
    }

    const batches: FileChange[][] = [];
    const batchSize = this.options.maxBatchSize;
    for (let i = 0; i < changes.length; i += batchSize) {
      batches.push(changes.slice(i, i + batchSize));
    }

    for (const batch of batches) {
      await this.hooks.onBatch(batch);
    }

    this.lastFlush = new Date().toISOString();
  }

  getStatus(): WatcherStatus {
    return {
      enabled: Boolean(this.watcher),
      watching: this.watcher ? 1 : 0,
      pendingChanges: this.pendingChanges.size,
      lastFlush: this.lastFlush,
    };
  }
}
