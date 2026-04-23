import { loadInvariantsConfig } from '../checks/invariants/load.js';
import { runInvariants } from '../checks/invariants/runner.js';
import { runStaticAnalyzers } from '../checks/adapters/index.js';
import type { StaticAnalyzerId, StaticAnalyzerResult } from '../checks/adapters/types.js';
import { createContextPlan } from '../context/planner.js';
import { fetchPlannedContext } from '../context/fetcher.js';
import type { ReviewDiffContext } from '../context/diffContext.js';
import type { EnterpriseLLMClient } from '../llm/types.js';
import { runTwoPassReview } from '../llm/twoPass.js';
import { buildDetailedPrompt, buildStructuralPrompt } from '../prompts/enterprise.js';
import type { EnterpriseFinding } from '../types.js';
import { scrubSecrets } from '../../reactive/guardrails/index.js';
import type { ReviewDiffInput } from '../reviewDiff.js';

const REVIEW_CONTEXT_LINES = 16;

export interface ReviewDiffStaticAnalysisMetadata {
  analyzers_requested: StaticAnalyzerId[];
  analyzers_executed: StaticAnalyzerId[];
  warnings: string[];
  results: StaticAnalyzerResult[];
}

export interface ReviewAnalyzerResults {
  warnings: string[];
  invariantFindings: EnterpriseFinding[];
  invariantsExecuted: number;
  invariantsMs: number;
  invariantsForPrompt: string;
  staticFindings: EnterpriseFinding[];
  staticAnalyzersExecuted: number;
  staticAnalysisMs: number;
  staticAnalysisMetadata?: ReviewDiffStaticAnalysisMetadata;
  llmFindings: EnterpriseFinding[];
  llmPasses: number;
  llmSkippedReason?: string;
  llmModel?: string;
  contextFetchMs: number;
  secretsScrubMs: number;
  llmStructuralMs: number;
  llmDetailedMs: number;
}

export async function runReviewAnalyzers(
  context: ReviewDiffContext,
  input: ReviewDiffInput
): Promise<ReviewAnalyzerResults> {
  const warnings: string[] = [];

  const invariants = runInvariantStage(context, input, warnings);
  const staticAnalysis = await runStaticAnalysisStage(context, input, warnings);
  const llm = await runLlmStage(context, input, warnings, invariants.invariantsForPrompt);

  return {
    warnings,
    invariantFindings: invariants.findings,
    invariantsExecuted: invariants.executed,
    invariantsMs: invariants.durationMs,
    invariantsForPrompt: invariants.invariantsForPrompt,
    staticFindings: staticAnalysis.findings,
    staticAnalyzersExecuted: staticAnalysis.executed,
    staticAnalysisMs: staticAnalysis.durationMs,
    staticAnalysisMetadata: staticAnalysis.metadata,
    llmFindings: llm.findings,
    llmPasses: llm.passes,
    llmSkippedReason: llm.skippedReason,
    llmModel: llm.model,
    contextFetchMs: llm.contextFetchMs,
    secretsScrubMs: llm.secretsScrubMs,
    llmStructuralMs: llm.structuralMs,
    llmDetailedMs: llm.detailedMs,
  };
}

function runInvariantStage(
  context: ReviewDiffContext,
  input: ReviewDiffInput,
  warnings: string[]
): {
  findings: EnterpriseFinding[];
  executed: number;
  durationMs: number;
  invariantsForPrompt: string;
} {
  if (!input.options?.invariants_path) {
    return {
      findings: [],
      executed: 0,
      durationMs: 0,
      invariantsForPrompt: '(none)',
    };
  }

  if (!input.workspace_path) {
    warnings.push('invariants_path provided but workspace_path was not provided; skipping invariants');
    return {
      findings: [],
      executed: 0,
      durationMs: 0,
      invariantsForPrompt: '(none)',
    };
  }

  try {
    const startedAt = Date.now();
    const config = loadInvariantsConfig(input.workspace_path, input.options.invariants_path);
    const result = runInvariants(context.parsedDiff, context.preflight.changed_files, config);
    warnings.push(...result.warnings);
    return {
      findings: result.findings,
      executed: result.checked_invariants,
      durationMs: Date.now() - startedAt,
      invariantsForPrompt: formatInvariants(config),
    };
  } catch (error) {
    warnings.push(`Failed to load/run invariants: ${String(error)}`);
    return {
      findings: [],
      executed: 0,
      durationMs: 0,
      invariantsForPrompt: '(none)',
    };
  }
}

async function runStaticAnalysisStage(
  context: ReviewDiffContext,
  input: ReviewDiffInput,
  warnings: string[]
): Promise<{
  findings: EnterpriseFinding[];
  executed: number;
  durationMs: number;
  metadata?: ReviewDiffStaticAnalysisMetadata;
}> {
  if (!input.options?.enable_static_analysis) {
    return {
      findings: [],
      executed: 0,
      durationMs: 0,
    };
  }

  const analyzers = (input.options.static_analyzers ?? ['tsc']).filter(Boolean) as StaticAnalyzerId[];
  const metadata: ReviewDiffStaticAnalysisMetadata = {
    analyzers_requested: analyzers,
    analyzers_executed: [],
    warnings: [],
    results: [],
  };

  if (!input.workspace_path) {
    const warning = 'enable_static_analysis was true but workspace_path was not provided; skipping static analysis';
    warnings.push(warning);
    metadata.warnings.push(warning);
    return {
      findings: [],
      executed: 0,
      durationMs: 0,
      metadata,
    };
  }

  const startedAt = Date.now();
  const changedFiles =
    context.preflight.changed_files.length > 0 ? context.preflight.changed_files : input.changed_files ?? [];

  const run = await runStaticAnalyzers({
    input: {
      workspace_path: input.workspace_path,
      changed_files: changedFiles,
      diff: input.diff,
    },
    analyzers,
    timeoutMs: input.options.static_analysis_timeout_ms ?? 60_000,
    maxFindingsPerAnalyzer: input.options.static_analysis_max_findings_per_analyzer ?? 20,
    semgrepArgs: input.options.semgrep_args,
  });

  const durationMs = Date.now() - startedAt;
  metadata.analyzers_executed = run.results.filter(result => !result.skipped_reason).map(result => result.analyzer);
  metadata.results = run.results;
  metadata.warnings.push(...run.warnings);
  warnings.push(...run.warnings);

  return {
    findings: run.findings,
    executed: run.results.filter(result => !result.skipped_reason).length,
    durationMs,
    metadata,
  };
}

async function runLlmStage(
  context: ReviewDiffContext,
  input: ReviewDiffInput,
  warnings: string[],
  invariantsForPrompt: string
): Promise<{
  findings: EnterpriseFinding[];
  passes: number;
  skippedReason?: string;
  model?: string;
  contextFetchMs: number;
  secretsScrubMs: number;
  structuralMs: number;
  detailedMs: number;
}> {
  const llmEnabled = input.options?.enable_llm ?? false;
  if (!llmEnabled) {
    return {
      findings: [],
      passes: 0,
      contextFetchMs: 0,
      secretsScrubMs: 0,
      structuralMs: 0,
      detailedMs: 0,
    };
  }

  const readFile = input.runtime?.readFile;
  const llm = input.runtime?.llm;
  if (!readFile || !llm) {
    warnings.push('LLM enabled but runtime.readFile/runtime.llm not provided; skipping LLM pass');
    return {
      findings: [],
      passes: 0,
      skippedReason: 'missing_runtime',
      contextFetchMs: 0,
      secretsScrubMs: 0,
      structuralMs: 0,
      detailedMs: 0,
    };
  }

  const noiseGateSkip =
    !(input.options?.llm_force ?? false) &&
    context.preflight.risk_score <= 2 &&
    context.preflight.tests_touched;

  if (noiseGateSkip) {
    return {
      findings: [],
      passes: 0,
      skippedReason: 'noise_gate_low_risk',
      model: llm.model,
      contextFetchMs: 0,
      secretsScrubMs: 0,
      structuralMs: 0,
      detailedMs: 0,
    };
  }

  const plan = createContextPlan(context.parsedDiff, context.preflight, {
    tokenBudget: input.options?.token_budget ?? 8000,
    maxFiles: input.options?.max_context_files ?? 5,
  });

  const contextStartedAt = Date.now();
  const rawContext = await fetchPlannedContext(context.parsedDiff, plan, readFile, {
    contextLines: REVIEW_CONTEXT_LINES,
  });
  const contextFetchMs = Date.now() - contextStartedAt;

  const scrubStartedAt = Date.now();
  const scrubbedContext = scrubSecrets(rawContext).scrubbedContent;
  const scrubbedDiff = scrubSecrets(input.diff).scrubbedContent;
  const scrubbedInvariants = scrubSecrets(invariantsForPrompt).scrubbedContent;
  const secretsScrubMs = Date.now() - scrubStartedAt;

  const twoPass = await runTwoPassReview({
    llm,
    options: {
      enabled: true,
      twoPass: input.options?.two_pass ?? true,
      riskThreshold: input.options?.risk_threshold ?? 3,
    },
    riskScore: context.preflight.risk_score,
    buildStructuralPrompt: () =>
      buildStructuralPrompt({
        diff: scrubbedDiff,
        context: scrubbedContext,
        invariants: scrubbedInvariants,
        customInstructions: input.options?.custom_instructions,
      }),
    buildDetailedPrompt: (structuralFindingsJson: string) =>
      buildDetailedPrompt({
        diff: scrubbedDiff,
        context: scrubbedContext,
        invariants: scrubbedInvariants,
        structuralFindingsJson,
        customInstructions: input.options?.custom_instructions,
      }),
  });

  warnings.push(...twoPass.warnings);

  return {
    findings: twoPass.findings,
    passes: twoPass.passes_executed,
    model: llm.model,
    contextFetchMs,
    secretsScrubMs,
    structuralMs: twoPass.timings_ms.structural,
    detailedMs: twoPass.timings_ms.detailed ?? 0,
  };
}

function formatInvariants(
  config: Record<string, Array<{ id: string; severity: string; category: string; rule: string }>>
): string {
  const lines: string[] = [];
  for (const [section, invariants] of Object.entries(config)) {
    lines.push(`${section}:`);
    for (const invariant of invariants) {
      lines.push(`- [${invariant.id}] (${invariant.severity}/${invariant.category}) ${invariant.rule}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim() || '(none)';
}
