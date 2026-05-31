import * as fs from 'node:fs';
import * as path from 'node:path';

import { scrubSecrets } from '../src/reactive/guardrails/index.js';
import {
  sha256Hex,
  type NormalizedSafetyCaseReceipt,
  type NormalizedSafetyReceipt,
} from './normalizeEvalOutput.js';

export interface SafetyFixtureCase {
  id: string;
  content: string;
  expect_secrets: boolean;
  expect_types: string[];
}

export interface SafetyFixturesFile {
  schema_version: number;
  cases: SafetyFixtureCase[];
}

export interface SafetyEvalPaths {
  repoRoot: string;
  safetyFixturesPath: string;
}

function readJsonFile<T>(filePath: string): T {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Missing fixture file: ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8')) as T;
}

export function buildSafetyReceipt(paths: SafetyEvalPaths): NormalizedSafetyReceipt {
  const fixtures = readJsonFile<SafetyFixturesFile>(paths.safetyFixturesPath);
  const sortedCases = [...fixtures.cases].sort((left, right) => left.id.localeCompare(right.id));

  const cases: NormalizedSafetyCaseReceipt[] = sortedCases.map((fixtureCase) => {
    const result = scrubSecrets(fixtureCase.content);
    const detectedTypes = [...new Set(result.detectedSecrets.map((entry) => entry.type))].sort();
    const expectTypes = [...fixtureCase.expect_types].sort();
    const secretsMatch = result.hasSecrets === fixtureCase.expect_secrets;
    const typesMatch =
      sha256Hex(JSON.stringify(detectedTypes)) === sha256Hex(JSON.stringify(expectTypes));
    const scrubbedHash = sha256Hex(result.scrubbedContent);

    return {
      id: fixtureCase.id,
      secrets_detected: result.hasSecrets,
      detected_types: detectedTypes,
      expect_secrets: fixtureCase.expect_secrets,
      expect_types: expectTypes,
      secrets_match: secretsMatch,
      types_match: typesMatch,
      scrubbed_hash: scrubbedHash,
      status: secretsMatch && typesMatch ? 'pass' : 'fail',
    };
  });

  const passed = cases.filter((entry) => entry.status === 'pass').length;

  return {
    case_count: cases.length,
    passed_count: passed,
    cases,
  };
}

export function resolveDefaultSafetyPaths(repoRoot: string): SafetyEvalPaths {
  return {
    repoRoot,
    safetyFixturesPath: path.join(repoRoot, 'evals', 'fixtures', 'safety-fixtures.json'),
  };
}
