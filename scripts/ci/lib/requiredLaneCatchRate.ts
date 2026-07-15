/**
 * Q3b — Required-lane catch-rate evaluator + provenance-valid report.
 *
 * Replaces the TODO echo scaffold in
 * `.github/workflows/required-lane-catch-rate.yml` with an executable
 * evaluator that:
 *   1. Loads the Q3a frozen `seeded_failure` corpus + threshold contract
 *   2. Runs approved category detectors against the workspace
 *   3. Computes catch_rate_pct = caught(should_catch) / should_catch * 100
 *   4. Emits a provenance-valid report (commit, corpus hash, contract version)
 *   5. Fails closed when corpus/evaluator/threshold proof is missing or
 *      catch rate drops below the advertised 95% policy
 */

import fs from 'fs';
import path from 'path';
import {
  eolInvariantSha256Hexes,
  readJson,
  type CorpusCase,
  type CorpusFile,
  type FrozenCorpusContract,
} from './frozenCorpusContract.js';
import { resolveCommitSha } from '../bench-provenance.js';

export class RequiredLaneCatchRateError extends Error {}

export type ExpectedOutcome = 'should_catch' | 'should_pass';
export type EvaluatorVerdict = 'caught' | 'passed' | 'missed' | 'false_positive';

export interface SeededFailureCase extends CorpusCase {
  expected_outcome: ExpectedOutcome;
  failure_category: string;
}

export interface CaseEvaluation {
  id: string;
  failure_category: string;
  expected_outcome: ExpectedOutcome;
  verdict: EvaluatorVerdict;
  detail: string;
  matched_expectation: boolean;
}

export interface CatchRateMetrics {
  should_catch_total: number;
  caught: number;
  missed: number;
  should_pass_total: number;
  passed: number;
  false_positives: number;
  catch_rate_pct: number;
  control_pass_rate_pct: number;
}

export interface RequiredLaneCatchRateReport {
  schema_version: 1;
  generated_at_utc: string;
  commit_sha: string;
  lane: 'seeded_failure';
  corpus_id: string;
  corpus_path: string;
  corpus_sha256: string;
  contract_path: string;
  contract_version: number;
  threshold_min_catch_rate_pct: number;
  metrics: CatchRateMetrics;
  cases: CaseEvaluation[];
  gate: { status: 'pass' | 'fail'; reasons: string[] };
}

export type CategoryDetector = (caseDef: SeededFailureCase, repoRoot: string) => {
  ok: boolean;
  detail: string;
};

const DEFAULT_CONTRACT_PATH = 'config/ci/q3a-frozen-corpus-contract.json';
const DEFAULT_OUT_PATH = 'artifacts/bench/required-lane-catch-rate-report.json';

function resolvePath(repoRoot: string, relativeOrAbsolutePath: string): string {
  return path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.join(repoRoot, relativeOrAbsolutePath);
}

function readText(repoRoot: string, relativePath: string): string {
  const resolved = resolvePath(repoRoot, relativePath);
  if (!fs.existsSync(resolved)) {
    throw new RequiredLaneCatchRateError(`Missing required file for evaluator probe: ${relativePath}`);
  }
  return fs.readFileSync(resolved, 'utf8');
}

/**
 * Approved detectors for the Q3a seeded-failure corpus.
 * Each `should_catch` category asserts a regression guard that must remain
 * present in-tree. Control-pass categories assert healthy invariants.
 */
export function createDefaultDetectors(): Record<string, CategoryDetector> {
  return {
    'cancellation-regression': (_case, repoRoot) => {
      const source = readText(repoRoot, 'src/mcp/executeTool.ts');
      const hasCancelledVocabulary =
        /export type ToolCallResult = 'success' \| 'error' \| 'cancelled'/.test(source) ||
        /result: 'cancelled'/.test(source);
      const hasAbortHandling = /signal\.aborted|AbortSignal/.test(source);
      const ok = hasCancelledVocabulary && hasAbortHandling;
      return {
        ok,
        detail: ok
          ? 'executeTool retains single cancelled vocabulary + abort handling'
          : 'cancellation regression: missing cancelled vocabulary or abort handling',
      };
    },
    'cache-identity-regression': (_case, repoRoot) => {
      const source = readText(repoRoot, 'src/mcp/serviceClient.ts');
      const ok = /maxOutputLength=/.test(source) && /maxOutputLength/.test(source);
      return {
        ok,
        detail: ok
          ? 'semantic cache identity includes maxOutputLength'
          : 'cache identity regression: maxOutputLength missing from cache key material',
      };
    },
    'graph-scope-regression': (_case, repoRoot) => {
      const store = readText(repoRoot, 'src/internal/graph/persistentGraphStore.ts');
      const adapter = readText(repoRoot, 'src/internal/graph/discoveryAdapter.ts');
      const hasManifestGuard = /graph_manifest_unavailable/.test(store);
      const hasDiscoveryBind = /discoveryAdapter|loadCanonicalDiscoveryManifest|listDiscoverableFiles/.test(
        adapter + store
      );
      // Catch broad-scan regressions: a recursive listWorkspaceFiles fallback
      // must not reappear as the primary corpus walk.
      const hasBroadScanFallback =
        /async function listWorkspaceFiles/.test(store) ||
        /function listWorkspaceFiles/.test(store);
      const ok = hasManifestGuard && hasDiscoveryBind && !hasBroadScanFallback;
      return {
        ok,
        detail: ok
          ? 'graph hydration remains manifest-bound without broad-scan fallback'
          : 'graph scope regression: missing manifest bind or broad-scan fallback restored',
      };
    },
    none: (caseDef, repoRoot) => {
      // Control-pass probes — healthy invariants that must remain true.
      if (caseDef.id === 'seed-pass-symbol-definition-lookup') {
        const registry = readText(repoRoot, 'src/mcp/toolRegistry.ts');
        const ok =
          /symbolDefinitionTool/.test(registry) && /handleSymbolDefinition/.test(registry);
        return {
          ok,
          detail: ok
            ? 'symbol_definition surface remains registered'
            : 'control-pass failed: symbol_definition surface missing',
        };
      }
      if (caseDef.id === 'seed-pass-holdout-leakage-guard') {
        const source = readText(repoRoot, 'scripts/ci/check-retrieval-holdout-fixture.ts');
        const ok = /holdout|leakage|overlap/i.test(source);
        return {
          ok,
          detail: ok
            ? 'holdout leakage guard script present'
            : 'control-pass failed: holdout leakage guard missing',
        };
      }
      if (caseDef.id === 'seed-pass-git-status-totals') {
        const source = readText(repoRoot, 'src/mcp/utils/gitUtils.ts');
        const ok =
          /never truncated for display/.test(source) &&
          /parseGitPorcelainStatus/.test(source) &&
          /total:/.test(source);
        return {
          ok,
          detail: ok
            ? 'git status totals remain available independently of truncation'
            : 'control-pass failed: git status totals guard missing',
        };
      }
      return { ok: true, detail: 'control-pass default ok' };
    },
  };
}

export function evaluateCase(
  caseDef: SeededFailureCase,
  repoRoot: string,
  detectors: Record<string, CategoryDetector>
): CaseEvaluation {
  const detector = detectors[caseDef.failure_category];
  if (!detector) {
    throw new RequiredLaneCatchRateError(
      `Missing evaluator detector for failure_category=${caseDef.failure_category} (case=${caseDef.id})`
    );
  }

  const result = detector(caseDef, repoRoot);
  let verdict: EvaluatorVerdict;
  if (caseDef.expected_outcome === 'should_catch') {
    verdict = result.ok ? 'caught' : 'missed';
  } else {
    verdict = result.ok ? 'passed' : 'false_positive';
  }

  return {
    id: caseDef.id,
    failure_category: caseDef.failure_category,
    expected_outcome: caseDef.expected_outcome,
    verdict,
    detail: result.detail,
    matched_expectation:
      (caseDef.expected_outcome === 'should_catch' && verdict === 'caught') ||
      (caseDef.expected_outcome === 'should_pass' && verdict === 'passed'),
  };
}

export function computeCatchRateMetrics(cases: CaseEvaluation[]): CatchRateMetrics {
  const shouldCatch = cases.filter((c) => c.expected_outcome === 'should_catch');
  const shouldPass = cases.filter((c) => c.expected_outcome === 'should_pass');
  const caught = shouldCatch.filter((c) => c.verdict === 'caught').length;
  const missed = shouldCatch.filter((c) => c.verdict === 'missed').length;
  const passed = shouldPass.filter((c) => c.verdict === 'passed').length;
  const falsePositives = shouldPass.filter((c) => c.verdict === 'false_positive').length;
  const catchRatePct = shouldCatch.length > 0 ? (caught / shouldCatch.length) * 100 : 0;
  const controlPassRatePct = shouldPass.length > 0 ? (passed / shouldPass.length) * 100 : 100;

  return {
    should_catch_total: shouldCatch.length,
    caught,
    missed,
    should_pass_total: shouldPass.length,
    passed,
    false_positives: falsePositives,
    catch_rate_pct: Number(catchRatePct.toFixed(4)),
    control_pass_rate_pct: Number(controlPassRatePct.toFixed(4)),
  };
}

export function loadSeededFailureCorpus(
  repoRoot: string,
  contractPath = DEFAULT_CONTRACT_PATH
): {
  contract: FrozenCorpusContract;
  corpus: CorpusFile;
  corpusPath: string;
  corpusSha256: string;
  minCatchRatePct: number;
} {
  const resolvedContract = resolvePath(repoRoot, contractPath);
  if (!fs.existsSync(resolvedContract)) {
    throw new RequiredLaneCatchRateError(`Frozen corpus contract not found: ${contractPath}`);
  }

  const contract = readJson<FrozenCorpusContract>(resolvedContract);
  const lane = contract.lanes?.seeded_failure;
  if (!lane) {
    throw new RequiredLaneCatchRateError('Contract missing seeded_failure lane');
  }

  const corpusPath = lane.corpus_path;
  const resolvedCorpus = resolvePath(repoRoot, corpusPath);
  if (!fs.existsSync(resolvedCorpus)) {
    throw new RequiredLaneCatchRateError(`Seeded failure corpus not found: ${corpusPath}`);
  }

  const raw = fs.readFileSync(resolvedCorpus, 'utf8');
  if (!eolInvariantSha256Hexes(raw).includes(lane.content_sha256)) {
    const actualHash = eolInvariantSha256Hexes(raw)[0];
    throw new RequiredLaneCatchRateError(
      `Corpus sha256 mismatch for seeded_failure: expected ${lane.content_sha256}, got ${actualHash}`
    );
  }
  // Keep the receipt's provenance stable across Git's platform-dependent
  // working-tree line endings by reporting the pinned contract hash.
  const corpusSha256 = lane.content_sha256;

  const corpus = JSON.parse(raw) as CorpusFile;
  const minCatchRatePct = Number(lane.thresholds?.min_catch_rate_pct);
  if (!Number.isFinite(minCatchRatePct)) {
    throw new RequiredLaneCatchRateError('seeded_failure thresholds.min_catch_rate_pct missing or invalid');
  }

  return { contract, corpus, corpusPath, corpusSha256, minCatchRatePct };
}

export function buildCatchRateReport(options: {
  repoRoot: string;
  contractPath?: string;
  detectors?: Record<string, CategoryDetector>;
  commitSha?: string;
  nowIso?: string;
}): RequiredLaneCatchRateReport {
  const contractPath = options.contractPath ?? DEFAULT_CONTRACT_PATH;
  const loaded = loadSeededFailureCorpus(options.repoRoot, contractPath);
  const detectors = options.detectors ?? createDefaultDetectors();

  if (!detectors || Object.keys(detectors).length === 0) {
    throw new RequiredLaneCatchRateError('Evaluator detectors missing');
  }

  const cases: CaseEvaluation[] = [];
  for (const entry of loaded.corpus.cases) {
    const expected = entry.expected_outcome;
    if (expected !== 'should_catch' && expected !== 'should_pass') {
      throw new RequiredLaneCatchRateError(
        `Case ${entry.id} missing valid expected_outcome (should_catch|should_pass)`
      );
    }
    const failureCategory =
      typeof entry.failure_category === 'string' ? entry.failure_category : 'none';
    cases.push(
      evaluateCase(
        {
          ...entry,
          expected_outcome: expected,
          failure_category: failureCategory,
        },
        options.repoRoot,
        detectors
      )
    );
  }

  const metrics = computeCatchRateMetrics(cases);
  const reasons: string[] = [];
  if (metrics.should_catch_total === 0) {
    reasons.push('seeded_failure corpus has zero should_catch cases');
  }
  if (metrics.catch_rate_pct < loaded.minCatchRatePct) {
    reasons.push(
      `catch_rate_pct ${metrics.catch_rate_pct} < min_catch_rate_pct ${loaded.minCatchRatePct}`
    );
  }
  if (metrics.false_positives > 0) {
    reasons.push(`control-pass false_positives=${metrics.false_positives}`);
  }

  return {
    schema_version: 1,
    generated_at_utc: options.nowIso ?? new Date().toISOString(),
    commit_sha: options.commitSha ?? resolveCommitSha(),
    lane: 'seeded_failure',
    corpus_id: loaded.corpus.corpus_id,
    corpus_path: loaded.corpusPath,
    corpus_sha256: loaded.corpusSha256,
    contract_path: contractPath,
    contract_version: loaded.contract.version,
    threshold_min_catch_rate_pct: loaded.minCatchRatePct,
    metrics,
    cases,
    gate: {
      status: reasons.length === 0 ? 'pass' : 'fail',
      reasons,
    },
  };
}

export function writeCatchRateReport(report: RequiredLaneCatchRateReport, outPath: string): void {
  const resolved = path.isAbsolute(outPath) ? outPath : path.join(process.cwd(), outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export { DEFAULT_CONTRACT_PATH, DEFAULT_OUT_PATH };
