import type { ContextServiceClient } from '../serviceClient.js';
import type { CompletePlanState } from '../types/planning.js';
import {
  composeSharedHandoffPayload,
  readPersistedApprovedMemories,
  readPersistedPlanState,
  readRecentReviewFindings,
  type HandoffMemoryRecord,
  type HandoffReasonCode,
  type SharedHandoffPayload,
} from './sharedCore.js';

export type ActivePlanHandoffReasonCode = HandoffReasonCode | 'truncated';

export interface ActivePlanHandoffDiagnostic {
  reason: ActivePlanHandoffReasonCode;
  message: string;
}

export interface ActivePlanHandoffEnvelope {
  mode: 'active_plan';
  plan_id: string;
  status: 'ready' | 'degraded' | 'unavailable';
  payload?: SharedHandoffPayload;
  diagnostics?: ActivePlanHandoffDiagnostic[];
}

const MAX_LINKED_FILES = 10;
const MAX_COMPLETED_STEPS = 5;
const MAX_APPROVED_MEMORIES = 5;
const MAX_REVIEW_FINDINGS = 5;
const MAX_MEMORY_CONTENT_CHARS = 320;
const MAX_PAYLOAD_CHARS = 12_000;

function collectHandoffLinkedFiles(planState: CompletePlanState): string[] {
  const linkedFiles = new Set<string>(planState.plan.context_files ?? []);
  for (const step of planState.plan.steps ?? []) {
    for (const file of step.files_to_modify ?? []) linkedFiles.add(file.path);
    for (const file of step.files_to_create ?? []) linkedFiles.add(file.path);
    for (const file of step.files_to_delete ?? []) linkedFiles.add(file);
  }
  return [...linkedFiles].sort((left, right) => left.localeCompare(right));
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function capTextList(values: string[] | undefined, maxCount: number, maxChars: number): string[] {
  return (values ?? [])
    .slice(0, maxCount)
    .map((value) => truncateText(value, maxChars));
}

function sanitizeMemoryRecord(record: HandoffMemoryRecord): HandoffMemoryRecord {
  return {
    ...record,
    content: truncateText(record.content, MAX_MEMORY_CONTENT_CHARS),
    ...(record.title ? { title: truncateText(record.title, 160) } : {}),
    ...(record.subtype ? { subtype: truncateText(record.subtype, 80) } : {}),
    ...(record.tags ? { tags: capTextList(record.tags, 10, 80) } : {}),
    ...(record.source ? { source: truncateText(record.source, 200) } : {}),
    ...(record.linked_files ? { linked_files: capTextList(record.linked_files, 10, 200) } : {}),
    ...(record.linked_plans ? { linked_plans: capTextList(record.linked_plans, 10, 120) } : {}),
    ...(record.evidence ? { evidence: truncateText(record.evidence, 300) } : {}),
    ...(record.owner ? { owner: truncateText(record.owner, 120) } : {}),
  };
}

function capMemoryRecords(records: HandoffMemoryRecord[], maxCount: number): {
  records: HandoffMemoryRecord[];
  reasons: string[];
} {
  const reasons: string[] = [];
  if (records.length > maxCount) {
    reasons.push(`limited records from ${records.length} to ${maxCount}`);
  }

  let contentTruncated = false;
  const cappedRecords = records
    .slice(0, maxCount)
    .map((record) => {
      const sanitizedRecord = sanitizeMemoryRecord(record);
      if (JSON.stringify(sanitizedRecord) !== JSON.stringify(record)) {
        contentTruncated = true;
      }
      return sanitizedRecord;
    });

  if (contentTruncated) {
    reasons.push(`truncated record fields to bounded lengths`);
  }

  return {
    records: cappedRecords,
    reasons,
  };
}

function capStepSummary(step: SharedHandoffPayload['current_step']): SharedHandoffPayload['current_step'] {
  if (!step) {
    return null;
  }

  return {
    ...step,
    description: truncateText(step.description, 400),
    acceptance_criteria: capTextList(step.acceptance_criteria, 5, 180),
    linked_files: step.linked_files.slice(0, MAX_LINKED_FILES),
  };
}

function applyPayloadCaps(payload: SharedHandoffPayload): {
  payload: SharedHandoffPayload;
  diagnostics: ActivePlanHandoffDiagnostic[];
} {
  const truncationReasons: string[] = [];
  const approved = capMemoryRecords(payload.approved_memories, MAX_APPROVED_MEMORIES);
  const findings = capMemoryRecords(payload.recent_review_findings, MAX_REVIEW_FINDINGS);
  const linkedFiles = payload.linked_files.slice(0, MAX_LINKED_FILES);
  const completedSteps = payload.completed_steps.slice(0, MAX_COMPLETED_STEPS);

  if (payload.linked_files.length > linkedFiles.length) {
    truncationReasons.push(`limited linked_files from ${payload.linked_files.length} to ${linkedFiles.length}`);
  }
  if (payload.completed_steps.length > completedSteps.length) {
    truncationReasons.push(`limited completed_steps from ${payload.completed_steps.length} to ${completedSteps.length}`);
  }
  truncationReasons.push(...approved.reasons.map((reason) => `approved_memories ${reason}`));
  truncationReasons.push(...findings.reasons.map((reason) => `recent_review_findings ${reason}`));

  const cappedPayload: SharedHandoffPayload = {
    ...payload,
    linked_files: linkedFiles,
    completed_steps: completedSteps,
    approved_memories: approved.records,
    recent_review_findings: findings.records,
  };

  let serializedLength = JSON.stringify(cappedPayload).length;
  if (serializedLength > MAX_PAYLOAD_CHARS && cappedPayload.approved_memories.length > 0) {
    while (serializedLength > MAX_PAYLOAD_CHARS && cappedPayload.approved_memories.length > 0) {
      cappedPayload.approved_memories = cappedPayload.approved_memories.slice(0, -1);
      serializedLength = JSON.stringify(cappedPayload).length;
    }
    truncationReasons.push(`reduced approved_memories to fit ${MAX_PAYLOAD_CHARS} characters`);
  }
  if (serializedLength > MAX_PAYLOAD_CHARS && cappedPayload.recent_review_findings.length > 0) {
    while (serializedLength > MAX_PAYLOAD_CHARS && cappedPayload.recent_review_findings.length > 0) {
      cappedPayload.recent_review_findings = cappedPayload.recent_review_findings.slice(0, -1);
      serializedLength = JSON.stringify(cappedPayload).length;
    }
    truncationReasons.push(`reduced recent_review_findings to fit ${MAX_PAYLOAD_CHARS} characters`);
  }
  if (serializedLength > MAX_PAYLOAD_CHARS && cappedPayload.linked_files.length > 0) {
    while (serializedLength > MAX_PAYLOAD_CHARS && cappedPayload.linked_files.length > 0) {
      cappedPayload.linked_files = cappedPayload.linked_files.slice(0, -1);
      serializedLength = JSON.stringify(cappedPayload).length;
    }
    truncationReasons.push(`reduced linked_files to fit ${MAX_PAYLOAD_CHARS} characters`);
  }
  if (serializedLength > MAX_PAYLOAD_CHARS) {
    cappedPayload.objective = truncateText(cappedPayload.objective, 1000);
    cappedPayload.scope_in = capTextList(cappedPayload.scope_in, 10, 400);
    cappedPayload.scope_out = capTextList(cappedPayload.scope_out, 10, 400);
    cappedPayload.constraints = capTextList(cappedPayload.constraints, 10, 400);
    cappedPayload.unresolved_risks = capTextList(cappedPayload.unresolved_risks, 10, 400);
    cappedPayload.next_actions = capTextList(cappedPayload.next_actions, 3, 300);
    cappedPayload.current_step = capStepSummary(cappedPayload.current_step);
    cappedPayload.completed_steps = cappedPayload.completed_steps
      .slice(0, 3)
      .map((step) => capStepSummary(step)!);
    serializedLength = JSON.stringify(cappedPayload).length;
    truncationReasons.push(`truncated plan fields to fit ${MAX_PAYLOAD_CHARS} characters`);
  }
  if (serializedLength > MAX_PAYLOAD_CHARS && cappedPayload.completed_steps.length > 0) {
    cappedPayload.completed_steps = [];
    serializedLength = JSON.stringify(cappedPayload).length;
    truncationReasons.push(`removed completed_steps to fit ${MAX_PAYLOAD_CHARS} characters`);
  }
  if (serializedLength > MAX_PAYLOAD_CHARS) {
    cappedPayload.objective = truncateText(cappedPayload.objective, 400);
    cappedPayload.scope_in = capTextList(cappedPayload.scope_in, 5, 200);
    cappedPayload.scope_out = capTextList(cappedPayload.scope_out, 5, 200);
    cappedPayload.constraints = capTextList(cappedPayload.constraints, 5, 200);
    cappedPayload.unresolved_risks = capTextList(cappedPayload.unresolved_risks, 5, 200);
    cappedPayload.current_step = null;
    serializedLength = JSON.stringify(cappedPayload).length;
    truncationReasons.push(`applied fallback plan field caps to fit ${MAX_PAYLOAD_CHARS} characters`);
  }
  if (serializedLength > MAX_PAYLOAD_CHARS) {
    cappedPayload.approved_memories = [];
    cappedPayload.recent_review_findings = [];
    cappedPayload.linked_files = [];
    cappedPayload.next_actions = [];
    serializedLength = JSON.stringify(cappedPayload).length;
    truncationReasons.push(`removed optional handoff sections to fit ${MAX_PAYLOAD_CHARS} characters`);
  }
  if (serializedLength > MAX_PAYLOAD_CHARS) {
    cappedPayload.objective = truncateText(cappedPayload.objective, 120);
    cappedPayload.scope_in = [];
    cappedPayload.scope_out = [];
    cappedPayload.constraints = [];
    cappedPayload.unresolved_risks = [];
    cappedPayload.current_step = null;
    cappedPayload.completed_steps = [];
    truncationReasons.push(`applied minimum handoff payload caps to fit ${MAX_PAYLOAD_CHARS} characters`);
  }

  return {
    payload: cappedPayload,
    diagnostics: truncationReasons.length > 0
      ? [{
        reason: 'truncated',
        message: truncationReasons.join('; '),
      }]
      : [],
  };
}

export async function buildActivePlanHandoff(
  serviceClient: ContextServiceClient,
  planId: string
): Promise<ActivePlanHandoffEnvelope> {
  const planResult = await readPersistedPlanState(planId);
  if (!planResult.ok) {
    return {
      mode: 'active_plan',
      plan_id: planId,
      status: 'unavailable',
      diagnostics: [
        {
          reason: planResult.reason,
          message: planResult.message,
        },
      ],
    };
  }

  const workspacePath = serviceClient.getWorkspacePath();
  const linkedFiles = collectHandoffLinkedFiles(planResult.state);
  const approvedDiagnostics: ActivePlanHandoffDiagnostic[] = [];
  let approvedMemories: HandoffMemoryRecord[] = [];
  try {
    approvedMemories = readPersistedApprovedMemories(workspacePath).memories.filter((memory) => {
      const linkedToPlan = (memory.linked_plans ?? []).includes(planId);
      const linkedToFile = (memory.linked_files ?? []).some((file) => linkedFiles.includes(file));
      return linkedToPlan || linkedToFile;
    });
  } catch (error) {
    approvedDiagnostics.push({
      reason: 'findings_unavailable',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const reviewFindings = readRecentReviewFindings(workspacePath, {
    planId,
    linkedFiles,
    limit: MAX_REVIEW_FINDINGS * 2,
  });
  const findingsDiagnostics = reviewFindings.ok
    ? []
    : [
      {
        reason: reviewFindings.reason,
        message: reviewFindings.message,
      },
    ];
  const payload = composeSharedHandoffPayload({
    planState: planResult.state,
    approvedMemories,
    recentReviewFindings: reviewFindings.ok ? reviewFindings.findings : [],
  });
  const cappedPayload = applyPayloadCaps(payload);
  const diagnostics = [...approvedDiagnostics, ...findingsDiagnostics, ...cappedPayload.diagnostics];

  return {
    mode: 'active_plan',
    plan_id: planId,
    status: diagnostics.length > 0 ? 'degraded' : 'ready',
    payload: cappedPayload.payload,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}
