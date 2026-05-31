/**
 * MCP tool definitions for search and symbol navigation tools.
 */

import {
  callRelationshipsOutputSchema,
  semanticSearchOutputSchema,
  symbolDefinitionOutputSchema,
  symbolReferencesOutputSchema,
  symbolSearchOutputSchema,
} from '../schemas/convertedToolOutputSchemas.js';

export const semanticSearchTool = {
  name: 'semantic_search',
  description: `Perform semantic search across the codebase to find relevant code snippets.

Use this tool when you need to:
- Find specific functions, classes, or implementations
- Locate code that handles a particular concept
- Quickly explore what exists in the codebase

For comprehensive context with file summaries and related files, use get_context_for_prompt instead.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language description of what you\'re looking for (e.g., "user authentication", "database connection", "API error handling")',
      },
      top_k: {
        type: 'number',
        description: 'Number of results to return (default: 10, max: 50)',
        default: 10,
      },
      mode: {
        type: 'string',
        description: 'Search mode: "fast" (default) uses cached results and moderate expansion; "deep" increases expansion/budget for better recall at higher latency.',
        default: 'fast',
        enum: ['fast', 'deep'],
      },
      profile: {
        type: 'string',
        description: 'Optional retrieval profile override. "fast" is low-latency, "balanced" increases recall, "rich" maximizes recall/cost.',
        enum: ['fast', 'balanced', 'rich'],
      },
      bypass_cache: {
        type: 'boolean',
        description: 'When true, bypass caches for this call (useful for benchmarking or ensuring freshest results).',
        default: false,
      },
      timeout_ms: {
        type: 'number',
        description: 'Max time to spend on the retrieval pipeline in milliseconds. 0/undefined means no timeout.',
        default: 0,
      },
      include_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional workspace-relative glob filters to include matching paths only.',
      },
      exclude_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional workspace-relative glob filters to exclude matching paths after include filtering.',
      },
    },
    required: ['query'],
  },
  outputSchema: semanticSearchOutputSchema,
};

export const symbolSearchTool = {
  name: 'symbol_search',
  description: `Perform deterministic symbol-first search across the codebase for identifier-style navigation.

Use this tool when you need to:
- Jump to files containing a known function, class, type, or constant name
- Prefer exact/local symbol-aware ranking over broader semantic retrieval
- Narrow navigation with include_paths or exclude_paths`,
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Identifier-style query such as a function, class, interface, type, or constant name.',
      },
      top_k: {
        type: 'number',
        description: 'Number of results to return (default: 10, max: 50)',
        default: 10,
      },
      bypass_cache: {
        type: 'boolean',
        description: 'When true, bypass caches for this call.',
        default: false,
      },
      include_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional workspace-relative glob filters to include matching paths only.',
      },
      exclude_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional workspace-relative glob filters to exclude matching paths after include filtering.',
      },
    },
    required: ['symbol'],
  },
  outputSchema: symbolSearchOutputSchema,
};

export const symbolReferencesTool = {
  name: 'symbol_references',
  description: `Find non-declaration usages of a known identifier across the local codebase.

Use this tool when you need to:
- Locate call sites or consumers of a known function, class, or constant
- Exclude declaration hits from identifier-style navigation
- Narrow usage lookup with include_paths or exclude_paths`,
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Identifier whose usages you want to locate.',
      },
      top_k: {
        type: 'number',
        description: 'Number of results to return (default: 10, max: 50)',
        default: 10,
      },
      bypass_cache: {
        type: 'boolean',
        description: 'When true, bypass caches for this call.',
        default: false,
      },
      include_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional workspace-relative glob filters to include matching paths only.',
      },
      exclude_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional workspace-relative glob filters to exclude matching paths after include filtering.',
      },
    },
    required: ['symbol'],
  },
  outputSchema: symbolReferencesOutputSchema,
};

export const symbolDefinitionTool = {
  name: 'symbol_definition',
  description: `Return the single best deterministic declaration site for a known identifier.

Use this tool when you need to:
- Jump straight to the canonical declaration of a function, class, type, interface, or constant
- Get one definitive answer (file, line, kind, snippet) rather than a ranked list
- Complement symbol_search (ranked) and symbol_references (non-declaration usages)`,
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Identifier whose declaration site you want to locate.',
      },
      workspacePath: {
        type: 'string',
        description: 'Optional workspace path. Defaults to the current workspace.',
      },
      language_hint: {
        type: 'string',
        description: 'Optional language hint (currently advisory; reserved for future use).',
      },
      bypass_cache: {
        type: 'boolean',
        description: 'When true, bypass caches for this call.',
        default: false,
      },
      include_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional workspace-relative glob filters to include matching paths only.',
      },
      exclude_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional workspace-relative glob filters to exclude matching paths after include filtering.',
      },
    },
    required: ['symbol'],
  },
  outputSchema: symbolDefinitionOutputSchema,
};

export const callRelationshipsTool = {
  name: 'call_relationships',
  description: `Return deterministic local callers and/or callees of a known function or method symbol.

Use this tool when you need to:
- See which functions invoke a given symbol (callers) and where
- Inspect which identifiers a function invokes inside its own body (callees)
- Complement symbol_definition (single declaration site) and symbol_references (non-declaration usages)

Caller heuristic: lines containing <symbol>( that are not declaration-like; the nearest enclosing declaration is reported as callerSymbol when detectable.
Callee heuristic: locates the symbol's definition and scans the brace-delimited body for identifiers followed by '('. Brace-language only in v1; non-brace bodies (e.g., Python) yield empty callees.`,
  inputSchema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Function or method identifier whose call relationships you want to inspect.',
      },
      direction: {
        type: 'string',
        enum: ['callers', 'callees', 'both'],
        description: 'Which side of the call graph to compute. Defaults to both.',
        default: 'both',
      },
      workspacePath: {
        type: 'string',
        description: 'Optional workspace path. Defaults to the current workspace.',
      },
      top_k: {
        type: 'number',
        description: 'Maximum entries per side (1-100). Defaults to 20.',
        default: 20,
      },
      language_hint: {
        type: 'string',
        description: 'Optional language hint (currently advisory; reserved for future use).',
      },
      bypass_cache: {
        type: 'boolean',
        description: 'When true, bypass caches for this call.',
        default: false,
      },
      include_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional workspace-relative glob filters to include matching paths only.',
      },
      exclude_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional workspace-relative glob filters to exclude matching paths after include filtering.',
      },
    },
    required: ['symbol'],
  },
  outputSchema: callRelationshipsOutputSchema,
};
