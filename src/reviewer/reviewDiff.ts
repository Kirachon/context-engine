import crypto from 'crypto';
import type { ParsedDiff } from '../mcp/types/codeReview.js';
import { parseUnifiedDiff } from './diff/parse.js';
import { classifyChange } from './diff/classify.js';
import { runDeterministicPreflight } from './checks/preflight.js';
import type { EnterpriseFinding, EnterpriseReviewResult } from './types.js';
import { loadInvariantsConfig } from './checks/invariants/load.js';
import { runInvariants } from './checks/invariants/runner.js';
import { createContextPlan } from './context/planner.js';
import { fetchPlannedContext } from './context/fetcher.js';
import { buildDetailedPrompt, buildStructuralPrompt } from './prompts/enterprise.js';
import { runTwoPassReview } from './llm/twoPass.js';
import type { EnterpriseLLMClient } from './llm/types.js';
import { scrubSecrets } from '../reactive/guardrails/index.js';
import { toSarif } from './output/sarif.js';
import { formatGitHubComment } from './output/github.js';
import { runStaticAnalyzers } from './checks/adapters/index.js';
import type { StaticAnalyzerId } from './checks/adapters/types.js';
import { evaluateFailurePolicy, postProcessFindings } from './post/normalize.js';
import { dedupeFindingsById } from './post/findings.js';

const TOOL_VERSION = '1.9.0';

export interface ReviewDiffOptions {
  confidence_threshold?: number;
  max_findings?: number;
  categories?: string[];
  invariants_path?: string;
  // Static analysis (opt-in)
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
  // CI gating
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
  const startTime = Date.now();

  const parsedDiff: ParsedDiff = parseUnifiedDiff(input.diff);
  const classification = classifyChange(parsedDiff);
  const preflightStart = Date.now();
  const preflight = runDeterministicPreflight(parsedDiff, input.changed_files);
  const preflightMs = Date.now() - preflightStart;

  const warnings: string[] = [];
  const invariantFindings: EnterpriseFinding[] = [];
  let invariantsExecuted = 0;
  let invariantsMs = 0;
  let invariantsForPrompt = '(none)';
  if (input.options?.invariants_path) {
    if (!input.workspace_path) {
      warnings.push('invariants_path provided but workspace_path was not provided; skipping invariants');
    } else {
      try {
        const invStart = Date.now();
        const config = loadInvariantsConfig(input.workspace_path, input.options.invariants_path);
        const runResult = runInvariants(parsedDiff, preflight.changed_files, config);
        invariantFindings.push(...runResult.findings);
        warnings.push(...runResult.warnings);
        invariantsExecuted = runResult.checked_invariants;
        invariantsMs = Date.now() - invStart;
        invariantsForPrompt = formatInvariants(config);
      } catch (e) {
        warnings.push(`Failed to load/run invariants: ${String(e)}`);
      }
    }
  }

  const findings = buildDeterministicFindings({
    classification,
    changedFiles: preflight.changed_files,
    hotspots: preflight.hotspots,
    configChanged: preflight.config_changed,
    publicApiChanged: preflight.public_api_changed,
    testsTouched: preflight.tests_touched,
    isBinaryChange: preflight.is_binary_change,
  });

  const staticFindings: EnterpriseFinding[] = [];
  let staticAnalyzersExecuted = 0;
  let staticAnalysisMs = 0;
  if (input.options?.enable_static_analysis) {
    if (!input.workspace_path) {
      warnings.push('enable_static_analysis was true but workspace_path was not provided; skipping static analysis');
    } else {
      const staticStart = Date.now();
      const analyzers = (input.options.static_analyzers ?? ['tsc']).filter(Boolean);
      const changedFiles = preflight.changed_files.length > 0 ? preflight.changed_files : input.changed_files ?? [];
      const run = await runStaticAnalyzers({
        input: { workspace_path: input.workspace_path, changed_files: changedFiles, diff: input.diff },
        analyzers: analyzers as StaticAnalyzerId[],
        timeoutMs: input.options.static_analysis_timeout_ms ?? 60_000,
        maxFindingsPerAnalyzer: input.options.static_analysis_max_findings_per_analyzer ?? 20,
        semgrepArgs: input.options.semgrep_args,
      });
      staticAnalysisMs = Date.now() - staticStart;
      staticAnalyzersExecuted = run.results.filter(r => !r.skipped_reason).length;
      staticFindings.push(...run.findings);
      warnings.push(...run.warnings);
    }
  }

  const llmEnabled = input.options?.enable_llm ?? false;
  const llmForce = input.options?.llm_force ?? false;
  const riskThreshold = input.options?.risk_threshold ?? 3;
  const confidenceThreshold = input.options?.confidence_threshold ?? 0.55;
  const categories = input.options?.categories;
  const maxFindings = input.options?.max_findings ?? 20;

  const llmFindings: EnterpriseFinding[] = [];
  let llmPasses = 0;
  let llmSkippedReason: string | undefined;
  let llmModel: string | undefined;
  let contextFetchMs = 0;
  let secretsScrubMs = 0;
  let llmStructuralMs = 0;
  let llmDetailedMs = 0;

  if (llmEnabled) {
    const runtime = input.runtime;
    const readFile = runtime?.readFile;
    const llm = runtime?.llm;

    if (!readFile || !llm) {
      llmSkippedReason = 'missing_runtime';
      warnings.push('LLM enabled but runtime.readFile/runtime.llm not provided; skipping LLM pass');
    } else {
      llmModel = llm.model;

      const noiseGateSkip =
        !llmForce &&
        preflight.risk_score <= 2 &&
        invariantFindings.length === 0 &&
        preflight.tests_touched;

      if (noiseGateSkip) {
        llmSkippedReason = 'noise_gate_low_risk';
      } else {
        const plan = createContextPlan(parsedDiff, preflight, {
          tokenBudget: input.options?.token_budget ?? 8000,
          maxFiles: input.options?.max_context_files ?? 5,
        });

        const contextStart = Date.now();
        const contextRaw = await fetchPlannedContext(parsedDiff, plan, readFile, { contextLines: 20 });
        contextFetchMs = Date.now() - contextStart;

        const scrubStart = Date.now();
        const scrubbedContext = scrubSecrets(contextRaw).scrubbedContent;
        const scrubbedDiff = scrubSecrets(input.diff).scrubbedContent;
        const scrubbedInvariants = scrubSecrets(invariantsForPrompt).scrubbedContent;
        secretsScrubMs = Date.now() - scrubStart;

        const twoPass = await runTwoPassReview({
          llm,
          options: {
            enabled: true,
            twoPass: input.options?.two_pass ?? true,
            riskThreshold,
          },
          riskScore: preflight.risk_score,
          buildStructuralPrompt: () =>
            buildStructuralPrompt({
              diff: scrubbedDiff,
              context: scrubbedContext,
              invariants: scrubbedInvariants,
              customInstructions: input.options?.custom_instructions,
            }),
          buildDetailedPrompt: (structuralJson: string) =>
            buildDetailedPrompt({
              diff: scrubbedDiff,
              context: scrubbedContext,
              invariants: scrubbedInvariants,
              structuralFindingsJson: structuralJson,
              customInstructions: input.options?.custom_instructions,
            }),
        });

        llmFindings.push(...twoPass.findings);
        warnings.push(...twoPass.warnings);
        llmPasses = twoPass.passes_executed;
        llmStructuralMs = twoPass.timings_ms.structural;
        llmDetailedMs = twoPass.timings_ms.detailed ?? 0;
      }
    }
  }

  const mergedFindings = dedupeFindingsById([...invariantFindings, ...staticFindings, ...llmFindings, ...findings]);
  const { filteredForOutput, limitedFindings } = postProcessFindings({
    mergedFindings,
    confidenceThreshold,
    categories,
    allowlistFindingIds: input.options?.allowlist_finding_ids,
    maxFindings,
  });

  const { shouldFail, reasons } = evaluateFailurePolicy({
    findings: filteredForOutput,
    failOnSeverity: input.options?.fail_on_severity ?? 'CRITICAL',
    failOnInvariantIds: input.options?.fail_on_invariant_ids ?? [],
  });

  const durationMs = Date.now() - startTime;
  const summary = buildSummary({
    riskScore: preflight.risk_score,
    classification,
    filesChanged: preflight.changed_files.length,
    linesAdded: parsedDiff.lines_added,
    linesRemoved: parsedDiff.lines_removed,
    hotspots: preflight.hotspots,
    findingsCount: limitedFindings.length,
  });

  const result: EnterpriseReviewResult = {
    run_id: crypto.randomUUID(),
    risk_score: preflight.risk_score,
    classification,
    hotspots: preflight.hotspots,
    summary,
    findings: limitedFindings,
    should_fail: shouldFail,
    fail_reasons: reasons,
    stats: {
      files_changed: preflight.changed_files.length,
      lines_added: parsedDiff.lines_added,
      lines_removed: parsedDiff.lines_removed,
      duration_ms: durationMs,
      deterministic_checks_executed: preflight.deterministic_checks_executed,
      invariants_executed: invariantsExecuted,
      static_analyzers_executed: staticAnalyzersExecuted,
      llm_passes_executed: llmPasses,
      llm_findings_added: llmFindings.length,
      llm_skipped_reason: llmSkippedReason,
      timings_ms: {
        preflight: preflightMs,
        invariants: invariantsMs,
        static_analysis: staticAnalysisMs,
        context_fetch: contextFetchMs,
        secrets_scrub: secretsScrubMs,
        llm_structural: llmStructuralMs,
        llm_detailed: llmDetailedMs,
      },
    },
    metadata: {
      reviewed_at: new Date().toISOString(),
      tool_version: TOOL_VERSION,
      warnings,
      llm_model: llmModel,
    },
  };

  if (input.options?.include_sarif) {
    result.sarif = toSarif(result);
  }
  if (input.options?.include_markdown) {
    result.markdown = formatGitHubComment(result);
  }

  return result;
}

function buildSummary(args: {
  riskScore: number;
  classification: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  hotspots: string[];
  findingsCount: number;
}): string {
  const hotspotsText = args.hotspots.length > 0 ? ` Hotspots: ${args.hotspots.join(', ')}.` : '';
  return `Classified as ${args.classification}. Risk ${args.riskScore}/5. ${args.filesChanged} files changed (+${args.linesAdded}/-${args.linesRemoved}). ${args.findingsCount} deterministic findings.${hotspotsText}`.trim();
}

function buildDeterministicFindings(args: {
  classification: string;
  changedFiles: string[];
  hotspots: string[];
  configChanged: boolean;
  publicApiChanged: boolean;
  testsTouched: boolean;
  isBinaryChange: boolean;
}): EnterpriseFinding[] {
  const findings: EnterpriseFinding[] = [];
  const primaryLocationFile = args.changedFiles[0] ?? '(multiple files)';

  const add = (finding: Omit<EnterpriseFinding, 'location'> & { location?: EnterpriseFinding['location'] }) => {
    findings.push({
      ...finding,
      location: finding.location ?? { file: primaryLocationFile, startLine: 1, endLine: 1 },
    });
  };

  if (!args.testsTouched && args.classification !== 'docs' && args.classification !== 'infra') {
    add({
      id: 'PRE001',
      severity: 'MEDIUM',
      category: 'reliability',
      confidence: 0.95,
      title: 'No tests appear to be touched by this change',
      evidence: [`changed_files: ${args.changedFiles.slice(0, 10).join(', ')}${args.changedFiles.length > 10 ? ', ...' : ''}`],
      impact: 'Risk of regressions is higher without test changes or additions.',
      recommendation: 'Add or update tests covering the modified behavior, or justify why no tests are needed.',
    });
  }

  if (args.publicApiChanged) {
    add({
      id: 'PRE002',
      severity: 'HIGH',
      category: 'architecture',
      confidence: 0.9,
      title: 'Possible public API surface change detected',
      evidence: ['Detected export-related changes or updates to entry/tool registration paths.'],
      impact: 'Downstream clients may break if the API change is not backward compatible.',
      recommendation: 'Review API compatibility, update documentation, and ensure semantic versioning expectations are met.',
    });
  }

  if (args.configChanged) {
    add({
      id: 'PRE003',
      severity: 'MEDIUM',
      category: 'infra',
      confidence: 0.9,
      title: 'Configuration or CI-related files changed',
      evidence: [`hotspots: ${args.hotspots.join(', ') || '(none)'}`],
      impact: 'Build, release, or runtime behavior can change in subtle ways.',
      recommendation: 'Verify build/test locally and confirm CI behavior matches expectations.',
    });
  }

  if (args.isBinaryChange) {
    add({
      id: 'PRE004',
      severity: 'LOW',
      category: 'maintainability',
      confidence: 0.85,
      title: 'Binary file change detected in diff',
      evidence: ['Binary files were detected; content cannot be reviewed deterministically.'],
      impact: 'Reviewers cannot evaluate binary changes for safety or correctness.',
      recommendation: 'Provide provenance and rationale (e.g., generated asset), and consider storing generated artifacts elsewhere.',
    });
  }

  if (args.hotspots.length > 0) {
    add({
      id: 'PRE005',
      severity: 'INFO',
      category: 'maintainability',
      confidence: 0.9,
      title: 'Hotspot paths detected',
      evidence: [`hotspots: ${args.hotspots.join(', ')}`],
      impact: 'Changes in these areas typically have larger blast radius.',
      recommendation: 'Double-check edge cases and ensure tests cover critical flows.',
    });
  }

  return findings;
}

function formatInvariants(config: Record<string, Array<{ id: string; severity: string; category: string; rule: string }>>): string {
  const lines: string[] = [];
  for (const [section, invariants] of Object.entries(config)) {
    lines.push(`${section}:`);
    for (const inv of invariants) {
      lines.push(`- [${inv.id}] (${inv.severity}/${inv.category}) ${inv.rule}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim() || '(none)';
}

// NOTE: Failure policy implementation moved to `src/reviewer/post/normalize.ts`.
