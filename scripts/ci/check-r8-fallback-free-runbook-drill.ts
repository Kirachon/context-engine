#!/usr/bin/env node
/**
 * Deterministic R8 fallback-free runbook + drill checker.
 *
 * Validates:
 * - R8 contract file presence and metadata.
 * - Drill artifact required schema/evidence fields and readiness rules.
 *
 * Exit codes:
 * - 0: all checks passed
 * - 1: one or more checks failed
 * - 2: usage/parsing error
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_CONTRACT_PATH = 'docs/R8_FALLBACK_FREE_INCIDENT_RUNBOOK_CONTRACT.md';
const CONTRACT_ID = 'R8_FALLBACK_FREE_INCIDENT_RUNBOOK_CONTRACT';
const ALLOWED_INCIDENT_CLASSES = new Set(['TRANSIENT_UPSTREAM', 'AUTH', 'QUOTA', 'CONFIG']);
const ISO_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const PLACEHOLDER_VALUE_REGEX = /^(tbd|n\/a|na|unknown|null)$/i;

const REQUIRED_TOP_LEVEL_FIELDS = [
  'drill_id',
  'contract_version',
  'executed_at_utc',
  'owner',
  'scenario_name',
  'incident_class',
  'decision_path_trace',
  'evidence',
  'outcome',
  'duration_minutes',
  'follow_up_actions',
] as const;

const REQUIRED_EVIDENCE_FIELDS = [
  'command_path',
  'error_signal_excerpt',
  'classification_justification',
  'validation_command',
  'validation_result',
  'artifact_refs',
  'started_at_utc',
  'ended_at_utc',
  'blocker_status',
] as const;

type TopLevelField = (typeof REQUIRED_TOP_LEVEL_FIELDS)[number];
type EvidenceField = (typeof REQUIRED_EVIDENCE_FIELDS)[number];

interface CheckerArgs {
  contractPath: string;
  drillArtifactPath: string;
}

interface CheckLine {
  id: string;
  status: 'PASS' | 'FAIL';
  detail: string;
}

interface R8CheckResult {
  status: 'PASS' | 'FAIL';
  contractPath: string;
  drillArtifactPath: string;
  contractVersion: string | null;
  incidentClass: string | null;
  outcome: string | null;
  blockers: string[];
  checks: CheckLine[];
  errors: string[];
}

interface ParsedArtifact {
  raw: string;
  format: 'json' | 'kv';
  jsonObject?: Record<string, unknown>;
  kvFields?: Record<string, string>;
}

interface ParsedContract {
  contractVersion: string | null;
}

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/check-r8-fallback-free-runbook-drill.ts --drill-artifact <path> [options]

Options:
  --drill-artifact <path>   Path to R8 drill artifact (required).
  --contract <path>         Path to contract doc. Default: ${DEFAULT_CONTRACT_PATH}
  -h, --help                Show help.
`);
  process.exit(code);
}

function parseArgs(argv: string[]): CheckerArgs {
  const args: CheckerArgs = {
    contractPath: DEFAULT_CONTRACT_PATH,
    drillArtifactPath: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }
    if (arg === '--drill-artifact' && next) {
      args.drillArtifactPath = next.trim();
      i += 1;
      continue;
    }
    if (arg === '--contract' && next) {
      args.contractPath = next.trim();
      i += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  if (!args.drillArtifactPath) {
    throw new Error('Missing required argument: --drill-artifact <path>');
  }

  return args;
}

function normalizeKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[()]/g, '')
    .replace(/[^\w.]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseKvArtifact(raw: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
  let parent: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '  ');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```')) {
      continue;
    }

    const parentMatch = /^([A-Za-z][A-Za-z0-9_. ()/-]*):\s*$/.exec(trimmed);
    if (parentMatch) {
      parent = normalizeKey(parentMatch[1]);
      continue;
    }

    const entryMatch = /^([A-Za-z][A-Za-z0-9_. ()/-]*):\s*(.+)$/.exec(trimmed);
    if (!entryMatch) {
      continue;
    }

    const key = normalizeKey(entryMatch[1]);
    const value = entryMatch[2].trim().replace(/^['"]|['"]$/g, '');
    if (!(key in fields)) {
      fields[key] = value;
    }

    if (parent && !key.includes('.')) {
      const nestedKey = `${parent}.${key}`;
      if (!(nestedKey in fields)) {
        fields[nestedKey] = value;
      }
    }
  }

  return fields;
}

function parseArtifact(artifactPath: string): ParsedArtifact {
  const raw = fs.readFileSync(path.resolve(artifactPath), 'utf-8');
  const normalizedRaw = raw.replace(/^\uFEFF/, '');
  const trimmed = normalizedRaw.trim();
  const jsonDetected =
    artifactPath.toLowerCase().endsWith('.json') || trimmed.startsWith('{') || trimmed.startsWith('[');

  if (jsonDetected) {
    try {
      const parsed = JSON.parse(normalizedRaw) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return { raw: normalizedRaw, format: 'json', jsonObject: parsed as Record<string, unknown> };
      }
      throw new Error('JSON drill artifact must be an object');
    } catch {
      throw new Error(`Invalid JSON drill artifact: ${artifactPath}`);
    }
  }

  return { raw: normalizedRaw, format: 'kv', kvFields: parseKvArtifact(normalizedRaw) };
}

function parseContract(contractPath: string): ParsedContract {
  const resolved = path.resolve(contractPath);
  const errors: string[] = [];
  if (!fs.existsSync(resolved)) {
    throw new Error(`Missing contract file: ${resolved}`);
  }
  const content = fs.readFileSync(resolved, 'utf-8');
  if (!content.includes(`contract_id: ${CONTRACT_ID}`)) {
    errors.push(`Contract missing required ID token: contract_id: ${CONTRACT_ID}`);
  }
  const versionMatch = /contract_version:\s*([0-9]+\.[0-9]+\.[0-9]+)/.exec(content);
  if (!versionMatch) {
    errors.push('Contract missing semantic version token: contract_version: <x.y.z>');
  }

  if (errors.length > 0) {
    throw new Error(errors.join(' | '));
  }

  return { contractVersion: versionMatch ? versionMatch[1] : null };
}

function parseStrictUtcIso(value: string): number | undefined {
  if (!ISO_UTC_REGEX.test(value)) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function getJsonPath(obj: Record<string, unknown>, pathParts: string[]): unknown {
  let cursor: unknown = obj;
  for (const part of pathParts) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) {
      return undefined;
    }
    const record = cursor as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, part)) {
      return undefined;
    }
    cursor = record[part];
  }
  return cursor;
}

function getTopLevelValue(artifact: ParsedArtifact, field: TopLevelField): unknown {
  if (artifact.format === 'json' && artifact.jsonObject) {
    return artifact.jsonObject[field];
  }
  const fields = artifact.kvFields ?? {};
  if (field === 'evidence') {
    const hasEvidenceKey = fields.evidence != null;
    const hasEvidenceChildren = Object.keys(fields).some((key) => key.startsWith('evidence.'));
    return hasEvidenceKey || hasEvidenceChildren ? 'present' : undefined;
  }
  return fields[field];
}

function getEvidenceValue(artifact: ParsedArtifact, field: EvidenceField): unknown {
  if (artifact.format === 'json' && artifact.jsonObject) {
    return getJsonPath(artifact.jsonObject, ['evidence', field]);
  }
  const fields = artifact.kvFields ?? {};
  return fields[`evidence.${field}`] ?? fields[field];
}

function asString(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function isMissingOrPlaceholder(value: unknown): boolean {
  if (value == null) {
    return true;
  }
  if (Array.isArray(value)) {
    return false;
  }
  if (typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length === 0;
  }
  const scalar = asString(value);
  if (!scalar) {
    return true;
  }
  return PLACEHOLDER_VALUE_REGEX.test(scalar);
}

function collectBlockers(
  blockerStatusValue: string,
  evidenceResolutionValue: unknown
): string[] {
  const blockers: string[] = [];
  const normalized = blockerStatusValue.trim().toLowerCase();
  if (!normalized || normalized === 'none') {
    return blockers;
  }
  blockers.push(normalized);
  if (isMissingOrPlaceholder(evidenceResolutionValue)) {
    blockers.push('unresolved_without_resolution_evidence');
  }
  return blockers;
}

function validateFollowUpActions(artifact: ParsedArtifact, outcome: string): string[] {
  if (outcome !== 'FAIL') {
    return [];
  }

  if (artifact.format === 'json' && artifact.jsonObject) {
    const actions = artifact.jsonObject.follow_up_actions;
    if (!Array.isArray(actions) || actions.length === 0) {
      return ['follow_up_actions must be a non-empty array when outcome=FAIL'];
    }
    const issues: string[] = [];
    actions.forEach((action, index) => {
      if (typeof action !== 'object' || action === null || Array.isArray(action)) {
        issues.push(`follow_up_actions[${index}] must be an object with owner and due_date`);
        return;
      }
      const record = action as Record<string, unknown>;
      const owner = asString(record.owner);
      const dueDate = asString(record.due_date ?? record.due);
      if (!owner) {
        issues.push(`follow_up_actions[${index}] missing owner`);
      }
      if (!dueDate) {
        issues.push(`follow_up_actions[${index}] missing due_date (or due)`);
      }
    });
    return issues;
  }

  const raw = artifact.raw.toLowerCase();
  if (!/\bfollow_up_actions\b/.test(raw)) {
    return ['follow_up_actions section missing when outcome=FAIL'];
  }
  const hasOwner = /\bowner\b/.test(raw);
  const hasDue = /\bdue(?:_date)?\b/.test(raw);
  if (!hasOwner || !hasDue) {
    return ['follow_up_actions must include owner and due date when outcome=FAIL'];
  }
  return [];
}

function isMissingTopLevelField(
  artifact: ParsedArtifact,
  field: TopLevelField
): boolean {
  const value = getTopLevelValue(artifact, field);
  if (field === 'decision_path_trace') {
    if (Array.isArray(value)) {
      return value.length === 0;
    }
    return isMissingOrPlaceholder(value);
  }
  if (field === 'evidence') {
    if (artifact.format === 'json') {
      return typeof value !== 'object' || value === null || Array.isArray(value);
    }
    return isMissingOrPlaceholder(value);
  }
  if (field === 'follow_up_actions') {
    if (Array.isArray(value)) {
      return false;
    }
    return isMissingOrPlaceholder(value);
  }
  return isMissingOrPlaceholder(value);
}

function isMissingEvidenceField(
  artifact: ParsedArtifact,
  field: EvidenceField
): boolean {
  const value = getEvidenceValue(artifact, field);
  if (field === 'artifact_refs') {
    if (Array.isArray(value)) {
      return value.length === 0;
    }
  }
  return isMissingOrPlaceholder(value);
}

export function checkR8FallbackFreeRunbookDrill(
  args: CheckerArgs
): R8CheckResult {
  const contractPath = path.resolve(args.contractPath);
  const drillArtifactPath = path.resolve(args.drillArtifactPath);
  const errors: string[] = [];
  const checks: CheckLine[] = [];

  let contractVersion: string | null = null;
  try {
    const contract = parseContract(contractPath);
    contractVersion = contract.contractVersion;
    checks.push({
      id: 'r8_contract_present',
      status: 'PASS',
      detail: `contract_id=${CONTRACT_ID}, contract_version=${contractVersion ?? 'unknown'}`,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({ id: 'r8_contract_present', status: 'FAIL', detail });
    errors.push(detail);
  }

  if (!fs.existsSync(drillArtifactPath)) {
    const detail = `Drill artifact not found: ${drillArtifactPath}`;
    checks.push({ id: 'r8_artifact_present', status: 'FAIL', detail });
    errors.push(detail);
    return {
      status: 'FAIL',
      contractPath,
      drillArtifactPath,
      contractVersion,
      incidentClass: null,
      outcome: null,
      blockers: ['missing_artifact'],
      checks,
      errors,
    };
  }
  checks.push({ id: 'r8_artifact_present', status: 'PASS', detail: drillArtifactPath });

  let artifact: ParsedArtifact;
  try {
    artifact = parseArtifact(drillArtifactPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({ id: 'r8_artifact_parse', status: 'FAIL', detail });
    errors.push(detail);
    return {
      status: 'FAIL',
      contractPath,
      drillArtifactPath,
      contractVersion,
      incidentClass: null,
      outcome: null,
      blockers: ['artifact_parse_error'],
      checks,
      errors,
    };
  }

  const missingTopLevel = REQUIRED_TOP_LEVEL_FIELDS.filter((field) =>
    isMissingTopLevelField(artifact, field)
  );
  if (missingTopLevel.length > 0) {
    const detail = `Missing required top-level field(s): ${missingTopLevel.join(', ')}`;
    checks.push({ id: 'r8_required_fields_complete', status: 'FAIL', detail });
    errors.push(detail);
  } else {
    checks.push({ id: 'r8_required_fields_complete', status: 'PASS', detail: 'All required top-level fields present.' });
  }

  const incidentClassRaw = asString(getTopLevelValue(artifact, 'incident_class')).toUpperCase();
  if (!ALLOWED_INCIDENT_CLASSES.has(incidentClassRaw)) {
    const detail =
      'incident_class must be one of TRANSIENT_UPSTREAM|AUTH|QUOTA|CONFIG';
    checks.push({ id: 'r8_incident_class_valid', status: 'FAIL', detail });
    errors.push(detail);
  } else {
    checks.push({ id: 'r8_incident_class_valid', status: 'PASS', detail: `incident_class=${incidentClassRaw}` });
  }

  const decisionTrace = getTopLevelValue(artifact, 'decision_path_trace');
  const traceText = typeof decisionTrace === 'string' ? decisionTrace : JSON.stringify(decisionTrace ?? '');
  if (!traceText || traceText.trim().length === 0) {
    const detail = 'decision_path_trace must be non-empty.';
    checks.push({ id: 'r8_decision_path_precedence', status: 'FAIL', detail });
    errors.push(detail);
  } else if (incidentClassRaw && !traceText.toUpperCase().includes(incidentClassRaw)) {
    const detail =
      `decision_path_trace must include selected incident_class (${incidentClassRaw}) to prove precedence path.`;
    checks.push({ id: 'r8_decision_path_precedence', status: 'FAIL', detail });
    errors.push(detail);
  } else {
    checks.push({
      id: 'r8_decision_path_precedence',
      status: 'PASS',
      detail: 'decision_path_trace includes selected incident class.',
    });
  }

  const missingEvidence = REQUIRED_EVIDENCE_FIELDS.filter((field) =>
    isMissingEvidenceField(artifact, field)
  );
  if (missingEvidence.length > 0) {
    const detail = `Missing required evidence field(s): ${missingEvidence.map(field => `evidence.${field}`).join(', ')}`;
    checks.push({ id: 'r8_evidence_complete', status: 'FAIL', detail });
    errors.push(detail);
  } else {
    checks.push({ id: 'r8_evidence_complete', status: 'PASS', detail: 'All required evidence fields present.' });
  }

  const evidenceValidationResult = asString(getEvidenceValue(artifact, 'validation_result')).toUpperCase();
  if (evidenceValidationResult !== 'PASS' && evidenceValidationResult !== 'FAIL') {
    const detail = 'evidence.validation_result must be PASS or FAIL.';
    checks.push({ id: 'r8_validation_result_valid', status: 'FAIL', detail });
    errors.push(detail);
  } else {
    checks.push({
      id: 'r8_validation_result_valid',
      status: 'PASS',
      detail: `evidence.validation_result=${evidenceValidationResult}`,
    });
  }

  const outcome = asString(getTopLevelValue(artifact, 'outcome')).toUpperCase();
  if (outcome !== 'PASS' && outcome !== 'FAIL') {
    const detail = 'outcome must be PASS or FAIL.';
    checks.push({ id: 'r8_outcome_valid', status: 'FAIL', detail });
    errors.push(detail);
  } else {
    checks.push({ id: 'r8_outcome_valid', status: 'PASS', detail: `outcome=${outcome}` });
  }

  const drillId = asString(getTopLevelValue(artifact, 'drill_id'));
  if (!/^R8-\d{8}-\d{3}$/.test(drillId)) {
    const detail = `drill_id must match pattern R8-YYYYMMDD-###: ${drillId || '(missing)'}`;
    checks.push({ id: 'r8_drill_id_format', status: 'FAIL', detail });
    errors.push(detail);
  } else {
    checks.push({ id: 'r8_drill_id_format', status: 'PASS', detail: `drill_id=${drillId}` });
  }

  const executedAt = asString(getTopLevelValue(artifact, 'executed_at_utc'));
  if (executedAt && parseStrictUtcIso(executedAt) == null) {
    const detail = `executed_at_utc must be strict UTC ISO-8601: ${executedAt}`;
    checks.push({ id: 'r8_executed_timestamp_valid', status: 'FAIL', detail });
    errors.push(detail);
  } else {
    checks.push({ id: 'r8_executed_timestamp_valid', status: 'PASS', detail: `executed_at_utc=${executedAt || '(missing)'}` });
  }

  const startedAtRaw = asString(getEvidenceValue(artifact, 'started_at_utc'));
  const endedAtRaw = asString(getEvidenceValue(artifact, 'ended_at_utc'));
  const startedAt = startedAtRaw ? parseStrictUtcIso(startedAtRaw) : undefined;
  const endedAt = endedAtRaw ? parseStrictUtcIso(endedAtRaw) : undefined;
  if (startedAtRaw && startedAt == null) {
    const detail = `evidence.started_at_utc must be strict UTC ISO-8601: ${startedAtRaw}`;
    checks.push({ id: 'r8_evidence_started_timestamp_valid', status: 'FAIL', detail });
    errors.push(detail);
  } else {
    checks.push({ id: 'r8_evidence_started_timestamp_valid', status: 'PASS', detail: `evidence.started_at_utc=${startedAtRaw || '(missing)'}` });
  }
  if (endedAtRaw && endedAt == null) {
    const detail = `evidence.ended_at_utc must be strict UTC ISO-8601: ${endedAtRaw}`;
    checks.push({ id: 'r8_evidence_ended_timestamp_valid', status: 'FAIL', detail });
    errors.push(detail);
  } else {
    checks.push({ id: 'r8_evidence_ended_timestamp_valid', status: 'PASS', detail: `evidence.ended_at_utc=${endedAtRaw || '(missing)'}` });
  }
  if (startedAt != null && endedAt != null && endedAt < startedAt) {
    const detail = 'evidence.ended_at_utc must be >= evidence.started_at_utc.';
    checks.push({ id: 'r8_evidence_timeline_valid', status: 'FAIL', detail });
    errors.push(detail);
  } else {
    checks.push({ id: 'r8_evidence_timeline_valid', status: 'PASS', detail: 'evidence timeline order valid.' });
  }

  const durationRaw = getTopLevelValue(artifact, 'duration_minutes');
  const durationValue = Number(durationRaw);
  if (!Number.isFinite(durationValue) || durationValue < 0) {
    const detail = `duration_minutes must be a non-negative number: ${asString(durationRaw) || '(missing)'}`;
    checks.push({ id: 'r8_duration_valid', status: 'FAIL', detail });
    errors.push(detail);
  } else {
    checks.push({ id: 'r8_duration_valid', status: 'PASS', detail: `duration_minutes=${durationValue}` });
  }

  const blockerStatus = asString(getEvidenceValue(artifact, 'blocker_status'));
  const blockerResolution = getEvidenceValue(artifact, 'blocker_resolution');
  const blockers = collectBlockers(blockerStatus, blockerResolution);
  if (blockers.includes('unresolved_without_resolution_evidence')) {
    const detail =
      'evidence.blocker_resolution is required when evidence.blocker_status is not "none".';
    checks.push({ id: 'r8_blocker_resolution_required', status: 'FAIL', detail });
    errors.push(detail);
  } else {
    checks.push({
      id: 'r8_blocker_resolution_required',
      status: 'PASS',
      detail: blockerStatus ? `blocker_status=${blockerStatus}` : 'blocker_status missing',
    });
  }

  const followUpIssues = validateFollowUpActions(artifact, outcome);
  if (followUpIssues.length > 0) {
    const detail = followUpIssues.join(' | ');
    checks.push({ id: 'r8_follow_up_actions_valid', status: 'FAIL', detail });
    errors.push(...followUpIssues);
  } else {
    checks.push({
      id: 'r8_follow_up_actions_valid',
      status: 'PASS',
      detail: outcome === 'FAIL' ? 'follow_up_actions include owner and due date.' : 'outcome != FAIL',
    });
  }

  if (contractVersion && asString(getTopLevelValue(artifact, 'contract_version')) !== contractVersion) {
    const detail = `contract_version mismatch: artifact=${asString(getTopLevelValue(artifact, 'contract_version'))} contract=${contractVersion}`;
    checks.push({ id: 'r8_contract_version_match', status: 'FAIL', detail });
    errors.push(detail);
  } else {
    checks.push({
      id: 'r8_contract_version_match',
      status: 'PASS',
      detail: `contract_version=${asString(getTopLevelValue(artifact, 'contract_version')) || '(missing)'}`,
    });
  }

  return {
    status: errors.length > 0 ? 'FAIL' : 'PASS',
    contractPath,
    drillArtifactPath,
    contractVersion,
    incidentClass: incidentClassRaw || null,
    outcome: outcome || null,
    blockers,
    checks,
    errors,
  };
}

function main(): void {
  let args: CheckerArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    printHelpAndExit(2);
  }

  const result = checkR8FallbackFreeRunbookDrill(args);

  // eslint-disable-next-line no-console
  console.log('R8 fallback-free runbook/drill check');
  // eslint-disable-next-line no-console
  console.log(`contract_path=${result.contractPath}`);
  // eslint-disable-next-line no-console
  console.log(`drill_artifact_path=${result.drillArtifactPath}`);

  for (const check of result.checks) {
    // eslint-disable-next-line no-console
    console.log(`${check.status} ${check.id}: ${check.detail}`);
  }

  if (result.errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`R8 runbook/drill check failed with ${result.errors.length} issue(s).`);
    for (const error of result.errors) {
      // eslint-disable-next-line no-console
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log('R8 runbook/drill check passed.');
  process.exit(0);
}

const isDirectExecution =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main();
}
