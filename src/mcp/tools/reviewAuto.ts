/**
 * Layer 3: MCP Interface Layer - Review Auto Tool
 *
 * Smart wrapper that chooses the most appropriate review tool based on inputs.
 * - If `diff` is provided: runs `review_diff`
 * - Otherwise: runs `review_git_diff`
 *
 * This keeps external schemas stable by returning a wrapper object with a stable shape.
 */

import crypto from 'crypto';
import type { ContextServiceClient } from '../serviceClient.js';
import type { ReviewOptions } from '../types/codeReview.js';
import type { EnterpriseReviewResult } from '../../reviewer/types.js';
import { handleReviewGitDiff, type ReviewGitDiffArgs } from './gitReview.js';
import { handleReviewDiff, type ReviewDiffArgs } from './reviewDiff.js';
import type { ReviewGitDiffOutput } from './gitReview.js';
import { normalizeOptionalDiffInput, parseRequiredDiffInput } from '../tooling/diffInput.js';
import { getCommitDiff, getGitDiff, getGitStatus, type GitDiffResult } from '../utils/gitUtils.js';
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

interface ChunkExecutionResult<TOutput> {
  output: TOutput;
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

type ReviewPathBucket = 'src' | 'tests' | 'ops' | 'other';

interface ReviewDiffSection {
  filePath: string;
  section: string;
  bucket: ReviewPathBucket;
}

interface ReviewDiffChunkInput {
  diff: string;
  changed_files: string[];
}

function classifyPathBucket(filePath: string): ReviewPathBucket {
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

function splitIntoBalancedChunks<T>(items: T[], chunkSize: number): T[][] {
  if (items.length === 0) {
    return [];
  }
  const safeChunkSize = Math.max(1, Math.floor(chunkSize));
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += safeChunkSize) {
    chunks.push(items.slice(i, i + safeChunkSize));
  }
  return chunks;
}

function extractReviewDiffSections(diff: string): ReviewDiffSection[] {
  const fileRegex = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  const matches = [...diff.matchAll(fileRegex)];
  return matches
    .map((match, index) => {
      const oldPath = match[1] ?? '';
      const newPath = match[2] ?? '';
      const startIdx = match.index ?? 0;
      const endIdx = matches[index + 1]?.index ?? diff.length;
      const section = diff.slice(startIdx, endIdx).trimEnd();
      const filePath = newPath && newPath !== '/dev/null' ? newPath : oldPath;
      if (!section || !filePath) {
        return null;
      }
      return {
        filePath,
        section,
        bucket: classifyPathBucket(filePath),
      };
    })
    .filter((section): section is ReviewDiffSection => section !== null);
}

function buildReviewDiffChunks(diff: string): ReviewDiffChunkInput[] | null {
  const sections = extractReviewDiffSections(diff);
  if (sections.length <= getReviewAutoChunkMinFiles()) {
    return null;
  }

  const chunkSize = Math.max(
    1,
    Math.min(getReviewAutoChunkMinFiles(), Math.ceil(sections.length / getReviewAutoParallelWorkers()))
  );

  const buckets: Record<ReviewPathBucket, ReviewDiffSection[]> = {
    src: [],
    tests: [],
    ops: [],
    other: [],
  };
  for (const section of sections) {
    buckets[section.bucket].push(section);
  }

  const chunks: ReviewDiffChunkInput[] = [];
  for (const bucket of ['src', 'tests', 'ops', 'other'] as ReviewPathBucket[]) {
    const chunkedBucketSections = splitIntoBalancedChunks(buckets[bucket], chunkSize);
    for (const bucketChunk of chunkedBucketSections) {
      const diffChunk = bucketChunk.map((section) => section.section).join('\n').trimEnd();
      const changedFiles = Array.from(new Set(bucketChunk.map((section) => section.filePath)));
      if (diffChunk.length === 0 || changedFiles.length === 0) {
        continue;
      }
      chunks.push({
        diff: diffChunk,
        changed_files: changedFiles,
      });
    }
  }

  return chunks.length > 1 ? chunks : null;
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => typeof value === 'string' && value.trim().length > 0)));
}

function mergeEnterpriseReviewOutputs(outputs: EnterpriseReviewResult[]): EnterpriseReviewResult {
  const allFindings = outputs.flatMap((out) => out.findings);
  const uniqueFindings: typeof allFindings = [];
  const seen = new Set<string>();
  for (const finding of allFindings) {
    const key = [
      finding.id,
      finding.location.file,
      finding.location.startLine,
      finding.title,
    ].join('|');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueFindings.push(finding);
  }

  const severityRank: Record<EnterpriseReviewResult['findings'][number]['severity'], number> = {
    CRITICAL: 0,
    HIGH: 1,
    MEDIUM: 2,
    LOW: 3,
    INFO: 4,
  };

  uniqueFindings.sort((a, b) => {
    if (a.severity !== b.severity) {
      return severityRank[a.severity] - severityRank[b.severity];
    }
    return b.confidence - a.confidence;
  });

  const riskScore = outputs.reduce((max, out) => Math.max(max, out.risk_score), 0);
  const maxRiskOutputs = outputs.filter((out) => out.risk_score === riskScore);
  const classification = maxRiskOutputs[0]?.classification ?? outputs[0]?.classification ?? 'refactor';
  const hotspots = dedupeStrings(outputs.flatMap((out) => out.hotspots));
  const shouldFail = outputs.some((out) => out.should_fail ?? false);
  const failReasons = dedupeStrings(outputs.flatMap((out) => out.fail_reasons ?? []));
  const summary = `Chunked parallel review merged from ${outputs.length} chunk(s). ` +
    outputs.map((out) => out.summary).filter(Boolean).join(' ').trim();

  const reviewedAt = outputs
    .map((out) => out.metadata.reviewed_at)
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .sort()
    .at(-1) ?? new Date().toISOString();

  const toolVersion = outputs[0]?.metadata.tool_version ?? 'chunked-review';
  const warnings = dedupeStrings(outputs.flatMap((out) => out.metadata.warnings));
  const llmModel = dedupeStrings(outputs.map((out) => out.metadata.llm_model ?? '')).at(0);

  const timings = outputs.reduce<NonNullable<EnterpriseReviewResult['stats']['timings_ms']>>((acc, out) => {
    const current = out.stats.timings_ms ?? {};
    acc.preflight = (acc.preflight ?? 0) + (current.preflight ?? 0);
    acc.invariants = (acc.invariants ?? 0) + (current.invariants ?? 0);
    acc.static_analysis = (acc.static_analysis ?? 0) + (current.static_analysis ?? 0);
    acc.context_fetch = (acc.context_fetch ?? 0) + (current.context_fetch ?? 0);
    acc.secrets_scrub = (acc.secrets_scrub ?? 0) + (current.secrets_scrub ?? 0);
    acc.llm_structural = (acc.llm_structural ?? 0) + (current.llm_structural ?? 0);
    acc.llm_detailed = (acc.llm_detailed ?? 0) + (current.llm_detailed ?? 0);
    return acc;
  }, {});

  return {
    run_id: crypto.randomUUID(),
    risk_score: riskScore,
    classification,
    hotspots,
    summary,
    findings: uniqueFindings,
    should_fail: shouldFail,
    fail_reasons: failReasons,
    stats: {
      files_changed: outputs.reduce((sum, out) => sum + out.stats.files_changed, 0),
      lines_added: outputs.reduce((sum, out) => sum + out.stats.lines_added, 0),
      lines_removed: outputs.reduce((sum, out) => sum + out.stats.lines_removed, 0),
      duration_ms: outputs.reduce((sum, out) => sum + out.stats.duration_ms, 0),
      deterministic_checks_executed: outputs.reduce((sum, out) => sum + out.stats.deterministic_checks_executed, 0),
      invariants_executed: outputs.reduce((sum, out) => sum + (out.stats.invariants_executed ?? 0), 0),
      static_analyzers_executed: outputs.reduce((sum, out) => sum + (out.stats.static_analyzers_executed ?? 0), 0),
      llm_passes_executed: outputs.reduce((sum, out) => sum + (out.stats.llm_passes_executed ?? 0), 0),
      llm_findings_added: outputs.reduce((sum, out) => sum + (out.stats.llm_findings_added ?? 0), 0),
      llm_skipped_reason:
        dedupeStrings(outputs.map((out) => out.stats.llm_skipped_reason ?? '')).join('; ') || undefined,
      timings_ms: timings,
    },
    metadata: {
      reviewed_at: reviewedAt,
      tool_version: toolVersion,
      warnings,
      llm_model: llmModel,
    },
  };
}

type ReviewCorrectness = ReviewGitDiffOutput['review']['overall_correctness'];

function chooseWorstCorrectness(values: ReviewCorrectness[]): ReviewCorrectness {
  const rank: Record<ReviewCorrectness, number> = {
    'patch is correct': 0,
    'needs attention': 1,
    'patch is incorrect': 2,
  };
  return values.reduce((worst, next) => (rank[next] > rank[worst] ? next : worst), 'patch is correct');
}

function mergeReviewGitDiffOutputs(outputs: ReviewGitDiffOutput[]): ReviewGitDiffOutput {
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

  const confidenceValues = outputs
    .map((out) => out.review.overall_confidence_score)
    .filter((v) => Number.isFinite(v));
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

async function loadGitDiffResult(
  args: ReviewAutoArgs,
  workspacePath: string
): Promise<GitDiffResult | null> {
  const target = args.target ?? 'staged';
  if (looksLikeCommitHash(target)) {
    return getCommitDiff(workspacePath, target);
  }

  return getGitDiff(workspacePath, {
    target,
    base: args.base,
    pathPatterns: args.include_patterns,
  });
}

async function runChunkedParallelEnterpriseReview(
  chunks: ReviewDiffChunkInput[],
  serviceClient: ContextServiceClient,
  options: ReviewDiffArgs['options']
): Promise<ChunkExecutionResult<EnterpriseReviewResult> | null> {
  if (chunks.length <= 1) {
    return null;
  }

  const chunkRuns = await runWithConcurrency(chunks, getReviewAutoParallelWorkers(), async (chunk) => {
    try {
      const resultStr = await handleReviewDiff(
        {
          diff: chunk.diff,
          changed_files: chunk.changed_files,
          options,
        },
        serviceClient
      );
      return { ok: true as const, output: parseJsonOrThrow<EnterpriseReviewResult>(resultStr, 'chunk review_diff output') };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/No reviewable changes found in diff scope|No changes found for review/i.test(message)) {
        return { ok: false as const, skipped: true as const };
      }
      return { ok: false as const, skipped: false as const };
    }
  });

  const successful = chunkRuns
    .filter((run): run is { ok: true; output: EnterpriseReviewResult } => run.ok)
    .map((run) => run.output);
  const skippedChunks = chunkRuns.filter((run) => !run.ok && run.skipped).length;
  if (successful.length === 0) {
    return null;
  }

  return {
    output: mergeEnterpriseReviewOutputs(successful),
    chunkCount: chunks.length,
    completedChunks: successful.length,
    skippedChunks,
    fallbackUsed: false,
  };
}

async function runChunkedParallelGitReview(
  args: ReviewAutoArgs,
  serviceClient: ContextServiceClient
): Promise<ChunkExecutionResult<ReviewGitDiffOutput> | null> {
  if (!isChunkedParallelEnabled()) return null;

  const workspacePath = serviceClient.getWorkspacePath();
  const status = await getGitStatus(workspacePath);
  if (!status.is_git_repo) {
    throw new Error('Not a git repository. Please run this tool from within a git repository.');
  }

  const diffResult = await loadGitDiffResult(args, workspacePath);
  if (!diffResult || !diffResult.diff.trim()) {
    return null;
  }

  const chunks = buildReviewDiffChunks(diffResult.diff);
  if (!chunks) {
    return null;
  }

  const chunkRuns = await runWithConcurrency(chunks, getReviewAutoParallelWorkers(), async (chunk) => {
    try {
      const resultStr = await handleReviewGitDiff(
        {
          target: args.target,
          base: args.base,
          include_patterns: chunk.changed_files,
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

  const successful = chunkRuns
    .filter((run): run is { ok: true; output: ReviewGitDiffOutput } => run.ok)
    .map((run) => run.output);
  const skippedChunks = chunkRuns.filter((run) => !run.ok && run.skipped).length;
  if (successful.length === 0) {
    return null;
  }

  return {
    output: mergeReviewGitDiffOutputs(successful),
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

    let chunkExecution: ReviewAutoResult['chunked_execution'] | undefined;
    let output: EnterpriseReviewResult;
    const reviewDiffOptions = args.review_diff_options ?? {};
    const chunkInputs =
      reviewDiffOptions.include_sarif || reviewDiffOptions.include_markdown
        ? null
        : buildReviewDiffChunks(diff);
    const chunked = chunkInputs
      ? await runChunkedParallelEnterpriseReview(chunkInputs, serviceClient, reviewDiffOptions)
      : null;
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
      const resultStr = await handleReviewDiff(
        { diff, changed_files: args.changed_files, options: args.review_diff_options } as ReviewDiffArgs,
        serviceClient
      );
      output = parseJsonOrThrow<EnterpriseReviewResult>(resultStr, 'review_diff output');
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
