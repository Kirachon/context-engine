import type { ResourceTemplate } from '@modelcontextprotocol/sdk/types.js';
import { getDefaultDiscoverabilityTitle } from '../tooling/discoverability.js';

/**
 * MCP SDK 1.29.0 exposes resource templates through `resources/templates/list`
 * (`ListResourceTemplatesRequestSchema`), not inside `resources/list`
 * (`ListResourcesRequestSchema`). Concrete resources remain on resources/list;
 * parameterized URI patterns are advertised separately as templates.
 */
export const RESOURCE_TEMPLATE_TRANSPORT = Object.freeze({
  sdkVersion: '1.29.0',
  listResourcesIncludesTemplates: false,
  templateListMethod: 'resources/templates/list',
  templateListSchema: 'ListResourceTemplatesRequestSchema',
  templateResultField: 'resourceTemplates',
});

export const FILE_RESOURCE_TEMPLATE_URI = 'context-engine://files/{path}';
export const CHUNK_RESOURCE_TEMPLATE_URI = 'context-engine://chunks/{chunkId}';
export const SYMBOL_RESOURCE_TEMPLATE_URI = 'context-engine://symbols/{symbolId}';
export const CONTEXT_PACK_RESOURCE_TEMPLATE_URI = 'context-engine://context-packs/{packId}';
export const REVIEW_RESOURCE_TEMPLATE_URI = 'context-engine://reviews/{reviewId}';
export const INDEX_SNAPSHOT_RESOURCE_TEMPLATE_URI = 'context-engine://index/snapshot';

const RESOURCE_TEMPLATE_DEFINITIONS: ResourceTemplate[] = [
  {
    uriTemplate: FILE_RESOURCE_TEMPLATE_URI,
    name: 'workspace-file',
    title: getDefaultDiscoverabilityTitle('workspace-file'),
    description: 'Read a safe workspace-relative file by path.',
    mimeType: 'text/plain',
  },
  {
    uriTemplate: CHUNK_RESOURCE_TEMPLATE_URI,
    name: 'indexed-chunk',
    title: getDefaultDiscoverabilityTitle('indexed-chunk'),
    description: 'Read an indexed code chunk by chunk identifier.',
    mimeType: 'text/plain',
  },
  {
    uriTemplate: SYMBOL_RESOURCE_TEMPLATE_URI,
    name: 'indexed-symbol',
    title: getDefaultDiscoverabilityTitle('indexed-symbol'),
    description: 'Read indexed symbol metadata and snippet by symbol identifier.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: CONTEXT_PACK_RESOURCE_TEMPLATE_URI,
    name: 'context-pack',
    title: getDefaultDiscoverabilityTitle('context-pack'),
    description: 'Read a saved context pack bundle by pack identifier.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: REVIEW_RESOURCE_TEMPLATE_URI,
    name: 'review-session',
    title: getDefaultDiscoverabilityTitle('review-session'),
    description: 'Read a persisted review session artifact by review identifier.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: INDEX_SNAPSHOT_RESOURCE_TEMPLATE_URI,
    name: 'index-snapshot',
    title: getDefaultDiscoverabilityTitle('index-snapshot'),
    description: 'Read the current workspace index snapshot metadata.',
    mimeType: 'application/json',
  },
];

export function buildResourceTemplateList(): ResourceTemplate[] {
  return RESOURCE_TEMPLATE_DEFINITIONS.map((template) => ({ ...template }));
}
