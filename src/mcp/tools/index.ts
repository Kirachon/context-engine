/**
 * Layer 3: MCP Interface Layer - Index Workspace Tool
 *
 * Allows triggering workspace indexing via MCP tool call.
 * This is essential for first-time setup or when files change significantly.
 */

import { ContextServiceClient } from '../serviceClient.js';

export interface IndexWorkspaceArgs {
  /** Force re-indexing even if index exists (default: false) */
  force?: boolean;
  /** Run indexing in background worker (default: false) */
  background?: boolean;
}

/**
 * Handle the index_workspace tool call
 */
export async function handleIndexWorkspace(
  args: IndexWorkspaceArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const { force = false, background = false } = args;
  
  const startTime = Date.now();
  
  try {
    console.error(`[index_workspace] Starting workspace indexing (force=${force})...`);

    if (force) {
      console.error('[index_workspace] Force enabled: clearing existing index state first...');
      await serviceClient.clearIndex();
    }

    if (background) {
      // Fire and forget background worker
      serviceClient.indexWorkspaceInBackground().catch((error) => {
        console.error('[index_workspace] Background indexing failed:', error);
      });
      return JSON.stringify({
        success: true,
        message: 'Background indexing started',
      }, null, 2);
    }

    await serviceClient.indexWorkspace();
    
    const elapsed = Date.now() - startTime;
    
    return JSON.stringify({
      success: true,
      message: `Workspace indexed successfully in ${elapsed}ms`,
      elapsed_ms: elapsed,
    }, null, 2);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[index_workspace] Failed: ${errorMessage}`);
    
    throw new Error(`Failed to index workspace: ${errorMessage}`);
  }
}

/**
 * Tool schema definition for MCP registration
 */
export const indexWorkspaceTool = {
  name: 'index_workspace',
  description: `Index the current workspace for semantic search.

This tool scans all source files in the workspace and builds a semantic index
that enables fast, meaning-based code search.

**When to use this tool:**
- First time using the context engine with a new project
- After making significant changes to the codebase
- When semantic_search or enhance_prompt returns no results

**What gets indexed (50+ file types):**
- TypeScript/JavaScript (.ts, .tsx, .js, .jsx, .mjs, .cjs)
- Python (.py, .pyi)
- Flutter/Dart (.dart, .arb)
- Go (.go)
- Rust (.rs)
- Java/Kotlin/Scala (.java, .kt, .kts, .scala)
- C/C++ (.c, .cpp, .h, .hpp)
- .NET (.cs, .fs)
- Swift/Objective-C (.swift, .m)
- Web (.vue, .svelte, .astro, .html, .css, .scss)
- Config (.json, .yaml, .yml, .toml, .xml, .plist, .gradle)
- API schemas (.graphql, .proto)
- Shell scripts (.sh, .bash, .ps1)
- DevOps (Dockerfile, .tf, Makefile, Jenkinsfile)
- Documentation (.md, .txt)

**What is excluded (optimized for AI context):**
- Generated code (*.g.dart, *.freezed.dart, *.pb.*)
- Dependencies (node_modules, vendor, Pods, .pub-cache)
- Build outputs (dist, build, .dart_tool, .next)
- Lock files (package-lock.json, pubspec.lock, yarn.lock)
- Binary files (images, fonts, media, archives)
- Files over 1MB (typically generated or data files)
- Secrets (.env, *.key, *.pem)

The index is saved to .augment-context-state.json in the workspace root
and will be automatically restored on future server starts.`,
  inputSchema: {
    type: 'object',
    properties: {
      force: {
        type: 'boolean',
        description: 'Force re-indexing even if an index already exists (default: false)',
        default: false,
      },
      background: {
        type: 'boolean',
        description: 'Run indexing in a background worker thread (non-blocking)',
        default: false,
      },
    },
    required: [],
  },
};
