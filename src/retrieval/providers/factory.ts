import { resolveRetrievalProviderId } from './env.js';
import { LocalNativeProvider } from './localNativeProvider.js';
import type {
  RetrievalProvider,
  RetrievalProviderCallbacks,
  RetrievalProviderId,
} from './types.js';
type RetrievalProviderFactory = (callbacks: RetrievalProviderCallbacks) => RetrievalProvider;

const PROVIDER_REGISTRY: Record<RetrievalProviderId, RetrievalProviderFactory> = {
  local_native: (callbacks) => new LocalNativeProvider(callbacks, 'local_native'),
  local_native_v2: (callbacks) => new LocalNativeProvider(callbacks, 'local_native_v2'),
};

export interface CreateRetrievalProviderOptions {
  providerId?: RetrievalProviderId;
  callbacks: RetrievalProviderCallbacks;
}

export function createRetrievalProvider(
  options: CreateRetrievalProviderOptions
): RetrievalProvider {
  const providerId = options.providerId ?? resolveRetrievalProviderId();
  const providerFactory = PROVIDER_REGISTRY[providerId];
  return providerFactory(options.callbacks);
}

export function getRetrievalProviderRegistry(): Readonly<Record<RetrievalProviderId, RetrievalProviderFactory>> {
  return PROVIDER_REGISTRY;
}
