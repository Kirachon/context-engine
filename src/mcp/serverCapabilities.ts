export type ServerCapabilityOptions = {
  resources?: boolean;
  prompts?: boolean;
  roots?: boolean;
};

type AdvertisedServerCapability = {
  capability: Record<string, unknown> | undefined;
  runtimeReceipts: string[];
};

export const SERVER_CAPABILITY_PARITY: Readonly<{
  tools: AdvertisedServerCapability;
  resources: AdvertisedServerCapability;
  prompts: AdvertisedServerCapability;
  logging: AdvertisedServerCapability;
  roots: AdvertisedServerCapability;
}> = Object.freeze({
  tools: {
    capability: Object.freeze({ listChanged: true }),
    runtimeReceipts: ['ListToolsRequestSchema', 'CallToolRequestSchema'],
  },
  resources: {
    capability: Object.freeze({ subscribe: false, listChanged: true }),
    runtimeReceipts: [
      'ListResourcesRequestSchema',
      'ListResourceTemplatesRequestSchema',
      'ReadResourceRequestSchema',
    ],
  },
  prompts: {
    capability: Object.freeze({ listChanged: true }),
    runtimeReceipts: ['ListPromptsRequestSchema', 'GetPromptRequestSchema'],
  },
  logging: {
    capability: undefined,
    runtimeReceipts: [],
  },
  roots: {
    capability: undefined,
    runtimeReceipts: ['RootsListChangedNotificationSchema', 'roots/list'],
  },
});

export function createServerCapabilities(options?: ServerCapabilityOptions): Record<string, unknown> {
  const capabilities: Record<string, unknown> = {
    tools: SERVER_CAPABILITY_PARITY.tools.capability,
  };

  if (options?.resources) {
    capabilities.resources = SERVER_CAPABILITY_PARITY.resources.capability;
  }
  if (options?.prompts) {
    capabilities.prompts = SERVER_CAPABILITY_PARITY.prompts.capability;
  }

  return capabilities;
}
