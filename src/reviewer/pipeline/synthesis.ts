import crypto from 'crypto';
import { formatGitHubComment } from '../output/github.js';
import { toSarif } from '../output/sarif.js';
import { dedupeFindingsById } from '../post/findings.js';
import { evaluateFailurePolicy, postProcessFindings } from '../post/normalize.js';
import type { ReviewDiffContext } from '../context/diffContext.js';
import type { EnterpriseFinding, EnterpriseReviewResult } from '../types.js';
import type { ReviewAnalyzerResults, ReviewDiffStaticAnalysisMetadata } from './analyzerOrchestrator.js';
import type { ReviewDiffInput } from '../reviewDiff.js';

const TOOL_VERSION = '1.9.0';

export type ReviewDiffResultWithStaticMetadata = EnterpriseReviewResult & {
  static_analysis?: ReviewDiffStaticAnalysisMetadata;
};

export function buildDeterministicFindings(args: {
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

export function buildReviewDiffResult(args: {
  context: ReviewDiffContext;
  input: ReviewDiffInput;
  analyzerResults: ReviewAnalyzerResults;
  deterministicFindings: EnterpriseFinding[];
  durationMs: number;
  preflightMs: number;
}): EnterpriseReviewResult {
  const { context, input, analyzerResults, deterministicFindings, durationMs, preflightMs } = args;

  const confidenceThreshold = input.options?.confidence_threshold ?? 0.55;
  const categories = input.options?.categories;
  const maxFindings = input.options?.max_findings ?? 20;

  const mergedFindings = dedupeFindingsById([
    ...analyzerResults.invariantFindings,
    ...analyzerResults.staticFindings,
    ...analyzerResults.llmFindings,
    ...deterministicFindings,
  ]);

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

  const result: ReviewDiffResultWithStaticMetadata = {
    run_id: crypto.randomUUID(),
    risk_score: context.preflight.risk_score,
    classification: context.classification,
    hotspots: context.preflight.hotspots,
    summary: buildSummary({
      riskScore: context.preflight.risk_score,
      classification: context.classification,
      filesChanged: context.preflight.changed_files.length,
      linesAdded: context.parsedDiff.lines_added,
      linesRemoved: context.parsedDiff.lines_removed,
      hotspots: context.preflight.hotspots,
      findingsCount: limitedFindings.length,
    }),
    findings: limitedFindings,
    should_fail: shouldFail,
    fail_reasons: reasons,
    stats: {
      files_changed: context.preflight.changed_files.length,
      lines_added: context.parsedDiff.lines_added,
      lines_removed: context.parsedDiff.lines_removed,
      duration_ms: durationMs,
      deterministic_checks_executed: context.preflight.deterministic_checks_executed,
      invariants_executed: analyzerResults.invariantsExecuted,
      static_analyzers_executed: analyzerResults.staticAnalyzersExecuted,
      llm_passes_executed: analyzerResults.llmPasses,
      llm_findings_added: analyzerResults.llmFindings.length,
      llm_skipped_reason: analyzerResults.llmSkippedReason,
      timings_ms: {
        preflight: preflightMs,
        invariants: analyzerResults.invariantsMs,
        static_analysis: analyzerResults.staticAnalysisMs,
        context_fetch: analyzerResults.contextFetchMs,
        secrets_scrub: analyzerResults.secretsScrubMs,
        llm_structural: analyzerResults.llmStructuralMs,
        llm_detailed: analyzerResults.llmDetailedMs,
      },
    },
    metadata: {
      reviewed_at: new Date().toISOString(),
      tool_version: TOOL_VERSION,
      warnings: analyzerResults.warnings,
      llm_model: analyzerResults.llmModel,
    },
  };

  if (analyzerResults.staticAnalysisMetadata) {
    result.static_analysis = analyzerResults.staticAnalysisMetadata;
  }
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
