#!/usr/bin/env node
/**
 * CI-friendly rollout readiness checker.
 *
 * Verifies required governance docs and optional artifact paths.
 *
 * Exit codes:
 * - 0: required docs exist and optional artifacts (if provided) pass quality checks
 * - 1: required docs/artifacts missing or quality checks fail
 */

import * as fs from 'fs';
import * as path from 'path';
import { checkR8FallbackFreeRunbookDrill } from './check-r8-fallback-free-runbook-drill.ts';

const REQUIRED_PATHS = [
  'docs/CONTRACT_FREEZE.md',
  'docs/BENCHMARKING_GATES.md',
  'docs/FLAG_REGISTRY.md',
  'docs/ROLLOUT_RUNBOOK.md',
];
const DEFAULT_R8_CONTRACT_PATH = 'docs/R8_FALLBACK_FREE_INCIDENT_RUNBOOK_CONTRACT.md';

interface ParsedArgs {
  optionalArtifacts: string[];
  r8DrillArtifactPath: string | null;
  r8ContractPath: string;
}

function normalizeInputPaths(argv: string[]): string[] {
  return argv.map((entry) => entry.trim()).filter(Boolean);
}

function parseArgs(argv: string[]): ParsedArgs {
  const optionalArtifacts: string[] = [];
  let r8DrillArtifactPath: string | null = null;
  let r8ContractPath = DEFAULT_R8_CONTRACT_PATH;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--r8-drill-artifact') {
      if (!next) {
        throw new Error('Missing value for --r8-drill-artifact');
      }
      r8DrillArtifactPath = next.trim();
      i += 1;
      continue;
    }
    if (arg === '--r8-contract') {
      if (!next) {
        throw new Error('Missing value for --r8-contract');
      }
      r8ContractPath = next.trim();
      i += 1;
      continue;
    }
    optionalArtifacts.push(arg);
  }

  return {
    optionalArtifacts: normalizeInputPaths(optionalArtifacts),
    r8DrillArtifactPath,
    r8ContractPath,
  };
}

function fileExists(targetPath: string): boolean {
  return fs.existsSync(path.resolve(targetPath));
}

function printSection(title: string, entries: string[]): void {
  if (entries.length === 0) {
    return;
  }

  // eslint-disable-next-line no-console
  console.log(title);
  for (const entry of entries) {
    // eslint-disable-next-line no-console
    console.log(`- ${entry}`);
  }
}

interface ArtifactSignalResult {
  artifactPath: string;
  hasPassMarker: boolean;
  hasFailMarker: boolean;
  jsonDetected: boolean;
  schemaValid: boolean;
  schemaIssues: string[];
}

function hasPassMarker(content: string): boolean {
  return /\bPASS\b/i.test(content) || /"status"\s*:\s*"PASS"/i.test(content);
}

function hasFailMarker(content: string): boolean {
  return /\bFAIL(?:ED)?\b/i.test(content) || /"status"\s*:\s*"FAIL(?:ED)?"/i.test(content);
}

function validateJsonSchemaShape(parsed: unknown): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { valid: false, issues: ['JSON artifact must be an object.'] };
  }

  const record = parsed as Record<string, unknown>;
  const hasStatus = Object.prototype.hasOwnProperty.call(record, 'status');
  const hasEvidencePayload =
    Object.prototype.hasOwnProperty.call(record, 'checks') ||
    Object.prototype.hasOwnProperty.call(record, 'results') ||
    Object.prototype.hasOwnProperty.call(record, 'metrics') ||
    Object.prototype.hasOwnProperty.call(record, 'summary');

  if (!hasStatus) {
    issues.push('Missing required JSON key: status');
  }
  if (!hasEvidencePayload) {
    issues.push('Missing one evidence key: checks|results|metrics|summary');
  }

  return { valid: issues.length === 0, issues };
}

function validateArtifactSignals(artifactPath: string): ArtifactSignalResult {
  const resolvedPath = path.resolve(artifactPath);
  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const trimmed = raw.trim();
  const jsonDetected =
    artifactPath.toLowerCase().endsWith('.json') ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[');

  let schemaValid = true;
  const schemaIssues: string[] = [];
  if (jsonDetected) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      const schema = validateJsonSchemaShape(parsed);
      schemaValid = schema.valid;
      schemaIssues.push(...schema.issues);
    } catch {
      schemaValid = false;
      schemaIssues.push('Invalid JSON payload.');
    }
  }

  return {
    artifactPath,
    hasPassMarker: hasPassMarker(raw),
    hasFailMarker: hasFailMarker(raw),
    jsonDetected,
    schemaValid,
    schemaIssues,
  };
}

function main(): void {
  const parsedArgs = parseArgs(process.argv.slice(2));
  const optionalArtifacts = parsedArgs.optionalArtifacts;
  const requiredMissing = REQUIRED_PATHS.filter((target) => !fileExists(target));
  const optionalMissing = optionalArtifacts.filter((target) => !fileExists(target));
  const presentArtifacts = optionalArtifacts.filter((target) => fileExists(target));
  const signalResults = presentArtifacts.map((target) => validateArtifactSignals(target));
  const r8Failures: string[] = [];
  let r8Status: 'SKIP' | 'PASS' | 'FAIL' = 'SKIP';

  if (parsedArgs.r8DrillArtifactPath) {
    const r8Result = checkR8FallbackFreeRunbookDrill({
      contractPath: parsedArgs.r8ContractPath,
      drillArtifactPath: parsedArgs.r8DrillArtifactPath,
    });
    r8Status = r8Result.status;
    if (r8Result.status === 'FAIL') {
      r8Failures.push(...r8Result.errors.map((error) => `R8: ${error}`));
    }
  }

  const qualityFailures = signalResults.flatMap((result) => {
    const failures: string[] = [];
    if (!result.hasPassMarker) {
      failures.push(`${result.artifactPath}: missing PASS marker`);
    }
    if (result.hasFailMarker) {
      failures.push(`${result.artifactPath}: contains FAIL marker`);
    }
    if (result.jsonDetected && !result.schemaValid) {
      for (const issue of result.schemaIssues) {
        failures.push(`${result.artifactPath}: ${issue}`);
      }
    }
    return failures;
  });

  // eslint-disable-next-line no-console
  console.log('Rollout readiness check');
  // eslint-disable-next-line no-console
  console.log(`Required files checked: ${REQUIRED_PATHS.length}`);
  // eslint-disable-next-line no-console
  console.log(`Optional artifacts checked: ${optionalArtifacts.length}`);

  printSection('Missing required files:', requiredMissing);
  printSection('Missing optional artifacts:', optionalMissing);
  printSection('Artifact quality failures:', qualityFailures);
  printSection('R8 runbook/drill failures:', r8Failures);

  if (signalResults.length > 0) {
    // eslint-disable-next-line no-console
    console.log('Artifact quality signals:');
    for (const result of signalResults) {
      const status =
        result.hasPassMarker && !result.hasFailMarker && (!result.jsonDetected || result.schemaValid)
          ? 'PASS'
          : 'FAIL';
      // eslint-disable-next-line no-console
      console.log(
        `- ${result.artifactPath}: ${status} (pass_marker=${result.hasPassMarker}, fail_marker=${result.hasFailMarker}, json=${result.jsonDetected}, schema=${result.schemaValid})`
      );
    }
  }

  if (parsedArgs.r8DrillArtifactPath) {
    // eslint-disable-next-line no-console
    console.log(
      `R8 runbook/drill check: ${r8Status} (artifact=${parsedArgs.r8DrillArtifactPath}, contract=${parsedArgs.r8ContractPath})`
    );
  } else {
    // eslint-disable-next-line no-console
    console.log('R8 runbook/drill check: SKIP (no --r8-drill-artifact provided)');
  }

  const hasFailure =
    requiredMissing.length > 0 ||
    optionalMissing.length > 0 ||
    qualityFailures.length > 0 ||
    r8Failures.length > 0;
  if (hasFailure) {
    // eslint-disable-next-line no-console
    console.error('Readiness check failed.');
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log('Readiness check passed.');
  process.exit(0);
}

main();
