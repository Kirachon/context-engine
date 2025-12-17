/**
 * Layer 3: MCP Interface Layer - Memory Tool
 *
 * Provides persistent cross-session memory storage using markdown files.
 * Memories are stored in .memories/ directory and indexed by Auggie for
 * semantic retrieval alongside code context.
 *
 * Responsibilities:
 * - Add memories to appropriate category files
 * - Trigger incremental reindexing after memory updates
 * - Provide memory listing and management
 */

import * as fs from 'fs';
import * as path from 'path';
import { ContextServiceClient } from '../serviceClient.js';

// ============================================================================
// Type Definitions
// ============================================================================

export type MemoryCategory = 'preferences' | 'decisions' | 'facts';

export interface AddMemoryArgs {
  category: MemoryCategory;
  content: string;
  title?: string;
}

export interface ListMemoriesArgs {
  category?: MemoryCategory;
}

// ============================================================================
// Constants
// ============================================================================

const MEMORIES_DIR = '.memories';

const CATEGORY_FILES: Record<MemoryCategory, string> = {
  preferences: 'preferences.md',
  decisions: 'decisions.md',
  facts: 'facts.md',
};

const CATEGORY_DESCRIPTIONS: Record<MemoryCategory, string> = {
  preferences: 'coding style, tool preferences, and personal workflow choices',
  decisions: 'architecture decisions, technology choices, and design rationale',
  facts: 'project facts, environment info, and codebase structure',
};

// ============================================================================
// Helper Functions
// ============================================================================

function ensureMemoriesDir(workspacePath: string): string {
  const memoriesPath = path.join(workspacePath, MEMORIES_DIR);
  if (!fs.existsSync(memoriesPath)) {
    fs.mkdirSync(memoriesPath, { recursive: true });
  }
  return memoriesPath;
}

function formatMemoryEntry(content: string, title?: string): string {
  const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  let entry = '\n';

  if (title) {
    entry += `### [${timestamp}] ${title}\n`;
  }

  // Ensure content starts with a bullet or proper formatting
  const lines = content.trim().split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('-') && !trimmed.startsWith('*') && !trimmed.startsWith('#')) {
      entry += `- ${trimmed}\n`;
    } else {
      entry += `${line}\n`;
    }
  }

  return entry;
}

// ============================================================================
// Tool Handlers
// ============================================================================

/**
 * Add a new memory to the specified category
 */
export async function handleAddMemory(
  args: AddMemoryArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const { category, content, title } = args;

  // Validate inputs
  if (!category || !CATEGORY_FILES[category]) {
    const validCategories = Object.keys(CATEGORY_FILES).join(', ');
    throw new Error(`Invalid category. Must be one of: ${validCategories}`);
  }

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('Content is required and must be a non-empty string');
  }

  if (content.length > 5000) {
    throw new Error('Content too long: maximum 5000 characters per memory');
  }

  // Get workspace path from service client
  const workspacePath = serviceClient.getWorkspacePath();
  const memoriesPath = ensureMemoriesDir(workspacePath);
  const filePath = path.join(memoriesPath, CATEGORY_FILES[category]);
  const relativePath = path.join(MEMORIES_DIR, CATEGORY_FILES[category]);

  // Format and append the memory
  const formattedEntry = formatMemoryEntry(content, title);

  // Ensure file exists with header if it doesn't
  if (!fs.existsSync(filePath)) {
    const header = `# ${category.charAt(0).toUpperCase() + category.slice(1)}\n\n` +
      `This file stores ${CATEGORY_DESCRIPTIONS[category]}.\n`;
    fs.writeFileSync(filePath, header, 'utf-8');
  }

  // Append the memory
  fs.appendFileSync(filePath, formattedEntry, 'utf-8');

  // Trigger incremental reindex for the updated file
  try {
    await serviceClient.indexFiles([relativePath]);
  } catch (error) {
    console.error('[add_memory] Failed to reindex memory file:', error);
    // Don't fail the operation if reindexing fails - memory is still saved
  }

  const timestamp = new Date().toISOString();

  return `# ✅ Memory Added\n\n` +
    `| Property | Value |\n` +
    `|----------|-------|\n` +
    `| **Category** | ${category} |\n` +
    `| **File** | \`${relativePath}\` |\n` +
    `| **Title** | ${title || '(none)'} |\n` +
    `| **Timestamp** | ${timestamp} |\n` +
    `| **Indexed** | Yes |\n\n` +
    `**Content:**\n\`\`\`\n${content.trim()}\n\`\`\`\n\n` +
    `_This memory will be automatically retrieved when relevant to future queries._`;
}

/**
 * List all memories, optionally filtered by category
 */
export async function handleListMemories(
  args: ListMemoriesArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const { category } = args;
  const workspacePath = serviceClient.getWorkspacePath();
  const memoriesPath = path.join(workspacePath, MEMORIES_DIR);

  // Check if memories directory exists
  if (!fs.existsSync(memoriesPath)) {
    return `# 📚 Memories\n\n` +
      `_No memories found. The \`.memories/\` directory does not exist yet._\n\n` +
      `Use the \`add_memory\` tool to start storing memories.`;
  }

  const categories = category ? [category] : (Object.keys(CATEGORY_FILES) as MemoryCategory[]);
  let output = `# 📚 Memories\n\n`;

  let totalMemories = 0;

  for (const cat of categories) {
    const filePath = path.join(memoriesPath, CATEGORY_FILES[cat]);
    const relativePath = path.join(MEMORIES_DIR, CATEGORY_FILES[cat]);

    if (!fs.existsSync(filePath)) {
      output += `## ${cat.charAt(0).toUpperCase() + cat.slice(1)}\n\n`;
      output += `_No memories in this category yet._\n\n`;
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const memoryCount = lines.filter(l => l.trim().startsWith('-') || l.trim().startsWith('###')).length;
    totalMemories += memoryCount;

    const stats = fs.statSync(filePath);
    const lastModified = stats.mtime.toISOString();

    output += `## ${cat.charAt(0).toUpperCase() + cat.slice(1)}\n\n`;
    output += `| Property | Value |\n`;
    output += `|----------|-------|\n`;
    output += `| **File** | \`${relativePath}\` |\n`;
    output += `| **Size** | ${stats.size} bytes |\n`;
    output += `| **Last Modified** | ${lastModified} |\n`;
    output += `| **Entries** | ~${memoryCount} |\n\n`;

    // Show preview of content (first 500 chars)
    const preview = content.length > 500 ? content.substring(0, 500) + '\n...' : content;
    output += `**Preview:**\n\`\`\`markdown\n${preview}\n\`\`\`\n\n`;
  }

  output += `---\n\n`;
  output += `**Total:** ~${totalMemories} memory entries across ${categories.length} categories.\n\n`;
  output += `_Use \`add_memory\` to add new memories or edit files directly._`;

  return output;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const addMemoryTool = {
  name: 'add_memory',
  description: `Store a memory for future sessions. Memories are persisted as markdown files and automatically retrieved via semantic search when relevant.

**Categories:**
- \`preferences\`: Coding style, tool preferences, personal workflow choices
- \`decisions\`: Architecture decisions, technology choices, design rationale
- \`facts\`: Project facts, environment info, codebase structure

**Examples:**
- Add preference: "Prefers TypeScript strict mode"
- Add decision: "Chose JWT for authentication because..."
- Add fact: "API runs on port 3000"

Memories are stored in \`.memories/\` directory and indexed by Auggie for semantic retrieval.`,
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['preferences', 'decisions', 'facts'],
        description: 'Category of memory: preferences (coding style), decisions (architecture), or facts (project info)',
      },
      content: {
        type: 'string',
        description: 'The memory content to store (max 5000 characters)',
      },
      title: {
        type: 'string',
        description: 'Optional title for the memory (useful for decisions)',
      },
    },
    required: ['category', 'content'],
  },
};

export const listMemoriesTool = {
  name: 'list_memories',
  description: `List all stored memories, optionally filtered by category.

Shows file stats, entry counts, and content preview for each memory category.`,
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['preferences', 'decisions', 'facts'],
        description: 'Optional: Filter to a specific category',
      },
    },
    required: [],
  },
};

