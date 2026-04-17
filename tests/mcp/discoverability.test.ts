import { describe, expect, it } from '@jest/globals';

import {
  PROMPT_DEFINITIONS,
  buildResourceList,
  buildToolRegistryEntries,
} from '../../src/mcp/server.js';
import { getToolManifest } from '../../src/mcp/tools/manifest.js';
import { initializePlanManagementServices } from '../../src/mcp/tools/planManagement.js';

describe('MCP discoverability metadata', () => {
  it('applies canonical tool metadata to runtime tool registration and tool_manifest', () => {
    const entries = buildToolRegistryEntries({} as any);
    const enhanceTool = entries.find((entry) => entry.tool.name === 'enhance_prompt')?.tool as
      | {
          name: string;
          title?: string;
          annotations?: {
            title?: string;
            readOnlyHint?: boolean;
            idempotentHint?: boolean;
          };
        }
      | undefined;

    expect(enhanceTool).toEqual(
      expect.objectContaining({
        name: 'enhance_prompt',
        title: 'Enhance Prompt',
        annotations: expect.objectContaining({
          title: 'Enhance Prompt',
          readOnlyHint: true,
          idempotentHint: true,
        }),
      })
    );

    const manifest = getToolManifest() as {
      discoverability?: {
        tools?: Array<{
          id: string;
          title?: string;
          usage_hint?: string;
          safety_hints?: string[];
          related_surfaces?: { prompts?: string[]; tools?: string[] };
        }>;
      };
    };
    const enhanceMetadata = manifest.discoverability?.tools?.find((entry) => entry.id === 'enhance_prompt');
    const symbolMetadata = manifest.discoverability?.tools?.find((entry) => entry.id === 'symbol_search');
    const symbolReferencesMetadata = manifest.discoverability?.tools?.find((entry) => entry.id === 'symbol_references');
    const symbolDefinitionMetadata = manifest.discoverability?.tools?.find((entry) => entry.id === 'symbol_definition');
    const callRelationshipsMetadata = manifest.discoverability?.tools?.find((entry) => entry.id === 'call_relationships');

    expect(enhanceMetadata).toEqual(
      expect.objectContaining({
        id: 'enhance_prompt',
        title: 'Enhance Prompt',
        usage_hint: expect.stringContaining('repo-grounded'),
        safety_hints: expect.arrayContaining(['Read-only; enhancement may use external references only when provided explicitly.']),
        related_surfaces: expect.objectContaining({
          prompts: expect.arrayContaining(['enhance-request']),
          tools: expect.arrayContaining(['create_plan']),
        }),
      })
    );

    expect(symbolMetadata).toEqual(
      expect.objectContaining({
        id: 'symbol_search',
        title: 'Symbol Search',
        usage_hint: expect.stringContaining('identifier'),
        safety_hints: expect.arrayContaining(['Read-only deterministic local retrieval for identifier-style code navigation.']),
        related_surfaces: expect.objectContaining({
          tools: expect.arrayContaining(['semantic_search', 'get_file']),
        }),
      })
    );

    expect(symbolReferencesMetadata).toEqual(
      expect.objectContaining({
        id: 'symbol_references',
        title: 'Symbol References',
        usage_hint: expect.stringContaining('usages'),
        safety_hints: expect.arrayContaining(['Read-only deterministic local retrieval for non-declaration symbol usages.']),
        related_surfaces: expect.objectContaining({
          tools: expect.arrayContaining(['symbol_search', 'get_file']),
        }),
      })
    );

    expect(symbolDefinitionMetadata).toEqual(
      expect.objectContaining({
        id: 'symbol_definition',
        title: 'Symbol Definition',
        usage_hint: expect.stringContaining('declaration'),
        safety_hints: expect.arrayContaining(['Read-only deterministic local retrieval for the single best declaration site.']),
        related_surfaces: expect.objectContaining({
          tools: expect.arrayContaining(['symbol_search', 'symbol_references', 'get_file']),
        }),
      })
    );

    expect(callRelationshipsMetadata).toEqual(
      expect.objectContaining({
        id: 'call_relationships',
        title: 'Call Relationships',
        usage_hint: expect.stringContaining('callers'),
        safety_hints: expect.arrayContaining(['Read-only deterministic local heuristic; brace-language only for callees in v1.']),
        related_surfaces: expect.objectContaining({
          tools: expect.arrayContaining(['symbol_definition', 'symbol_references', 'symbol_search']),
        }),
      })
    );

    const reviewTool = entries.find((entry) => entry.tool.name === 'review_memory_suggestions')?.tool as
      | {
          name: string;
          title?: string;
          annotations?: {
            title?: string;
          };
        }
      | undefined;

    expect(reviewTool).toEqual(
      expect.objectContaining({
        name: 'review_memory_suggestions',
        title: 'Review Memory Suggestions',
        annotations: expect.objectContaining({
          title: 'Review Memory Suggestions',
        }),
      })
    );
  });

  it('applies canonical prompt titles to runtime prompts and tool_manifest', () => {
    const enhancePrompt = PROMPT_DEFINITIONS.find((prompt) => prompt.name === 'enhance-request');

    expect(enhancePrompt).toEqual(
      expect.objectContaining({
        name: 'enhance-request',
        title: 'Enhance Request',
      })
    );

    const manifest = getToolManifest() as {
      discoverability?: {
        prompts?: Array<{ id: string; title?: string; related_surfaces?: { tools?: string[] } }>;
      };
    };

    expect(manifest.discoverability?.prompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'enhance-request',
          title: 'Enhance Request',
          related_surfaces: expect.objectContaining({
            tools: expect.arrayContaining(['enhance_prompt']),
          }),
        }),
      ])
    );
  });

  it('applies canonical resource titles to runtime resources and tool_manifest', async () => {
    initializePlanManagementServices(process.cwd());
    const resources = await buildResourceList();
    const manifestResource = resources.find((resource) => resource.uri === 'context-engine://tool-manifest');

    expect(manifestResource).toEqual(
      expect.objectContaining({
        uri: 'context-engine://tool-manifest',
        title: 'Tool Manifest',
      })
    );

    const manifest = getToolManifest() as {
      discoverability?: {
        resources?: Array<{ id: string; uri_pattern?: string; title?: string }>;
      };
    };

    expect(manifest.discoverability?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'context-engine://tool-manifest',
          uri_pattern: 'context-engine://tool-manifest',
          title: 'Tool Manifest',
        }),
      ])
    );
  });
});
