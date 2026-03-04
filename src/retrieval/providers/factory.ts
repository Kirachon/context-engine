import { AugmentLegacyProvider } from './augmentLegacyProvider.js';
import { resolveRetrievalProviderId } from './env.js';
import { LocalNativeProvider } from './localNativeProvider.js';
import type {
  RetrievalProvider,
  RetrievalProviderCallbacks,
  RetrievalProviderId,
} from './types.js';

type RetrievalProviderConstructor = new (
  callbacks: RetrievalProviderCallbacks
) => RetrievalProvider;

const PROVIDER_REGISTRY: Record<RetrievalProviderId, RetrievalProviderConstructor> = {
  augment_legacy: AugmentLegacyProvider,
  local_native: LocalNativeProvider,
};

export interface CreateRetrievalProviderOptions {
  providerId?: RetrievalProviderId;
  callbacks: RetrievalProviderCallbacks;
}

export function createRetrievalProvider(
  options: CreateRetrievalProviderOptions
): RetrievalProvider {
  const providerId = options.providerId ?? resolveRetrievalProviderId();
  const ProviderCtor = PROVIDER_REGISTRY[providerId];
  if (!ProviderCtor) {
    throw new Error(`Unsupported retrieval provider "${providerId}"`);
  }

  return new ProviderCtor(options.callbacks);
}

export function getRetrievalProviderRegistry(): Readonly<Record<RetrievalProviderId, RetrievalProviderConstructor>> {
  return PROVIDER_REGISTRY;
}
