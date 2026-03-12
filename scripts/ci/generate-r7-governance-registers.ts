#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';

interface RegisterRisk {
  last_review_utc?: string;
  next_review_utc?: string;
  [key: string]: unknown;
}

interface RegisterFile {
  generated_at_utc?: string;
  last_review_utc?: string;
  next_review_utc?: string;
  risks?: RegisterRisk[];
  [key: string]: unknown;
}

const TEMPLATE_DELIVERY = 'docs/templates/r7-delivery-risk-register.template.json';
const TEMPLATE_RUNTIME = 'docs/templates/r7-runtime-risk-register.template.json';
const OUT_DELIVERY = 'artifacts/governance/r7-delivery-risk-register.json';
const OUT_RUNTIME = 'artifacts/governance/r7-runtime-risk-register.json';

function toUtcIsoSeconds(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function readRegister(filePath: string): RegisterFile {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8')) as RegisterFile;
}

function applyFreshReviewWindow(register: RegisterFile, now: Date, next: Date): RegisterFile {
  const updated: RegisterFile = { ...register };
  updated.generated_at_utc = toUtcIsoSeconds(now);
  updated.last_review_utc = toUtcIsoSeconds(now);
  updated.next_review_utc = toUtcIsoSeconds(next);
  if (Array.isArray(updated.risks)) {
    updated.risks = updated.risks.map((risk) => ({
      ...risk,
      last_review_utc: toUtcIsoSeconds(now),
      next_review_utc: toUtcIsoSeconds(next),
    }));
  }
  return updated;
}

function writeJson(filePath: string, value: unknown): void {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(): number {
  const now = new Date();
  const next = new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000);

  const delivery = applyFreshReviewWindow(readRegister(TEMPLATE_DELIVERY), now, next);
  const runtime = applyFreshReviewWindow(readRegister(TEMPLATE_RUNTIME), now, next);

  writeJson(OUT_DELIVERY, delivery);
  writeJson(OUT_RUNTIME, runtime);

  // eslint-disable-next-line no-console
  console.log(`Generated R7 governance registers: ${OUT_DELIVERY}, ${OUT_RUNTIME}`);
  return 0;
}

process.exitCode = run();
