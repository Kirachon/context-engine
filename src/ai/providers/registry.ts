/**
 * Static, read-only provider descriptor registry.
 *
 * Pure declarative catalogue of provider ids known to the multi-provider
 * framework, with their capabilities and activation tier. Selecting a provider
 * still goes through factory.ts; this module is not consumed by routing yet.
 */

export type ProviderTier = 'stable' | 'experimental' | 'shadow_only';

export interface ProviderDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly tier: ProviderTier;
  readonly capabilities: {
    readonly streaming: boolean;
    readonly toolCalls: boolean;
    readonly structuredOutput: boolean;
  };
  readonly notes?: string;
}

const OPENAI_SESSION: ProviderDescriptor = Object.freeze({
  id: 'openai_session',
  displayName: 'OpenAI Codex Session',
  tier: 'stable' as const,
  capabilities: Object.freeze({
    streaming: true,
    toolCalls: true,
    structuredOutput: true,
  }),
  notes: 'Default and only stable provider. Backed by CodexSessionProvider.',
});

const DESCRIPTORS: readonly ProviderDescriptor[] = Object.freeze([OPENAI_SESSION]);

export function listProviderDescriptors(): readonly ProviderDescriptor[] {
  return DESCRIPTORS;
}

export function getProviderDescriptor(id: string): ProviderDescriptor | undefined {
  if (!id) return undefined;
  return DESCRIPTORS.find((d) => d.id === id);
}

export function isKnownProviderId(id: string): boolean {
  return getProviderDescriptor(id) !== undefined;
}

export function isStableProviderId(id: string): boolean {
  const d = getProviderDescriptor(id);
  return d !== undefined && d.tier === 'stable';
}
