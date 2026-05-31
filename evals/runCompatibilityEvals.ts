import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildToolManifestParityReceipt } from './compatibilityChecks.js';
import {
  buildNormalizedFingerprint,
  MCP_COMPATIBILITY_SCHEMA_VERSION,
  normalizeForBaseline,
  stableStringify,
  type EvalSectionStatus,
  type NormalizedMcpCompatibility,
} from './normalizeEvalOutput.js';
import {
  resolveDefaultMcpEvalSmokePaths,
  runMcpEvalSmoke,
  type McpEvalSmokeRunResult,
} from './runSmokeEvals.js';

export interface McpCompatibilityRunResult {
  raw: NormalizedMcpCompatibility & { generated_at: string };
  normalized: NormalizedMcpCompatibility;
  fingerprint: string;
  evalSmoke: McpEvalSmokeRunResult;
}

function sectionStatusFromSmoke(result: McpEvalSmokeRunResult): NormalizedMcpCompatibility['eval_smoke']['sections'] {
  const safetyPassed = result.normalized.safety.passed_count;
  const usefulnessPassed = result.normalized.usefulness.cases.filter((entry) => entry.matched_expected).length;

  return {
    retrieval: result.normalized.retrieval.case_count > 0 ? 'pass' : 'fail',
    context_packs: result.normalized.context_packs.length > 0 ? 'pass' : 'fail',
    safety: safetyPassed === result.normalized.safety.case_count ? 'pass' : 'fail',
    usefulness: usefulnessPassed === result.normalized.usefulness.case_count ? 'pass' : 'fail',
    performance:
      result.normalized.performance.passed_count === result.normalized.performance.check_count
        ? 'pass'
        : 'fail',
  };
}

function buildSummary(
  evalSmoke: McpEvalSmokeRunResult,
  toolManifestParityStatus: EvalSectionStatus
): NormalizedMcpCompatibility['summary'] {
  const sections = sectionStatusFromSmoke(evalSmoke);
  const sectionValues = Object.values(sections);
  const sectionPassed = sectionValues.filter((entry) => entry === 'pass').length;
  const compatibilityPassed = toolManifestParityStatus === 'pass' ? 1 : 0;
  const checksTotal = sectionValues.length + 1;
  const checksPassed = sectionPassed + compatibilityPassed;

  return {
    status: checksPassed === checksTotal ? 'pass' : 'fail',
    checks_passed: checksPassed,
    checks_total: checksTotal,
  };
}

export function runMcpCompatibility(repoRoot: string): McpCompatibilityRunResult {
  const evalSmoke = runMcpEvalSmoke(resolveDefaultMcpEvalSmokePaths(repoRoot));
  const toolManifestParity = buildToolManifestParityReceipt();
  const sections = sectionStatusFromSmoke(evalSmoke);

  const withoutSummary: Omit<NormalizedMcpCompatibility, 'summary'> = {
    schema_version: MCP_COMPATIBILITY_SCHEMA_VERSION,
    gate_mode: 'informational',
    eval_smoke: {
      fingerprint: evalSmoke.fingerprint,
      status: evalSmoke.normalized.summary.status,
      sections,
    },
    compatibility: {
      tool_manifest_parity: toolManifestParity,
    },
  };

  const normalized: NormalizedMcpCompatibility = {
    ...withoutSummary,
    summary: buildSummary(evalSmoke, toolManifestParity.status),
  };

  const raw = {
    ...normalized,
    generated_at: new Date().toISOString(),
  };

  return {
    raw,
    normalized,
    fingerprint: buildNormalizedFingerprint(normalized),
    evalSmoke,
  };
}

export function writeMcpCompatibilityArtifacts(
  outDir: string,
  result: McpCompatibilityRunResult
): { rawPath: string; normalizedPath: string; smokeRawPath: string; smokeNormalizedPath: string } {
  fs.mkdirSync(outDir, { recursive: true });
  const rawPath = path.join(outDir, 'mcp-compatibility.json');
  const normalizedPath = path.join(outDir, 'mcp-compatibility.normalized.json');
  const smokeRawPath = path.join(outDir, 'mcp-eval-smoke.json');
  const smokeNormalizedPath = path.join(outDir, 'mcp-eval-smoke.normalized.json');

  fs.writeFileSync(rawPath, `${JSON.stringify(result.raw, null, 2)}\n`, 'utf8');
  fs.writeFileSync(normalizedPath, `${stableStringify(normalizeForBaseline(result.normalized))}\n`, 'utf8');
  fs.writeFileSync(smokeRawPath, `${JSON.stringify(result.evalSmoke.raw, null, 2)}\n`, 'utf8');
  fs.writeFileSync(
    smokeNormalizedPath,
    `${stableStringify(normalizeForBaseline(result.evalSmoke.normalized))}\n`,
    'utf8'
  );

  return { rawPath, normalizedPath, smokeRawPath, smokeNormalizedPath };
}
