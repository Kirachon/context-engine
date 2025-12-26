import type { ParsedDiff } from '../../mcp/types/codeReview.js';

export interface PreflightResult {
  changed_files: string[];
  hotspots: string[];
  public_api_changed: boolean;
  config_changed: boolean;
  tests_touched: boolean;
  is_binary_change: boolean;
  risk_score: number;
  raw_risk_score: number;
  deterministic_checks_executed: number;
}

const CONFIG_PATTERNS: RegExp[] = [
  /^package\.json$/i,
  /^package-lock\.json$/i,
  /^tsconfig(\..+)?\.json$/i,
  /^\.github\//i,
  /^dockerfile$/i,
  /^docker\//i,
  /^scripts\//i,
  /\.ya?ml$/i,
];

const TEST_PATTERNS: RegExp[] = [
  /^tests\//i,
  /\/__tests__\//i,
  /\.test\.[jt]s$/i,
  /\.spec\.[jt]s$/i,
];

const HOTZONE_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: 'src/mcp', pattern: /^src\/mcp\//i },
  { id: 'src/reactive', pattern: /^src\/reactive\//i },
  { id: 'src/internal', pattern: /^src\/internal\//i },
  { id: 'src/http', pattern: /^src\/http\//i },
  { id: 'auth', pattern: /(^|\/)(auth|oauth|jwt|token)(\/|$)/i },
  { id: 'security', pattern: /(^|\/)(security|crypto|tls|ssl)(\/|$)/i },
];

function isConfigPath(filePath: string): boolean {
  return CONFIG_PATTERNS.some(r => r.test(filePath));
}

function isTestPath(filePath: string): boolean {
  return TEST_PATTERNS.some(r => r.test(filePath));
}

function detectPublicApiChange(parsedDiff: ParsedDiff, changedFiles: string[]): boolean {
  if (changedFiles.some(p => /^src\/index\.ts$/i.test(p))) return true;
  if (changedFiles.some(p => /^src\/mcp\/tools\//i.test(p))) return true;

  const changedLines = parsedDiff.files
    .flatMap(f => f.hunks.flatMap(h => h.lines))
    .filter(l => l.type === 'add' || l.type === 'remove')
    .map(l => l.content);

  return changedLines.some(line =>
    /^\s*(export\s+|module\.exports\b|exports\.)/i.test(line)
  );
}

function detectHotspots(changedFiles: string[]): string[] {
  const hits = new Set<string>();
  for (const filePath of changedFiles) {
    for (const { id, pattern } of HOTZONE_PATTERNS) {
      if (pattern.test(filePath)) hits.add(id);
    }
  }
  return Array.from(hits).sort();
}

export function runDeterministicPreflight(parsedDiff: ParsedDiff, providedChangedFiles?: string[]): PreflightResult {
  const changedFiles =
    providedChangedFiles && providedChangedFiles.length > 0
      ? providedChangedFiles
      : parsedDiff.files.map(f => f.new_path);

  const hotspots = detectHotspots(changedFiles);
  const configChanged = changedFiles.some(isConfigPath);
  const testsTouched = changedFiles.some(isTestPath);
  const publicApiChanged = detectPublicApiChange(parsedDiff, changedFiles);
  const isBinaryChange = parsedDiff.files.some(f => f.is_binary);

  const checksExecuted = 5;

  const filesChanged = changedFiles.length;
  const hotzonesHit = hotspots.length;
  const testsNotTouched = !testsTouched;

  const baseScore = 1;
  const rawRisk =
    baseScore +
    (filesChanged > 10 ? 1 : 0) +
    hotzonesHit * 0.5 +
    (publicApiChanged ? 1.5 : 0) +
    (configChanged ? 0.5 : 0) +
    (testsNotTouched ? 1 : 0);

  const riskScore = Math.min(5, Math.max(1, Math.ceil(rawRisk)));

  return {
    changed_files: changedFiles,
    hotspots,
    public_api_changed: publicApiChanged,
    config_changed: configChanged,
    tests_touched: testsTouched,
    is_binary_change: isBinaryChange,
    risk_score: riskScore,
    raw_risk_score: rawRisk,
    deterministic_checks_executed: checksExecuted,
  };
}

