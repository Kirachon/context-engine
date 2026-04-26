import * as fs from 'fs';
import * as path from 'path';

import type { CompletePlanState, EnhancedPlanStep } from '../types/planning.js';
import {
  readPersistedPlanState,
  type PersistedPlanStateReadReason,
  type PersistedPlanStateReadResult,
} from '../tools/planManagement.js';

const MEMORIES_DIR = '.memories';
const CATEGORY_FILES = {
  preferences: 'preferences.md',
  decisions: 'decisions.md',
  facts: 'facts.md',
} as const;

type MemoryCategory = keyof typeof CATEGORY_FILES;
type MemoryPriority = 'critical' | 'helpful' | 'archive';

export type HandoffReasonCode = PersistedPlanStateReadReason | 'findings_unavailable';

export interface HandoffMemoryRecord {
  category: MemoryCategory;
  content: string;
  title?: string;
  subtype?: string;
  priority?: MemoryPriority;
  tags?: string[];
  source?: string;
  linked_files?: string[];
  linked_plans?: string[];
  evidence?: string;
  owner?: string;
  created_at?: string;
  updated_at?: string;
  rank_score: number;
  relative_path: string;
  entry_index: number;
}

export interface HandoffStepSummary {
  step_number: number;
  title: string;
  description: string;
  acceptance_criteria: string[];
  linked_files: string[];
}

export interface SharedHandoffPayload {
  objective: string;
  scope_in: string[];
  scope_out: string[];
  constraints: string[];
  current_step: HandoffStepSummary | null;
  completed_steps: HandoffStepSummary[];
  unresolved_risks: string[];
  linked_files: string[];
  approved_memories: HandoffMemoryRecord[];
  recent_review_findings: HandoffMemoryRecord[];
  next_actions: string[];
}

export type ApprovedMemoriesReadResult = {
  ok: true;
  memories: HandoffMemoryRecord[];
};

export type ReviewFindingsReadResult =
  | {
    ok: true;
    findings: HandoffMemoryRecord[];
  }
  | {
    ok: false;
    reason: 'findings_unavailable';
    findings: [];
    message: string;
  };

function parseMetadataListField(rawValue?: string): string[] | undefined {
  if (!rawValue) return undefined;
  const entries = rawValue
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : undefined;
}

function calculateMemoryRankScore(memory: Omit<HandoffMemoryRecord, 'rank_score'>): number {
  const base = 0.5;
  let score = base;

  if (memory.priority === 'critical') score += 0.12;
  else if (memory.priority === 'helpful') score += 0.06;
  else if (memory.priority === 'archive') score -= 0.04;

  if (memory.category === 'decisions') score += 0.06;
  if (memory.category === 'preferences') score += 0.03;

  if (memory.subtype === 'review_finding' || memory.subtype === 'failed_attempt') {
    score += 0.04;
  } else if (memory.subtype === 'incident' || memory.subtype === 'plan_note') {
    score += 0.02;
  }

  const updatedAt = memory.updated_at || memory.created_at;
  if (updatedAt) {
    const ageDays = Math.floor((Date.now() - Date.parse(updatedAt)) / (1000 * 60 * 60 * 24));
    if (!Number.isNaN(ageDays) && ageDays >= 0) {
      if (ageDays <= 14) score += 0.08;
      else if (ageDays <= 60) score += 0.04;
      else if (ageDays <= 180) score += 0.02;
    }
  }

  return Math.min(1, Math.max(0, score));
}

function compareIsoDateDesc(left?: string, right?: string): number {
  const leftTime = left ? Date.parse(left) : Number.NaN;
  const rightTime = right ? Date.parse(right) : Number.NaN;
  if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return 0;
  if (Number.isNaN(leftTime)) return 1;
  if (Number.isNaN(rightTime)) return -1;
  return rightTime - leftTime;
}

function compareMemoryRecords(left: HandoffMemoryRecord, right: HandoffMemoryRecord): number {
  return (right.rank_score - left.rank_score)
    || compareIsoDateDesc(left.updated_at || left.created_at, right.updated_at || right.created_at)
    || left.category.localeCompare(right.category)
    || (left.title || '').localeCompare(right.title || '')
    || left.content.localeCompare(right.content);
}

function summarizeStep(step: EnhancedPlanStep): HandoffStepSummary {
  const linkedFiles = new Set<string>();
  for (const file of step.files_to_modify ?? []) linkedFiles.add(file.path);
  for (const file of step.files_to_create ?? []) linkedFiles.add(file.path);
  for (const file of step.files_to_delete ?? []) linkedFiles.add(file);

  return {
    step_number: step.step_number,
    title: step.title,
    description: step.description,
    acceptance_criteria: [...(step.acceptance_criteria ?? [])],
    linked_files: [...linkedFiles].sort((left, right) => left.localeCompare(right)),
  };
}

function getStepByNumber(planState: CompletePlanState, stepNumber: number): EnhancedPlanStep | undefined {
  return (planState.plan.steps ?? []).find((step) => step.step_number === stepNumber);
}

function collectPlanLinkedFiles(planState: CompletePlanState, approvedMemories: HandoffMemoryRecord[], reviewFindings: HandoffMemoryRecord[]): string[] {
  const linkedFiles = new Set<string>(planState.plan.context_files ?? []);

  for (const step of planState.plan.steps ?? []) {
    for (const file of step.files_to_modify ?? []) linkedFiles.add(file.path);
    for (const file of step.files_to_create ?? []) linkedFiles.add(file.path);
    for (const file of step.files_to_delete ?? []) linkedFiles.add(file);
  }

  for (const memory of [...approvedMemories, ...reviewFindings]) {
    for (const file of memory.linked_files ?? []) {
      linkedFiles.add(file);
    }
  }

  return [...linkedFiles].sort((left, right) => left.localeCompare(right));
}

function buildNextActions(planState: CompletePlanState, currentStep: HandoffStepSummary | null): string[] {
  const actions: string[] = [];

  if (currentStep) {
    actions.push(`Continue step ${currentStep.step_number}: ${currentStep.title}`);
  }

  const readySteps = (planState.execution.ready_steps ?? [])
    .map((stepNumber) => getStepByNumber(planState, stepNumber))
    .filter((step): step is EnhancedPlanStep => Boolean(step));

  for (const step of readySteps) {
    if (actions.length >= 3) break;
    if (currentStep && step.step_number === currentStep.step_number) continue;
    actions.push(`Queue step ${step.step_number}: ${step.title}`);
  }

  if (actions.length === 0) {
    const executionOrder = planState.plan.dependency_graph?.execution_order ?? [];
    const completed = new Set(
      (planState.execution.steps ?? [])
        .filter((step) => step.status === 'completed')
        .map((step) => step.step_number)
    );
    const nextStepNumber = executionOrder.find((stepNumber) => !completed.has(stepNumber))
      ?? planState.plan.steps?.[0]?.step_number;
    const nextStep = nextStepNumber !== undefined ? getStepByNumber(planState, nextStepNumber) : undefined;
    if (nextStep) {
      actions.push(`Start step ${nextStep.step_number}: ${nextStep.title}`);
    }
  }

  return actions;
}

function parsePersistedMemoryFile(category: MemoryCategory, filePath: string, relativePath: string): HandoffMemoryRecord[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/u);
  let cursor = 0;

  if (/^#\s+/u.test(lines[0] ?? '')) {
    cursor += 1;
    while (cursor < lines.length && (lines[cursor] ?? '').trim().length > 0) cursor += 1;
    while (cursor < lines.length && (lines[cursor] ?? '').trim().length === 0) cursor += 1;
  }

  const records: HandoffMemoryRecord[] = [];
  let title: string | undefined;
  let contentLines: string[] = [];
  let metadata = new Map<string, string>();

  const flush = (): void => {
    const text = contentLines.join('\n').trim();
    if (!text) {
      title = undefined;
      contentLines = [];
      metadata = new Map<string, string>();
      return;
    }

    const recordBase: Omit<HandoffMemoryRecord, 'rank_score'> = {
      category,
      content: text,
      ...(title ? { title } : {}),
      ...(metadata.get('subtype') ? { subtype: metadata.get('subtype') } : {}),
      ...(metadata.get('priority') ? { priority: metadata.get('priority') as MemoryPriority } : {}),
      ...(parseMetadataListField(metadata.get('tags')) ? { tags: parseMetadataListField(metadata.get('tags')) } : {}),
      ...(metadata.get('source') ? { source: metadata.get('source') } : {}),
      ...(parseMetadataListField(metadata.get('linked_files')) ? { linked_files: parseMetadataListField(metadata.get('linked_files')) } : {}),
      ...(parseMetadataListField(metadata.get('linked_plans')) ? { linked_plans: parseMetadataListField(metadata.get('linked_plans')) } : {}),
      ...(metadata.get('evidence') ? { evidence: metadata.get('evidence') } : {}),
      ...(metadata.get('owner') ? { owner: metadata.get('owner') } : {}),
      ...(metadata.get('created_at') ? { created_at: metadata.get('created_at') } : {}),
      ...(metadata.get('updated_at') ? { updated_at: metadata.get('updated_at') } : {}),
      relative_path: relativePath,
      entry_index: records.length,
    };

    records.push({
      ...recordBase,
      rank_score: calculateMemoryRankScore(recordBase),
    });

    title = undefined;
    contentLines = [];
    metadata = new Map<string, string>();
  };

  for (let index = cursor; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? '';
    const line = rawLine.trim();

    const headingMatch = /^###\s+\[[^\]]+\]\s+(.+)$/u.exec(line);
    if (headingMatch) {
      flush();
      title = headingMatch[1]?.trim();
      continue;
    }

    const metadataMatch = /^-\s+\[meta\]\s+([a-z_]+)\s*:\s*(.+)$/iu.exec(line);
    if (metadataMatch) {
      metadata.set(metadataMatch[1]!.toLowerCase(), metadataMatch[2]!.trim());
      continue;
    }

    if (!line) {
      continue;
    }

    if (
      !title
      && contentLines.length === 0
      && metadata.size === 0
      && !line.startsWith('- ')
      && !line.startsWith('* ')
      && !line.startsWith('#')
    ) {
      continue;
    }

    if (line.startsWith('- ')) {
      contentLines.push(line.slice(2).trim());
      continue;
    }

    if (line.startsWith('* ')) {
      contentLines.push(line.slice(2).trim());
      continue;
    }

    contentLines.push(line);
  }

  flush();
  return records;
}

function matchesPlanOrFiles(record: HandoffMemoryRecord, planId?: string, linkedFiles?: string[]): boolean {
  const matchesPlan = planId ? (record.linked_plans ?? []).includes(planId) : false;
  const matchesFiles = linkedFiles && linkedFiles.length > 0
    ? (record.linked_files ?? []).some((file) => linkedFiles.includes(file))
    : false;
  return matchesPlan || matchesFiles;
}

export { readPersistedPlanState };
export type { PersistedPlanStateReadResult, PersistedPlanStateReadReason };

export function readPersistedApprovedMemories(workspacePath: string): ApprovedMemoriesReadResult {
  const memoriesDir = path.join(workspacePath, MEMORIES_DIR);
  if (!fs.existsSync(memoriesDir)) {
    return { ok: true, memories: [] };
  }

  const memories: HandoffMemoryRecord[] = [];
  for (const [category, fileName] of Object.entries(CATEGORY_FILES) as Array<[MemoryCategory, string]>) {
    const filePath = path.join(memoriesDir, fileName);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    memories.push(...parsePersistedMemoryFile(category, filePath, `${MEMORIES_DIR}/${fileName}`));
  }

  memories.sort(compareMemoryRecords);
  return {
    ok: true,
    memories,
  };
}

export function readRecentReviewFindings(
  workspacePath: string,
  options: {
    planId?: string;
    linkedFiles?: string[];
    limit?: number;
  } = {}
): ReviewFindingsReadResult {
  try {
    const approved = readPersistedApprovedMemories(workspacePath);
    const candidates = approved.memories.filter((memory) => memory.subtype === 'review_finding');
    if (candidates.length === 0) {
      return { ok: true, findings: [] };
    }

    const linkedCandidates = candidates.filter((record) => matchesPlanOrFiles(record, options.planId, options.linkedFiles));
    const hasFilters = Boolean(options.planId) || Boolean(options.linkedFiles?.length);
    const selectedPool = hasFilters ? linkedCandidates : candidates;
    const selected = [...selectedPool]
      .sort((left, right) =>
        compareIsoDateDesc(left.updated_at || left.created_at, right.updated_at || right.created_at)
        || compareMemoryRecords(left, right))
      .slice(0, options.limit ?? 5);

    return {
      ok: true,
      findings: selected,
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'findings_unavailable',
      findings: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function composeSharedHandoffPayload(input: {
  planState: CompletePlanState;
  approvedMemories: HandoffMemoryRecord[];
  recentReviewFindings: HandoffMemoryRecord[];
}): SharedHandoffPayload {
  const completedStepNumbers = new Set(
    (input.planState.execution.steps ?? [])
      .filter((step) => step.status === 'completed')
      .map((step) => step.step_number)
  );

  const completedSteps = [...completedStepNumbers]
    .map((stepNumber) => getStepByNumber(input.planState, stepNumber))
    .filter((step): step is EnhancedPlanStep => Boolean(step))
    .sort((left, right) => left.step_number - right.step_number)
    .map(summarizeStep);

  const currentStepNumber = input.planState.execution.current_steps?.[0]
    ?? input.planState.execution.ready_steps?.[0]
    ?? input.planState.plan.dependency_graph?.execution_order?.find((stepNumber) => !completedStepNumbers.has(stepNumber))
    ?? input.planState.plan.steps?.[0]?.step_number;
  const currentStep = currentStepNumber !== undefined
    ? getStepByNumber(input.planState, currentStepNumber)
    : undefined;
  const currentStepSummary = currentStep ? summarizeStep(currentStep) : null;

  return {
    objective: input.planState.plan.goal,
    scope_in: [...(input.planState.plan.scope.included ?? [])],
    scope_out: [...(input.planState.plan.scope.excluded ?? [])],
    constraints: [...(input.planState.plan.scope.constraints ?? [])],
    current_step: currentStepSummary,
    completed_steps: completedSteps,
    unresolved_risks: (input.planState.plan.risks ?? []).map((risk) => risk.issue),
    linked_files: collectPlanLinkedFiles(input.planState, input.approvedMemories, input.recentReviewFindings),
    approved_memories: input.approvedMemories,
    recent_review_findings: input.recentReviewFindings,
    next_actions: buildNextActions(input.planState, currentStepSummary),
  };
}
