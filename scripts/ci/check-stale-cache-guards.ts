#!/usr/bin/env node
/**
 * Deterministic CI check that stale/unhealthy index guard coverage remains present.
 *
 * Exit codes:
 * - 0: required coverage anchors are present
 * - 1: one or more anchors are missing
 */

import * as fs from 'fs';
import * as path from 'path';

type GuardTarget = {
  file: string;
  purpose: string;
  requiredSnippets: string[];
};

const GUARDED_TARGETS: GuardTarget[] = [
  {
    file: 'tests/tools/status.test.ts',
    purpose: 'index_status stale/unhealthy guidance assertions',
    requiredSnippets: [
      "it('should surface stale index guidance'",
      "it('should surface error guidance for unhealthy index status'",
      "expect(result).toContain('reindex_workspace');",
    ],
  },
  {
    file: 'tests/tools/search.test.ts',
    purpose: 'semantic_search stale/unhealthy freshness warning assertions',
    requiredSnippets: [
      "it('should include freshness warning in no-results output when index is stale'",
      "it('should include freshness warning when index is unhealthy'",
      "expect(result).toContain('index is stale');",
    ],
  },
  {
    file: 'tests/tools/context.test.ts',
    purpose: 'get_context_for_prompt stale/unhealthy freshness warning assertions',
    requiredSnippets: [
      "it('should include freshness warning when index is stale'",
      "it('should include freshness warning when index is unhealthy'",
      "expect(result).toContain('workspace appears unindexed');",
    ],
  },
  {
    file: 'tests/tools/codebaseRetrieval.test.ts',
    purpose: 'codebase_retrieval stale/unhealthy freshness metadata assertions',
    requiredSnippets: [
      "it('adds freshness warning metadata when index is stale'",
      "it('adds freshness warning metadata when index is unhealthy'",
      "expect(parsed.metadata.freshnessWarning).toMatch(/index status is error/i);",
    ],
  },
  {
    file: 'tests/serviceClient.test.ts',
    purpose: 'cache lifecycle safeguards in ContextServiceClient',
    requiredSnippets: [
      "it('should cache search results'",
      "it('should clear cache when clearCache is called'",
      "it('should clear cache after indexing'",
    ],
  },
];

function readFileOrThrow(relativePath: string): string {
  const resolvedPath = path.resolve(relativePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Required file not found: ${relativePath}`);
  }
  return fs.readFileSync(resolvedPath, 'utf8');
}

function main(): void {
  const failures: string[] = [];

  // eslint-disable-next-line no-console
  console.log('Stale-cache correctness guard coverage check');

  for (const target of GUARDED_TARGETS) {
    const source = readFileOrThrow(target.file);
    const missing = target.requiredSnippets.filter((snippet) => !source.includes(snippet));

    // eslint-disable-next-line no-console
    console.log(`- ${target.file}: ${target.purpose}`);

    if (missing.length > 0) {
      failures.push(
        `${target.file} is missing required coverage anchors:\n${missing.map((s) => `  • ${s}`).join('\n')}`
      );
    }
  }

  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error('Stale-cache guard coverage check failed.');
    for (const failure of failures) {
      // eslint-disable-next-line no-console
      console.error(`\n${failure}`);
    }
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log('Stale-cache guard coverage check passed.');
  process.exit(0);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`Stale-cache guard coverage check failed: ${message}`);
  process.exit(1);
}
