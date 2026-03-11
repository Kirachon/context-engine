#!/usr/bin/env node
/**
 * Auggie capability parity checker.
 *
 * Exit codes:
 * - 0: gate passed
 * - 1: gate failed
 * - 2: usage/parsing error
 */

import * as fs from 'fs';
import * as path from 'path';

type EvalStatus = 'pass' | 'fail' | 'skip';
type GateStatus = 'pass' | 'fail';

interface CliArgs {
  reportPath: string;
  matrixPath: string;
  outPath: string;
  requireConsecutive?: number;
  historyDir?: string;
}

interface Evaluation {
  id: string;
  status: EvalStatus;
}

interface RetrievalParityReport {
  evaluations?: Evaluation[];
  gate?: {
    status?: string;
  };
}

interface MatrixJourney {
  id: string;
  domain?: string;
  weight?: number;
  metric_refs: string[];
  critical?: boolean;
}

interface MatrixConfig {
  journeys?: MatrixJourney[];
  weights?: Record<string, number>;
  gate_rules?: {
    min_overall_score?: number;
    critical_required?: number;
  };
  critical_journeys?: string[];
}

interface JourneyScore {
  journey_id: string;
  domain: string;
  score: number;
  pass_count: number;
  considered_count: number;
  weight: number;
  critical: boolean;
}

interface HistoryCheckResult {
  enabled: boolean;
  required?: number;
  checked?: number;
  status?: GateStatus;
  files?: string[];
  reason?: string;
}

interface OutputArtifact {
  schema_version: number;
  generated_at: string;
  inputs: {
    report: string;
    matrix: string;
    out: string;
    history_dir?: string;
    require_consecutive?: number;
  };
  min_overall_score: number;
  critical_required_score: number;
  domain_scores: Array<{ domain: string; score: number; domain_weight: number }>;
  journey_scores: JourneyScore[];
  overall_score: number;
  critical_failures: Array<{ journey_id: string; score: number }>;
  history_check: HistoryCheckResult;
  gate: {
    status: GateStatus;
    reasons: string[];
  };
}

const DEFAULT_MATRIX_PATH = path.join('config', 'ci', 'auggie-capability-matrix.json');
const DEFAULT_OUT_PATH = path.join('artifacts', 'bench', 'auggie-capability-parity-gate.json');

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/check-auggie-capability-parity.ts --report <path> [--matrix <path>] [--out <path>] [--require-consecutive <n> --history-dir <dir>]

Options:
  --report <path>           Retrieval parity report JSON (required)
  --matrix <path>           Capability matrix JSON (default: ${DEFAULT_MATRIX_PATH})
  --out <path>              Output artifact path (default: ${DEFAULT_OUT_PATH})
  --require-consecutive <n> Require latest n history artifacts to have gate.status=pass
  --history-dir <dir>       Directory with historical report artifacts
`);
  process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    reportPath: '',
    matrixPath: DEFAULT_MATRIX_PATH,
    outPath: DEFAULT_OUT_PATH,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }
    if (arg === '--report') {
      if (!next) throw new Error('Missing value for --report');
      args.reportPath = next;
      i += 1;
      continue;
    }
    if (arg === '--matrix') {
      if (!next) throw new Error('Missing value for --matrix');
      args.matrixPath = next;
      i += 1;
      continue;
    }
    if (arg === '--out') {
      if (!next) throw new Error('Missing value for --out');
      args.outPath = next;
      i += 1;
      continue;
    }
    if (arg === '--require-consecutive') {
      if (!next) throw new Error('Missing value for --require-consecutive');
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--require-consecutive must be a positive integer');
      }
      args.requireConsecutive = parsed;
      i += 1;
      continue;
    }
    if (arg === '--history-dir') {
      if (!next) throw new Error('Missing value for --history-dir');
      args.historyDir = next;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.reportPath) {
    throw new Error('--report is required');
  }
  if ((args.requireConsecutive != null && !args.historyDir) || (args.requireConsecutive == null && args.historyDir)) {
    throw new Error('--require-consecutive and --history-dir must be provided together');
  }

  return args;
}

function readJsonFile(filePath: string): unknown {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, 'utf8');
  return JSON.parse(raw) as unknown;
}

function asObject(value: unknown, errorMessage: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(errorMessage);
  }
  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asEvalStatus(value: unknown): EvalStatus | undefined {
  if (value === 'pass' || value === 'fail' || value === 'skip') {
    return value;
  }
  return undefined;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function normalizeReport(reportRaw: unknown): RetrievalParityReport {
  const reportObj = asObject(reportRaw, 'Report must be a JSON object');
  const evaluationsRaw = reportObj.evaluations;
  const gateRaw = reportObj.gate;

  const evaluations: Evaluation[] = Array.isArray(evaluationsRaw)
    ? evaluationsRaw
        .map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return undefined;
          }
          const id = (item as Record<string, unknown>).id;
          const status = asEvalStatus((item as Record<string, unknown>).status);
          if (typeof id !== 'string' || !status) {
            return undefined;
          }
          return { id, status };
        })
        .filter((item): item is Evaluation => Boolean(item))
    : [];

  let gate: RetrievalParityReport['gate'];
  if (gateRaw && typeof gateRaw === 'object' && !Array.isArray(gateRaw)) {
    const status = (gateRaw as Record<string, unknown>).status;
    gate = typeof status === 'string' ? { status } : undefined;
  }

  return { evaluations, gate };
}

function normalizeMatrix(matrixRaw: unknown): {
  journeys: MatrixJourney[];
  weights: Record<string, number>;
  minOverall: number;
  criticalRequired: number;
} {
  const matrixObj = asObject(matrixRaw, 'Matrix must be a JSON object');
  const journeysRaw = matrixObj.journeys;
  const weightsRaw = matrixObj.weights;
  const gateRulesRaw = matrixObj.gate_rules;

  if (!Array.isArray(journeysRaw)) {
    throw new Error('Matrix missing journeys[]');
  }
  const journeys: MatrixJourney[] = journeysRaw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Invalid journey at index ${index}`);
    }
    const obj = item as Record<string, unknown>;
    const id = obj.id;
    const metricRefs = obj.metric_refs;
    if (typeof id !== 'string' || !Array.isArray(metricRefs) || !metricRefs.every((ref) => typeof ref === 'string')) {
      throw new Error(`Journey ${index} must include id:string and metric_refs:string[]`);
    }
    return {
      id,
      domain: typeof obj.domain === 'string' && obj.domain.trim().length > 0 ? obj.domain.trim() : id,
      weight: asFiniteNumber(obj.weight) ?? 1,
      metric_refs: metricRefs as string[],
      critical: obj.critical === true,
    };
  });

  if (!weightsRaw || typeof weightsRaw !== 'object' || Array.isArray(weightsRaw)) {
    throw new Error('Matrix missing weights object');
  }
  const weightsObj = weightsRaw as Record<string, unknown>;
  const weights: Record<string, number> = {};
  for (const [key, value] of Object.entries(weightsObj)) {
    const numeric = asFiniteNumber(value);
    if (numeric == null || numeric < 0) {
      throw new Error(`Invalid weight for journey "${key}"`);
    }
    weights[key] = numeric;
  }

  const gateRulesObj = gateRulesRaw && typeof gateRulesRaw === 'object' && !Array.isArray(gateRulesRaw)
    ? (gateRulesRaw as Record<string, unknown>)
    : undefined;
  const minOverall = asFiniteNumber(gateRulesObj?.min_overall_score) ?? 0;
  const criticalRequired = asFiniteNumber(gateRulesObj?.critical_required) ?? 100;
  const criticalJourneys = Array.isArray(matrixObj.critical_journeys)
    ? (matrixObj.critical_journeys as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];

  const mergedJourneys = journeys.map((journey) => ({
    ...journey,
    critical: journey.critical === true || criticalJourneys.includes(journey.id),
  }));

  return { journeys: mergedJourneys, weights, minOverall, criticalRequired };
}

function scoreJourney(journey: MatrixJourney, evaluationsById: Map<string, EvalStatus>): JourneyScore {
  let passCount = 0;
  let consideredCount = 0;

  for (const metricRefRaw of journey.metric_refs) {
    const isOptional = metricRefRaw.startsWith('optional:');
    const metricRef = isOptional ? metricRefRaw.slice('optional:'.length) : metricRefRaw;
    const status = evaluationsById.get(metricRef);

    if (status == null) {
      if (!isOptional) {
        consideredCount += 1;
      }
      continue;
    }

    if (status === 'skip' && isOptional) {
      continue;
    }

    consideredCount += 1;
    if (status === 'pass') {
      passCount += 1;
    }
  }

  const score = consideredCount > 0 ? (passCount / consideredCount) * 100 : 0;
  return {
    journey_id: journey.id,
    domain: journey.domain ?? journey.id,
    score,
    pass_count: passCount,
    considered_count: consideredCount,
    weight: journey.weight ?? 1,
    critical: journey.critical === true,
  };
}

function computeDomainScores(
  journeyScores: JourneyScore[],
  domainWeights: Record<string, number>
): Array<{ domain: string; score: number; domain_weight: number }> {
  const domainGroups = new Map<string, JourneyScore[]>();
  for (const score of journeyScores) {
    const domain = score.domain;
    const existing = domainGroups.get(domain) ?? [];
    existing.push(score);
    domainGroups.set(domain, existing);
  }

  const domainScores: Array<{ domain: string; score: number; domain_weight: number }> = [];
  for (const [domain, scores] of domainGroups.entries()) {
    const totalJourneyWeight = scores.reduce((acc, item) => acc + (item.weight > 0 ? item.weight : 0), 0);
    const weightedScore = totalJourneyWeight > 0
      ? scores.reduce((acc, item) => acc + (item.score * (item.weight > 0 ? item.weight : 0)), 0) / totalJourneyWeight
      : scores.reduce((acc, item) => acc + item.score, 0) / Math.max(scores.length, 1);
    domainScores.push({
      domain,
      score: weightedScore,
      domain_weight: domainWeights[domain] ?? 0,
    });
  }

  domainScores.sort((a, b) => a.domain.localeCompare(b.domain));
  return domainScores;
}

function computeOverall(domainScores: Array<{ domain: string; score: number; domain_weight: number }>): number {
  const weightedDomains = domainScores.filter((item) => item.domain_weight > 0);
  if (weightedDomains.length === 0) {
    if (domainScores.length === 0) {
      return 0;
    }
    return domainScores.reduce((acc, item) => acc + item.score, 0) / domainScores.length;
  }

  const totalWeight = weightedDomains.reduce((acc, item) => acc + item.domain_weight, 0);
  if (totalWeight <= 0) {
    return 0;
  }

  const weightedSum = weightedDomains.reduce((acc, item) => acc + (item.score * item.domain_weight), 0);
  return weightedSum / totalWeight;
}

function checkConsecutiveHistory(historyDir: string, required: number): HistoryCheckResult {
  const resolvedDir = path.resolve(historyDir);
  if (!fs.existsSync(resolvedDir)) {
    return {
      enabled: true,
      required,
      checked: 0,
      status: 'fail',
      reason: `History directory not found: ${resolvedDir}`,
      files: [],
    };
  }

  const allJsonFiles = fs
    .readdirSync(resolvedDir)
    .filter((file) => file.toLowerCase().endsWith('.json'))
    .map((file) => {
      const fullPath = path.join(resolvedDir, file);
      const stat = fs.statSync(fullPath);
      return {
        fullPath,
        file,
        mtimeMs: stat.mtimeMs,
      };
    })
    .sort((a, b) => {
      if (b.mtimeMs !== a.mtimeMs) {
        return b.mtimeMs - a.mtimeMs;
      }
      return b.file.localeCompare(a.file);
    });

  if (allJsonFiles.length < required) {
    return {
      enabled: true,
      required,
      checked: allJsonFiles.length,
      status: 'fail',
      reason: `Insufficient history artifacts: found ${allJsonFiles.length}, required ${required}`,
      files: allJsonFiles.map((entry) => entry.fullPath),
    };
  }

  const latest = allJsonFiles.slice(0, required);
  const failingFile = latest.find((entry) => {
    try {
      const parsed = readJsonFile(entry.fullPath);
      const obj = asObject(parsed, `History artifact must be an object: ${entry.fullPath}`);
      const gateObj = obj.gate;
      if (!gateObj || typeof gateObj !== 'object' || Array.isArray(gateObj)) {
        return true;
      }
      const status = (gateObj as Record<string, unknown>).status;
      return status !== 'pass';
    } catch {
      return true;
    }
  });

  if (failingFile) {
    return {
      enabled: true,
      required,
      checked: required,
      status: 'fail',
      reason: `History gate check failed for ${failingFile.fullPath}`,
      files: latest.map((entry) => entry.fullPath),
    };
  }

  return {
    enabled: true,
    required,
    checked: required,
    status: 'pass',
    files: latest.map((entry) => entry.fullPath),
  };
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    printHelpAndExit(2);
  }

  try {
    const report = normalizeReport(readJsonFile(args.reportPath));
    const matrix = normalizeMatrix(readJsonFile(args.matrixPath));

    const evaluationsById = new Map<string, EvalStatus>();
    for (const evaluation of report.evaluations ?? []) {
      evaluationsById.set(evaluation.id, evaluation.status);
    }

    const journeyScores = matrix.journeys.map((journey) => scoreJourney(journey, evaluationsById));
    const domainScores = computeDomainScores(journeyScores, matrix.weights);
    const overallScore = computeOverall(domainScores);

    const criticalFailures = journeyScores
      .filter((item) => item.critical && item.score < matrix.criticalRequired)
      .map((item) => ({ journey_id: item.journey_id, score: item.score }));

    const reasons: string[] = [];
    if (overallScore < matrix.minOverall) {
      reasons.push(`overall_score ${overallScore.toFixed(2)} below min_overall_score ${matrix.minOverall.toFixed(2)}`);
    }
    if (criticalFailures.length > 0) {
      reasons.push(
        `critical journeys below ${matrix.criticalRequired}: ${criticalFailures.map((item) => item.journey_id).join(', ')}`
      );
    }

    let historyCheck: HistoryCheckResult = { enabled: false };
    if (args.requireConsecutive != null && args.historyDir) {
      historyCheck = checkConsecutiveHistory(args.historyDir, args.requireConsecutive);
      if (historyCheck.status !== 'pass') {
        reasons.push(historyCheck.reason ?? 'history check failed');
      }
    }

    const gateStatus: GateStatus = reasons.length === 0 ? 'pass' : 'fail';
    const outPath = path.resolve(args.outPath);

    const artifact: OutputArtifact = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      inputs: {
        report: path.resolve(args.reportPath),
        matrix: path.resolve(args.matrixPath),
        out: outPath,
        history_dir: args.historyDir ? path.resolve(args.historyDir) : undefined,
        require_consecutive: args.requireConsecutive,
      },
      min_overall_score: matrix.minOverall,
      critical_required_score: matrix.criticalRequired,
      domain_scores: domainScores,
      journey_scores: journeyScores,
      overall_score: overallScore,
      critical_failures: criticalFailures,
      history_check: historyCheck,
      gate: {
        status: gateStatus,
        reasons,
      },
    };

    ensureParentDir(outPath);
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8');

    // eslint-disable-next-line no-console
    console.log(`out=${outPath}`);
    // eslint-disable-next-line no-console
    console.log(`overall_score=${overallScore.toFixed(2)}`);
    // eslint-disable-next-line no-console
    console.log(`gate_status=${gateStatus}`);

    process.exit(gateStatus === 'pass' ? 0 : 1);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

main();
