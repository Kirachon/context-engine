import type { EnterpriseLLMClient } from './llm/types.js';
import type { StaticAnalyzerId } from './checks/adapters/types.js';
import { createReviewDiffContext } from './context/diffContext.js';
import { runReviewAnalyzers } from './pipeline/analyzerOrchestrator.js';
import { buildDeterministicFindings, buildReviewDiffResult } from './pipeline/synthesis.js';
import type { EnterpriseReviewResult } from './types.js';

export const TOOL_VERSION = '1.9.0';

export interface ReviewDiffOptions {
  confidence_threshold?: number;
  max_findings?: number;
  categories?: string[];
  invariants_path?: string;
  enable_static_analysis?: boolean;
  static_analyzers?: StaticAnalyzerId[];
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
}

export interface ReviewDiffInput {
  diff: string;
  changed_files?: string[];
  workspace_path?: string;
  options?: ReviewDiffOptions;
  runtime?: {
    readFile?: (filePath: string) => Promise<string>;
    llm?: EnterpriseLLMClient;
  };
}

export async function reviewDiff(input: ReviewDiffInput): Promise<EnterpriseReviewResult> {
  const startedAt = Date.now();

  const preflightStartedAt = Date.now();
  const context = createReviewDiffContext(input.diff, input.changed_files);
  const preflightMs = Date.now() - preflightStartedAt;

  const deterministicFindings = buildDeterministicFindings({
    classification: context.classification,
    changedFiles: context.preflight.changed_files,
    hotspots: context.preflight.hotspots,
    configChanged: context.preflight.config_changed,
    publicApiChanged: context.preflight.public_api_changed,
    testsTouched: context.preflight.tests_touched,
    isBinaryChange: context.preflight.is_binary_change,
  });

  const analyzerResults = await runReviewAnalyzers(context, input);

  return buildReviewDiffResult({
    context,
    input,
    analyzerResults,
    deterministicFindings,
    durationMs: Date.now() - startedAt,
    preflightMs,
  });
}
