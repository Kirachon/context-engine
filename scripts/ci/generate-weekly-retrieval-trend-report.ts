#!/usr/bin/env node
/**
 * Generate weekly retrieval trend artifact from bench artifacts.
 *
 * Exit codes:
 * - 0: artifact generated
 * - 2: usage/parsing/input error
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

type CheckStatus = 'PASS' | 'FAIL';
type TrendStatus = 'PASS' | 'FAIL';

interface CliArgs {
  parityPath: string;
  qualityPath: string;
  outPath: string;
  archiveDir: string;
  retentionWeeks: number;
  periodKey?: string;
}

interface TrendCheck {
  id: string;
  status: CheckStatus;
  source: string;
  message: string;
}

interface WeeklyTrendArtifact {
  schema_version: 1;
  generated_at_utc: string;
  status: TrendStatus;
  period: {
    key: string;
    start_utc: string;
    end_utc_exclusive: string;
  };
  summary: {
    headline: string;
    pass_checks: number;
    fail_checks: number;
    retention_archive_note: string;
  };
  metrics: {
    strict_parity_score: number;
    quality_pass_rate: number;
    ndcg_delta_pct: number;
    mrr_delta_pct: number;
    recall_delta_pct: number;
  };
  checks: TrendCheck[];
  retention: {
    policy: string;
    retained_period_count: number;
    retention_archive_note: string;
  };
  inputs: {
    parity_artifact_path: string;
    quality_artifact_path: string;
    parity_artifact_sha256: string;
    quality_artifact_sha256: string;
    out_path: string;
    archive_dir: string;
  };
}

const DEFAULT_PARITY_PATH = path.join('artifacts', 'bench', 'auggie-capability-parity-gate.json');
const DEFAULT_QUALITY_PATH = path.join('artifacts', 'bench', 'retrieval-quality-report.json');
const DEFAULT_OUT_PATH = path.join('artifacts', 'bench', 'r4-weekly-trend.json');
const DEFAULT_ARCHIVE_DIR = path.join('artifacts', 'bench', 'archive', 'r4-weekly');
const DEFAULT_RETENTION_WEEKS = 12;
const PERIOD_KEY_REGEX = /^\d{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$/;

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/generate-weekly-retrieval-trend-report.ts [options]

Options:
  --parity <path>          Parity gate artifact path (default: ${DEFAULT_PARITY_PATH})
  --quality <path>         Retrieval quality artifact path (default: ${DEFAULT_QUALITY_PATH})
  --out <path>             Output artifact path (default: ${DEFAULT_OUT_PATH})
  --archive-dir <path>     Archive directory (default: ${DEFAULT_ARCHIVE_DIR})
  --retention-weeks <n>    Rolling retention window (default: ${DEFAULT_RETENTION_WEEKS})
  --period-key <YYYY-Www>  Explicit ISO week period key override
`);
  process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    parityPath: DEFAULT_PARITY_PATH,
    qualityPath: DEFAULT_QUALITY_PATH,
    outPath: DEFAULT_OUT_PATH,
    archiveDir: DEFAULT_ARCHIVE_DIR,
    retentionWeeks: DEFAULT_RETENTION_WEEKS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }
    if (arg === '--parity') {
      if (!next) throw new Error('Missing value for --parity');
      args.parityPath = next;
      i += 1;
      continue;
    }
    if (arg === '--quality') {
      if (!next) throw new Error('Missing value for --quality');
      args.qualityPath = next;
      i += 1;
      continue;
    }
    if (arg === '--out') {
      if (!next) throw new Error('Missing value for --out');
      args.outPath = next;
      i += 1;
      continue;
    }
    if (arg === '--archive-dir') {
      if (!next) throw new Error('Missing value for --archive-dir');
      args.archiveDir = next;
      i += 1;
      continue;
    }
    if (arg === '--retention-weeks') {
      if (!next) throw new Error('Missing value for --retention-weeks');
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error('--retention-weeks must be an integer >= 1');
      }
      args.retentionWeeks = parsed;
      i += 1;
      continue;
    }
    if (arg === '--period-key') {
      if (!next) throw new Error('Missing value for --period-key');
      if (!PERIOD_KEY_REGEX.test(next)) {
        throw new Error(`Invalid --period-key: ${next}`);
      }
      args.periodKey = next;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function toRepoRelativePath(absolutePath: string): string {
  const rel = path.relative(process.cwd(), absolutePath);
  return rel && !rel.startsWith('..') ? rel.replace(/\\/g, '/') : absolutePath.replace(/\\/g, '/');
}

function readJsonObject(filePath: string): Record<string, unknown> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Artifact not found: ${resolved}`);
  }
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Artifact must be a JSON object: ${resolved}`);
  }
  return parsed as Record<string, unknown>;
}

function readFileSha256(filePath: string): string {
  const source = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(source).digest('hex');
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function getNumberAtPath(source: Record<string, unknown>, pathTokens: string[]): number | null {
  let cursor: unknown = source;
  for (const token of pathTokens) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
      return null;
    }
    cursor = (cursor as Record<string, unknown>)[token];
  }
  return asFiniteNumber(cursor);
}

function getEvaluationValue(report: Record<string, unknown>, id: string): number | null {
  const evaluations = report.evaluations;
  if (!Array.isArray(evaluations)) {
    return null;
  }
  const match = evaluations.find((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    return (entry as Record<string, unknown>).id === id;
  });
  if (!match || typeof match !== 'object' || Array.isArray(match)) {
    return null;
  }
  return asFiniteNumber((match as Record<string, unknown>).value);
}

function getIsoWeekPeriod(now: Date): { key: string; startUtc: Date; endUtcExclusive: Date } {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - 3);
  monday.setUTCHours(0, 0, 0, 0);
  const endExclusive = new Date(monday);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 7);
  return {
    key: `${isoYear}-W${String(week).padStart(2, '0')}`,
    startUtc: monday,
    endUtcExclusive: endExclusive,
  };
}

function getIsoWeekPeriodFromKey(periodKey: string): { key: string; startUtc: Date; endUtcExclusive: Date } {
  const match = /^(\d{4})-W(\d{2})$/.exec(periodKey);
  if (!match) {
    throw new Error(`Invalid period key: ${periodKey}`);
  }
  const year = Number.parseInt(match[1], 10);
  const week = Number.parseInt(match[2], 10);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4IsoDay = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4IsoDay - 1));
  week1Monday.setUTCHours(0, 0, 0, 0);
  const startUtc = new Date(week1Monday);
  startUtc.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  const endUtcExclusive = new Date(startUtc);
  endUtcExclusive.setUTCDate(startUtc.getUTCDate() + 7);
  return { key: periodKey, startUtc, endUtcExclusive };
}

function findExistingPeriodEntries(archiveDir: string, periodKey: string): string[] {
  if (!fs.existsSync(archiveDir)) return [];
  const entries = fs.readdirSync(archiveDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name.startsWith('r4-weekly-trend-'))
    .map((entry) => path.join(archiveDir, entry.name));

  const matches: string[] = [];
  for (const filePath of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const period = (parsed as Record<string, unknown>).period;
      if (!period || typeof period !== 'object' || Array.isArray(period)) continue;
      if ((period as Record<string, unknown>).key === periodKey) {
        matches.push(filePath);
      }
    } catch {
      // ignore malformed archive entries during duplicate scan
    }
  }
  return matches;
}

function enforceRetention(archiveDir: string, retentionWeeks: number, currentPeriodKey: string): number {
  if (!fs.existsSync(archiveDir)) return 0;
  const entries = fs.readdirSync(archiveDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name.startsWith('r4-weekly-trend-'))
    .map((entry) => path.join(archiveDir, entry.name));

  const passArtifacts: Array<{ filePath: string; periodKey: string }> = [];
  for (const filePath of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const obj = parsed as Record<string, unknown>;
      if (obj.status !== 'PASS') continue;
      const period = obj.period;
      if (!period || typeof period !== 'object' || Array.isArray(period)) continue;
      const periodKey = (period as Record<string, unknown>).key;
      if (typeof periodKey !== 'string' || !PERIOD_KEY_REGEX.test(periodKey)) continue;
      passArtifacts.push({ filePath, periodKey });
    } catch {
      // ignore malformed archive entries during retention
    }
  }

  passArtifacts.sort((a, b) => b.periodKey.localeCompare(a.periodKey));
  const keep = new Set(
    passArtifacts
      .slice(0, retentionWeeks)
      .map((entry) => entry.filePath)
  );

  for (const entry of passArtifacts.slice(retentionWeeks)) {
    if (entry.periodKey === currentPeriodKey) continue;
    fs.unlinkSync(entry.filePath);
  }

  return Math.min(passArtifacts.length, retentionWeeks);
}

function run(): number {
  try {
    const args = parseArgs(process.argv.slice(2));
    const parityPath = path.resolve(args.parityPath);
    const qualityPath = path.resolve(args.qualityPath);
    const outPath = path.resolve(args.outPath);
    const archiveDir = path.resolve(args.archiveDir);
    const now = new Date();

    const period = args.periodKey ? getIsoWeekPeriodFromKey(args.periodKey) : getIsoWeekPeriod(now);

    const parity = readJsonObject(parityPath);
    const quality = readJsonObject(qualityPath);

    const parityPathForArtifact = toRepoRelativePath(parityPath);
    const qualityPathForArtifact = toRepoRelativePath(qualityPath);
    const outPathForArtifact = toRepoRelativePath(outPath);
    const archiveDirForArtifact = toRepoRelativePath(archiveDir);

    const checks: TrendCheck[] = [];
    const strictParityScore = getNumberAtPath(parity, ['overall_score']);
    checks.push({
      id: 'metric.strict_parity_score',
      status: strictParityScore === null ? 'FAIL' : 'PASS',
      source: parityPathForArtifact,
      message: strictParityScore === null ? 'Missing numeric overall_score' : `overall_score=${strictParityScore}`,
    });

    const qualityPassRate = getNumberAtPath(quality, ['summary', 'pass_rate']);
    checks.push({
      id: 'metric.quality_pass_rate',
      status: qualityPassRate === null ? 'FAIL' : 'PASS',
      source: qualityPathForArtifact,
      message: qualityPassRate === null ? 'Missing numeric summary.pass_rate' : `summary.pass_rate=${qualityPassRate}`,
    });

    const ndcgDeltaPct = getEvaluationValue(quality, 'quality.ndcg_at_10');
    checks.push({
      id: 'metric.ndcg_delta_pct',
      status: ndcgDeltaPct === null ? 'FAIL' : 'PASS',
      source: qualityPathForArtifact,
      message: ndcgDeltaPct === null ? 'Missing evaluation value for quality.ndcg_at_10' : `quality.ndcg_at_10=${ndcgDeltaPct}`,
    });

    const mrrDeltaPct = getEvaluationValue(quality, 'quality.mrr_at_10');
    checks.push({
      id: 'metric.mrr_delta_pct',
      status: mrrDeltaPct === null ? 'FAIL' : 'PASS',
      source: qualityPathForArtifact,
      message: mrrDeltaPct === null ? 'Missing evaluation value for quality.mrr_at_10' : `quality.mrr_at_10=${mrrDeltaPct}`,
    });

    const recallDeltaPct = getEvaluationValue(quality, 'quality.recall_at_50');
    checks.push({
      id: 'metric.recall_delta_pct',
      status: recallDeltaPct === null ? 'FAIL' : 'PASS',
      source: qualityPathForArtifact,
      message: recallDeltaPct === null ? 'Missing evaluation value for quality.recall_at_50' : `quality.recall_at_50=${recallDeltaPct}`,
    });

    const periodConflicts = findExistingPeriodEntries(archiveDir, period.key);
    checks.push({
      id: 'archive.duplicate_period',
      status: periodConflicts.length > 0 ? 'FAIL' : 'PASS',
      source: archiveDirForArtifact,
      message: periodConflicts.length > 0
        ? `Duplicate period entries detected for ${period.key}: ${periodConflicts.length}`
        : `Period ${period.key} duplicate scan passed`,
    });

    const passChecks = checks.filter((check) => check.status === 'PASS').length;
    const failChecks = checks.length - passChecks;
    const retentionNote = `Archived under ${archiveDirForArtifact} with rolling_${args.retentionWeeks}_weeks retention policy.`;
    const status: TrendStatus = failChecks === 0 ? 'PASS' : 'FAIL';

    const artifact: WeeklyTrendArtifact = {
      schema_version: 1,
      generated_at_utc: now.toISOString(),
      status,
      period: {
        key: period.key,
        start_utc: period.startUtc.toISOString(),
        end_utc_exclusive: period.endUtcExclusive.toISOString(),
      },
      summary: {
        headline: `R4 weekly retrieval trend (${period.key})`,
        pass_checks: passChecks,
        fail_checks: failChecks,
        retention_archive_note: retentionNote,
      },
      metrics: {
        strict_parity_score: strictParityScore ?? 0,
        quality_pass_rate: qualityPassRate ?? 0,
        ndcg_delta_pct: ndcgDeltaPct ?? 0,
        mrr_delta_pct: mrrDeltaPct ?? 0,
        recall_delta_pct: recallDeltaPct ?? 0,
      },
      checks,
      retention: {
        policy: `rolling_${args.retentionWeeks}_weeks`,
        retained_period_count: 0,
        retention_archive_note: retentionNote,
      },
      inputs: {
        parity_artifact_path: parityPathForArtifact,
        quality_artifact_path: qualityPathForArtifact,
        parity_artifact_sha256: readFileSha256(parityPath),
        quality_artifact_sha256: readFileSha256(qualityPath),
        out_path: outPathForArtifact,
        archive_dir: archiveDirForArtifact,
      },
    };

    fs.mkdirSync(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, `r4-weekly-trend-${period.key}.json`);
    if (fs.existsSync(archivePath)) {
      const existing = JSON.parse(fs.readFileSync(archivePath, 'utf8')) as unknown;
      const existingObj =
        existing && typeof existing === 'object' && !Array.isArray(existing)
          ? (existing as Record<string, unknown>)
          : null;
      const sameInputs =
        existingObj?.period &&
        typeof existingObj.period === 'object' &&
        !Array.isArray(existingObj.period) &&
        (existingObj.period as Record<string, unknown>).key === period.key &&
        existingObj?.inputs &&
        typeof existingObj.inputs === 'object' &&
        !Array.isArray(existingObj.inputs) &&
        (existingObj.inputs as Record<string, unknown>).parity_artifact_sha256 ===
          artifact.inputs.parity_artifact_sha256 &&
        (existingObj.inputs as Record<string, unknown>).quality_artifact_sha256 ===
          artifact.inputs.quality_artifact_sha256;

      if (sameInputs) {
        ensureParentDir(outPath);
        fs.writeFileSync(outPath, fs.readFileSync(archivePath, 'utf8'), 'utf8');
        // eslint-disable-next-line no-console
        console.log(`r4_weekly_trend skip period=${period.key} reason=duplicate_identical_inputs out=${outPath}`);
        return 0;
      }
      throw new Error(`Duplicate period conflict for ${period.key}: existing archive entry differs from current inputs.`);
    }

    ensureParentDir(outPath);
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8');
    fs.copyFileSync(outPath, archivePath);

    const retainedPeriodCount = enforceRetention(archiveDir, args.retentionWeeks, period.key);
    artifact.retention.retained_period_count = retainedPeriodCount;
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8');
    fs.copyFileSync(outPath, archivePath);

    // eslint-disable-next-line no-console
    console.log(`r4_weekly_trend generated status=${artifact.status} period=${period.key} out=${outPath}`);
    return 0;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Error: ${(error as Error).message}`);
    return 2;
  }
}

process.exitCode = run();
