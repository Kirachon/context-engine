import { AugmentLegacyProvider } from './augmentLegacyProvider.js';
import { resolveRetrievalProviderId, validateAugmentLegacyAuthConfig } from './env.js';
import { LocalNativeProvider } from './localNativeProvider.js';
import type {
  RetrievalProvider,
  RetrievalProviderCallbacks,
  RetrievalProviderId,
} from './types.js';
import { RetrievalProviderError } from './types.js';

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
  if (providerId === 'augment_legacy' && options.providerId === 'augment_legacy') {
    validateAugmentLegacyAuthConfig(process.env, { selectionSource: 'providerId' });
  }
  const ProviderCtor = PROVIDER_REGISTRY[providerId];
  if (!ProviderCtor) {
    throw new RetrievalProviderError({
      code: 'provider_unsupported',
      provider: providerId,
      message: `Unsupported retrieval provider "${providerId}"`,
    });
  }

  return new ProviderCtor(options.callbacks);
}

export function getRetrievalProviderRegistry(): Readonly<Record<RetrievalProviderId, RetrievalProviderConstructor>> {
  return PROVIDER_REGISTRY;
}
