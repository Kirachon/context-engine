import { describe, expect, it } from '@jest/globals';

import {
  PROMPT_DEFINITIONS,
  buildResourceList,
  buildToolRegistryEntries,
} from '../../src/mcp/server.js';
import { listRestApiToolMappings } from '../../src/mcp/tooling/discoverability.js';
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
    const findCallersMetadata = manifest.discoverability?.tools?.find((entry) => entry.id === 'find_callers');
    const findCalleesMetadata = manifest.discoverability?.tools?.find((entry) => entry.id === 'find_callees');
    const traceSymbolMetadata = manifest.discoverability?.tools?.find((entry) => entry.id === 'trace_symbol');
    const impactAnalysisMetadata = manifest.discoverability?.tools?.find((entry) => entry.id === 'impact_analysis');

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
        shared_contract: expect.objectContaining({
          latency_class: 'extended',
          index_requirement: 'recommended',
          provenance_availability: 'none',
          transport: expect.objectContaining({
            stdio_mcp: true,
            streamable_http_mcp: true,
            rest_api: expect.objectContaining({
              method: 'POST',
              path: '/api/v1/enhance-prompt',
            }),
          }),
        }),
      })
    );

    expect(symbolMetadata).toEqual(
      expect.objectContaining({
        id: 'symbol_search',
        title: 'Symbol Search',
        usage_hint: expect.stringContaining('identifier'),
        safety_hints: expect.arrayContaining(['Read-only deterministic local retrieval for identifier-style code navigation with explicit graph fallback receipts.']),
        related_surfaces: expect.objectContaining({
          tools: expect.arrayContaining(['semantic_search', 'get_file']),
        }),
        shared_contract: expect.objectContaining({
          graph_requirement: 'preferred',
          provenance_availability: 'fallback_receipts',
          explainability_fields: expect.arrayContaining([
            'backend',
            'graph_status',
            'graph_degraded_reason',
            'fallback_reason',
          ]),
          transport: expect.objectContaining({
            rest_api: expect.objectContaining({
              path: '/api/v1/symbol-search',
            }),
          }),
        }),
      })
    );

    expect(symbolReferencesMetadata).toEqual(
      expect.objectContaining({
        id: 'symbol_references',
        title: 'Symbol References',
        usage_hint: expect.stringContaining('usages'),
        safety_hints: expect.arrayContaining(['Read-only deterministic local retrieval for non-declaration symbol usages with explicit graph fallback receipts.']),
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
        safety_hints: expect.arrayContaining(['Read-only deterministic local retrieval for the single best declaration site with explicit graph fallback receipts.']),
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
        safety_hints: expect.arrayContaining(['Read-only deterministic local retrieval; graph-backed when available with controlled heuristic fallback.']),
        related_surfaces: expect.objectContaining({
          tools: expect.arrayContaining(['symbol_definition', 'symbol_references', 'symbol_search']),
        }),
      })
    );

    expect(findCallersMetadata).toEqual(
      expect.objectContaining({
        id: 'find_callers',
        title: 'Find Callers',
        usage_hint: expect.stringContaining('direct callers'),
        related_surfaces: expect.objectContaining({
          tools: expect.arrayContaining(['call_relationships', 'trace_symbol', 'impact_analysis']),
        }),
      })
    );

    expect(findCalleesMetadata).toEqual(
      expect.objectContaining({
        id: 'find_callees',
        title: 'Find Callees',
        usage_hint: expect.stringContaining('direct callees'),
        related_surfaces: expect.objectContaining({
          tools: expect.arrayContaining(['call_relationships', 'trace_symbol', 'impact_analysis']),
        }),
      })
    );

    expect(traceSymbolMetadata).toEqual(
      expect.objectContaining({
        id: 'trace_symbol',
        title: 'Trace Symbol',
        usage_hint: expect.stringContaining('definition'),
        related_surfaces: expect.objectContaining({
          tools: expect.arrayContaining(['find_callers', 'find_callees', 'impact_analysis']),
        }),
      })
    );

    expect(impactAnalysisMetadata).toEqual(
      expect.objectContaining({
        id: 'impact_analysis',
        title: 'Impact Analysis',
        usage_hint: expect.stringContaining('direct change surface'),
        related_surfaces: expect.objectContaining({
          tools: expect.arrayContaining(['trace_symbol', 'find_callers', 'find_callees', 'symbol_definition']),
        }),
        shared_contract: expect.objectContaining({
          latency_class: 'extended',
          graph_requirement: 'preferred',
          provenance_availability: 'fallback_receipts',
          transport: expect.objectContaining({
            rest_api: expect.objectContaining({
              path: '/api/v1/impact-analysis',
            }),
          }),
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

  it('keeps manifest tool ids, runtime registration, and REST parity declarations aligned', () => {
    const entries = buildToolRegistryEntries({} as any);
    const runtimeToolNames = entries.map((entry) => entry.tool.name).sort((left, right) => left.localeCompare(right));
    const manifest = getToolManifest() as {
      tools: string[];
      discoverability?: {
        tools?: Array<{
          id: string;
          shared_contract?: {
            transport?: {
              rest_api?: {
                method: 'POST';
                path: `/api/v1/${string}`;
              };
            };
          };
        }>;
      };
    };

    expect([...manifest.tools].sort((left, right) => left.localeCompare(right))).toEqual(runtimeToolNames);
    expect(
      (manifest.discoverability?.tools ?? [])
        .map((entry) => entry.id)
        .sort((left, right) => left.localeCompare(right))
    ).toEqual(runtimeToolNames);

    expect(
      (manifest.discoverability?.tools ?? [])
        .flatMap((entry) =>
          entry.shared_contract?.transport?.rest_api
            ? [{
                tool: entry.id,
                method: entry.shared_contract.transport.rest_api.method,
                path: entry.shared_contract.transport.rest_api.path,
              }]
            : []
        )
        .sort((left, right) => left.path.localeCompare(right.path))
    ).toEqual(listRestApiToolMappings());
  });
});
