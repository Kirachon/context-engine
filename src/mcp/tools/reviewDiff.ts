/**
 * Layer 3: MCP Interface Layer - Enterprise Diff Review Tool
 *
 * Additive tool that performs a deterministic, diff-first preflight review and
 * returns a structured JSON schema suitable for CI/IDE consumption.
 */

import { ContextServiceClient } from '../serviceClient.js';
import { reviewDiff, type ReviewDiffInput } from '../../reviewer/reviewDiff.js';

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
    enable_llm?: boolean;
    llm_force?: boolean;
    two_pass?: boolean;
    risk_threshold?: number;
    token_budget?: number;
    max_context_files?: number;
    custom_instructions?: string;
    fail_on_severity?: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
    fail_on_invariant_ids?: string[];
    allowlist_finding_ids?: string[];
    include_sarif?: boolean;
    include_markdown?: boolean;
  };
}

export async function handleReviewDiff(
  args: ReviewDiffArgs,
  serviceClient: ContextServiceClient
): Promise<string> {
  if (!args.diff || typeof args.diff !== 'string') {
    throw new Error('Missing or invalid "diff" argument. Provide a unified diff string.');
  }

  const input: ReviewDiffInput = {
    diff: args.diff,
    changed_files: args.changed_files,
    workspace_path: serviceClient.getWorkspacePath(),
    options: args.options,
    runtime: {
      readFile: (filePath: string) => serviceClient.getFile(filePath),
      llm: {
        call: (searchQuery: string, prompt: string) => serviceClient.searchAndAsk(searchQuery, prompt),
        model: 'auggie-context-engine',
      },
    },
  };

  const result = await reviewDiff(input);
  return JSON.stringify(result, null, 2);
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
          enable_llm: { type: 'boolean', description: 'Enable LLM review pass (Phase 3). Default: false', default: false },
          llm_force: { type: 'boolean', description: 'Force LLM review even if noise-gates would skip it. Default: false', default: false },
          two_pass: { type: 'boolean', description: 'Enable two-pass LLM review when enabled. Default: true', default: true },
          risk_threshold: { type: 'number', description: 'Risk score threshold (1-5) to run detailed pass. Default: 3', default: 3 },
          token_budget: { type: 'number', description: 'Context token budget for diff-first excerpts. Default: 8000', default: 8000 },
          max_context_files: { type: 'number', description: 'Max files to include in diff-first context. Default: 5', default: 5 },
          custom_instructions: { type: 'string', description: 'Custom instructions for the reviewer' },
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
