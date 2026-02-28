/**
 * Layer 3: MCP Interface Layer - Enterprise Diff Review Tool
 *
 * Additive tool that performs a deterministic, diff-first preflight review and
 * returns a structured JSON schema suitable for CI/IDE consumption.
 */

import { ContextServiceClient } from '../serviceClient.js';
import { reviewDiff, type ReviewDiffInput } from '../../reviewer/reviewDiff.js';
import { validateNonEmptyString } from '../tooling/validation.js';

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
  const diff = validateNonEmptyString(
    typeof args.diff === 'string' ? args.diff.trim() : args.diff,
    'Missing or invalid "diff" argument. Provide a unified diff string.'
  );

  const input: ReviewDiffInput = {
    diff,
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
