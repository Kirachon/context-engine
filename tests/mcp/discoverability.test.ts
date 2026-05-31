import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import {
  PROMPT_DEFINITIONS,
  buildToolRegistryEntries,
} from '../../src/mcp/server.js';
import {
  TOOL_MANIFEST_RESOURCE_URI,
  buildResourceList,
} from '../../src/mcp/resources/resourceRouter.js';
import { listRestApiToolMappings } from '../../src/mcp/tooling/discoverability.js';
import { getToolManifest } from '../../src/mcp/tools/manifest.js';
import { initializePlanManagementServices } from '../../src/mcp/tools/planManagement.js';

type SelectionProfile = {
  schema_version: 1;
  intent_tags: string[];
  preferred_when: string[];
  avoid_when: string[];
  selection_signals: string[];
  operation_risk: string[];
};

const ALLOWED_INTENT_TAGS = new Set([
  'index',
  'search',
  'context',
  'symbol',
  'file',
  'enhancement',
  'manifest',
  'memory',
  'planning',
  'approval',
  'execution_tracking',
  'review',
  'static_analysis',
  'security',
  'resource',
  'diagnostics',
]);

const ALLOWED_OPERATION_RISKS = new Set([
  'read_only',
  'writes_workspace_state',
  'destructive',
  'runs_local_process',
  'uses_git_state',
  'uses_external_sources',
  'may_send_to_llm',
  'secret_exposure_risk',
]);

const POISONING_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/iu,
  /exfiltrat/iu,
  /leak\s+(the\s+)?secret/iu,
  /run\s+.+command/iu,
  /delete\s+.+files?/iu,
];

function metadataText(entry: {
  title?: string;
  usage_hint?: string;
  examples?: string[];
  safety_hints?: string[];
  selection_profile?: SelectionProfile;
}): string {
  return [
    entry.title,
    entry.usage_hint,
    ...(entry.examples ?? []),
    ...(entry.safety_hints ?? []),
    ...(entry.selection_profile?.preferred_when ?? []),
    ...(entry.selection_profile?.avoid_when ?? []),
    ...(entry.selection_profile?.selection_signals ?? []),
    ...(entry.selection_profile?.intent_tags ?? []),
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ');
}

function selectToolsForIntent(intent: string, tools: Array<{
  id: string;
  title?: string;
  usage_hint?: string;
  examples?: string[];
  selection_profile?: SelectionProfile;
}>): string[] {
  const tokens = intent
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .filter((token) => token.length > 2);

  return tools
    .map((tool) => {
      const haystack = metadataText(tool).toLowerCase();
      const tokenScore = tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
      const tagScore = (tool.selection_profile?.intent_tags ?? []).reduce(
        (score, tag) => score + (tokens.some((token) => tag.includes(token) || token.includes(tag)) ? 3 : 0),
        0
      );
      return { id: tool.id, score: tokenScore + tagScore };
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, 3)
    .map((tool) => tool.id);
}

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
    const manifestResource = resources.find((resource) => resource.uri === TOOL_MANIFEST_RESOURCE_URI);

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

  it('adds additive selection profiles for every runtime tool without changing tool registration', () => {
    const entries = buildToolRegistryEntries({} as any);
    const manifest = getToolManifest() as {
      discoverability?: {
        tools?: Array<{
          id: string;
          safety_hints?: string[];
          annotations?: unknown;
          selection_profile?: SelectionProfile;
        }>;
      };
    };

    const manifestTools = manifest.discoverability?.tools ?? [];
    const runtimeToolNames = new Set(entries.map((entry) => entry.tool.name));

    expect(manifestTools).toHaveLength(runtimeToolNames.size);
    for (const entry of manifestTools) {
      expect(runtimeToolNames.has(entry.id)).toBe(true);
      expect(entry.selection_profile).toEqual(
        expect.objectContaining({
          schema_version: 1,
          intent_tags: expect.any(Array),
          preferred_when: expect.any(Array),
          avoid_when: expect.any(Array),
          selection_signals: expect.any(Array),
          operation_risk: expect.any(Array),
        })
      );
      expect(entry.selection_profile?.intent_tags.length).toBeGreaterThan(0);
      expect(entry.selection_profile?.preferred_when.length).toBeGreaterThan(0);
      expect(entry.selection_profile?.selection_signals.length).toBeGreaterThan(0);
      for (const tag of entry.selection_profile?.intent_tags ?? []) {
        expect(ALLOWED_INTENT_TAGS.has(tag)).toBe(true);
      }
      for (const risk of entry.selection_profile?.operation_risk ?? []) {
        expect(ALLOWED_OPERATION_RISKS.has(risk)).toBe(true);
      }
    }
  });

  it('keeps selection metadata declarative and flags risky tools with safety hints', () => {
    const manifest = getToolManifest() as {
      discoverability?: {
        tools?: Array<{
          id: string;
          title?: string;
          usage_hint?: string;
          examples?: string[];
          safety_hints?: string[];
          selection_profile?: SelectionProfile;
        }>;
      };
    };

    for (const entry of manifest.discoverability?.tools ?? []) {
      const text = metadataText(entry);
      expect(text).not.toMatch(/[\0\r]/u);
      for (const pattern of POISONING_PATTERNS) {
        expect(text).not.toMatch(pattern);
      }

      const risks = new Set(entry.selection_profile?.operation_risk ?? []);
      const requiresSafetyHint = [...risks].some((risk) => risk !== 'read_only');
      if (requiresSafetyHint) {
        expect(entry.safety_hints?.length ?? 0).toBeGreaterThan(0);
      }
      if (risks.has('destructive')) {
        expect(entry.safety_hints?.join(' ')).toMatch(/destructive|remove|rollback/i);
      }
    }
  });

  it('pins risk labels for representative sensitive tools', () => {
    const manifest = getToolManifest() as {
      discoverability?: {
        tools?: Array<{
          id: string;
          selection_profile?: SelectionProfile;
        }>;
      };
    };
    const byId = new Map((manifest.discoverability?.tools ?? []).map((tool) => [tool.id, tool]));
    const expectedRisks: Record<string, string[]> = {
      index_workspace: ['writes_workspace_state'],
      clear_index: ['destructive'],
      delete_plan: ['destructive'],
      review_auto: ['uses_git_state', 'may_send_to_llm'],
      run_static_analysis: ['runs_local_process'],
      scrub_secrets: ['secret_exposure_risk'],
      reactive_review_pr: ['writes_workspace_state', 'may_send_to_llm'],
      pause_review: ['writes_workspace_state'],
      resume_review: ['writes_workspace_state'],
    };

    for (const [toolId, risks] of Object.entries(expectedRisks)) {
      expect(byId.has(toolId)).toBe(true);
      expect(byId.get(toolId)?.selection_profile?.operation_risk).toEqual(expect.arrayContaining(risks));
    }
  });

  it('maps representative user intents to the expected tools using selection metadata', () => {
    const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'tool-selection-intents.json');
    const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Array<{
      intent: string;
      expected_tools: string[];
    }>;
    const manifest = getToolManifest() as {
      discoverability?: {
        tools?: Array<{
          id: string;
          title?: string;
          usage_hint?: string;
          examples?: string[];
          selection_profile?: SelectionProfile;
        }>;
      };
    };
    const tools = manifest.discoverability?.tools ?? [];

    let topOneMatches = 0;
    for (const fixture of fixtures) {
      const selectedTools = selectToolsForIntent(fixture.intent, tools);
      if (fixture.expected_tools.includes(selectedTools[0] ?? '')) {
        topOneMatches += 1;
      }
      expect(selectedTools).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^(${fixture.expected_tools.join('|')})$`))]));
    }

    expect(topOneMatches / fixtures.length).toBeGreaterThanOrEqual(0.85);
  });
});
