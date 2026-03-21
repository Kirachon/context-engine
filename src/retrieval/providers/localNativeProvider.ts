import type {
  RetrievalProvider,
  RetrievalProviderCallbacks,
  RetrievalProviderId,
  RetrievalSearchOptions,
} from './types.js';

export class LocalNativeProvider implements RetrievalProvider {
  readonly id: RetrievalProviderId;

  constructor(
    private readonly callbacks: RetrievalProviderCallbacks,
    providerId: RetrievalProviderId = 'local_native'
  ) {
    this.id = providerId;
  }

  search(query: string, topK: number, options?: RetrievalSearchOptions) {
    return this.callbacks.localNative.search(query, topK, options, {
      providerId: this.id,
      operation: 'search',
    });
  }

  indexWorkspace() {
    return this.callbacks.localNative.indexWorkspace({
      providerId: this.id,
      operation: 'indexWorkspace',
    });
  }

  indexFiles(filePaths: string[]) {
    return this.callbacks.localNative.indexFiles(filePaths, {
      providerId: this.id,
      operation: 'indexFiles',
    });
  }

  clearIndex() {
    return this.callbacks.localNative.clearIndex({
      providerId: this.id,
      operation: 'clearIndex',
    });
  }

  getIndexStatus() {
    return this.callbacks.localNative.getIndexStatus({
      providerId: this.id,
      operation: 'getIndexStatus',
    });
  }

  health() {
    return this.callbacks.localNative.health({
      providerId: this.id,
      operation: 'health',
    });
  }
}
