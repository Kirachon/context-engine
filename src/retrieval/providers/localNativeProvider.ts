import type {
  RetrievalProvider,
  RetrievalProviderCallbacks,
  RetrievalSearchOptions,
} from './types.js';

export class LocalNativeProvider implements RetrievalProvider {
  readonly id = 'local_native' as const;

  constructor(private readonly callbacks: RetrievalProviderCallbacks) {}

  search(query: string, topK: number, options?: RetrievalSearchOptions) {
    return this.callbacks.search(query, topK, options);
  }

  indexWorkspace() {
    return this.callbacks.indexWorkspace();
  }

  indexFiles(filePaths: string[]) {
    return this.callbacks.indexFiles(filePaths);
  }

  clearIndex() {
    return this.callbacks.clearIndex();
  }

  getIndexStatus() {
    return this.callbacks.getIndexStatus();
  }

  health() {
    return this.callbacks.health();
  }
}
