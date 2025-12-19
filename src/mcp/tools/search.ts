/**
 * Layer 3: MCP Interface Layer - Search Tool
 *
 * Exposes semantic_search as an MCP tool
 *
 * Responsibilities:
 * - Validate input parameters
 * - Map tool calls to service layer
 * - Format results for optimal LLM consumption
 *
 * Use Cases:
 * - Find specific code patterns or implementations
 * - Locate functions, classes, or types by description
 * - Quick exploration of codebase for specific concepts
 */

import { ContextServiceClient } from '../serviceClient.js';
import { internalRetrieveCode } from '../../internal/handlers/retrieval.js';

export interface SemanticSearchArgs {
  query: string;
  top_k?: number;
}

/**
 * Format relevance score as a visual indicator
 */
function formatRelevance(score: number | undefined): string {
  if (score === undefined) return '';
  if (score >= 0.8) return '🔥';
  if (score >= 0.6) return '✅';
  if (score >= 0.4) return '📊';
  return '📌';
}

export async function handleSemanticSearch(
  args: SemanticSearchArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const { query, top_k = 10 } = args;

  // Validate inputs
  if (!query || typeof query !== 'string') {
    throw new Error('Invalid query parameter: must be a non-empty string');
  }

  if (query.length > 500) {
    throw new Error('Query too long: maximum 500 characters');
  }

  if (top_k !== undefined && (typeof top_k !== 'number' || top_k < 1 || top_k > 50)) {
    throw new Error('Invalid top_k parameter: must be a number between 1 and 50');
  }

  const retrieval = await internalRetrieveCode(query, serviceClient, { topK: top_k });
  const results = retrieval.results;

  // Format results for agent consumption
  if (results.length === 0) {
    let output = `# 🔍 Search Results\n\n`;
    output += `**Query:** "${query}"\n\n`;
    output += `_No results found. Try:\n`;
    output += `- Using different keywords\n`;
    output += `- Being more general or more specific\n`;
    output += `- Checking if the codebase is indexed_\n`;
    return output;
  }

  let output = `# 🔍 Search Results\n\n`;
  output += `**Query:** "${query}"\n`;
  output += `**Found:** ${results.length} matching snippets\n\n`;

  // Group results by file for better organization
  const fileGroups = new Map<string, typeof results>();
  for (const result of results) {
    if (!fileGroups.has(result.path)) {
      fileGroups.set(result.path, []);
    }
    fileGroups.get(result.path)!.push(result);
  }

  output += `## Results by File\n\n`;

  let fileIndex = 0;
  for (const [filePath, fileResults] of fileGroups) {
    fileIndex++;
    const topRelevance = Math.max(...fileResults.map(r => r.relevanceScore || 0));
    const indicator = formatRelevance(topRelevance);

    output += `### ${fileIndex}. \`${filePath}\` ${indicator}\n\n`;

    for (const result of fileResults) {
      if (result.lines) {
        output += `**Lines ${result.lines}**`;
      }
      if (result.relevanceScore) {
        output += ` (${(result.relevanceScore * 100).toFixed(0)}% match)`;
      }
      output += `\n\n`;

      // Show a preview of the content
      const preview = result.content.length > 300
        ? result.content.substring(0, 300) + '...'
        : result.content;

      output += '```\n';
      output += preview;
      output += '\n```\n\n';
    }
  }

  // Retrieval audit table (sorted by highest score, max 10 entries)
  const auditRows = Array.from(fileGroups.entries())
    .map(([filePath, fileResults]) => {
      const best = fileResults.reduce((acc, cur) => {
        const currentScore = cur.relevanceScore ?? 0;
        return currentScore > (acc.relevanceScore ?? 0) ? cur : acc;
      }, fileResults[0]);

      return {
        filePath,
        score: best.relevanceScore,
        matchType: best.matchType ?? 'semantic',
        retrievedAt: best.retrievedAt,
      };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 10);

  if (auditRows.length > 0) {
    output += `## Retrieval Audit\n\n`;
    output += `| File | Score | Type | Retrieved |\n`;
    output += `|------|-------|------|-----------|\n`;
    for (const row of auditRows) {
      const scoreText = row.score !== undefined ? `${(row.score * 100).toFixed(0)}%` : 'n/a';
      const retrieved = row.retrievedAt ?? 'now';
      output += `| \`${row.filePath}\` | ${scoreText} | ${row.matchType} | ${retrieved} |\n`;
    }
    output += `\n`;
  }

  output += `---\n`;
  output += `_Use \`get_context_for_prompt\` for more comprehensive context or \`get_file\` for complete file contents._\n`;

  return output;
}

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
    },
    required: ['query'],
  },
};
