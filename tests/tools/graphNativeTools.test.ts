import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  findCallersTool,
  handleFindCallers,
} from '../../src/mcp/tools/findCallers.js';
import {
  findCalleesTool,
  handleFindCallees,
} from '../../src/mcp/tools/findCallees.js';
import {
  traceSymbolTool,
  handleTraceSymbol,
} from '../../src/mcp/tools/traceSymbol.js';
import {
  impactAnalysisTool,
  handleImpactAnalysis,
} from '../../src/mcp/tools/impactAnalysis.js';

describe('graph-native MCP tools', () => {
  let mockServiceClient: {
    callRelationships: ReturnType<typeof jest.fn>;
    symbolDefinition: ReturnType<typeof jest.fn>;
    symbolReferencesSearch: ReturnType<typeof jest.fn>;
    getLastSymbolNavigationDiagnostics: ReturnType<typeof jest.fn>;
  };

  beforeEach(() => {
    let lastDiagnostics: unknown = null;
    mockServiceClient = {
      callRelationships: jest.fn(async (_symbol: string, options?: { direction?: 'callers' | 'callees' | 'both' }) => {
        if (options?.direction === 'callers') {
          lastDiagnostics = {
            backend: 'graph',
            graph_status: 'ready',
            graph_degraded_reason: null,
            fallback_reason: null,
          };
          return {
            symbol: 'targetSymbol',
            callers: [
              {
                file: 'src/caller.ts',
                line: 12,
                snippet: 'targetSymbol();',
                score: 98,
                callerSymbol: 'runCaller',
              },
            ],
            callees: [],
            metadata: {
              symbol: 'targetSymbol',
              direction: 'callers',
              totalCallers: 1,
              totalCallees: 0,
              resolutionBackend: 'graph',
              fallbackReason: null,
              graphStatus: 'ready',
              graphDegradedReason: null,
            },
          };
        }

        if (options?.direction === 'callees') {
          lastDiagnostics = {
            backend: 'heuristic_fallback',
            graph_status: 'degraded',
            graph_degraded_reason: 'graph_partial',
            fallback_reason: 'graph_call_edge_not_found',
          };
          return {
            symbol: 'targetSymbol',
            callers: [],
            callees: [
              {
                file: 'src/callee.ts',
                line: 4,
                snippet: 'childCall();',
                score: 77,
                calleeSymbol: 'childCall',
              },
            ],
            metadata: {
              symbol: 'targetSymbol',
              direction: 'callees',
              totalCallers: 0,
              totalCallees: 1,
              resolutionBackend: 'heuristic_fallback',
              fallbackReason: 'graph_call_edge_not_found',
              graphStatus: 'degraded',
              graphDegradedReason: 'graph_partial',
            },
          };
        }

        lastDiagnostics = {
          backend: 'graph',
          graph_status: 'ready',
          graph_degraded_reason: null,
          fallback_reason: null,
        };
        return {
          symbol: 'targetSymbol',
          callers: [
            {
              file: 'src/caller.ts',
              line: 12,
              snippet: 'targetSymbol();',
              score: 98,
              callerSymbol: 'runCaller',
            },
          ],
          callees: [
            {
              file: 'src/callee.ts',
              line: 4,
              snippet: 'childCall();',
              score: 77,
              calleeSymbol: 'childCall',
            },
          ],
          metadata: {
            symbol: 'targetSymbol',
            direction: 'both',
            totalCallers: 1,
            totalCallees: 1,
            resolutionBackend: 'graph',
            fallbackReason: null,
            graphStatus: 'ready',
            graphDegradedReason: null,
          },
        };
      }),
      symbolDefinition: jest.fn(async () => {
        lastDiagnostics = {
          backend: 'graph',
          graph_status: 'ready',
          graph_degraded_reason: null,
          fallback_reason: null,
        };
        return {
          found: true,
          symbol: 'targetSymbol',
          file: 'src/target.ts',
          line: 8,
          kind: 'function',
          snippet: 'export function targetSymbol() {}',
          score: 180,
        };
      }),
      symbolReferencesSearch: jest.fn(async () => {
        lastDiagnostics = {
          backend: 'graph',
          graph_status: 'ready',
          graph_degraded_reason: null,
          fallback_reason: null,
        };
        return [
          {
            path: 'src/caller.ts',
            content: 'targetSymbol();',
            lines: '12-12',
            relevanceScore: 1,
          },
          {
            path: 'tests/target.test.ts',
            content: 'expect(targetSymbol).toBeDefined();',
            lines: '3-3',
            relevanceScore: 0.6,
          },
        ];
      }),
      getLastSymbolNavigationDiagnostics: jest.fn(() => lastDiagnostics),
    };
  });

  it('returns direct callers with explicit graph receipts', async () => {
    const parsed = JSON.parse(await handleFindCallers({ symbol: ' targetSymbol ' }, mockServiceClient as any));

    expect(parsed).toEqual({
      symbol: 'targetSymbol',
      callers: [
        expect.objectContaining({
          file: 'src/caller.ts',
          callerSymbol: 'runCaller',
        }),
      ],
      metadata: expect.objectContaining({
        graph_backed: true,
        degraded: false,
        analysis_scope: 'direct_callers_only',
        diagnostics: expect.objectContaining({
          backend: 'graph',
          graph_status: 'ready',
        }),
      }),
    });
  });

  it('returns explicit degraded receipts for direct callees fallback mode', async () => {
    const parsed = JSON.parse(await handleFindCallees({ symbol: 'targetSymbol', top_k: 5 }, mockServiceClient as any));

    expect(parsed).toEqual({
      symbol: 'targetSymbol',
      callees: [
        expect.objectContaining({
          file: 'src/callee.ts',
          calleeSymbol: 'childCall',
        }),
      ],
      metadata: expect.objectContaining({
        graph_backed: false,
        degraded: true,
        degraded_reasons: expect.arrayContaining(['graph_call_edge_not_found', 'graph_partial']),
        analysis_scope: 'direct_callees_only',
      }),
    });
  });

  it('traces a symbol across definition, references, callers, and callees', async () => {
    const parsed = JSON.parse(await handleTraceSymbol({ symbol: 'targetSymbol', top_k: 7 }, mockServiceClient as any));

    expect(parsed.trace_summary).toEqual({
      definition_found: true,
      reference_count: 2,
      caller_count: 1,
      callee_count: 1,
      touched_files: ['src/callee.ts', 'src/caller.ts', 'src/target.ts', 'tests/target.test.ts'],
    });
    expect(parsed.metadata).toEqual(expect.objectContaining({
      graph_backed_operations: 3,
      heuristic_operations: 0,
      degraded: false,
      analysis_scope: 'direct_definition_references_and_call_edges_only',
    }));
  });

  it('computes a bounded direct impact summary with deterministic risk receipts', async () => {
    const parsed = JSON.parse(await handleImpactAnalysis({ symbol: 'targetSymbol' }, mockServiceClient as any));

    expect(parsed.impact_summary).toEqual(expect.objectContaining({
      direct_reference_count: 2,
      direct_caller_count: 1,
      direct_callee_count: 1,
      impacted_file_count: 4,
      risk_level: 'low',
    }));
    expect(parsed.metadata).toEqual(expect.objectContaining({
      transitive: false,
      deterministic: true,
      degraded: false,
    }));
  });

  it('validates required symbol input', async () => {
    await expect(handleFindCallers({ symbol: '   ' }, mockServiceClient as any))
      .rejects.toThrow(/symbol/i);
    await expect(handleTraceSymbol({ symbol: '' }, mockServiceClient as any))
      .rejects.toThrow(/symbol/i);
  });

  it('exports stable additive tool schemas', () => {
    expect([
      findCallersTool,
      findCalleesTool,
      traceSymbolTool,
      impactAnalysisTool,
    ]).toMatchInlineSnapshot(`
[
  {
    "description": "Return deterministic callers of a known function or method symbol.

This tool prefers persisted graph call edges and falls back explicitly when graph
coverage is unavailable or incomplete.

Use when you want call sites for one symbol without the broader combined output
of call_relationships.",
    "inputSchema": {
      "properties": {
        "bypass_cache": {
          "description": "When true, bypass caches for this call.",
          "type": "boolean",
        },
        "exclude_paths": {
          "description": "Optional workspace-relative glob filters to exclude matching paths after include filtering.",
          "items": {
            "type": "string",
          },
          "type": "array",
        },
        "include_paths": {
          "description": "Optional workspace-relative glob filters to include matching paths only.",
          "items": {
            "type": "string",
          },
          "type": "array",
        },
        "language_hint": {
          "description": "Optional language hint (currently advisory).",
          "type": "string",
        },
        "symbol": {
          "description": "Function or method identifier whose callers you want to inspect.",
          "type": "string",
        },
        "top_k": {
          "description": "Maximum callers to return (1-100). Defaults to 20.",
          "maximum": 100,
          "minimum": 1,
          "type": "integer",
        },
        "workspacePath": {
          "description": "Optional workspace path hint. Present for parity with other navigation tools.",
          "type": "string",
        },
      },
      "required": [
        "symbol",
      ],
      "type": "object",
    },
    "name": "find_callers",
  },
  {
    "description": "Return deterministic callees of a known function or method symbol.

This tool prefers persisted graph call edges and reports explicit degraded-mode
receipts when it had to fall back to heuristic extraction.",
    "inputSchema": {
      "properties": {
        "bypass_cache": {
          "description": "When true, bypass caches for this call.",
          "type": "boolean",
        },
        "exclude_paths": {
          "description": "Optional workspace-relative glob filters to exclude matching paths after include filtering.",
          "items": {
            "type": "string",
          },
          "type": "array",
        },
        "include_paths": {
          "description": "Optional workspace-relative glob filters to include matching paths only.",
          "items": {
            "type": "string",
          },
          "type": "array",
        },
        "language_hint": {
          "description": "Optional language hint (currently advisory).",
          "type": "string",
        },
        "symbol": {
          "description": "Function or method identifier whose outgoing calls you want to inspect.",
          "type": "string",
        },
        "top_k": {
          "description": "Maximum callees to return (1-100). Defaults to 20.",
          "maximum": 100,
          "minimum": 1,
          "type": "integer",
        },
        "workspacePath": {
          "description": "Optional workspace path hint. Present for parity with other navigation tools.",
          "type": "string",
        },
      },
      "required": [
        "symbol",
      ],
      "type": "object",
    },
    "name": "find_callees",
  },
  {
    "description": "Trace a known symbol across its canonical definition, non-declaration
references, and direct call edges.

This tool composes the graph-backed symbol navigation surfaces into one
deterministic response and makes degraded-mode behavior explicit per stage.",
    "inputSchema": {
      "properties": {
        "bypass_cache": {
          "description": "When true, bypass caches for this call.",
          "type": "boolean",
        },
        "exclude_paths": {
          "description": "Optional workspace-relative glob filters to exclude matching paths after include filtering.",
          "items": {
            "type": "string",
          },
          "type": "array",
        },
        "include_paths": {
          "description": "Optional workspace-relative glob filters to include matching paths only.",
          "items": {
            "type": "string",
          },
          "type": "array",
        },
        "language_hint": {
          "description": "Optional language hint (currently advisory).",
          "type": "string",
        },
        "symbol": {
          "description": "Identifier to trace across definition, references, callers, and callees.",
          "type": "string",
        },
        "top_k": {
          "description": "Maximum references/callers/callees to include per section (1-100). Defaults to 20.",
          "maximum": 100,
          "minimum": 1,
          "type": "integer",
        },
        "workspacePath": {
          "description": "Optional workspace path hint. Present for parity with other navigation tools.",
          "type": "string",
        },
      },
      "required": [
        "symbol",
      ],
      "type": "object",
    },
    "name": "trace_symbol",
  },
  {
    "description": "Estimate the direct change surface of a known symbol using graph-backed
definition, reference, and call-edge data.

This v1 analysis is intentionally bounded to direct references and call edges so
degraded-mode behavior stays explicit and deterministic.",
    "inputSchema": {
      "properties": {
        "bypass_cache": {
          "description": "When true, bypass caches for this call.",
          "type": "boolean",
        },
        "exclude_paths": {
          "description": "Optional workspace-relative glob filters to exclude matching paths after include filtering.",
          "items": {
            "type": "string",
          },
          "type": "array",
        },
        "include_paths": {
          "description": "Optional workspace-relative glob filters to include matching paths only.",
          "items": {
            "type": "string",
          },
          "type": "array",
        },
        "language_hint": {
          "description": "Optional language hint (currently advisory).",
          "type": "string",
        },
        "symbol": {
          "description": "Identifier whose direct impact surface you want to estimate.",
          "type": "string",
        },
        "top_k": {
          "description": "Maximum references/callers/callees to include per section (1-100). Defaults to 25.",
          "maximum": 100,
          "minimum": 1,
          "type": "integer",
        },
        "workspacePath": {
          "description": "Optional workspace path hint. Present for parity with other navigation tools.",
          "type": "string",
        },
      },
      "required": [
        "symbol",
      ],
      "type": "object",
    },
    "name": "impact_analysis",
  },
]
`);
  });
});
