#!/usr/bin/env node
/**
 * Deterministic checker for R7 split risk register templates/artifacts.
 *
 * Validates owner and review-date requirements, plus risk_id uniqueness across
 * delivery and runtime registers.
 *
 * Exit codes:
 * - 0: both registers pass validation
 * - 1: one or more validation failures
 * - 2: usage error
 */

import * as fs from 'fs';
import * as path from 'path';

type RegisterType = 'delivery' | 'runtime';

interface CheckerArgs {
  deliveryPath: string;
  runtimePath: string;
  ignoreCadence: boolean;
}

interface RiskRecord {
  risk_id?: unknown;
  title?: unknown;
  status?: unknown;
  likelihood?: unknown;
  impact?: unknown;
  trigger?: unknown;
  mitigation?: unknown;
  contingency?: unknown;
  owner?: unknown;
  opened_at_utc?: unknown;
  last_review_utc?: unknown;
  next_review_utc?: unknown;
  evidence_ref?: unknown;
  delivery_milestone?: unknown;
  dependency_refs?: unknown;
  runtime_surface?: unknown;
  detect_signal?: unknown;
}

interface RiskRegister {
  schema_version?: unknown;
  register_type?: unknown;
  register_owner?: unknown;
  generated_at_utc?: unknown;
  last_review_utc?: unknown;
  next_review_utc?: unknown;
  risks?: unknown;
  empty_register_reason?: unknown;
}

const DEFAULTS: CheckerArgs = {
  deliveryPath: 'artifacts/governance/r7-delivery-risk-register.json',
  runtimePath: 'artifacts/governance/r7-runtime-risk-register.json',
  ignoreCadence: false,
};

const ISO_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const REVIEW_CADENCE_MS = 7 * 24 * 60 * 60 * 1000;
const DELIVERY_RISK_ID_REGEX = /^DR-\d{3}$/;
const RUNTIME_RISK_ID_REGEX = /^RR-\d{3}$/;

const STATUS_VALUES = new Set(['open', 'watch', 'mitigated', 'closed']);
const LIKELIHOOD_VALUES = new Set(['low', 'medium', 'high']);
const IMPACT_VALUES = new Set(['low', 'medium', 'high', 'critical']);
const DELIVERY_MILESTONES = new Set(['0-30', '31-60', '61-90']);

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node --import tsx scripts/ci/check-r7-split-risk-registers.ts [options]

Options:
  --delivery <path>   Path to delivery risk register JSON.
  --runtime <path>    Path to runtime risk register JSON.
  --ignore-cadence    Skip 7-day freshness checks (schema-only/template mode).
`);
  process.exit(code);
}

function parseArgs(argv: string[]): CheckerArgs {
  const parsed: CheckerArgs = { ...DEFAULTS };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }

    if (arg === '--delivery') {
      if (!next) {
        throw new Error('Missing value for --delivery');
      }
      parsed.deliveryPath = next.trim();
      i += 1;
      continue;
    }

    if (arg === '--runtime') {
      if (!next) {
        throw new Error('Missing value for --runtime');
      }
      parsed.runtimePath = next.trim();
      i += 1;
      continue;
    }
    if (arg === '--ignore-cadence') {
      parsed.ignoreCadence = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseIsoUtc(value: unknown): number | null {
  if (!isNonEmptyString(value) || !ISO_UTC_REGEX.test(value)) {
    return null;
  }
  const epoch = Date.parse(value);
  return Number.isNaN(epoch) ? null : epoch;
}

function readJsonFile(filePath: string): unknown {
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as unknown;
}

function validateRegister(
  value: unknown,
  expectedType: RegisterType,
  label: string,
  errors: string[],
  nowEpochMs: number,
  ignoreCadence: boolean
): string[] {
  const riskIds: string[] = [];

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${label}: register must be a JSON object`);
    return riskIds;
  }

  const register = value as RiskRegister;
  if (register.schema_version !== '1.0') {
    errors.push(`${label}: schema_version must equal "1.0"`);
  }
  if (register.register_type !== expectedType) {
    errors.push(`${label}: register_type must equal "${expectedType}"`);
  }
  if (!isNonEmptyString(register.register_owner)) {
    errors.push(`${label}: register_owner is required and must be non-empty`);
  }
  const registerGeneratedAt = parseIsoUtc(register.generated_at_utc);
  if (registerGeneratedAt === null) {
    errors.push(`${label}: generated_at_utc must be valid UTC ISO-8601`);
  }

  const registerLastReview = parseIsoUtc(register.last_review_utc);
  const registerNextReview = parseIsoUtc(register.next_review_utc);
  if (registerLastReview === null) {
    errors.push(`${label}: last_review_utc must be valid UTC ISO-8601 (review_date requirement)`);
  }
  if (registerNextReview === null) {
    errors.push(`${label}: next_review_utc must be valid UTC ISO-8601 (review_date requirement)`);
  }
  if (
    registerLastReview !== null &&
    registerNextReview !== null &&
    registerNextReview <= registerLastReview
  ) {
    errors.push(`${label}: next_review_utc must be later than last_review_utc`);
  }
  if (!ignoreCadence && registerLastReview !== null && nowEpochMs - registerLastReview > REVIEW_CADENCE_MS) {
    errors.push(`${label}: last_review_utc is stale (must be within the last 7 days)`);
  }
  if (
    !ignoreCadence &&
    registerLastReview !== null &&
    registerNextReview !== null &&
    registerNextReview - registerLastReview > REVIEW_CADENCE_MS
  ) {
    errors.push(`${label}: next_review_utc must be within 7 days of last_review_utc`);
  }

  if (!Array.isArray(register.risks)) {
    errors.push(`${label}: risks must be an array`);
    return riskIds;
  }
  if (register.risks.length === 0 && !isNonEmptyString(register.empty_register_reason)) {
    errors.push(`${label}: empty risks array requires non-empty empty_register_reason`);
  }

  for (let i = 0; i < register.risks.length; i += 1) {
    const riskValue = register.risks[i];
    const riskLabel = `${label} risks[${i}]`;

    if (typeof riskValue !== 'object' || riskValue === null || Array.isArray(riskValue)) {
      errors.push(`${riskLabel}: risk record must be a JSON object`);
      continue;
    }

    const risk = riskValue as RiskRecord;
    const riskId = risk.risk_id;
    if (!isNonEmptyString(riskId)) {
      errors.push(`${riskLabel}: risk_id is required`);
    } else {
      const pattern = expectedType === 'delivery' ? DELIVERY_RISK_ID_REGEX : RUNTIME_RISK_ID_REGEX;
      if (!pattern.test(riskId)) {
        errors.push(`${riskLabel}: risk_id "${riskId}" does not match required pattern`);
      }
      riskIds.push(riskId);
    }

    const requiredStringFields: Array<keyof RiskRecord> = [
      'title',
      'trigger',
      'mitigation',
      'contingency',
      'owner',
      'evidence_ref',
    ];
    for (const field of requiredStringFields) {
      if (!isNonEmptyString(risk[field])) {
        errors.push(`${riskLabel}: ${field} is required and must be non-empty`);
      }
    }

    if (isNonEmptyString(risk.title) && risk.title.length > 120) {
      errors.push(`${riskLabel}: title must be <= 120 characters`);
    }
    if (!isNonEmptyString(risk.status) || !STATUS_VALUES.has(risk.status)) {
      errors.push(`${riskLabel}: status must be one of ${Array.from(STATUS_VALUES).join(', ')}`);
    }
    if (!isNonEmptyString(risk.likelihood) || !LIKELIHOOD_VALUES.has(risk.likelihood)) {
      errors.push(
        `${riskLabel}: likelihood must be one of ${Array.from(LIKELIHOOD_VALUES).join(', ')}`
      );
    }
    if (!isNonEmptyString(risk.impact) || !IMPACT_VALUES.has(risk.impact)) {
      errors.push(`${riskLabel}: impact must be one of ${Array.from(IMPACT_VALUES).join(', ')}`);
    }

    if (parseIsoUtc(risk.opened_at_utc) === null) {
      errors.push(`${riskLabel}: opened_at_utc must be valid UTC ISO-8601`);
    }
    const riskLastReview = parseIsoUtc(risk.last_review_utc);
    const riskNextReview = parseIsoUtc(risk.next_review_utc);
    if (riskLastReview === null) {
      errors.push(`${riskLabel}: last_review_utc must be valid UTC ISO-8601 (review_date requirement)`);
    }
    if (riskNextReview === null) {
      errors.push(`${riskLabel}: next_review_utc must be valid UTC ISO-8601 (review_date requirement)`);
    }
    if (riskLastReview !== null && riskNextReview !== null && riskNextReview <= riskLastReview) {
      errors.push(`${riskLabel}: next_review_utc must be later than last_review_utc`);
    }
    if (!ignoreCadence && riskLastReview !== null && nowEpochMs - riskLastReview > REVIEW_CADENCE_MS) {
      errors.push(`${riskLabel}: last_review_utc is stale (must be within the last 7 days)`);
    }
    if (
      !ignoreCadence &&
      riskLastReview !== null &&
      riskNextReview !== null &&
      riskNextReview - riskLastReview > REVIEW_CADENCE_MS
    ) {
      errors.push(`${riskLabel}: next_review_utc must be within 7 days of last_review_utc`);
    }

    if (expectedType === 'delivery') {
      if (!isNonEmptyString(risk.delivery_milestone) || !DELIVERY_MILESTONES.has(risk.delivery_milestone)) {
        errors.push(
          `${riskLabel}: delivery_milestone must be one of ${Array.from(DELIVERY_MILESTONES).join(', ')}`
        );
      }
      if (!Array.isArray(risk.dependency_refs) || risk.dependency_refs.length === 0) {
        errors.push(`${riskLabel}: dependency_refs is required and must be a non-empty array`);
      } else {
        const allRecommendationIds = risk.dependency_refs.every((item) =>
          isNonEmptyString(item) ? /^R\d+$/.test(item) : false
        );
        if (!allRecommendationIds) {
          errors.push(`${riskLabel}: dependency_refs entries must be recommendation IDs like R4`);
        }
      }
      if (risk.runtime_surface !== undefined) {
        errors.push(`${riskLabel}: runtime_surface is not allowed in delivery register`);
      }
      if (risk.detect_signal !== undefined) {
        errors.push(`${riskLabel}: detect_signal is not allowed in delivery register`);
      }
    } else {
      if (!isNonEmptyString(risk.runtime_surface)) {
        errors.push(`${riskLabel}: runtime_surface is required and must be non-empty`);
      }
      if (!isNonEmptyString(risk.detect_signal)) {
        errors.push(`${riskLabel}: detect_signal is required and must be non-empty`);
      }
      if (risk.delivery_milestone !== undefined) {
        errors.push(`${riskLabel}: delivery_milestone is not allowed in runtime register`);
      }
      if (risk.dependency_refs !== undefined) {
        errors.push(`${riskLabel}: dependency_refs is not allowed in runtime register`);
      }
    }
  }

  return riskIds;
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

  const deliveryPath = path.resolve(args.deliveryPath);
  const runtimePath = path.resolve(args.runtimePath);
  const errors: string[] = [];
  const riskIdLocations = new Map<string, string[]>();
  const nowEpochMs = Date.now();

  // eslint-disable-next-line no-console
  console.log('R7 split risk register check');
  // eslint-disable-next-line no-console
  console.log(`Delivery register: ${deliveryPath}`);
  // eslint-disable-next-line no-console
  console.log(`Runtime register: ${runtimePath}`);

  const inputs: Array<{ label: string; expectedType: RegisterType; filePath: string }> = [
    { label: 'delivery register', expectedType: 'delivery', filePath: deliveryPath },
    { label: 'runtime register', expectedType: 'runtime', filePath: runtimePath },
  ];

  let totalRisks = 0;
  for (const input of inputs) {
    if (!fs.existsSync(input.filePath)) {
      errors.push(`${input.label}: file not found at ${input.filePath}`);
      continue;
    }

    let json: unknown;
    try {
      json = readJsonFile(input.filePath);
    } catch (error) {
      errors.push(
        `${input.label}: failed to read/parse JSON (${error instanceof Error ? error.message : String(error)})`
      );
      continue;
    }

    const riskIds = validateRegister(
      json,
      input.expectedType,
      input.label,
      errors,
      nowEpochMs,
      args.ignoreCadence
    );
    totalRisks += riskIds.length;

    for (const riskId of riskIds) {
      const list = riskIdLocations.get(riskId) ?? [];
      list.push(input.label);
      riskIdLocations.set(riskId, list);
    }
  }

  for (const [riskId, locations] of riskIdLocations.entries()) {
    if (locations.length > 1) {
      errors.push(
        `risk_id must be unique across both registers: ${riskId} appears in ${locations.join(', ')}`
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log(`risk_records=${totalRisks}`);

  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error('Validation errors:');
    for (const error of errors) {
      // eslint-disable-next-line no-console
      console.error(`- ${error}`);
    }
    // eslint-disable-next-line no-console
    console.error(`R7 split risk register check failed with ${errors.length} issue(s).`);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log('R7 split risk register check passed.');
}

main();
