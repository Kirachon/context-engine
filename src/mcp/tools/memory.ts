/**
 * Layer 3: MCP Interface Layer - Memory Tool
 *
 * Provides persistent cross-session memory storage using markdown files.
 * Memories are stored in .memories/ directory and indexed for
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
import { validateMaxLength, validateNonEmptyString, validateOneOf } from '../tooling/validation.js';

// ============================================================================
// Type Definitions
// ============================================================================

export type MemoryCategory = 'preferences' | 'decisions' | 'facts';
export type MemoryPriority = 'critical' | 'helpful' | 'archive';

export interface AddMemoryArgs {
  category: MemoryCategory;
  content: string;
  title?: string;
  subtype?: string;
  tags?: string[];
  priority?: MemoryPriority;
  source?: string;
  linked_files?: string[];
  linked_plans?: string[];
  evidence?: string;
  created_at?: string;
  updated_at?: string;
  owner?: string;
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

const VALID_PRIORITIES: MemoryPriority[] = ['critical', 'helpful', 'archive'];

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

function normalizeStringArray(values?: string[]): string[] | undefined {
  if (!values) return undefined;
  const normalized = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function formatMemoryEntry(content: string, title: string | undefined, metadata: AddMemoryArgs): string {
  const now = new Date().toISOString();
  const createdAt = metadata.created_at || now;
  const updatedAt = metadata.updated_at || createdAt;
  const headingDate = createdAt.split('T')[0]; // YYYY-MM-DD
  let entry = '\n';

  if (title) {
    entry += `### [${headingDate}] ${title}\n`;
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

  const tags = normalizeStringArray(metadata.tags);
  const linkedFiles = normalizeStringArray(metadata.linked_files);
  const linkedPlans = normalizeStringArray(metadata.linked_plans);
  const metadataLines: string[] = [];
  if (metadata.subtype) metadataLines.push(`- [meta] subtype: ${metadata.subtype}`);
  if (metadata.priority) metadataLines.push(`- [meta] priority: ${metadata.priority}`);
  if (tags) metadataLines.push(`- [meta] tags: ${tags.join(', ')}`);
  if (metadata.source) metadataLines.push(`- [meta] source: ${metadata.source}`);
  if (linkedFiles) metadataLines.push(`- [meta] linked_files: ${linkedFiles.join(', ')}`);
  if (linkedPlans) metadataLines.push(`- [meta] linked_plans: ${linkedPlans.join(', ')}`);
  if (metadata.evidence) metadataLines.push(`- [meta] evidence: ${metadata.evidence}`);
  if (metadata.owner) metadataLines.push(`- [meta] owner: ${metadata.owner}`);
  metadataLines.push(`- [meta] created_at: ${createdAt}`);
  metadataLines.push(`- [meta] updated_at: ${updatedAt}`);

  entry += '\n';
  entry += metadataLines.join('\n');
  entry += '\n';

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
  const {
    category,
    content,
    title,
    subtype,
    tags,
    priority,
    source,
    linked_files,
    linked_plans,
    evidence,
    created_at,
    updated_at,
    owner,
  } = args;
  const validContent = validateNonEmptyString(
    content,
    'Content is required and must be a non-empty string'
  );

  // Validate inputs
  if (!category || !CATEGORY_FILES[category as MemoryCategory]) {
    validateOneOf(
      category,
      Object.keys(CATEGORY_FILES) as MemoryCategory[],
      `Invalid category. Must be one of: ${Object.keys(CATEGORY_FILES).join(', ')}`
    );
  }
  validateMaxLength(validContent, 5000, 'Content too long: maximum 5000 characters per memory');
  if (priority) {
    validateOneOf(priority, VALID_PRIORITIES, 'Priority must be one of: critical, helpful, archive');
  }
  if (title) validateMaxLength(title, 200, 'Title too long: maximum 200 characters');
  if (subtype) validateMaxLength(subtype, 100, 'Subtype too long: maximum 100 characters');
  if (source) validateMaxLength(source, 500, 'Source too long: maximum 500 characters');
  if (evidence) validateMaxLength(evidence, 1000, 'Evidence too long: maximum 1000 characters');
  if (owner) validateMaxLength(owner, 120, 'Owner too long: maximum 120 characters');
  if (created_at && Number.isNaN(Date.parse(created_at))) {
    throw new Error('created_at must be a valid ISO timestamp');
  }
  if (updated_at && Number.isNaN(Date.parse(updated_at))) {
    throw new Error('updated_at must be a valid ISO timestamp');
  }
  for (const value of tags ?? []) {
    validateMaxLength(value, 50, 'Tag too long: maximum 50 characters');
  }
  for (const value of linked_files ?? []) {
    validateMaxLength(value, 300, 'linked_files entry too long: maximum 300 characters');
  }
  for (const value of linked_plans ?? []) {
    validateMaxLength(value, 120, 'linked_plans entry too long: maximum 120 characters');
  }

  // Get workspace path from service client
  const workspacePath = serviceClient.getWorkspacePath();
  const memoriesPath = ensureMemoriesDir(workspacePath);
  const filePath = path.join(memoriesPath, CATEGORY_FILES[category]);
  const relativePath = path.join(MEMORIES_DIR, CATEGORY_FILES[category]);

  // Format and append the memory
  const formattedEntry = formatMemoryEntry(validContent, title, {
    category,
    content: validContent,
    title,
    subtype,
    tags,
    priority,
    source,
    linked_files,
    linked_plans,
    evidence,
    created_at,
    updated_at,
    owner,
  });

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
  const metadataSummary = [
    subtype ? `subtype=${subtype}` : null,
    priority ? `priority=${priority}` : null,
    tags && tags.length > 0 ? `tags=${tags.join(',')}` : null,
  ].filter(Boolean);

  return `# ✅ Memory Added\n\n` +
    `| Property | Value |\n` +
    `|----------|-------|\n` +
    `| **Category** | ${category} |\n` +
    `| **File** | \`${relativePath}\` |\n` +
    `| **Title** | ${title || '(none)'} |\n` +
    `| **Timestamp** | ${timestamp} |\n` +
    `| **Metadata** | ${metadataSummary.length > 0 ? metadataSummary.join('; ') : '(none)'} |\n` +
    `| **Indexed** | Yes |\n\n` +
    `**Content:**\n\`\`\`\n${validContent.trim()}\n\`\`\`\n\n` +
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

Optional metadata fields improve ranking and traceability across sessions:
- \`subtype\`: finer-grained label such as \`review_finding\` or \`failed_attempt\`
- \`priority\`: \`critical\`, \`helpful\`, or \`archive\`
- \`tags\`, \`source\`, \`linked_files\`, \`linked_plans\`, \`evidence\`, \`owner\`, timestamps

Memories are stored in \`.memories/\` directory and indexed for semantic retrieval.`,
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
      subtype: {
        type: 'string',
        description: 'Optional subtype label (for example: review_finding, failed_attempt, incident)',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional tags to support filtering and ranking',
      },
      priority: {
        type: 'string',
        enum: ['critical', 'helpful', 'archive'],
        description: 'Optional priority used for memory ranking',
      },
      source: {
        type: 'string',
        description: 'Optional source path or identifier',
      },
      linked_files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional file paths related to this memory',
      },
      linked_plans: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional plan identifiers related to this memory',
      },
      evidence: {
        type: 'string',
        description: 'Optional evidence reference (commands, receipts, or docs)',
      },
      created_at: {
        type: 'string',
        description: 'Optional ISO timestamp for when this memory was first created',
      },
      updated_at: {
        type: 'string',
        description: 'Optional ISO timestamp for the most recent update',
      },
      owner: {
        type: 'string',
        description: 'Optional owner for memory maintenance',
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
