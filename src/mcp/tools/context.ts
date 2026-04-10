/**
 * Layer 3: MCP Interface Layer - Context Tool
 *
 * Exposes get_context_for_prompt as an MCP tool
 * This is the primary tool for prompt enhancement
 *
 * Responsibilities:
 * - Validate input parameters
 * - Map tool calls to service layer
 * - Format enhanced context output for optimal LLM consumption
 *
 * Output Format:
 * - Hierarchical markdown structure
 * - File summaries before detailed code
 * - Relevance scores for prioritization
 * - Token-aware formatting
 * - Related file suggestions
 */

import { ContextServiceClient, ContextOptions } from '../serviceClient.js';
import { internalContextBundle } from '../../internal/handlers/context.js';
import { internalIndexStatus } from '../../internal/handlers/utilities.js';
import { featureEnabled } from '../../config/features.js';
import { getIndexFreshnessWarning } from '../tooling/indexFreshness.js';
import {
  validateBoolean,
  validateExternalSources,
  validateFiniteNumberInRange,
  validateMaxLength,
  validatePathScopeGlobs,
  validateTrimmedNonEmptyString,
} from '../tooling/validation.js';

export interface GetContextArgs {
  query: string;
  max_files?: number;
  token_budget?: number;
  include_related?: boolean;
  min_relevance?: number;
  bypass_cache?: boolean;
  include_paths?: string[];
  exclude_paths?: string[];
  external_sources?: Array<{ type: 'github_url' | 'docs_url'; url: string; label?: string }>;
}

const MAX_QUERY_LENGTH = 1000;

/**
 * Get the syntax highlighting language for a file extension
 */
function getLanguageForExtension(ext: string): string {
  const langMap: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
    '.jsx': 'jsx',
    '.py': 'python',
    '.rb': 'ruby',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.kt': 'kotlin',
    '.cs': 'csharp',
    '.cpp': 'cpp',
    '.c': 'c',
    '.h': 'c',
    '.hpp': 'cpp',
    '.swift': 'swift',
    '.php': 'php',
    '.sql': 'sql',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.md': 'markdown',
    '.html': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.vue': 'vue',
    '.svelte': 'svelte',
  };
  return langMap[ext.toLowerCase()] || '';
}

/**
 * Format relevance score as a visual indicator
 */
function formatRelevance(score: number): string {
  if (score >= 0.8) return '🔥 High';
  if (score >= 0.6) return '✅ Good';
  if (score >= 0.4) return '📊 Moderate';
  return '📌 Low';
}

export async function handleGetContext(
  args: GetContextArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const {
    query,
    max_files = 5,
    token_budget = 8000,
    include_related = true,
    min_relevance = 0.3,
    bypass_cache = false,
    include_paths,
    exclude_paths,
    external_sources,
  } = args;
  const normalizedQuery = validateTrimmedNonEmptyString(
    query,
    'Invalid query parameter: must be a non-empty string'
  );

  // Validate inputs
  validateMaxLength(normalizedQuery, MAX_QUERY_LENGTH, `Query too long: maximum ${MAX_QUERY_LENGTH} characters`);
  validateFiniteNumberInRange(max_files, 1, 20, 'Invalid max_files parameter: must be a number between 1 and 20');
  validateFiniteNumberInRange(
    token_budget,
    500,
    100000,
    'Invalid token_budget parameter: must be a number between 500 and 100000'
  );
  validateBoolean(bypass_cache, 'Invalid bypass_cache parameter: must be a boolean');
  validateBoolean(include_related, 'Invalid include_related parameter: must be a boolean');
  validateFiniteNumberInRange(
    min_relevance,
    0,
    1,
    'Invalid min_relevance parameter: must be a number between 0 and 1'
  );
  const normalizedIncludePaths = validatePathScopeGlobs(include_paths, 'include_paths');
  const normalizedExcludePaths = validatePathScopeGlobs(exclude_paths, 'exclude_paths');
  const normalizedExternalSources = validateExternalSources(external_sources, 'external_sources');

  // Build options
  const options: ContextOptions = {
    maxFiles: max_files,
    tokenBudget: token_budget,
    includeRelated: include_related,
    minRelevance: min_relevance,
    includeSummaries: true,
    bypassCache: bypass_cache,
    includePaths: normalizedIncludePaths,
    excludePaths: normalizedExcludePaths,
    externalSources: normalizedExternalSources,
  };

  const contextBundle = await internalContextBundle(normalizedQuery, serviceClient, options);
  const status = internalIndexStatus(serviceClient);
  const freshnessWarning = getIndexFreshnessWarning(status, {
    prefix: '⚠️ ',
    subject: 'Context',
  });
  const sortedFiles = [...contextBundle.files].sort((a, b) => {
    const scoreDiff = b.relevance - a.relevance;
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return a.path.localeCompare(b.path);
  });

  // Format enhanced context bundle for agent consumption
  let output = '';

  // =========================================================================
  // Header with summary and metadata
  // =========================================================================
  output += `# 📚 Codebase Context\n\n`;
  output += `**Query:** "${normalizedQuery}"\n\n`;
  if (freshnessWarning) {
    output += `${freshnessWarning}\n\n`;
  }
  output += `> ${contextBundle.summary}\n\n`;

  // Metadata section
  output += `**Stats:** ${contextBundle.metadata.totalFiles} files, `;
  output += `${contextBundle.metadata.totalSnippets} snippets, `;
  output += `~${contextBundle.metadata.totalTokens} tokens`;
  if (contextBundle.metadata.memoriesIncluded && contextBundle.metadata.memoriesIncluded > 0) {
    output += `, ${contextBundle.metadata.memoriesIncluded} memories`;
  }
  if (contextBundle.metadata.truncated) {
    output += ` (truncated to fit ${contextBundle.metadata.tokenBudget} token budget)`;
  }
  output += `\n\n`;

  // =========================================================================
  // Key Insights (hints)
  // =========================================================================
  if (contextBundle.hints.length > 0) {
    output += `## 💡 Key Insights\n\n`;
    for (const hint of contextBundle.hints) {
      output += `- ${hint}\n`;
    }
    output += '\n';
  }

  // =========================================================================
  // Memories (cross-session context)
  // =========================================================================
  if (contextBundle.memories && contextBundle.memories.length > 0) {
    output += `## 🧠 Relevant Memories\n\n`;
    output += `_Persistent context from previous sessions that may be relevant:_\n\n`;

    for (const memory of contextBundle.memories) {
      const relevanceIcon = memory.relevanceScore >= 0.7 ? '🔥' :
        memory.relevanceScore >= 0.5 ? '✅' : '📌';
      output += `### ${relevanceIcon} ${memory.category.charAt(0).toUpperCase() + memory.category.slice(1)}\n\n`;
      output += `${memory.content}\n\n`;
    }
  }

  // =========================================================================
  // File Overview (quick reference)
  // =========================================================================
  if (sortedFiles.length > 0) {
    output += `## 📁 Files Overview\n\n`;
    output += `| # | File | Relevance | Summary |\n`;
    output += `|---|------|-----------|----------|\n`;
    for (let i = 0; i < sortedFiles.length; i++) {
      const file = sortedFiles[i];
      const relevance = formatRelevance(file.relevance);
      const summary = file.summary.substring(0, 50) + (file.summary.length > 50 ? '...' : '');
      output += `| ${i + 1} | \`${file.path}\` | ${relevance} | ${summary} |\n`;
    }
    output += '\n';
  }

  if (featureEnabled('context_packs_v2') && sortedFiles.length > 0) {
    output += `## ✅ Why These Files\n\n`;
    for (const file of sortedFiles) {
      const rationale = file.selectionRationale ?? `Selected for relevance ${file.relevance.toFixed(2)}`;
      output += `- \`${file.path}\`: ${rationale}\n`;
    }
    output += '\n';
  }

  if (featureEnabled('context_packs_v2') && contextBundle.dependencyMap) {
    const edges = Object.entries(contextBundle.dependencyMap)
      .filter(([, related]) => related.length > 0);
    if (edges.length > 0) {
      output += `## 🧭 Dependency Map\n\n`;
      for (const [filePath, related] of edges) {
        output += `- \`${filePath}\` -> ${related.map((item) => `\`${item}\``).join(', ')}\n`;
      }
      output += '\n';
    }
  }

  if ((contextBundle.externalReferences?.length ?? 0) > 0 || (contextBundle.metadata.externalSourcesRequested ?? 0) > 0) {
    output += `## 🌐 External References\n\n`;
    output += `_The following snippets are user-supplied references. They are not part of the indexed local codebase._\n\n`;
    if ((contextBundle.externalReferences?.length ?? 0) > 0) {
      for (const reference of contextBundle.externalReferences ?? []) {
        output += `### ${reference.label ?? reference.title ?? reference.url}\n\n`;
        output += `- Source: \`${reference.url}\`\n`;
        output += `- Host: \`${reference.host}\`\n`;
        output += `- Status: ${reference.status}\n\n`;
        output += `${reference.excerpt}\n\n`;
      }
    } else {
      output += `External sources were requested, but none were used. Result is local-only.\n\n`;
    }
    for (const warning of contextBundle.metadata.externalWarnings ?? []) {
      output += `- Warning [${warning.code}]: ${warning.message} (\`${warning.source_url}\`)\n`;
    }
    if ((contextBundle.metadata.externalWarnings?.length ?? 0) > 0) {
      output += '\n';
    }
  }

  // =========================================================================
  // Detailed Code Context
  // =========================================================================
  output += `## 📝 Detailed Code Context\n\n`;

  if (sortedFiles.length === 0) {
    output += `_No relevant code found for this query. Try:\n`;
    output += `- Using different keywords\n`;
    output += `- Being more specific about what you're looking for\n`;
    output += `- Ensuring the codebase is indexed_\n\n`;
  }

  for (let fileIndex = 0; fileIndex < sortedFiles.length; fileIndex++) {
    const file = sortedFiles[fileIndex];
    const language = getLanguageForExtension(file.extension);

    // File header with summary
    output += `### ${fileIndex + 1}. \`${file.path}\`\n\n`;

    if (file.summary) {
      output += `> **${file.summary}** (Relevance: ${formatRelevance(file.relevance)})\n\n`;
    }

    // Related files hint
    if (file.relatedFiles && file.relatedFiles.length > 0) {
      output += `📎 _Related files: ${file.relatedFiles.join(', ')}_\n\n`;
    }

    // Code snippets
    for (let snippetIndex = 0; snippetIndex < file.snippets.length; snippetIndex++) {
      const snippet = file.snippets[snippetIndex];

      // Snippet header for multiple snippets
      if (file.snippets.length > 1) {
        output += `#### Snippet ${snippetIndex + 1}`;
        if (snippet.codeType) {
          output += ` (${snippet.codeType})`;
        }
        output += ` — Lines: ${snippet.lines}\n\n`;
      } else {
        output += `**Lines: ${snippet.lines}**`;
        if (snippet.codeType) {
          output += ` _(${snippet.codeType})_`;
        }
        output += `\n\n`;
      }

      // Code block with syntax highlighting
      output += `\`\`\`${language}\n`;
      output += snippet.text;
      if (!snippet.text.endsWith('\n')) {
        output += '\n';
      }
      output += `\`\`\`\n\n`;
    }

    // Separator between files
    if (fileIndex < sortedFiles.length - 1) {
      output += `---\n\n`;
    }
  }

  // =========================================================================
  // Footer with usage tips
  // =========================================================================
  output += `---\n\n`;
  output += `_Context retrieved in ${contextBundle.metadata.searchTimeMs}ms. `;
  output += `Use \`semantic_search\` for more targeted queries or \`get_file\` for complete file contents._\n`;

  return output;
}

export const getContextTool = {
  name: 'get_context_for_prompt',
  description: `Get relevant codebase context optimized for prompt enhancement.
This is the primary tool for understanding code and gathering context before making changes.

Returns:
- File summaries and relevance scores
- Smart-extracted code snippets (most relevant parts)
- Related file suggestions for dependency awareness
- Relevant memories from previous sessions (preferences, decisions, facts)
- Token-aware output (respects context window limits)

Use this tool when you need to:
- Understand how a feature is implemented
- Find relevant code before making changes
- Get context about a specific concept or pattern
- Explore unfamiliar parts of the codebase
- Recall user preferences and past decisions`,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Description of what you need context for (e.g., "authentication logic", "database schema", "how user registration works")',
      },
      max_files: {
        type: 'number',
        description: 'Maximum number of files to include (default: 5, max: 20)',
        default: 5,
      },
      token_budget: {
        type: 'number',
        description: 'Maximum tokens for the entire context (default: 8000). Adjust based on your context window.',
        default: 8000,
      },
      include_related: {
        type: 'boolean',
        description: 'Include related/imported files for better context (default: true)',
        default: true,
      },
      min_relevance: {
        type: 'number',
        description: 'Minimum relevance score (0-1) to include a file (default: 0.3)',
        default: 0.3,
      },
      bypass_cache: {
        type: 'boolean',
        description: 'Bypass caches (forces fresh retrieval; useful for benchmarking/debugging).',
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
      external_sources: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['github_url', 'docs_url'] },
            url: { type: 'string' },
            label: { type: 'string' },
          },
          required: ['type', 'url'],
        },
        description: 'Optional external sources to ground the returned context without indexing them locally.',
      },
    },
    required: ['query'],
  },
};
