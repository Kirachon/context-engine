#!/usr/bin/env tsx
/**
 * Snapshot harness for MCP tools (Phase 2).
 *
 * Usage:
 *   npx --no-install tsx tests/snapshots/snapshot-harness.ts --update
 *   npx --no-install tsx tests/snapshots/snapshot-harness.ts
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  FILE_CONTENTS,
  FIXED_TIME_ISO,
  INDEX_RESULT,
  INDEX_STATUS,
  SEARCH_RESULTS,
  SNAPSHOT_CASES,
  buildContextBundle,
} from './test-inputs.js';

import { handleCodebaseRetrieval } from '../../src/mcp/tools/codebaseRetrieval.js';
import { handleSemanticSearch } from '../../src/mcp/tools/search.js';
import { handleGetContext } from '../../src/mcp/tools/context.js';
import { handleEnhancePrompt } from '../../src/mcp/tools/enhance.js';
import { handleGetFile } from '../../src/mcp/tools/file.js';
import { handleIndexStatus } from '../../src/mcp/tools/status.js';
import { handleToolManifest } from '../../src/mcp/tools/manifest.js';
import { handleVisualizePlan } from '../../src/mcp/tools/plan.js';
import { handleListMemories } from '../../src/mcp/tools/memory.js';
import { reviewMemorySuggestionsTool } from '../../src/mcp/tools/memoryReview.js';
import { indexWorkspaceTool } from '../../src/mcp/tools/index.js';
import { codebaseRetrievalTool } from '../../src/mcp/tools/codebaseRetrieval.js';
import { semanticSearchTool } from '../../src/mcp/tools/search.js';
import { getFileTool } from '../../src/mcp/tools/file.js';
import { getContextTool } from '../../src/mcp/tools/context.js';
import { enhancePromptTool } from '../../src/mcp/tools/enhance.js';
import { indexStatusTool } from '../../src/mcp/tools/status.js';
import { reindexWorkspaceTool, clearIndexTool } from '../../src/mcp/tools/lifecycle.js';
import { toolManifestTool } from '../../src/mcp/tools/manifest.js';
import { addMemoryTool, listMemoriesTool } from '../../src/mcp/tools/memory.js';
import { createPlanTool, refinePlanTool, visualizePlanTool, executePlanTool } from '../../src/mcp/tools/plan.js';
import { planManagementTools } from '../../src/mcp/tools/planManagement.js';
import { reviewChangesTool } from '../../src/mcp/tools/codeReview.js';
import { reviewGitDiffTool } from '../../src/mcp/tools/gitReview.js';
import { reviewDiffTool } from '../../src/mcp/tools/reviewDiff.js';
import { reviewAutoTool } from '../../src/mcp/tools/reviewAuto.js';
import { checkInvariantsTool } from '../../src/mcp/tools/checkInvariants.js';
import { runStaticAnalysisTool } from '../../src/mcp/tools/staticAnalysis.js';
import { reactiveReviewTools } from '../../src/mcp/tools/reactiveReview.js';

const ROOT = process.cwd();
const SNAPSHOT_DIR = path.join(ROOT, 'tests', 'snapshots', 'phase2', 'baseline');
const WORKSPACE_DIR = path.join(ROOT, 'tests', 'snapshots', 'phase2', 'workspace');
const FIXTURE_PATH = path.join(ROOT, 'tests', 'snapshots', 'phase2', 'fixtures', 'old-client-tool-families.json');
const FIXED_TIME = new Date(FIXED_TIME_ISO);

type SnapshotResult = {
  id: string;
  output: string;
};

type ToolDefinition = {
  name: string;
  inputSchema?: {
    required?: string[];
  };
};

type OldClientFixtureCase = {
  tool: string;
  args: Record<string, unknown>;
};

type OldClientFixtureFamily = {
  family: string;
  fixtures: OldClientFixtureCase[];
};

type OldClientFixtureCatalog = {
  version: number;
  families: OldClientFixtureFamily[];
};

class MockContextServiceClient {
  constructor(private workspacePath: string) {}

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  getIndexStatus() {
    return INDEX_STATUS;
  }

  async semanticSearch(query: string, topK: number) {
    const key = query.toLowerCase().includes('database') ? 'database' : 'default';
    const results = SEARCH_RESULTS[key] ?? SEARCH_RESULTS.default;
    return results.slice(0, topK);
  }

  async getFile(filePath: string) {
    const content = FILE_CONTENTS[filePath];
    if (content === undefined) {
      throw new Error(`File not found: ${filePath}`);
    }
    return content;
  }

  async getContextForPrompt(query: string, options?: { tokenBudget?: number }) {
    return buildContextBundle(query, options?.tokenBudget ?? 8000);
  }

  async searchAndAsk(query: string, _prompt: string) {
    return [
      '### BEGIN RESPONSE ###',
      'Here is an enhanced version of the original instruction that is more specific and clear:',
      `<enhanced-prompt>ENHANCED: ${query}</enhanced-prompt>`,
      '',
      '### END RESPONSE ###',
    ].join('\n');
  }

  async indexWorkspace() {
    return INDEX_RESULT;
  }

  async indexWorkspaceInBackground() {
    return;
  }

  async clearIndex() {
    return;
  }

  async indexFiles(_paths: string[]) {
    return;
  }
}

function freezeTime() {
  const OriginalDate = Date;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Date = class extends OriginalDate {
    constructor(...args: any[]) {
      if (args.length === 0) {
        super(FIXED_TIME.getTime());
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      super(...args);
    }

    static now() {
      return FIXED_TIME.getTime();
    }

    static parse(dateString: string) {
      return OriginalDate.parse(dateString);
    }

    static UTC(...args: number[]) {
      return OriginalDate.UTC(...args);
    }
  };

  return () => {
    (globalThis as any).Date = OriginalDate;
  };
}

function ensureWorkspace() {
  fs.rmSync(WORKSPACE_DIR, { force: true, recursive: true });
  fs.mkdirSync(path.join(WORKSPACE_DIR, '.memories'), { recursive: true });

  const prefsPath = path.join(WORKSPACE_DIR, '.memories', 'preferences.md');
  const decisionsPath = path.join(WORKSPACE_DIR, '.memories', 'decisions.md');
  const factsPath = path.join(WORKSPACE_DIR, '.memories', 'facts.md');

  fs.writeFileSync(
    prefsPath,
    '# Preferences\n\nThis file stores coding style.\n- Prefer strict typing\n',
    'utf-8'
  );
  fs.writeFileSync(
    decisionsPath,
    '# Decisions\n\nThis file stores architecture decisions.\n### [2025-01-01] Use adapters\n- Keep tools thin\n',
    'utf-8'
  );
  fs.writeFileSync(
    factsPath,
    '# Facts\n\nThis file stores project facts.\n- Uses SQLite in tests\n',
    'utf-8'
  );

  fs.utimesSync(prefsPath, FIXED_TIME, FIXED_TIME);
  fs.utimesSync(decisionsPath, FIXED_TIME, FIXED_TIME);
  fs.utimesSync(factsPath, FIXED_TIME, FIXED_TIME);
}

function snapshotPath(id: string): string {
  const safeName = id.replace(/[^a-zA-Z0-9_.-]+/g, '_');
  return path.join(SNAPSHOT_DIR, `${safeName}.baseline.txt`);
}

function loadOldClientFixtures(): OldClientFixtureCatalog {
  const content = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const parsed = JSON.parse(content) as OldClientFixtureCatalog;
  if (!parsed || !Array.isArray(parsed.families)) {
    throw new Error(`Invalid old-client fixture catalog at ${FIXTURE_PATH}`);
  }
  return parsed;
}

function getRegisteredTools(): ToolDefinition[] {
  return [
    indexWorkspaceTool,
    codebaseRetrievalTool,
    semanticSearchTool,
    getFileTool,
    getContextTool,
    enhancePromptTool,
    indexStatusTool,
    reindexWorkspaceTool,
    clearIndexTool,
    toolManifestTool,
    addMemoryTool,
    listMemoriesTool,
    reviewMemorySuggestionsTool,
    createPlanTool,
    refinePlanTool,
    visualizePlanTool,
    executePlanTool,
    ...planManagementTools,
    reviewChangesTool,
    reviewGitDiffTool,
    reviewDiffTool,
    reviewAutoTool,
    checkInvariantsTool,
    runStaticAnalysisTool,
    ...reactiveReviewTools,
  ];
}

function validateOldClientFixtures(fixtures: OldClientFixtureCatalog): void {
  const registeredTools = getRegisteredTools();
  const registeredMap = new Map(registeredTools.map((tool) => [tool.name, tool]));
  const seenTools = new Set<string>();
  const errors: string[] = [];

  for (const family of fixtures.families) {
    if (!Array.isArray(family.fixtures) || family.fixtures.length === 0) {
      errors.push(`Family "${family.family}" has no fixtures.`);
      continue;
    }

    for (const fixture of family.fixtures) {
      const tool = registeredMap.get(fixture.tool);
      if (!tool) {
        errors.push(`Unknown tool fixture "${fixture.tool}" in family "${family.family}".`);
        continue;
      }

      seenTools.add(fixture.tool);
      const required = tool.inputSchema?.required ?? [];
      for (const key of required) {
        if (!(key in fixture.args)) {
          errors.push(`Fixture "${fixture.tool}" in family "${family.family}" is missing required arg "${key}".`);
        }
      }
    }
  }

  const missingTools = [...registeredMap.keys()].filter((name) => !seenTools.has(name));
  if (missingTools.length > 0) {
    errors.push(`Missing tool fixtures: ${missingTools.join(', ')}`);
  }

  if (errors.length > 0) {
    throw new Error(`Old-client fixture validation failed:\n- ${errors.join('\n- ')}`);
  }
}

async function runCase(caseDef: (typeof SNAPSHOT_CASES)[number], serviceClient: MockContextServiceClient): Promise<SnapshotResult> {
  let output: string;
  try {
    switch (caseDef.tool) {
      case 'codebase_retrieval':
        output = await handleCodebaseRetrieval(caseDef.args as any, serviceClient as any);
        break;
      case 'semantic_search':
        output = await handleSemanticSearch(caseDef.args as any, serviceClient as any);
        break;
      case 'get_context_for_prompt':
        output = await handleGetContext(caseDef.args as any, serviceClient as any);
        break;
      case 'enhance_prompt':
        output = await handleEnhancePrompt(caseDef.args as any, serviceClient as any);
        break;
      case 'get_file':
        output = await handleGetFile(caseDef.args as any, serviceClient as any);
        break;
      case 'index_status':
        output = await handleIndexStatus(caseDef.args as any, serviceClient as any);
        break;
      case 'tool_manifest':
        output = await handleToolManifest(caseDef.args as any, serviceClient as any);
        break;
      case 'visualize_plan':
        output = await handleVisualizePlan(caseDef.args as any, serviceClient as any);
        break;
      case 'list_memories':
        output = await handleListMemories(caseDef.args as any, serviceClient as any);
        break;
      default:
        throw new Error(`Unsupported tool: ${caseDef.tool}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output = `Error: ${message}`;
  }

  return { id: caseDef.id, output: output.endsWith('\n') ? output : `${output}\n` };
}

async function main() {
  const updateSnapshots = process.argv.includes('--update');
  process.env.CONTEXT_ENGINE_RETRIEVAL_PIPELINE = '0';

  const restoreTime = freezeTime();
  ensureWorkspace();
  const oldClientFixtures = loadOldClientFixtures();
  validateOldClientFixtures(oldClientFixtures);

  const serviceClient = new MockContextServiceClient(WORKSPACE_DIR);
  const results: SnapshotResult[] = [];

  for (const caseDef of SNAPSHOT_CASES) {
    const result = await runCase(caseDef, serviceClient);
    results.push(result);
  }

  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  let failures = 0;
  for (const result of results) {
    const filePath = snapshotPath(result.id);
    if (updateSnapshots || !fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, result.output, 'utf-8');
      continue;
    }

    const existing = fs.readFileSync(filePath, 'utf-8');
    if (existing !== result.output) {
      failures += 1;
      console.error(`[snapshot] MISMATCH ${result.id}`);
    }
  }

  restoreTime();

  if (!updateSnapshots && failures > 0) {
    console.error(`Snapshot mismatches: ${failures}`);
    process.exit(1);
  }

  console.log(updateSnapshots ? 'Snapshots updated.' : 'Snapshots verified.');
}

main();
