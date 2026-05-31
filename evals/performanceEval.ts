import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  NormalizedContextPackReceipt,
  NormalizedPerformanceCheck,
  NormalizedPerformanceReceipt,
  NormalizedRetrievalReceipt,
  NormalizedSafetyReceipt,
  NormalizedUsefulnessReceipt,
} from './normalizeEvalOutput.js';

export interface PerformanceBudgetsFile {
  schema_version: number;
  budgets: {
    usefulness_top1_min: number;
    context_pack_max_items: number;
    safety_min_cases: number;
    retrieval_min_cases: number;
  };
}

export interface PerformanceEvalPaths {
  repoRoot: string;
  budgetsPath: string;
}

function readJsonFile<T>(filePath: string): T {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Missing fixture file: ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8')) as T;
}

function buildCheck(
  id: string,
  metric: string,
  value: number,
  budget: number,
  comparator: 'min' | 'max'
): NormalizedPerformanceCheck {
  const status =
    comparator === 'min'
      ? value >= budget
        ? 'pass'
        : 'fail'
      : value <= budget
        ? 'pass'
        : 'fail';
  return {
    id,
    metric,
    value,
    budget,
    comparator,
    status,
  };
}

export function buildPerformanceReceipt(
  paths: PerformanceEvalPaths,
  inputs: {
    retrieval: NormalizedRetrievalReceipt;
    contextPacks: NormalizedContextPackReceipt[];
    safety: NormalizedSafetyReceipt;
    usefulness: NormalizedUsefulnessReceipt;
  }
): NormalizedPerformanceReceipt {
  const budgets = readJsonFile<PerformanceBudgetsFile>(paths.budgetsPath).budgets;
  const contextPackItems = inputs.contextPacks.reduce((sum, entry) => sum + entry.item_count, 0);

  const checks: NormalizedPerformanceCheck[] = [
    buildCheck(
      'retrieval_case_count',
      'case_count',
      inputs.retrieval.case_count,
      budgets.retrieval_min_cases,
      'min'
    ),
    buildCheck(
      'safety_case_count',
      'case_count',
      inputs.safety.case_count,
      budgets.safety_min_cases,
      'min'
    ),
    buildCheck(
      'usefulness_top1_rate',
      'top_one_rate',
      inputs.usefulness.top_one_rate,
      budgets.usefulness_top1_min,
      'min'
    ),
    buildCheck(
      'context_pack_item_budget',
      'item_count',
      contextPackItems,
      budgets.context_pack_max_items,
      'max'
    ),
  ];

  const passed = checks.filter((entry) => entry.status === 'pass').length;

  return {
    check_count: checks.length,
    passed_count: passed,
    checks,
  };
}

export function resolveDefaultPerformancePaths(repoRoot: string): PerformanceEvalPaths {
  return {
    repoRoot,
    budgetsPath: path.join(repoRoot, 'evals', 'fixtures', 'performance-budgets.json'),
  };
}
