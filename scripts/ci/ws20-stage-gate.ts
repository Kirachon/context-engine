#!/usr/bin/env node
/**
 * WS20 deterministic rollout stage gate validator.
 *
 * Validates structured rollout evidence artifacts for numeric stage gates.
 * Supported artifact formats: JSON, YAML, Markdown (frontmatter or fenced block).
 *
 * Exit codes:
 * - 0: pass
 * - 1: gate validation failures
 * - 2: usage or parsing error
 */

import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';

type StageNumber = 0 | 1 | 2 | 3;

interface GateArgs {
  artifactPath: string;
  expectedStage?: StageNumber;
}

interface GateCheck {
  name: string;
  ok: boolean;
  detail: string;
}

interface ControlledRampCheckpointThreshold {
  percent: number;
  min_soak_hours: number;
}

interface Ws20GateThresholds {
  canary: {
    min_percent: number;
    max_percent: number;
    min_soak_hours: number;
  };
  controlled_ramp: {
    checkpoints: ControlledRampCheckpointThreshold[];
  };
  ga_hardening: {
    min_soak_hours: number;
  };
}

const STAGE_NAMES: Record<StageNumber, string> = {
  0: 'pre_rollout',
  1: 'canary',
  2: 'controlled_ramp',
  3: 'ga_hardening',
};

const DEFAULT_THRESHOLDS_PATH = 'config/rollout-go-no-go-thresholds.json';

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/ws20-stage-gate.ts --artifact <path> [--stage <0|1|2|3>]

Notes:
  - stage 0: pre_rollout
  - stage 1: canary
  - stage 2: controlled_ramp
  - stage 3: ga_hardening
`);
  process.exit(code);
}

function parseStage(value: string): StageNumber {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3) {
    throw new Error(`Invalid --stage value: ${value}. Expected 0|1|2|3.`);
  }
  return parsed as StageNumber;
}

function parseArgs(argv: string[]): GateArgs {
  const out: Partial<GateArgs> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === '--artifact' || arg === '--artifact-path') && next) {
      out.artifactPath = next;
      i += 1;
      continue;
    }
    if (arg === '--stage' && next) {
      out.expectedStage = parseStage(next);
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }
  }

  if (!out.artifactPath) {
    throw new Error('Missing required --artifact <path>.');
  }

  return out as GateArgs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadWs20Thresholds(
  configPath: string = DEFAULT_THRESHOLDS_PATH
): { thresholds: Ws20GateThresholds; resolvedPath: string } {
  const resolvedPath = path.resolve(configPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`WS20 thresholds config not found: ${resolvedPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8')) as unknown;
  } catch (error) {
    throw new Error(
      `Failed to parse WS20 thresholds config ${resolvedPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(`WS20 thresholds config root must be an object: ${resolvedPath}`);
  }

  const ws20 = isRecord(parsed.ws20_stage_gate) ? parsed.ws20_stage_gate : undefined;
  const canary = ws20 && isRecord(ws20.canary) ? ws20.canary : undefined;
  const controlledRamp =
    ws20 && isRecord(ws20.controlled_ramp) ? ws20.controlled_ramp : undefined;
  const gaHardening =
    ws20 && isRecord(ws20.ga_hardening) ? ws20.ga_hardening : undefined;

  const canaryMinPercent = finiteNumber(canary?.min_percent);
  const canaryMaxPercent = finiteNumber(canary?.max_percent);
  const canaryMinSoakHours = finiteNumber(canary?.min_soak_hours);
  const gaMinSoakHours = finiteNumber(gaHardening?.min_soak_hours);

  const checkpointRows = Array.isArray(controlledRamp?.checkpoints)
    ? controlledRamp.checkpoints
    : undefined;

  if (
    canaryMinPercent == null ||
    canaryMaxPercent == null ||
    canaryMinSoakHours == null ||
    gaMinSoakHours == null ||
    !checkpointRows
  ) {
    throw new Error(
      `WS20 thresholds config missing required fields in ${resolvedPath} (canary/controlled_ramp/ga_hardening).`
    );
  }

  if (canaryMinPercent < 0 || canaryMaxPercent < canaryMinPercent) {
    throw new Error(
      `WS20 thresholds config has invalid canary percent range in ${resolvedPath}.`
    );
  }

  if (checkpointRows.length === 0) {
    throw new Error(`WS20 thresholds config must define at least one controlled_ramp checkpoint in ${resolvedPath}.`);
  }

  const checkpoints: ControlledRampCheckpointThreshold[] = [];
  for (const row of checkpointRows) {
    if (!isRecord(row)) {
      throw new Error(
        `WS20 thresholds config checkpoint entries must be objects in ${resolvedPath}.`
      );
    }
    const percent = finiteNumber(row.percent);
    const minSoakHours = finiteNumber(row.min_soak_hours);
    if (percent == null || minSoakHours == null || percent < 0 || minSoakHours < 0) {
      throw new Error(
        `WS20 thresholds config checkpoint entries require non-negative numeric percent and min_soak_hours in ${resolvedPath}.`
      );
    }
    checkpoints.push({ percent, min_soak_hours: minSoakHours });
  }

  return {
    thresholds: {
      canary: {
        min_percent: canaryMinPercent,
        max_percent: canaryMaxPercent,
        min_soak_hours: canaryMinSoakHours,
      },
      controlled_ramp: {
        checkpoints,
      },
      ga_hardening: {
        min_soak_hours: gaMinSoakHours,
      },
    },
    resolvedPath,
  };
}

function readArtifactPayload(filePath: string): Record<string, unknown> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Artifact not found: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, 'utf-8');
  const ext = path.extname(resolved).toLowerCase();
  const trimmed = raw.trim();

  const parseJson = (source: string): Record<string, unknown> => {
    const parsed = JSON.parse(source) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('Artifact root must be an object.');
    }
    return parsed;
  };

  const parseYaml = (source: string): Record<string, unknown> => {
    const parsed = YAML.parse(source) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('Artifact root must be an object.');
    }
    return parsed;
  };

  const parseMarkdown = (source: string): Record<string, unknown> => {
    const frontmatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
    if (frontmatter?.[1]) {
      return parseYaml(frontmatter[1]);
    }

    const fenced = source.match(/```(?:yaml|yml|json)\s*\r?\n([\s\S]*?)\r?\n```/i);
    if (fenced?.[1]) {
      const fenceBody = fenced[1];
      const isLikelyJson = fenceBody.trimStart().startsWith('{');
      return isLikelyJson ? parseJson(fenceBody) : parseYaml(fenceBody);
    }

    throw new Error('Markdown artifact must include YAML frontmatter or a ```yaml/```json fenced block.');
  };

  try {
    if (ext === '.json' || trimmed.startsWith('{')) {
      return parseJson(raw);
    }
    if (ext === '.yaml' || ext === '.yml') {
      return parseYaml(raw);
    }
    if (ext === '.md') {
      return parseMarkdown(raw);
    }
    // Fallback parsing for extensionless/unknown files.
    return parseYaml(raw);
  } catch (error) {
    throw new Error(
      `Failed to parse artifact ${resolved}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseWindowSoakHours(evidence: Record<string, unknown>): number | undefined {
  const direct = finiteNumber(evidence.soak_hours);
  if (direct != null) {
    return direct;
  }

  const window = isRecord(evidence.window) ? evidence.window : undefined;
  if (!window) {
    return undefined;
  }

  const start = nonEmptyString(window.start_utc);
  const end = nonEmptyString(window.end_utc);
  if (!start || !end) {
    return undefined;
  }

  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return undefined;
  }

  return (endMs - startMs) / (1000 * 60 * 60);
}

function collectBaseChecks(
  evidence: Record<string, unknown>,
  expectedStage?: StageNumber
): { checks: GateCheck[]; stage?: StageNumber } {
  const checks: GateCheck[] = [];
  const stage = finiteNumber(evidence.stage);
  const stageAsInt = stage != null && Number.isInteger(stage) ? (stage as number) : undefined;
  const validStage =
    stageAsInt === 0 || stageAsInt === 1 || stageAsInt === 2 || stageAsInt === 3
      ? (stageAsInt as StageNumber)
      : undefined;

  checks.push({
    name: 'rollout_id',
    ok: Boolean(nonEmptyString(evidence.rollout_id)),
    detail: 'rollout_id must be a non-empty string.',
  });
  checks.push({
    name: 'stage',
    ok: validStage != null,
    detail: 'stage must be an integer in range 0..3.',
  });

  if (validStage != null) {
    const declaredName = nonEmptyString(evidence.stage_name);
    if (declaredName) {
      checks.push({
        name: 'stage_name_alignment',
        ok: declaredName === STAGE_NAMES[validStage],
        detail: `stage_name must match ${STAGE_NAMES[validStage]} for stage ${validStage}.`,
      });
    }
  }

  if (expectedStage != null && validStage != null) {
    checks.push({
      name: 'expected_stage_match',
      ok: expectedStage === validStage,
      detail: `artifact stage (${validStage}) must match --stage ${expectedStage}.`,
    });
  }

  return { checks, stage: validStage };
}

function validateStage0(evidence: Record<string, unknown>): GateCheck[] {
  const preRollout = isRecord(evidence.pre_rollout) ? evidence.pre_rollout : undefined;
  return [
    {
      name: 'pre_rollout_present',
      ok: Boolean(preRollout),
      detail: 'pre_rollout section is required for stage 0.',
    },
    {
      name: 'baseline_snapshot_id',
      ok: Boolean(preRollout && nonEmptyString(preRollout.baseline_snapshot_id)),
      detail: 'pre_rollout.baseline_snapshot_id is required.',
    },
    {
      name: 'checklist_complete',
      ok: preRollout ? parseBoolean(preRollout.checklist_complete) === true : false,
      detail: 'pre_rollout.checklist_complete must be true.',
    },
  ];
}

function validateStage1(
  evidence: Record<string, unknown>,
  thresholds: Ws20GateThresholds
): GateCheck[] {
  const canary = isRecord(evidence.canary) ? evidence.canary : undefined;
  const canaryPercent = canary ? finiteNumber(canary.percent) : undefined;
  const canarySoak = canary ? finiteNumber(canary.soak_hours) : undefined;
  const windowSoak = parseWindowSoakHours(evidence);
  const effectiveSoak = canarySoak ?? windowSoak;

  return [
    {
      name: 'canary_present',
      ok: Boolean(canary),
      detail: 'canary section is required for stage 1.',
    },
    {
      name: 'canary_percent_range',
      ok:
        canaryPercent != null &&
        canaryPercent >= thresholds.canary.min_percent &&
        canaryPercent <= thresholds.canary.max_percent,
      detail: `canary.percent must be between ${thresholds.canary.min_percent} and ${thresholds.canary.max_percent}.`,
    },
    {
      name: 'canary_min_soak_24h',
      ok: effectiveSoak != null && effectiveSoak >= thresholds.canary.min_soak_hours,
      detail: `canary soak must be at least ${thresholds.canary.min_soak_hours} hours (canary.soak_hours or window duration).`,
    },
    {
      name: 'canary_exit_criteria',
      ok: canary ? parseBoolean(canary.exit_criteria_met) === true : false,
      detail: 'canary.exit_criteria_met must be true.',
    },
    {
      name: 'canary_signoff',
      ok: canary ? Boolean(nonEmptyString(canary.signed_by) && nonEmptyString(canary.evidence_ref)) : false,
      detail: 'canary.signed_by and canary.evidence_ref are required.',
    },
  ];
}

function validateStage2(
  evidence: Record<string, unknown>,
  thresholds: Ws20GateThresholds
): GateCheck[] {
  const controlledRamp = isRecord(evidence.controlled_ramp) ? evidence.controlled_ramp : undefined;
  const checkpoints = Array.isArray(controlledRamp?.checkpoints)
    ? (controlledRamp?.checkpoints as unknown[])
    : undefined;

  const checks: GateCheck[] = [
    {
      name: 'controlled_ramp_present',
      ok: Boolean(controlledRamp),
      detail: 'controlled_ramp section is required for stage 2.',
    },
    {
      name: 'controlled_ramp_checkpoints',
      ok: Boolean(checkpoints && checkpoints.length > 0),
      detail: 'controlled_ramp.checkpoints must be a non-empty array.',
    },
  ];

  if (!checkpoints || checkpoints.length === 0) {
    return checks;
  }

  const byPercent = new Map<number, Record<string, unknown>>();
  for (const entry of checkpoints) {
    if (!isRecord(entry)) {
      continue;
    }
    const percent = finiteNumber(entry.percent);
    if (percent != null) {
      byPercent.set(percent, entry);
    }
  }

  for (const checkpointThreshold of thresholds.controlled_ramp.checkpoints) {
    const percentValue = checkpointThreshold.percent;
    const minSoak = checkpointThreshold.min_soak_hours;
    const checkpoint = byPercent.get(percentValue);
    checks.push({
      name: `checkpoint_${percentValue}_exists`,
      ok: Boolean(checkpoint),
      detail: `controlled_ramp.checkpoints must include percent=${percentValue}.`,
    });

    if (!checkpoint) {
      continue;
    }

    const soak = finiteNumber(checkpoint.soak_hours);
    checks.push({
      name: `checkpoint_${percentValue}_soak`,
      ok: soak != null && soak >= minSoak,
      detail: `percent=${percentValue} checkpoint requires soak_hours >= ${minSoak}.`,
    });
    checks.push({
      name: `checkpoint_${percentValue}_status`,
      ok: nonEmptyString(checkpoint.status) === 'pass',
      detail: `percent=${percentValue} checkpoint status must be 'pass'.`,
    });
    checks.push({
      name: `checkpoint_${percentValue}_signoff`,
      ok: Boolean(nonEmptyString(checkpoint.signed_by) && nonEmptyString(checkpoint.evidence_ref)),
      detail: `percent=${percentValue} checkpoint requires signed_by and evidence_ref.`,
    });
  }

  return checks;
}

function validateStage3(
  evidence: Record<string, unknown>,
  thresholds: Ws20GateThresholds
): GateCheck[] {
  const ga = isRecord(evidence.ga_hardening) ? evidence.ga_hardening : undefined;
  const soak = ga ? finiteNumber(ga.soak_hours) : undefined;
  return [
    {
      name: 'ga_hardening_present',
      ok: Boolean(ga),
      detail: 'ga_hardening section is required for stage 3.',
    },
    {
      name: 'ga_min_soak_24h',
      ok: soak != null && soak >= thresholds.ga_hardening.min_soak_hours,
      detail: `ga_hardening.soak_hours must be at least ${thresholds.ga_hardening.min_soak_hours}.`,
    },
    {
      name: 'ga_stability_confirmed',
      ok: ga ? parseBoolean(ga.stability_confirmed) === true : false,
      detail: 'ga_hardening.stability_confirmed must be true.',
    },
    {
      name: 'ga_closeout_evidence',
      ok: ga ? Boolean(nonEmptyString(ga.closeout_evidence_ref) && nonEmptyString(ga.signed_by)) : false,
      detail: 'ga_hardening.closeout_evidence_ref and ga_hardening.signed_by are required.',
    },
  ];
}

function runValidation(
  evidence: Record<string, unknown>,
  thresholds: Ws20GateThresholds,
  expectedStage?: StageNumber
): GateCheck[] {
  const base = collectBaseChecks(evidence, expectedStage);
  const checks = [...base.checks];
  if (base.stage == null) {
    return checks;
  }

  if (base.stage === 0) {
    checks.push(...validateStage0(evidence));
  } else if (base.stage === 1) {
    checks.push(...validateStage1(evidence, thresholds));
  } else if (base.stage === 2) {
    checks.push(...validateStage2(evidence, thresholds));
  } else {
    checks.push(...validateStage3(evidence, thresholds));
  }

  return checks;
}

function main(): void {
  let args: GateArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    printHelpAndExit(2);
  }

  try {
    const artifact = readArtifactPayload(args.artifactPath);
    const { thresholds, resolvedPath: thresholdsPath } = loadWs20Thresholds();
    const checks = runValidation(artifact, thresholds, args.expectedStage);

    const resolvedArtifact = path.resolve(args.artifactPath);
    // eslint-disable-next-line no-console
    console.log('WS20 rollout stage gate');
    // eslint-disable-next-line no-console
    console.log(`artifact=${resolvedArtifact}`);
    // eslint-disable-next-line no-console
    console.log(`thresholds_config=${thresholdsPath}`);
    // eslint-disable-next-line no-console
    console.log(`checks=${checks.length}`);

    for (const check of checks) {
      // eslint-disable-next-line no-console
      console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
    }

    const failed = checks.filter((check) => !check.ok);
    if (failed.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`WS20 stage gate failed with ${failed.length} failing checks.`);
      process.exit(1);
    }

    // eslint-disable-next-line no-console
    console.log('WS20 stage gate passed.');
    process.exit(0);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

main();
