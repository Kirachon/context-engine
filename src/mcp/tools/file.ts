/**
 * Layer 3: MCP Interface Layer - File Tool
 *
 * Exposes get_file as an MCP tool
 *
 * Responsibilities:
 * - Validate input parameters
 * - Map tool calls to service layer
 * - Format file contents for optimal LLM consumption
 *
 * Use Cases:
 * - View complete file contents
 * - Examine specific files found via search
 * - Review configuration or documentation files
 */

import { ContextServiceClient } from '../serviceClient.js';
import * as nodePath from 'path';
import {
  validateLineRange,
  validateMaxLength,
  validateNonEmptyString,
  validateNumberInRange,
} from '../tooling/validation.js';

export interface GetFileArgs {
  path: string;
  start_line?: number;
  end_line?: number;
}

/**
 * Get syntax highlighting language for a file extension
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
    '.toml': 'toml',
    '.xml': 'xml',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'zsh',
    '.ps1': 'powershell',
  };
  return langMap[ext.toLowerCase()] || '';
}

/**
 * Format file size in human-readable format
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export async function handleGetFile(
  args: GetFileArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const { path, start_line, end_line } = args;

  // Validate inputs
  const validPath = validateNonEmptyString(path, 'Invalid path parameter: must be a non-empty string');
  validateMaxLength(validPath, 500, 'Path too long: maximum 500 characters');
  validateNumberInRange(start_line, 1, Number.POSITIVE_INFINITY, 'Invalid start_line: must be a positive number');
  validateNumberInRange(end_line, 1, Number.POSITIVE_INFINITY, 'Invalid end_line: must be a positive number');
  validateLineRange(start_line, end_line, 'Invalid range: start_line must be less than or equal to end_line');

  const fullContent = await serviceClient.getFile(validPath);
  const allLines = fullContent.split('\n');
  const totalLines = allLines.length;
  const size = Buffer.byteLength(fullContent, 'utf-8');
  const ext = nodePath.extname(validPath);
  const language = getLanguageForExtension(ext);
  const filename = nodePath.basename(validPath);

  // Handle line range if specified
  let content: string;
  let lineInfo: string;

  if (start_line !== undefined || end_line !== undefined) {
    const start = (start_line || 1) - 1; // Convert to 0-based
    const end = end_line || totalLines;

    if (start >= totalLines) {
      throw new Error(`start_line ${start_line} exceeds file length (${totalLines} lines)`);
    }

    const selectedLines = allLines.slice(start, end);
    content = selectedLines.join('\n');
    lineInfo = `Lines ${start + 1}-${Math.min(end, totalLines)} of ${totalLines}`;
  } else {
    content = fullContent;
    lineInfo = `${totalLines} lines`;
  }

  // Format output with enhanced metadata
  let output = `# 📄 File: \`${filename}\`\n\n`;
  output += `| Property | Value |\n`;
  output += `|----------|-------|\n`;
  output += `| **Path** | \`${validPath}\` |\n`;
  output += `| **Lines** | ${lineInfo} |\n`;
  output += `| **Size** | ${formatFileSize(size)} |\n`;
  output += `| **Type** | ${ext || 'unknown'} |\n`;
  output += `\n`;

  // Add the file content with syntax highlighting
  output += `## Content\n\n`;
  output += `\`\`\`${language}\n`;
  output += content;
  if (!content.endsWith('\n')) {
    output += '\n';
  }
  output += `\`\`\`\n`;

  // Add navigation hint if viewing a range
  if (start_line !== undefined || end_line !== undefined) {
    output += `\n---\n`;
    output += `_Viewing partial content. Use \`get_file\` without line range for complete file._\n`;
  }

  return output;
}

export const getFileTool = {
  name: 'get_file',
  description: `Retrieve complete or partial contents of a file from the codebase.

Use this tool when you need to:
- View the full implementation of a specific file
- Examine files found via semantic_search
- Read configuration, documentation, or data files
- View specific line ranges within large files

For searching across multiple files, use semantic_search or get_context_for_prompt instead.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to workspace root (e.g., "src/index.ts", "package.json")',
      },
      start_line: {
        type: 'number',
        description: 'Optional: First line to include (1-based). Omit for start of file.',
      },
      end_line: {
        type: 'number',
        description: 'Optional: Last line to include (1-based). Omit for end of file.',
      },
    },
    required: ['path'],
  },
};
