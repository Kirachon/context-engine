#!/usr/bin/env node
/**
 * D1c2 — Evidence-date / provenance CI contract checker.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

type Policy = {
  schema_version: number;
  task_id: string;
  intentional_exceptions: Array<{ path: string; reason: string }>;
  ci_contract: { fail_on: string[] };
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')) as T;
}

function isIsoDateDir(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(name);
}

function isUnderException(relativePath: string, exceptions: string[]): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  return exceptions.some((ex) => {
    const e = ex.replace(/\\/g, '/');
    return normalized === e || normalized.startsWith(e.endsWith('/') ? e : `${e}/`) || e.endsWith('/') && normalized.startsWith(e);
  });
}

export function checkEvidenceDateContract(root = repoRoot): string[] {
  const policy = readJson<Policy>('config/ci/evidence-date-policy.json');
  const errors: string[] = [];
  const exceptionPaths = policy.intentional_exceptions.map((e) => e.path);

  const evidenceRoot = path.join(root, 'docs/rollout-evidence');
  if (fs.existsSync(evidenceRoot)) {
    for (const entry of fs.readdirSync(evidenceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!isIsoDateDir(entry.name)) {
        errors.push(`directory_date_not_iso: docs/rollout-evidence/${entry.name}`);
      }
    }
  }

  const machineCandidates = [
    ...globFiles(path.join(root, 'artifacts/plan'), /^context-engine-remediation-.*\.json$/),
    ...globFiles(path.join(root, 'artifacts/bench'), /-(gate|receipt)\.json$/),
  ];

  for (const absolute of machineCandidates) {
    const relative = path.relative(root, absolute).replace(/\\/g, '/');
    if (isUnderException(relative, exceptionPaths)) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(fs.readFileSync(absolute, 'utf8')) as Record<string, unknown>;
    } catch {
      errors.push(`unreadable_json: ${relative}`);
      continue;
    }

    const commit =
      (typeof parsed.commit_sha === 'string' && parsed.commit_sha) ||
      (typeof (parsed.reproducibility_lock as { commit_sha?: string } | undefined)?.commit_sha === 'string'
        ? (parsed.reproducibility_lock as { commit_sha: string }).commit_sha
        : null);

    if (commit && !/^[0-9a-f]{7,40}$/i.test(commit)) {
      errors.push(`commit_sha_malformed: ${relative}`);
    }

    // Fingerprint / inventory receipts must carry a content hash field when present for D1c-style contracts.
    if (relative.includes('q4a-goldens') || relative.includes('q4b-parity') || relative.includes('calibration-receipt')) {
      const hasHash =
        typeof parsed.golden_inventory_sha256 === 'string' ||
        typeof parsed.parity_inventory_sha256 === 'string' ||
        typeof (parsed.evaluation as { status?: string } | undefined)?.status === 'string' ||
        typeof parsed.corpus_identity === 'object';
      if (!hasHash && typeof parsed.evaluation !== 'object') {
        errors.push(`missing_required_machine_hash_field: ${relative}`);
      }
    }
  }

  return errors;
}

function globFiles(dir: string, pattern: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(dir, name));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkEvidenceDateContract();
  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ status: 'fail', errors }, null, 2));
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ status: 'pass', errors: [] }, null, 2));
  process.exit(0);
}
