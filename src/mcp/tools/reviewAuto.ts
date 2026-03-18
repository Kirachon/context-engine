/**
 * Layer 3: MCP Interface Layer - Review Auto Tool
 *
 * Smart wrapper that chooses the most appropriate review tool based on inputs.
 * - If `diff` is provided: runs `review_diff`
 * - Otherwise: runs `review_git_diff`
 *
 * This keeps external schemas stable by returning a wrapper object with a stable shape.
 */

import type { ContextServiceClient } from '../serviceClient.js';
import type { ReviewOptions } from '../types/codeReview.js';
import type { EnterpriseReviewResult } from '../../reviewer/types.js';
import { handleReviewGitDiff, type ReviewGitDiffArgs } from './gitReview.js';
import { handleReviewDiff, type ReviewDiffArgs } from './reviewDiff.js';
import type { ReviewGitDiffOutput } from './gitReview.js';
import { normalizeOptionalDiffInput, parseRequiredDiffInput } from '../tooling/diffInput.js';
import { getGitDiff } from '../utils/gitUtils.js';
import { envInt } from '../../config/env.js';

export type ReviewAutoSelectedTool = 'review_diff' | 'review_git_diff';

export interface ReviewAutoArgs {
  /**
   * Force a specific tool. Default: auto.
   */
  tool?: 'auto' | ReviewAutoSelectedTool;

  /**
   * Unified diff content (when provided, selects review_diff unless tool overrides).
   */
  diff?: string;

  /**
   * Optional list of changed files (review_diff only).
   */
  changed_files?: string[];

  /**
   * Git mode args (review_git_diff only).
   */
  target?: string;
  base?: string;
  include_patterns?: string[];

  /**
   * Options for review_diff.
   */
  review_diff_options?: ReviewDiffArgs['options'];

  /**
   * Options for review_git_diff (same as review_changes).
   */
  review_git_diff_options?: ReviewOptions;

  /**
   * Response shape version. Default: v1.
   */
  response_version?: 'v1' | 'v2';
}

interface ReviewAutoSkippedStep {
  step: 'llm_pass' | 'static_analysis';
  reason: string;
}

export interface ReviewAutoResult {
  selected_tool: ReviewAutoSelectedTool;
  rationale: string;
  output: EnterpriseReviewResult | ReviewGitDiffOutput;
  skipped_steps?: ReviewAutoSkippedStep[];
  requested_by?: 'default' | 'config' | 'user';
  chunked_execution?: {
    enabled: boolean;
    chunk_count: number;
    completed_chunks: number;
    skipped_chunks: number;
    parallel_workers: number;
    fallback_used: boolean;
  };
}

const REVIEW_AUTO_CHUNKED_PARALLEL_ENV = 'CE_REVIEW_AUTO_CHUNKED_PARALLEL';

type ReviewCorrectness = ReviewGitDiffOutput['review']['overall_correctness'];

interface ChunkExecutionResult {
  output: ReviewGitDiffOutput;
  chunkCount: number;
  completedChunks: number;
  skippedChunks: number;
  fallbackUsed: boolean;
}

function isChunkedParallelEnabled(): boolean {
  return process.env[REVIEW_AUTO_CHUNKED_PARALLEL_ENV] === 'true';
}

function getReviewAutoChunkMinFiles(): number {
  return envInt('CE_REVIEW_AUTO_CHUNK_MIN_FILES', 10, { min: 1, max: 500 });
}

function getReviewAutoParallelWorkers(): number {
  return envInt('CE_REVIEW_AUTO_PARALLEL_WORKERS', 2, { min: 1, max: 4 });
}

function looksLikeCommitHash(target: string): boolean {
  return /^[a-f0-9]{7,40}$/i.test(target);
}

function classifyPathBucket(filePath: string): 'src' | 'tests' | 'ops' | 'other' {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.startsWith('src/')) return 'src';
  if (normalized.startsWith('tests/')) return 'tests';
  if (
    normalized.startsWith('scripts/')
    || normalized.startsWith('.github/')
    || normalized.startsWith('docs/')
    || normalized.endsWith('.md')
  ) {
    return 'ops';
  }
  return 'other';
}

function buildChunkPatternsFromFiles(files: string[]): string[][] {
  const buckets: Record<'src' | 'tests' | 'ops' | 'other', string[]> = {
    src: [],
    tests: [],
    ops: [],
    other: [],
  };
  for (const file of files) {
    buckets[classifyPathBucket(file)].push(file);
  }

  const chunks: string[][] = [];
  if (buckets.src.length > 0) chunks.push(['src/**']);
  if (buckets.tests.length > 0) chunks.push(['tests/**']);
  if (buckets.ops.length > 0) chunks.push(['scripts/**', '.github/**', 'docs/**', '*.md']);
  if (buckets.other.length > 0) chunks.push([...new Set(buckets.other)]);
  return chunks;
}

function chooseWorstCorrectness(values: ReviewCorrectness[]): ReviewCorrectness {
  const rank: Record<ReviewCorrectness, number> = {
    'patch is correct': 0,
    'needs attention': 1,
    'patch is incorrect': 2,
  };
  return values.reduce((worst, next) => (rank[next] > rank[worst] ? next : worst), 'patch is correct');
}

function mergeChunkOutputs(outputs: ReviewGitDiffOutput[]): ReviewGitDiffOutput {
  const findings = outputs.flatMap((out) => out.review.findings);
  const uniqueFindings: typeof findings = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    const key = [
      finding.id,
      finding.code_location.file_path,
      finding.code_location.line_range.start,
      finding.title,
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueFindings.push(finding);
  }

  uniqueFindings.sort((a, b) => a.priority - b.priority || b.confidence_score - a.confidence_score);

  const filesChanged = Array.from(
    new Set(outputs.flatMap((out) => out.git_info.files_changed))
  ).sort((a, b) => a.localeCompare(b));

  const confidenceValues = outputs.map((out) => out.review.overall_confidence_score).filter((v) => Number.isFinite(v));
  const averageConfidence = confidenceValues.length > 0
    ? confidenceValues.reduce((sum, v) => sum + v, 0) / confidenceValues.length
    : 0;

  const correctness = chooseWorstCorrectness(outputs.map((out) => out.review.overall_correctness));
  const categoriesReviewed = Array.from(
    new Set(outputs.flatMap((out) => out.review.metadata.categories_reviewed))
  );

  const durationMs = outputs.reduce((sum, out) => sum + out.review.metadata.review_duration_ms, 0);
  const filteredCount = outputs.reduce((sum, out) => sum + out.review.metadata.findings_filtered, 0);

  const explanation = `Chunked parallel review merged from ${outputs.length} chunk(s). ` +
    outputs.map((out) => out.review.overall_explanation).filter(Boolean).join(' ').trim();

  return {
    git_info: {
      target: outputs[0]?.git_info.target ?? 'staged',
      base: outputs[0]?.git_info.base,
      command: `chunked_parallel_review(${outputs.length})`,
      files_changed: filesChanged,
      stats: {
        additions: outputs.reduce((sum, out) => sum + out.git_info.stats.additions, 0),
        deletions: outputs.reduce((sum, out) => sum + out.git_info.stats.deletions, 0),
        files_count: filesChanged.length,
      },
    },
    review: {
      findings: uniqueFindings,
      overall_correctness: correctness,
      overall_explanation: explanation,
      overall_confidence_score: averageConfidence,
      changes_summary: {
        files_changed: filesChanged.length,
        lines_added: outputs.reduce((sum, out) => sum + out.review.changes_summary.lines_added, 0),
        lines_removed: outputs.reduce((sum, out) => sum + out.review.changes_summary.lines_removed, 0),
      },
      metadata: {
        reviewed_at: new Date().toISOString(),
        review_duration_ms: durationMs,
        model_used: outputs[0]?.review.metadata.model_used ?? 'chunked-review',
        tool_version: outputs[0]?.review.metadata.tool_version ?? '1.0.0',
        findings_filtered: filteredCount,
        confidence_threshold: outputs[0]?.review.metadata.confidence_threshold ?? 0.7,
        categories_reviewed: categoriesReviewed,
      },
    },
  };
}

async function runWithConcurrency<T, R>(
  items: T[],
  workerLimit: number,
  run: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(workerLimit, items.length || 1)) }).map(async () => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      const result = await run(items[current], current);
      results[current] = result;
    }
  });

  await Promise.all(workers);
  return results;
}

async function runChunkedParallelGitReview(
  args: ReviewAutoArgs,
  serviceClient: ContextServiceClient
): Promise<ChunkExecutionResult | null> {
  if (!isChunkedParallelEnabled()) return null;
  if (args.include_patterns && args.include_patterns.length > 0) return null;

  const target = args.target ?? 'staged';
  if (looksLikeCommitHash(target)) return null;

  const workspacePath = serviceClient.getWorkspacePath();
  const baseDiff = await getGitDiff(workspacePath, {
    target,
    base: args.base,
  });
  if (!baseDiff.diff.trim()) {
    return null;
  }
  if (baseDiff.files_changed.length < getReviewAutoChunkMinFiles()) {
    return null;
  }

  const chunks = buildChunkPatternsFromFiles(baseDiff.files_changed);
  if (chunks.length <= 1) {
    return null;
  }

  const chunkRuns = await runWithConcurrency(chunks, getReviewAutoParallelWorkers(), async (chunkPatterns) => {
    try {
      const resultStr = await handleReviewGitDiff(
        {
          target: args.target,
          base: args.base,
          include_patterns: chunkPatterns,
          options: args.review_git_diff_options ?? {},
        },
        serviceClient
      );
      return { ok: true as const, output: parseJsonOrThrow<ReviewGitDiffOutput>(resultStr, 'chunk review_git_diff output') };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/No changes found for review_git_diff target/i.test(message)) {
        return { ok: false as const, skipped: true as const };
      }
      return { ok: false as const, skipped: false as const };
    }
  });

  const successful = chunkRuns.filter((run): run is { ok: true; output: ReviewGitDiffOutput } => run.ok).map((run) => run.output);
  const skippedChunks = chunkRuns.filter((run) => !run.ok && run.skipped).length;
  if (successful.length === 0) {
    return null;
  }

  return {
    output: mergeChunkOutputs(successful),
    chunkCount: chunks.length,
    completedChunks: successful.length,
    skippedChunks,
    fallbackUsed: false,
  };
}

function selectTool(args: ReviewAutoArgs): { selected: ReviewAutoSelectedTool; rationale: string } {
  if (args.tool && args.tool !== 'auto') {
    return { selected: args.tool, rationale: `Forced tool: ${args.tool}` };
  }

  if (normalizeOptionalDiffInput(args.diff)) {
    return { selected: 'review_diff', rationale: 'diff provided -> using review_diff' };
  }

  return { selected: 'review_git_diff', rationale: 'no diff provided -> using review_git_diff' };
}

function parseJsonOrThrow<T = unknown>(value: string, context: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${context}: failed to parse JSON (${message})`);
  }
}

function buildV2SkipMetadata(
  selected: ReviewAutoSelectedTool,
  args: ReviewAutoArgs
): { skipped_steps: ReviewAutoSkippedStep[]; requested_by: 'default' | 'config' | 'user' } {
  if (selected !== 'review_diff') {
    return { skipped_steps: [], requested_by: 'config' };
  }

  const options = args.review_diff_options;
  const llmEnabled = options?.enable_llm ?? false;
  const staticAnalysisEnabled = options?.enable_static_analysis ?? false;

  const skipped_steps: ReviewAutoSkippedStep[] = [];
  if (!llmEnabled) {
    skipped_steps.push({
      step: 'llm_pass',
      reason: 'Skipped because review_diff options.enable_llm is disabled.',
    });
  }
  if (!staticAnalysisEnabled) {
    skipped_steps.push({
      step: 'static_analysis',
      reason: 'Skipped because review_diff options.enable_static_analysis is disabled.',
    });
  }

  const userSpecifiedDisable =
    options?.enable_llm === false || options?.enable_static_analysis === false;

  return {
    skipped_steps,
    requested_by: userSpecifiedDisable ? 'user' : 'default',
  };
}

export async function handleReviewAuto(args: ReviewAutoArgs, serviceClient: ContextServiceClient): Promise<string> {
  const requireExplicitScope = process.env.CE_REVIEW_AUTO_REQUIRE_EXPLICIT_SCOPE === 'true';
  if (requireExplicitScope && !normalizeOptionalDiffInput(args.diff) && !args.target) {
    throw new Error(
      'review_auto requires explicit scope in this environment: provide diff or target.'
    );
  }
  const { selected, rationale } = selectTool(args);
  const responseVersion = args.response_version ?? 'v1';
  const useV2 = responseVersion === 'v2';
  const normalizedDiff = normalizeOptionalDiffInput(args.diff);

  if (selected === 'review_diff') {
    const diff = parseRequiredDiffInput(
      args.diff,
      'review_diff selected but no valid diff provided',
      'review_diff selected but diff does not look like a unified diff'
    );
    if (args.target || args.base || (args.include_patterns && args.include_patterns.length > 0)) {
      throw new Error('review_diff selected; git args (target/base/include_patterns) are not applicable');
    }
    if (args.review_git_diff_options) {
      throw new Error('review_diff selected; review_git_diff_options is not applicable');
    }

    const resultStr = await handleReviewDiff(
      { diff, changed_files: args.changed_files, options: args.review_diff_options } as ReviewDiffArgs,
      serviceClient
    );
    const output = parseJsonOrThrow<EnterpriseReviewResult>(resultStr, 'review_diff output');
    const result: ReviewAutoResult = { selected_tool: selected, rationale, output };
    if (useV2) {
      const v2Metadata = buildV2SkipMetadata(selected, args);
      result.skipped_steps = v2Metadata.skipped_steps;
      result.requested_by = v2Metadata.requested_by;
    }
    return JSON.stringify(result, null, 2);
  }

  if (normalizedDiff) {
    throw new Error('review_git_diff selected; diff argument is not applicable');
  }
  if (args.changed_files) {
    throw new Error('review_git_diff selected; changed_files is not applicable');
  }
  if (args.review_diff_options) {
    throw new Error('review_git_diff selected; review_diff_options is not applicable');
  }

  let chunkExecution: ReviewAutoResult['chunked_execution'] | undefined;
  let output: ReviewGitDiffOutput;
  const chunked = await runChunkedParallelGitReview(args, serviceClient);
  if (chunked) {
    output = chunked.output;
    chunkExecution = {
      enabled: true,
      chunk_count: chunked.chunkCount,
      completed_chunks: chunked.completedChunks,
      skipped_chunks: chunked.skippedChunks,
      parallel_workers: getReviewAutoParallelWorkers(),
      fallback_used: chunked.fallbackUsed,
    };
  } else {
    const resultStr = await handleReviewGitDiff(
      {
        target: args.target,
        base: args.base,
        include_patterns: args.include_patterns,
        options: args.review_git_diff_options ?? {},
      } as ReviewGitDiffArgs,
      serviceClient
    );
    output = parseJsonOrThrow<ReviewGitDiffOutput>(resultStr, 'review_git_diff output');
  }
  const result: ReviewAutoResult = { selected_tool: selected, rationale, output };
  if (chunkExecution) {
    result.chunked_execution = chunkExecution;
  }
  if (useV2) {
    const v2Metadata = buildV2SkipMetadata(selected, args);
    result.skipped_steps = v2Metadata.skipped_steps;
    result.requested_by = v2Metadata.requested_by;
  }
  return JSON.stringify(result, null, 2);
}

export const reviewAutoTool = {
  name: 'review_auto',
  description:
    'Smart wrapper that chooses review_diff when a diff is provided; otherwise chooses review_git_diff for the current git workspace.',
  inputSchema: {
    type: 'object',
    properties: {
      tool: {
        type: 'string',
        description: "Force tool selection. One of: 'auto', 'review_diff', 'review_git_diff'. Default: auto.",
        enum: ['auto', 'review_diff', 'review_git_diff'],
        default: 'auto',
      },
      diff: { type: 'string', description: 'Unified diff content (selects review_diff in auto mode)' },
      changed_files: { type: 'array', items: { type: 'string' }, description: 'Optional list of changed files (review_diff only)' },
      target: { type: 'string', description: "Git target to review (review_git_diff only). Default: 'staged'." },
      base: { type: 'string', description: 'Base ref for git comparisons (review_git_diff only)' },
      include_patterns: { type: 'array', items: { type: 'string' }, description: 'File globs to include (review_git_diff only)' },
      review_diff_options: { type: 'object', description: 'Options passed through to review_diff (advanced/CI-oriented)' },
      review_git_diff_options: { type: 'object', description: 'Options passed through to review_git_diff (same as review_changes options)' },
      response_version: {
        type: 'string',
        enum: ['v1', 'v2'],
        description: 'Response shape version. Default is v1.',
        default: 'v1',
      },
    },
    required: [],
  },
};
