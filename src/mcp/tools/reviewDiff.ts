/**
 * Layer 3: MCP Interface Layer - Enterprise Diff Review Tool
 *
 * Additive tool that performs a deterministic, diff-first preflight review and
 * returns a structured JSON schema suitable for CI/IDE consumption.
 */

import { ContextServiceClient } from '../serviceClient.js';
import { reviewDiff, type ReviewDiffInput } from '../../reviewer/reviewDiff.js';
import { assertNonEmptyDiffScope, normalizeRequiredDiffInput } from '../tooling/diffInput.js';
import { envMs } from '../../config/env.js';
import {
  createRetrievalFlowContext,
  finalizeRetrievalFlow,
  noteRetrievalStage,
} from '../../internal/retrieval/flow.js';

const DEFAULT_REVIEW_DIFF_LLM_TIMEOUT_MS = 60_000;
const MIN_REVIEW_DIFF_LLM_TIMEOUT_MS = 1_000;
const MAX_REVIEW_DIFF_LLM_TIMEOUT_MS = 30 * 60 * 1000;
const FLOW_DEBUG_ENV = 'CE_FLOW_DEBUG';

function resolveReviewTimeoutMs(
  requestedTimeoutMs: number | undefined,
  fallbackTimeoutMs: number
): number {
  if (requestedTimeoutMs === undefined) {
    return fallbackTimeoutMs;
  }
  if (!Number.isFinite(requestedTimeoutMs)) {
    return fallbackTimeoutMs;
  }
  return Math.max(
    MIN_REVIEW_DIFF_LLM_TIMEOUT_MS,
    Math.min(MAX_REVIEW_DIFF_LLM_TIMEOUT_MS, Math.floor(requestedTimeoutMs))
  );
}

export interface ReviewDiffArgs {
  diff: string;
  changed_files?: string[];
  base_sha?: string;
  head_sha?: string;
  options?: {
    confidence_threshold?: number;
    max_findings?: number;
    categories?: string[];
    invariants_path?: string;
    enable_static_analysis?: boolean;
    static_analyzers?: Array<'tsc' | 'semgrep'>;
    static_analysis_timeout_ms?: number;
    static_analysis_max_findings_per_analyzer?: number;
    semgrep_args?: string[];
    enable_llm?: boolean;
    llm_force?: boolean;
    two_pass?: boolean;
    risk_threshold?: number;
    token_budget?: number;
    max_context_files?: number;
    custom_instructions?: string;
    llm_timeout_ms?: number;
    fail_on_severity?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
    fail_on_invariant_ids?: string[];
    allowlist_finding_ids?: string[];
    include_sarif?: boolean;
    include_markdown?: boolean;
  };
}

function noteReviewFlowStage(flow: ReturnType<typeof createRetrievalFlowContext>, stage: string): void {
  noteRetrievalStage(flow, `review:${stage}`);
}

export async function handleReviewDiff(
  args: ReviewDiffArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  const flow = createRetrievalFlowContext('review_diff', {
    metadata: {
      tool: 'review_diff',
      changed_files_count: args.changed_files?.length ?? 0,
      enable_llm: args.options?.enable_llm ?? false,
      enable_static_analysis: args.options?.enable_static_analysis ?? false,
    },
  });
  noteReviewFlowStage(flow, 'start');

  let completedSuccessfully = false;
  try {
    const diff = normalizeRequiredDiffInput(
      args.diff,
      'Missing or invalid "diff" argument. Provide a unified diff string.'
    );
    noteReviewFlowStage(flow, 'diff_normalized');
    assertNonEmptyDiffScope(diff, args.changed_files);
    noteReviewFlowStage(flow, 'scope_validated');

    const runtime: ReviewDiffInput['runtime'] = {
      readFile: (filePath: string) => serviceClient.getFile(filePath),
    };
    if (args.options?.enable_llm) {
      const reviewDiffLlmTimeoutMs = envMs(
        'CE_REVIEW_DIFF_LLM_TIMEOUT_MS',
        envMs('CE_REVIEW_AI_TIMEOUT_MS', DEFAULT_REVIEW_DIFF_LLM_TIMEOUT_MS, {
          min: MIN_REVIEW_DIFF_LLM_TIMEOUT_MS,
          max: MAX_REVIEW_DIFF_LLM_TIMEOUT_MS,
        }),
        {
          min: MIN_REVIEW_DIFF_LLM_TIMEOUT_MS,
          max: MAX_REVIEW_DIFF_LLM_TIMEOUT_MS,
        }
      );
      const effectiveReviewTimeoutMs = resolveReviewTimeoutMs(
        args.options?.llm_timeout_ms,
        reviewDiffLlmTimeoutMs
      );
      noteReviewFlowStage(flow, 'llm:enabled');
      runtime.llm = {
        call: async (searchQuery: string, prompt: string) => {
          noteReviewFlowStage(flow, 'llm:request');
          try {
            const response = await serviceClient.searchAndAsk(searchQuery, prompt, {
              timeoutMs: effectiveReviewTimeoutMs,
            });
            noteReviewFlowStage(flow, 'llm:response');
            return response;
          } catch (error) {
            noteReviewFlowStage(flow, 'llm:error');
            throw error;
          }
        },
      };
    } else {
      noteReviewFlowStage(flow, 'llm:disabled');
    }

    const input: ReviewDiffInput = {
      diff,
      changed_files: args.changed_files,
      workspace_path: serviceClient.getWorkspacePath(),
      options: args.options,
      runtime,
    };

    noteReviewFlowStage(flow, 'review:invoke');
    const result = await reviewDiff(input);
    noteReviewFlowStage(flow, 'review:complete');
    noteReviewFlowStage(flow, 'complete:success');
    completedSuccessfully = true;
    return JSON.stringify(result, null, 2);
  } catch (error) {
    noteReviewFlowStage(flow, 'complete:error');
    throw error;
  } finally {
    const summary = finalizeRetrievalFlow(flow, {
      outcome: completedSuccessfully ? 'success' : 'error',
    });
    if (process.env[FLOW_DEBUG_ENV] === '1') {
      console.error(
        `[review_diff] Flow ${completedSuccessfully ? 'success' : 'error'} (${summary.elapsedMs}ms): ${summary.stages.join(' > ')}`
      );
    }
  }
}

export const reviewDiffTool = {
  name: 'review_diff',
  description: 'Enterprise-grade diff-first review with deterministic preflight and structured JSON output.',
  inputSchema: {
    type: 'object',
    properties: {
      diff: { type: 'string', description: 'Unified diff content' },
      changed_files: { type: 'array', items: { type: 'string' }, description: 'Optional list of changed file paths' },
      base_sha: { type: 'string', description: 'Optional base commit SHA' },
      head_sha: { type: 'string', description: 'Optional head commit SHA' },
      options: {
        type: 'object',
        properties: {
          confidence_threshold: { type: 'number', description: 'Minimum confidence for findings (0-1)', default: 0.55 },
          max_findings: { type: 'number', description: 'Maximum number of findings to return', default: 20 },
          categories: { type: 'array', items: { type: 'string' }, description: 'Optional categories to focus on' },
          invariants_path: { type: 'string', description: 'Path to invariants config (Phase 2)' },
          enable_static_analysis: {
            type: 'boolean',
            description: 'Run local static analyzers (TypeScript typecheck / optional semgrep). Default: false',
            default: false,
          },
          static_analyzers: {
            type: 'array',
            items: { type: 'string', enum: ['tsc', 'semgrep'] },
            description: 'Which analyzers to run when enable_static_analysis is true. Default: ["tsc"]',
          },
          static_analysis_timeout_ms: {
            type: 'number',
            description: 'Timeout per static analyzer in milliseconds. Default: 60000',
            default: 60000,
          },
          static_analysis_max_findings_per_analyzer: {
            type: 'number',
            description: 'Max findings per analyzer. Default: 20',
            default: 20,
          },
          semgrep_args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional semgrep args (e.g. ["--config","p/ci"]). Only used when semgrep is selected.',
          },
          enable_llm: { type: 'boolean', description: 'Enable LLM review pass (Phase 3). Default: false', default: false },
          llm_force: { type: 'boolean', description: 'Force LLM review even if noise-gates would skip it. Default: false', default: false },
          two_pass: { type: 'boolean', description: 'Enable two-pass LLM review when enabled. Default: true', default: true },
          risk_threshold: { type: 'number', description: 'Risk score threshold (1-5) to run detailed pass. Default: 3', default: 3 },
          token_budget: { type: 'number', description: 'Context token budget for diff-first excerpts. Default: 8000', default: 8000 },
          max_context_files: { type: 'number', description: 'Max files to include in diff-first context. Default: 5', default: 5 },
          custom_instructions: { type: 'string', description: 'Custom instructions for the reviewer' },
          llm_timeout_ms: {
            type: 'number',
            description: 'Optional AI timeout override in milliseconds for this review call (1000-1800000).',
            minimum: 1000,
            maximum: 1800000,
          },
          fail_on_severity: {
            type: 'string',
            description: 'CI gating severity threshold. Default: CRITICAL',
            enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'],
            default: 'CRITICAL',
          },
          fail_on_invariant_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of invariant/finding ids that force CI failure regardless of severity',
          },
          allowlist_finding_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Finding ids to suppress from output and gating (escape hatch)',
          },
          include_sarif: {
            type: 'boolean',
            description: 'Include SARIF JSON in the response payload (Phase 4). Default: false',
            default: false,
          },
          include_markdown: {
            type: 'boolean',
            description: 'Include GitHub-flavored Markdown summary in the response payload (Phase 4). Default: false',
            default: false,
          },
        },
      },
    },
    required: ['diff'],
  },
};
