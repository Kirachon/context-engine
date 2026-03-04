import type {
  RetrievalProvider,
  RetrievalProviderCallbacks,
  RetrievalSearchOptions,
} from './types.js';

export class AugmentLegacyProvider implements RetrievalProvider {
  readonly id = 'augment_legacy' as const;

  constructor(private readonly callbacks: RetrievalProviderCallbacks) {}

  search(query: string, topK: number, options?: RetrievalSearchOptions) {
    return this.callbacks.augmentLegacy.search(query, topK, options, {
      providerId: this.id,
      operation: 'search',
    });
  }

  indexWorkspace() {
    return this.callbacks.augmentLegacy.indexWorkspace({
      providerId: this.id,
      operation: 'indexWorkspace',
    });
  }

  indexFiles(filePaths: string[]) {
    return this.callbacks.augmentLegacy.indexFiles(filePaths, {
      providerId: this.id,
      operation: 'indexFiles',
    });
  }

  clearIndex() {
    return this.callbacks.augmentLegacy.clearIndex({
      providerId: this.id,
      operation: 'clearIndex',
    });
  }

  getIndexStatus() {
    return this.callbacks.augmentLegacy.getIndexStatus({
      providerId: this.id,
      operation: 'getIndexStatus',
    });
  }

  health() {
    return this.callbacks.augmentLegacy.health({
      providerId: this.id,
      operation: 'health',
    });
  }
}
