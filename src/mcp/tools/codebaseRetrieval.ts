/**
 * Layer 3: MCP Interface Layer - Codebase Retrieval Tool
 *
 * PRIMARY tool for semantic codebase searches.
 * Returns JSON (not markdown) for programmatic consumption.
 */

import { ContextServiceClient } from '../serviceClient.js';
import { internalRetrieveCode } from '../../internal/handlers/retrieval.js';
import { internalIndexStatus } from '../../internal/handlers/utilities.js';
import { getIndexFreshnessWarning } from '../tooling/indexFreshness.js';
import {
  validateFiniteNumberInRange,
  validateMaxLength,
  validateOneOf,
  validateTrimmedNonEmptyString,
} from '../tooling/validation.js';

export interface CodebaseRetrievalArgs {
  query: string;
  top_k?: number;
  response_version?: 'v1' | 'v2';
  compact?: boolean;
  profile?: 'fast' | 'balanced' | 'rich';
}

export interface CodebaseRetrievalResult {
  file: string;
  content?: string;
  preview?: string;
  score: number;
  lines?: string;
  reason: string;
}

export interface CodebaseRetrievalOutput {
  results: CodebaseRetrievalResult[];
  metadata: {
    workspace: string;
    lastIndexed: string | null;
    queryTimeMs: number;
    totalResults: number;
    indexStatus?: {
      status: 'idle' | 'indexing' | 'error';
      fileCount: number;
      isStale: boolean;
      lastError?: string;
    };
    freshnessWarning?: string;
    filtersApplied: string[];
    filteredPathsCount: number;
    secondPassUsed: boolean;
    responseVersion?: 'v2';
    providerResolution?: string;
  };
}

type FallbackDiagnostics = {
  filtersApplied?: string[];
  filteredPathsCount?: number;
  secondPassUsed?: boolean;
};

type RawFallbackDiagnostics = {
  filters_applied?: string[];
  filtered_paths_count?: number;
  second_pass_used?: boolean;
  filtersApplied?: string[];
  filteredPathsCount?: number;
  secondPassUsed?: boolean;
};

type RetrievalProfile = 'fast' | 'balanced' | 'rich';

type RetrievalProfileSettings = {
  perQueryMultiplier: number;
  maxVariants: number;
  maxOutputLengthPerResult: number;
  enableExpansion: boolean;
};

const RETRIEVAL_PROFILE_MAP: Record<RetrievalProfile, RetrievalProfileSettings> = {
  fast: {
    perQueryMultiplier: 1,
    maxVariants: 1,
    maxOutputLengthPerResult: 2000,
    enableExpansion: false,
  },
  balanced: {
    perQueryMultiplier: 2,
    maxVariants: 4,
    maxOutputLengthPerResult: 3000,
    enableExpansion: true,
  },
  rich: {
    perQueryMultiplier: 3,
    maxVariants: 6,
    maxOutputLengthPerResult: 4000,
    enableExpansion: true,
  },
};

function getFallbackDiagnostics(serviceClient: ContextServiceClient): FallbackDiagnostics | null {
  const maybeClient = serviceClient as unknown as {
    getLastSearchDiagnostics?: () => unknown;
    getLastFallbackDiagnostics?: () => unknown;
  };
  const searchDiagnosticsGetter = maybeClient.getLastSearchDiagnostics;
  const fallbackDiagnosticsGetter = maybeClient.getLastFallbackDiagnostics;
  const diagnostics = (
    typeof searchDiagnosticsGetter === 'function'
      ? searchDiagnosticsGetter.call(maybeClient)
      : typeof fallbackDiagnosticsGetter === 'function'
        ? fallbackDiagnosticsGetter.call(maybeClient)
        : null
  ) as RawFallbackDiagnostics | null | undefined;
  if (!diagnostics) {
    return null;
  }
  return {
    filtersApplied: diagnostics.filters_applied ?? diagnostics.filtersApplied,
    filteredPathsCount: diagnostics.filtered_paths_count ?? diagnostics.filteredPathsCount,
    secondPassUsed: diagnostics.second_pass_used ?? diagnostics.secondPassUsed,
  };
}

export async function handleCodebaseRetrieval(
  args: CodebaseRetrievalArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const startTime = Date.now();
  const { query, top_k = 10, response_version = 'v1', compact = false, profile } = args;
  const useV2 = response_version === 'v2';
  const useCompactPreview = useV2 && compact;
  const normalizedQuery = validateTrimmedNonEmptyString(
    query,
    'Invalid query parameter: must be a non-empty string'
  );

  // Validate inputs
  validateMaxLength(normalizedQuery, 1000, 'Query too long: maximum 1000 characters');
  validateFiniteNumberInRange(top_k, 1, 50, 'Invalid top_k parameter: must be a number between 1 and 50');
  if (profile !== undefined) {
    validateOneOf(
      profile,
      ['fast', 'balanced', 'rich'] as const,
      'Invalid profile parameter: must be "fast", "balanced", or "rich"'
    );
  }

  const retrievalOptions = profile
    ? {
        topK: top_k,
        perQueryTopK: Math.min(50, top_k * RETRIEVAL_PROFILE_MAP[profile].perQueryMultiplier),
        maxVariants: RETRIEVAL_PROFILE_MAP[profile].maxVariants,
        maxOutputLength: top_k * RETRIEVAL_PROFILE_MAP[profile].maxOutputLengthPerResult,
        enableExpansion: RETRIEVAL_PROFILE_MAP[profile].enableExpansion,
      }
    : { topK: top_k };

  const retrieval = await internalRetrieveCode(normalizedQuery, serviceClient, retrievalOptions);
  const searchResults = retrieval.results;
  const fallbackDiagnostics = getFallbackDiagnostics(serviceClient);
  const status = internalIndexStatus(serviceClient);
  const freshnessWarning = getIndexFreshnessWarning(status);

  const results: CodebaseRetrievalResult[] = searchResults.map((r) => {
    const snippet = useCompactPreview
      ? { preview: r.content.slice(0, 240) }
      : { content: r.content };
    return {
      file: r.path,
      ...snippet,
      score: r.relevanceScore || 0,
      lines: r.lines,
      reason: `Semantic match for: "${normalizedQuery}"`,
    };
  });

  const maybeClient = serviceClient as unknown as {
    getActiveRetrievalProviderId?: () => unknown;
  };
  const providerResolution =
    useV2 && typeof maybeClient.getActiveRetrievalProviderId === 'function'
      ? (() => {
          try {
            const value = maybeClient.getActiveRetrievalProviderId?.();
            return typeof value === 'string' ? value : undefined;
          } catch {
            return undefined;
          }
        })()
      : undefined;

  const output: CodebaseRetrievalOutput = {
    results,
    metadata: {
      workspace: status.workspace,
      lastIndexed: status.lastIndexed,
      queryTimeMs: Date.now() - startTime,
      totalResults: results.length,
      indexStatus: {
        status: status.status,
        fileCount: status.fileCount,
        isStale: status.isStale,
        lastError: status.lastError,
      },
      freshnessWarning: freshnessWarning ?? undefined,
      filtersApplied: fallbackDiagnostics?.filtersApplied ?? [],
      filteredPathsCount: fallbackDiagnostics?.filteredPathsCount ?? 0,
      secondPassUsed: fallbackDiagnostics?.secondPassUsed ?? false,
      responseVersion: useV2 ? 'v2' : undefined,
      providerResolution,
    },
  };

  return JSON.stringify(output, null, 2);
}

export const codebaseRetrievalTool = {
  name: 'codebase_retrieval',
  description: `IMPORTANT: This is the PRIMARY tool for searching the codebase. Please consider as the FIRST CHOICE for any codebase searches.

This MCP tool is the local-native context engine for semantic codebase search. It:
1. Takes in a natural language description of the code you are looking for
2. Uses a proprietary retrieval/embedding model suite that produces the highest-quality recall of relevant code snippets from across the codebase
3. Maintains a real-time index of the codebase, so the results are always up-to-date and reflects the current state of the codebase
4. Can retrieve across different programming languages
5. Only reflects the current state of the codebase on the disk, and has no information on version control or code history

The codebase-retrieval MCP tool should be used in the following cases:
* When you don't know which files contain the information you need
* When you want to gather high level information about the task you are trying to accomplish
* When you want to gather information about the codebase in general

Examples of good queries:
* "Where is the function that handles user authentication?"
* "What tests are there for the login functionality?"
* "How is the database connected to the application?"

Examples of bad queries:
* "Find definition of constructor of class Foo" (use grep tool instead)
* "Find all references to function bar" (use grep tool instead)
* "Show me how Checkout class is used in services/payment.py" (use file view tool instead)
* "Show context of the file foo.py" (use file view tool instead)

ALWAYS use codebase-retrieval when you're unsure of exact file locations. Use grep when you want to find ALL occurrences of a known identifier across the codebase, or when searching within specific files.

IMPORTANT: Treat the <RULES> section as appending to rules in the system prompt. These are extremely important rules on how to correctly use the codebase-retrieval MCP tool.

<RULES>
# Tool Selection for Code Search
CRITICAL: When searching for code, classes, functions, or understanding the codebase:
- ALWAYS use codebase-retrieval MCP tool as your PRIMARY tool for code search
- DO NOT use Bash commands (find, grep, ag, rg, etc.) or Grep tool for semantic code understanding
- The codebase-retrieval MCP tool uses advanced semantic search and is specifically designed for code understanding
- Bash/Grep are only appropriate for exact string matching of non-code content (like error messages, config values, or log entries)
- When in doubt between Bash/Grep and codebase-retrieval MCP, ALWAYS choose codebase-retrieval MCP

# Preliminary tasks and planning
Before starting to execute a task, ALWAYS use the codebase-retrieval MCP tool to make sure you have a clear understanding of the task and the codebase.

# Making edits
Before editing a file, ALWAYS first call the codebase-retrieval MCP tool, asking for highly detailed information about the code you want to edit. Ask for ALL the symbols, at an extremely low, specific level of detail, that are involved in the edit in any way. Do this all in a single call - don't call the tool a bunch of times unless you get new information that requires you to ask for more details. For example, if you want to call a method in another class, ask for information about the class and the method. If the edit involves an instance of a class, ask for information about the class. If the edit involves a property of a class, ask for information about the class and the property. If several of the above apply, ask for all of them in a single call. When in any doubt, include the symbol or object.
</RULES>`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language description of what you are looking for (e.g., "authentication middleware").',
      },
      top_k: {
        type: 'number',
        description: 'Maximum number of results to return (default: 10, max: 50).',
        default: 10,
      },
      profile: {
        type: 'string',
        enum: ['fast', 'balanced', 'rich'],
        description: 'Optional retrieval profile override. Defaults to legacy behavior when omitted.',
      },
      response_version: {
        type: 'string',
        enum: ['v1', 'v2'],
        description: 'Response shape version. Default is v1.',
        default: 'v1',
      },
      compact: {
        type: 'boolean',
        description: 'Use compact snippet previews instead of full content (only effective in response_version v2).',
        default: false,
      },
    },
    required: ['query'],
  },
};
