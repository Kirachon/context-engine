import * as fs from 'fs';
import * as path from 'path';

import { indexWorkspaceTool } from '../../src/mcp/tools/index.js';
import { codebaseRetrievalTool } from '../../src/mcp/tools/codebaseRetrieval.js';
import { semanticSearchTool, symbolSearchTool, symbolReferencesTool, symbolDefinitionTool } from '../../src/mcp/tools/search.js';
import { getFileTool } from '../../src/mcp/tools/file.js';
import { getContextTool } from '../../src/mcp/tools/context.js';
import { enhancePromptTool } from '../../src/mcp/tools/enhance.js';
import { indexStatusTool } from '../../src/mcp/tools/status.js';
import { reindexWorkspaceTool, clearIndexTool } from '../../src/mcp/tools/lifecycle.js';
import { toolManifestTool } from '../../src/mcp/tools/manifest.js';
import { addMemoryTool, listMemoriesTool } from '../../src/mcp/tools/memory.js';
import { reviewMemorySuggestionsTool } from '../../src/mcp/tools/memoryReview.js';
import { createPlanTool, refinePlanTool, visualizePlanTool, executePlanTool } from '../../src/mcp/tools/plan.js';
import { planManagementTools } from '../../src/mcp/tools/planManagement.js';
import { reviewChangesTool } from '../../src/mcp/tools/codeReview.js';
import { reviewGitDiffTool } from '../../src/mcp/tools/gitReview.js';
import { reviewDiffTool } from '../../src/mcp/tools/reviewDiff.js';
import { reviewAutoTool } from '../../src/mcp/tools/reviewAuto.js';
import { checkInvariantsTool } from '../../src/mcp/tools/checkInvariants.js';
import { runStaticAnalysisTool } from '../../src/mcp/tools/staticAnalysis.js';
import { reactiveReviewTools } from '../../src/mcp/tools/reactiveReview.js';
import { handleToolManifest } from '../../src/mcp/tools/manifest.js';

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

const FIXTURE_PATH = path.join(
  process.cwd(),
  'tests',
  'snapshots',
  'phase2',
  'fixtures',
  'old-client-tool-families.json'
);
const MANIFEST_BASELINE_PATH = path.join(
  process.cwd(),
  'tests',
  'snapshots',
  'phase2',
  'baseline',
  'tool_manifest_basic.baseline.txt'
);

function getRegisteredTools(): ToolDefinition[] {
  return [
    indexWorkspaceTool,
    codebaseRetrievalTool,
    semanticSearchTool,
    symbolSearchTool,
    symbolReferencesTool,
    symbolDefinitionTool,
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

function loadCatalog(): OldClientFixtureCatalog {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8')) as OldClientFixtureCatalog;
}

describe('Old-client fixture catalog coverage', () => {
  it('covers every currently registered tool with required args present', () => {
    const catalog = loadCatalog();
    const registeredTools = getRegisteredTools();
    const registeredMap = new Map(registeredTools.map((tool) => [tool.name, tool]));
    const seenTools = new Set<string>();
    const errors: string[] = [];

    for (const family of catalog.families) {
      expect(family.fixtures.length).toBeGreaterThan(0);

      for (const fixture of family.fixtures) {
        const tool = registeredMap.get(fixture.tool);
        if (!tool) {
          errors.push(`Unknown tool fixture: ${fixture.tool}`);
          continue;
        }

        seenTools.add(fixture.tool);
        const required = tool.inputSchema?.required ?? [];
        for (const key of required) {
          if (!(key in fixture.args)) {
            errors.push(`Tool ${fixture.tool} missing required fixture arg ${key}`);
          }
        }
      }
    }

    const missingTools = [...registeredMap.keys()].filter((name) => !seenTools.has(name));
    if (missingTools.length > 0) {
      errors.push(`Missing fixtures for tools: ${missingTools.join(', ')}`);
    }

    expect(errors).toEqual([]);
  });

  it('keeps runtime tool inventory in parity with manifest output and the baseline snapshot', async () => {
    const runtimeTools = getRegisteredTools().map((tool) => tool.name);
    const manifest = JSON.parse(await handleToolManifest({}, {} as never)) as {
      version: string;
      tools: string[];
    };
    const manifestBaseline = JSON.parse(fs.readFileSync(MANIFEST_BASELINE_PATH, 'utf-8')) as {
      version: string;
      tools: string[];
    };

    expect(new Set(runtimeTools).size).toBe(runtimeTools.length);
    expect(manifest.tools).toEqual(runtimeTools);
    expect(manifest).toEqual(manifestBaseline);
  });
});
