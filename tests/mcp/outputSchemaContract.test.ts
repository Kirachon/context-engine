import { describe, expect, it } from '@jest/globals';

import { buildToolRegistryEntries } from '../../src/mcp/server.js';
import { IndexStatus } from '../../src/mcp/serviceClient.js';
import {
  callRelationshipsOutputSchema,
  codebaseRetrievalOutputSchema,
  findCallersOutputSchema,
  findCalleesOutputSchema,
  getContextForPromptOutputSchema,
  impactAnalysisOutputSchema,
  indexStatusOutputSchema,
  semanticSearchOutputSchema,
  symbolDefinitionOutputSchema,
  symbolReferencesOutputSchema,
  symbolSearchOutputSchema,
  toolManifestOutputSchema,
  traceSymbolOutputSchema,
  whyThisContextOutputSchema,
} from '../../src/mcp/schemas/convertedToolOutputSchemas.js';
import { handleFindCallers } from '../../src/mcp/tools/findCallers.js';
import { handleFindCallees } from '../../src/mcp/tools/findCallees.js';
import { handleTraceSymbol } from '../../src/mcp/tools/traceSymbol.js';
import { handleImpactAnalysis } from '../../src/mcp/tools/impactAnalysis.js';
import { handleCodebaseRetrieval } from '../../src/mcp/tools/codebaseRetrieval.js';
import { handleGetContext } from '../../src/mcp/tools/context.js';
import {
  handleCallRelationships,
  handleSemanticSearch,
  handleSymbolDefinition,
  handleSymbolReferencesSearch,
  handleSymbolSearch,
} from '../../src/mcp/tools/search.js';
import { handleIndexStatus } from '../../src/mcp/tools/status.js';
import { getToolManifest, handleToolManifest } from '../../src/mcp/tools/manifest.js';
import {
  CONVERTED_TOOL_OUTPUT_SCHEMAS,
  isConvertedToolWithOutputSchema,
  listConvertedToolsWithOutputSchema,
  validateStructuredContent,
} from '../../src/mcp/utils/outputSchemaContract.js';
import { validateAgainstJsonSchema } from '../../src/mcp/utils/jsonSchemaValidator.js';
import type { JsonSchema } from '../../src/mcp/types/outputSchema.js';

const EXPECTED_CONVERTED_TOOLS = [
  'call_relationships',
  'codebase_retrieval',
  'find_callees',
  'find_callers',
  'get_context_for_prompt',
  'impact_analysis',
  'index_status',
  'semantic_search',
  'symbol_definition',
  'symbol_references',
  'symbol_search',
  'tool_manifest',
  'trace_symbol',
  'why_this_context',
];

describe('output schema contract utilities', () => {
  it('registers only converted tools with output schemas', () => {
    expect(listConvertedToolsWithOutputSchema()).toEqual(EXPECTED_CONVERTED_TOOLS);
    expect(CONVERTED_TOOL_OUTPUT_SCHEMAS).toEqual({
      call_relationships: callRelationshipsOutputSchema,
      codebase_retrieval: codebaseRetrievalOutputSchema,
      find_callees: findCalleesOutputSchema,
      find_callers: findCallersOutputSchema,
      get_context_for_prompt: getContextForPromptOutputSchema,
      impact_analysis: impactAnalysisOutputSchema,
      index_status: indexStatusOutputSchema,
      semantic_search: semanticSearchOutputSchema,
      symbol_definition: symbolDefinitionOutputSchema,
      symbol_references: symbolReferencesOutputSchema,
      symbol_search: symbolSearchOutputSchema,
      tool_manifest: toolManifestOutputSchema,
      trace_symbol: traceSymbolOutputSchema,
      why_this_context: whyThisContextOutputSchema,
    });
    expect(isConvertedToolWithOutputSchema('index_status')).toBe(true);
    expect(isConvertedToolWithOutputSchema('symbol_search')).toBe(true);
    expect(isConvertedToolWithOutputSchema('semantic_search')).toBe(true);
    expect(isConvertedToolWithOutputSchema('codebase_retrieval')).toBe(true);
    expect(isConvertedToolWithOutputSchema('get_context_for_prompt')).toBe(true);
    expect(isConvertedToolWithOutputSchema('enhance_prompt')).toBe(false);
  });

  it('validates representative JSON schema cases with the lightweight validator', () => {
    const schema: JsonSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['count', 'label'],
      properties: {
        count: { type: 'integer', minimum: 0 },
        label: { type: 'string', enum: ['alpha', 'beta'] },
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    };

    expect(validateAgainstJsonSchema({ count: 1, label: 'alpha', tags: ['x'] }, schema).valid).toBe(true);
    expect(validateAgainstJsonSchema({ count: -1, label: 'alpha' }, schema).valid).toBe(false);
    expect(validateAgainstJsonSchema({ count: 1, label: 'gamma' }, schema).valid).toBe(false);
    expect(validateAgainstJsonSchema({ count: 1, label: 'alpha', extra: true }, schema).valid).toBe(false);
  });

  it('advertises outputSchema only for converted tools in runtime registration', () => {
    const entries = buildToolRegistryEntries({} as any);
    const toolsByName = new Map(entries.map((entry) => [entry.tool.name, entry.tool]));

    for (const toolName of listConvertedToolsWithOutputSchema()) {
      const tool = toolsByName.get(toolName) as { outputSchema?: unknown } | undefined;
      expect(tool?.outputSchema).toEqual(CONVERTED_TOOL_OUTPUT_SCHEMAS[toolName]);
    }

    const unconvertedSamples = ['enhance_prompt', 'create_plan', 'get_file'];
    for (const toolName of unconvertedSamples) {
      const tool = toolsByName.get(toolName) as { outputSchema?: unknown } | undefined;
      expect(tool?.outputSchema).toBeUndefined();
    }
  });

  it('validates index_status structuredContent emitted by the handler', async () => {
    const status: IndexStatus = {
      workspace: '/tmp/workspace',
      status: 'idle',
      lastIndexed: '2025-01-11T00:00:00.000Z',
      fileCount: 42,
      isStale: false,
      embeddingRuntime: {
        state: 'degraded',
        configured: {
          id: 'transformers:Xenova/all-MiniLM-L6-v2',
          modelId: 'Xenova/all-MiniLM-L6-v2',
          vectorDimension: 384,
        },
        active: {
          id: 'hash-32',
          modelId: 'hash-32',
          vectorDimension: 32,
        },
        fallback: {
          id: 'hash-32',
          modelId: 'hash-32',
          vectorDimension: 32,
        },
        loadFailures: 2,
        lastFailure: 'model unavailable',
        nextRetryAt: '2025-01-11T00:01:00.000Z',
        hashFallbackActive: true,
        downgrade: {
          reason: 'active runtime "hash-32" differs from configured "transformers:Xenova/all-MiniLM-L6-v2"',
          since: null,
        },
      },
    };

    const mockServiceClient = {
      getIndexStatus: () => status,
    };

    const result = await handleIndexStatus({}, mockServiceClient as any);
    const validation = validateStructuredContent('index_status', result.structuredContent);

    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it('validates tool_manifest structuredContent emitted by the handler', async () => {
    const result = await handleToolManifest({}, {} as any);
    const validation = validateStructuredContent('tool_manifest', result.structuredContent);

    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(result.structuredContent).toEqual(getToolManifest());
  });

  it('validates symbol navigation structuredContent emitted by handlers', async () => {
    const mockServiceClient = {
      symbolSearch: async () => [
        {
          path: 'src/auth/provider.ts',
          content: 'export function resolveAIProviderId() {}',
          relevanceScore: 0.97,
          lines: '1-1',
        },
      ],
      symbolReferencesSearch: async () => [
        {
          path: 'src/caller.ts',
          content: 'resolveAIProviderId();',
          relevanceScore: 0.95,
          lines: '2-2',
        },
      ],
      symbolDefinition: async () => ({
        found: true,
        symbol: 'resolveAIProviderId',
        file: 'src/providers.ts',
        line: 12,
        kind: 'function',
        snippet: 'export function resolveAIProviderId() {}',
        score: 195,
        metadata: {
          backend: 'graph',
          graph_status: 'ready',
          graph_degraded_reason: null,
          fallback_reason: null,
        },
      }),
      callRelationships: async () => ({
        symbol: 'resolveAIProviderId',
        callers: [
          {
            file: 'src/handler.ts',
            line: 42,
            snippet: 'resolveAIProviderId();',
            score: 80,
            callerSymbol: 'handle',
          },
        ],
        callees: [
          {
            calleeSymbol: 'lookup',
            file: 'src/providers.ts',
            line: 14,
            snippet: 'lookup();',
            score: 10,
          },
        ],
        metadata: {
          symbol: 'resolveAIProviderId',
          direction: 'both',
          totalCallers: 1,
          totalCallees: 1,
          resolutionBackend: 'graph',
          fallbackReason: null,
          graphStatus: 'ready',
          graphDegradedReason: null,
        },
      }),
      getLastSymbolNavigationDiagnostics: () => ({
        backend: 'graph',
        graph_status: 'ready',
        graph_degraded_reason: null,
        fallback_reason: null,
      }),
      getIndexStatus: () => ({
        workspace: '/tmp/workspace',
        status: 'idle',
        lastIndexed: '2025-01-01T00:00:00.000Z',
        fileCount: 10,
        isStale: false,
      }),
    };

    const symbolSearchResult = await handleSymbolSearch({ symbol: 'resolveAIProviderId' }, mockServiceClient as any);
    expect(validateStructuredContent('symbol_search', symbolSearchResult.structuredContent).valid).toBe(true);

    const symbolReferencesResult = await handleSymbolReferencesSearch(
      { symbol: 'resolveAIProviderId' },
      mockServiceClient as any
    );
    expect(validateStructuredContent('symbol_references', symbolReferencesResult.structuredContent).valid).toBe(true);

    const symbolDefinitionResult = await handleSymbolDefinition(
      { symbol: 'resolveAIProviderId' },
      mockServiceClient as any
    );
    expect(validateStructuredContent('symbol_definition', symbolDefinitionResult.structuredContent).valid).toBe(true);

    const callRelationshipsResult = await handleCallRelationships(
      { symbol: 'resolveAIProviderId' },
      mockServiceClient as any
    );
    expect(validateStructuredContent('call_relationships', callRelationshipsResult.structuredContent).valid).toBe(true);

    const findCallersResult = await handleFindCallers({ symbol: 'resolveAIProviderId' }, mockServiceClient as any);
    expect(validateStructuredContent('find_callers', findCallersResult.structuredContent).valid).toBe(true);

    const findCalleesResult = await handleFindCallees({ symbol: 'resolveAIProviderId' }, mockServiceClient as any);
    expect(validateStructuredContent('find_callees', findCalleesResult.structuredContent).valid).toBe(true);

    const traceSymbolResult = await handleTraceSymbol({ symbol: 'resolveAIProviderId' }, mockServiceClient as any);
    expect(validateStructuredContent('trace_symbol', traceSymbolResult.structuredContent).valid).toBe(true);

    const impactAnalysisResult = await handleImpactAnalysis({ symbol: 'resolveAIProviderId' }, mockServiceClient as any);
    expect(validateStructuredContent('impact_analysis', impactAnalysisResult.structuredContent).valid).toBe(true);
  });

  it('validates retrieval tool structuredContent emitted by handlers', async () => {
    const mockServiceClient = {
      semanticSearch: async () => [
        {
          path: 'src/auth/login.ts',
          content: 'export function login() {}',
          relevanceScore: 0.91,
          lines: '1-3',
          matchType: 'semantic',
        },
      ],
      getContextForPrompt: async () => ({
        summary: 'Auth context summary.',
        query: 'login flow',
        files: [
          {
            path: 'src/auth/login.ts',
            extension: '.ts',
            summary: 'Login handler.',
            relevance: 0.9,
            tokenCount: 120,
            snippets: [
              {
                text: 'export function login() {}',
                lines: '1-3',
                relevance: 0.9,
                tokenCount: 20,
              },
            ],
          },
        ],
        hints: ['Check session middleware.'],
        metadata: {
          totalFiles: 1,
          totalSnippets: 1,
          totalTokens: 120,
          tokenBudget: 8000,
          truncated: false,
          searchTimeMs: 12,
        },
      }),
      getLastSearchDiagnostics: () => null,
      getActiveRetrievalProviderId: () => 'hybrid',
      getIndexStatus: () => ({
        workspace: '/tmp/workspace',
        status: 'idle',
        lastIndexed: '2025-01-01T00:00:00.000Z',
        fileCount: 10,
        isStale: false,
      }),
    };

    const codebaseRetrievalResult = await handleCodebaseRetrieval(
      { query: 'login flow' },
      mockServiceClient as any
    );
    expect(validateStructuredContent('codebase_retrieval', codebaseRetrievalResult.structuredContent).valid).toBe(true);

    const semanticSearchResult = await handleSemanticSearch(
      { query: 'login flow' },
      mockServiceClient as any
    );
    expect(validateStructuredContent('semantic_search', semanticSearchResult.structuredContent).valid).toBe(true);

    const getContextResult = await handleGetContext(
      { query: 'login flow' },
      mockServiceClient as any
    );
    expect(validateStructuredContent('get_context_for_prompt', getContextResult.structuredContent).valid).toBe(true);
  });

  it('rejects structuredContent that violates a converted tool schema', () => {
    const validation = validateStructuredContent('index_status', {
      schema_version: 2,
      status: {},
      freshness: {},
      guidance: [],
      embeddingRuntime: null,
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });
});
