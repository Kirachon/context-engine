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

const TOOL_VERSION = '2.0.0-phase1';

export interface ReviewDiffOptions {
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
  const preflight = runDeterministicPreflight(parsedDiff, input.changed_files);

  const warnings: string[] = [];
  const invariantFindings: EnterpriseFinding[] = [];
  let invariantsForPrompt = '(none)';
  if (input.options?.invariants_path) {
    if (!input.workspace_path) {
      warnings.push('invariants_path provided but workspace_path was not provided; skipping invariants');
    } else {
      try {
        const config = loadInvariantsConfig(input.workspace_path, input.options.invariants_path);
        const runResult = runInvariants(parsedDiff, preflight.changed_files, config);
        invariantFindings.push(...runResult.findings);
        warnings.push(...runResult.warnings);
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

        const contextRaw = await fetchPlannedContext(parsedDiff, plan, readFile, { contextLines: 20 });
        const scrubbedContext = scrubSecrets(contextRaw).scrubbedContent;
        const scrubbedDiff = scrubSecrets(input.diff).scrubbedContent;
        const scrubbedInvariants = scrubSecrets(invariantsForPrompt).scrubbedContent;

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
      }
    }
  }

  const mergedFindings = dedupeFindingsById([...invariantFindings, ...llmFindings, ...findings]);
  const filtered = mergedFindings
    .filter(f => f.confidence >= confidenceThreshold)
    .filter(f => (categories && categories.length > 0 ? categories.includes(f.category as any) : true));
  const allowlist = new Set((input.options?.allowlist_finding_ids ?? []).filter(Boolean));
  const filteredForOutput = filtered.filter(f => !allowlist.has(f.id));
  const limitedFindings = filteredForOutput.slice(0, Math.max(0, maxFindings));

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
      llm_passes_executed: llmPasses,
      llm_findings_added: llmFindings.length,
      llm_skipped_reason: llmSkippedReason,
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

function dedupeFindingsById(findings: EnterpriseFinding[]): EnterpriseFinding[] {
  const seen = new Set<string>();
  const out: EnterpriseFinding[] = [];
  for (const f of findings) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  return out;
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

const SEVERITY_ORDER: Record<string, number> = {
  CRITICAL: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  INFO: 1,
};

function evaluateFailurePolicy(args: {
  findings: EnterpriseFinding[];
  failOnSeverity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  failOnInvariantIds: string[];
}): { shouldFail: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const failIds = new Set(args.failOnInvariantIds.filter(Boolean));
  const threshold = SEVERITY_ORDER[args.failOnSeverity] ?? SEVERITY_ORDER.CRITICAL;

  for (const f of args.findings) {
    if (failIds.has(f.id)) {
      reasons.push(`Invariant ${f.id} forced-fail`);
      continue;
    }
    const sev = SEVERITY_ORDER[f.severity] ?? 0;
    if (sev >= threshold) {
      reasons.push(`${f.severity} ${f.id}: ${f.title}`);
    }
  }

  return { shouldFail: reasons.length > 0, reasons: reasons.slice(0, 20) };
}
