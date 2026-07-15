/**
 * Layer 3: MCP Interface Layer - Memory Quarantine
 *
 * Non-destructive filtering for archive-priority memories.
 *
 * Memories persisted with `- [meta] priority: archive` in `.memories/**` are kept on
 * disk untouched (nothing is deleted or moved) but must be hard-excluded from
 * *default* memory selection paths (context retrieval / getRelevantMemories /
 * handoff ranking). Explicit archive access (e.g. `list_memories`) is unaffected
 * because it reads file contents directly rather than going through this filter.
 *
 * This module intentionally only depends on a minimal `priority` shape so it can be
 * shared between the differently-typed memory records used by
 * `src/mcp/serviceClient.ts` (`MemoryEntry`) and `src/mcp/handoff/sharedCore.ts`
 * (`HandoffMemoryRecord`) without introducing a coupling between those modules.
 */

export type QuarantinablePriority = 'critical' | 'helpful' | 'archive' | string | undefined;

export interface QuarantinableMemory {
  priority?: QuarantinablePriority;
}

export interface MemoryQuarantineOptions {
  /**
   * When true, archive-priority memories are included in the result. Defaults to
   * false, meaning archive memories are excluded unless explicitly requested.
   */
  includeArchive?: boolean;
}

/**
 * Returns true when the memory is marked `priority: archive`.
 */
export function isArchivedMemory(memory: QuarantinableMemory | null | undefined): boolean {
  if (!memory) return false;
  return memory.priority === 'archive';
}

/**
 * Filters a list of memories down to the default (non-archive) selection, unless
 * `includeArchive` is set, in which case the input is returned unchanged (as a new
 * array). Never mutates the input array or its elements.
 */
export function filterDefaultMemories<T extends QuarantinableMemory>(
  memories: readonly T[],
  options: MemoryQuarantineOptions = {}
): T[] {
  if (options.includeArchive) {
    return [...memories];
  }
  return memories.filter((memory) => !isArchivedMemory(memory));
}
